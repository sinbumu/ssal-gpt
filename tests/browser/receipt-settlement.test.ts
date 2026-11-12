import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings } from '../../src/autonomy.js';
import { Browser } from '../../src/browser.js';
import type { Job } from '../../src/store.js';
import { captureReceipt, verifyReceipt, watchSubmissionDialogs } from '../../src/receipt.js';

for (const scenario of [
  'late-analytics-navigation',
  'late-rejection',
  'missing-response',
] as const) {
  test(`receipt settlement: ${scenario} after initial drain, no repeated POST`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssal-settlement-'));
    const app = await createApp({ dir, port: 0, headless: true });
    app.scheduler.stop();
    let submissions = 0;
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = createServer(async (req, res) => {
      req.resume();
      if (req.url === '/demo/save') {
        submissions++;
        if (scenario === 'missing-response') await delayed;
        res.writeHead(302, { location: '/demo/result', 'content-type': 'text/html' });
        res.end();
      } else if (req.url === '/demo/later') {
        await delayed;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"message":"접수 처리 오류입니다."}');
      } else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          req.url === '/demo/result'
            ? '<h1>등록되었습니다.</h1>'
            : '<form method="post" action="/demo/save"><input name="answer" value="fixture"><button>제출</button></form>',
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const url = origin + '/demo/settlement';
    const browser = new Browser(dir, origin, true);
    const event = app.store.record(
      {
        title: '가상 리디렉션 설문',
        organizer: 'fixture',
        entryUrl: url,
        deadline: '2099-01-01T00:00:00Z',
        prize: '가상',
        winners: 1,
        requirements: ['설문'],
        blockers: [],
        evidenceQuote: '가상',
        evidenceKind: 'text',
        effortMinutes: 1,
      },
      url,
      'fixture',
      'fixture.png',
    ).event;
    const job: Job = {
      id: randomUUID(),
      eventId: event.id,
      kind: 'apply',
      provider: { kind: 'api', model: 'fixture' },
      goal: 'fixture',
      startUrl: url,
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
      allowedOrigins: [origin],
      approvedTexts: [],
      history: [],
      autonomy: createAutonomy(syntheticSettings, origin),
    };
    try {
      app.store.claimSubmission(event.id, job.id);
      await browser.open();
      browser.ownerJobId = job.id;
      await browser.navigate(url);
      const before = await browser.observe(true);
      job.uncertain = true;
      job.intent = { kind: 'submission', url, beforeText: before.text, at: Date.now() };
      app.store.saveJob(job);
      const watcher = await watchSubmissionDialogs(app.store, browser, job, origin + '/demo/save', [
        'fixture',
        'second',
      ]);
      const page = browser.page!;
      const model = {
        decide: async () => {
          throw new Error('no model needed');
        },
      } as any;
      try {
        await page.getByRole('button', { name: '제출' }).click({ noWaitAfter: true });
        await watcher.settle(new AbortController().signal);
        if (scenario === 'missing-response') {
          assert.equal(
            job.receiptCapture?.settled,
            false,
            'a bound request still awaiting a response is incomplete',
          );
          captureReceipt(job, {
            ...before,
            text: '등록되었습니다.',
            capturedAt: Date.now(),
          } as any);
          assert.equal(
            await verifyReceipt(app.store, browser, model, job, new AbortController().signal, true),
            false,
          );
          assert.equal(job.receiptCheck?.captureIncomplete, true);
          assert.equal(job.receiptCheck?.outcome, 'unconfirmed');
          release();
        } else {
          assert.equal(job.receiptCapture?.settled, true);
          if (scenario === 'late-analytics-navigation') {
            await page.evaluate(async () => {
              await fetch('/demo/analytics', { method: 'POST', body: 'view' });
              history.pushState({}, '', '#result');
            });
            await new Promise((r) => setTimeout(r, 30));
            assert.equal(
              job.receiptCapture?.settled,
              true,
              'late rejected request/navigation must not poison settled state',
            );
          } else {
            const sent = page.waitForRequest((r) => r.url().endsWith('/later'));
            await page.evaluate(() => {
              void fetch('/demo/later', {
                method: 'POST',
                body: 'answer=fixture&other=second',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
              });
            });
            await sent;
            await new Promise((r) => setTimeout(r, 30));
            assert.equal(
              job.receiptCapture?.settled,
              false,
              'a second matched response must still be awaited',
            );
            release();
          }
        }
        await page.waitForURL('**/demo/result*');
        captureReceipt(job, await browser.observe(true));
        await watcher.settle(new AbortController().signal);
      } finally {
        watcher.close();
      }
      assert.equal(job.receiptCapture?.lifecycle, 'closed');
      assert.equal(job.receiptCapture?.settled, true);
      const closedCapture = JSON.stringify(job.receiptCapture);
      await page.evaluate(async () => {
        await fetch('/demo/analytics', { method: 'POST', body: 'view' });
      });
      assert.equal(
        JSON.stringify(job.receiptCapture),
        closedCapture,
        'closed evidence is immutable',
      );
      const accepted = await verifyReceipt(
        app.store,
        browser,
        model,
        job,
        new AbortController().signal,
        true,
      );
      assert.equal(
        accepted,
        scenario !== 'late-rejection',
        JSON.stringify({ check: job.receiptCheck, observations: job.receiptObservations }),
      );
      if (scenario === 'late-rejection') assert.equal(job.receiptCheck?.outcome, 'conflict');
      assert.equal(submissions, 1);
    } finally {
      release();
      await browser.close();
      await app.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
