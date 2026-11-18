import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Job } from '../src/store.js';
import type { Runner } from '../src/runner.js';
import { OutcomeSchema, putOutcome, outcomes } from '../src/outcomes.js';
import {
  publicResultSource,
  resultCheckPlan,
  startResultBatch,
  resultBatch,
  tickResultBatch,
  controlResultBatch,
  recoverResultBatch,
} from '../src/result-batch.js';

const provider = { kind: 'api' as const, model: 'fixture' };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-result-batch-')),
    store = new Store(dir);
  const add = (
    extra: Record<string, unknown> = {},
    url = 'https://example.org/notice/' + randomUUID(),
  ) => {
    const event = store.record(
      {
        title: '합성 발표 행사 ' + randomUUID(),
        organizer: 'Fixture',
        entryUrl: 'https://form.naver.com/response/' + randomUUID(),
        deadline: null,
        prize: '커피',
        winners: 1,
        requirements: [],
        blockers: [],
        evidenceQuote: '합성 발표 행사',
        evidenceKind: 'text',
        effortMinutes: 1,
        ...extra,
      },
      url,
      'test',
      'test.png',
      {
        sourceEvidence: [
          {
            id: randomUUID(),
            url,
            title: '합성',
            text:
              typeof extra.announcementNote === 'string'
                ? extra.announcementNote
                : '합성 발표 행사',
            screenshot: 'test.png',
            observedAt: Date.now(),
          },
        ],
      },
    ).event;
    const at = new Date().toISOString();
    const job = {
      id: randomUUID(),
      kind: 'apply',
      eventId: event.id,
      status: 'completed',
      createdAt: at,
      updatedAt: at,
      history: [],
    } as unknown as Job;
    store.saveJob(job);
    store.claimSubmission(event.id, job.id);
    store.markSubmission(event.id, 'completed', '{}');
    return event;
  };
  const outcome = (id: string, extra = {}) =>
    putOutcome(store, {
      ...OutcomeSchema.parse({ eventId: id, sourceUrl: store.event(id)!.sourceUrl, ...extra }),
      updatedAt: new Date().toISOString(),
      reportedBy: 'unconfirmed',
    });
  let busy = false,
    started: string[] = [];
  const runner = {
    isBusy: () => busy,
    start: (id: string) => {
      busy = true;
      started.push(id);
      const j = store.job(id)!;
      j.status = 'running';
      store.saveJob(j);
    },
    pause: async (id: string, stop = false) => {
      busy = false;
      const j = store.job(id)!;
      j.status = stop ? 'stopped' : 'paused';
      store.saveJob(j);
    },
  } as unknown as Runner;
  const finish = (status: Job['status'] = 'completed') => {
    busy = false;
    const j = store.job(started.at(-1)!)!;
    j.status = status;
    j.note = '합성 결과';
    store.saveJob(j);
  };
  return {
    dir,
    store,
    add,
    outcome,
    runner,
    started,
    finish,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('batch preview excludes known results, future dates, private-only and form links without writing outcomes', () => {
  const f = fixture();
  try {
    const eligible = f.add();
    f.add({ announcementDate: '2999-01-01' });
    const won = f.add();
    f.outcome(won.id, { status: 'won', note: '사용자 확인' });
    f.add({}, 'https://docs.google.com/forms/d/e/test/viewform');
    const dm = f.add({ announcementNote: '당첨자는 개별 DM으로 안내합니다.' });
    const recent = f.add();
    f.outcome(recent.id);
    const o = outcomes(f.store).find((o) => o.eventId === recent.id)!;
    putOutcome(f.store, {
      ...o,
      check: {
        at: Date.now(),
        state: 'unavailable',
        quote: '없음',
        url: o.sourceUrl,
        screenshot: 'test.png',
      },
    });
    const before = JSON.stringify(outcomes(f.store));
    const plan = resultCheckPlan(f.store);
    assert.deepEqual(
      plan.filter((x) => x.eligible).map((x) => x.eventId),
      [eligible.id],
    );
    assert.equal(JSON.stringify(outcomes(f.store)), before);
    assert.ok(plan.every((x) => x.reason));
    assert.match(plan.find((x) => x.eventId === dm.id)!.reason, /개별 연락/);
    for (const url of [
      'https://www.instagram.com/direct/t/123',
      'https://www.instagram.com/di%72ect/t/123',
      'https://mail.google.com/mail/u/0',
      'https://example.org/logout',
      'https://example.org/notice?token=secret',
      'https://forms.gle/a',
      'https://user:secret@example.org/notice',
      'javascript:alert(1)',
    ])
      assert.equal(publicResultSource(url), false, url);
    assert.equal(publicResultSource('https://www.instagram.com/p/Fixture/'), true);
  } finally {
    f.cleanup();
  }
});

test('a paused individual result job pauses its batch instead of being silently resumed', async () => {
  const f = fixture();
  try {
    f.add();
    startResultBatch(f.store, provider, 'chromium');
    tickResultBatch(f.store, f.runner);
    await f.runner.pause(f.started[0]!);
    tickResultBatch(f.store, f.runner);
    assert.equal(resultBatch(f.store)!.state, 'paused');
    assert.equal(f.started.length, 1);
    await controlResultBatch(f.store, f.runner, 'resume');
    tickResultBatch(f.store, f.runner);
    assert.equal(f.started.length, 2);
    assert.equal(f.started[0], f.started[1]);
  } finally {
    f.cleanup();
  }
});

test('manual batch progresses with queue disabled, deduplicates, isolates failure and preserves known outcomes', () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add();
    startResultBatch(f.store, provider, 'chromium', 10);
    assert.throws(() => startResultBatch(f.store, provider, 'chromium'), /result_batch_exists/);
    tickResultBatch(f.store, f.runner);
    tickResultBatch(f.store, f.runner);
    assert.equal(f.started.length, 1);
    f.finish('failed');
    tickResultBatch(f.store, f.runner);
    assert.equal(f.started.length, 2);
    f.finish();
    tickResultBatch(f.store, f.runner);
    assert.equal(resultBatch(f.store)!.state, 'completed');
    assert.equal(resultBatch(f.store)!.items.filter((x) => x.state === 'done').length, 2);
    assert.deepEqual(new Set(outcomes(f.store).map((x) => x.eventId)), new Set([a.id, b.id]));
    assert.ok(outcomes(f.store).every((x) => x.status === 'pending' && !x.autoCheck));
  } finally {
    f.cleanup();
  }
});

