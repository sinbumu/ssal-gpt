import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings } from '../../src/autonomy.js';
import { inspectForm } from '../../src/forms.js';
import { captureReceipt, watchSubmissionDialogs } from '../../src/receipt.js';
import { savedGoogleContinuation, restoreGoogleDraft } from '../../src/google-progress.js';
import type { Job } from '../../src/store.js';
const url = 'https://docs.google.com/forms/d/e/fixtureGoogle/viewform';
const target = url.replace('viewform', 'formResponse');
function form(stage: number) {
  const history = ['0', '0,3', '0,3,7'][stage];
  const key = ['name', 'email', 'phone'][stage];
  const label = ['이름', '이메일', '휴대폰 번호'][stage];
  return `<title>가상 구글폼</title><form method="post" action="${target}" data-is-first-page="${stage === 0}">
  <input type="hidden" name="pageHistory" value="${history}">
  <label>${label}<input name="${key}" required></label>
  ${stage === 2 ? '<fieldset><legend>개인정보 수집 및 이용 동의</legend><p>전화번호를 경품 발송에 이용하고 발표 후 1주일 보관합니다. 수집자: 가상 주최자</p><label><input type="radio" name="consent" value="yes" required>동의합니다</label><label><input type="radio" name="consent" value="no">동의하지 않습니다</label></fieldset>' : ''}
  ${stage ? '<div role="button">뒤로</div>' : ''}
  <div role="button" jsname="${stage === 2 ? 'final' : 'OCpkoe'}" tabindex="0" onclick="this.closest('form').requestSubmit()">${stage === 2 ? '제출' : '다음'}</div></form>`;
}
for (const scenario of ['fresh', 'legacy-live', 'restart'] as const)
  test(`Google ${scenario}: native POST Next, branched sections, final review once and one final submission`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssal-google-next-'));
    const app = await createApp({ dir, port: 0, headless: true });
    app.scheduler.stop();
    let nextPosts = 0,
      finalPosts = 0;
    const config = {
      ...syntheticSettings,
      policy: {
        ...syntheticSettings.policy,
        finalSubmit: 'review' as const,
        consent: { ...syntheticSettings.policy.consent, mode: 'manual' as const },
      },
    };
    app.store.setSettings('autonomy', config);
    const j: Job = {
      id: randomUUID(),
      kind: 'apply',
      provider: { kind: 'api', model: 'fixture' },
      goal: 'fixture',
      startUrl: url,
      currentUrl: url,
      status: 'paused',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      maxSteps: 10,
      candidateLimit: 1,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      uncertain: false,
      note: '',
      allowedOrigins: [new URL(url).origin],
      approvedTexts: [],
      history: [],
      autonomy: createAutonomy(config, new URL(url).origin),
    };
    async function route() {
      await app.browser.context!.route('**/*', async (r) => {
        let body = form(0);
        if (r.request().method() === 'POST') {
          assert.equal(r.request().url(), target);
          const data = new URLSearchParams(r.request().postData()!);
          const stage = ['0', '0,3', '0,3,7'].indexOf(data.get('pageHistory')!);
          assert.ok(stage >= 0);
          const key = ['name', 'email', 'phone'][stage] as 'name' | 'email' | 'phone';
          assert.equal(data.get(key), config.profile[key]);
          if (stage < 2) {
            nextPosts++;
            body = form(stage + 1);
          } else {
            finalPosts++;
            assert.equal(data.get('consent'), 'yes');
            body = '<p>응답이 기록되었습니다.</p>';
          }
        }
        await r.fulfill({ contentType: 'text/html; charset=utf-8', body });
      });
    }
    async function inbox(data: unknown) {
      const s = await fetch(app.origin + '/api/state').then((r) => r.json());
      const r = await fetch(app.origin + `/api/jobs/${j.id}/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': s.csrf },
        body: JSON.stringify(data),
      });
      assert.equal(r.status, 200, await r.text());
      await app.runner.finished();
    }
    try {
      await app.browser.open();
      await route();
      await app.browser.navigate(url);
      app.browser.ownerJobId = j.id;
      const first = (await inspectForm(app.browser.page!)).view;
      assert.equal(first.buttons[0]!.providerControl, 'google-next');
      if (scenario !== 'fresh') {
        const o = await app.browser.observe(true);
        j.uncertain = true;
        j.transmitted = true;
        j.intent = {
          at: Date.now(),
          url,
          kind: 'submission',
          controlLabel: '다음',
          beforeText: o.text,
        };
        j.autonomy!.overrides[first.questions[0]!.signature] = [config.profile.name];
        app.store.saveJob(j);
        await app.browser.page!.locator('[name=name]').fill(config.profile.name);
        const watch = await watchSubmissionDialogs(app.store, app.browser, j, target);
        await app.browser.page!.getByRole('button', { name: '다음', exact: true }).click();
        await watch.settle(AbortSignal.timeout(10000));
        watch.close();
        j.currentUrl = app.browser.page!.url();
        j.history = [{ action: 'form_batch', reason: 'legacy Next mislabeled final', url }];
        captureReceipt(j, await app.browser.observe(true));
        assert.ok(savedGoogleContinuation(j));
        // Invalid captures/final actions never unlock an unknown submission.
        for (const mutate of [
          (x: Job) => {
            x.intent!.controlLabel = '제출';
          },
          (x: Job) => {
            x.receiptCapture!.settled = false;
          },
          (x: Job) => {
            x.receiptCapture!.requests = 2;
          },
          (x: Job) => {
            x.receiptResponses![0]!.status = 500;
          },
          (x: Job) => {
            x.currentUrl = target.replace('fixtureGoogle', 'otherForm');
          },
        ]) {
          const x = structuredClone(j);
          mutate(x);
          assert.equal(savedGoogleContinuation(x), undefined);
        }
        if (scenario === 'restart') {
          await app.browser.close();
          await app.browser.open();
          await route();
          const missing = structuredClone(j);
          missing.autonomy!.overrides = {};
          assert.equal(await restoreGoogleDraft(app.store, app.browser, missing), false);
          assert.equal(nextPosts, 1, 'a failed recovery must not transmit anything');
        }
      }
      app.runner.model.decide = (async (_p: unknown, _i: string, ctx: any) => {
        assert.notEqual(
          ctx.purpose,
          'verify_receipt',
          'Next is resolved without a receipt AI call',
        );
        return {
          inputTokens: 0,
          outputTokens: 0,
          step: {
            observationId: ctx.observation.id,
            action: 'form_plan',
            reason: 'fixture',
            buttonId: ctx.form.buttons[0].id,
            answers: ctx.form.questions.map((q: any) => ({
              questionId: q.id,
              category: q.label.includes('동의') ? 'consent' : 'fact',
              source: q.label.includes('동의') ? 'unknown' : 'profile',
              sourceId: q.label.includes('이름')
                ? 'name'
                : q.label.includes('이메일')
                  ? 'email'
                  : 'phone',
              answer: [],
              reason: 'fixture',
            })),
          },
        };
      }) as any;
      app.store.saveJob(j);
      app.runner.start(j.id);
      await app.runner.finished();
      let current = app.store.job(j.id)!;
      assert.equal(current.status, 'needs_user', current.note);
      assert.equal(current.uncertain, false);
      assert.equal(current.autonomy!.inbox!.final, undefined, 'Next never opens final approval');
      assert.equal(current.autonomy!.inbox!.items.length, 1);
      assert.equal(finalPosts, 0);
      assert.equal(nextPosts, scenario === 'restart' ? 3 : 2);
      assert.equal(current.continuations?.length, scenario === 'restart' ? 3 : 2);
      assert.equal(current.autonomy!.metrics.recoveries, scenario === 'fresh' ? 0 : 1);
      const pending = current.autonomy!.inbox!;
      await inbox({
        inboxId: pending.id,
        answers: { [pending.items[0]!.id]: ['동의합니다'] },
        remember: false,
      });
      current = app.store.job(j.id)!;
      assert.equal(current.autonomy!.inbox!.final, true, current.note);
      assert.equal(current.autonomy!.inbox!.buttonLabel, '제출');
      assert.equal(finalPosts, 0);
      await inbox({ inboxId: current.autonomy!.inbox!.id, confirm: true });
      current = app.store.job(j.id)!;
      assert.equal(current.status, 'completed', current.note);
      assert.equal(finalPosts, 1);
      assert.equal(current.receiptCheck!.method, 'rules');
      assert.equal(current.receiptCheck!.captureIncomplete, false);
      assert.equal(current.receiptResponses![0]!.status, 200);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

test('Google control identity rejects unrelated origins, wrong actions, ambiguous controls and missing/invalid path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-google-control-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  let html = form(0);
  try {
    await app.browser.open();
    await app.browser.context!.route('**/*', (r) =>
      r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }),
    );
    for (const variant of [
      form(0).replace('OCpkoe', 'different'),
      form(0).replace(target, target.replace('fixtureGoogle', 'anotherGoogle')),
      form(0).replace('value="0"', 'value="invalid"'),
      form(0).replace('data-is-first-page="true"', ''),
      form(0).replace('</form>', '<div role="button" jsname="OCpkoe">다음</div></form>'),
      form(0).replace('</form>', '<div role="button">제출</div></form>'),
    ]) {
      html = variant;
      await app.browser.navigate(url);
      assert.ok(
        (await inspectForm(app.browser.page!)).view.buttons.every((b) => !b.providerControl),
      );
    }
    html = form(0);
    await app.browser.navigate(url.replace('docs.google.com', 'example.org'));
    assert.ok((await inspectForm(app.browser.page!)).view.buttons.every((b) => !b.providerControl));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const outcome of ['validation', 'http-error', 'loop'] as const)
  test(`Google Next ${outcome}: does not clear uncertainty or click again`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssal-google-no-replay-'));
    const app = await createApp({ dir, port: 0, headless: true });
    app.scheduler.stop();
    app.store.setSettings('autonomy', syntheticSettings);
    let posts = 0;
    const j: Job = {
      id: randomUUID(),
      kind: 'apply',
      provider: { kind: 'api', model: 'fixture' },
      goal: 'fixture',
      startUrl: url,
      currentUrl: url,
      status: 'paused',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      maxSteps: 10,
      candidateLimit: 1,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      uncertain: false,
      note: '',
      allowedOrigins: [new URL(url).origin],
      approvedTexts: [],
      history: [],
      autonomy: createAutonomy(syntheticSettings, new URL(url).origin),
    };
    try {
      await app.browser.open();
      await app.browser.context!.route('**/*', async (r) => {
        const post = r.request().method() === 'POST';
        if (post) posts++;
        const body = !post
          ? form(0)
          : outcome === 'validation'
            ? form(0) + '<p>필수 질문입니다.</p>'
            : outcome === 'loop'
              ? form(1).replace('value="0,3"', 'value="0,0"')
              : form(1);
        await r.fulfill({
          status: post && outcome === 'http-error' ? 500 : 200,
          contentType: 'text/html; charset=utf-8',
          body,
        });
      });
      await app.browser.navigate(url);
      app.browser.ownerJobId = j.id;
      app.runner.model.decide = (async (_p: unknown, _i: string, ctx: any) => ({
        inputTokens: 0,
        outputTokens: 0,
        step:
          ctx.purpose === 'verify_receipt'
            ? { observationId: ctx.observation.id, action: 'needs_user', reason: '판정 불가' }
            : {
                observationId: ctx.observation.id,
                action: 'form_plan',
                reason: 'fixture',
                buttonId: ctx.form.buttons[0].id,
                answers: [
                  {
                    questionId: ctx.form.questions[0].id,
                    category: 'fact',
                    source: 'profile',
                    sourceId: 'name',
                    answer: [],
                    reason: 'fixture',
                  },
                ],
              },
      })) as any;
      app.store.saveJob(j);
      app.runner.start(j.id);
      await app.runner.finished();
      const stopped = app.store.job(j.id)!;
      assert.equal(stopped.uncertain, true);
      assert.notEqual(stopped.status, 'completed');
      assert.equal(stopped.continuations, undefined);
      assert.equal(posts, 1);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
