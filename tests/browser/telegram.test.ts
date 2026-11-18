import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../../src/server.js';
import { OutcomeSchema, putOutcome } from '../../src/outcomes.js';
import { collectNotices } from '../../src/reward-notifications.js';
import type { TelegramRequest } from '../../src/telegram.js';

test('dashboard pairs a private bot, reviews recipient, tests alerts and keeps an independent paginated inbox', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-telegram-ui-'));
  const sends: Record<string, unknown>[] = [];
  let nonce = '';
  const request: TelegramRequest = async (_token, method, body) => {
    if (method === 'getMe') return { is_bot: true, username: 'FixtureAlertsBot' };
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'getUpdates')
      return [
        {
          update_id: 1,
          message: {
            date: Math.floor(Date.now() / 1000),
            text: '/start ' + nonce,
            chat: { id: 12345678, type: 'private' },
            from: { id: 12345678, is_bot: false, first_name: 'Fixture User' },
          },
        },
      ];
    if (method === 'sendMessage') {
      sends.push(body);
      return { message_id: sends.length, chat: { id: body.chat_id, type: 'private' } };
    }
    throw new Error('unexpected request');
  };
  const app = await createApp({ dir, port: 0, headless: true, telegramRequest: request });
  app.scheduler.stop();
  for (let i = 0; i < 21; i++)
    putOutcome(app.store, {
      ...OutcomeSchema.parse({
        eventId: randomUUID(),
        status: 'won',
        sourceUrl: 'https://example.org/',
        note: 'synthetic',
        followUp: { state: 'needs_reply' },
      }),
      updatedAt: new Date().toISOString(),
      reportedBy: 'user',
    });
  collectNotices(app.store);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.origin + '/#rewards');
    await page.locator('#reward-inbox article').first().waitFor();
    assert.equal(await page.locator('#reward-inbox article').count(), 20);
    await page.locator('#reward-inbox-more').click();
    assert.equal(await page.locator('#reward-inbox article').count(), 21);
    await page.locator('#reward-inbox-read').click();
    await page.waitForFunction(() =>
      document.querySelector('#reward-inbox-count')?.textContent?.includes('안 읽음 0개'),
    );
    await page.locator('#reward-inbox-filter').selectOption('unread');
    assert.equal(await page.locator('#reward-inbox article').count(), 0);
    await page.locator('#telegram-settings > summary').click();
    assert.equal(await page.locator('#telegram-activate').isEnabled(), false);
    const token = '123456:fixture_token_without_real_credentials';
    await page.locator('#telegram-pair-form input').fill(token);
    await page.locator('#telegram-pair-form button').click();
    await page.locator('#telegram-pair-link').waitFor();
    nonce = new URL(
      (await page.locator('#telegram-pair-link').getAttribute('href'))!,
    ).searchParams.get('start')!;
    assert.equal(await page.locator('#telegram-pair-form input').inputValue(), '');
    await page.locator('#telegram-find').click();
    await page.waitForFunction(() =>
      document.querySelector('#telegram-connection-status')?.textContent?.includes('Fixture User'),
    );
    assert.equal(sends.length, 0);
    assert.equal(await page.locator('#telegram-activate').isEnabled(), false);
    await page.locator('#telegram-confirm').check();
    await page.locator('#telegram-activate').click();
    await page.waitForFunction(() =>
      document.querySelector('#telegram-connection-status')?.textContent?.includes('알림 사용 중'),
    );
    assert.equal(sends.length, 1);
    await page.locator('#telegram-send-pending').click();
    await page.waitForFunction(() =>
      document.querySelector('#telegram-deliveries')?.textContent?.includes('21개 알림'),
    );
    assert.equal(sends.length, 2);
    assert.match(String(sends[1]!.text), /회신 필요 21건/);
    const state = await (await page.request.get(app.origin + '/api/state')).json();
    assert.ok(!JSON.stringify(state).includes(token));
    assert.equal(state.rewardNotices.length, 21);
    const noCsrf = await page.request.post(app.origin + '/api/telegram/activate', {
      data: { confirmPersonalChat: true },
    });
    assert.equal(noCsrf.status(), 403);
    const notConfirmed = await page.request.post(app.origin + '/api/telegram/activate', {
      headers: { 'x-ssal-token': state.csrf },
      data: { confirmPersonalChat: false },
    });
    assert.equal(notConfirmed.status(), 400);
    await page.locator('#telegram-pause').click();
    await page.waitForFunction(() =>
      document.querySelector('#telegram-connection-status')?.textContent?.includes('알림 중지'),
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
