import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings, hash } from '../../src/autonomy.js';
import { inspectForm } from '../../src/forms.js';
import { captureReceipt } from '../../src/receipt.js';
import type { Job } from '../../src/store.js';
const url = 'https://form.naver.com/response/fixtureNaver';
const target = 'https://survey-api.naver.com/api/form/surveys/fixtureNaver/answers';
const first = `<h2>설문 진행 상태</h2><label>이름<input name="name" required></label><button id="nsv_page_control_next" type="button">다음</button>`;
const second = `<h2>설문 진행 상태</h2><span>2/2</span><label>휴대폰 번호<input name="phone" required></label><fieldset><legend>개인정보 수집 및 이용 동의</legend><p>전화번호를 경품 발송에 이용하고 당첨자 발표 후 1주일 보관합니다. 제공받는 자: 가상 주최자</p><label><input type="radio" name="consent" value="yes" required>동의합니다</label><label><input type="radio" name="consent" value="no">동의하지 않습니다</label></fieldset><button id="nsv_page_control_prev" type="button">이전</button><button id="nsv_page_control_submit" type="button">제출</button>`;
for (const scenario of ['fresh', 'legacy-live', 'restart'] as const)
  test(`Naver ${scenario}: hidden progress Next, one phone on final page, dashboard consent and only one submitted POST`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssal-naver-next-'));
    const app = await createApp({ dir, port: 0, headless: true });
    app.scheduler.stop();
    let posts = 0;
    const config = {
      ...syntheticSettings,
      policy: {
        ...syntheticSettings.policy,
        finalSubmit: 'review' as const,
        consent: { ...syntheticSettings.policy.consent, mode: 'manual' as const },
      },
    };
    app.store.setSettings('autonomy', config);
    const j: Job = {
      id: randomUUID(),
      kind: 'apply',
      provider: { kind: 'api', model: 'fixture' },
      goal: 'fixture',
      startUrl: url,
      currentUrl: url,
      status: 'paused',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      maxSteps: 10,
      candidateLimit: 1,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      uncertain: false,
      note: '',
      allowedOrigins: [new URL(url).origin],
      approvedTexts: [],
      history: [],
      autonomy: createAutonomy(config, new URL(url).origin),
    };
    async function route() {
      await app.browser.context!.route('**/*', async (r) => {
        if (r.request().method() === 'POST') {
          assert.equal(r.request().url(), target);
          posts++;
          const body = JSON.parse(r.request().postData()!);
          assert.equal(body.items.find((i: any) => i.questionId === 2).value, config.profile.phone);
          await r.fulfill({
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: '{"success":true}',
          });
        } else if (r.request().method() === 'OPTIONS')
          await r.fulfill({
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': 'Content-Type',
              'Access-Control-Allow-Methods': 'POST',
            },
          });
        else
          await r.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<title>고정 가상 폼</title><main>${first}</main><script>let name='';const main=document.querySelector('main');document.addEventListener('click',async e=>{if(e.target.id==='nsv_page_control_next'){name=document.querySelector('[name=name]').value;main.innerHTML=${JSON.stringify(second)}}if(e.target.id==='nsv_page_control_submit'){await fetch(${JSON.stringify(target)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:[{questionId:1,value:name},{questionId:2,value:document.querySelector('[name=phone]').value},{questionId:3,value:'yes'}],taToken:'private-token'})});main.innerHTML='<p>답변이 제출되었습니다.</p>'}})</script>`,
          });
      });
    }
    async function inbox(data: unknown) {
      const s = await fetch(app.origin + '/api/state').then((r) => r.json());
      const r = await fetch(app.origin + `/api/jobs/${j.id}/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': s.csrf },
        body: JSON.stringify(data),
      });
      assert.equal(r.status, 200, await r.text());
      await app.runner.finished();
    }
    try {
      await app.browser.open();
      await route();
      await app.browser.navigate(url);
      app.browser.ownerJobId = j.id;
      const firstView = (await inspectForm(app.browser.page!)).view;
      assert.equal(firstView.buttons[0]!.providerControl, 'naver-next');
      const before = await app.browser.observe(true);
      assert.ok(!before.text.includes('1/2'));
      if (scenario !== 'fresh') {
        await app.browser.page!.locator('[name=name]').fill(config.profile.name);
        await app.browser.page!.locator('#nsv_page_control_next').click();
        j.uncertain = true;
        j.transmitted = true;
        j.intent = {
          at: Date.now(),
          url,
          kind: 'submission',
          controlLabel: '다음',
          beforeText: before.text,
        };
        j.history = [{ action: 'form_batch', reason: 'legacy Next mislabeled final', url }];
        j.receiptCapture = {
          intentHash: hash(j.intent),
          settled: true,
          requests: 0,
          diagnostics: {
            observedPosts: 0,
            matchedRequests: 0,
            responses: 0,
            rejected: {},
            popups: 0,
            navigations: 0,
            pageClosed: false,
          },
        };
        captureReceipt(j, await app.browser.observe(true));
        if (scenario === 'restart') {
          await app.browser.close();
          await app.browser.open();
          await route();
        }
      }
      app.runner.model.decide = (async (_p: unknown, _i: string, ctx: any) => {
        assert.notEqual(
          ctx.purpose,
          'verify_receipt',
          'a Next transition must not spend a receipt-model call',
        );
        return {
          inputTokens: 0,
          outputTokens: 0,
          step: {
            observationId: ctx.observation.id,
            action: 'form_plan',
            reason: 'fixture',
            buttonId: ctx.form.buttons[0].id,
            answers: ctx.form.questions.map((q: any) => ({
              questionId: q.id,
              category: q.label.includes('동의') ? 'consent' : 'fact',
              source: q.label.includes('동의') ? 'unknown' : 'profile',
              sourceId: q.label.includes('이름') ? 'name' : 'phone',
              answer: [],
              reason: 'fixture',
            })),
          },
        };
      }) as any;
      app.store.saveJob(j);
      app.runner.start(j.id);
      await app.runner.finished();
      let current = app.store.job(j.id)!;
      assert.equal(current.status, 'needs_user', current.note);
      assert.equal(current.uncertain, false);
      assert.equal(
        current.autonomy!.inbox!.final,
        undefined,
        'Next must not require a final approval',
      );
      assert.equal(current.autonomy!.inbox!.items.length, 1);
      assert.equal(posts, 0);
      assert.equal(current.continuations?.length, scenario === 'restart' ? 2 : 1);
      const pending = current.autonomy!.inbox!;
      await inbox({
        inboxId: pending.id,
        answers: { [pending.items[0]!.id]: ['동의합니다'] },
        remember: false,
      });
      current = app.store.job(j.id)!;
      assert.equal(current.autonomy!.inbox!.final, true, current.note);
      assert.equal(current.autonomy!.inbox!.buttonLabel, '제출');
      assert.equal(posts, 0);
      await inbox({ inboxId: current.autonomy!.inbox!.id, confirm: true });
      current = app.store.job(j.id)!;
      assert.equal(current.status, 'completed', current.note);
      assert.equal(posts, 1);
      assert.equal(current.receiptCheck!.method, 'rules');
      assert.equal(current.receiptCheck!.capture!.matchedRequests, 1);
      assert.equal(
        current.receiptCheck!.signals.find((s) => s.kind === 'response')?.outcome,
        'accepted',
      );
      assert.equal(current.receiptCheck!.signals.find((s) => s.kind === 'response')?.status, 200);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

test('Naver control identity is restricted to its exact response page, unique DOM ID, type and label', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-naver-controls-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  try {
    await app.browser.open();
    let html =
      '<label>이름<input required></label><button id="nsv_page_control_next" type="button">다음</button>';
    await app.browser.context!.route('**/*', (r) =>
      r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }),
    );
    for (const location of [
      'https://example.org/response/fixtureNaver',
      'https://form.naver.com/edit/fixtureNaver',
      url,
    ]) {
      await app.browser.navigate(location);
      assert.equal(
        (await inspectForm(app.browser.page!)).view.buttons[0]!.providerControl,
        location === url ? 'naver-next' : undefined,
      );
    }
    for (const change of [
      html.replace('>다음<', '>제출<'),
      html.replace('type="button"', 'type="submit"'),
      html + '<button id="nsv_page_control_next" type="button">다음</button>',
    ]) {
      html = change;
      await app.browser.page!.reload();
      assert.ok(
        (await inspectForm(app.browser.page!)).view.buttons.every((b) => !b.providerControl),
      );
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
