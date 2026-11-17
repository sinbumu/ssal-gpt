import { ServiceError } from './auth.js';

export type StreamSummary = {
  events: number;
  itemsAdded: number;
  itemsDone: number;
  functionCallsDone: number;
  argumentsDone: number;
  completedOutputCount: number;
  reconstructed?: boolean;
  invalid?: 'incomplete' | 'conflicting';
};

export type OutputDetails = {
  reason:
    | 'call_count'
    | 'function_name'
    | 'namespace'
    | 'arguments_json'
    | 'arguments_schema'
    | 'refusal'
    | 'stream_structure'
    | 'stream_reconstructed';
  outputTypes: string[];
  callCount: number;
  functionName: 'missing' | 'step' | 'qualified_step' | 'unexpected';
  namespace: 'missing' | 'expected' | 'unexpected';
  issues?: { code: string; path: (string | number)[]; expected?: string[] }[];
  stream?: StreamSummary;
};
export type ReportedUsage = { inputTokens: number; outputTokens: number };
export type ModelDiagnostic = OutputDetails & {
  id: string;
  at: number;
  code: string;
  elapsedMs: number;
  usage?: ReportedUsage;
  outcome: 'rejected' | 'retrying' | 'recovered' | 'stopped';
};
export class ModelOutputError extends ServiceError {
  constructor(
    code:
      | 'expected_one_browser_step'
      | 'invalid_action_json'
      | 'invalid_action_schema'
      | 'model_output_refused'
      | 'invalid_response_output_stream',
    readonly details: OutputDetails,
    readonly elapsedMs: number,
    readonly usage?: ReportedUsage,
  ) {
    super(code, 502);
  }
  get retryable() {
    return !['model_output_refused', 'invalid_response_output_stream'].includes(this.code);
  }
}

// Keep classifications and schema-owned paths only, never provider text,
// arguments, unknown keys, tool names, URLs, refusal text or reasoning content.
export function outputDetails(result: any): Omit<OutputDetails, 'reason'> {
  const output = Array.isArray(result?.output) ? result.output : [];
  const calls = output.filter((o: any) => o?.type === 'function_call');
  const types = new Set([
    'function_call',
    'message',
    'reasoning',
    'tool_search_call',
    'tool_search_output',
  ]);
  const call = calls[0];
  return {
    outputTypes: [
      ...new Set<string>(output.map((o: any) => (types.has(o?.type) ? o.type : 'other'))),
    ].slice(0, 8),
    callCount: calls.length,
    functionName:
      !call || call.name === undefined
        ? 'missing'
        : call.name === 'step'
          ? 'step'
          : call.name === 'ssal_browser.step'
            ? 'qualified_step'
            : 'unexpected',
    namespace:
      call?.namespace === undefined || call?.namespace === null
        ? 'missing'
        : call.namespace === 'ssal_browser'
          ? 'expected'
          : 'unexpected',
  };
}
export function reportedUsage(result: any): ReportedUsage | undefined {
  const i = result?.usage?.input_tokens,
    o = result?.usage?.output_tokens;
  return Number.isSafeInteger(i) && i >= 0 && Number.isSafeInteger(o) && o >= 0
    ? { inputTokens: i, outputTokens: o }
    : undefined;
}
export function schemaIssues(issues: { code: string; path: PropertyKey[] }[], schema: unknown) {
  const keys = new Set<string>();
  function collect(value: any) {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value.properties || {})) keys.add(key);
    for (const child of Object.values(value)) collect(child);
  }
  collect(schema);
  const codes = new Set([
    'invalid_type',
    'too_big',
    'too_small',
    'invalid_format',
    'not_multiple_of',
    'unrecognized_keys',
    'invalid_union',
    'invalid_key',
    'invalid_element',
    'invalid_value',
    'custom',
  ]);
  return issues.slice(0, 12).map((issue) => {
    let node: any = schema;
    for (const p of issue.path)
      node = typeof p === 'number' ? node?.items : node?.properties?.[String(p)];
    // Expected enum values come from our schema, never from the rejected value.
    const expected =
      issue.code === 'invalid_value' && Array.isArray(node?.enum)
        ? (node.enum.filter((v: unknown) => typeof v === 'string').slice(0, 30) as string[])
        : undefined;
    return {
      code: codes.has(issue.code) ? issue.code : 'other',
      path: issue.path
        .slice(0, 8)
        .map((p) =>
          typeof p === 'number' && Number.isInteger(p) && p >= 0 && p < 10000
            ? p
            : typeof p === 'string' && keys.has(p)
              ? p
              : '<unknown>',
        ),
      expected,
    };
  });
}

export function repairFeedback(
  last?: ModelDiagnostic,
  schema?: unknown,
): OutputDetails | undefined {
  if (
    !last ||
    !['stopped', 'rejected'].includes(last.outcome) ||
    !['expected_one_browser_step', 'invalid_action_json', 'invalid_action_schema'].includes(
      last.code,
    )
  )
    return;
  return {
    reason: last.reason,
    outputTypes: last.outputTypes,
    callCount: last.callCount,
    functionName: last.functionName,
    namespace: last.namespace,
    issues: schema && last.issues ? schemaIssues(last.issues, schema) : last.issues,
  };
}
