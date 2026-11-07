import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../../src/server.js';
import { Runner } from '../../src/runner.js';
import type { Model, Step } from '../../src/model.js';
import type { Job } from '../../src/store.js';
import {
  createAutonomy,
  syntheticSettings,
  type AnswerPlan,
  type Question,
} from '../../src/autonomy.js';
import { inspectForm, applyAnswers } from '../../src/forms.js';
import { demoState } from '../../src/autonomy-demo.js';

function syntheticModel(): Model {
  return {
    async decide(_choice: unknown, _instructions: string, context: any, image: Buffer) {
      assert.ok(image.length > 1000);
      assert.ok(
        !JSON.stringify(context).includes('demo@example.invalid'),
        'profile must not enter model context',
      );
      const step = (s: Partial<Step>) => ({
        step: { observationId: context.observation.id, reason: '합성 테스트 드라이버', ...s },
        inputTokens: 0,
        outputTokens: 0,
      });
      if (context.observation.text.includes('설문이 완료되었습니다.'))
        return step({ action: 'done', evidenceQuote: '설문이 완료되었습니다.' });
      const answers = context.form.questions.map((q: Question): AnswerPlan => ({
        questionId: q.id,
        source: /경험|회원/.test(q.label) ? 'unknown' : 'recommendation',
        category: /경험|회원/.test(q.label)
          ? 'fact'
          : /경품|얻는 곳/.test(q.label)
            ? 'preference'
            : 'evaluation',
        answer:
          q.kind === 'text'
            ? []
            : q.label.includes('경품')
              ? ['커피', '차']
              : q.label.includes('얻는 곳')
                ? ['포털 검색', 'SNS']
                : q.options.some((o) => o.id === '그렇다')
                  ? ['그렇다']
                  : [],
        reason: 'fixture response',
      }));
      return step({ action: 'form_plan', answers, buttonId: context.form.buttons[0]?.id });
    },
  } as unknown as Model;
}
function makeJob(origin: string): Job {
  const id = randomUUID();
  return {
    id,
    kind: 'autonomy_demo',
    provider: { kind: 'api', model: 'synthetic-test-driver' },
    goal: 'test',
    startUrl: `${origin}/demo/autonomy?run=${id}`,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    candidateLimit: 1,
    maxSteps: 20,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    note: '',
    uncertain: false,
    allowedOrigins: [origin],
    approvedTexts: [],
    history: [],
    autonomy: createAutonomy(syntheticSettings, origin, true),
  };
}
test('batch plans traverse changed layouts, conditional fields and receipts without runtime edits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-autonomy-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    for (const layout of ['normal', 'shift']) {
      const job = makeJob(app.origin);
      app.store.saveJob(job);
      app.store.setSettings(`synthetic:${job.id}`, { page: 1, layout, inbox: false, posts: 0 });
      const runner = new Runner(app.store, app.browser, syntheticModel(), app.origin);
      runner.start(job.id);
      await runner.finished();
      const result = app.store.job(job.id)!;
      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.equal(result.autonomy!.metrics.inboxBatches, 0);
      assert.equal(result.autonomy!.metrics.recoveries, 1);
      assert.ok(result.autonomy!.metrics.reused >= 2);
      assert.equal(result.steps, 7);
      assert.equal(demoState(app.store, job.id).posts, 5);
      assert.ok(app.store.receipt(job.id));
      assert.throws(() => runner.start(job.id), /job_not_resumable/);
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('dashboard groups unknown facts, accepts one answer batch, preserves focus, then resumes without model re-prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-inbox-'));
  const app = await createApp({ dir, port: 0, headless: true });
  const ui = await chromium.launch({ headless: true });
  try {
    // Substitute only provider inference, never job state or recovery while running.
    app.runner.model.decide = syntheticModel().decide;
    const job = makeJob(app.origin);
    app.store.saveJob(job);
    app.store.setSettings(`synthetic:${job.id}`, {
      page: 1,
      layout: 'shift',
      inbox: true,
      posts: 0,
    });
    app.runner.start(job.id);
    await app.runner.finished();
    const paused = app.store.job(job.id)!;
    assert.equal(paused.status, 'needs_user');
    assert.equal(paused.autonomy!.inbox!.items.length, 2);
    const page = await ui.newPage();
    await page.goto(app.origin);
    const form = page.locator(`[data-inbox="${job.id}"]`);
    await form.waitFor();
    await form.getByLabel('아니요', { exact: true }).nth(0).check();
    await page.waitForTimeout(2200);
    assert.equal(await form.getByLabel('아니요', { exact: true }).nth(0).isChecked(), true);
    await form.getByLabel('아니요', { exact: true }).nth(1).check();
    await form.getByRole('button', { name: '한 번에 답변하고 재개' }).click();
    await page
      .locator('#jobs .pill')
      .filter({ hasText: /^완료$/ })
      .waitFor({ timeout: 30000 });
    const done = app.store.job(job.id)!;
    assert.equal(done.status, 'completed');
    assert.equal(done.autonomy!.metrics.inboxBatches, 1);
    assert.equal(done.steps, 7);
    assert.equal(demoState(app.store, job.id).posts, 5);
    assert.equal(
      app.store.settings('answers', []).length,
      0,
      'synthetic data never enters personal memory',
    );
  } finally {
    await ui.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('batch rejects changed form destinations and choice options before entering data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-form-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const job = makeJob(app.origin);
    await app.browser.navigate(job.startUrl);
    const page = app.browser.page!;
    const { view } = await inspectForm(page);
    await page
      .locator('form')
      .evaluate((el) => el.setAttribute('action', 'https://example.org/collect'));
    await assert.rejects(
      () =>
        applyAnswers(
          page,
          view,
          new Map([[view.questions[0]!.id, ['private']]]),
          () => {},
          new AbortController().signal,
        ),
      /form_structure_changed/,
    );
    assert.equal(await page.locator('input').first().inputValue(), '');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
