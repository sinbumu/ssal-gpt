import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Browser, browserProfileDirectory } from '../../src/browser.js';
import { createApp } from '../../src/server.js';
import type { Job } from '../../src/store.js';

async function post(app: Awaited<ReturnType<typeof createApp>>, path: string, data: unknown) {
  const state = await fetch(app.origin + '/api/state').then((r) => r.json());
  return fetch(app.origin + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
    body: JSON.stringify(data),
  });
}

test('persistent cookies and local storage survive a full browser restart without extending session cookies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-login-'));
  const app = await createApp({ dir, port: 0, headless: true });
  let reopened: Browser | undefined;
  try {
    await app.browser.navigate(app.origin + '/demo/event');
    await app.browser.context!.addCookies([
      {
        name: 'synthetic_remember',
        value: 'fixture',
        url: app.origin,
        expires: Math.floor(Date.now() / 1000) + 3600,
      },
      { name: 'synthetic_session', value: 'fixture', url: app.origin },
    ]);
    await app.browser.page!.evaluate(() => localStorage.setItem('synthetic_login', 'remembered'));
    assert.equal((await post(app, '/api/browser/close', {})).status, 200);
    reopened = new Browser(dir, app.origin, true);
    await reopened.navigate(app.origin + '/demo/event');
    const cookies = await reopened.context!.cookies();
    assert.equal(cookies.find((c) => c.name === 'synthetic_remember')?.value, 'fixture');
    assert.equal(
      cookies.some((c) => c.name === 'synthetic_session'),
      false,
    );
    assert.equal(
      await reopened.page!.evaluate(() => localStorage.getItem('synthetic_login')),
      'remembered',
    );
  } finally {
    await reopened?.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('closing the selected tab can reopen a live tab while invalidating old observations and job ownership', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-tab-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    await app.browser.navigate(app.origin + '/demo/event');
    const keeper = app.browser.page!;
    const selected = await app.browser.context!.newPage();
    await selected.goto(app.origin + '/demo/event');
    app.browser.ownerJobId = 'old';
    const observation = await app.browser.observe();
    await selected.close();
    await app.browser.navigate(app.origin + '/demo/event');
    assert.equal(app.browser.page, keeper);
    assert.equal(app.browser.ownerJobId, undefined);
    await assert.rejects(() => app.browser.assertFresh(observation.id), /stale_observation/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manual login keeps confirmation dialogs for the user; agent mode retains automatic dismiss', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-dialog-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    await app.browser.navigate(app.origin + '/demo/event');
    const page = app.browser.page!;
    const dialogPromise = page.waitForEvent('dialog');
    const result = page.evaluate(() => confirm('Synthetic remember-login confirmation'));
    const dialog = await dialogPromise;
    await page.waitForTimeout(100);
    await dialog.accept();
    assert.equal(await result, true);
    app.browser.setManual(false);
    assert.equal(await page.evaluate(() => confirm('Synthetic agent dialog')), false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('login diagnostics distinguish visible sign-out, login and Google rejection without returning account text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-login-check-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    await app.browser.open();
    await app.browser.page!.route('https://www.naver.com/**', (route) =>
      route.fulfill({
        body: '<p>private-account@example.invalid</p><a href="/logout">로그아웃</a>',
        contentType: 'text/html; charset=utf-8',
      }),
    );
    await app.browser.navigate('https://www.naver.com/');
    const signed = await app.browser.connectionStatus();
    assert.equal(signed.state, 'signed_in_visible');
    assert.ok(!JSON.stringify(signed).includes('private-account'));
    await app.browser.page!.setContent('<a href="/login">NAVER 로그인</a>');
    assert.equal((await app.browser.connectionStatus()).state, 'login_required');
    await app.browser.page!.setContent('<p>브라우저 또는 앱이 안전하지 않을 수 있습니다.</p>');
    assert.equal((await app.browser.connectionStatus()).state, 'blocked');
    await app.browser.page!.setContent(
      '<p>쿠키가 있다는 사실만으로는 로그인을 확인할 수 없습니다.</p>',
    );
    assert.equal((await app.browser.connectionStatus()).state, 'unknown');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('browser settings reject arbitrary channels; manual external opening is distinct and rejects private URLs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-browser-settings-'));
  const opened: string[] = [];
  const app = await createApp({
    dir,
    port: 0,
    headless: true,
    externalOpen: async (url) => {
      opened.push(url);
    },
  });
  try {
    assert.equal(
      (await post(app, '/api/browser/settings', { engine: '--user-data-dir=elsewhere' })).status,
      400,
    );
    assert.equal(
      (await post(app, '/api/browser/external', { url: 'http://127.0.0.1/private' })).status,
      400,
    );
    const response = await post(app, '/api/browser/external', { url: 'https://www.youtube.com/' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).sharedSession, false);
    assert.deepEqual(opened, ['https://www.youtube.com/']);
    assert.equal(app.browser.context, undefined);
    const now = new Date().toISOString();
    const j: Job = {
      id: randomUUID(),
      kind: 'demo',
      provider: { kind: 'api', model: 'fixture' },
      browserEngine: 'chrome',
      goal: 'test',
      startUrl: app.origin + '/demo/event',
      currentUrl: app.origin + '/demo/event',
      status: 'paused',
      createdAt: now,
      updatedAt: now,
      candidateLimit: 1,
      maxSteps: 20,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      note: '',
      uncertain: false,
      allowedOrigins: [app.origin],
      approvedTexts: [],
      history: [],
    };
    app.store.saveJob(j);
    const mismatch = await post(app, `/api/jobs/${j.id}/resume`, { useCurrentPage: true });
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).error, 'job_browser_profile_mismatch');
    assert.equal(app.store.job(j.id)!.status, 'paused');
    assert.notEqual(
      browserProfileDirectory(dir, 'chromium'),
      browserProfileDirectory(dir, 'chrome'),
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const hasChrome = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome',
].some(existsSync);
test(
  'installed Chrome uses a separate persistent profile and switching back retains Chromium login data',
  { skip: !hasChrome },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssal-chrome-'));
    const app = await createApp({ dir, port: 0, headless: true });
    try {
      await app.browser.navigate(app.origin + '/demo/event');
      await app.browser.context!.addCookies([
        {
          name: 'chromium_only',
          value: 'fixture',
          url: app.origin,
          expires: Math.floor(Date.now() / 1000) + 3600,
        },
      ]);
      assert.equal((await post(app, '/api/browser/settings', { engine: 'chrome' })).status, 200);
      await app.browser.navigate(app.origin + '/demo/event');
      assert.equal(app.browser.engine, 'chrome');
      assert.equal(
        (await app.browser.context!.cookies()).some((c) => c.name === 'chromium_only'),
        false,
      );
      await app.browser.context!.addCookies([
        {
          name: 'chrome_only',
          value: 'fixture',
          url: app.origin,
          expires: Math.floor(Date.now() / 1000) + 3600,
        },
      ]);
      assert.equal((await post(app, '/api/browser/settings', { engine: 'chromium' })).status, 200);
      await app.browser.navigate(app.origin + '/demo/event');
      const cookies = await app.browser.context!.cookies();
      assert.equal(
        cookies.some((c) => c.name === 'chromium_only'),
        true,
      );
      assert.equal(
        cookies.some((c) => c.name === 'chrome_only'),
        false,
      );
      assert.equal(app.store.settings<any>('browser', null).engine, 'chromium');
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
