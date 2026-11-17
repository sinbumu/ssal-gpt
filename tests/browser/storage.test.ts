import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  truncateSync,
  utimesSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../../src/server.js';
import { MiB } from '../../src/storage.js';
import type { Job } from '../../src/store.js';

test('storage dashboard previews and removes ordinary evidence, persists controls and blocks overflowing observations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-storage-ui-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  const browser = await chromium.launch(),
    page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    const job = {
      id: randomUUID(),
      status: 'completed',
      kind: 'discover',
      history: [],
      uncertain: false,
      provider: { kind: 'api', model: 'fixture' },
      note: '',
      maxSteps: 10,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      allowedOrigins: [],
      approvedTexts: [],
    } as unknown as Job;
    app.store.saveJob(job);
    const name = `${randomUUID()}.png`,
      path = join(dir, 'evidence', name);
    app.storage.writeImage(name, Buffer.from('old fixture'), job.id);
    const old = new Date(Date.now() - 20 * 86400_000);
    utimesSync(path, old, old);
    await page.goto(app.origin + '/#operations');
    await page.waitForFunction(() =>
      document.querySelector('#storage-summary')?.textContent?.includes('정리 예정 1장'),
    );
    assert.equal(await page.locator('#storage-form [name=automatic]').isChecked(), true);
    assert.equal(
      await page.locator('#storage-form [name=screenshotLimitMiB]').inputValue(),
      '3072',
    );
    await page.locator('#storage-form [name=retentionDays]').fill('21');
    await page.locator('#storage-form button').click();
    await page.waitForFunction(() =>
      document.querySelector('#toast')?.textContent?.includes('보관 설정을 저장'),
    );
    assert.equal(app.storage.settings().retentionDays, 21);
    await page.locator('#storage-form [name=retentionDays]').fill('14');
    await page.locator('#storage-form button').click();
    await page.waitForFunction(() =>
      document.querySelector('#storage-summary')?.textContent?.includes('정리 예정 1장'),
    );
    await page.locator('#storage-cleanup').click();
    await page.waitForFunction(() =>
      document.querySelector('#storage-summary')?.textContent?.includes('정리 예정 0장'),
    );
    assert.ok(!existsSync(path));
    await page.locator('#storage-form').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/ssal-storage-ui.png' });
    assert.equal((await page.request.get(app.origin + '/evidence/' + name)).status(), 410);
    assert.ok(app.store.job(job.id));
    const csrf = (await (await page.request.get(app.origin + '/api/state')).json()).csrf;
    assert.equal(
      (await page.request.post(app.origin + '/api/storage/cleanup', { data: {} })).status(),
      403,
    );
    assert.equal(
      (
        await page.request.post(app.origin + '/api/storage', {
          headers: { Origin: app.origin, 'X-Ssal-Token': csrf },
          data: { screenshotLimitMiB: 4096 },
        })
      ).status(),
      400,
    );
    await app.browser.open();
    await app.browser.page!.goto(app.origin + '/demo/event');
    app.browser.ownerJobId = job.id;
    const observation = await app.browser.observe();
    assert.ok(existsSync(join(dir, 'evidence', observation.screenshot)));
    assert.ok(
      app.store.db
        .prepare('SELECT name FROM evidence_assets WHERE name=?')
        .get(observation.screenshot),
    );
    app.storage.save({ screenshotLimitMiB: 128 });
    const full = join(dir, 'evidence', `${randomUUID()}.png`);
    writeFileSync(full, '');
    truncateSync(full, 128 * MiB);
    await assert.rejects(app.browser.observe(), /storage_screenshot_limit/);
    await app.browser.context!.addCookies([
      {
        name: 'ssal_session_fixture',
        value: 'retained',
        url: app.origin,
        expires: Date.now() / 1000 + 86400,
      },
    ]);
    const cacheDir = join(dir, 'browser', 'Default', 'Cache');
    mkdirSync(cacheDir, { recursive: true });
    const cacheFile = join(cacheDir, 'ssal_synthetic_cache');
    writeFileSync(cacheFile, '');
    truncateSync(cacheFile, 513 * MiB);
    await app.browser.close();
    assert.ok(!existsSync(cacheFile));
    await app.browser.open();
    assert.equal(
      (await app.browser.context!.cookies(app.origin)).find(
        (c) => c.name === 'ssal_session_fixture',
      )?.value,
      'retained',
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
