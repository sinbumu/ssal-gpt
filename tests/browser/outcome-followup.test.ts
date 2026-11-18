import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../../src/server.js';
import { syntheticSettings } from '../../src/autonomy.js';
import {
  OutcomeSchema,
  saveOutcome,
  outcomes,
  outcomeAlerts,
  claimReplyDraft,
  queueResultCheck,
} from '../../src/outcomes.js';
import type { Job } from '../../src/store.js';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-followup-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  app.store.setSettings('autonomy', {
    ...syntheticSettings,
    profile: {
      ...syntheticSettings.profile,
      shippingAddress: '가상 배송 기본주소',
      shippingAddressDetail: '가상 상세주소',
      postalCode: '00000',
    },
  });
  const e = app.store.record(
    {
      title: '가상 달력 당첨',
      organizer: 'Fixture',
      entryUrl: app.origin + '/demo/entry',
      deadline: null,
      prize: '달력',
      winners: 1,
      requirements: [],
      blockers: [],
      evidenceQuote: 'fixture',
      evidenceKind: 'text',
      effortMinutes: 1,
    },
    app.origin + '/demo/entry',
    'fixture',
    'fixture.png',
  ).event;
  const job = {
    id: randomUUID(),
    kind: 'apply',
    eventId: e.id,
    status: 'completed',
    createdAt: new Date().toISOString(),
    history: [],
  } as unknown as Job;
  app.store.saveJob(job);
  app.store.claimSubmission(e.id, job.id);
  app.store.markSubmission(e.id, 'completed', '{}');
  const input = OutcomeSchema.parse({
    eventId: e.id,
    status: 'won',
    sourceUrl: 'https://www.instagram.com/direct/t/123456789/',
    note: '사용자가 받은 당첨 안내 확인',
    claimBy: '2099-01-20',
    reward: { name: '달력' },
    followUp: {
      recipient: 'fixture_official',
      requested: ['name', 'phone', 'address', 'consent'],
      deadlineText: '1월 20일 오후 2시 (요일 불일치)',
      deadlineUncertain: true,
      deliveryNote: '회신 후 1~2주',
    },
  });
  saveOutcome(app.store, input);
  return { app, dir, input };
}

