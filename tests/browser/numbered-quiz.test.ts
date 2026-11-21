import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings } from '../../src/autonomy.js';
import { inspectForm, formValuesHash } from '../../src/forms.js';
import { errorNotice } from '../../src/job-notice.js';
import type { Job } from '../../src/store.js';

const quiz = Array.from(
  { length: 7 },
  (_, i) =>
    `<section id="ans${i + 1}"><h3>${i + 1}. ${i + 1} 더하기 1은?</h3><div class="chk_wrap flex">${[String(i + 2), '25.61%', '99개', '100'].map((label, n) => `<p class="answer"><button class="num" onclick="choose(this)">${n + 1}</button>${label}</p>`).join('')}</div><ul class="hint_box"><li>화면의 수를 더하세요.</li></ul></section>`,
).join('');
const html = (mode: string) => `<meta charset="utf-8"><h1>가상 숫자 선택 퀴즈</h1>${quiz}
<div class="notice">개인정보 수집 및 이용 동의: 성명, 휴대전화번호를 경품 지급 목적으로 사용하며 경품 지급 후 파기합니다. 동의하지 않으면 이벤트에 참여할 수 없습니다.</div>
<div class="chk"><div class="tb_wr"><table><tr><th>개인정보수집</th><td><div><input type="radio" id="agree" name="agreement" onclick="agreeChanged()"><label for="agree">동의</label><input type="radio" id="decline" name="agreement" checked><label for="decline">비동의</label></div></td></tr>
<tr><th>성명</th><td><input id="name" placeholder="성명을 입력해주세요"></td></tr><tr><th>전화</th><td><input id="phone" placeholder="휴대전화번호"></td></tr></table></div></div>
<div id="buttons" style="display:none"><button type="button" onclick="sendEntry()">제출하기</button><button type="button">취소</button></div>
<button id="unrelated">8</button>
<script>window.choiceClicks=0;
function choose(button){ window.choiceClicks++; ${mode === 'no-selection' ? '' : "button.closest('section').querySelectorAll('button').forEach(b=>b.classList.remove('select')); button.classList.add('select');"}
fetch('/demo/leak',{method:'POST',body:'must not send'}).catch(()=>{}); }
function agreeChanged(){ ${mode === 'no-button' ? '' : "document.querySelector('#buttons').style.display='block';"}
${mode === 'changed-question' ? "document.querySelector('#ans7 h3').textContent='새로운 질문입니다.';" : ''}
fetch('/demo/leak?consent=Y').catch(()=>{}); }
async function sendEntry(){if(!confirm('제출하시겠습니까?')) return;
const body=new URLSearchParams({name:document.querySelector('#name').value, phone:document.querySelector('#phone').value});
document.querySelectorAll('section').forEach((s,i)=>body.set('choice'+i,s.querySelector('button.select')?.textContent||''));
await (await fetch('/demo/save',{method:'POST',body})).json(); alert('제출이 완료되었습니다.');
${mode === 'accepted-close' ? 'window.close();' : "document.body.innerHTML='<h1>응모가 완료되었습니다.</h1>';"}}
</script>`;

