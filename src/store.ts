import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import type { ProviderChoice } from './auth.js';
import type { Candidate, Step } from './model.js';
import type { AutonomyState } from './autonomy.js';
import type { BrowserEngine } from './browser.js';
import type { SourceEvidence } from './evidence.js';
import type { EntryTask } from './tasks.js';
import type { DiscoveryState } from './discovery.js';
import type { ReadTraceSummary } from './read-trace.js';
import { winnerNotice } from './notifications.js';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'needs_user'
  | 'approval'
  | 'submission_unknown'
  | 'completed'
  | 'failed'
  | 'stopped';
export type Approval = {
  id: string;
  action: Step;
  fingerprint: string;
  url: string;
  expires: number;
  form: unknown;
  kind: 'content' | 'interaction';
  target?: { label: string; type: string; href?: string };
};
export type Job = {
  retryEventId?: string;
  retryFromJobId?: string;
  readTraces?: ReadTraceSummary[];
  id: string;
  kind: 'discover' | 'apply' | 'demo' | 'autonomy_demo' | 'result';
  prepareOne?: { revision: string; expires: number; childId?: string; switches?: number };
  activeMs?: number;
  transmitted?: boolean;
  switchReason?: string;
  seenQuestions?: string[];
  tasks?: EntryTask[];
  taskFormStarted?: boolean;
  parentId?: string;
  scheduleId?: string;
  selectionKey?: string;
  autonomy?: AutonomyState;
  goal: string;
  provider: ProviderChoice;
  browserEngine?: BrowserEngine;
  startUrl: string;
  currentUrl?: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  eventId?: string;
  candidateLimit: number;
  maxSteps: number;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  note: string;
  holdNote?: string;
  archivedAt?: string;
  screenshot?: string;
  approval?: Approval;
  uncertain: boolean;
  allowedOrigins: string[];
  approvedTexts: string[];
  intent?: {
    beforeText: string;
    url: string;
    kind?: 'step' | 'submission';
    progress?: { current: number; total: number };
    controlLabel?: string;
    pageMarker?: { id: string; number: number };
    at?: number;
  };
  continuations?: { at: number; screenshot: string; quote: string; from: string; page: number }[];
  sourceEvidence?: SourceEvidence[];
  visitedUrls?: string[];
  skippedUrls?: string[];
  searchEngine?: 'google' | 'naver';
  discovery?: DiscoveryState;
  receiptObservations?: (SourceEvidence & { intentHash: string })[];
  userContext?: string;
  memory?: string;
  observedUrls?: string[];
  observedProgress?: { url: string; current: number; total: number };
  history: { action: string; reason: string; url: string }[];
};
export type EventRecord = Candidate & {
  management?: {
    mode: 'active' | 'dropped' | 'manual';
    at: string;
    note?: string;
    retryJobId?: string;
    manualAt?: string;
    manualNotEnteredAt?: string;
  };
  id: string;
  sourceUrl: string;
  foundAt: string;
  jobId: string;
  screenshot: string;
  score: number;
  scoreReasons: string[];
  entryKey: string;
  campaignKey: string;
  sourceEvidence?: SourceEvidence[];
  entryChannel?: string;
  connectionProfile?: string;
  reviews?: { at: string; note: string; previousEntryUrl: string; previousBlockers: string[] }[];
};

// A new entry may replace only a terminal preparation with no recorded external action.
export function unattemptedEntry(job: Job | undefined) {
  return (
    !!job &&
    ['stopped', 'failed'].includes(job.status) &&
    !job.uncertain &&
    !job.transmitted &&
    !job.intent &&
    !job.taskFormStarted &&
    !job.continuations?.length &&
    !job.receiptObservations?.length &&
    !(job.autonomy?.consents || []).some((c) => c.appliedAt) &&
    !(job.tasks || []).some(
      (t) => t.attempt || t.proof || ['attempted', 'verified', 'manual_reported'].includes(t.state),
    )
  );
}

