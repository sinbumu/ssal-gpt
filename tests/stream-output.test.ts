import test from 'node:test';
import assert from 'node:assert/strict';
import { readSSE, parseModelOutput } from '../src/model.js';
import { ModelOutputError } from '../src/model-output.js';
const item = {
  id: 'fc_1',
  type: 'function_call',
  call_id: 'call_1',
  name: 'step',
  namespace: 'ssal_browser',
  status: 'completed',
  arguments: JSON.stringify({ action: 'done', observationId: 'obs', reason: 'synthetic' }),
};
const added = {
  type: 'response.output_item.added',
  output_index: 0,
  item: { ...item, status: 'in_progress', arguments: '' },
};
const done = { type: 'response.output_item.done', output_index: 0, item };
const completed = (output: unknown = []) => ({
  type: 'response.completed',
  response: { status: 'completed', output, usage: { input_tokens: 10, output_tokens: 2 } },
});
function stream(events: any[]) {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''));
}

test('terminal output and finalized stream agree; empty terminal uses only complete, ordered items', async () => {
  const normal = parseModelOutput(await readSSE(stream([added, done, completed([item])])), 1);
  assert.equal(normal.step.action, 'done');
  assert.equal(normal.streamRecovery, undefined);
  const recovered = parseModelOutput(await readSSE(stream([added, done, completed()])), 1);
  assert.equal(recovered.step.action, 'done');
  assert.equal(recovered.streamRecovery?.details.stream?.reconstructed, true);
});

test('partial, mismatched, duplicate, missing and conflicting stream items cannot execute', async () => {
  const cases = [
    [added, completed()],
    [done, completed()],
    [added, { ...done, item: { ...item, id: 'wrong' } }, completed()],
    [added, done, done, completed()],
    [{ ...added, output_index: 1 }, { ...done, output_index: 1 }, completed()],
    [added, { ...done, item: { ...item, status: 'incomplete' } }, completed()],
    [added, done, completed([{ ...item, arguments: 'different' }])],
    [added, done, completed(), completed()],
  ];
  for (const events of cases) {
    const result = await readSSE(stream(events));
    assert.throws(
      () => parseModelOutput(result, 5),
      (e: unknown) => {
        assert.ok(e instanceof ModelOutputError);
        assert.equal(e.code, 'invalid_response_output_stream');
        assert.equal(e.retryable, false);
        assert.equal(e.usage?.inputTokens, 10);
        return true;
      },
    );
  }
});

test('stream fallback still rejects multiple actions and refusals; unfinished responses never execute', async () => {
  const second = { ...item, id: 'fc_2', call_id: 'call_2' };
  const events = [
    added,
    done,
    { ...added, output_index: 1, item: second },
    { ...done, output_index: 1, item: second },
    completed(),
  ];
  const awaitedMultiple = await readSSE(stream(events));
  assert.throws(() => parseModelOutput(awaitedMultiple, 1), /expected_one_browser_step/);
  const refusal = {
    id: 'msg',
    type: 'message',
    status: 'completed',
    content: [{ type: 'refusal', refusal: 'private-refusal' }],
  };
  const refused = await readSSE(
    stream([{ ...added, item: refusal }, { ...done, item: refusal }, completed()]),
  );
  assert.throws(() => parseModelOutput(refused, 1), /model_output_refused/);
  await assert.rejects(readSSE(stream([added, done])), /inference_stream_interrupted/);
  await assert.rejects(
    readSSE(
      stream([
        added,
        done,
        { type: 'response.incomplete', response: { error: { code: 'incomplete' } } },
      ]),
    ),
    /incomplete/,
  );
});
