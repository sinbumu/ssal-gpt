import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../../src/server.js';
import { Runner } from '../../src/runner.js';
import { parseModelOutput, type ModelClient } from '../../src/model.js';
import { ServiceError } from '../../src/auth.js';
import { OperationsSchema, usage } from '../../src/operations.js';
import type { Job } from '../../src/store.js';

async function fixture(
  run: (app: Awaited<ReturnType<typeof createApp>>, job: Job) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-output-browser-'));
  const app = await createApp({ dir, port: 0, headless: true });
  const job: Job = {
    id: randomUUID(),
    kind: 'discover',
    goal: 'synthetic',
    provider: { kind: 'api', model: 'synthetic' },
    startUrl: app.origin + '/demo/event',
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    candidateLimit: 1,
    maxSteps: 10,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    note: '',
    uncertain: false,
    allowedOrigins: [app.origin],
    approvedTexts: [],
    history: [],
  };
  app.store.saveJob(job);
  try {
    await run(app, job);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const output = (args?: unknown) => ({
  output:
    args === undefined
      ? []
      : [
          {
            type: 'function_call',
            name: 'step',
            namespace: 'ssal_browser',
            arguments: JSON.stringify(args),
          },
        ],
  usage: { input_tokens: 10, output_tokens: 2 },
});

test('discovery repairs format errors with fresh observations, meters all requests and renders diagnostic fields', async () =>
  fixture(async (app, job) => {
    const observations: string[] = [];
    let actions = 0;
    app.browser.act = async () => {
      actions++;
      throw new Error('no action expected');
    };
    const model: ModelClient = {
      async decide(_p, _i, ctx: any, image) {
        assert.ok(image.length > 1000);
        observations.push(ctx.observation.id);
        if (observations.length > 1) assert.ok(ctx.modelOutputRepair);
        return parseModelOutput(
          output(
            observations.length === 2
              ? undefined
              : {
                  action: 'done',
                  observationId: ctx.observation.id,
                  reason: 'synthetic',
                  ...(observations.length === 1 ? { delta: 1001 } : {}),
                },
          ),
          30,
        );
      },
    };
    const runner = new Runner(app.store, app.browser, model, app.origin);
    runner.start(job.id);
    await runner.finished();
    const saved = app.store.job(job.id)!;
    assert.equal(saved.status, 'completed');
    assert.equal(saved.steps, 1);
    assert.equal(saved.modelFormatRetries, 2);
    assert.deepEqual(
      saved.modelDiagnostics?.map((d) => d.outcome),
      ['stopped', 'recovered'],
    );
    assert.equal(new Set(observations).size, 3);
    assert.equal(actions, 0);
    assert.equal(usage(app.store).calls, 3);
    assert.equal(usage(app.store).tokens, 36);
    assert.equal(saved.inputTokens + saved.outputTokens, 36);
    assert.deepEqual(
      saved.readTraces?.slice(0, 2).map((t) => t.status),
      ['failed', 'failed'],
    );
    const trace = JSON.parse(
      readFileSync(join(app.store.dir, 'evidence', observations[0] + '.read.json'), 'utf8'),
    );
    assert.equal(trace.details.validation.issues[0].path[0], 'delta');
    const dashboard = await chromium.launch({ headless: true });
    try {
      const page = await dashboard.newPage();
      await page.goto(app.origin + '/#runs');
      await page.locator('#runs > details > summary').click();
      await page.locator('.model-diagnostics summary').first().waitFor();
      await page.locator('.model-diagnostics summary').first().click();
      const text = await page.locator('.model-diagnostics').first().innerText();
      assert.match(text, /2\/2/);
      assert.match(text, /delta/);
      assert.match(text, /재요청 응답 검증 통과/);
    } finally {
      await dashboard.close();
    }
  }));

test('format retry cap survives resume and no browser action executes for rejected output', async () =>
  fixture(async (app, job) => {
    let calls = 0;
    const runner = new Runner(
      app.store,
      app.browser,
      {
        async decide() {
          calls++;
          return parseModelOutput(output(), 10);
        },
      },
      app.origin,
    );
    runner.start(job.id);
    await runner.finished();
    assert.equal(calls, 3);
    assert.equal(app.store.job(job.id)!.status, 'failed');
    assert.equal(app.store.job(job.id)!.modelFormatRetries, 2);
    runner.start(job.id);
    await runner.finished();
    assert.equal(calls, 4);
    assert.equal(app.store.job(job.id)!.steps, 0);
    assert.equal(app.store.job(job.id)!.modelFormatRetries, 2);
  }));

for (const scenario of [
  'daily_call',
  'daily_token',
  'job_call',
  'job_token',
  'refusal',
  'http',
  'abort',
  'uncertain',
] as const) {
  test(`format recovery does not exceed limits or retry ${scenario}`, async () =>
    fixture(async (app, job) => {
      if (scenario === 'daily_call')
        app.store.setSettings('operations', OperationsSchema.parse({ dailyCalls: 1 }));
      if (scenario === 'daily_token')
        app.store.setSettings('operations', OperationsSchema.parse({ dailyTokens: 12 }));
      if (scenario === 'job_call') {
        const { selection } = await import('../../src/selection.js');
        app.store.setSettings('selectionPolicy', { ...selection(app.store), discoveryCalls: 5 });
        for (let i = 0; i < 4; i++)
          app.store.db
            .prepare('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?)')
            .run(randomUUID(), '2020-01-01', job.id, 0, 0, null, 'reported', Date.now());
      }
      if (scenario === 'job_token') {
        const { selection } = await import('../../src/selection.js');
        app.store.setSettings('selectionPolicy', { ...selection(app.store), discoveryTokens: 12 });
      }
      if (scenario === 'uncertain') {
        job.uncertain = true;
        app.store.saveJob(job);
      }
      let calls = 0;
      const runner = new Runner(
        app.store,
        app.browser,
        {
          async decide(_p, _i, _ctx, _image, signal) {
            calls++;
            if (scenario === 'http') throw new ServiceError('inference_http_429', 502);
            if (scenario === 'abort') {
              throw new DOMException('synthetic cancellation', 'AbortError');
              signal.throwIfAborted();
            }
            if (scenario === 'refusal')
              return parseModelOutput(
                {
                  ...output(),
                  output: [
                    { type: 'message', content: [{ type: 'refusal', refusal: 'synthetic' }] },
                  ],
                },
                10,
              );
            return parseModelOutput(output(), 10);
          },
        },
        app.origin,
      );
      runner.start(job.id);
      await runner.finished();
      assert.equal(calls, 1);
      assert.equal(app.store.job(job.id)!.modelFormatRetries || 0, 0);
      assert.equal(app.store.job(job.id)!.steps, 0);
    }));
}

test('user pause during inference stops without a format retry', { timeout: 10000 }, async () =>
  fixture(async (app, job) => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const runner = new Runner(
      app.store,
      app.browser,
      {
        async decide(_p, _i, _ctx, _image, signal) {
          calls++;
          entered();
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          );
          throw new Error('not reached');
        },
      },
      app.origin,
    );
    runner.start(job.id);
    await started;
    await runner.pause(job.id);
    await runner.finished();
    assert.equal(calls, 1);
    assert.equal(app.store.job(job.id)!.status, 'paused');
    assert.equal(app.store.job(job.id)!.modelFormatRetries || 0, 0);
  }),
);

test('an execution failure with the same code never enters model format recovery', async () =>
  fixture(async (app, job) => {
    let calls = 0,
      actions = 0;
    app.browser.act = async () => {
      actions++;
      throw new ServiceError('invalid_action_schema');
    };
    const runner = new Runner(
      app.store,
      app.browser,
      {
        async decide(_p, _i, ctx: any) {
          calls++;
          return parseModelOutput(
            output({
              action: 'scroll',
              observationId: ctx.observation.id,
              reason: 'synthetic',
              delta: 300,
            }),
            10,
          );
        },
      },
      app.origin,
    );
    runner.start(job.id);
    await runner.finished();
    assert.equal(calls, 1);
    assert.equal(actions, 1);
    assert.equal(app.store.job(job.id)!.modelFormatRetries || 0, 0);
    assert.equal(app.store.job(job.id)!.stopReason?.phase, 'action');
  }));
