import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
  existsSync,
  truncateSync,
  symlinkSync,
  unlinkSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Job } from '../src/store.js';
import { StorageManager, StorageSchema, MiB } from '../src/storage.js';
import { errorNotice } from '../src/job-notice.js';
import { ServiceError } from '../src/auth.js';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-storage-')),
    store = new Store(dir),
    storage = new StorageManager(store);
  const job = {
    id: randomUUID(),
    status: 'completed',
    kind: 'discover',
    history: [],
    uncertain: false,
  } as unknown as Job;
  store.saveJob(job);
  function asset(bytes: number, days = 20, purpose = 'observation', jobId = job.id) {
    const name = `${randomUUID()}.png`,
      path = join(dir, 'evidence', name);
    writeFileSync(path, '');
    truncateSync(path, bytes);
    const at = new Date(Date.now() - days * 86400_000);
    utimesSync(path, at, at);
    if (purpose !== 'legacy')
      store.db.prepare('INSERT INTO evidence_assets VALUES (?,?,?)').run(name, jobId, purpose);
    return { name, path };
  }
  return {
    dir,
    store,
    storage,
    job,
    asset,
    close() {
      storage.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('retention protects referenced, unknown, consent, error and unfinished evidence; removes only old ordinary pairs', () => {
  const f = fixture();
  try {
    const ordinary = f.asset(100),
      referenced = f.asset(100),
      consent = f.asset(100, 20, 'consent'),
      legacy = f.asset(100, 20, 'legacy');
    const failed = { ...f.job, id: randomUUID(), status: 'failed' } as Job;
    const pending = {
      ...f.job,
      id: randomUUID(),
      status: 'submission_unknown',
      uncertain: true,
    } as Job;
    f.store.saveJob(failed);
    f.store.saveJob(pending);
    const failedAsset = f.asset(100, 20, 'observation', failed.id),
      pendingAsset = f.asset(100, 20, 'observation', pending.id);
    failed.screenshot = failedAsset.name;
    f.store.saveJob(failed);
    failed.status = 'completed';
    delete failed.screenshot;
    f.store.saveJob(failed);
    f.job.screenshot = referenced.name;
    f.job.readTraces = [
      {
        id: ordinary.name.slice(0, -4),
        screenshot: ordinary.name,
        phase: 'discovery',
        at: Date.now() - 20 * 86400_000,
        status: 'executed',
      },
    ];
    f.store.saveJob(f.job);
    const recent = f.asset(100, 0);
    const trace = ordinary.path.replace('.png', '.read.json');
    writeFileSync(trace, '{}');
    const jobs = JSON.stringify(f.store.jobs());
    assert.equal(f.storage.summary().plannedCount, 1);
    assert.equal(f.storage.cleanup().files, 2);
    assert.ok(!existsSync(ordinary.path));
    assert.ok(!existsSync(trace));
    for (const a of [referenced, consent, legacy, failedAsset, pendingAsset, recent])
      assert.ok(existsSync(a.path));
    assert.equal(JSON.stringify(f.store.jobs()), jobs);
    assert.equal(f.storage.cleanup().files, 0);
  } finally {
    f.close();
  }
});
test('capacity prunes oldest eligible evidence and stops before exceeding the hard cap when protected evidence fills it', () => {
  const f = fixture();
  try {
    f.storage.save({ screenshotLimitMiB: 128 });
    const first = f.asset(70 * MiB, 5),
      second = f.asset(60 * MiB, 4);
    assert.equal(f.storage.summary().planned[0]?.name, first.name);
    const name = `${randomUUID()}.png`;
    f.storage.writeImage(name, Buffer.from('new screenshot'), f.job.id);
    assert.ok(!existsSync(first.path));
    assert.ok(existsSync(second.path));
    f.asset(128 * MiB, 20, 'consent');
    const blocked = `${randomUUID()}.png`;
    assert.throws(
      () => f.storage.writeImage(blocked, Buffer.from('blocked'), f.job.id),
      /storage_screenshot_limit/,
    );
    assert.ok(!existsSync(join(f.dir, 'evidence', blocked)));
    assert.equal(
      errorNotice(new ServiceError('storage_screenshot_limit'), 'observation').category,
      'normal',
    );
    assert.throws(() => StorageSchema.parse({ screenshotLimitMiB: 3073 }));
    assert.equal(StorageSchema.parse({}).screenshotLimitMiB, 3072);
  } finally {
    f.close();
  }
});
test('disabled automatic cleanup keeps ordinary files and still enforces admission; legacy read traces classify only known jobs', () => {
  const f = fixture();
  try {
    f.storage.save({ automatic: false, screenshotLimitMiB: 128 });
    const a = f.asset(128 * MiB, 30, 'legacy');
    writeFileSync(
      a.path.replace('.png', '.read.json'),
      JSON.stringify({ jobId: f.job.id, status: 'executed' }),
    );
    assert.equal(f.storage.summary().plannedCount, 1);
    assert.throws(
      () => f.storage.writeImage(`${randomUUID()}.png`, Buffer.from('x'), f.job.id),
      /storage_screenshot_limit/,
    );
    assert.ok(existsSync(a.path));
    assert.equal(f.storage.cleanup().files, 2);
  } finally {
    f.close();
  }
});
test('cache cleanup is closed-profile only, allowlisted, and never follows symlinks or removes login storage', () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'ssal-outside-'));
  try {
    f.storage.save({ cacheLimitMiB: 128 });
    const profile = join(f.dir, 'browser'),
      cache = join(profile, 'Default', 'Cache');
    mkdirSync(cache, { recursive: true });
    const payload = join(cache, 'payload');
    writeFileSync(payload, '');
    truncateSync(payload, 129 * MiB);
    const cookie = join(profile, 'Default', 'Cookies');
    writeFileSync(cookie, 'keep session');
    const local = join(profile, 'Default', 'Local Storage');
    mkdirSync(local);
    writeFileSync(join(local, 'data'), 'keep site data');
    const secret = join(outside, 'secret');
    writeFileSync(secret, 'keep outside');
    symlinkSync(outside, join(profile, 'Default', 'Code Cache'));
    symlinkSync('fixture-lock', join(profile, 'SingletonLock'));
    f.storage.cleanupCache('browser');
    assert.ok(existsSync(payload));
    unlinkSync(join(profile, 'SingletonLock'));
    f.storage.cleanupCache('browser');
    assert.ok(!existsSync(payload));
    assert.equal(readFileSync(cookie, 'utf8'), 'keep session');
    assert.equal(readFileSync(join(local, 'data'), 'utf8'), 'keep site data');
    assert.equal(readFileSync(secret, 'utf8'), 'keep outside');
    symlinkSync(outside, join(f.dir, 'evidence', `${randomUUID()}.png`));
    f.storage.cleanup();
    assert.ok(existsSync(secret));
  } finally {
    f.close();
    rmSync(outside, { recursive: true, force: true });
  }
});
