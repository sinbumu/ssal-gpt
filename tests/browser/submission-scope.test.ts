import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { durableResponseReader } from '../../src/response-body.js';
import { chromium } from 'playwright';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings } from '../../src/autonomy.js';
import { watchSubmissionDialogs, captureReceipt, verifyReceipt } from '../../src/receipt.js';
import type { Job } from '../../src/store.js';

for (const scenario of [
  'naver',
  'naver-unavailable',
  'naver-error',
  'naver-duplicate',
  'wrong-survey',
  'missing-answer',
  'unrelated-tab',
  'popup',
  'popup-close-parent',
] as const) {
  test(`submission ownership ${scenario}: first popup/nested provider response, scoped capture and retained diagnostics`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssal-scope-'));
    const app = await createApp({ dir, port: 0, headless: true });
    app.scheduler.stop();
    let posts = 0;
    const popup = scenario.startsWith('popup');
    const url = popup
      ? app.origin + '/demo/popup'
      : 'https://form.naver.com/response/fixtureSurvey';
    const target = popup
      ? app.origin + '/demo/save'
      : `https://survey-api.naver.com/api/form/surveys/${scenario === 'wrong-survey' ? 'anotherSurvey' : 'fixtureSurvey'}/answers`;
    const values = [syntheticSettings.profile.name, syntheticSettings.profile.phone];
    const j: Job = {
      id: randomUUID(),
      kind: 'apply',
      provider: { kind: 'api', model: 'fixture' },
      goal: 'fixture',
      startUrl: url,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      maxSteps: 5,
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
    let watcher: Awaited<ReturnType<typeof watchSubmissionDialogs>> | undefined;
    try {
      await app.browser.open();
      const context = app.browser.context!;
      await context.route('**/*', async (r) => {
        if (r.request().method() === 'POST') {
          posts++;
          await r.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify(
              popup
                ? { message: '응모가 완료되었습니다.', receipt_no: 'POP-42' }
                : scenario === 'naver-error'
                  ? { success: false, error: 'INVALID_PARAM' }
                  : scenario === 'naver-duplicate'
                    ? { success: false, error: 'DUPLICATED' }
                    : { success: true, available: true, surveyStatus: 'IN_PROGRESS' },
            ),
          });
        } else if (r.request().method() === 'OPTIONS')
          await r.fulfill({
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'POST',
              'Access-Control-Allow-Headers': 'Content-Type',
            },
          });
        else
          await r.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: popup
              ? `<h1>가상 응모</h1><form method="post" action="${target}" target="_blank"><input name="name" value="${values[0]}"><input name="phone" value="${values[1]}"><button>제출</button></form>`
              : `<h1>가상 응모</h1><button id="send">제출</button><script>send.onclick=()=>fetch(${JSON.stringify(target)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:${JSON.stringify((scenario === 'missing-answer' ? [values[0]] : values).map((value) => ({ questionId: 1, value })))},taToken:'private-token'})}).then(r=>r.json()).then(()=>{${scenario === 'naver-unavailable' ? 'location.reload()' : ''}})</script>`,
          });
      });
      await app.browser.navigate(url);
      const original = app.browser.page!;
      const extra = scenario === 'unrelated-tab' ? await context.newPage() : undefined;
      if (extra) await extra.goto(url);
      app.browser.page = original;
      app.browser.ownerJobId = j.id;
      const before = await app.browser.observe(true, values);
      j.screenshot = before.screenshot;
      j.uncertain = true;
      j.transmitted = true;
      j.intent = { kind: 'submission', url, beforeText: before.text, at: Date.now() };
      app.store.saveJob(j);
      watcher = await watchSubmissionDialogs(
        app.store,
        app.browser,
        j,
        popup ? target : '',
        values,
      );
      let child;
      if (popup) {
        const created = context.waitForEvent('page');
        await original.locator('button').click();
        child = await created;
        if (scenario === 'popup-close-parent') await original.close();
      } else await (extra || original).locator('#send').click();
      await watcher.settle(new AbortController().signal);
      watcher.close();
      assert.equal(posts, 1);
      const captured = !['wrong-survey', 'missing-answer', 'unrelated-tab'].includes(scenario);
      assert.equal(j.receiptResponses?.length || 0, captured ? 1 : 0);
      if (captured)
        assert.equal(
          j.receiptResponses![0].bodyState,
          scenario === 'naver-unavailable' ? 'unavailable' : 'parsed',
        );
      if (popup) assert.equal(j.receiptCapture?.diagnostics?.popups, 1);
      if (scenario === 'popup-close-parent')
        assert.equal(j.receiptCapture?.diagnostics?.pageClosed, true);
      if (scenario === 'naver-unavailable')
        assert.ok(j.receiptCapture!.diagnostics!.navigations >= 1);
      if (!captured) {
        assert.ok(Object.keys(j.receiptCapture!.diagnostics!.rejected).length);
        return;
      }
      const expected =
        scenario === 'naver-unavailable'
          ? 'unconfirmed'
          : scenario === 'naver-error'
            ? 'rejected'
            : scenario === 'naver-duplicate'
              ? 'existing'
              : 'accepted';
      if (!popup) captureReceipt(j, await app.browser.observe(true, values));
      if (scenario === 'naver') {
        j.taskFormStarted = true;
        j.tasks = [{ id: 'form-fixture', kind: 'form', state: 'pending', url, label: '폼' } as any];
      }
      let calls = 0;
      const model = {
        decide: async () => {
          calls++;
          throw Error('no AI expected');
        },
      } as any;
      assert.equal(
        await verifyReceipt(app.store, app.browser, model, j, new AbortController().signal),
        expected === 'accepted',
      );
      assert.equal(j.receiptCheck?.outcome, expected);
      assert.equal(calls, 0);
      assert.equal(j.receiptCheck!.capture!.responses, 1);
      assert.ok(!JSON.stringify(j.receiptCheck).includes(values[1]));
      assert.ok(!JSON.stringify(j.receiptCheck).includes('private-token'));
      const saved = app.store.job(j.id)!;
      assert.equal(saved.receiptCheck?.capture?.responses, 1);
      if (scenario === 'naver') {
        assert.equal(saved.receiptResponses, undefined);
        assert.equal(saved.receiptCapture, undefined);
        const ui = await chromium.launch({ headless: true });
        try {
          const page = await ui.newPage();
          const errors: string[] = [];
          page.on('pageerror', (e) => errors.push(e.message));
          await page.goto(app.origin);
          await page.locator('.receipt-check').first().waitFor({ state: 'attached' });
          const text = await page.locator('body').textContent();
          assert.match(text || '', /결과 플래그: success=true/);
          assert.match(text || '', /네트워크 수집 진단/);
          assert.match(text || '', /승인 제출과 연결 1개/);
          assert.deepEqual(errors, []);
        } finally {
          await ui.close();
        }
      }
    } finally {
      watcher?.close();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// A fulfilled mock has no durable network body after navigation. Exercise the
// Chromium buffer with a real second HTTP origin, without any external service.
test(
  'real cross-origin response survives reload in the bounded durable reader',
  { timeout: 15000 },
  async () => {
    const front = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>synthetic network fixture</h1>');
    });
    front.listen(0, '127.0.0.1');
    await once(front, 'listening');
    const origin = `http://127.0.0.1:${(front.address() as any).port}`;
    let posts = 0;
    const api = createServer(async (req, res) => {
      for await (const _ of req) {
        /* consume synthetic body */
      }
      posts++;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ success: true }));
    });
    api.listen(0, '127.0.0.1');
    await once(api, 'listening');
    const target = `http://127.0.0.1:${(api.address() as any).port}/save`;
    const browser = await chromium.launch({ headless: true });
    let reader: Awaited<ReturnType<typeof durableResponseReader>> | undefined;
    try {
      const p = await browser.newPage();
      p.setDefaultTimeout(5000);
      await p.goto(origin);
      reader = await durableResponseReader(p, (url) => url === target);
      const request = p.waitForRequest((r) => r.url() === target && r.method() === 'POST');
      const navigation = p.waitForEvent('framenavigated');
      await p.evaluate((target) => {
        void fetch(target, { method: 'POST', body: 'name=synthetic&phone=01000000000' })
          .then((r) => r.json())
          .then(() => location.reload());
      }, target);
      const sent = await request;
      await navigation;
      await p.waitForLoadState();
      const body = await reader.read(sent);
      assert.deepEqual(JSON.parse(body!.toString()), { success: true });
      assert.equal(posts, 1);
    } finally {
      reader?.close();
      await browser.close();
      await new Promise<void>((resolve) => front.close(() => resolve()));
      await new Promise<void>((resolve) => api.close(() => resolve()));
    }
  },
);
