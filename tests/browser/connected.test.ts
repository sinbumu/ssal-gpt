import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from '../../src/browser.js';

test('explicit local browser connection controls only the selected tab and disconnects without closing user pages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-connected-'));
  const external = await chromium.launchPersistentContext(join(dir, 'external'), {
    headless: true,
    args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'],
  });
  const browser = new Browser(dir, 'http://127.0.0.1:54321', true);
  try {
    const first = external.pages()[0]!;
    await first.setContent('<title>unrelated</title><input value="private untouched">');
    const second = await external.newPage();
    await second.setContent('<title>selected</title><input value="work">');
    await assert.rejects(browser.listConnection('https://example.com:9222/'), /local_debugging/);
    const port = readFileSync(join(dir, 'external', 'DevToolsActivePort'), 'utf8').split('\n')[0];
    const tabs = await browser.listConnection(`http://127.0.0.1:${port}`);
    await browser.connectTab(tabs.find((t) => t.title === 'selected')!.id);
    assert.equal(browser.engine, 'connected');
    await browser.page!.locator('input').fill('updated');
    assert.equal(await second.locator('input').inputValue(), 'updated');
    assert.equal(await first.locator('input').inputValue(), 'private untouched');
    await assert.rejects(
      browser.inReadOnlyTab(async () => {}),
      /extra_tab_not_granted/,
    );
    await browser.close();
    assert.equal(first.isClosed(), false);
    assert.equal(second.isClosed(), false);
    assert.equal(await second.locator('input').inputValue(), 'updated');
    await assert.rejects(browser.open(), /reconnect_required/);
  } finally {
    await browser.close();
    await browser.disconnectPending();
    await external.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
