import { lstatSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ServiceError } from './auth.js';
import { privateDirectory } from './config.js';
import type { Store } from './store.js';

export const MiB = 1024 ** 2;
export const StorageSchema = z
  .object({
    automatic: z.boolean().default(true),
    retentionDays: z.number().int().min(1).max(365).default(14),
    screenshotLimitMiB: z.number().int().min(128).max(3072).default(3072),
    cacheCleanup: z.boolean().default(true),
    cacheLimitMiB: z.number().int().min(128).max(2048).default(512),
  })
  .strict();
const imageName = /^[a-f0-9-]{36}\.png$/;
const traceName = /^[a-f0-9-]{36}\.read\.json$/;
const activeStates = new Set([
  'running',
  'queued',
  'paused',
  'approval',
  'needs_user',
  'submission_unknown',
]);
const cachePaths = [
  'Default/Cache',
  'Default/Code Cache',
  'Default/GPUCache',
  'Default/DawnWebGPUCache',
  'Default/DawnGraphiteCache',
  'GraphiteDawnCache',
  'ShaderCache',
  'GrShaderCache',
];
function stat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
// Do not follow symlinks, including intermediate cache/profile directories.
function safePath(root: string, relative: string) {
  let path = root;
  if (stat(root)?.isSymbolicLink()) return;
  for (const part of relative.split('/')) {
    path = join(path, part);
    const s = stat(path);
    if (!s || s.isSymbolicLink()) return;
  }
  return path;
}
function filesUnder(path: string): { path: string; bytes: number }[] {
  const s = stat(path);
  if (!s || s.isSymbolicLink()) return [];
  if (s.isFile()) return [{ path, bytes: s.size }];
  return s.isDirectory() ? readdirSync(path).flatMap((n) => filesUnder(join(path, n))) : [];
}
type Asset = { name: string; bytes: number; at: number; reason?: string; traceBytes: number };
export class StorageManager {
  private evidence: string;
  private timer?: ReturnType<typeof setInterval>;
  constructor(readonly store: Store) {
    if (stat(join(store.dir, 'evidence'))?.isSymbolicLink())
      throw new ServiceError('storage_path_unsafe');
    this.evidence = privateDirectory(join(store.dir, 'evidence'));
  }
  settings() {
    return StorageSchema.parse(this.store.settings('storage', {}));
  }
  save(input: unknown) {
    this.store.setSettings('storage', StorageSchema.parse(input));
  }
  private inventory(now: number) {
    if (stat(this.evidence)?.isSymbolicLink()) throw new ServiceError('storage_path_unsafe');
    const protectedNames = new Set<string>();
    const references = (value: unknown) => {
      for (const name of JSON.stringify(value).match(/[a-f0-9-]{36}\.png/g) || [])
        protectedNames.add(name);
    };
    const jobs = new Map(this.store.jobs().map((j) => [j.id, j]));
    // Routine read-trace links in finished jobs may expire; their small summaries
    // remain in the DB. Protect final/approved/source evidence and failed reads.
    for (const job of jobs.values()) {
      if (job.uncertain || activeStates.has(job.status) || job.status === 'failed') references(job);
      else {
        const { readTraces, ...important } = job;
        references(important);
        references((readTraces || []).filter((t) => ['failed', 'rejected'].includes(t.status)));
      }
    }
    for (const table of ['events', 'settings'])
      for (const row of this.store.db.prepare(`SELECT data FROM ${table}`).all())
        references(row.data);
    for (const row of this.store.db.prepare('SELECT evidence FROM submissions').all())
      references(row.evidence);
    const tracked = new Map(
      this.store.db
        .prepare('SELECT * FROM evidence_assets')
        .all()
        .map((r) => [String(r.name), r]),
    );
    const assets: Asset[] = [];
    let traceBytes = 0;
    let otherBytes = 0;
    for (const name of readdirSync(this.evidence)) {
      const s = stat(join(this.evidence, name));
      if (!s?.isFile()) continue;
      if (traceName.test(name)) {
        traceBytes += s.size;
        continue;
      }
      if (!name.endsWith('.png')) {
        otherBytes += s.size;
        continue;
      }
      const tracePath = join(this.evidence, name.replace(/\.png$/, '.read.json'));
      const traceStat = stat(tracePath);
      let record = tracked.get(name);
      let legacyTrace: { jobId?: string; status?: string } | undefined;
      if (!record && traceStat?.isFile() && traceStat.size < MiB) {
        try {
          legacyTrace = JSON.parse(readFileSync(tracePath, 'utf8'));
        } catch {
          /* Preserve unclassified evidence. */
        }
        if (legacyTrace?.jobId && jobs.has(legacyTrace.jobId))
          record = { job_id: legacyTrace.jobId, purpose: 'observation' };
      }
      const job = record?.job_id ? jobs.get(String(record.job_id)) : undefined;
      const reason =
        !imageName.test(name) || !record
          ? '과거 자료 · 용도 미분류'
          : protectedNames.has(name)
            ? '원문·접수·확인·진단 기록에서 참조 중'
            : record.purpose === 'consent'
              ? '개인정보·동의 안내 화면'
              : record.purpose === 'error'
                ? '오류 진단 증거'
                : !job
                  ? '작업 연결 미확인'
                  : job.uncertain || activeStates.has(job.status)
                    ? '진행·대기·결과 미확인 작업'
                    : job.status === 'failed' ||
                        ['failed', 'rejected'].includes(legacyTrace?.status || '')
                      ? '오류 진단 증거'
                      : now - s.mtimeMs < 10 * 60_000
                        ? '최근 관찰 보호'
                        : undefined;
      assets.push({
        name,
        bytes: s.size,
        at: s.mtimeMs,
        reason,
        traceBytes: traceStat?.isFile() ? traceStat.size : 0,
      });
    }
    return { assets, traceBytes, otherBytes };
  }
  private plan(now: number, incoming = 0) {
    const config = this.settings(),
      inventory = this.inventory(now);
    const screenshots = inventory.assets.reduce((n, a) => n + a.bytes, 0);
    const candidates = inventory.assets
      .filter((a) => !a.reason)
      .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
    let remaining = screenshots + incoming;
    const remove = candidates.flatMap((a) => {
      const reason =
        now - a.at > config.retentionDays * 86400_000
          ? '보관 기간 경과'
          : remaining > config.screenshotLimitMiB * MiB
            ? '스크린샷 용량 상한'
            : undefined;
      if (!reason) return [];
      remaining -= a.bytes;
      return [{ ...a, reason }];
    });
    return { ...inventory, config, screenshots, remove, remaining };
  }
  private remove(plan: ReturnType<StorageManager['plan']>) {
    let files = 0,
      bytes = 0;
    for (const asset of plan.remove) {
      for (const name of [asset.name, asset.name.replace(/\.png$/, '.read.json')]) {
        const path = join(this.evidence, name),
          s = stat(path);
        if (!s?.isFile() || s.isSymbolicLink()) continue;
        unlinkSync(path);
        files++;
        bytes += s.size;
      }
      this.store.db.prepare('DELETE FROM evidence_assets WHERE name=?').run(asset.name);
    }
    if (files) this.store.setSettings('storageLastCleanup', { at: Date.now(), files, bytes });
    return { files, bytes };
  }
  cleanup(now = Date.now()) {
    const result = this.remove(this.plan(now));
    this.store.setSettings('storageCleanupError', null);
    return result;
  }
  // Synchronous admission + write: concurrent observations cannot reserve the same free space.
  writeImage(name: string, image: Buffer, jobId?: string, consent = false) {
    if (!imageName.test(name)) throw new ServiceError('invalid_evidence_file');
    const plan = this.plan(Date.now(), image.length);
    if (plan.config.automatic) this.remove(plan);
    const after = plan.config.automatic ? plan.remaining : plan.screenshots + image.length;
    if (after > plan.config.screenshotLimitMiB * MiB)
      throw new ServiceError('storage_screenshot_limit');
    writeFileSync(join(this.evidence, name), image, { mode: 0o600, flag: 'wx' });
    this.store.db
      .prepare('INSERT INTO evidence_assets VALUES (?,?,?)')
      .run(name, jobId || null, consent ? 'consent' : 'observation');
  }
  private caches(profile: 'browser' | 'browser-chrome') {
    return cachePaths.flatMap((p) => {
      const path = safePath(this.store.dir, `${profile}/${p}`);
      return path ? filesUnder(path) : [];
    });
  }
  cleanupCache(profile: 'browser' | 'browser-chrome') {
    try {
      this.cleanupClosedCache(profile);
    } catch {
      this.store.setSettings('storageCleanupError', {
        at: Date.now(),
        code: 'cache_cleanup_failed',
      });
    }
  }
  private cleanupClosedCache(profile: 'browser' | 'browser-chrome') {
    const config = this.settings();
    // A normal browser close releases this lock. Never clear an open profile.
    if (!config.cacheCleanup || stat(join(this.store.dir, profile, 'SingletonLock'))) return;
    const files = this.caches(profile);
    const bytes = files.reduce((n, f) => n + f.bytes, 0);
    if (bytes <= config.cacheLimitMiB * MiB) return;
    for (const f of files) if (stat(f.path)?.isFile()) unlinkSync(f.path);
    this.store.setSettings('storageLastCacheCleanup', { at: Date.now(), profile, bytes });
  }
  summary(now = Date.now()) {
    const p = this.plan(now);
    const protectedAssets = p.assets.filter((a) => a.reason);
    const reasons = new Map<string, { reason: string; count: number; bytes: number }>();
    for (const a of protectedAssets) {
      const row = reasons.get(a.reason!) || { reason: a.reason!, count: 0, bytes: 0 };
      row.count++;
      row.bytes += a.bytes;
      reasons.set(a.reason!, row);
    }
    return {
      at: now,
      config: p.config,
      screenshotBytes: p.screenshots,
      screenshotCount: p.assets.length,
      traceBytes: p.traceBytes,
      otherEvidenceBytes: p.otherBytes,
      protectedBytes: protectedAssets.reduce((n, a) => n + a.bytes, 0),
      protection: [...reasons.values()],
      plannedCount: p.remove.length,
      plannedBytes: p.remove.reduce((n, a) => n + a.bytes + a.traceBytes, 0),
      planned: p.remove
        .slice(0, 20)
        .map((a) => ({ name: a.name, at: a.at, bytes: a.bytes + a.traceBytes, reason: a.reason })),
      limitBlocked: p.remaining >= p.config.screenshotLimitMiB * MiB,
      caches: (['browser', 'browser-chrome'] as const).map((profile) => ({
        profile,
        bytes: this.caches(profile).reduce((n, f) => n + f.bytes, 0),
        open: !!stat(join(this.store.dir, profile, 'SingletonLock')),
      })),
      lastCleanup: this.store.settings('storageLastCleanup', null),
      lastCacheCleanup: this.store.settings('storageLastCacheCleanup', null),
      cleanupError: this.store.settings('storageCleanupError', null),
    };
  }
  start(blocked: () => boolean) {
    this.timer = setInterval(() => {
      if (blocked() || !this.settings().automatic) return;
      try {
        this.cleanup();
      } catch {
        this.store.setSettings('storageCleanupError', {
          at: Date.now(),
          code: 'storage_cleanup_failed',
        });
      }
    }, 60 * 60_000);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
