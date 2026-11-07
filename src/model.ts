import { z } from 'zod';
import { Auth, ServiceError, type ProviderChoice } from './auth.js';

export const CandidateSchema = z.object({
  title: z.string().min(1).max(200),
  organizer: z.string().max(120),
  entryUrl: z.string().url(),
  deadline: z.string().datetime({ offset: true }).nullable(),
  prize: z.string().max(500),
  winners: z.number().int().positive().nullable(),
  requirements: z.array(z.string().max(300)).max(20),
  blockers: z.array(z.string().max(300)).max(20),
  evidenceQuote: z.string().min(1).max(2000),
  evidenceKind: z.enum(['text', 'image']),
  effortMinutes: z.number().min(1).max(300),
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
      'done',
      'needs_user',
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
  })
  .strict();
export type Step = z.infer<typeof StepSchema>;
export type Inference = {
  step: Step;
  inputTokens: number;
  outputTokens: number;
  requestId?: string;
};

export async function readSSE(response: Response) {
  if (!response.body) throw new ServiceError('empty_response_stream', 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed: Record<string, any> | undefined;
  let bytes = 0;
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
        if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) {
          const code = event.response?.error?.code || event.error?.code;
          throw new ServiceError(
            typeof code === 'string' && /^[a-z_0-9]{1,120}$/.test(code) ? code : 'inference_failed',
            502,
          );
        }
        if (event.type === 'response.completed') completed = event.response;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!completed || completed.status !== 'completed')
    throw new ServiceError('inference_stream_interrupted', 502);
  return completed;
}

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
    const calls = (result.output || []).filter((o: any) => o.type === 'function_call');
    if (
      calls.length !== 1 ||
      !['step', 'ssal_browser.step'].includes(calls[0].name) ||
      (calls[0].namespace && calls[0].namespace !== 'ssal_browser')
    ) {
      throw new ServiceError('expected_one_browser_step', 502);
    }
    let args: unknown;
    try {
      args = JSON.parse(calls[0].arguments);
    } catch {
      throw new ServiceError('invalid_action_json', 502);
    }
    const parsed = StepSchema.safeParse(args);
    if (!parsed.success) throw new ServiceError('invalid_action_schema', 502);
    return {
      step: parsed.data,
      inputTokens: result.usage?.input_tokens || 0,
      outputTokens: result.usage?.output_tokens || 0,
      requestId: response.headers.get('x-request-id') || undefined,
    };
  }
}
