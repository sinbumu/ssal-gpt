import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Browser } from '../../src/browser.js';
import { actionPolicy } from '../../src/runner.js';
import type { Job } from '../../src/store.js';

test('public header menus can navigate read-only while login, form links and network writes remain blocked', async () => {
  let posts = 0;
  const server = createServer((req, res) => {
    if (req.method === 'POST') posts++;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      req.url === '/demo/start'
        ? `<div class="site_header"><a href="javascript:;" onclick="fetch('/demo/write',{method:'POST'}).catch(()=>{});location.href='/demo/target'">공식 포털</a><a href="javascript:;">로그인</a><form><a href="#">다음</a></form></div><a href="javascript:;">기타 동작</a>`
        : '<p>공개 기관 목록</p>',
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const dir = mkdtempSync(join(tmpdir(), 'ssal-nav-'));
  const browser = new Browser(dir, origin, true);
  try {
    browser.setManual(false);
    browser.setReadOnlyMode(true);
    await browser.open();
    await browser.navigate(origin + '/demo/start');
    const o = await browser.observe();
    const nav = o.elements.find((e) => e.label === '공식 포털')!;
    assert.equal(nav.navigationOnly, true);
    assert.ok(o.elements.filter((e) => e !== nav).every((e) => !e.navigationOnly));
    const step = { action: 'click' as const, ref: nav.ref, observationId: o.id, reason: 'read' };
    assert.equal(actionPolicy({ kind: 'discover' } as Job, step, o), 'allow');
    await browser.act(step);
    assert.equal(browser.page!.url(), origin + '/demo/target');
    assert.equal(posts, 0);
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
