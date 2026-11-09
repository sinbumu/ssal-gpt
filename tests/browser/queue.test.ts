import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from '../../src/browser.js';

test('independent job tabs preserve a filled POST form and invalidate observations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-tabs-'));
  const browser = new Browser(dir, 'http://127.0.0.1:54321', true);
  try {
    await browser.selectJob('one');
    browser.ownerJobId = 'one';
    await browser.page!.setContent(
      '<form method="post"><input name="answer"><button>Submit</button></form>',
    );
    await browser.page!.locator('input').fill('keep this answer');
    const original = browser.page;
    await browser.selectJob('two');
    browser.ownerJobId = 'two';
    assert.notEqual(browser.page, original);
    await browser.page!.setContent('<p>Independent discovery</p>');
    await browser.selectJob('one');
    assert.equal(browser.page, original);
    assert.equal(browser.ownerJobId, 'one');
    assert.equal(await browser.page!.locator('input').inputValue(), 'keep this answer');
    assert.equal(browser.latest, undefined);
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
