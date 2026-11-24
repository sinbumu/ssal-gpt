import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readDeadline } from '../../src/deadline-check.js';
import type { EventRecord } from '../../src/store.js';

test('closing-day check attributes the notice to the event post and ignores a visitor comment', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const post = 'https://www.instagram.com/p/fixture/';
    const event = {
      sourceUrl: post,
      entryUrl: post,
      deadlineDate: '2030-02-03',
      tasks: [{ kind: 'comment', quote: '댓글로 응모하세요' }],
    } as EventRecord;
    const at = Date.parse('2030-02-03T13:00:00+09:00');
    const period = '댓글로 응모하세요<br>참여 기간 30. 2. 1. ~ 30. 2. 3.';
    await page.route('**/*', (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<main></main>' }),
    );
    await page.goto(post);
    await page.setContent(
      `<main><h1>${period}</h1><aside>30. 2. 3. 현재 접수 중입니다.</aside></main>`,
    );
    assert.equal((await readDeadline(page, event, at)).state, 'unknown');
    await page.setContent(`<main><h1>${period}<br>30. 2. 3. 현재 접수 중입니다.</h1></main>`);
    assert.equal((await readDeadline(page, event, at)).state, 'open');
    await page.goto(post + 'unrelated');
    await page.setContent(`<main><h1>${period} 22:00</h1></main>`);
    assert.equal((await readDeadline(page, event, at)).state, 'unknown');
  } finally {
    await browser.close();
  }
});
