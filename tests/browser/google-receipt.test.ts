import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server.js';
import type { Job } from '../../src/store.js';
import { createAutonomy, syntheticSettings } from '../../src/autonomy.js';
import { captureReceipt, verifyReceipt, watchSubmissionDialogs } from '../../src/receipt.js';

const start = 'https://docs.google.com/forms/d/e/fixtureReceipt/viewform';
const target = start.replace('viewform', 'formResponse');
for (const scenario of [
  'thanks-ko',
  'thanks-en',
  'custom-semantic',
  'plain-thanks',
  'still-form',
  'old-message',
  'next',
  'closed',
  'http-error',
  'missing-response',
  'capture-pending',
  'wrong-form',
  'stale-intent',
  'duplicate-component',
] as const) {
  test(`Google confirmation ${scenario}: bound final response and rendered state, never replay`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssal-google-receipt-'));
    const app = await createApp({ dir, port: 0, headless: true });
    app.scheduler.stop();
    let posts = 0,
      calls = 0;
    const message =
      scenario === 'thanks-en'
        ? 'Thank you for your response.'
        : scenario === 'custom-semantic'
          ? '소중한 의견은 서비스 개선에 반영하겠습니다.'
          : scenario === 'closed'
            ? '이 설문지는 더 이상 응답을 받지 않습니다.'
            : '응답해 주셔서 감사합니다.';
    const job: Job = {
      id: randomUUID(),
      kind: 'apply',
      provider: { kind: 'api', model: 'fixture' },
      goal: 'fixture',
      startUrl: start,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      maxSteps: 10,
      candidateLimit: 1,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      uncertain: false,
      note: '',
      allowedOrigins: [new URL(start).origin],
      approvedTexts: [],
      history: [],
      autonomy: createAutonomy(syntheticSettings, new URL(start).origin),
    };
    try {
      await app.browser.open();
      app.browser.ownerJobId = job.id;
      await app.browser.context!.route('https://docs.google.com/**', async (r) => {
        const post = r.request().method() === 'POST';
        if (post) posts++;
        const component = `<div class="idZHHb"><div class="vHW8K">${message}</div></div>`;
        await r.fulfill({
          status: post && scenario === 'http-error' ? 500 : 200,
          contentType: 'text/html; charset=utf-8',
          body: post
            ? (scenario === 'plain-thanks' ? `<p>${message}</p>` : component) +
              (scenario === 'still-form'
                ? '<form><input aria-label="다음 질문"><button>제출</button></form>'
                : '') +
              (scenario === 'duplicate-component' ? component : '')
            : `${scenario === 'old-message' ? `<p>${message}</p>` : ''}<form method="post" action="${target}"><label>이름<input name="name" value="fixture"></label><button>제출</button></form>`,
        });
      });
      await app.browser.navigate(start);
      const before = await app.browser.observe(true);
      job.uncertain = true;
      job.transmitted = true;
      job.intent = {
        kind: 'submission',
        providerControl: 'google-submit',
        controlLabel: '제출',
        url: start,
        beforeText: before.text,
        at: Date.now(),
      };
      app.store.saveJob(job);
      const watcher = await watchSubmissionDialogs(app.store, app.browser, job, target);
      await app.browser.page!.getByRole('button', { name: '제출', exact: true }).click();
      await watcher.settle(AbortSignal.timeout(10000));
      watcher.close();
      const o = await app.browser.observe(true);
      captureReceipt(job, o);
      if (['plain-thanks', 'still-form', 'duplicate-component'].includes(scenario))
        assert.equal(o.googleConfirmation, undefined);
      else assert.equal(o.googleConfirmation?.message, message);
      if (scenario === 'next') {
        job.intent.kind = 'step';
        job.intent.providerControl = 'google-next';
        job.intent.controlLabel = '다음';
      }
      if (scenario === 'missing-response') job.receiptResponses = [];
      if (scenario === 'capture-pending') {
        job.receiptCapture!.settled = false;
        job.receiptCapture!.pendingTasks = 1;
      }
      if (scenario === 'wrong-form')
        job.receiptObservations![0]!.googleConfirmation!.formId = 'differentForm';
      if (scenario === 'stale-intent') job.intent.at! += 100000;
      app.store.saveJob(job);
      const model = {
        decide: async (_p: unknown, _i: string, ctx: any) => {
          calls++;
          if (scenario === 'custom-semantic') assert.equal(ctx.boundGoogleConfirmation, message);
          return {
            inputTokens: 10,
            outputTokens: 5,
            step: {
              action: 'done',
              receiptKind: 'accepted',
              evidenceQuote: message,
              observationId: ctx.observation.id,
              reason: 'fixture',
            },
          };
        },
      } as any;
      const accepted = ['thanks-ko', 'thanks-en', 'custom-semantic'].includes(scenario);
      assert.equal(
        await verifyReceipt(app.store, app.browser, model, job, AbortSignal.timeout(10000), true),
        accepted,
        job.receiptCheck?.reason,
      );
      assert.equal(posts, 1);
      if (accepted) {
        assert.equal(job.status, 'completed');
        assert.equal(job.receiptCheck!.method, scenario === 'custom-semantic' ? 'ai' : 'rules');
        assert.equal(calls, scenario === 'custom-semantic' ? 1 : 0);
      } else assert.notEqual(job.status, 'completed');
      if (scenario === 'thanks-ko') {
        // The observation facts persist. Rechecking works after browser shutdown
        // without reconstructing the form, another model call or another POST.
        job.uncertain = true;
        job.status = 'submission_unknown';
        app.store.saveJob(job);
        await app.browser.close();
        const s = await fetch(app.origin + '/api/state').then((r) => r.json());
        const result = await fetch(app.origin + `/api/jobs/${job.id}/verify-result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': s.csrf },
          body: '{}',
        }).then((r) => r.json());
        assert.equal(result.verified, true);
        assert.equal(app.store.job(job.id)!.status, 'completed');
        assert.equal(posts, 1);
        assert.equal(calls, 0);
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
