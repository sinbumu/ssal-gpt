import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings } from '../../src/autonomy.js';
import { inspectForm } from '../../src/forms.js';
import type { Job } from '../../src/store.js';

test('omitted consent is not refusal; explicit refusal stops and user-requested review preserves answers without submission', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-consent-review-')),
    app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  const ui = await chromium.launch();
  let posts = 0;
  const id = randomUUID(),
    url = app.origin + '/demo/review-consent';
  try {
    await app.browser.open();
    await app.browser.context!.route(url, async (r) => {
      if (r.request().method() === 'POST') posts++;
      await r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<form method="post"><label>개선의견<input name="idea"></label><label><input type="checkbox" name="consent">개인정보 동의</label><button>제출</button></form>',
      });
    });
    await app.browser.navigate(url);
    app.browser.ownerJobId = id;
    const { view } = await inspectForm(app.browser.page!);
    const a = createAutonomy(
      { ...syntheticSettings, policy: { ...syntheticSettings.policy, finalSubmit: 'review' } },
      app.origin,
      true,
    );
    a.inbox = {
      id: randomUUID(),
      fingerprint: view.fingerprint,
      createdAt: Date.now(),
      items: view.questions.map((q) => ({
        ...q,
        category: q.kind === 'checkbox' ? 'consent' : 'evaluation',
        reason: 'review',
      })),
    };
    const job = {
      id,
      kind: 'apply',
      status: 'needs_user',
      provider: { kind: 'api', model: 'synthetic' },
      goal: 'review test',
      startUrl: url,
      currentUrl: url,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      maxSteps: 40,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      candidateLimit: 1,
      note: '입력 확인',
      uncertain: false,
      history: [],
      allowedOrigins: [app.origin],
      approvedTexts: [],
      autonomy: a,
    } as Job;
    app.store.saveJob(job);
    app.runner.model.decide = (async (_p, _i, ctx: any) => ({
      inputTokens: 0,
      outputTokens: 0,
      step: {
        action: 'form_plan',
        observationId: ctx.observation.id,
        reason: 'fixture',
        buttonId: ctx.form.buttons[0].id,
        answers: ctx.form.questions.map((q: any) => ({
          questionId: q.id,
          category: q.kind === 'checkbox' ? 'consent' : 'evaluation',
          source: 'unknown',
          answer: [],
          reason: 'existing user answers',
        })),
      },
    })) as typeof app.runner.model.decide;
    const api = async (action: string, body: unknown) => {
      const s = await fetch(app.origin + '/api/state').then((r) => r.json());
      return fetch(`${app.origin}/api/jobs/${id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': s.csrf },
        body: JSON.stringify(body),
      });
    };
    const [idea, consent] = view.questions;
    const data = {
      inboxId: a.inbox.id,
      answers: { [idea!.id]: ['저장한 개선 제안'], [consent!.id]: [] },
    };
    const missing = await api('inbox', data);
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, 'consent_decision_required');
    assert.equal(app.store.job(id)!.status, 'needs_user');
    assert.equal(app.store.job(id)!.autonomy!.inbox!.id, a.inbox.id);
    const page = await ui.newPage();
    await page.goto(app.origin);
    const form = page.locator(`[data-inbox="${id}"]`);
    await form.waitFor();
    assert.equal(await form.locator('input[type=radio]').count(), 2);
    assert.equal(await form.locator('input[type=radio]:checked').count(), 0);
    assert.equal(await form.evaluate((f) => (f as HTMLFormElement).checkValidity()), false);
    assert.equal((await api('inbox', { ...data, explicitDeclines: [consent!.id] })).status, 200);
    await app.runner.finished();
    let stopped = app.store.job(id)!;
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.autonomy!.metrics.fields, 0);
    assert.equal(posts, 0);
    const oldSteps = stopped.steps;
    assert.deepEqual(stopped.autonomy!.overrides[idea!.signature], ['저장한 개선 제안']);
    assert.equal((await api('review-consent', {})).status, 200);
    let reopened = app.store.job(id)!;
    const box = reopened.autonomy!.inbox!;
    assert.equal(reopened.status, 'needs_user');
    assert.equal(box.items.length, 1);
    assert.equal(box.items[0]!.category, 'consent');
    assert.equal(reopened.steps, oldSteps);
    assert.equal(reopened.maxSteps, 40);
    assert.equal(posts, 0);
    assert.equal(reopened.autonomy!.overrides[consent!.signature], undefined);
    assert.deepEqual(reopened.autonomy!.overrides[idea!.signature], ['저장한 개선 제안']);
    assert.equal(
      (
        await api('inbox', {
          inboxId: box.id,
          answers: { [consent!.id]: [consent!.options[0]!.id] },
        })
      ).status,
      200,
    );
    await app.runner.finished();
    reopened = app.store.job(id)!;
    assert.equal(reopened.autonomy!.inbox!.final, true, reopened.note);
    assert.equal(posts, 0);
    assert.equal(await app.browser.page!.locator('[name=idea]').inputValue(), '저장한 개선 제안');
    assert.equal((await api('review-consent', {})).status, 400);
  } finally {
    await ui.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
