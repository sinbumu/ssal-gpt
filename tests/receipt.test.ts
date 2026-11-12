import test from 'node:test';
import assert from 'node:assert/strict';
import { freshReceipt } from '../src/receipt.js';
import { hash } from '../src/autonomy.js';
import { completionMessage, receiptLineSafe } from '../src/completion.js';
import type { Job } from '../src/store.js';

test('receipt proof is bound to the exact submission, time and origin; old or negative fragments cannot complete it', () => {
  const job = {
    uncertain: true,
    intent: { kind: 'submission', url: 'https://example.org/form', beforeText: '질문', at: 2000 },
  } as Job;
  const evidence = {
    id: 'x',
    url: 'https://example.org/receipt',
    title: 'result',
    text: '답변이 제출되었습니다.',
    screenshot: 'x.png',
    observedAt: 3000,
    intentHash: hash(job.intent),
  };
  assert.ok(freshReceipt(job, evidence, evidence.text));
  assert.equal(freshReceipt(job, { ...evidence, observedAt: 1000 }, evidence.text), false);
  assert.equal(
    freshReceipt(job, { ...evidence, url: 'https://unrelated.example/' }, evidence.text),
    false,
  );
  assert.equal(
    freshReceipt(job, { ...evidence, intentHash: 'other-attempt' }, evidence.text),
    false,
  );
  assert.equal(
    freshReceipt(
      { ...job, intent: { ...job.intent!, beforeText: evidence.text } },
      { ...evidence, intentHash: hash({ ...job.intent, beforeText: evidence.text }) },
      evidence.text,
    ),
    false,
  );
  assert.equal(
    receiptLineSafe('응답을 저장했어요.', '응답을 저장했어요. 처리 오류가 발견되었습니다.'),
    false,
  );
  assert.equal(completionMessage('제출 완료', '예시: 제출 완료'), false);
});
test('participation acknowledgements allow spacing but reject instructions, errors and prior entries', () => {
  for (const text of ['이벤트에 참여 되었습니다.', '이벤트에 참여되었습니다.', '참여가 됐습니다.'])
    assert.equal(completionMessage(text, text), true, text);
  for (const text of [
    '이벤트에 참여 되지 않았습니다.',
    '이벤트에 참여되지 않았습니다.',
    '이미 이벤트에 참여하셨습니다.',
    '이미 이번호 이벤트에 참여하셨습니다.',
    '이미 참여 되었습니다.',
    '예시: 이벤트에 참여 되었습니다.',
    '동의하면 이벤트에 참여 되었습니다.',
    '이벤트에 참여 되었습니다. 처리 오류가 발생했습니다.',
    '참여해 주셔서 감사합니다.',
  ])
    assert.equal(completionMessage(text, text), false, text);
  assert.equal(completionMessage('참여 되었습니다.', '이미 참여 되었습니다.'), false);
});

test('legacy drained redirect evidence is reconciled without browser access, replay or AI; incomplete/conflicting evidence stays locked', async () => {
  const { verifyReceipt } = await import('../src/receipt.js');
  for (const scenario of [
    'complete',
    'unaccounted-post',
    'missing-response',
    'reading-body',
    'new-capture',
    'server-pending',
    'server-error',
    'duplicate',
    'stale',
    'other-origin',
    'multiple-requests',
    'unknown-rejection',
  ] as const) {
    const j = {
      id: 'fixture',
      kind: 'apply',
      uncertain: true,
      status: 'submission_unknown',
      intent: {
        kind: 'submission',
        url: 'https://example.org/form',
        beforeText: '설문 입력',
        at: 100,
      },
      receiptResponses: [],
      receiptObservations: [],
    } as unknown as Job;
    const intentHash = hash(j.intent);
    j.receiptCapture = {
      intentHash,
      requests: 1,
      settled: false,
      diagnostics: {
        observedPosts: 5,
        matchedRequests: 1,
        responses: 1,
        rejected: { unrecognized_destination: 4 },
        popups: 0,
        navigations: 2,
        pageClosed: false,
      },
    };
    j.receiptResponses = [
      {
        id: 'response',
        intentHash,
        url: 'https://example.org/save',
        status: 302,
        at: 110,
        fields: [],
        bodyState: 'unsupported',
      },
    ];
    j.receiptObservations = [
      {
        id: 'screen',
        intentHash,
        url: 'https://example.org/result',
        title: 'fixture',
        text: '등록되었습니다.',
        observedAt: 120,
        screenshot: 'fixture.png',
        links: [],
      },
    ];
    if (scenario === 'unaccounted-post') j.receiptCapture.diagnostics!.observedPosts++;
    if (scenario === 'missing-response') j.receiptResponses = [];
    if (scenario === 'reading-body') j.receiptResponses[0]!.bodyState = 'reading';
    if (scenario === 'new-capture') {
      j.receiptCapture.lifecycle = 'closed';
      j.receiptCapture.pendingTasks = 1;
    }
    if (scenario === 'server-pending') j.receiptResponses[0]!.status = 202;
    if (scenario === 'server-error') j.receiptResponses[0]!.status = 500;
    if (scenario === 'duplicate') j.receiptObservations[0]!.text = '이미 참여하셨습니다.';
    if (scenario === 'stale') j.intent!.at = 130;
    if (scenario === 'other-origin') j.receiptObservations[0]!.url = 'https://other.example/result';
    if (scenario === 'multiple-requests') j.receiptCapture.requests = 2;
    if (scenario === 'unknown-rejection') {
      j.receiptCapture.diagnostics!.rejected = { observation_error: 4 };
    }
    let completed = 0;
    const store = {
      saveJob: () => {},
      complete: () => {
        completed++;
      },
    } as any;
    const noBrowser = new Proxy(
      {},
      {
        get() {
          throw new Error('must use saved evidence only');
        },
      },
    ) as any;
    const model = {
      decide: () => {
        throw new Error('must not use AI');
      },
    } as any;
    assert.equal(
      await verifyReceipt(store, noBrowser, model, j, new AbortController().signal, false),
      scenario === 'complete',
      scenario,
    );
    assert.equal(completed, scenario === 'complete' ? 1 : 0, scenario);
    if (scenario === 'complete') assert.equal(j.receiptCheck?.reconciledCapture, 'legacy_redirect');
    else assert.notEqual(j.receiptCheck?.outcome, 'accepted', scenario);
    if (scenario === 'new-capture') assert.equal(j.receiptCheck?.captureIncomplete, true);
  }
});
