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

async function post(app: Awaited<ReturnType<typeof createApp>>, path: string, data: unknown) {
  const s = await fetch(app.origin + '/api/state').then((r) => r.json());
  return fetch(app.origin + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': s.csrf },
    body: JSON.stringify(data),
  });
}

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
test('rendered required hints format profile phones locally and mask their echoed value', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-phone-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const job = makeJob(app.origin);
    job.autonomy!.profile = { ...job.autonomy!.profile, phone: '01000000000' };
    job.autonomy!.policy = { ...job.autonomy!.policy, finalSubmit: 'review' };
    await app.browser.navigate(job.startUrl);
    await app.browser.page!.setContent(`<form><p id="phone-hint">중간에 하이픈을 넣어주세요.</p>
      <fieldset><h3>답변 필수 연락처</h3><input name="phone" aria-describedby="phone-hint"><output></output>
      </fieldset><button type="submit">제출</button></form>
      <script>document.querySelector('input').oninput=e=>document.querySelector('output').textContent=e.target.value</script>`);
    const before = await inspectForm(app.browser.page!);
    assert.equal(before.view.questions[0]!.required, true);
    assert.ok(before.view.questions[0]!.description!.includes('하이픈'));
    // Echoed values are outside the fieldset hint, as on many result previews.
    await app.browser.page!.evaluate(() => document.body.append(document.querySelector('output')!));
    job.currentUrl = job.startUrl;
    app.browser.ownerJobId = job.id;
    app.store.saveJob(job);
    const runner = new Runner(app.store, app.browser, syntheticModel(), app.origin);
    runner.start(job.id);
    await runner.finished();
    const result = app.store.job(job.id)!;
    assert.equal(result.autonomy!.inbox!.final, true, result.note);
    assert.equal(await app.browser.page!.locator('input').inputValue(), '010-0000-0000');
    assert.equal(result.autonomy!.profile.phone, '01000000000');
    assert.ok(result.autonomy!.privateAnswers!.includes('010-0000-0000'));
    const o = await app.browser.observe(true, result.autonomy!.privateAnswers);
    assert.ok(!o.text.includes('010-0000-0000'));
    const previous = (await inspectForm(app.browser.page!)).view.fingerprint;
    await app.browser
      .page!.locator('#phone-hint')
      .evaluate((el) => (el.textContent = '숫자만 입력'));
    assert.notEqual((await inspectForm(app.browser.page!)).view.fingerprint, previous);
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
    await page.getByText('지난 실행 내역 펼치기', { exact: true }).click();
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

test('final review is bound to actual values; manual edits cannot be silently overwritten and submitted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-final-review-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    app.runner.model.decide = syntheticModel().decide;
    const j = makeJob(app.origin);
    j.autonomy!.policy = { ...j.autonomy!.policy, finalSubmit: 'review' };
    app.store.saveJob(j);
    app.runner.start(j.id);
    await app.runner.finished();
    const pending = app.store.job(j.id)!;
    assert.equal(pending.autonomy!.inbox?.final, true);
    assert.equal(demoState(app.store, j.id).posts, 4);
    await app.browser.page!.locator('input[type=tel]').fill('010-1111-1111');
    assert.equal(
      (
        await post(app, `/api/jobs/${j.id}/inbox`, {
          inboxId: pending.autonomy!.inbox!.id,
          confirm: true,
        })
      ).status,
      200,
    );
    await app.runner.finished();
    const changed = app.store.job(j.id)!;
    assert.equal(changed.status, 'needs_user');
    assert.equal(changed.note, 'final_review_changed');
    assert.equal(await app.browser.page!.locator('input[type=tel]').inputValue(), '010-1111-1111');
    assert.equal(demoState(app.store, j.id).posts, 4);
    // A fresh review must be generated and explicitly accepted before submission.
    app.runner.start(j.id);
    await app.runner.finished();
    const fresh = app.store.job(j.id)!;
    assert.ok(fresh.autonomy!.inbox?.final);
    assert.notEqual(fresh.autonomy!.inbox!.id, pending.autonomy!.inbox!.id);
    assert.equal(
      (
        await post(app, `/api/jobs/${j.id}/inbox`, {
          inboxId: fresh.autonomy!.inbox!.id,
          confirm: true,
        })
      ).status,
      200,
    );
    await app.runner.finished();
    assert.equal(app.store.job(j.id)!.status, 'completed');
    assert.equal(demoState(app.store, j.id).posts, 5);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('revoked delegation stops before input; settings and profile are not copied into the state polling response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-revoke-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const j = makeJob(app.origin);
    j.autonomy!.synthetic = false;
    j.autonomy!.revision = 'old';
    app.store.saveJob(j);
    assert.equal(
      (
        await post(app, '/api/autonomy', {
          profile: syntheticSettings.profile,
          policy: syntheticSettings.policy,
        })
      ).status,
      200,
    );
    app.runner.model.decide = syntheticModel().decide;
    app.runner.start(j.id);
    await app.runner.finished();
    assert.equal(app.store.job(j.id)!.note, 'delegation_expired_or_changed');
    assert.equal(app.store.job(j.id)!.steps, 0);
    assert.equal(await app.browser.page!.locator('input').first().inputValue(), '');
    const s = await fetch(app.origin + '/api/state').then((r) => r.text());
    assert.ok(!s.includes('demo@example.invalid'));
    assert.equal((await post(app, `/api/jobs/${j.id}/delegation`, {})).status, 200);
    app.runner.start(j.id);
    await app.runner.finished();
    assert.equal(app.store.job(j.id)!.status, 'completed');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('autonomous submission response loss never repeats a POST and receipt read reconciles the result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-unknown-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const j = makeJob(app.origin);
    app.store.saveJob(j);
    app.runner.model.decide = syntheticModel().decide;
    await app.browser.open();
    await app.browser.page!.route('**/demo/autonomy*', async (route) => {
      if (route.request().method() === 'POST' && demoState(app.store, j.id).page === 5) {
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    app.runner.start(j.id);
    await app.runner.finished();
    assert.equal(app.store.job(j.id)!.status, 'submission_unknown');
    assert.equal(demoState(app.store, j.id).posts, 5);
    app.runner.start(j.id);
    await app.runner.finished();
    assert.equal(demoState(app.store, j.id).posts, 5);
    // User navigates to the existing receipt (GET); this does not submit again.
    await app.browser.navigate(j.startUrl);
    app.runner.start(j.id);
    await app.runner.finished();
    assert.equal(app.store.job(j.id)!.status, 'completed');
    assert.equal(demoState(app.store, j.id).posts, 5);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('confirmed answers persist through dashboard API and a new job reuses them without asking again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-reuse-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    await post(app, '/api/autonomy', {
      profile: syntheticSettings.profile,
      policy: syntheticSettings.policy,
    });
    const config = app.store.settings<any>('autonomy', null);
    app.runner.model.decide = syntheticModel().decide;
    const first = makeJob(app.origin);
    first.autonomy = createAutonomy(config, app.origin);
    app.store.saveJob(first);
    app.store.setSettings(`synthetic:${first.id}`, {
      page: 1,
      layout: 'normal',
      inbox: true,
      posts: 0,
    });
    app.runner.start(first.id);
    await app.runner.finished();
    const box = app.store.job(first.id)!.autonomy!.inbox!;
    assert.equal(box.items.length, 2);
    assert.equal(
      (
        await post(app, `/api/jobs/${first.id}/inbox`, {
          inboxId: box.id,
          answers: Object.fromEntries(box.items.map((q) => [q.id, ['아니요']])),
          remember: true,
        })
      ).status,
      200,
    );
    await app.runner.finished();
    assert.equal(app.store.job(first.id)!.status, 'completed');
    assert.equal(app.store.settings('answers', []).length, 2);
    const second = makeJob(app.origin);
    second.autonomy = createAutonomy(config, app.origin);
    app.store.saveJob(second);
    app.store.setSettings(`synthetic:${second.id}`, {
      page: 1,
      layout: 'shift',
      inbox: true,
      posts: 0,
    });
    app.runner.start(second.id);
    await app.runner.finished();
    const done = app.store.job(second.id)!;
    assert.equal(done.status, 'completed');
    assert.equal(done.autonomy!.metrics.inboxBatches, 0);
    assert.equal(demoState(app.store, second.id).posts, 5);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an untouched preparation survives restart and waits for delayed form rendering before planning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-delayed-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const j = makeJob(app.origin);
    j.currentUrl = j.startUrl;
    app.store.saveJob(j);
    await app.browser.open();
    await app.browser.page!.route('**/demo/autonomy?**', (r) =>
      r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<p>설문 준비 중</p><script>setTimeout(()=>document.body.innerHTML='<form><label>의견<input></label><button>제출</button></form>',1200)</script>`,
      }),
    );
    let calls = 0;
    const model = {
      async decide(_p: unknown, _i: string, ctx: any) {
        calls++;
        assert.equal(ctx.form.questions.length, 1);
        return {
          step: {
            action: 'needs_user',
            observationId: ctx.observation.id,
            reason: 'fixture reached loaded form',
          },
          inputTokens: 0,
          outputTokens: 0,
        };
      },
    } as unknown as Model;
    const runner = new Runner(app.store, app.browser, model, app.origin);
    runner.start(j.id);
    await runner.finished();
    assert.equal(calls, 1);
    assert.equal(app.store.job(j.id)!.note, 'fixture reached loaded form');
    assert.equal(app.store.job(j.id)!.autonomy!.metrics.fields, 0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
