import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server.js';
import { backgroundPage } from '../../src/browser-background.js';

async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-background-'));
  const app = await createApp({ dir, port: 0, headless: true });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await app.browser.navigate(app.origin + '/demo/event');
  return app;
}

test('background job and research tabs preserve the original form, screenshot, input and read-only guard', async (t) => {
  const app = await fixture(t);
  const browser = app.browser;
  const original = browser.page!;
  await original.setContent(
    '<title>Original form</title><input aria-label="answer" value="saved">',
  );
  browser.ownerJobId = 'first';
  await browser.selectJob('second');
  const second = browser.page!;
  assert.notEqual(second, original);
  browser.ownerJobId = 'second';
  await second.goto(app.origin + '/demo/event');
  await second.setContent(
    '<title>Second form</title><input aria-label="answer"><button>Continue</button>',
  );
  await second.getByLabel('answer').fill('second answer');
  assert.ok((await browser.observe()).image.length > 1000);
  await browser.inReadOnlyTab(async () => {
    assert.notEqual(browser.page, second);
    await browser.navigate(app.origin + '/demo/event');
    const blocked = await browser.page!.evaluate(async () => {
      try {
        await fetch('/demo/unsafe', { method: 'POST', body: 'must not send' });
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(blocked, true);
  });
  assert.equal(browser.page, second);
  assert.equal(await second.getByLabel('answer').inputValue(), 'second answer');
  await browser.selectJob('first');
  assert.equal(browser.page, original);
  assert.equal(await original.getByLabel('answer').inputValue(), 'saved');
});

test('native popup form POST, opener messages and element focus survive window-focus suppression', async (t) => {
  const app = await fixture(t);
  const browser = app.browser;
  browser.setManual(false);
  const context = browser.context!;
  const origin = app.origin;
  let posts = 0;
  await context.route(origin + '/demo/focus-popup', async (route) => {
    assert.equal(route.request().method(), 'POST');
    assert.equal(route.request().postData(), 'answer=fixture');
    posts++;
    await route.fulfill({
      contentType: 'text/html',
      body: `<title>Popup receipt</title><h1>Accepted</h1><input id="field"><script>window.focus();document.querySelector('input').focus();opener.postMessage('accepted',location.origin)</script>`,
    });
  });
  const parent = browser.page!;
  await parent.setContent(
    `<form method="post" action="${origin}/demo/focus-popup" target="result"><input name="answer" value="fixture"><button>Submit</button></form><output></output><script>addEventListener('message',e=>document.querySelector('output').textContent=e.data)</script>`,
  );
  const popupReady = parent.waitForEvent('popup');
  await parent.getByRole('button', { name: 'Submit' }).click();
  const popup = await popupReady;
  await popup.waitForLoadState('domcontentloaded');
  assert.equal(await popup.locator('h1').innerText(), 'Accepted');
  assert.equal(await popup.evaluate(() => document.activeElement?.id), 'field');
  await parent.locator('output').filter({ hasText: 'accepted' }).waitFor();
  assert.equal(await popup.opener(), parent);
  assert.equal(posts, 1);
  assert.equal(browser.page, popup);
  assert.ok((await browser.observe()).image.length > 1000);
  await popup.close();
  assert.equal(parent.isClosed(), false);
});

test('dashboard open explicitly activates; automatic navigation, job switches and research never call bringToFront', async (t) => {
  const app = await fixture(t);
  let activations = 0;
  const patch = (page: NonNullable<typeof app.browser.page>) => {
    page.bringToFront = async () => {
      activations++;
    };
  };
  patch(app.browser.page!);
  app.browser.context!.on('page', patch);
  app.browser.ownerJobId = 'first';
  await app.browser.selectJob('second');
  await app.browser.navigate(app.origin + '/demo/event');
  await app.browser.inReadOnlyTab(async () => app.browser.navigate(app.origin + '/demo/event'));
  assert.equal(activations, 0);
  const state = await fetch(app.origin + '/api/state').then((r) => r.json());
  const response = await fetch(app.origin + '/api/browser/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
    body: JSON.stringify({ url: app.origin + '/demo/event' }),
  });
  assert.equal(response.status, 200);
  assert.equal(activations, 1);
});

test('background tab creation fails without opening a foreground fallback or losing the existing page', async (t) => {
  const app = await fixture(t);
  const context = app.browser.context!;
  const original = app.browser.page!;
  const createSession = context.newCDPSession.bind(context);
  let attempted = 0;
  context.newCDPSession = async (page) => {
    const session = await createSession(page);
    const send = session.send.bind(session);
    session.send = (async (method: string, params: unknown) => {
      if (method === 'Target.createTarget') {
        attempted++;
        assert.equal((params as { background: boolean }).background, true);
        assert.equal((params as { focus: boolean }).focus, false);
        throw new Error('fixture creation rejected');
      }
      return send(method as never, params as never);
    }) as typeof session.send;
    return session;
  };
  await assert.rejects(backgroundPage(context, original), /browser_background_tab_failed/);
  await assert.rejects(
    app.browser.inReadOnlyTab(async () => assert.fail('must not run')),
    /browser_background_tab_failed/,
  );
  assert.equal(attempted, 2);
  assert.equal(context.pages().length, 1);
  assert.equal(app.browser.page, original);
  assert.equal(original.isClosed(), false);
  assert.equal((app.browser as unknown as { readOnlyMode: boolean }).readOnlyMode, false);
  app.browser.ownerJobId = 'saved-job';
  await assert.rejects(app.browser.selectJob('new-job'), /browser_background_tab_failed/);
  assert.equal(app.browser.page, original);
  assert.equal(app.browser.ownerJobId, 'saved-job');
});
