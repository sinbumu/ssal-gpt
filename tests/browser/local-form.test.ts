import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings } from '../../src/autonomy.js';
import { inspectForm } from '../../src/forms.js';
import { holdLocalForm, releaseLocalForm } from '../../src/local-form.js';
import { armSubmissionConfirm } from '../../src/submission-confirm.js';
import type { Job } from '../../src/store.js';

for (const scenario of ['accepted', 'no-dialog', 'changed-background'] as const) {
  test(`local form ${scenario}: stage opener, isolated modal, saved answer and single reviewed submit`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssal-local-form-'));
    const app = await createApp({ dir, port: 0, headless: true });
    app.scheduler.stop();
    const config = {
      ...syntheticSettings,
      profile: { ...syntheticSettings.profile, phone: '01000000000' },
      policy: { ...syntheticSettings.policy, finalSubmit: 'review' as const },
    };
    app.store.setSettings('autonomy', config);
    const start = app.origin + '/demo/local-form';
    let transmissions = 0;
    const html = `<meta charset="utf-8"><input id="memo" aria-label="응원 메시지 입력" maxlength="30">
      <a href="#" role="button" data-join="01" id="open"><img alt="응원하고 서명하기"></a>
      <a href="#" role="button" id="external"><img alt="다른 사이트에서 참여하기"></a>
      <dialog id="entry"><form id="form" method="dialog"><label>이름<input name="name"></label>
      <label>전화번호<input name="phone"></label></form><button type="submit" form="form">참여하기</button></dialog>
      <script>window.opens=0;
      form.phone.addEventListener('blur',()=>{form.phone.value=form.phone.value.replace(/^(01\\d)(\\d{3,4})(\\d{4})$/, '$1-$2-$3');});
      memo.addEventListener('input',()=>{ fetch('/demo/leak',{method:'POST',body:memo.value}).catch(()=>{}); });
      document.getElementById('open').addEventListener('click',e=>{ e.preventDefault(); window.opens++;
        fetch('/demo/leak?memo='+encodeURIComponent(memo.value)).catch(()=>{});
        ${scenario === 'no-dialog' ? '' : 'entry.showModal();'} });
      form.addEventListener('submit',async e=>{ e.preventDefault();
        if (!confirm('참여 하시겠습니까?')) return;
        const body=new FormData(form); body.set('memo',memo.value);
        await fetch('/demo/save',{method:'POST',body}); entry.close();
        document.body.innerHTML='<h1>응모가 완료되었습니다.</h1>'; });</script>`;
    try {
      await app.browser.open();
      await app.browser.context!.route(app.origin + '/demo/**', async (r) => {
        if (!r.request().url().endsWith('/demo/local-form')) {
          transmissions++;
          assert.equal(r.request().url(), app.origin + '/demo/save');
          assert.match(r.request().postData()!, /name="memo"\r\n\r\n가상 응원 문구/);
          assert.match(r.request().postData()!, /name="phone"\r\n\r\n010-0000-0000/);
          return r.fulfill({
            contentType: 'application/json',
            body: '{"code":"0000","msg":"응모가 완료되었습니다."}',
          });
        }
        await r.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      });
      await app.browser.navigate(start);
      const initial = (await inspectForm(app.browser.page!)).view;
      assert.equal(initial.questions[0]!.maxLength, 30);
      assert.equal(initial.buttons.length, 1);
      assert.ok(initial.buttons[0]!.reveals);
      const autonomy = createAutonomy(config, app.origin);
      autonomy.overrides[initial.questions[0]!.signature] = ['가상 응원 문구'];
      // Existing failure: old plan had no button, and no input/transmission occurred.
      autonomy.plan = { fingerprint: 'old', answers: [] };
      const j: Job = {
        id: randomUUID(),
        kind: 'apply',
        provider: { kind: 'api', model: 'fixture' },
        goal: 'Synthetic dialog entry',
        startUrl: start,
        currentUrl: start,
        status: 'failed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        maxSteps: 10,
        candidateLimit: 1,
        steps: 0,
        inputTokens: 0,
        outputTokens: 0,
        uncertain: false,
        note: '',
        allowedOrigins: [app.origin],
        approvedTexts: [],
        history: [],
        autonomy,
        stopReason: {
          category: 'technical',
          title: 'fixture',
          reason: 'fixture',
          nextAction: 'fixture',
          code: 'form_destination_outside_grant',
          phase: 'form_planning',
          at: Date.now(),
        },
      };
      app.runner.model.decide = (async (_p: unknown, _i: unknown, ctx: any) => ({
        inputTokens: 1,
        outputTokens: 1,
        step: {
          action: 'form_plan',
          observationId: ctx.observation.id,
          reason: 'fixture',
          buttonId: ctx.form.buttons[0]?.id,
          answers: ctx.form.questions.map((q: any) => ({
            questionId: q.id,
            category: 'fact',
            source: q.label === '응원 메시지 입력' ? 'unknown' : 'profile',
            sourceId: q.label === '이름' ? 'name' : 'phone',
            reason: 'fixture',
          })),
        },
      })) as any;
      app.store.saveJob(j);
      app.runner.start(j.id);
      await app.runner.finished();
      let saved = app.store.job(j.id)!;
      assert.equal(transmissions, 0);
      assert.equal(saved.transmitted, undefined);
      assert.equal(saved.uncertain, false);
      assert.equal(await app.browser.page!.evaluate(() => (window as any).opens), 1, saved.note);
      if (scenario === 'no-dialog') {
        assert.equal(saved.stopReason?.code, 'local_form_not_opened');
        saved.status = 'paused';
        app.store.saveJob(saved);
        app.runner.start(j.id);
        await app.runner.finished();
        assert.equal(await app.browser.page!.evaluate(() => (window as any).opens), 1);
        assert.equal(transmissions, 0);
        return;
      }
      assert.equal(saved.status, 'needs_user', saved.note);
      assert.equal(saved.autonomy?.inbox?.final, true);
      assert.equal(saved.formExecution?.reveal?.state, 'verified');
      assert.ok(saved.formExecution!.reveal!.blockedRequests! >= 2);
      assert.match(JSON.stringify(saved.autonomy!.inbox!.review), /가상 응원 문구/);
      const modal = (await inspectForm(app.browser.page!)).view;
      assert.deepEqual(
        modal.questions.map((q) => q.label),
        ['이름', '전화번호'],
      );
      if (scenario === 'changed-background') {
        await app.browser.page!.evaluate(() => {
          (document.querySelector('#memo') as HTMLInputElement).value = '바뀐 내용';
        });
        // A fresh plan cannot silently send a changed first-stage answer.
        delete saved.autonomy!.inbox;
        delete saved.autonomy!.plan;
        saved.status = 'paused';
        app.store.saveJob(saved);
        app.runner.start(j.id);
        await app.runner.finished();
        assert.equal(app.store.job(j.id)!.stopReason?.code, 'local_form_answers_changed');
        assert.equal(transmissions, 0);
        return;
      }
      const state = (await (await fetch(app.origin + '/api/state')).json()) as any;
      const res = await fetch(app.origin + `/api/jobs/${j.id}/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
        body: JSON.stringify({ inboxId: saved.autonomy!.inbox!.id, confirm: true }),
      });
      assert.equal(res.status, 200, await res.text());
      await app.runner.finished();
      saved = app.store.job(j.id)!;
      assert.equal(saved.status, 'completed', saved.note);
      assert.equal(transmissions, 1);
      assert.equal(saved.receiptCapture?.requests, 1);
      assert.equal(saved.receiptCheck?.capture?.bindingChecks?.[0]?.phoneFormatting, 1);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('local guard covers popup requests and preserves an independent tab; ambiguous dialogs are rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-local-guard-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  try {
    await app.browser.open();
    const page = app.browser.page!;
    let received = 0;
    await app.browser.context!.route(app.origin + '/demo/**', (r) => {
      received++;
      return r.fulfill({ body: '<h1>Fixture</h1>' });
    });
    await page.goto(app.origin + '/demo/start');
    received = 0;
    await holdLocalForm(page);
    await page.evaluate((url) => {
      window.open(url);
    }, app.origin + '/demo/popup');
    await page.waitForTimeout(150);
    assert.equal(received, 0);
    const unrelated = await app.browser.context!.newPage();
    await unrelated.goto(app.origin + '/demo/unrelated');
    assert.equal(received, 1);
    await releaseLocalForm(page);
    await page.setContent(
      '<div role="dialog" aria-modal="true"><input></div><div role="dialog" aria-modal="true"><input></div>',
    );
    await assert.rejects(() => inspectForm(page), /multiple_active_form_dialogs/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only one simple final submission confirmation inherits the active page grant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-confirm-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  try {
    await app.browser.open();
    app.browser.setManual(false);
    const page = app.browser.page!;
    await page.goto(app.origin + '/demo/form');
    const confirm = (message = '참여 하시겠습니까?') =>
      page.evaluate((m) => window.confirm(m), message);
    assert.equal(await confirm(), false);
    let active = true;
    let revoke = armSubmissionConfirm(page, () => active);
    assert.equal(await confirm(), true);
    assert.equal(await confirm(), false);
    revoke();
    revoke = armSubmissionConfirm(page, () => active);
    assert.equal(await confirm('개인정보 제3자 제공에 동의하시겠습니까?'), false);
    assert.equal(await confirm(), false);
    revoke();
    revoke = armSubmissionConfirm(page, () => active);
    active = false;
    assert.equal(await confirm(), false);
    revoke();
    active = true;
    revoke = armSubmissionConfirm(page, () => active);
    revoke();
    assert.equal(await confirm(), false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('modal consent notices include their local terms; aggregate select-all is not a separate answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-modal-consent-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  try {
    await app.browser.open();
    await app.browser.page!.setContent(`<dialog open><form>
      <label><input type="checkbox">모두 동의하기</label>
      <section><label>개인정보 수집 동의<input type="checkbox" name="agree" required></label><dl><dt>보관 기간</dt><dd>운영 문안 확정 예정</dd></dl></section>
      <section><label>개인정보 위탁 동의<input type="checkbox" name="privacy" required></label><table><tr><td>가상 운영 대행사</td><td>캠페인 지원</td></tr></table></section>
      <button type="submit">참여하기</button></form></dialog>`);
    const view = (await inspectForm(app.browser.page!)).view;
    assert.deepEqual(
      view.questions.map((q) => q.label),
      ['개인정보 수집 동의', '개인정보 위탁 동의'],
    );
    assert.match(view.questions[0]!.description, /운영 문안 확정 예정/);
    assert.match(view.questions[1]!.description, /가상 운영 대행사/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
