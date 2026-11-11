import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings } from '../../src/autonomy.js';
import type { Job } from '../../src/store.js';
import { verifyReceipt } from '../../src/receipt.js';

for (const scenario of [
  'accepted',
  'validation',
  'confirm',
  'before-post',
  'foreign-frame',
  'mixed-alerts',
] as const) {
  test(`submission alert ${scenario}: exact response binding, final review, masking and no duplicate POST`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssal-dialog-receipt-'));
    const app = await createApp({ dir, port: 0, headless: true });
    let posts = 0;
    const config = {
      ...syntheticSettings,
      policy: { ...syntheticSettings.policy, finalSubmit: 'review' as const },
    };
    app.store.setSettings('autonomy', config);
    const j: Job = {
      id: randomUUID(),
      kind: 'apply',
      provider: { kind: 'api', model: 'synthetic' },
      goal: 'synthetic receipt',
      startUrl: app.origin + '/demo/dialog',
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      maxSteps: 10,
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
    try {
      await app.browser.open();
      await app.browser.context!.route('https://example.org/**', (r) =>
        r.fulfill({ contentType: 'text/html', body: '<p>Public return page</p>' }),
      );
      await app.browser.context!.route(app.origin + '/demo/**', async (r) => {
        if (r.request().method() === 'POST') {
          posts++;
          const message =
            scenario === 'validation'
              ? '응모가 완료되지 않았습니다. 인증문자 오류입니다.'
              : '응모가 완료되었습니다. ' + config.profile.name;
          const call =
            scenario === 'before-post'
              ? ''
              : `${scenario === 'confirm' ? 'confirm' : 'alert'}(${JSON.stringify(message)});`;
          await r.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<script>${call}${scenario === 'mixed-alerts' ? "alert('처리 오류가 발생했습니다.');" : ''}parent.location.href='https://example.org/returned';</script>`,
          });
        } else {
          await r.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<h1>가상 응모</h1><form method="post" action="/demo/save" target="result" ${scenario === 'before-post' ? `onsubmit="alert('응모가 완료되었습니다.')"` : ''}><label>이름<input name="name" required></label><button>제출</button></form><iframe name="result" hidden></iframe>${scenario === 'foreign-frame' ? '<iframe src="https://example.org/foreign" hidden></iframe>' : ''}`,
          });
        }
      });
      app.runner.model.decide = (async (_p: unknown, _i: unknown, ctx: any) => ({
        step: ctx.uncertain
          ? {
              observationId: ctx.observation.id,
              action: 'needs_user',
              reason: '접수 확인 불가',
              receiptKind: 'not_confirmed',
            }
          : {
              observationId: ctx.observation.id,
              action: 'form_plan',
              reason: '가상 이름 입력',
              buttonId: ctx.form.buttons[0].id,
              answers: ctx.form.questions.map((q: any) => ({
                questionId: q.id,
                category: 'fact',
                source: 'profile',
                sourceId: 'name',
                reason: '저장 값',
              })),
            },
        inputTokens: 0,
        outputTokens: 0,
      })) as typeof app.runner.model.decide;
      app.store.saveJob(j);
      app.runner.start(j.id);
      await app.runner.finished();
      const prepared = app.store.job(j.id)!;
      assert.equal(prepared.autonomy!.inbox?.final, true, prepared.note);
      assert.equal(posts, 0);
      const state = await fetch(app.origin + '/api/state').then((r) => r.json());
      const response = await fetch(app.origin + `/api/jobs/${j.id}/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
        body: JSON.stringify({ inboxId: prepared.autonomy!.inbox!.id, confirm: true }),
      });
      assert.equal(response.status, 200, await response.text());
      await app.runner.finished();
      const result = app.store.job(j.id)!;
      assert.equal(posts, 1);
      assert.equal(
        result.status,
        scenario === 'accepted' ? 'completed' : 'submission_unknown',
        result.note,
      );
      if (scenario === 'accepted') {
        assert.equal(result.receiptDialogs?.length, 1);
        assert.ok(!JSON.stringify(result.receiptDialogs).includes(config.profile.name));
        // Persisted native evidence can be verified with no page/model interaction.
        result.status = 'submission_unknown';
        result.uncertain = true;
        app.store.saveJob(result);
        assert.equal(
          await verifyReceipt(
            app.store,
            app.browser,
            {
              decide: async () => {
                throw new Error('must not call model');
              },
            },
            result,
            new AbortController().signal,
          ),
          true,
        );
      } else {
        app.runner.start(j.id);
        await app.runner.finished();
        assert.equal(app.store.job(j.id)!.status, 'submission_unknown');
      }
      assert.equal(posts, 1);
      const publicState = await fetch(app.origin + '/api/state').then((r) => r.json());
      assert.equal(publicState.jobs.find((job: any) => job.id === j.id).receiptDialogs, undefined);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
