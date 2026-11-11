import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Job } from '../src/store.js';
import { syntheticSettings } from '../src/autonomy.js';
import {
  entryLifecycle,
  manageEntry,
  retryEntry,
  reportManualCompletion,
} from '../src/entry-lifecycle.js';
import { canPrepareEntry, prepareDiscoveredEntry, nextWorkflowJob } from '../src/workflow.js';

function fixture(run: (store: Store) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-entry-life-')),
    store = new Store(dir);
  try {
    store.setSettings('autonomy', syntheticSettings);
    run(store);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
function seed(store: Store) {
  const url = `https://form.naver.com/response/${randomUUID()}`;
  const candidate = {
    title: '가상 응모',
    organizer: url,
    entryUrl: url,
    deadline: '2099-01-01T00:00:00Z',
    prize: '커피',
    winners: 10,
    requirements: [],
    blockers: [],
    evidenceQuote: '공식 가상 이벤트 안내',
    evidenceKind: 'text' as const,
    effortMinutes: 2,
  };
  const context = {
    sourceEvidence: [
      {
        id: 'fixture',
        url,
        title: '안내',
        text: candidate.evidenceQuote,
        screenshot: 'fixture.png',
        observedAt: Date.now(),
      },
    ],
  };
  const e = store.record(candidate, url, 'original-discovery', 'fixture.png', context).event;
  const j: Job = {
    id: randomUUID(),
    kind: 'apply',
    eventId: e.id,
    goal: '가상 응모',
    startUrl: url,
    status: 'stopped',
    provider: { kind: 'api', model: 'fixture' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    candidateLimit: 1,
    maxSteps: 20,
    steps: 4,
    inputTokens: 123,
    outputTokens: 10,
    uncertain: false,
    note: '준비 중단',
    allowedOrigins: [new URL(url).origin],
    approvedTexts: ['old approval'],
    history: [],
  };
  store.saveJob(j);
  store.claimSubmission(e.id, j.id);
  return { e, j, candidate, context };
}
test('drop and manual routing preserve duplicate locks, hide from automatic selection and require explicit manual evidence', () =>
  fixture((store) => {
    const { e, j, candidate, context } = seed(store);
    assert.equal(entryLifecycle(store, e).label, '중단됨');
    manageEntry(store, e, 'dropped', '참여하지 않음');
    assert.equal(entryLifecycle(store, e).hiddenByDefault, true);
    assert.equal(canPrepareEntry(store, e), false);
    assert.equal(
      store.record(candidate, e.entryUrl, 'new-discovery', 'fresh.png', context).refreshed,
      false,
    );
    assert.equal(store.submission(e.id)?.job_id, j.id);
    assert.throws(() => retryEntry(store, e, j.provider, 'chromium'), /entry_retry_unsafe/);
    manageEntry(store, e, 'active');
    assert.equal(entryLifecycle(store, e).hiddenByDefault, false);
    assert.equal(entryLifecycle(store, e).canRetry, true);
    manageEntry(store, e, 'manual');
    assert.equal(store.completedEntries().length, 0);
    reportManualCompletion(store, e, '사용자가 접수 완료 문구를 직접 확인했습니다.');
    assert.equal(store.completedEntries()[0]!.verification, 'user_reported');
    assert.equal(store.job(j.id)!.status, 'stopped');
    assert.equal(store.job(j.id)!.inputTokens, 123);
    assert.throws(
      () => reportManualCompletion(store, e, '두 번째 완료'),
      /manual_entry_not_active/,
    );
  }));
test('retry rechecks only the selected event, atomically hands off its lock, and retains history without old approvals', () =>
  fixture((store) => {
    const { e, j, candidate, context } = seed(store);
    const retry = retryEntry(store, e, j.provider, 'chromium', '실제 사용자 답변');
    assert.equal(store.submission(e.id)?.job_id, j.id);
    assert.throws(
      () => retryEntry(store, store.event(e.id)!, j.provider, 'chromium'),
      /entry_retry_unsafe/,
    );
    assert.equal(
      store.record(candidate, e.entryUrl, 'unrelated', 'x.png', context).refreshed,
      false,
    );
    const refreshed = store.record(candidate, e.entryUrl, retry.id, 'fresh.png', context);
    assert.equal(refreshed.refreshed, true);
    retry.status = 'completed';
    store.saveJob(retry);
    const id = prepareDiscoveredEntry(store, retry)!;
    const child = store.job(id)!;
    assert.ok(id);
    assert.equal(store.submission(e.id)?.job_id, id);
    assert.equal(child.userContext, '실제 사용자 답변');
    assert.deepEqual(child.approvedTexts, []);
    assert.equal(store.job(j.id)!.inputTokens, 123);
    assert.equal(prepareDiscoveredEntry(store, retry), undefined);
    child.status = 'stopped';
    child.switchReason = '필수 조건 미해결';
    store.saveJob(child);
    assert.equal(
      nextWorkflowJob(store, child),
      undefined,
      'targeted retry never starts unrelated events',
    );
  }));
test('unknown, transmitted, partially completed and mismatched-profile entries cannot create a new attempt', () =>
  fixture((store) => {
    for (const flag of ['uncertain', 'transmitted', 'intent', 'task', 'form'] as const) {
      const { e, j } = seed(store);
      if (flag === 'uncertain') {
        j.uncertain = true;
        store.markSubmission(e.id, 'unknown');
      }
      if (flag === 'transmitted') j.transmitted = true;
      if (flag === 'intent') j.intent = { beforeText: '', url: e.entryUrl };
      if (flag === 'form') j.taskFormStarted = true;
      if (flag === 'task')
        j.tasks = [
          {
            id: 'like',
            kind: 'like',
            url: e.entryUrl,
            instruction: 'like',
            quote: 'like',
            dependsOn: [],
            state: 'verified',
          },
        ];
      store.saveJob(j);
      assert.equal(entryLifecycle(store, e).canRetry, false, flag);
      assert.throws(() => retryEntry(store, e, j.provider, 'chromium'), /entry_retry_unsafe/);
      manageEntry(store, e, 'dropped');
      manageEntry(store, e, 'active');
      assert.equal(
        entryLifecycle(store, e).canRetry,
        false,
        'restoring cannot clear external uncertainty',
      );
    }
    const { e, j } = seed(store);
    assert.throws(() => retryEntry(store, e, j.provider, 'chrome'), /job_browser_profile_mismatch/);
  }));
test('a retry cannot refresh or acquire a claim after a competing state change', () =>
  fixture((store) => {
    const { e, j, candidate, context } = seed(store),
      retry = retryEntry(store, e, j.provider, 'chromium');
    store.markSubmission(e.id, 'unknown');
    assert.equal(
      store.record(candidate, e.entryUrl, retry.id, 'fresh.png', context).refreshed,
      false,
    );
    assert.equal(store.claimRetry(e.id, 'new-child', retry), false);
    assert.equal(store.submission(e.id)?.job_id, j.id);
  }));
test('restoring a manual handoff requires a separate no-participation confirmation and cannot clear unknown submission evidence', () =>
  fixture((store) => {
    const { e, j } = seed(store);
    manageEntry(store, e, 'manual');
    manageEntry(store, e, 'active');
    assert.equal(entryLifecycle(store, e).canRetry, false);
    assert.throws(() => retryEntry(store, e, j.provider, 'chromium'), /entry_retry_unsafe/);
    manageEntry(store, e, 'active', undefined, true);
    assert.equal(entryLifecycle(store, e).canRetry, true);
    manageEntry(store, e, 'manual');
    assert.equal(
      entryLifecycle(store, e).manualUnconfirmed,
      true,
      'a second handoff needs a new confirmation',
    );
    store.markSubmission(e.id, 'unknown');
    manageEntry(store, e, 'active', undefined, true);
    assert.equal(entryLifecycle(store, e).canRetry, false);
    const untouched = seed(store);
    store.db.prepare('DELETE FROM submissions WHERE event_id=?').run(untouched.e.id);
    assert.equal(canPrepareEntry(store, untouched.e), true);
    manageEntry(store, untouched.e, 'manual');
    manageEntry(store, untouched.e, 'active');
    assert.equal(
      canPrepareEntry(store, untouched.e),
      false,
      'a handoff before the first app attempt still blocks automatic entry',
    );
    manageEntry(store, untouched.e, 'active', undefined, true);
    assert.equal(canPrepareEntry(store, untouched.e), true);
  }));
