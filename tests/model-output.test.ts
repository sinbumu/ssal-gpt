import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Auth } from '../src/auth.js';
import { Model, parseModelOutput } from '../src/model.js';
import { ModelOutputError } from '../src/model-output.js';
import { Store, type Job } from '../src/store.js';
import { meteredModel, usage, OperationsSchema } from '../src/operations.js';

const step = { action: 'done', observationId: 'observation', reason: 'synthetic' };
const call = (args: unknown = step) => ({
  type: 'function_call',
  name: 'step',
  namespace: 'ssal_browser',
  arguments: JSON.stringify(args),
});
const response = (output: unknown[]) => ({ output, usage: { input_tokens: 12, output_tokens: 3 } });

test('response validation distinguishes count, name, namespace, JSON, fields and refusal without storing provider content', () => {
  const cases = [
    {
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'private-text' }] }],
      reason: 'call_count',
    },
    { output: [call(), call()], reason: 'call_count' },
    { output: [{ ...call(), name: 'private-tool-name' }], reason: 'function_name' },
    { output: [{ ...call(), namespace: 'private-namespace' }], reason: 'namespace' },
    { output: [{ ...call(), arguments: '{private-json' }], reason: 'arguments_json' },
    {
      output: [call({ ...step, delta: 1001, 'private-field-name': 'private-value' })],
      reason: 'arguments_schema',
    },
    {
      output: [
        { type: 'message', content: [{ type: 'refusal', refusal: 'private-refusal' }] },
        call(),
      ],
      reason: 'refusal',
    },
  ];
  for (const c of cases)
    assert.throws(
      () => parseModelOutput(response(c.output), 123),
      (error: unknown) => {
        assert.ok(error instanceof ModelOutputError);
        assert.equal(error.details.reason, c.reason);
        assert.equal(error.retryable, c.reason !== 'refusal');
        assert.equal(error.elapsedMs, 123);
        assert.deepEqual(error.usage, { inputTokens: 12, outputTokens: 3 });
        assert.ok(!JSON.stringify(error).includes('private-'));
        if (c.reason === 'arguments_schema') {
          assert.ok(
            error.details.issues?.some((i) => i.path.join('.') === 'delta' && i.code === 'too_big'),
          );
          assert.ok(error.details.issues?.some((i) => i.code === 'unrecognized_keys'));
        }
        return true;
      },
    );
  for (const tool of [
    call(),
    { ...call(), namespace: undefined },
    { ...call(), name: 'ssal_browser.step' },
  ]) {
    assert.deepEqual(
      parseModelOutput(response([{ type: 'reasoning', summary: ['private-reasoning'] }, tool]), 10)
        .step,
      step,
    );
  }
});

test('real SSE model boundary preserves invalid response usage, and missing usage stays unreported', async (t) => {
  let withUsage = true;
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [], ...(withUsage ? { usage: { input_tokens: 17, output_tokens: 4 } } : {}) } })}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
  );
  const model = new Model({ bearer: async () => 'synthetic' } as unknown as Auth);
  const dir = mkdtempSync(join(tmpdir(), 'ssal-output-'));
  const store = new Store(dir);
  try {
    store.setSettings(
      'operations',
      OperationsSchema.parse({
        dailyTokens: 100,
        rates: [{ model: 'synthetic', inputPerMillion: 1, outputPerMillion: 2 }],
      }),
    );
    const job = { id: 'synthetic', inputTokens: 0, outputTokens: 0 } as Job;
    const metered = meteredModel(store, model, job);
    const args = [
      { kind: 'api' as const, model: 'synthetic' },
      'test',
      {},
      Buffer.from('image'),
      new AbortController().signal,
    ] as const;
    await assert.rejects(metered.decide(...args), /expected_one_browser_step/);
    assert.equal(usage(store).tokens, 21);
    assert.equal(usage(store).unknown, 0);
    assert.equal(job.inputTokens, 17);
    assert.equal(job.outputTokens, 4);
    assert.equal(job.modelDiagnostics?.[0].reason, 'call_count');
    assert.equal(store.job(job.id)?.modelDiagnostics?.length, 1);
    withUsage = false;
    await assert.rejects(metered.decide(...args));
    assert.equal(usage(store).unknown, 1);
    assert.equal(usage(store).tokens, 21);
    assert.equal(job.modelDiagnostics?.[1].usage, undefined);
    const row = store.db.prepare('SELECT estimated_usd FROM usage WHERE state=?').get('reported')!;
    assert.equal(row.estimated_usd, 25 / 1000000);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stream diagnostics preserve finalized items when the terminal output is empty', async () => {
  const { readSSE } = await import('../src/model.js');
  const events = [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'fc', type: 'function_call' },
    },
    { type: 'response.function_call_arguments.done', arguments: 'private-arguments' },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'fc', ...call() } },
    { type: 'response.completed', response: { status: 'completed', ...response([]) } },
  ];
  const result = await readSSE(
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')),
  );
  const parsed = parseModelOutput(result, 5);
  assert.deepEqual(parsed.step, step);
  assert.deepEqual(parsed.streamRecovery?.details.stream, {
    events: 4,
    itemsAdded: 1,
    itemsDone: 1,
    functionCallsDone: 1,
    argumentsDone: 1,
    completedOutputCount: 0,
    reconstructed: true,
  });
  assert.ok(!JSON.stringify(parsed.streamRecovery).includes('private-'));
});

test('enum repair guidance contains only schema values and survives a later resume without raw arguments', async () => {
  const { schemaIssues, repairFeedback } = await import('../src/model-output.js');
  const issues = schemaIssues([{ code: 'invalid_value', path: ['candidate', 'entryType'] }], {
    properties: {
      candidate: {
        properties: { entryType: { enum: ['survey', 'quiz', 'social', 'mixed', 'other'] } },
      },
    },
  });
  assert.deepEqual(issues[0].expected, ['survey', 'quiz', 'social', 'mixed', 'other']);
  const last = {
    id: 'id',
    at: 1,
    code: 'invalid_action_schema',
    elapsedMs: 1,
    outcome: 'stopped' as const,
    reason: 'arguments_schema' as const,
    outputTypes: ['function_call'],
    callCount: 1,
    functionName: 'step' as const,
    namespace: 'expected' as const,
    issues,
  };
  assert.deepEqual(repairFeedback(last)?.issues, issues);
  assert.equal(repairFeedback({ ...last, outcome: 'recovered' }), undefined);
  assert.equal(
    repairFeedback({ ...last, code: 'model_output_refused', reason: 'refusal' }),
    undefined,
  );
});
