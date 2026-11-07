import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import type { ProviderChoice } from './auth.js';
import type { Candidate, Step } from './model.js';

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
  id: string;
  kind: 'discover' | 'apply' | 'demo';
  goal: string;
  provider: ProviderChoice;
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
  screenshot?: string;
  approval?: Approval;
  uncertain: boolean;
  allowedOrigins: string[];
  approvedTexts: string[];
  intent?: { beforeText: string; url: string };
  memory?: string;
  history: { action: string; reason: string; url: string }[];
};
export type EventRecord = Candidate & {
  id: string;
  sourceUrl: string;
  foundAt: string;
  jobId: string;
  screenshot: string;
  score: number;
  scoreReasons: string[];
  entryKey: string;
  campaignKey: string;
};

export function canonicalUrl(raw: string) {
  const url = new URL(raw);
  url.hash = '';
  for (const key of [...url.searchParams.keys()])
    if (/^utm_|^(fbclid|igsh|gclid|ref)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString();
}
export function scoreCandidate(candidate: Candidate, now = Date.now()) {
  const reasons: string[] = [];
  if (!candidate.deadline) return { score: 0, reasons: ['마감일 확인 필요'] };
  if (Date.parse(candidate.deadline) <= now) return { score: 0, reasons: ['종료된 이벤트'] };
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
  constructor(dir: string) {
    const file = join(dir, 'state.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, entry_key TEXT UNIQUE NOT NULL, campaign_key TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS submissions (event_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, state TEXT NOT NULL, evidence TEXT);
      CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, at TEXT NOT NULL, message TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS demo_receipts (run TEXT PRIMARY KEY, receipt TEXT NOT NULL);
    `);
    for (const job of this.jobs()) {
      if (['running', 'queued', 'approval'].includes(job.status)) {
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
  record(candidate: Candidate, sourceUrl: string, jobId: string, screenshot: string) {
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
    if (existing)
      return { event: JSON.parse(existing.data as string) as EventRecord, added: false };
    const ranked = scoreCandidate(candidate);
    const event: EventRecord = {
      ...candidate,
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
    this.db
      .prepare('INSERT INTO events VALUES (?,?,?,?)')
      .run(event.id, entryKey, campaignKey, JSON.stringify(event));
    return { event, added: true };
  }
  submission(eventId: string) {
    return this.db.prepare('SELECT * FROM submissions WHERE event_id=?').get(eventId);
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
