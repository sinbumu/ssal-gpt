import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server.js';
import { Runner } from '../../src/runner.js';
import {
  createAutonomy,
  syntheticSettings,
  ProfileSchema,
  settings,
  memories,
} from '../../src/autonomy.js';
import { inspectForm } from '../../src/forms.js';
import type { ModelClient } from '../../src/model.js';
import type { Job } from '../../src/store.js';

test('native shipping form links adjacent consent, separates field labels and phone parts, and waits for human code and final review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-native-shipping-'));
  const app = await createApp({ dir, port: 0, headless: true });
  let posts = 0;
  const html = `<h1>가상 배송 경품 퀴즈</h1><p>공개 퀴즈: 1 더하기 1</p>
    <dl><dt>개인정보 수집 및 이용 동의</dt><dd>가상 기관은 이름, 연락처, 이메일, 주소를 경품 발송 목적으로 수집하고 2년 보관합니다. 동의를 거부할 경우 이벤트 참여 서비스를 이용하실 수 없습니다.</dd></dl>
    <p><label for="agree">개인정보 수집 및 이용에 동의합니다</label><input type="checkbox" id="agree"></p>
    <form method="post" action="/demo/receipt"><fieldset><legend>퀴즈</legend>
      <label for="answer">정답</label><input id="answer" name="answer">
      <label for="name">이름</label><input id="name" name="name">
      <label for="email">이메일</label><input id="email" name="email">
      <label for="phone1">연락처</label><input id="phone1" title="연락처 첫번째 3자리 입력" maxlength="3">
      <input id="phone2" title="연락처 두번째 4자리 입력" maxlength="4"><input id="phone3" title="연락처 세번째 4자리 입력" maxlength="4">
      <label for="zip">우편번호</label><input id="zip" title="주소">
      <label for="addr">주소</label><input id="addr">
      <label for="detail">나머지주소</label><input id="detail">
      <label for="code">인증문자</label><input id="code" title="자동기입방지문자" required>
      <input type="image" alt="퀴즈응모하기" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='30'/%3E">
    </fieldset></form>`;
  async function post(path: string, body: unknown) {
    const s = await fetch(app.origin + '/api/state').then((r) => r.json());
    const r = await fetch(app.origin + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': s.csrf },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 200, await r.text());
  }
  try {
    app.store.setSettings('autonomy', {
      revision: 'native-shipping-fixture',
      profile: ProfileSchema.parse({
        name: '가상 참가자',
        email: 'fixture@example.invalid',
        phone: '010-1234-5678',
        shippingAddress: '가상도 예시로 99',
        shippingAddressDetail: '101호',
        postalCode: '12345',
      }),
      policy: {
        ...syntheticSettings.policy,
        finalSubmit: 'review',
        consent: { ...syntheticSettings.policy.consent, mode: 'adaptive', declineOptional: true },
      },
    });
    const config = settings(app.store);
    await app.browser.open();
    await app.browser.context!.route(app.origin + '/demo/**', async (r) => {
      if (r.request().method() === 'POST') posts++;
      await r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: r.request().method() === 'POST' ? '<h1>답변이 제출되었습니다.</h1>' : html,
      });
    });
    const j: Job = {
      id: randomUUID(),
      kind: 'apply',
      provider: { kind: 'api', model: 'synthetic' },
      goal: '가상 배송지 폼',
      startUrl: app.origin + '/demo/native',
      status: 'queued',
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
      autonomy: createAutonomy(config, app.origin),
    };
    j.autonomy!.organizer = '가상 기관';
    const model: ModelClient = {
      async decide(_p, _i, ctx: any, image) {
        assert.ok(image.length > 1000);
        assert.ok(!JSON.stringify(ctx).includes('가상도 예시로 99'));
        if (!ctx.form)
          return {
            inputTokens: 0,
            outputTokens: 0,
            step: {
              observationId: ctx.observation.id,
              reason: '가상 접수 확인',
              action: 'done',
              evidenceQuote: '답변이 제출되었습니다.',
            },
          };
        return {
          inputTokens: 0,
          outputTokens: 0,
          step: {
            observationId: ctx.observation.id,
            reason: '가상 폼 계획',
            action: 'form_plan',
            buttonId: ctx.form.buttons[0].id,
            answers: ctx.form.questions.map((q: any) => ({
              questionId: q.id,
              source: 'recommendation',
              category: /동의/.test(q.label) ? 'consent' : 'knowledge',
              answer: [q.label === '정답' ? '2' : 'not-authorized-code'],
              evidenceQuote: '공개 퀴즈: 1 더하기 1',
              reason: '가상 계획',
            })),
          },
        };
      },
    };
    const runner = new Runner(app.store, app.browser, model, app.origin);
    app.store.saveJob(j);
    runner.start(j.id);
    await runner.finished();
    let current = app.store.job(j.id)!;
    assert.equal(current.status, 'needs_user', current.note);
    const inbox = current.autonomy!.inbox!;
    assert.equal(inbox.items.length, 2, JSON.stringify(inbox));
    assert.ok(
      inbox.items.some((q) => /인증문자/.test(q.label) && q.category === 'fact' && !q.recommended),
    );
    assert.ok(inbox.items.some((q) => /동의/.test(q.label) && q.description?.includes('2년')));
    assert.equal(inbox.items.find((q) => /동의/.test(q.label))?.required, true);
    assert.equal(posts, 0);
    // The API uses app.runner; install the same synthetic decision provider.
    (app.runner as any).model = model;
    const answers = Object.fromEntries(
      inbox.items.map((q) => [q.id, /동의/.test(q.label) ? [q.options[0]!.id] : ['human-entered']]),
    );
    await post(`/api/jobs/${j.id}/inbox`, { inboxId: inbox.id, answers, remember: true });
    await app.runner.finished();
    current = app.store.job(j.id)!;
    assert.equal(current.autonomy!.inbox?.final, true, current.note);
    assert.equal(posts, 0);
    const p = app.browser.page!;
    assert.equal((await inspectForm(p)).view.buttons[0]!.action, app.origin + '/demo/receipt');
    for (const [id, value] of Object.entries({
      name: '가상 참가자',
      email: 'fixture@example.invalid',
      phone1: '010',
      phone2: '1234',
      phone3: '5678',
      zip: '12345',
      addr: '가상도 예시로 99',
      detail: '101호',
      code: 'human-entered',
    }))
      assert.equal(await p.locator('#' + id).inputValue(), value, id);
    assert.ok(!memories(app.store).some((a) => /인증문자/.test(a.question)));
    await p.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'unrelated';
      document.body.prepend(input);
    });
    await assert.rejects(() => inspectForm(p), /multiple_forms_require_manual_selection/);
    await p.locator('#unrelated').evaluate((e) => e.remove());
    assert.equal(posts, 0);
    await post(`/api/jobs/${j.id}/inbox`, { inboxId: current.autonomy!.inbox!.id, confirm: true });
    await app.runner.finished();
    assert.equal(app.store.job(j.id)!.status, 'completed', app.store.job(j.id)!.note);
    assert.equal(posts, 1, 'image submit sends exactly one synthetic POST after approval');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
