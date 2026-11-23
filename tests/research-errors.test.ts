import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceError } from '../src/auth.js';
import { researchDiagnostic } from '../src/research-errors.js';
test('wrapped browser error retains cause and code but strips profile, URL, token, call log and home paths', () => {
  const e = new Error(
    'Timeout user Jane Doe token=private-token https://example.org/?secret=foo\nCall log: secret DOM',
  );
  e.name = 'TimeoutError';
  e.stack += '\n at Browser.act (/Users/private/project/src/browser.ts:12:3)';
  const d = researchDiagnostic(
    new ServiceError('statistics_query_unavailable', 400, { cause: e }),
    'query',
    ['Jane Doe'],
    'reobserve',
  );
  assert.equal(d.code, 'statistics_query_unavailable');
  assert.equal(d.errorName, 'TimeoutError');
  assert.ok(d.frames.includes('browser.ts:12:3'));
  assert.doesNotMatch(
    JSON.stringify(d),
    /Jane Doe|private-token|secret=foo|secret DOM|\/Users\/|https:\/\//,
  );
});
