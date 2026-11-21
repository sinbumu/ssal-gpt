import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings } from '../../src/autonomy.js';
import { inspectForm } from '../../src/forms.js';
import { errorNotice } from '../../src/job-notice.js';
import { ServiceError } from '../../src/auth.js';
import type { Job } from '../../src/store.js';

test('expired dashboard resume exposes renewal and preserves the live form, answers and budgets through final review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-renewal-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  const ui = await chromium.launch({ headless: true });
  try {
    const config = {
      ...syntheticSettings,
      policy: { ...syntheticSettings.policy, finalSubmit: 'review' as const },
    };
    app.store.setSettings('autonomy', config);
    const url = app.origin + '/demo/renewal';
    await app.browser.open();
    let gets = 0,
      posts = 0;
    await app.browser.page!.route(url, (route) => {
      if (route.request().method() === 'POST') posts++;
      else gets++;
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<form method="post"><label>선호하는 과일<input name="fruit" required></label><button type="submit">제출</button></form>',
      });
    });
    await app.browser.navigate(url);
    const { view } = await inspectForm(app.browser.page!);
    const a = createAutonomy(config, app.origin);
    a.overrides[view.questions[0]!.signature] = ['사과'];
    a.expires = Date.now() - 1000;
    a.metrics.modelCalls = 4;
    a.metrics.fields = 5;
    a.metrics.recoveries = 3;
    a.inbox = {
      id: 'old-review',
      fingerprint: 'old',
      items: [],
      final: true,
      createdAt: Date.now(),
    };
    a.finalApproval = 'old';
    const job: Job = {
      id: randomUUID(),
      kind: 'apply',
      goal: '합성 위임 복구',
      provider: { kind: 'api', model: 'fixture' },
      startUrl: url,
      currentUrl: url,
      status: 'needs_user',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      candidateLimit: 1,
      maxSteps: 40,
      steps: 4,
      inputTokens: 100,
      outputTokens: 20,
      note: 'delegation_expired_or_changed',
      uncertain: false,
      allowedOrigins: [app.origin],
      approvedTexts: [],
      history: [],
      autonomy: a,
      stopReason: errorNotice(new ServiceError('delegation_expired_or_changed'), 'form_navigation'),
    };
    app.store.saveJob(job);
    app.browser.ownerJobId = job.id;
    await app.browser.page!.getByLabel('선호하는 과일').fill('사과');
    app.runner.model.decide = async (_p, _i, raw: any) => ({
      step: {
        action: 'form_plan',
        observationId: raw.observation.id,
        reason: '합성 복구 검증',
        buttonId: raw.form.buttons[0].id,
        answers: raw.form.questions.map((q: any) => ({
          questionId: q.id,
          source: 'unknown',
          category: 'preference',
          reason: '기존 답변 사용',
        })),
      },
      inputTokens: 11,
      outputTokens: 3,
    });
    const state = await (await fetch(app.origin + '/api/state')).json();
    const post = (action: string, data: unknown) =>
      fetch(`${app.origin}/api/jobs/${job.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
        body: JSON.stringify(data),
      });
    assert.equal((await post('resume', { useCurrentPage: true })).status, 409);
    assert.equal(
      app.store.job(job.id)!.autonomy!.inbox!.id,
      'old-review',
      'failed resume must not discard answers/review',
    );
    assert.equal(
      (await post('renew-delegation', { useCurrentPage: true, revision: 'stale' })).status,
      400,
    );
    assert.equal(app.store.job(job.id)!.autonomy!.expires, a.expires);
    const page = await ui.newPage();
    await page.goto(app.origin);
    const card = page.locator(`#active-jobs #job-${job.id}`);
    await card.getByText('작업 위임 24시간 만료', { exact: true }).waitFor();
    assert.equal(await card.locator('[data-action=resume-current]').count(), 0);
    assert.equal(await card.locator('[data-inbox]').count(), 0);
    page.on('dialog', (dialog) => void dialog.accept());
    await card
      .getByRole('button', { name: '위임 갱신하고 현재 화면에서 재개', exact: true })
      .click();
    await card.getByRole('button', { name: '최종 제출하고 결과 확인', exact: true }).waitFor();
    const after = app.store.job(job.id)!;
    assert.equal(after.status, 'needs_user');
    assert.equal(after.autonomy!.inbox!.final, true);
    assert.deepEqual(after.autonomy!.overrides, a.overrides);
    assert.equal(after.autonomy!.metrics.recoveries, 3);
    assert.equal(after.autonomy!.metrics.modelCalls, 5);
    assert.equal(after.steps, 5);
    assert.equal(after.maxSteps, 40);
    assert.equal(after.inputTokens, 111);
    assert.equal(gets, 1, 'current-page renewal must not GET reload the in-progress form');
    assert.equal(posts, 0, 'renewal is not final submission permission');
    assert.equal(after.autonomy!.finalApproval, undefined);
  } finally {
    await ui.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
