import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings, type Question } from '../../src/autonomy.js';
import type { Job } from '../../src/store.js';

test('open-ended drafts are prepared in one batch, editable and persistent; Other is skipped and only reviewed answers are posted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-drafts-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  const ui = await chromium.launch();
  let posts = 0;
  const config = {
    ...syntheticSettings,
    policy: {
      ...syntheticSettings.policy,
      preferenceRule: '',
      evaluationRule: '',
      finalSubmit: 'review' as const,
      consent: { ...syntheticSettings.policy.consent, mode: 'manual' as const },
    },
  };
  app.store.setSettings('autonomy', config);
  const id = randomUUID(),
    url = app.origin + '/demo/draft-form';
  const job = {
    id,
    kind: 'apply',
    status: 'queued',
    provider: { kind: 'api', model: 'synthetic' },
    goal: 'draft test',
    startUrl: url,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    maxSteps: 10,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    candidateLimit: 1,
    note: '',
    uncertain: false,
    history: [],
    allowedOrigins: [app.origin],
    approvedTexts: [],
    autonomy: createAutonomy(config, app.origin),
  } as Job;
  let draftCalls = 0;
  app.runner.model.decide = (async (_p, _i, ctx: any, image: Buffer) => {
    assert.ok(image.length > 1000);
    if (ctx.purpose === 'review_only_drafts') {
      draftCalls++;
      assert.equal(ctx.questions.length, 2);
      assert.doesNotMatch(JSON.stringify(ctx), /demo@example|010-0000/);
      return {
        inputTokens: 10,
        outputTokens: 5,
        step: {
          action: 'form_plan',
          observationId: ctx.observationId,
          reason: '검토용 초안',
          answers: ctx.questions.map((q: any) => ({
            questionId: q.id,
            source: 'recommendation',
            category: 'preference',
            answer: [
              q.label.includes('개선')
                ? '메뉴를 한눈에 찾을 수 있으면 좋겠습니다.'
                : '창립을 축하하며 앞으로도 응원합니다!',
            ],
            reason: '제안',
          })),
        },
      };
    }
    return {
      inputTokens: 10,
      outputTokens: 5,
      step: {
        action: 'form_plan',
        observationId: ctx.observation.id,
        reason: '묶음 계획',
        buttonId: ctx.form.buttons[0].id,
        answers: ctx.form.questions.map((q: Question) => ({
          questionId: q.id,
          source: 'unknown',
          category: q.label.includes('동의')
            ? 'consent'
            : q.label.includes('개선')
              ? 'evaluation'
              : q.label.includes('축하')
                ? 'preference'
                : 'fact',
          answer: [],
          reason: '확인',
        })),
      },
    };
  }) as typeof app.runner.model.decide;
  try {
    await app.browser.open();
    await app.browser.context!.route(url + '**', async (r) => {
      if (r.request().method() === 'POST') {
        posts++;
        const body = new URLSearchParams(r.request().postData()!);
        assert.equal(body.get('other'), '');
        assert.equal(body.get('improve'), '사용자가 직접 다듬은 제안');
        await r.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '응모가 완료되었습니다.',
        });
      } else
        await r.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<form method="post">
        <dl><dt>방문 목적</dt><dd><ul><li><label><input type="radio" name="purpose" value="event">이벤트 참여</label></li><li><label><input type="radio" name="purpose" value="other">기타</label><input name="other" title="기타 작성"></li></ul></dd></dl>
        <label>개선의견<textarea name="improve"></textarea></label><label>창립 축하 문구<textarea name="cheer"></textarea></label>
        <label>연락처<input name="phone" required></label><label><input type="checkbox" name="consent" required>개인정보 동의</label><button type="submit">제출</button></form>`,
        });
    });
    app.store.saveJob(job);
    app.runner.start(id);
    await app.runner.finished();
    let saved = app.store.job(id)!,
      box = saved.autonomy!.inbox!;
    assert.equal(saved.status, 'needs_user', saved.note);
    assert.equal(draftCalls, 1);
    assert.equal(saved.steps, 2);
    assert.equal(saved.autonomy!.metrics.fields, 0);
    assert.equal(posts, 0);
    assert.equal(box.items.filter((q) => q.reviewDraft).length, 2);
    const other = box.items.find((q) => q.label.endsWith('기타 작성'))!;
    assert.ok(other.condition);
    const api = async (action: string, body: unknown) => {
      const s = await fetch(app.origin + '/api/state').then((r) => r.json());
      return fetch(`${app.origin}/api/jobs/${id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': s.csrf },
        body: JSON.stringify(body),
      });
    };
    await app.browser.page!.close();
    assert.equal((await api('restore-form', {})).status, 400);
    assert.equal((await api('restore-form', { confirmedNotSubmitted: true })).status, 200);
    assert.equal(app.store.job(id)!.autonomy!.inbox!.id, box.id);
    assert.equal(posts, 0);
    const page = await ui.newPage();
    await page.goto(app.origin);
    const form = page.locator(`[data-inbox="${id}"]`);
    await form.waitFor();
    const improvement = box.items.find((q) => q.label === '개선의견')!;
    const field = form.locator(`[name="${improvement.id}"]`);
    assert.equal(await field.inputValue(), '메뉴를 한눈에 찾을 수 있으면 좋겠습니다.');
    assert.equal(await form.locator(`[name="${other.id}"]`).isDisabled(), true);
    await form.getByLabel('기타', { exact: true }).check();
    assert.equal(await form.locator(`[name="${other.id}"]`).isVisible(), true);
    await form.locator(`[name="${other.id}"]`).fill('선택 변경 전에 적은 기타');
    await form.getByLabel('이벤트 참여', { exact: true }).check();
    await field.fill('사용자가 직접 다듬은 제안');
    await page.locator('h1').click();
    saved = app.store.job(id)!;
    saved.note = '합성 폴링 갱신';
    app.store.saveJob(saved);
    await page.waitForTimeout(2200);
    assert.equal(await field.inputValue(), '사용자가 직접 다듬은 제안');
    await page.reload();
    await form.waitFor();
    assert.equal(await field.inputValue(), '사용자가 직접 다듬은 제안');
    await form.getByRole('button', { name: '추천 답변 모두 선택' }).click();
    assert.equal(await field.inputValue(), '사용자가 직접 다듬은 제안');
    await form.getByLabel('개인정보 동의', { exact: true }).check();
    await form.getByRole('button', { name: '한 번에 답변하고 재개' }).click();
    await page.getByRole('button', { name: '최종 제출하고 결과 확인', exact: true }).waitFor();
    assert.equal(posts, 0);
    assert.equal(
      (await api('restore-form', { confirmedNotSubmitted: true })).status,
      400,
      'an entered form is never reopened by preparation recovery',
    );
    assert.equal(await app.browser.page!.locator('[name=other]').inputValue(), '');
    assert.equal(
      await app.browser.page!.locator('[name=improve]').inputValue(),
      '사용자가 직접 다듬은 제안',
    );
    await page.getByRole('button', { name: '최종 제출하고 결과 확인', exact: true }).click();
    await page.waitForFunction((id) => !document.querySelector(`[data-inbox="${id}"]`), id);
    await app.runner.finished();
    assert.equal(app.store.job(id)!.status, 'completed', app.store.job(id)!.note);
    assert.equal(posts, 1);
    assert.equal(draftCalls, 1);
    assert.equal(
      await page.evaluate(
        () => Object.keys(sessionStorage).filter((k) => k.startsWith('ssal-inbox:')).length,
      ),
      0,
    );
  } finally {
    await ui.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
