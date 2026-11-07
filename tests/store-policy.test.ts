import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, scoreCandidate, type Job } from '../src/store.js';
import { actionPolicy } from '../src/runner.js';
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
    assert.equal(db.claimSubmission(a.event.id, 'job1'), true);
    assert.equal(db.claimSubmission(a.event.id, 'job2'), false);
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
