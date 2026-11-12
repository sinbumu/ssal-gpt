import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Browser } from '../../src/browser.js';
import { createApp } from '../../src/server.js';
import { discoveryState } from '../../src/discovery.js';
import { Runner } from '../../src/runner.js';
import type { Job } from '../../src/store.js';
import type { ModelClient } from '../../src/model.js';
import type { ObservationDiagnostic } from '../../src/job-notice.js';

async function fixture(
  run: (
    browser: Browser,
    rows: ObservationDiagnostic[],
    controller: AbortController,
    visits: string[],
  ) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-observe-recovery-'));
  const browser = new Browser(dir, undefined, true);
  const rows: ObservationDiagnostic[] = [],
    controller = new AbortController(),
    visits: string[] = [];
  try {
    await browser.open();
    browser.setManual(false);
    browser.setReadOnlyMode(true);
    browser.observationContext = { signal: controller.signal, report: (d) => rows.push(d) };
    await browser.context!.route('https://example.org/**', async (r) => {
      visits.push(r.request().method() + ' ' + r.request().url());
      assert.equal(r.request().method(), 'GET');
      await r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<h1>${new URL(r.request().url()).pathname}</h1><a href="/destination">Read source</a>`,
      });
    });
    await browser.navigate('https://example.org/before');
    await run(browser, rows, controller, visits);
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('actual navigation during screenshot discards mixed observation and reads the same tab again', async () =>
  fixture(async (browser, rows, _c, visits) => {
    const page = browser.page!,
      screenshot = page.screenshot.bind(page);
    let first = true;
    page.screenshot = async (options) => {
      if (first) {
        first = false;
        await page.goto('https://example.org/after');
      }
      return screenshot(options);
    };
    const o = await browser.observe();
    assert.equal(o.url, 'https://example.org/after');
    assert.match(o.text, /after/);
    assert.doesNotMatch(o.text, /before/);
    assert.deepEqual(
      rows.map((r) => r.outcome),
      ['retrying', 'recovered'],
    );
    assert.equal(rows[0].code, 'observation_navigation_changed');
    assert.equal(rows[0].stage, 'finalize');
    assert.equal(visits.length, 2, 'recovery does not reload or navigate');
    await browser.assertFresh(o.id, 'navigate');
  }));

test('real execution context destruction during observation recovers without replaying an action', async () =>
  fixture(async (browser, rows) => {
    const page = browser.page!,
      evaluate = page.evaluate.bind(page);
    let first = true;
    page.evaluate = (async (...args: any[]) => {
      if (first) {
        first = false;
        let started!: () => void;
        const ready = new Promise<void>((r) => (started = r));
        await page.exposeFunction('evaluationStarted', started);
        const result = evaluate(async () => {
          await (window as any).evaluationStarted();
          return new Promise((r) => setTimeout(r, 10_000));
        });
        const rejected = assert.rejects(result, /Execution context was destroyed/);
        await ready;
        await page.goto('https://example.org/after');
        await rejected;
        // Preserve the actual Playwright exception for the production handler.
        return result;
      }
      return (evaluate as any)(...args);
    }) as typeof page.evaluate;
    const o = await browser.observe();
    assert.match(o.url, /after$/);
    assert.equal(rows[0].code, 'observation_navigation_changed');
    assert.equal(rows.at(-1)?.outcome, 'recovered');
  }));

test('continuously redirecting document stops after exactly two retries; abort interrupts the wait', async () => {
  await fixture(async (browser, rows, _c, visits) => {
    const page = browser.page!,
      screenshot = page.screenshot.bind(page);
    let n = 0;
    page.screenshot = async (options) => {
      await page.goto('https://example.org/change-' + ++n);
      return screenshot(options);
    };
    await assert.rejects(browser.observe(), { code: 'browser_observation_unstable' });
    assert.deepEqual(
      rows.map((r) => r.outcome),
      ['retrying', 'retrying', 'stopped'],
    );
    assert.equal(visits.length, 4);
    await assert.rejects(browser.assertFresh('old', 'click'), { code: 'stale_observation' });
  });
  await fixture(async (browser, rows, controller, visits) => {
    await browser.page!.evaluate(() => document.body.remove());
    browser.observationContext!.report = (d) => {
      rows.push(d);
      controller.abort();
    };
    await assert.rejects(browser.observe(), { name: 'AbortError' });
    assert.equal(rows.length, 1);
    assert.equal(visits.length, 1);
  });
});

test('login and closed tab are not treated as transient navigation failures', async () =>
  fixture(async (browser, rows) => {
    await browser.navigate('https://example.org/login');
    await assert.rejects(browser.observe(), { code: 'needs_login_manual' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'stopped');
    await browser.navigate('https://example.org/before');
    const page = browser.page!,
      screenshot = page.screenshot.bind(page);
    page.screenshot = async (options) => {
      const image = await screenshot(options);
      await page.close();
      return image;
    };
    await assert.rejects(browser.observe(), { code: 'browser_closed' });
    assert.equal(rows.length, 2);
    assert.equal(rows[1].code, 'browser_closed');
  }));

test('runner skips an unstable read source and continues inside the original decision budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-run-recovery-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  try {
    await app.browser.open();
    await app.browser.context!.route('**/*', (r) => r.abort());
    await app.browser.context!.route('https://example.org/**', (r) =>
      r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<h1>Public source</h1><a href="/event-unstable">이벤트 1</a><a href="/event-stable">이벤트 2</a>',
      }),
    );
    const page = app.browser.page!,
      screenshot = page.screenshot.bind(page);
    page.screenshot = async (options) => {
      if (page.url().includes('/event-unstable')) await page.reload();
      return screenshot(options);
    };
    const j: Job = {
      id: randomUUID(),
      kind: 'discover',
      goal: 'fixture',
      provider: { kind: 'api', model: 'fixture' },
      startUrl: 'https://example.org/start',
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      candidateLimit: 1,
      maxSteps: 3,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      note: '',
      uncertain: false,
      allowedOrigins: ['https://example.org'],
      approvedTexts: [],
      history: [],
    };
    discoveryState(j).blockedEngines = ['google', 'naver'];
    let calls = 0;
    const model: ModelClient = {
      async decide(_p, _i, ctx: any) {
        calls++;
        return {
          step: {
            observationId: ctx.observation.id,
            action: calls === 1 ? 'navigate' : 'done',
            url: calls === 1 ? 'https://example.org/event-unstable' : undefined,
            reason: 'fixture',
          },
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };
    app.store.saveJob(j);
    const runner = new Runner(app.store, app.browser, model, app.origin);
    runner.start(j.id);
    await runner.finished();
    const result = app.store.job(j.id)!;
    assert.equal(result.status, 'completed');
    assert.equal(result.maxSteps, 3);
    assert.equal(calls, 2, 'observation recovery consumes no extra model calls');
    assert.equal(result.discovery?.switches, 1);
    assert.equal(result.currentUrl, 'https://example.org/event-stable');
    assert.equal(result.observationDiagnostics?.filter((d) => d.outcome === 'retrying').length, 2);
    assert.equal(result.observationDiagnostics?.at(-1)?.outcome, 'stopped');
    assert.equal(result.stopReason, undefined);
    assert.equal(app.browser.observationContext, undefined);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
