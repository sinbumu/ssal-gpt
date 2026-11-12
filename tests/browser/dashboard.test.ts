import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server.js';

test('dashboard saves operations and schedules with visible controls and no JavaScript errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-ui-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  const browser = await chromium.launch(),
    page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    app.store.setSettings('selection', { kind: 'api', model: 'fixture' });
    await page.goto(app.origin);
    await page.locator('#operations-form [name=dailyCalls]').fill('15');
    await page.locator('#operations-form [name=dailyTokens]').fill('250000');
    await page.locator('#operations-form [name=discoverySwitches]').fill('20');
    await page.locator('#operations-form button[type=submit],#operations-form button').click();
    await page.waitForFunction(() =>
      document.querySelector('#toast')?.textContent?.includes('운영 설정을 저장'),
    );
    assert.equal(app.store.settings<any>('operations', {}).dailyCalls, 15);
    assert.equal(app.store.settings<any>('operations', {}).discoverySwitches, 20);
    await page.reload();
    await page.waitForFunction(
      () =>
        (document.querySelector('#operations-form [name=discoverySwitches]') as HTMLInputElement)
          ?.value === '20',
    );
    await page.locator('#schedule-form [name=name]').fill('합성 예약');
    await page.locator('#schedule-form [name=sourceUrl]').fill(app.origin + '/demo/event');
    await page.locator('#schedule-form button').click();
    await page.waitForFunction(() =>
      document.querySelector('#schedules')?.textContent?.includes('합성 예약'),
    );
    assert.equal(app.store.settings<any[]>('schedules', [])[0].enabled, false);
    assert.equal(await page.locator('#connect-browser-form').count(), 1);
    assert.equal(
      await page.locator('#outcome-summary').innerText(),
      '접수 0건 · 확인한 당첨 0건 · 수령 0건 · 실현 가치 0원',
    );
    assert.deepEqual(errors, []);
    await page.locator('#selection-policy-form [name=facts]').fill('거주지역=서울');
    await page.locator('#selection-policy-form [name=maxMinutes]').fill('6');
    await page.locator('#selection-policy-form button').click();
    await page.waitForFunction(() =>
      document.querySelector('#toast')?.textContent?.includes('기회 선택 기준을 저장'),
    );
    assert.equal(app.store.settings<any>('selectionPolicy', {}).maxMinutes, 6);
    const event = app.store.record(
      {
        title: '합성 성과',
        organizer: 'fixture',
        entryUrl: 'https://example.org/form',
        deadline: '2099-01-01T00:00:00Z',
        prize: '커피',
        winners: 1,
        requirements: ['설문'],
        blockers: [],
        evidenceQuote: '가상',
        evidenceKind: 'text',
        effortMinutes: 2,
      },
      'https://example.org/event',
      'fixture',
      'fixture.png',
    ).event;
    await page.reload();
    await page.locator('#quality-form [name=eventId]').selectOption(event.id);
    await page.locator('#quality-form [name=status]').selectOption('missed');
    await page.locator('#quality-form [name=reason]').fill('합성 운영 검증: 참여 기한을 놓침');
    await page.locator('#quality-form button').click();
    await page.waitForFunction(() =>
      document.querySelector('#quality-records')?.textContent?.includes('참여 기한을 놓침'),
    );
    assert.match(await page.locator('#report-groups').innerText(), /example.org/);
    assert.match(await page.locator('#report-groups').innerText(), /미계측/);
    const csv = await page.request.get(app.origin + '/api/report.csv');
    assert.match(await csv.text(), /합성 운영 검증/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
