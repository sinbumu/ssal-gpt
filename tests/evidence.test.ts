import test from 'node:test';
import assert from 'node:assert/strict';
import { observedQuote } from '../src/evidence.js';
test('candidate quotes tolerate rendered whitespace but preserve the original contiguous source', () => {
  assert.equal(
    observedQuote('선정 인원\n100명\n입니다.', '선정 인원 100명 입니다.'),
    '선정 인원\n100명\n입니다.',
  );
  assert.equal(
    observedQuote('선정 인원 100명, 유료 구매 필요', '선정 인원 100명, 무료 구매 필요'),
    undefined,
  );
  assert.equal(observedQuote('첫 문장 중간 조건 마지막 문장', '첫 문장 마지막 문장'), undefined);
  assert.equal(observedQuote('내용', ''), undefined);
});
