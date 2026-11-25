import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../../src/server.js';
import { syntheticSettings } from '../../src/autonomy.js';
import {
  entryBatch,
  entryBatchPlan,
  startEntryBatch,
  stopEntryBatch,
} from '../../src/entry-batch.js';
import { operations } from '../../src/operations.js';
import type { Store } from '../../src/store.js';
const provider = { kind: 'api' as const, model: 'fixture' };
function record(store: Store, n: number) {
  const entryUrl = 'https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=entryQuiz' + n;
  return store.record(
    {
      title: '테스트 이벤트 ' + n,
      organizer: '합성 주최자 ' + n,
      entryUrl,
      deadline: '2099-01-01T00:00:00Z',
      prize: '커피',
      winners: 5,
      requirements: ['폼 응답'],
      blockers: [],
      evidenceQuote: '공식 안내',
      evidenceKind: 'text',
      effortMinutes: 3,
    },
    'https://example.org/event/' + n,
    'discovery',
    'fixture.png',
    {
      sourceEvidence: [
        {
          id: 'form',
          url: entryUrl,
          title: '폼',
          text: '공식 안내',
          screenshot: 'fixture.png',
          observedAt: Date.now(),
        },
      ],
    },
  ).event;
}

for (const finalSubmit of ['review', 'auto'] as const) {
  test(
    'dashboard starts two sequential form jobs with saved final policy ' + finalSubmit,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ssal-entry-batch-'));
      const app = await createApp({ dir, port: 0, headless: true });
      app.scheduler.stop();
      const dashboard = await chromium.launch();
      try {
        app.store.setSettings('selection', provider);
        app.store.setSettings('autonomy', {
          ...syntheticSettings,
          policy: { ...syntheticSettings.policy, finalSubmit },
        });
        record(app.store, 1);
        record(app.store, 2);
        app.auth.bearer = async () => 'fixture';
        const posts: string[] = [];
        await app.browser.open();
        await app.browser.context!.route('**/*', (r) => {
          if (r.request().method() === 'POST') {
            posts.push(new URL(r.request().url()).pathname);
            return r.fulfill({ json: { message: '응답이 제출되었습니다.' } });
          }
          const field = (name: string) =>
            `<div data-automation-id="questionItem"><div data-automation-id="questionTitle" role="heading">${name}<span data-automation-id="requiredStar"></span></div><input data-automation-id="textInput" aria-label="한 줄 텍스트" aria-required="true"></div>`;
          return r.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<main>${field('이름')}${field('이메일 주소')}<button data-automation-id="submitButton">제출</button></main><script>document.querySelector('button').onclick=async()=>{await fetch('/submit/'+new URLSearchParams(location.search).get('id'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({answers:[...document.querySelectorAll('input')].map(i=>i.value)})});document.querySelector('main').innerText='응답이 제출되었습니다.'}</script>`,
          });
        });
        app.runner.model.decide = async (_p, _i, c: any) => ({
          inputTokens: 5,
          outputTokens: 1,
          step: {
            action: 'form_plan',
            reason: 'fixture',
            observationId: c.observation.id,
            buttonId: c.form.buttons[0].id,
            answers: c.form.questions.map((q: any) => ({
              questionId: q.id,
              category: 'fact',
              source: 'profile',
              sourceId: q.label === '이름' ? 'name' : 'email',
              reason: 'fixture',
            })),
          },
        });
        const page = await dashboard.newPage();
        await page.goto(app.origin);
        await page.getByRole('button', { name: '응모 가능 2건 순차 시작' }).click();
        await page.locator('#entry-batch-stop').waitFor();
        const batch = entryBatch(app.store)!;
        assert.equal(batch.items.length, 2);
        record(app.store, 3); // Later discoveries are outside this grant.
        assert.throws(
          () => startEntryBatch(app.store, 'chromium', provider, 'again'),
          /entry_batch_active/,
        );
        const token = (await (await fetch(app.origin + '/api/state')).json()).csrf;
        for (let i = 0; i < 2; i++) {
          await app.scheduler.tick();
          await app.runner.finished();
          const item = entryBatch(app.store)!.items[i]!;
          const job = app.store.job(item.jobId!)!;
          assert.equal(app.store.jobs().length, i + 1);
          if (finalSubmit === 'review') {
            assert.equal(job.autonomy?.inbox?.final, true, job.note);
            assert.equal(posts.length, i);
            await app.scheduler.tick();
            assert.equal(app.store.jobs().length, i + 1);
            await page.reload();
            await page.getByRole('button', { name: '확인함 열기' }).click();
            await page.locator('[id="job-' + job.id + '"]').waitFor();
            const resp = await fetch(app.origin + '/api/jobs/' + job.id + '/inbox', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': token },
              body: JSON.stringify({ inboxId: job.autonomy!.inbox!.id, confirm: true }),
            });
            assert.equal(resp.status, 200, await resp.text());
            await app.runner.finished();
          }
          assert.equal(app.store.job(job.id)!.status, 'completed', app.store.job(job.id)!.note);
          assert.equal(app.store.submission(item.eventId)?.state, 'completed');
        }
        await app.scheduler.tick();
        assert.equal(entryBatch(app.store)!.state, 'completed');
        assert.deepEqual(
          entryBatch(app.store)!.items.map((i) => i.state),
          ['completed', 'completed'],
        );
        assert.equal(posts.length, 2);
        assert.equal(new Set(posts).size, 2);
        assert.equal(app.store.jobs().length, 2);
      } finally {
        await dashboard.close();
        await app.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}

test('stale scopes, existing claims, budget, delegation changes and stopped batches are respected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-entry-guards-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  try {
    app.store.setSettings('autonomy', syntheticSettings);
    const a = record(app.store, 1),
      b = record(app.store, 2);
    const plan = () => entryBatchPlan(app.store, app.browser.profileKey());
    const original = plan();
    app.store.saveEvent({ ...a, entryUrl: a.entryUrl + 'x' });
    assert.throws(
      () => startEntryBatch(app.store, 'chromium', provider, original.key),
      /entry_batch_plan_changed/,
    );
    app.store.saveEvent(a);
    const batch = startEntryBatch(app.store, 'chromium', provider, plan().key);
    app.store.claimSubmission(b.id, 'anotherJob');
    app.store.saveEvent({ ...a, requirements: ['결제'] });
    await app.scheduler.tick();
    await app.scheduler.tick();
    await app.scheduler.tick();
    assert.deepEqual(
      entryBatch(app.store)!.items.map((i) => i.state),
      ['skipped', 'skipped'],
    );
    assert.equal(app.store.jobs().length, 0);
    app.store.saveEvent(a);
    const next = startEntryBatch(app.store, 'chromium', provider, plan().key);
    assert.throws(() => stopEntryBatch(app.store, batch.id), /entry_batch_changed/);
    app.store.setSettings('operations', { ...operations(app.store), dailyEstimatedUsd: 1 });
    await app.scheduler.tick();
    assert.equal(entryBatch(app.store)!.items[0]!.state, 'pending');
    app.store.setSettings('autonomy', { ...syntheticSettings, revision: 'changed' });
    await app.scheduler.tick();
    assert.equal(entryBatch(app.store)!.state, 'stopped');
    const last = startEntryBatch(app.store, 'chromium', provider, plan().key);
    assert.notEqual(last.id, next.id);
    stopEntryBatch(app.store, last.id);
    await app.scheduler.tick();
    assert.equal(app.store.jobs().length, 0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart preserves the in-flight claim and waits on an unknown receipt before dispatching another event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-entry-restart-'));
  let app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  try {
    app.store.setSettings('autonomy', syntheticSettings);
    record(app.store, 1);
    record(app.store, 2);
    const plan = entryBatchPlan(app.store, 'chromium');
    startEntryBatch(app.store, 'chromium', provider, plan.key);
    // Simulate process exit immediately after the atomic queue/claim write.
    app.runner.start = () => {};
    await app.scheduler.tick();
    const first = entryBatch(app.store)!.items[0]!;
    assert.equal(app.store.job(first.jobId!)!.status, 'queued');
    await app.close();
    app = await createApp({ dir, port: 0, headless: true });
    app.scheduler.stop();
    await app.scheduler.tick();
    const job = app.store.job(first.jobId!)!;
    assert.equal(job.status, 'paused');
    assert.equal(app.store.submission(first.eventId)?.job_id, job.id);
    job.status = 'submission_unknown';
    job.uncertain = true;
    app.store.saveJob(job);
    app.store.markSubmission(first.eventId, 'unknown');
    await app.scheduler.tick();
    await app.scheduler.tick();
    assert.deepEqual(
      entryBatch(app.store)!.items.map((i) => i.state),
      ['current', 'pending'],
    );
    assert.equal(app.store.jobs().length, 1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
