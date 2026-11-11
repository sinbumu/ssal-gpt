import test from 'node:test';
import assert from 'node:assert/strict';
import {
  responseFields,
  classifyResponse,
  combineReceiptSignals,
  receiptTextOutcome,
} from '../src/submission-response.js';
const response = (data: unknown, status = 200) =>
  classifyResponse({
    id: 'fixture',
    intentHash: 'intent',
    url: 'https://example.org/save',
    at: 1,
    status,
    fields: responseFields(JSON.stringify(data), []),
    bodyState: 'parsed',
  });

test('extract only bounded result fields and mask private values; never assume unknown numeric codes', () => {
  const fields = responseFields(
    JSON.stringify({
      code: '0000',
      data: { receipt_no: 'R-42', msg: '접수 완료 tester@example.org 010-1234-5678 가상주소' },
      token: 'secret',
      input: { name: 'private' },
      id: 'not-a-receipt',
    }),
    ['가상주소'],
  );
  assert.deepEqual(
    fields.map((f) => f.kind),
    ['code', 'receipt', 'message'],
  );
  assert.ok(!JSON.stringify(fields).includes('secret'));
  for (const text of ['tester@example.org', '010-1234-5678', '가상주소', 'not-a-receipt'])
    assert.ok(!JSON.stringify(fields).includes(text));
  assert.equal(response({ code: '0000' }).outcome, 'unconfirmed');
  assert.equal(response({ code: 200, success: true, id: 'R-42' }, 201).outcome, 'unconfirmed');
  assert.equal(response({ receipt_no: 'R-42' }).outcome, 'unconfirmed');
  assert.equal(response({ msg: '접수번호' }).outcome, 'unconfirmed');
});
test('separate HTTP transport, receipt, validation, prior entry and conflicting outcomes', () => {
  assert.equal(response({ code: '0000', msg: '이벤트에 참여 되었습니다.' }).outcome, 'accepted');
  assert.equal(response({ success: true, receipt_no: 'R-42' }).outcome, 'accepted');
  assert.equal(response({ receipt_no: 'R-42' }, 201).outcome, 'accepted');
  assert.equal(response({ success: false, msg: '인증문자 오류입니다.' }).outcome, 'rejected');
  assert.equal(
    response({ code: 'DUP', msg: '이미 이번호 이벤트에 참여하셨습니다.' }).outcome,
    'existing',
  );
  assert.equal(response({ status: 'processing' }, 202).outcome, 'pending');
  assert.equal(response({ success: false, msg: '응모 완료' }).outcome, 'conflict');
  assert.equal(
    response({ success: true, receipt_no: 'R-42', status: 'pending' }).outcome,
    'conflict',
  );
  assert.equal(response({ msg: '응모 완료' }, 500).outcome, 'conflict');
  assert.equal(
    combineReceiptSignals([
      response({ msg: '응모 완료' }),
      { kind: 'dialog', outcome: 'rejected', message: '오류입니다.' },
    ]),
    'conflict',
  );
  assert.equal(receiptTextOutcome('이미 이번호 이벤트에 참여하셨습니다.'), 'existing');
  assert.equal(receiptTextOutcome('응답을 잘 받았어요.'), 'unconfirmed');
});
