import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Auth } from '../src/auth.js';
import { Model, StepSchema, parseModelOutput, stepToolParameters } from '../src/model.js';
import { fromToolArguments, strictToolSchema } from '../src/model-schema.js';
import { eventType } from '../src/selection.js';

const candidate = {
  title: 'Synthetic quiz',
  organizer: 'Synthetic',
  entryUrl: 'https://example.invalid/quiz',
  deadline: null,
  prize: 'Synthetic prize',
  winners: null,
  requirements: ['퀴즈 정답 제출'],
  blockers: [],
  evidenceQuote: '퀴즈 정답 제출',
  evidenceKind: 'text',
  effortMinutes: 3,
};
const domain = z.toJSONSchema(StepSchema, { target: 'draft-7' });
const parse = (args: unknown) =>
  parseModelOutput(
    {
      output: [
        {
          type: 'function_call',
          name: 'step',
          arguments: JSON.stringify(args),
        },
      ],
    },
    1,
  ).step;
const base = { action: 'record_event', observationId: 'current', reason: 'Record observed facts' };

test('wire schema recursively requires every field, closes objects and preserves enum constraints', () => {
  let objects = 0;
  function visit(s: any) {
    assert.equal(s.$schema, undefined);
    assert.equal(s.default, undefined);
    assert.notEqual(s.format, 'uri');
    if (s.type === 'object') {
      objects++;
      assert.equal(s.additionalProperties, false);
      assert.deepEqual(s.required, Object.keys(s.properties));
      Object.values(s.properties).forEach(visit);
    }
    if (s.items) visit(s.items);
    s.anyOf?.forEach(visit);
  }
  visit(stepToolParameters);
  assert.equal(objects, 19);
  const entry = stepToolParameters.properties.candidate.anyOf[0].properties.entryType;
  assert.deepEqual(entry.anyOf[0].enum, ['survey', 'quiz', 'social', 'mixed', 'other']);
  assert.deepEqual(entry.anyOf[1], { type: 'null' });
  assert.match(entry.anyOf[0].description, /not a literal site label/);
  assert.throws(
    () => strictToolSchema({ type: 'object', additionalProperties: true }),
    /unsupported/,
  );
});

test('entryType null is absent, all five enums survive, and invalid values are never guessed or dropped', () => {
  for (const entryType of ['survey', 'quiz', 'social', 'mixed', 'other'])
    assert.equal(
      parse({ ...base, candidate: { ...candidate, entryType } }).candidate?.entryType,
      entryType,
    );
  const result = parse({ ...base, candidate: { ...candidate, entryType: null, startsAt: null } });
  assert.equal(Object.hasOwn(result.candidate!, 'entryType'), false);
  assert.equal(result.candidate!.startsAt, null);
  assert.equal(result.candidate!.deadline, null);
  assert.equal(eventType(result.candidate!), 'quiz'); // Existing classification/exclusion path remains.
  for (const entryType of ['form', '퀴즈', 'unknown', '', 1, {}, []])
    assert.throws(
      () => parse({ ...base, candidate: { ...candidate, entryType } }),
      /invalid_action_schema/,
    );
  assert.throws(
    () => parse({ ...base, candidate: { ...candidate, entryUrl: 'not a URL' } }),
    /invalid_action_schema/,
  );
});

test('null adaptation preserves required fields, explicit nulls, unknown keys, unions and local bounds', () => {
  const result = parse({
    action: 'form_plan',
    observationId: 'current',
    reason: 'Plan',
    candidate: null,
    buttonId: null,
    answers: [
      {
        questionId: 'q1',
        category: 'knowledge',
        source: 'unknown',
        reason: 'No evidence',
        sourceId: null,
        answer: null,
        evidenceQuote: null,
        consentAssessment: null,
      },
    ],
  });
  assert.equal(Object.hasOwn(result, 'candidate'), false);
  assert.equal(Object.hasOwn(result, 'buttonId'), false);
  assert.equal(Object.hasOwn(result.answers![0], 'answer'), false);
  for (const bad of [
    { ...base, reason: null },
    { ...base, action: null },
    { ...base, delta: 1001 },
    { ...base, unknown: null },
    { ...base, reason: 'x'.repeat(501) },
    { ...base, candidate: { ...candidate, title: null } },
    { ...base, answers: [null] },
  ])
    assert.throws(() => parse(bad), /invalid_action_schema/);
  const plan = {
    parts: [{ text: 'Answer: ' }, { inputId: 'preference', prefix: '', suffix: '.' }],
    inputs: [{ id: 'preference', label: 'Choice', kind: 'text', options: [] }],
  };
  assert.deepEqual(parse({ ...base, commentPlan: plan }).commentPlan, plan);
  assert.deepEqual(fromToolArguments({ ...base, ref: null }, domain), base);
});

test('actual request sends strict schema; nullable tool arguments return a validated local action', async (t) => {
  const wire = Object.fromEntries(Object.keys(stepToolParameters.properties).map((k) => [k, null]));
  Object.assign(wire, { action: 'done', observationId: 'fresh', reason: 'Finished' });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    assert.equal(request.tools[0].tools[0].strict, true);
    assert.deepEqual(request.tools[0].tools[0].parameters, stepToolParameters);
    assert.equal(request.parallel_tool_calls, false);
    assert.equal(request.store, false);
    assert.equal(request.previous_response_id, undefined);
    return new Response(
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [
            {
              type: 'function_call',
              name: 'step',
              namespace: 'ssal_browser',
              arguments: JSON.stringify(wire),
            },
          ],
          usage: { input_tokens: 20, output_tokens: 10 },
        },
      })}\n\n`,
    );
  });
  const model = new Model({ bearer: async () => 'synthetic' } as unknown as Auth);
  const result = await model.decide(
    { kind: 'api_key', model: 'synthetic' },
    'Test',
    {},
    Buffer.from('image'),
    new AbortController().signal,
  );
  assert.deepEqual(result.step, { action: 'done', observationId: 'fresh', reason: 'Finished' });
  assert.equal(result.inputTokens, 20);
  assert.equal(result.outputTokens, 10);
});
