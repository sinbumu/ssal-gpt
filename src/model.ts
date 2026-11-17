import { z } from 'zod';
import { Auth, ServiceError, type ProviderChoice } from './auth.js';
import { AnswerPlanSchema } from './autonomy.js';
import { TaskSpecSchema } from './tasks.js';
import { WinnerNoticeSchema } from './notifications.js';
import { CommentPlanSchema } from './comment-content.js';
import {
  ModelOutputError,
  outputDetails,
  reportedUsage,
  schemaIssues,
  repairFeedback,
  type ModelDiagnostic,
  type StreamSummary,
} from './model-output.js';
const streamSummaries = new WeakMap<object, StreamSummary>();
import { StreamOutput } from './stream-output.js';

export const CandidateSchema = z.object({
  title: z.string().min(1).max(200),
  organizer: z.string().max(120),
  entryUrl: z.string().url(),
  deadline: z.string().datetime({ offset: true }).nullable(),
  deadlineDate: z.string().date().nullable().optional(),
  prize: z.string().max(500),
  winners: z.number().int().positive().nullable(),
  requirements: z.array(z.string().max(300)).max(20),
  blockers: z.array(z.string().max(300)).max(20),
  evidenceQuote: z.string().min(1).max(2000),
  evidenceKind: z.enum(['text', 'image']),
  effortMinutes: z.number().min(1).max(300),
  winnerNotice: WinnerNoticeSchema.optional(),
  entryNeeds: z
    .object({
      personalResponse: z.object({ required: z.boolean(), quote: z.string().max(800) }).optional(),
      registration: z.object({ required: z.boolean(), quote: z.string().max(800) }).optional(),
      logins: z
        .array(z.object({ url: z.string().url(), quote: z.string().min(1).max(800) }))
        .max(10)
        .default([]),
    })
    .optional(),
  announcementDate: z.string().date().nullable().optional(),
  announcementNote: z.string().max(500).optional(),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  selectionMethod: z.enum(['draw', 'first_come', 'judged', 'all', 'unknown']).optional(),
  entryType: z.enum(['survey', 'quiz', 'social', 'mixed', 'other']).optional(),
  eligibility: z
    .array(
      z.object({
        key: z.string().min(1).max(100),
        acceptedValues: z.array(z.string().min(1).max(200)).min(1).max(30),
        quote: z.string().min(1).max(1000),
      }),
    )
    .max(20)
    .optional(),
  tasks: z.array(TaskSpecSchema).max(20).optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;
export const StepSchema = z
  .object({
    action: z.enum([
      'navigate',
      'search',
      'scroll',
      'click',
      'type',
      'key',
      'wait',
      'record_event',
      'skip_source',
      'done',
      'needs_user',
      'form_plan',
      'research',
    ]),
    observationId: z.string().min(1),
    reason: z.string().min(1).max(500),
    memory: z.string().max(6000).optional(),
    ref: z.string().optional(),
    x: z.number().nonnegative().optional(),
    y: z.number().nonnegative().optional(),
    text: z.string().max(8000).optional(),
    url: z.string().url().optional(),
    delta: z.number().min(-1000).max(1000).optional(),
    candidate: CandidateSchema.optional(),
    evidenceQuote: z.string().max(2000).optional(),
    answers: z.array(AnswerPlanSchema).max(80).optional(),
    buttonId: z.string().optional(),
    searchEngine: z.enum(['naver', 'google']).optional(),
    skipCategory: z.enum(['ended', 'requirements', 'access', 'restricted', 'other']).optional(),
    questionId: z.string().optional(),
    resultKind: z.enum(['announced', 'pending', 'unavailable']).optional(),
    receiptKind: z.enum(['accepted', 'already_participated', 'not_confirmed']).optional(),
    draftBasis: z.enum(['source_text', 'source_image', 'inference', 'suggestion']).optional(),
    draftRequirementsMet: z.boolean().optional(),
    commentPlan: CommentPlanSchema.optional(),
    draftScore: z
      .object({ correct: z.number().int().min(0).max(20), total: z.number().int().min(1).max(20) })
      .optional(),
    quizAnswers: z
      .array(
        z.object({
          number: z.number().int().min(1).max(20),
          question: z.string().min(1).max(500),
          answer: z.enum(['O', 'X']),
        }),
      )
      .max(20)
      .optional(),
    quizKey: z
      .array(
        z.object({
          number: z.number().int().min(1).max(20),
          answer: z.enum(['O', 'X']),
          evidenceQuote: z.string().min(1).max(500),
        }),
      )
      .max(20)
      .optional(),
  })
  .strict();
export type Step = z.infer<typeof StepSchema>;
export const modelRepairFeedback = (last?: ModelDiagnostic) =>
  repairFeedback(last, z.toJSONSchema(StepSchema, { target: 'draft-7' }));
export type Inference = {
  step: Step;
  inputTokens: number;
  outputTokens: number;
  requestId?: string;
  streamRecovery?: { details: import('./model-output.js').OutputDetails; elapsedMs: number };
};

export function parseModelOutput(result: any, elapsedMs: number): Inference {
  const details = {
      ...outputDetails(result),
      stream: result && typeof result === 'object' ? streamSummaries.get(result) : undefined,
    },
    usage = reportedUsage(result);
  const output = Array.isArray(result?.output) ? result.output : [];
  const fail = (
    code: ConstructorParameters<typeof ModelOutputError>[0],
    reason: typeof details & { reason: import('./model-output.js').OutputDetails['reason'] },
  ) => {
    throw new ModelOutputError(code, reason, elapsedMs, usage);
  };
  if (details.stream?.invalid)
    fail('invalid_response_output_stream', { ...details, reason: 'stream_structure' });
  if (
    output.some(
      (o: any) =>
        o?.type === 'message' &&
        Array.isArray(o.content) &&
        o.content.some((c: any) => c?.type === 'refusal'),
    )
  )
    fail('model_output_refused', { ...details, reason: 'refusal' });
  if (details.callCount !== 1)
    fail('expected_one_browser_step', { ...details, reason: 'call_count' });
  if (!['step', 'qualified_step'].includes(details.functionName))
    fail('expected_one_browser_step', { ...details, reason: 'function_name' });
  if (details.namespace === 'unexpected')
    fail('expected_one_browser_step', { ...details, reason: 'namespace' });
  const call = output.find((o: any) => o?.type === 'function_call');
  let args: unknown;
  try {
    if (typeof call.arguments !== 'string') throw new Error('not_json_string');
    args = JSON.parse(call.arguments);
  } catch {
    fail('invalid_action_json', { ...details, reason: 'arguments_json' });
  }
  const parsed = StepSchema.safeParse(args);
  if (!parsed.success)
    throw new ModelOutputError(
      'invalid_action_schema',
      {
        ...details,
        reason: 'arguments_schema',
        issues: schemaIssues(
          parsed.error.issues,
          z.toJSONSchema(StepSchema, { target: 'draft-7' }),
        ),
      },
      elapsedMs,
      usage,
    );
  return {
    step: parsed.data,
    inputTokens: usage?.inputTokens || 0,
    outputTokens: usage?.outputTokens || 0,
    streamRecovery: details.stream?.reconstructed
      ? { details: { ...details, reason: 'stream_reconstructed' }, elapsedMs }
      : undefined,
  };
}

export async function readSSE(response: Response) {
  if (!response.body) throw new ServiceError('empty_response_stream', 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed: Record<string, any> | undefined;
  let bytes = 0;
  const items = new StreamOutput();
  let completedCount = 0;
  const stream: StreamSummary = {
    events: 0,
    itemsAdded: 0,
    itemsDone: 0,
    functionCallsDone: 0,
    argumentsDone: 0,
    completedOutputCount: 0,
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 12_000_000) throw new ServiceError('response_stream_too_large', 502);
      buffer += decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') continue;
        let event: any;
        try {
          event = JSON.parse(data);
        } catch {
          throw new ServiceError('invalid_response_stream', 502);
        }
        stream.events++;
        items.observe(event);
        if (event.type === 'response.output_item.added') stream.itemsAdded++;
        if (event.type === 'response.output_item.done') {
          stream.itemsDone++;
          if (event.item?.type === 'function_call') stream.functionCallsDone++;
        }
        if (event.type === 'response.function_call_arguments.done') stream.argumentsDone++;
        if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) {
          const code = event.response?.error?.code || event.error?.code;
          throw new ServiceError(
            typeof code === 'string' && /^[a-z_0-9]{1,120}$/.test(code) ? code : 'inference_failed',
            502,
          );
        }
        if (event.type === 'response.completed') {
          completed = event.response;
          completedCount++;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!completed || completed.status !== 'completed')
    throw new ServiceError('inference_stream_interrupted', 502);
  stream.completedOutputCount = Array.isArray(completed.output) ? completed.output.length : 0;
  const collected = items.finish(completed.output);
  if (completedCount !== 1) stream.invalid = 'conflicting';
  else if (collected.invalid) stream.invalid = collected.invalid;
  else if (collected.reconstructed) {
    completed.output = collected.output;
    stream.reconstructed = true;
  }
  streamSummaries.set(completed, stream);
  return completed;
}

export type ModelClient = Pick<Model, 'decide'>;

export class Model {
  constructor(private auth: Auth) {}
  async models(choice: ProviderChoice) {
    const token = await this.auth.bearer(choice);
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new ServiceError(`models_http_${response.status}`, 502);
    const body = (await response.json()) as any;
    if (choice.kind === 'chatgpt') {
      if (!Array.isArray(body.models)) throw new ServiceError('unexpected_model_catalog', 502);
      return body.models
        .filter((m: any) => m.visibility === 'list')
        .map((m: any) => ({ id: m.slug, name: m.display_name || m.slug }));
    }
    return (body.data || [])
      .filter((m: any) => /^gpt-/.test(m.id) && !/audio|realtime|image|transcribe|tts/.test(m.id))
      .map((m: any) => ({ id: m.id, name: m.id }));
  }
  async decide(
    choice: ProviderChoice,
    instructions: string,
    context: unknown,
    image: Buffer,
    signal: AbortSignal,
  ): Promise<Inference> {
    if (!choice.model) throw new ServiceError('model_required');
    const token = await this.auth.bearer(choice);
    const started = Date.now();
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: choice.model,
        store: false,
        stream: true,
        instructions,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: JSON.stringify(context) },
              {
                type: 'input_image',
                image_url: `data:image/png;base64,${image.toString('base64')}`,
                detail: 'high',
              },
            ],
          },
        ],
        tools: [
          {
            type: 'namespace',
            name: 'ssal_browser',
            description: 'Choose one bounded local browser action.',
            tools: [
              {
                type: 'function',
                name: 'step',
                description:
                  'Select exactly one next action using the current observation. Never invent completion or event facts.',
                strict: false,
                parameters: z.toJSONSchema(StepSchema, { target: 'draft-7' }),
              },
            ],
          },
        ],
        tool_choice: 'required',
        parallel_tool_calls: false,
      }),
    });
    if (!response.ok) {
      let code = `inference_http_${response.status}`;
      try {
        const body = (await response.json()) as any;
        if (typeof body.error?.code === 'string' && /^[a-z_0-9]{1,120}$/.test(body.error.code))
          code = body.error.code;
      } catch {
        /* Ignore untrusted diagnostics. */
      }
      throw new ServiceError(code, 502);
    }
    const result = await readSSE(response);
    return {
      ...parseModelOutput(result, Date.now() - started),
      requestId: response.headers.get('x-request-id') || undefined,
    };
  }
}