test('won follow-up preserves provenance, bounds preview fields, distinguishes reply from receipt and never sends', async () => {
  const { app, dir, input } = await fixture();
  try {
    assert.throws(
      () => saveOutcome(app.store, { ...input, status: 'pending', reward: undefined }),
      /followup_requires_confirmed_win/,
    );
    assert.throws(
      () =>
        queueResultCheck(app.store, input.eventId, { kind: 'api', model: 'fixture' }, 'chromium'),
      /private_message_check_not_supported/,
    );
    const before = JSON.stringify(outcomes(app.store));
    const draft = claimReplyDraft(app.store, input.eventId, 'unset');
    assert.match(draft.text, /가상 배송 기본주소, 가상 상세주소/);
    assert.ok(draft.missing.includes('개인정보 동의'));
    assert.ok(!draft.text.includes('우편번호'));
    assert.ok(!draft.text.includes(syntheticSettings.profile.email));
    const accepted = claimReplyDraft(app.store, input.eventId, 'accept');
    assert.equal(accepted.missing.length, 0);
    const declined = claimReplyDraft(app.store, input.eventId, 'decline');
    assert.match(declined.text, /동의하지 않습니다/);
    for (const value of [syntheticSettings.profile.phone, '가상 배송 기본주소'])
      assert.ok(!declined.text.includes(value));
    assert.equal(
      JSON.stringify(outcomes(app.store)),
      before,
      'previews must not persist PII or change consent/outcome',
    );
    assert.ok(outcomeAlerts(app.store, '2099-01-18').some((a) => /회신 대기/.test(a.message)));
    const key = outcomeAlerts(app.store, '2099-01-18')[0]!.key;
    assert.notEqual(outcomeAlerts(app.store, '2099-01-20')[0]!.key, key);
    saveOutcome(app.store, { ...input, followUp: { ...input.followUp!, state: 'replied' } });
    assert.ok(outcomeAlerts(app.store, '2099-01-21').every((a) => !/수령 기한/.test(a.message)));
    assert.equal(outcomes(app.store)[0]!.reward?.status, 'expected');
    saveOutcome(app.store, { ...input, followUp: undefined });
    assert.equal(outcomes(app.store)[0]!.followUp?.state, 'replied');
    saveOutcome(app.store, { ...input, reward: { ...input.reward!, status: 'received' } });
    assert.equal(outcomeAlerts(app.store, '2099-01-21').length, 0);
    assert.equal(app.store.jobs().length, 1, 'draft/alerts never schedule external actions');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dashboard shows claim tasks, previews only on request and deduplicates opt-in private browser alerts', async () => {
  const { app, dir, input } = await fixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(`window.rewardNotifications=[]; window.permissionRequests=0;
      class FakeNotification {
        static permission='default';
        static async requestPermission(){window.permissionRequests++;this.permission='granted';return 'granted';}
        constructor(title,options){window.rewardNotifications.push({title,...options});}
        close(){}
      }
      Object.defineProperty(window,'Notification',{value:FakeNotification,configurable:true});`);
    await page.goto(app.origin + '/#rewards');
    await page.locator('#reward-followups article').waitFor();
    assert.match(await page.locator('#reward-followups').innerText(), /기한 안내가 불명확/);
    assert.equal(await page.evaluate(() => (window as any).permissionRequests), 0);
    await page.locator('#enable-reward-notifications').click();
    await page.waitForFunction(() => (window as any).rewardNotifications.length === 1);
    const notification = await page.evaluate(() =>
      JSON.stringify((window as any).rewardNotifications),
    );
    assert.ok(!notification.includes('가상 달력'));
    assert.ok(!notification.includes('fixture_official'));
    await page.locator('#enable-reward-notifications').click();
    assert.equal(await page.evaluate(() => (window as any).rewardNotifications.length), 1);
    await page.locator('#reward-followups [data-outcome]').click();
    assert.equal(await page.locator('#claim-reply-draft').inputValue(), '');
    assert.equal(
      await page.locator('#check-outcome').isEnabled(),
      false,
      'generic result reader must not traverse a private inbox',
    );
    await page.locator('#prepare-claim-reply').click();
    await page.waitForFunction(() =>
      (document.querySelector('#claim-reply-draft') as HTMLTextAreaElement).value.includes(
        '가상 배송 기본주소',
      ),
    );
    assert.match(await page.locator('#claim-reply-status').innerText(), /개인정보 동의/);
    await page.locator('#copy-claim-reply').click();
    await page.waitForFunction(() =>
      document.querySelector('#toast')?.textContent?.includes('미확인 항목'),
    );
    await page.locator('#claim-consent').selectOption('decline');
    await page.locator('#prepare-claim-reply').click();
    await page.waitForFunction(() =>
      (document.querySelector('#claim-reply-draft') as HTMLTextAreaElement).value.includes(
        '동의하지 않습니다',
      ),
    );
    assert.ok(
      !(await page.locator('#claim-reply-draft').inputValue()).includes('가상 배송 기본주소'),
    );
    await page.locator('#clear-claim-reply').click();
    assert.equal(await page.locator('#claim-reply-draft').inputValue(), '');
    assert.equal(outcomes(app.store)[0]!.followUp!.state, 'needs_reply');
    assert.deepEqual(errors, []);
    const result = await page.request.post(app.origin + '/api/outcomes/reply-draft', {
      data: { eventId: input.eventId, consent: 'accept' },
    });
    assert.equal(result.status(), 403, 'explicit private preview requires CSRF');
  } finally {
    await browser.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
