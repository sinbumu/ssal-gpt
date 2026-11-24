import test from 'node:test';
import assert from 'node:assert/strict';
import { assessDeadline } from '../src/deadline-check.js';
import { deadlineState, type EventRecord } from '../src/store.js';
const url = 'https://www.instagram.com/p/fixture/';
const e = {
  deadline: null,
  deadlineDate: '2030-02-03',
  entryUrl: url,
  sourceUrl: url,
  tasks: [{ kind: 'comment', quote: '댓글로 참여하세요.' }],
} as EventRecord;
const at = Date.parse('2030-02-03T13:00:00+09:00');
test('closing-day evidence needs an attributable precise cutoff and is bound to date, source and recent observation', () => {
  const lines = '댓글로 참여하세요.\n참여 기간\n30. 2. 1. ~ 30. 2. 3.';
  const check = (s: string, author = true) => assessDeadline(e, s, author, at);
  assert.equal(check(lines).state, 'unknown');
  assert.equal(check(lines + ' 15:00', false).state, 'unknown');
  const open = check(lines + ' 15:00');
  assert.equal(open.state, 'open');
  assert.equal(deadlineState({ ...e, deadlineCheck: open }, at), 'available');
  assert.equal(
    deadlineState({ ...e, sourceUrl: url + 'other', deadlineCheck: open }, at),
    'closing_today',
  );
  assert.equal(deadlineState({ ...e, deadlineCheck: open }, at + 16 * 60000), 'closing_today');
  assert.equal(deadlineState({ ...e, deadlineCheck: open }, at + 86400000), 'ended');
  assert.equal(check(lines + ' 12:00').state, 'closed');
  assert.equal(check(lines + '\n이벤트가 조기 마감되었습니다.').state, 'closed');
  assert.equal(check(lines + ' 17:00\n소진 시 조기 마감').state, 'unknown');
});
