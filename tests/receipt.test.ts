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
