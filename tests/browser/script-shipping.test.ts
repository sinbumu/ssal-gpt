import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings, ProfileSchema } from '../../src/autonomy.js';
import { inspectForm } from '../../src/forms.js';
import type { Job } from '../../src/store.js';

for (const scenario of [
  'accepted',
  'accepted-sync',
  'accepted-response',
  'accepted-durable',
  'unrelated-post',
  'decline',
  'unmarked-decline',
] as const) {
  test(`script shipping ${scenario}: separate quiz answers, scoped address, full consent, human code and one approved POST`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssal-script-shipping-'));
    const app = await createApp({ dir, port: 0, headless: true });
    let posts = 0;
    const config = {
      ...syntheticSettings,
      profile: ProfileSchema.parse({
        name: '가상 참가자',
        phone: '01000000000',
        shippingAddress: '가상도 예시로 99',
        shippingAddressDetail: '101호',
      }),
      policy: {
        ...syntheticSettings.policy,
        finalSubmit: 'review' as const,
        consent: { ...syntheticSettings.policy.consent, mode: 'adaptive' as const },
      },
    };
    app.store.setSettings('autonomy', config);
    const j: Job = {
      id: randomUUID(),
      kind: 'apply',
      provider: { kind: 'api', model: 'synthetic' },
      goal: 'synthetic script shipping',
      startUrl: app.origin + '/demo/script-shipping',
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      maxSteps: 12,
      candidateLimit: 1,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      uncertain: false,
      note: '',
      allowedOrigins: [app.origin],
      approvedTexts: [],
      history: [],
      autonomy: createAutonomy(config, app.origin),
    };
    async function post(body: unknown) {
      const s = await fetch(app.origin + '/api/state').then((r) => r.json());
      const r = await fetch(app.origin + `/api/jobs/${j.id}/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': s.csrf },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 200, await r.text());
      await app.runner.finished();
    }
    const html = `<h1>가상 배송 퀴즈</h1><section>
      <div><p>문제 01: 1 더하기 1</p><input name="answer1" placeholder="정답을 입력해 주세요."></div>
      <div><p>문제 02: 1 더하기 2</p><input name="answer2" placeholder="정답을 입력해 주세요."></div>
      <div><input name="name" placeholder="이름"><input name="phone" placeholder="연락처"><input name="address" placeholder="주소"></div>
      <div><p>개인정보 수집 및 이용 동의 안내<br>수집 항목: 이름, 주소, 연락처<br>제공받는 자: 가상 대행사<br>수집 및 이용 목적: 잡지 제작과 제언 활용<br>보유 및 이용 기간: 상품 발송 후 즉시 파기${scenario === 'unmarked-decline' ? '' : '<br>동의하지 않을 경우 선물 추첨에서 제외됩니다.'}</p></div>
      <div><div><input type="checkbox" id="agree"><label for="agree">상품 발송을 위한 개인정보 제공에 동의합니다.</label></div></div>
      <div><b>자동등록방지</b><input name="captcha"></div>
      <button type="button" onclick="sendEntry()">제출하기</button></section>
      <script>async function sendEntry() {
        const body = new URLSearchParams();
        for (const input of document.querySelectorAll('input:not([type=checkbox])')) body.set(input.name, input.value);
        ${scenario === 'accepted-sync' ? "const xhr = new XMLHttpRequest(); xhr.open('POST', '/demo/save', false); xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded'); xhr.send(body.toString());" : `await (await fetch('/demo/save', {method:'POST', body: ${scenario === 'unrelated-post' ? "new URLSearchParams({tracking: 'unrelated'})" : 'body'}})).json();`}
        ${['accepted-response', 'accepted-durable'].includes(scenario) ? '' : `alert('${scenario === 'accepted-sync' ? '이벤트에 참여 되었습니다.' : '응모가 완료되었습니다.'}');`} location.reload();
      }</script>`;
    if (['accepted-response', 'accepted-durable'].includes(scenario)) {
      const handlers = app.server.listeners('request');
      app.server.removeAllListeners('request');
      app.server.on('request', async (req, res) => {
        if (!req.url?.startsWith('/demo/')) {
          for (const handler of handlers) handler.call(app.server, req, res);
          return;
        }
        if (req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk;
          const data = new URLSearchParams(body);
          assert.equal(data.get('address'), '가상도 예시로 99, 101호');
          posts++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ code: '0000', msg: '이벤트에 참여 되었습니다.', receipt_no: 'R-42' }),
          );
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      });
    }
    try {
      await app.browser.open();
      if (scenario === 'accepted-durable')
        app.browser.page!.on('response', (r) => {
          if (r.request().method() === 'POST')
            r.body = async () => {
              throw new Error('synthetic evicted response');
            };
        });
      if (!['accepted-response', 'accepted-durable'].includes(scenario))
        await app.browser.context!.route(app.origin + '/demo/**', async (r) => {
          if (r.request().method() === 'POST') {
            posts++;
            if (scenario.startsWith('accepted')) {
              const data = new URLSearchParams(r.request().postData()!);
              assert.equal(data.get('answer1'), '2');
              assert.equal(data.get('answer2'), '3');
              assert.equal(data.get('address'), '가상도 예시로 99, 101호');
              assert.equal(data.get('captcha'), 'human-entered');
            }
            await r.fulfill({
              contentType: 'application/json',
              body: ['accepted-response', 'accepted-durable'].includes(scenario)
                ? JSON.stringify({
                    code: '0000',
                    msg: '이벤트에 참여 되었습니다.',
                    receipt_no: 'R-42',
                  })
                : '{}',
            });
          } else await r.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
        });
      app.runner.model.decide = (async (_p: unknown, _i: unknown, ctx: any, image: Buffer) => {
        assert.ok(image.length > 1000);
        assert.ok(!JSON.stringify(ctx).includes('가상도 예시로 99'));
        return {
          inputTokens: 0,
          outputTokens: 0,
          step: ctx.uncertain
            ? {
                observationId: ctx.observation.id,
                action: 'needs_user',
                reason: '증거 미확인',
                receiptKind: 'not_confirmed',
              }
            : {
                observationId: ctx.observation.id,
                action: 'form_plan',
                reason: '가상 폼',
                buttonId: ctx.form.buttons[0].id,
                answers: ctx.form.questions.map((q: any) => ({
                  questionId: q.id,
                  category: /정답/.test(q.label)
                    ? 'knowledge'
                    : /동의/.test(q.label)
                      ? 'consent'
                      : 'fact',
                  source: /정답/.test(q.label) ? 'recommendation' : 'unknown',
                  answer: /정답/.test(q.label)
                    ? [q.description.includes('문제 01') ? '2' : '3']
                    : [],
                  evidenceQuote: q.description,
                  reason: '가상 계획',
                })),
              },
        };
      }) as typeof app.runner.model.decide;
      app.store.saveJob(j);
      app.runner.start(j.id);
      await app.runner.finished();
      let current = app.store.job(j.id)!;
      assert.equal(current.status, 'needs_user', current.note);
      let inbox = current.autonomy!.inbox!;
      assert.deepEqual(
        inbox.items.map((q) => q.category),
        ['consent', 'fact'],
      );
      assert.ok(inbox.items[0]!.description?.includes('가상 대행사'));
      assert.equal(inbox.items[0]!.required, scenario !== 'unmarked-decline');
      assert.equal(posts, 0);
      const view = (await inspectForm(app.browser.page!)).view;
      assert.notEqual(view.questions[0]!.signature, view.questions[1]!.signature);
      if (scenario === 'accepted') {
        await app.browser.page!.locator('[name=answer1]').evaluate((el) => {
          const duplicate = el.parentElement!.cloneNode(true) as HTMLElement;
          duplicate.id = 'ambiguous-copy';
          el.parentElement!.after(duplicate);
        });
        await assert.rejects(() => inspectForm(app.browser.page!), /ambiguous_form_questions/);
        await app.browser.page!.locator('#ambiguous-copy').evaluate((el) => el.remove());
      }
      await post({
        inboxId: inbox.id,
        explicitDeclines: scenario.includes('decline')
          ? inbox.items.filter((q) => q.category === 'consent').map((q) => q.id)
          : [],
        answers: Object.fromEntries(
          inbox.items.map((q) => [
            q.id,
            q.category === 'consent'
              ? scenario.includes('decline')
                ? []
                : [q.options[0]!.id]
              : ['human-entered'],
          ]),
        ),
      });
      current = app.store.job(j.id)!;
      if (scenario.includes('decline')) {
        assert.equal(current.status, 'stopped', current.note);
        assert.equal(await app.browser.page!.locator('[name=address]').inputValue(), '');
        assert.equal(posts, 0);
        return;
      }
      inbox = current.autonomy!.inbox!;
      assert.equal(inbox.final, true, current.note);
      assert.equal(posts, 0);
      assert.equal(await app.browser.page!.locator('[name=answer1]').inputValue(), '2');
      assert.equal(await app.browser.page!.locator('[name=answer2]').inputValue(), '3');
      await post({ inboxId: inbox.id, confirm: true });
      current = app.store.job(j.id)!;
      assert.equal(
        current.status,
        scenario.startsWith('accepted') ? 'completed' : 'submission_unknown',
        current.note,
      );
      assert.equal(posts, 1);
      if (['accepted-response', 'accepted-durable'].includes(scenario)) {
        assert.equal(current.receiptCheck?.method, 'rules');
        assert.equal(current.receiptCheck?.signals[0].receiptNumbers?.[0], 'R-42');
        assert.equal(current.receiptDialogs?.length || 0, 0);
      }
      assert.ok(!JSON.stringify(current.receiptDialogs || []).includes('가상도'));
      if (scenario === 'unrelated-post') {
        app.runner.start(j.id);
        await app.runner.finished();
        assert.equal(posts, 1);
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
