import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings, hash } from '../../src/autonomy.js';
import type { Job } from '../../src/store.js';
import { captureReceipt, verifyReceipt, watchSubmissionDialogs } from '../../src/receipt.js';

for (const scenario of [
  'json',
  'created',
  'error',
  'duplicate',
  'pending',
  'unknown-code',
  'semantic',
  'conflicting-alert',
  'conflicting-page',
  'unrelated',
  'oversize',
  'malformed',
  'delayed',
] as const) {
  test(`POST response ${scenario}: bounded capture, combined receipt verification, no repeated submit/model`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssal-response-'));
    const app = await createApp({ dir, port: 0, headless: true });
    app.scheduler.stop();
    let posts = 0,
      calls = 0;
    const event = app.store.record(
      {
        title: '가상 응답 확인 이벤트',
        organizer: 'fixture',
        entryUrl: app.origin + '/demo/response',
        deadline: '2099-01-01T00:00:00Z',
        prize: '가상 경품',
        winners: 1,
        requirements: ['가상 폼'],
        blockers: [],
        evidenceQuote: '가상',
        evidenceKind: 'text',
        effortMinutes: 1,
      },
      app.origin + '/demo/response',
      'fixture',
      'fixture.png',
    ).event;
    const j: Job = {
      id: randomUUID(),
      eventId: event.id,
      kind: 'apply',
      provider: { kind: 'api', model: 'fixture' },
      goal: 'response fixture',
      startUrl: app.origin + '/demo/response',
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
      allowedOrigins: [app.origin],
      approvedTexts: [],
      history: [],
      autonomy: createAutonomy(syntheticSettings, app.origin),
    };
    try {
      app.store.claimSubmission(event.id, j.id);
      await app.browser.open();
      app.browser.ownerJobId = j.id;
      app.browser.page!.on('dialog', (d) => void d.dismiss());
      await app.browser.context!.route(app.origin + '/demo/**', async (r) => {
        if (r.request().method() === 'POST') {
          posts++;
          if (scenario === 'delayed') await new Promise((resolve) => setTimeout(resolve, 600));
          const data =
            scenario === 'error'
              ? { code: 'E100', message: '인증문자 오류입니다.' }
              : scenario === 'duplicate'
                ? { code: 'DUP', message: '이미 이번호 이벤트에 참여하셨습니다.' }
                : scenario === 'pending'
                  ? { status: 'processing' }
                  : scenario === 'unknown-code'
                    ? { code: '0000', success: true, message: '확인 감사합니다.' }
                    : scenario === 'semantic'
                      ? { message: '보내주신 응답을 잘 받았어요.' }
                      : scenario === 'created'
                        ? { receipt_number: 'R-42' }
                        : { code: '0000', msg: '이벤트에 참여 되었습니다.', receipt_no: 'R-42' };
          await r.fulfill({
            status: scenario === 'created' ? 201 : scenario === 'pending' ? 202 : 200,
            contentType: 'application/json',
            body:
              scenario === 'oversize'
                ? 'x'.repeat(70000)
                : scenario === 'malformed'
                  ? '{bad'
                  : JSON.stringify(data),
          });
        } else
          await r.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<h1>가상 응모</h1><button id="send">제출</button><script>document.querySelector('#send').onclick=()=>fetch('/demo/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(scenario === 'unrelated' ? { analytics: 'view' } : { name: syntheticSettings.profile.name, phone: syntheticSettings.profile.phone })})}).then(r=>r.json()).then(()=>{${scenario === 'conflicting-alert' ? "alert('처리 오류가 발생했습니다.');" : scenario === 'conflicting-page' ? "document.body.innerHTML='<h1>응모 처리 오류입니다.</h1>';" : ''}})</script>`,
          });
      });
      await app.browser.navigate(j.startUrl);
      const before = await app.browser.observe(true, Object.values(syntheticSettings.profile));
      j.screenshot = before.screenshot;
      j.uncertain = true;
      j.transmitted = true;
      j.intent = { kind: 'submission', url: j.startUrl, beforeText: before.text, at: Date.now() };
      app.store.saveJob(j);
      const watcher = await watchSubmissionDialogs(app.store, app.browser, j, '', [
        syntheticSettings.profile.name,
        syntheticSettings.profile.phone,
      ]);
      try {
        await app.browser.page!.locator('#send').click();
        await watcher.settle(new AbortController().signal);
      } finally {
        watcher.close();
      }
      captureReceipt(j, await app.browser.observe(true, Object.values(syntheticSettings.profile)));
      app.store.saveJob(j);
      const model = {
        decide: async (_p: any, _i: any, ctx: any) => {
          calls++;
          assert.equal(ctx.purpose, 'verify_receipt');
          assert.ok(!JSON.stringify(ctx).includes(syntheticSettings.profile.phone));
          return {
            step: {
              observationId: ctx.observation.id,
              action: scenario === 'semantic' ? 'done' : 'needs_user',
              receiptKind: scenario === 'semantic' ? 'accepted' : 'not_confirmed',
              evidenceQuote: scenario === 'semantic' ? '보내주신 응답을 잘 받았어요.' : undefined,
              reason: '가상 의미 검토',
            },
            inputTokens: 10,
            outputTokens: 5,
          };
        },
      } as any;
      const accepted = ['json', 'created', 'semantic', 'delayed'].includes(scenario);
      assert.equal(
        await verifyReceipt(app.store, app.browser, model, j, new AbortController().signal, true),
        accepted,
        j.receiptCheck?.reason,
      );
      const expected = {
        error: 'rejected',
        duplicate: 'existing',
        pending: 'pending',
        'conflicting-alert': 'conflict',
        'conflicting-page': 'conflict',
      }[scenario];
      if (expected) assert.equal(j.receiptCheck?.outcome, expected);
      if (accepted) {
        assert.equal(j.status, 'completed');
        assert.equal(j.receiptCheck?.method, scenario === 'semantic' ? 'ai' : 'rules');
        if (scenario !== 'semantic') assert.equal(calls, 0);
      } else {
        const prior = calls;
        await verifyReceipt(app.store, app.browser, model, j, new AbortController().signal, false);
        await verifyReceipt(app.store, app.browser, model, j, new AbortController().signal, true);
        assert.equal(calls, prior, 'unchanged evidence must not call AI again');
      }
      if (scenario === 'unknown-code') assert.equal(calls, 1);
      if (scenario === 'unrelated') assert.equal(j.receiptResponses?.length || 0, 0);
      if (scenario === 'oversize') assert.equal(j.receiptResponses?.[0].bodyState, 'too_large');
      if (scenario === 'malformed') assert.equal(j.receiptResponses?.[0].bodyState, 'unavailable');
      assert.equal(posts, 1);
      const state = await fetch(app.origin + '/api/state').then((r) => r.json());
      const publicJob = state.jobs.find((job: any) => job.id === j.id);
      assert.equal(publicJob.receiptResponses, undefined);
      assert.equal(publicJob.receiptCheck.outcome, j.receiptCheck?.outcome);
      // Persisted response verification requires no browser and rejects stale intent.
      if (scenario === 'json') {
        const ui = await chromium.launch({ headless: true });
        try {
          const page = await ui.newPage();
          const errors: string[] = [];
          page.on('pageerror', (e) => errors.push(e.message));
          await page.goto(app.origin);
          await page.locator('#completed-entries .receipt-check').waitFor({ state: 'attached' });
          const card = await page.locator('#completed-entries').textContent();
          assert.match(card || '', /응답 코드: 0000/);
          assert.match(card || '', /접수번호: R-42/);
          assert.match(card || '', /제출 응답에서 접수 완료 확인/);
          assert.equal(await page.locator('#completed-entries pre').count(), 0);
          assert.deepEqual(errors, []);
        } finally {
          await ui.close();
        }
        const saved = app.store.job(j.id)!;
        saved.uncertain = true;
        saved.status = 'submission_unknown';
        await app.browser.close();
        assert.equal(
          await verifyReceipt(app.store, app.browser, model, saved, new AbortController().signal),
          true,
        );
        saved.uncertain = true;
        saved.intent = { ...saved.intent!, at: saved.intent!.at! + 100000 };
        assert.notEqual(hash(saved.intent), saved.receiptResponses?.[0].intentHash);
        assert.equal(
          await verifyReceipt(app.store, app.browser, model, saved, new AbortController().signal),
          false,
        );
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