test('pause and restart require explicit resume, stop preserves completed work and never reruns it', async () => {
  const f = fixture();
  try {
    f.add();
    f.add();
    startResultBatch(f.store, provider, 'chromium');
    tickResultBatch(f.store, f.runner);
    f.finish();
    tickResultBatch(f.store, f.runner);
    await controlResultBatch(f.store, f.runner, 'pause');
    tickResultBatch(f.store, f.runner);
    assert.equal(f.started.length, 2);
    await controlResultBatch(f.store, f.runner, 'resume');
    recoverResultBatch(f.store);
    assert.equal(resultBatch(f.store)!.state, 'paused');
    tickResultBatch(f.store, f.runner);
    assert.equal(f.started.length, 2);
    await controlResultBatch(f.store, f.runner, 'resume');
    tickResultBatch(f.store, f.runner);
    assert.equal(f.started.length, 3);
    assert.equal(f.started[1], f.started[2]);
    await controlResultBatch(f.store, f.runner, 'stop');
    tickResultBatch(f.store, f.runner);
    assert.equal(f.started.length, 3);
    assert.equal(resultBatch(f.store)!.items[0]!.state, 'done');
  } finally {
    f.cleanup();
  }
});

test('batch honors existing budget and rechecks changed eligibility before each new job', () => {
  const f = fixture();
  try {
    const a = f.add();
    startResultBatch(f.store, provider, 'chromium');
    f.outcome(a.id, { status: 'won', note: '뒤늦은 사용자 확인' });
    tickResultBatch(f.store, f.runner);
    assert.equal(f.started.length, 0);
    assert.equal(resultBatch(f.store)!.items[0]!.state, 'skipped');
    tickResultBatch(f.store, f.runner);
    f.add();
    startResultBatch(f.store, provider, 'chromium');
    f.store.setSettings('operations', { dailyEstimatedUsd: 1 });
    tickResultBatch(f.store, f.runner);
    assert.equal(f.started.length, 0);
    assert.equal(resultBatch(f.store)!.state, 'paused');
  } finally {
    f.cleanup();
  }
});