for (const mode of [
  'accepted',
  'accepted-close',
  'decline',
  'no-button',
  'changed-question',
  'no-selection',
] as const) {
  test(`numbered quiz ${mode}: consent-gated input, reviewed submission and bounded recovery`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'ssal-numbered-'));
    const app = await createApp({ dir, port: 0, headless: true });
    app.scheduler.stop();
    t.after(async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const config = {
      ...syntheticSettings,
      profile: { ...syntheticSettings.profile, phone: '01000000000' },
      policy: {
        ...syntheticSettings.policy,
        finalSubmit: 'review' as const,
        maxRecoveries: 0,
        consent: { ...syntheticSettings.policy.consent, mode: 'manual' as const },
      },
    };
    app.store.setSettings('autonomy', config);
    await app.browser.open();
    let posts = 0,
      leaks = 0;
    const start = app.origin + '/demo/numbered';
    await app.browser.context!.route(app.origin + '/demo/**', async (route) => {
      if (route.request().url().includes('/demo/leak')) {
        leaks++;
        return route.fulfill({ body: 'no' });
      }
      if (route.request().method() === 'POST') {
        posts++;
        assert.equal(route.request().url(), app.origin + '/demo/save');
        const data = new URLSearchParams(route.request().postData()!);
        assert.equal(data.get('name'), config.profile.name);
        for (let i = 0; i < 7; i++) assert.equal(data.get('choice' + i), '1');
        return route.fulfill({
          contentType: 'application/json',
          body: '{"code":"0000","message":"응모가 완료되었습니다.","receipt_no":"SYNTHETIC-1"}',
        });
      }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html(mode) });
    });
    await app.browser.navigate(start);
    const { view } = await inspectForm(app.browser.page!);
    assert.equal(view.questions.length, 10);
    assert.equal(view.buttons.length, 0, 'number buttons are not submit controls');
    assert.deepEqual(
      view.questions[0]!.options.map((o) => o.label),
      ['1. 2', '2. 25.61%', '3. 99개', '4. 100'],
    );
    const consent = view.questions.find((q) => q.label === '동의')!;
    assert.match(consent.description, /경품 지급 후 파기/);
    const autonomy = createAutonomy(config, app.origin);
    for (const q of view.questions.slice(0, 7))
      autonomy.overrides[q.signature] = [q.options[0]!.id];
    const job: Job = {
      id: randomUUID(),
      kind: 'apply',
      provider: { kind: 'api', model: 'fixture' },
      goal: 'Synthetic numbered quiz',
      startUrl: start,
      currentUrl: start,
      status: 'paused',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      candidateLimit: 1,
      maxSteps: 10,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      note: '',
      uncertain: false,
      allowedOrigins: [app.origin],
      approvedTexts: [],
      history: [],
      autonomy,
    };
    app.runner.model.decide = (async (_p: unknown, _i: unknown, ctx: any) => ({
      inputTokens: 1,
      outputTokens: 1,
      step: {
        action: 'form_plan',
        observationId: ctx.observation.id,
        reason: 'fixture',
        buttonId: ctx.inputOnly ? undefined : ctx.form.buttons[0]?.id,
        answers: ctx.form.questions.map((q: any) => ({
          questionId: q.id,
          category: q.label === '동의' ? 'consent' : q.options.length ? 'knowledge' : 'fact',
          source: 'unknown',
          reason: 'fixture',
        })),
      },
    })) as any;
    app.store.saveJob(job);
    app.runner.start(job.id);
    await app.runner.finished();
    let saved = app.store.job(job.id)!;
    assert.equal(saved.status, 'needs_user', saved.note);
    assert.equal(saved.autonomy?.inbox?.items.length, 1);
    assert.equal(saved.autonomy?.inbox?.items[0]?.category, 'consent');
    assert.equal(saved.autonomy?.metrics.fields, 0, 'no consent or quiz clicks before review');
    assert.equal(posts, 0);
    const post = async (body: unknown) => {
      const state = await fetch(app.origin + '/api/state').then((r) => r.json());
      const response = await fetch(app.origin + `/api/jobs/${job.id}/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, await response.text());
      await app.runner.finished();
      saved = app.store.job(job.id)!;
    };
    await post({
      inboxId: saved.autonomy!.inbox!.id,
      answers: { [consent.id]: [mode === 'decline' ? '비동의' : '동의'] },
    });
    assert.equal(posts, 0);
    assert.equal(leaks, 0, 'input-time POST and GET transmissions remain blocked');
    if (mode === 'decline') {
      assert.equal(saved.status, 'stopped', saved.note);
      assert.equal(saved.autonomy!.metrics.fields, 0);
      return;
    }
    if (['no-button', 'changed-question', 'no-selection'].includes(mode)) {
      assert.equal(saved.status, 'failed', saved.note);
      assert.equal(saved.stopReason?.category, 'technical');
      assert.equal(
        saved.stopReason?.code,
        mode === 'no-button'
          ? 'form_button_not_revealed'
          : mode === 'changed-question'
            ? 'form_structure_changed'
            : 'field_verification_failed',
      );
      if (mode === 'no-button') {
        const clicks = await app.browser.page!.evaluate(() => (window as any).choiceClicks);
        app.runner.start(job.id);
        await app.runner.finished();
        assert.equal(
          await app.browser.page!.evaluate(() => (window as any).choiceClicks),
          clicks,
          'resume does not repeat local input',
        );
      }
      return;
    }
    assert.equal(saved.autonomy?.inbox?.final, true, saved.note);
    assert.equal(saved.transmitted, undefined);
    assert.equal(saved.uncertain, false);
    assert.equal(saved.autonomy!.localInput?.count, 1);
    assert.ok(saved.autonomy!.localInput!.blockedRequests >= 8);
    assert.equal(
      await app.browser.page!.evaluate(() => (window as any).choiceClicks),
      7,
      'selection is verified without duplicate clicks',
    );
    assert.match(JSON.stringify(saved.autonomy!.inbox!.review), /1\. 2/);
    const values = await formValuesHash(app.browser.page!);
    await app.browser.page!.locator('#ans1 button').nth(1).click();
    assert.notEqual(
      await formValuesHash(app.browser.page!),
      values,
      'selection changes invalidate final approval',
    );
    await app.browser.page!.locator('#ans1 button').first().click();
    await post({ inboxId: saved.autonomy!.inbox!.id, confirm: true });
    assert.equal(saved.status, 'completed', saved.note);
    assert.equal(posts, 1);
    assert.equal(saved.receiptCapture?.requests, 1);
  });
}

test('ambiguous numbered options stop as a technical limitation before input', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-numbered-shape-'));
  const app = await createApp({ dir, port: 0, headless: true });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await app.browser.navigate(app.origin + '/demo/event');
  await app.browser.page!.setContent(quiz.replace('>25.61%', '>2'));
  await assert.rejects(inspectForm(app.browser.page!), (e: unknown) => {
    assert.equal(errorNotice(e, 'form_inspection').category, 'technical');
    assert.match(errorNotice(e, 'form_inspection').reason, /로그인·인증 요청이 아닌/);
    return true;
  });
});

for (const reason of ['unsupported_form', 'verification'] as const) {
  test(`form planner handoff ${reason} distinguishes missing support from human verification`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'ssal-form-handoff-'));
    const app = await createApp({ dir, port: 0, headless: true });
    app.scheduler.stop();
    t.after(async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const config = { ...syntheticSettings };
    app.store.setSettings('autonomy', config);
    const start = app.origin + '/demo/event';
    await app.browser.navigate(start);
    await app.browser.page!.setContent('<label>Example<input></label>');
    const job: Job = {
      id: randomUUID(),
      kind: 'apply',
      provider: { kind: 'api', model: 'fixture' },
      goal: 'Fixture',
      startUrl: start,
      currentUrl: start,
      status: 'paused',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      candidateLimit: 1,
      maxSteps: 5,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      note: '',
      uncertain: false,
      allowedOrigins: [app.origin],
      approvedTexts: [],
      history: [],
      autonomy: createAutonomy(config, app.origin),
    };
    app.browser.ownerJobId = job.id;
    app.runner.model.decide = (async (_p: unknown, _i: unknown, ctx: any) => ({
      inputTokens: 1,
      outputTokens: 1,
      step: {
        action: 'needs_user',
        observationId: ctx.observation.id,
        reason: 'fixture handoff',
        handoffReason: reason,
      },
    })) as any;
    app.store.saveJob(job);
    app.runner.start(job.id);
    await app.runner.finished();
    const saved = app.store.job(job.id)!;
    assert.equal(saved.status, reason === 'unsupported_form' ? 'failed' : 'needs_user');
    assert.equal(
      saved.stopReason?.category,
      reason === 'unsupported_form' ? 'technical' : undefined,
    );
    assert.equal(saved.autonomy!.metrics.fields, 0);
  });
}
