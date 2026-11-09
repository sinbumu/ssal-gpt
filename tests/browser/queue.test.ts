import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from '../../src/browser.js';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings } from '../../src/autonomy.js';
import { inspectForm } from '../../src/forms.js';
import type { Job } from '../../src/store.js';
import { randomUUID } from 'node:crypto';
import { OperationsSchema } from '../../src/operations.js';

test('independent job tabs preserve a filled POST form and invalidate observations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-tabs-'));
  const browser = new Browser(dir, 'http://127.0.0.1:54321', true);
  try {
    await browser.selectJob('one');
    browser.ownerJobId = 'one';
    await browser.page!.setContent(
      '<form method="post"><input name="answer"><button>Submit</button></form>',
    );
    await browser.page!.locator('input').fill('keep this answer');
    const original = browser.page;
    await browser.selectJob('two');
    browser.ownerJobId = 'two';
    assert.notEqual(browser.page, original);
    await browser.page!.setContent('<p>Independent discovery</p>');
    await browser.selectJob('one');
    assert.equal(browser.page, original);
    assert.equal(browser.ownerJobId, 'one');
    assert.equal(await browser.page!.locator('input').inputValue(), 'keep this answer');
    assert.equal(browser.latest, undefined);
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dashboard accepts answers while another job runs and resumes the preserved form from the queue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-queue-inbox-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  try {
    const id = randomUUID(),
      at = new Date().toISOString();
    const first: Job = {
      id,
      kind: 'autonomy_demo',
      provider: { kind: 'api', model: 'fixture' },
      goal: 'first',
      startUrl: app.origin + '/demo/queued-form',
      currentUrl: app.origin + '/demo/queued-form',
      status: 'needs_user',
      createdAt: at,
      updatedAt: at,
      candidateLimit: 1,
      maxSteps: 20,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      note: '',
      uncertain: false,
      allowedOrigins: [app.origin],
      approvedTexts: [],
      history: [],
      autonomy: createAutonomy(syntheticSettings, app.origin, true),
    };
    await app.browser.selectJob(id);
    app.browser.ownerJobId = id;
    let posts = 0,
      gets = 0;
    await app.browser.page!.route(first.startUrl, (r) => {
      if (r.request().method() === 'POST') {
        posts++;
        app.store.submitDemo(id);
        return r.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '<h1>설문이 완료되었습니다.</h1>',
        });
      }
      gets++;
      return r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<form method="post"><label>확인한 경험<input name="experience" required></label><button>제출</button></form>',
      });
    });
    await app.browser.navigate(first.startUrl);
    const { view } = await inspectForm(app.browser.page!);
    first.autonomy!.inbox = {
      id: randomUUID(),
      fingerprint: view.fingerprint,
      createdAt: Date.now(),
      items: [{ ...view.questions[0]!, category: 'fact', reason: 'unknown' }],
    };
    app.store.saveJob(first);
    const second: Job = {
      ...first,
      id: randomUUID(),
      kind: 'discover',
      goal: 'second',
      startUrl: app.origin + '/demo/event',
      currentUrl: undefined,
      status: 'queued',
      autonomy: undefined,
    };
    app.store.saveJob(second);
    app.store.setSettings('operations', OperationsSchema.parse({ queueEnabled: true }));
    app.runner.model.decide = async (_p, _i, c: any) => {
      if (c.goal === 'second') {
        await gate;
        return {
          step: { action: 'done', observationId: c.observation.id, reason: 'read done' },
          inputTokens: 0,
          outputTokens: 0,
        };
      }
      return {
        step: {
          action: 'form_plan',
          observationId: c.observation.id,
          reason: 'fixture',
          buttonId: c.form.buttons[0].id,
          answers: c.form.questions.map((q: any) => ({
            questionId: q.id,
            category: 'fact',
            source: 'unknown',
            reason: 'saved user answer',
          })),
        },
        inputTokens: 0,
        outputTokens: 0,
      };
    };
    app.runner.start(second.id);
    const state = await fetch(app.origin + '/api/state').then((r) => r.json());
    const response = await fetch(app.origin + `/api/jobs/${id}/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
      body: JSON.stringify({
        inboxId: first.autonomy!.inbox.id,
        answers: { [view.questions[0]!.id]: ['사용자 확인 답변'] },
      }),
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(app.store.job(id)?.status, 'queued');
    release();
    await app.runner.finished();
    await app.scheduler.tick();
    await app.runner.finished();
    assert.equal(app.store.job(id)?.status, 'completed', app.store.job(id)?.note);
    assert.equal(gets, 1, 'waiting form must never be reopened');
    assert.equal(posts, 1);
  } finally {
    release();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
