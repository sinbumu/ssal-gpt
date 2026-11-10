import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Browser } from '../../src/browser.js';
import { actionPolicy } from '../../src/runner.js';
import type { Job } from '../../src/store.js';
import { readDecision } from '../../src/read-trace.js';

test('collapsed reel caption is a scoped read control; form, toggles and nested links are not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-caption-')),
    browser = new Browser(dir, undefined, true);
  let writes = 0;
  const text = '이벤트 설명입니다. 팔로우 좋아요 댓글 조건을 끝까지 확인합니다. '.repeat(12);
  const clipped = `<div style="overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;width:273px;line-height:18px">${text}</div>`;
  try {
    await browser.open();
    browser.setManual(false);
    browser.setReadOnlyMode(true);
    await browser.context!.route('https://www.instagram.com/**', async (route) => {
      if (route.request().method() === 'POST') writes++;
      await route.fulfill({
        contentType: 'text/html',
        body: `<main><div id="caption" role="button" onclick="this.firstElementChild.style.webkitLineClamp='unset';this.removeAttribute('role')">${clipped}</div><form><div role="button">${clipped}</div></form><div role="button" aria-pressed="false">${clipped}</div><div role="button">${clipped}<a href="/account/">가입</a></div><button>더 보기</button></main>`,
      });
    });
    await browser.navigate('https://www.instagram.com/reels/synthetic/');
    const o = await browser.observe(),
      controls = o.elements.filter((e) => e.readDisclosure);
    assert.equal(controls.length, 1);
    const step = {
      action: 'click' as const,
      observationId: o.id,
      ref: controls[0]!.ref,
      reason: '본문 펼치기',
    };
    assert.equal(readDecision(o, step, []), 'allowed');
    assert.equal(actionPolicy({ kind: 'discover' } as Job, step, o), 'allow');
    await browser.page!.evaluate(() => document.body.append(document.createElement('span')));
    assert.equal(await browser.act(step), true, 'unrelated mutation rebinds the identical caption');
    assert.equal((await browser.observe()).elements.filter((e) => e.readDisclosure).length, 0);
    assert.equal(await browser.page!.locator('#caption').getAttribute('role'), null);
    await browser.navigate('https://www.instagram.com/reels/synthetic/');
    const prior = await browser.observe(),
      target = prior.elements.find((e) => e.readDisclosure)!;
    await browser.page!.locator('#caption > div').evaluate((e) => e.append('내용이 바뀜'));
    await assert.rejects(
      () => browser.act({ ...step, observationId: prior.id, ref: target.ref }),
      /stale_observation/,
    );
    await browser.navigate('https://www.instagram.com/synthetic_profile/');
    assert.equal(
      (await browser.observe()).elements.some((e) => e.readDisclosure),
      false,
    );
    assert.equal(writes, 0);
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test('post media arrows are read controls while forms, outside arrows, stale refs and profile arrows are not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-media-nav-'));
  const browser = new Browser(dir, undefined, true);
  let writes = 0;
  try {
    await browser.open();
    await browser.context!.route('https://www.instagram.com/**', async (route) => {
      if (route.request().method() === 'POST') writes++;
      await route.fulfill({
        contentType: 'text/html',
        body: `<main><div style="position:relative;width:400px;height:240px"><img width="400" height="240" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"><button id="media" aria-label="Next" style="position:absolute;right:5px;top:100px" onclick="document.querySelector('#card').textContent='second card'">→</button><form style="position:absolute;left:5px;top:100px"><button id="form-arrow" aria-label="Previous">←</button></form></div><p id="card">first card</p><form><input placeholder="answer"><button id="submit">Next</button></form><button id="outside">Next</button><button id="like" aria-pressed="false">Like</button></main>`,
      });
    });
    browser.setManual(false);
    browser.setReadOnlyMode(true);
    await browser.navigate('https://www.instagram.com/p/media-fixture/');
    const o = await browser.observe();
    const next = o.elements.find((e) => e.mediaNavigation === 'next')!;
    assert.ok(next);
    assert.equal(o.hasResponseFields, true);
    assert.equal(o.elements.filter((e) => e.mediaNavigation).length, 1);
    const step = {
      action: 'click' as const,
      observationId: o.id,
      ref: next.ref,
      reason: 'read next card',
    };
    // Existing generic Next rule would reject this because a comment/form field exists.
    assert.equal(
      actionPolicy({ kind: 'discover' } as Job, step, {
        ...o,
        elements: o.elements.map((e) => ({ ...e, mediaNavigation: undefined })),
      }),
      'block',
    );
    assert.equal(actionPolicy({ kind: 'discover' } as Job, step, o), 'allow');
    for (const e of o.elements.filter((e) => !e.mediaNavigation))
      if (e.tag === 'button')
        assert.equal(
          actionPolicy({ kind: 'discover' } as Job, { ...step, ref: e.ref }, o),
          'block',
        );
    await browser.page!.evaluate(() => {
      const a = document.createElement('button');
      a.textContent = 'unrelated';
      document.body.prepend(a);
    });
    assert.equal(
      await browser.act(step),
      true,
      'unrelated mutation rebinds the same read-only media control',
    );
    assert.match((await browser.observe()).text, /second card/);
    await assert.rejects(() => browser.act(step), /stale_observation/);
    const changed = await browser.observe();
    const arrow = changed.elements.find((e) => e.mediaNavigation)!;
    await browser.page!.locator('img').evaluate((img: HTMLImageElement) => {
      img.src =
        'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="400" height="240"/%3E';
    });
    await assert.rejects(
      () => browser.act({ ...step, observationId: changed.id, ref: arrow.ref }),
      /stale_observation/,
    );
    await browser.navigate('https://www.instagram.com/fixture_profile/');
    assert.ok((await browser.observe()).elements.every((e) => !e.mediaNavigation));
    assert.equal(writes, 0);
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
