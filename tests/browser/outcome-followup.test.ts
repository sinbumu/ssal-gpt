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
  putOutcome,
  saveRewardProgress,
  RewardProgressSchema,
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
    provider: { kind: 'api', model: 'fixture' },
    steps: 0,
    maxSteps: 30,
    inputTokens: 0,
    outputTokens: 0,
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

test('reward progress preserves evidence and secrets, distinguishes unknown and zero value, and rejects stale edits', async () => {
  const { app, dir, input } = await fixture();
  try {
    const original = outcomes(app.store)[0]!;
    original.reportedBy = 'agent';
    original.reward!.code = 'PRIVATE-CODE';
    original.check = {
      at: Date.now(),
      state: 'announced',
      quote: 'fixture',
      screenshot: '',
      url: app.origin + '/demo/result',
    };
    putOutcome(app.store, original);
    const write = (patch: Record<string, unknown>) =>
      saveRewardProgress(
        app.store,
        RewardProgressSchema.parse({
          eventId: input.eventId,
          expectedUpdatedAt: outcomes(app.store)[0]!.updatedAt,
          ...patch,
        }),
      );
    const replied = write({ stage: 'replied' });
    assert.equal(replied.followUp?.state, 'replied');
    assert.ok(replied.followUp?.repliedAt);
    assert.equal(replied.reward?.status, 'expected');
    assert.equal(replied.reportedBy, 'agent');
    assert.deepEqual(replied.check, original.check);
    assert.equal(replied.reward?.code, 'PRIVATE-CODE');
    assert.throws(
      () =>
        saveRewardProgress(app.store, {
          eventId: input.eventId,
          expectedUpdatedAt: original.updatedAt,
          stage: 'received',
          rewardName: '달력',
          valueKnown: false,
        }),
      /reward_progress_changed/,
    );
    assert.throws(
      () => write({ stage: 'received', rewardName: '달력', valueKnown: true }),
      /reward_receipt_fields_required/,
    );
    const received = write({ stage: 'received', rewardName: '달력', valueKnown: false });
    assert.equal(received.followUp?.state, 'done');
    assert.equal(received.reward?.valueKnown, false);
    assert.equal(received.reward?.status, 'received');
    assert.equal(received.reward?.faceValue, 0);
    assert.equal(outcomeAlerts(app.store).length, 0);
    assert.ok(received.reward?.receivedAt);
    const zero = write({
      stage: 'received',
      rewardName: '기타 선물',
      valueKnown: true,
      faceValue: 0,
    });
    assert.equal(zero.reward?.valueKnown, true);
    assert.equal(zero.reward?.receivedAt, received.reward?.receivedAt);
    const valued = write({
      stage: 'received',
      rewardName: '상품권',
      valueKnown: true,
      faceValue: 5000,
    });
    assert.equal(valued.reward?.faceValue, 5000);
    assert.equal(valued.reward?.realizedValue, 0);
    assert.equal(app.store.jobs().length, 1, 'recording receipt must not launch browser or model');
    const state = (await (await fetch(app.origin + '/api/state')).json()) as any;
    assert.ok(!JSON.stringify(state.outcomes).includes('PRIVATE-CODE'));
    const forbidden = await fetch(app.origin + '/api/outcomes/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: input.eventId,
        expectedUpdatedAt: valued.updatedAt,
        stage: 'replied',
      }),
    });
    assert.equal(forbidden.status, 403);
    putOutcome(app.store, { ...valued, status: 'pending' });
    assert.throws(() => write({ stage: 'replied' }), /confirmed_win_required/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reward modal records reply then receipt, permits custom and unknown values, and reopens history on mobile', async () => {
  const { app, dir, input } = await fixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.origin + '/#rewards');
    await page.locator('#reward-followups [data-stage="replied"]').click();
    assert.ok(await page.locator('#reward-progress-dialog').isVisible());
    await page.locator('#reward-progress-save').click();
    await page.locator('#reward-progress-dialog').waitFor({ state: 'hidden' });
    assert.equal(outcomes(app.store)[0]!.followUp?.state, 'replied');
    assert.equal(outcomes(app.store)[0]!.reward?.status, 'expected');
    assert.match(await page.locator('#reward-followups').innerText(), /회신 완료 · 수령 대기/);
    assert.ok(
      !(await page.locator('#reward-followups').innerText()).includes('기한 안내가 불명확'),
    );
    await page.locator('#reward-followups [data-stage="received"]').click();
    assert.equal(
      await page.locator('#reward-progress-form [name=rewardName]').inputValue(),
      '달력',
    );
    assert.equal(
      await page.locator('#reward-progress-form [name=valueKind]').inputValue(),
      'unknown',
    );
    await page.locator('#reward-prize-choice').selectOption('custom');
    await page.locator('#reward-progress-form [name=rewardName]').fill('직접 적은 달력');
    // Periodic state refresh must not wipe an open modal's edit.
    await page.waitForResponse((r) => r.url().endsWith('/api/state'));
    assert.equal(
      await page.locator('#reward-progress-form [name=rewardName]').inputValue(),
      '직접 적은 달력',
    );
    await page.locator('#reward-progress-save').click();
    await page.locator('#reward-progress-dialog').waitFor({ state: 'hidden' });
    assert.equal(outcomes(app.store)[0]!.reward?.name, '직접 적은 달력');
    assert.equal(outcomes(app.store)[0]!.reward?.valueKnown, false);
    assert.equal(await page.locator('#reward-followups article').count(), 0);
    assert.match(await page.locator('#reward-received').innerText(), /가치 미정/);
    await page.locator('#reward-received [data-reward-progress]').click();
    await page.locator('#reward-progress-form [name=valueKind]').selectOption('known');
    await page.locator('#reward-progress-form [name=faceValue]').fill('12000');
    await page.locator('#reward-progress-save').click();
    await page.locator('#reward-progress-dialog').waitFor({ state: 'hidden' });
    assert.match(await page.locator('#reward-received').innerText(), /12,000원/);
    await page.locator('#reward-received [data-outcome]').click();
    assert.ok(await page.locator('#outcome-dialog').isVisible());
    assert.equal(
      await page
        .locator('#outcome-guide a')
        .filter({ hasText: '받은 당첨 DM' })
        .getAttribute('href'),
      input.sourceUrl,
    );
    const box = await page.locator('#outcome-dialog').boundingBox();
    assert.ok(box && box.x >= 0 && box.width <= 390);
    await page.getByRole('button', { name: '결과 창 닫기', exact: true }).click();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('announcement alert opens a visible result modal with observed links and uncertain result, never an assumed loss', async () => {
  const { app, dir, input } = await fixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const old = outcomes(app.store)[0]!;
    putOutcome(app.store, {
      ...old,
      status: 'pending',
      reward: undefined,
      followUp: undefined,
      sourceUrl: app.origin + '/demo/result',
      check: {
        at: Date.now(),
        state: 'announced',
        quote: '당첨자에게 DM 발송',
        url: 'https://www.instagram.com/p/fixture/',
        screenshot: '',
      },
      dmChecks: [
        {
          organizer: 'fixture_official',
          state: 'no_evidence',
          at: Date.now(),
          url: 'https://www.instagram.com/direct/t/123456789/',
          quote: '',
          reason: 'fixture',
          screenshot: '',
          key: 'f'.repeat(64),
        } as any,
      ],
    });
    const page = await browser.newPage();
    await page.goto(app.origin + '/#rewards');
    await page.locator('#outcome-alerts [data-outcome]').click();
    assert.ok(await page.locator('#outcome-dialog').isVisible());
    assert.match(await page.locator('#outcome-guide').innerText(), /인스타그램 DM/);
    assert.match(await page.locator('#outcome-guide').innerText(), /낙첨 확정 아님/);
    assert.equal(
      await page
        .locator('#outcome-guide a')
        .filter({ hasText: '발표를 확인한' })
        .getAttribute('href'),
      'https://www.instagram.com/p/fixture/',
    );
    assert.equal(
      await page.locator('#outcome-guide a').filter({ hasText: 'DM 열기' }).getAttribute('href'),
      'https://www.instagram.com/direct/t/123456789/',
    );
    assert.ok(await page.locator('#outcome-guide a').filter({ hasText: '이벤트 안내' }).count());
    assert.equal(outcomes(app.store)[0]!.status, 'pending');
    await page.getByRole('button', { name: '결과 창 닫기', exact: true }).click();
    putOutcome(app.store, {
      ...outcomes(app.store)[0]!,
      check: {
        ...old.check,
        at: Date.now(),
        state: 'announced',
        quote: '당첨자 발표',
        screenshot: '',
        url: app.origin + '/demo/result',
      },
      dmChecks: [],
    });
    await page.waitForResponse((r) => r.url().endsWith('/api/state'));
    await page.locator('#outcome-alerts [data-outcome]').click();
    assert.match(
      await page.locator('#outcome-guide').innerText(),
      /연락 방법은 아직 확인되지 않았습니다/,
    );
  } finally {
    await browser.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
