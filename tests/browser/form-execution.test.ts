import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings } from '../../src/autonomy.js';
import type { Job } from '../../src/store.js';
import { jobNotice } from '../../src/job-notice.js';

const start = 'https://docs.google.com/forms/d/e/fixtureStages/viewform';
const target = start.replace('viewform', 'formResponse');
for (const scenario of [
  'same-label',
  'empty-section',
  'delayed-section',
  'resume-observation',
  'limit-next',
  'limit-final',
  'invalid-input',
] as const) {
  test(`form stages ${scenario}: input, Next observation and receipt are independent`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssal-stages-'));
    const app = await createApp({ dir, port: 0, headless: true });
    app.scheduler.stop();
    const config = {
      ...syntheticSettings,
      policy: { ...syntheticSettings.policy, finalSubmit: 'review' as const },
    };
    app.store.setSettings('autonomy', config);
    const job: Job = {
      id: randomUUID(),
      kind: 'apply',
      provider: { kind: 'api', model: 'fixture' },
      goal: 'fixture',
      startUrl: start,
      status: 'paused',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      maxSteps: scenario === 'limit-next' ? 1 : scenario === 'limit-final' ? 3 : 10,
      candidateLimit: 1,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      uncertain: false,
      note: '',
      allowedOrigins: [new URL(start).origin],
      approvedTexts: [],
      history: [],
      autonomy: createAutonomy(config, new URL(start).origin),
    };
    let posts = 0,
      finals = 0,
      calls = 0;
    const phases: string[] = [];
    function form(stage: number) {
      const path = ['0', '0,3', '0,3,7'][stage];
      const key =
        stage === 0 || scenario === 'same-label' ? 'name' : stage === 1 ? 'email' : 'phone';
      const label = { name: '이름', email: '이메일', phone: '휴대폰 번호' }[key];
      const empty = stage === 1 && scenario === 'empty-section';
      const delay = stage === 1 && ['delayed-section', 'resume-observation'].includes(scenario);
      return `<title>가상 다중페이지 폼</title><form method="post" action="${target}" ${stage === 0 ? 'data-is-first-page="true"' : ''}>
        <input type="hidden" name="pageHistory" value="${delay ? 'loading' : path}">
        ${empty ? '<p>다음 섹션 안내</p>' : `<label>${label}<input name="${key}" ${scenario === 'invalid-input' ? 'pattern="[0-9]{2}"' : ''}></label>`}
        ${stage ? '<div role="button">뒤로</div>' : ''}
        <div role="button" tabindex="0" jsname="${stage === 2 ? 'final' : 'OCpkoe'}" onclick="this.closest('form').requestSubmit()">${stage === 2 ? '제출' : '다음'}</div></form>
        ${delay ? `<script>setTimeout(()=>document.querySelector('[name=pageHistory]').value='${path}',${scenario === 'resume-observation' ? 8000 : 2300})</script>` : ''}`;
    }
    try {
      await app.browser.open();
      await app.browser.context!.route('https://docs.google.com/**', async (r) => {
        const post = r.request().method() === 'POST';
        let body = form(0);
        if (post) {
          posts++;
          const saved = app.store.job(job.id)!;
          const p = new URLSearchParams(r.request().postData()!).get('pageHistory');
          const stage = ['0', '0,3', '0,3,7'].indexOf(p!);
          assert.equal(saved.formExecution?.input?.state, 'verified');
          assert.equal(saved.uncertain, stage === 2, 'only final submit uses receipt uncertainty');
          phases.push(
            stage === 2
              ? saved.formExecution!.submission!.state
              : saved.formExecution!.transition!.state,
          );
          if (stage === 2) {
            finals++;
            body = '<div class="idZHHb"><div class="vHW8K">응답해 주셔서 감사합니다.</div></div>';
          } else body = form(stage + 1);
        }
        await r.fulfill({ contentType: 'text/html; charset=utf-8', body });
      });
      app.runner.model.decide = (async (_p: unknown, _i: string, ctx: any) => {
        calls++;
        assert.notEqual(
          ctx.purpose,
          'verify_receipt',
          'known receipts and Next require no model call',
        );
        return {
          inputTokens: 1,
          outputTokens: 1,
          step: {
            observationId: ctx.observation.id,
            action: 'form_plan',
            reason: 'fixture',
            buttonId: ctx.form.buttons[0].id,
            answers: ctx.form.questions.map((q: any) => ({
              questionId: q.id,
              category: 'fact',
              source: 'profile',
              sourceId: q.label === '이름' ? 'name' : q.label === '이메일' ? 'email' : 'phone',
              answer: [],
              reason: 'fixture',
            })),
          },
        };
      }) as any;
      app.store.saveJob(job);
      app.runner.start(job.id);
      await app.runner.finished();
      let current = app.store.job(job.id)!;
      if (scenario === 'invalid-input') {
        assert.equal(posts, 0);
        assert.equal(current.intent, undefined);
        assert.equal(current.uncertain, false);
        assert.equal(current.formExecution?.input?.state, 'applying');
        assert.equal(current.stopReason?.code, 'form_validation_failed');
        return;
      }
      if (scenario === 'resume-observation') {
        assert.equal(current.status, 'failed', current.note);
        assert.equal(current.uncertain, false);
        assert.equal(current.formExecution?.transition?.state, 'blocked');
        assert.equal(jobNotice(current)?.code, 'step_page_not_ready');
        assert.equal(current.receiptCheck, undefined);
        assert.equal(posts, 1);
        await app.browser.page!.waitForFunction(
          () => document.querySelector<HTMLInputElement>('[name=pageHistory]')?.value === '0,3',
        );
        // Normal app resume reads the current page; neither a data repair nor a replay.
        app.runner.start(job.id);
        await app.runner.finished();
        current = app.store.job(job.id)!;
      }
      if (scenario === 'limit-next') {
        assert.equal(current.status, 'paused');
        assert.equal(current.formExecution?.transition?.state, 'verified');
        assert.equal(current.formExecution?.pages.length, 1);
        assert.equal(current.uncertain, false);
        assert.equal(posts, 1);
        assert.equal(calls, 1);
        return;
      }
      assert.equal(current.autonomy?.inbox?.final, true, current.note);
      assert.equal(current.formExecution?.submission?.state, 'review');
      assert.equal(current.formExecution?.pages.length, 2);
      assert.equal(current.receiptCheck, undefined);
      assert.equal(posts, 2);
      if (scenario === 'delayed-section') assert.ok(current.formExecution!.pages[0]!.attempts > 1);
      if (scenario === 'resume-observation')
        assert.ok(current.formExecution!.pages[0]!.attempts > 4);
      const state = await fetch(app.origin + '/api/state').then((r) => r.json());
      const response = await fetch(app.origin + `/api/jobs/${job.id}/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
        body: JSON.stringify({ inboxId: current.autonomy!.inbox!.id, confirm: true }),
      });
      assert.equal(response.status, 200, await response.text());
      await app.runner.finished();
      current = app.store.job(job.id)!;
      assert.equal(current.status, 'completed', current.note);
      assert.equal(current.formExecution?.submission?.state, 'accepted');
      assert.equal(current.receiptCheck?.method, 'rules');
      assert.equal(finals, 1);
      assert.equal(posts, 3);
      assert.equal(calls, 3);
      assert.deepEqual(phases, ['observing', 'observing', 'observing']);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
