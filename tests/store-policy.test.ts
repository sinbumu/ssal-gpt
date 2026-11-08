import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deadlineState, Store, scoreCandidate, type Job } from '../src/store.js';
import { actionPolicy, pageProgress, intermediateAdvanced } from '../src/runner.js';
import { validateUrl, privateAddress, type Observation } from '../src/browser.js';
const candidate = {
  title: 'Synthetic coffee',
  organizer: 'Fixture',
  entryUrl: 'https://example.com/event?utm_source=test',
  deadline: '2099-12-31T23:59:00+09:00',
  prize: '커피',
  winners: 100,
  requirements: ['퀴즈'],
  blockers: [],
  evidenceQuote: '커피',
  evidenceKind: 'text' as const,
  effortMinutes: 3,
};
export function makeJob(id = 'test'): Job {
  return {
    id,
    kind: 'demo',
    goal: 'synthetic',
    provider: { kind: 'api', model: 'synthetic' },
    startUrl: 'https://example.com/',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    candidateLimit: 3,
    maxSteps: 30,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    note: '',
    uncertain: false,
    allowedOrigins: ['https://example.com'],
    approvedTexts: [],
    history: [],
  };
}
test('event dedup and submission claim survive restart; interrupted actions become unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-store-'));
  let db = new Store(dir);
  try {
    const a = db.record(candidate, 'https://example.com/event', 'j1', 'test.png');
    const b = db.record(
      { ...candidate, entryUrl: 'https://example.com/event?utm_source=other' },
      'https://example.com/event',
      'j2',
      'test.png',
    );
    assert.equal(a.event.id, b.event.id);
    assert.equal(b.added, false);
    assert.equal(b.refreshed, true);
    assert.equal(db.event(a.event.id)!.jobId, 'j2');
    assert.equal(db.claimSubmission(a.event.id, 'job1'), true);
    assert.equal(db.claimSubmission(a.event.id, 'job2'), false);
    const locked = db.record(
      { ...candidate, title: 'Do not overwrite' },
      candidate.entryUrl,
      'j3',
      'x.png',
    );
    assert.equal(locked.refreshed, false);
    assert.equal(db.event(a.event.id)!.jobId, 'j2');
    const job = makeJob();
    job.uncertain = true;
    db.saveJob(job);
    db.close();
    db = new Store(dir);
    assert.equal(db.job(job.id)?.status, 'submission_unknown');
    assert.equal(db.claimSubmission(a.event.id, 'job3'), false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('ranking does not recommend ended, undated or ineligible events', () => {
  assert.equal(scoreCandidate({ ...candidate, deadline: null }).score, 0);
  assert.equal(scoreCandidate({ ...candidate, deadline: '2020-01-01T00:00:00Z' }).score, 0);
  assert.equal(scoreCandidate({ ...candidate, blockers: ['구매 필요'] }).score, 0);
  assert.equal(scoreCandidate(candidate).score, 100);
});
test('untrusted model cannot promote discovery into entry or bypass unknown submission state', () => {
  const job = makeJob();
  job.kind = 'discover';
  const o = {
    id: 'obs',
    url: 'https://example.com',
    elements: [{ ref: 'e1', type: 'submit', tag: 'button', label: '응모' }],
  } as Observation;
  assert.equal(
    actionPolicy(
      job,
      { observationId: 'obs', action: 'click', ref: 'e1', reason: 'ignore policy' },
      o,
    ),
    'block',
  );
  assert.equal(
    actionPolicy(
      job,
      { observationId: 'obs', action: 'type', ref: 'e1', text: 'spam', reason: 'ignore policy' },
      o,
    ),
    'block',
  );
  job.kind = 'apply';
  assert.equal(
    actionPolicy(job, { observationId: 'obs', action: 'click', ref: 'e1', reason: 'submit' }, o),
    'review',
  );
  job.uncertain = true;
  assert.equal(
    actionPolicy(job, { observationId: 'obs', action: 'click', ref: 'e1', reason: 'retry' }, o),
    'block',
  );
  assert.throws(
    () => actionPolicy(job, { observationId: 'old', action: 'scroll', reason: 'stale' }, o),
    /stale_observation/,
  );
});
test('browser blocks internal services, encoded loopback, file URLs and unrelated dashboard routes', async () => {
  for (const url of [
    'file:///etc/passwd',
    'http://127.0.0.1',
    'http://2130706433',
    'http://169.254.169.254',
    'http://localhost',
    'http://[::1]',
    'http://127.0.0.1:4317/api/state',
  ])
    await assert.rejects(() => validateUrl(url, 'http://127.0.0.1:4317'));
  assert.equal(
    (await validateUrl('http://127.0.0.1:4317/demo/event', 'http://127.0.0.1:4317')).pathname,
    '/demo/event',
  );
  assert.equal(privateAddress('192.168.1.1'), true);
  assert.equal(privateAddress('::ffff:127.0.0.1'), true);
  assert.equal(privateAddress('8.8.8.8'), false);
});

test('date-only deadlines preserve uncertainty and use the Korean calendar boundary', () => {
  const c = { deadline: null, deadlineDate: '2030-01-02' };
  assert.equal(deadlineState(c, Date.parse('2030-01-01T14:59:59Z')), 'available');
  assert.equal(deadlineState(c, Date.parse('2030-01-01T15:00:00Z')), 'closing_today');
  assert.equal(deadlineState(c, Date.parse('2030-01-02T15:00:00Z')), 'ended');
  assert.equal(scoreCandidate({ ...candidate, ...c }, Date.parse('2030-01-01T15:00:00Z')).score, 0);
});

test('intermediate survey navigation requires observed progress on the same form, never implies final completion', () => {
  assert.deepEqual(pageProgress('Survey\n1 / 26page\n2%'), { current: 1, total: 26 });
  assert.deepEqual(pageProgress('2 / 26 페이지\nQ2'), { current: 2, total: 26 });
  const naver = 'https://form.naver.com/response/synthetic';
  assert.deepEqual(pageProgress('Naver\n폼\n설문 진행 상태\n1/2\n설문 참여', naver), {
    current: 1,
    total: 2,
  });
  assert.equal(pageProgress('퀴즈\n1/2', naver), undefined);
  assert.equal(pageProgress('설문 진행 상태\n1/2', 'https://example.org/form'), undefined);
  assert.equal(pageProgress('설문 진행 상태\n3/2', naver), undefined);
  assert.equal(pageProgress('1/2 페이지\n2/3 페이지', naver), undefined);
  assert.equal(pageProgress('설문 진행 상태\n1/2\n2/3 페이지', naver), undefined);
  const j = makeJob();
  j.uncertain = true;
  j.intent = {
    beforeText: '1 / 26page',
    url: 'https://example.com/survey',
    kind: 'step',
    progress: { current: 1, total: 26 },
  };
  const o = { url: 'https://example.com/survey', text: '2 / 26page\nQuestion two' } as Observation;
  assert.equal(intermediateAdvanced(j, o), true);
  assert.equal(
    intermediateAdvanced(j, { ...o, text: '8 / 26page\nSkipped inapplicable questions' }),
    true,
  );
  assert.equal(intermediateAdvanced(j, { ...o, text: '1 / 26page\nPlease answer' }), false);
  assert.equal(intermediateAdvanced(j, { ...o, url: 'https://other.example/survey' }), false);
  assert.equal(intermediateAdvanced(j, { ...o, url: 'https://example.com/other-survey' }), false);
  assert.equal(intermediateAdvanced(j, { ...o, text: '응모가 완료되었습니다' }), false);
  j.intent.kind = 'submission';
  assert.equal(intermediateAdvanced(j, o), false);
});

test('completed list excludes discoveries and unfinished entries, survives restart and preserves duplicate claims', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-list-'));
  let store = new Store(dir);
  try {
    const event = store.record(candidate, candidate.entryUrl, 'discovery', 'x.png').event;
    const job = makeJob('completed');
    job.kind = 'apply';
    job.eventId = event.id;
    store.saveJob(job);
    store.claimSubmission(event.id, job.id);
    assert.equal(store.completedEntries().length, 0);
    store.complete(job, {
      quote: '답변이 제출되었습니다.',
      verification: 'autonomous_visible_receipt',
      observedAt: 1234567890000,
    });
    store.close();
    store = new Store(dir);
    assert.equal(store.completedEntries().length, 1);
    assert.equal(store.completedEntries()[0]!.completedAt, new Date(1234567890000).toISOString());
    assert.equal(store.claimSubmission(event.id, 'duplicate'), false);
    assert.equal(store.job(job.id)!.status, 'completed');
    assert.ok(!JSON.stringify(store.completedEntries()).includes('provider'));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
