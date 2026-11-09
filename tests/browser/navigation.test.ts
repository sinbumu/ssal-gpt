import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Browser } from '../../src/browser.js';
import { actionPolicy } from '../../src/runner.js';
import type { Job } from '../../src/store.js';

test('hidden verification frames permit public reading but displayed challenges invalidate observations', async () => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      req.url === '/demo/start'
        ? `<h1>공개 이벤트 목록</h1><a href="/demo/detail">공식 이벤트</a>
          <iframe id="recaptcha" src="/demo/recaptcha/frame" style="display:none"></iframe>
          <iframe id="hcaptcha" src="/demo/hcaptcha/frame" style="visibility:hidden"></iframe>
          <div id="challenge-running" hidden>인증이 필요합니다</div>`
        : '<p>합성 인증 화면</p>',
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const dir = mkdtempSync(join(tmpdir(), 'ssal-verification-'));
  const browser = new Browser(dir, origin, true);
  try {
    browser.setReadOnlyMode(true);
    await browser.navigate(origin + '/demo/start');
    for (const id of ['recaptcha', 'hcaptcha', 'challenge-running']) {
      const observation = await browser.observe();
      assert.match(observation.text, /공개 이벤트 목록/);
      assert.ok(observation.elements.some((e) => e.label === '공식 이벤트'));
      await browser.page!.locator('#' + id).evaluate((el: HTMLElement) => {
        el.hidden = false;
        el.style.display = 'block';
        el.style.visibility = 'visible';
      });
      await assert.rejects(() => browser.observe(), /verification_required_manual/);
      await assert.rejects(() => browser.assertFresh(observation.id), /stale_observation/);
      await browser.page!.locator('#' + id).evaluate((el: HTMLElement) => {
        el.style.display = 'none';
      });
    }
    // A zero-size background frame also cannot present a challenge.
    await browser.page!.locator('#recaptcha').evaluate((el: HTMLElement) => {
      el.style.cssText = 'display:block;width:0;height:0;border:0';
    });
    assert.match((await browser.observe()).text, /공개 이벤트 목록/);
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

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