export function canonicalUrl(raw: string) {
  const url = new URL(raw);
  url.hash = '';
  if (['instagram.com', 'www.instagram.com'].includes(url.hostname)) {
    url.hostname = 'www.instagram.com';
    url.pathname = url.pathname.replace(/^\/[\w.]+\/(p|reel)\//, '/$1/');
    if (/^\/(p|reel)\/[\w-]+$/.test(url.pathname)) url.pathname += '/';
  }
  for (const key of [...url.searchParams.keys()])
    if (/^utm_|^(fbclid|igsh|gclid|ref)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString();
}
export function deadlineState(
  candidate: Pick<Candidate, 'deadline' | 'deadlineDate'>,
  now = Date.now(),
) {
  if (candidate.deadline) return Date.parse(candidate.deadline) <= now ? 'ended' : 'available';
  if (!candidate.deadlineDate) return 'unknown';
  const today = new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  if (candidate.deadlineDate < today) return 'ended';
  // A date is not evidence that entries remain open until 23:59 on that day.
  return candidate.deadlineDate === today ? 'closing_today' : 'available';
}
export function scoreCandidate(candidate: Candidate, now = Date.now()) {
  const reasons: string[] = [];
  const state = deadlineState(candidate, now);
  if (state === 'unknown') return { score: 0, reasons: ['마감일 확인 필요'] };
  if (state === 'ended') return { score: 0, reasons: ['종료된 이벤트'] };
  if (state === 'closing_today')
    return { score: 0, reasons: ['오늘 마감 · 정확한 시각 확인 필요'] };
  if (candidate.blockers.length) return { score: 0, reasons: candidate.blockers };
  let score = 50;
  if (candidate.effortMinutes <= 5) {
    score += 25;
    reasons.push('예상 과제 부담이 작음');
  }
  if (candidate.winners && candidate.winners >= 100) {
    score += 15;
    reasons.push('공지된 선정 인원 100명 이상');
  }
  if (/커피|상품권|기프티콘|네이버페이/.test(candidate.prize)) {
    score += 10;
    reasons.push('선호 경품 유형');
  }
  return { score, reasons: [...reasons, '당첨 확률이 아닌 검토 우선순위'] };
}

export class Store {
  readonly db: DatabaseSync;
  constructor(readonly dir: string) {
    const file = join(dir, 'state.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, day TEXT NOT NULL, job_id TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, estimated_usd REAL, state TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, entry_key TEXT UNIQUE NOT NULL, campaign_key TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS submissions (event_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, state TEXT NOT NULL, evidence TEXT);
      CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, at TEXT NOT NULL, message TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS demo_receipts (run TEXT PRIMARY KEY, receipt TEXT NOT NULL);
    `);
    for (const job of this.jobs()) {
      if (['running', 'approval'].includes(job.status)) {
        job.status = job.uncertain ? 'submission_unknown' : 'paused';
        delete job.approval;
        job.note = '앱이 재시작되었습니다. 현재 화면을 확인한 뒤 재개하세요.';
        this.saveJob(job);
      }
    }
  }
  jobs(): Job[] {
    return this.db
      .prepare('SELECT data FROM jobs ORDER BY rowid DESC')
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  job(id: string): Job | undefined {
    const row = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  saveJob(job: Job) {
    job.updatedAt = new Date().toISOString();
    this.db
      .prepare('INSERT INTO jobs VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(job.id, JSON.stringify(job));
  }
  note(id: string, message: string) {
    this.db
      .prepare('INSERT INTO notes(job_id,at,message) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), message);
  }
  notes(id: string) {
    return this.db
      .prepare('SELECT at,message FROM notes WHERE job_id=? ORDER BY id DESC LIMIT 100')
      .all(id);
  }
  events(): EventRecord[] {
    return this.db
      .prepare('SELECT data FROM events ORDER BY rowid DESC')
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  event(id: string): EventRecord | undefined {
    const r = this.db.prepare('SELECT data FROM events WHERE id=?').get(id);
    return r ? JSON.parse(r.data as string) : undefined;
  }
  reviewEvent(
    id: string,
    patch: Pick<Candidate, 'entryUrl' | 'deadlineDate' | 'blockers'>,
    note: string,
  ) {
    const event = this.event(id);
    if (!event) return undefined;
    const reviews = [
      ...(event.reviews || []),
      {
        at: new Date().toISOString(),
        note,
        previousEntryUrl: event.entryUrl,
        previousBlockers: event.blockers,
      },
    ].slice(-10);
    const next = { ...event, ...patch, entryKey: canonicalUrl(patch.entryUrl), reviews };
    const ranked = scoreCandidate(next);
    next.score = ranked.score;
    next.scoreReasons = ranked.reasons;
    this.db
      .prepare('UPDATE events SET entry_key=?,data=? WHERE id=?')
      .run(next.entryKey, JSON.stringify(next), id);
    return next;
  }
  record(
    candidate: Candidate,
    sourceUrl: string,
    jobId: string,
    screenshot: string,
    context?: Pick<EventRecord, 'sourceEvidence' | 'entryChannel' | 'connectionProfile'>,
  ) {
    const entryKey = canonicalUrl(candidate.entryUrl);
    const campaignKey = createHash('sha256')
      .update(
        `${candidate.organizer}:${candidate.title}`
          .normalize('NFKC')
          .toLowerCase()
          .replace(/\s|[\p{P}]/gu, ''),
      )
      .digest('hex');
    const existing = this.db
      .prepare('SELECT data FROM events WHERE entry_key=? OR campaign_key=? LIMIT 1')
      .get(entryKey, campaignKey);
    if (existing) {
      const prior = JSON.parse(existing.data as string) as EventRecord;
      if (prior.management?.mode && prior.management.mode !== 'active')
        return { event: prior, added: false, refreshed: false };
      if (this.submission(prior.id) && !this.retryOwns(prior.id, this.job(jobId)))
        return { event: prior, added: false, refreshed: false };
      const ranked = scoreCandidate(candidate);
      const event: EventRecord = {
        ...prior,
        ...candidate,
        ...context,
        entryKey,
        campaignKey,
        sourceUrl,
        jobId,
        screenshot,
        score: ranked.score,
        scoreReasons: ranked.reasons,
        reviews: [
          ...(prior.reviews || []),
          {
            at: new Date().toISOString(),
            note: '미응모 후보의 원문과 조건을 에이전트가 다시 확인했습니다.',
            previousEntryUrl: prior.entryUrl,
            previousBlockers: prior.blockers,
          },
        ].slice(-10),
      };
      event.winnerNotice = winnerNotice(event);
      this.db
        .prepare('UPDATE events SET entry_key=?,campaign_key=?,data=? WHERE id=?')
        .run(entryKey, campaignKey, JSON.stringify(event), prior.id);
      return { event, added: false, refreshed: true };
    }
    const ranked = scoreCandidate(candidate);
    const event: EventRecord = {
      ...candidate,
      ...context,
      id: randomUUID(),
      sourceUrl,
      jobId,
      screenshot,
      foundAt: new Date().toISOString(),
      score: ranked.score,
      scoreReasons: ranked.reasons,
      entryKey,
      campaignKey,
    };
    event.winnerNotice = winnerNotice(event);
    this.db
      .prepare('INSERT INTO events VALUES (?,?,?,?)')
      .run(event.id, entryKey, campaignKey, JSON.stringify(event));
    return { event, added: true, refreshed: false };
  }
  submission(eventId: string) {
    return this.db.prepare('SELECT * FROM submissions WHERE event_id=?').get(eventId);
  }
  saveEvent(event: EventRecord) {
    this.db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(event), event.id);
  }
  retryOwns(eventId: string, retry: Job | undefined) {
    const event = this.event(eventId),
      row = this.submission(eventId);
    return (
      !!retry &&
      retry.retryEventId === eventId &&
      event?.management?.mode === 'active' &&
      (!event.management.manualAt || !!event.management.manualNotEnteredAt) &&
      event.management.retryJobId === retry.id &&
      row?.state === 'in_progress' &&
      row.job_id === retry.retryFromJobId &&
      unattemptedEntry(this.job(String(row.job_id)))
    );
  }
  claimRetry(eventId: string, jobId: string, retry: Job) {
    if (!this.retryOwns(eventId, retry)) return false;
    return (
      this.db
        .prepare(
          "UPDATE submissions SET job_id=?,state='in_progress',evidence=NULL WHERE event_id=? AND job_id=? AND state='in_progress'",
        )
        .run(jobId, eventId, retry.retryFromJobId!).changes === 1
    );
  }
  claimSubmission(eventId: string, jobId: string) {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO submissions VALUES (?,?,'in_progress',NULL)")
      .run(eventId, jobId);
    return result.changes === 1;
  }
  markSubmission(eventId: string, state: string, evidence?: string) {
    this.db
      .prepare('UPDATE submissions SET state=?,evidence=? WHERE event_id=?')
      .run(state, evidence || null, eventId);
  }
  completedEntries() {
    return this.db
      .prepare("SELECT * FROM submissions WHERE state='completed'")
      .all()
      .flatMap((row) => {
        const event = this.event(String(row.event_id));
        const job = this.job(String(row.job_id));
        if (!event || !job || job.kind !== 'apply') return [];
        let proof: Record<string, unknown> = {};
        try {
          proof = JSON.parse(String(row.evidence || '{}'));
        } catch {
          /* Legacy evidence stays private. */
        }
        const at = proof.observedAt || proof.completedAt || job.updatedAt;
        return [
          {
            eventId: event.id,
            jobId: job.id,
            title: event.title,
            organizer: event.organizer,
            prize: event.prize,
            entryUrl: event.entryUrl,
            sourceUrl: event.sourceUrl,
            completedAt: typeof at === 'number' ? new Date(at).toISOString() : String(at),
            announcementDate: event.announcementDate,
            announcementNote: event.announcementNote,
            winnerNotice: winnerNotice(event),
            quote: typeof proof.quote === 'string' ? proof.quote : '접수 완료 화면 확인',
            screenshot:
              typeof proof.screenshot === 'string' && /^[a-f0-9-]+\.png$/.test(proof.screenshot)
                ? proof.screenshot
                : undefined,
            verification:
              typeof proof.verification === 'string' ? proof.verification : 'visible_receipt',
            consents: job.autonomy?.consents || [],
          },
        ];
      })
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  }
  complete(job: Job, proof: Record<string, unknown>) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      job.status = 'completed';
      job.uncertain = false;
      job.note = '완료 문구와 접수 결과를 확인했습니다.';
      const formTask = job.taskFormStarted
        ? job.tasks?.find((t) => t.kind === 'form' && t.state !== 'verified')
        : undefined;
      if (formTask) {
        formTask.state = 'verified';
        formTask.proof = {
          quote: String(proof.quote || '폼 접수 확인'),
          url: String(proof.url || job.currentUrl),
          screenshot: typeof proof.screenshot === 'string' ? proof.screenshot : undefined,
          at: Date.now(),
          actor: 'browser',
        };
        delete job.intent;
        delete job.receiptObservations;
      }
      const remaining = job.tasks?.some((t) => !['verified', 'manual_reported'].includes(t.state));
      if (remaining) {
        job.status = 'running';
        job.note = '폼 접수를 확인했습니다. 남은 참여 과제를 계속합니다.';
      }
      delete job.approval;
      if (job.autonomy) {
        if (!remaining) job.autonomy.metrics.finishedAt = Date.now();
        delete job.autonomy.plan;
        delete job.autonomy.finalApproval;
        delete job.autonomy.inbox;
      }
      if (typeof proof.screenshot === 'string') job.screenshot = proof.screenshot;
      this.saveJob(job);
      if (job.eventId)
        this.markSubmission(
          job.eventId,
          remaining ? 'in_progress' : 'completed',
          remaining
            ? undefined
            : JSON.stringify({
                completedAt: new Date().toISOString(),
                ...proof,
                tasks: job.tasks?.map((t) => ({
                  id: t.id,
                  kind: t.kind,
                  state: t.state,
                  proof: t.proof,
                })),
              }),
        );
      this.note(job.id, job.note);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  settings<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT data FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.data as string) : fallback;
  }
  setSettings(key: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data',
      )
      .run(key, JSON.stringify(value));
  }
  receipt(run: string) {
    return this.db.prepare('SELECT receipt FROM demo_receipts WHERE run=?').get(run)?.receipt as
      string | undefined;
  }
  submitDemo(run: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO demo_receipts VALUES (?,?)')
      .run(run, `TEST-${randomUUID().slice(0, 8)}`);
    return this.receipt(run)!;
  }
  close() {
    this.db.close();
  }
}
