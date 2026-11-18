import test from 'node:test';
import assert from 'node:assert/strict';
import { submissionRoute, submissionBodyMatch } from '../src/submission-request.js';
import { classifyResponse, responseFields } from '../src/submission-response.js';
const page = 'https://form.naver.com/response/fixtureSurvey';
const endpoint = 'https://survey-api.naver.com/api/form/surveys/fixtureSurvey/answers';
const values = ['가상 참가자', '01000000000'];
test('verified campaign receipt code applies only to the bound registration contract', () => {
  const root = 'https://campaign.daum-kg.net/2028g20incheon/';
  const target = root + 'process/event_join_register.php';
  assert.equal(submissionRoute(root + '#event1', target), 'campaign-g20-entry');
  assert.equal(submissionRoute(root + 'index_new.html', target), 'same-origin');
  assert.equal(submissionRoute(root, target + '?other=1'), 'same-origin');
  assert.equal(submissionRoute(root.replace('.net', '.net.evil.org'), target), undefined);
  const classify = (data: unknown, url = target, contract: any = 'campaign-g20-entry') =>
    classifyResponse({
      id: 'f',
      intentHash: 'f',
      url,
      status: 200,
      at: 1,
      fields: responseFields(JSON.stringify(data), []),
      bodyState: 'parsed',
      contract,
    }).outcome;
  assert.equal(classify({ result: 'ok' }), 'accepted');
  assert.equal(classify({ result: 'error' }), 'rejected');
  assert.equal(classify({ result: 'ok', msg: '이미 참여하셨습니다.' }), 'conflict');
  assert.equal(classify({ result: 'ok' }, target + '?other=1'), 'unconfirmed');
  assert.equal(classify({ result: 'ok' }, target, null), 'unconfirmed');
});
test('multipart capture matches text answers only; missing boundary, files and secrets do not prove a request', async () => {
  const form = new FormData();
  form.set('name', values[0]);
  form.set('phone', values[1]);
  form.set('emptyFile', new Blob([]), '');
  const req = new Request('https://example.org', { method: 'POST', body: form });
  const body = await req.text(),
    type = req.headers.get('content-type')!;
  assert.equal(submissionBodyMatch(body, type, values), 'matched');
  assert.equal(submissionBodyMatch(body, 'multipart/form-data', values), 'unsupported_body');
  assert.equal(submissionBodyMatch(body.slice(0, -6), type, values), 'unsupported_body');
  assert.equal(
    submissionBodyMatch(body.replace('name="phone"', 'name="token"'), type, values),
    'payload_mismatch',
  );
  const files = new FormData();
  files.set('name', values[0]);
  files.set('file', new Blob([values[1]]), 'test.txt');
  const fileReq = new Request('https://example.org', { method: 'POST', body: files });
  assert.equal(
    submissionBodyMatch(await fileReq.text(), fileReq.headers.get('content-type')!, values),
    'payload_mismatch',
  );
  const result = responseFields('{"result":"ok","name":"private"}', []);
  assert.deepEqual(result, [{ kind: 'status', key: 'result', value: 'ok' }]);
  assert.equal(
    classifyResponse({
      id: 'f',
      intentHash: 'f',
      url: 'https://example.org',
      status: 200,
      at: 1,
      fields: result,
      bodyState: 'parsed',
    }).outcome,
    'unconfirmed',
  );
});
test('provider receipt route is exact to the approved survey; arbitrary cross-origin and update routes stay excluded', () => {
  assert.equal(submissionRoute(page, endpoint), 'naver-form-answer');
  for (const u of [
    endpoint + '/old',
    endpoint + '?other=1',
    endpoint.replace('fixtureSurvey', 'anotherSurvey'),
    endpoint.replace('survey-api.naver.com', 'survey-api.naver.com.evil.org'),
    endpoint.replace('/answers', '/answers/status'),
  ])
    assert.equal(submissionRoute(page, u), undefined);
  assert.equal(
    submissionRoute('https://other.example/response/fixtureSurvey', endpoint),
    undefined,
  );
  assert.equal(submissionRoute(page, 'https://form.naver.com/save'), 'same-origin');
});
test('nested answer binding excludes tokens, extras, missing answers and oversized payloads', () => {
  const body = JSON.stringify({
    items: values.map((value) => ({ questionId: 1, value })),
    taToken: 'secret',
    extras: {},
  });
  assert.equal(
    submissionBodyMatch(body, 'application/json', values, 'naver-form-answer'),
    'matched',
  );
  assert.equal(
    submissionBodyMatch(
      JSON.stringify({ items: [{ value: values[0] }], taToken: values[1] }),
      'application/json',
      values,
      'naver-form-answer',
    ),
    'payload_mismatch',
  );
  assert.equal(
    submissionBodyMatch(
      JSON.stringify({ items: [], extras: { values } }),
      'application/json',
      values,
      'naver-form-answer',
    ),
    'payload_mismatch',
  );
  assert.equal(
    submissionBodyMatch(JSON.stringify({ data: { answers: values } }), 'application/json', values),
    'matched',
  );
  assert.equal(
    submissionBodyMatch(
      JSON.stringify({ name: values[0], token: values[1] }),
      'application/json',
      values,
    ),
    'payload_mismatch',
  );
  assert.equal(
    submissionBodyMatch('x'.repeat(65537), 'application/json', values),
    'unsupported_body',
  );
  assert.equal(submissionBodyMatch(body, 'application/json', [values[0]]), 'insufficient_values');
  assert.equal(
    submissionBodyMatch(body, 'application/json', [values[1]], 'naver-form-answer'),
    'matched',
  );
  assert.equal(
    submissionBodyMatch(body, 'application/json', ['짧음'], 'naver-form-answer'),
    'insufficient_values',
  );
  assert.equal(submissionBodyMatch(body, 'application/json', [values[1]]), 'insufficient_values');
});
test('Naver saved-answer contract separates success, duplicate and rejection without inventing receipt numbers', () => {
  const response = (data: unknown, contract: any = 'naver-form-answer', url = endpoint) =>
    classifyResponse({
      id: 'fixture',
      intentHash: 'fixture',
      url,
      status: 200,
      at: 1,
      fields: responseFields(JSON.stringify(data), []),
      bodyState: 'parsed',
      contract,
    });
  assert.equal(
    response({ success: true, available: true, surveyStatus: 'IN_PROGRESS' }).outcome,
    'accepted',
  );
  assert.equal(response({ success: true }, null).outcome, 'unconfirmed');
  assert.equal(
    response({ success: true }, 'naver-form-answer', 'https://example.org/save').outcome,
    'unconfirmed',
  );
  assert.equal(response({ success: false, error: 'DUPLICATED' }).outcome, 'existing');
  assert.equal(response({ success: false, error: 'INVALID_PARAM' }).outcome, 'rejected');
  assert.equal(response({ success: true, error: 'INVALID_PARAM' }).outcome, 'conflict');
  assert.deepEqual(response({ success: true }).receiptNumbers, []);
  assert.deepEqual(response({ success: true }).flags, ['success=true']);
});
