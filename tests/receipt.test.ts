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
