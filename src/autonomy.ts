import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store.js';

export const ProfileSchema = z
  .object({
    name: z.string().max(100).default(''),
    email: z.string().max(200).default(''),
    phone: z.string().max(80).default(''),
    region: z.string().max(100).default(''),
    occupation: z.string().max(100).default(''),
    ageRange: z.string().max(100).default(''),
  })
  .strict();
export const PolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    autoRecommendations: z.boolean().default(false),
    preferenceRule: z.string().max(1500).default(''),
    evaluationRule: z.string().max(1500).default(''),
    singleChoice: z.enum(['ask', 'first']).default('ask'),
    finalSubmit: z.enum(['review', 'auto']).default('review'),
    maxRecoveries: z.number().int().min(0).max(5).default(3),
  })
  .strict();
export const SettingsSchema = z.object({ profile: ProfileSchema, policy: PolicySchema }).strict();
export type Settings = z.infer<typeof SettingsSchema> & { revision: string };
export type Profile = z.infer<typeof ProfileSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type Question = {
  id: string;
  signature: string;
  label: string;
  kind: 'text' | 'radio' | 'checkbox' | 'select';
  required: boolean;
  options: { id: string; label: string }[];
  multiple: boolean;
  maxChoices?: number;
};
export const AnswerPlanSchema = z
  .object({
    questionId: z.string(),
    category: z.enum(['fact', 'preference', 'evaluation', 'knowledge', 'consent']),
    source: z.enum(['profile', 'memory', 'recommendation', 'unknown']),
    sourceId: z.string().optional(),
    answer: z.array(z.string().max(2000)).max(30).optional(),
    evidenceQuote: z.string().max(1000).optional(),
    reason: z.string().max(300),
  })
  .strict();
export type AnswerPlan = z.infer<typeof AnswerPlanSchema>;
export type SavedAnswer = {
  id: string;
  signature: string;
  question: string;
  kind: Question['kind'];
  answer: string[];
  origin: string;
  category: AnswerPlan['category'];
  at: string;
};
export type InboxItem = Question & {
  reason: string;
  recommended?: string[];
  category: AnswerPlan['category'];
};
export type AutonomyState = {
  revision: string;
  policy: Policy;
  profile: Profile;
  origin: string;
  expires: number;
  synthetic?: boolean;
  plan?: { fingerprint: string; answers: AnswerPlan[]; buttonId?: string };
  overrides: Record<string, string[]>;
  reused?: Record<string, string[]>;
  privateAnswers?: string[];
  inbox?: {
    id: string;
    fingerprint: string;
    items: InboxItem[];
    final?: boolean;
    review?: unknown;
    createdAt: number;
  };
  finalApproval?: string;
  metrics: {
    modelCalls: number;
    modelMs: number;
    browserMs: number;
    fields: number;
    reused: number;
    batches: number;
    inboxBatches: number;
    recoveries: number;
    startedAt: number;
    waitingMs?: number;
    finishedAt?: number;
  };
};
export function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function settings(store: Store): Settings {
  return store.settings<Settings>('autonomy', {
    ...SettingsSchema.parse({ profile: {}, policy: {} }),
    revision: 'initial',
  });
}
export function memories(store: Store) {
  return store.settings<SavedAnswer[]>('answers', []);
}
export function saveAnswer(store: Store, answer: Omit<SavedAnswer, 'id' | 'at'>) {
  const rows = memories(store).filter(
    (a) => !(a.signature === answer.signature && a.origin === answer.origin),
  );
  const value = { ...answer, id: randomUUID(), at: new Date().toISOString() };
  store.setSettings('answers', [...rows, value].slice(-300));
  return value;
}
export function createAutonomy(config: Settings, origin: string, synthetic = false): AutonomyState {
  return {
    revision: config.revision,
    policy: config.policy,
    profile: config.profile,
    origin,
    synthetic,
    expires: Date.now() + 24 * 60 * 60_000,
    overrides: {},
    metrics: {
      modelCalls: 0,
      modelMs: 0,
      browserMs: 0,
      fields: 0,
      reused: 0,
      batches: 0,
      inboxBatches: 0,
      recoveries: 0,
      startedAt: Date.now(),
    },
  };
}
export const syntheticSettings: Settings = {
  revision: 'synthetic-v1',
  profile: ProfileSchema.parse({
    name: '테스트 참가자',
    email: 'demo@example.invalid',
    phone: '010-0000-0000',
  }),
  policy: PolicySchema.parse({
    enabled: true,
    autoRecommendations: true,
    preferenceRule: '커피, 차 순으로 선호한다. 정보는 포털 검색과 SNS에서 얻는다.',
    evaluationRule: '일반 디자인·편의성 평가는 대체로 긍정, 매우 그렇다로 통일하지 않는다.',
    singleChoice: 'first',
    finalSubmit: 'auto',
  }),
};
const personal: Record<keyof Profile, RegExp> = {
  name: /성명|이름|\bname\b/i,
  email: /이메일|전자우편|\be-?mail\b/i,
  phone: /연락처|전화|휴대|\bphone\b|\bmobile\b/i,
  region: /거주|지역|\bregion\b/i,
  occupation: /직업|\boccupation\b/i,
  ageRange: /연령|나이|age/i,
};
export function personalKey(q: Question) {
  return (Object.keys(personal) as (keyof Profile)[]).find((k) => personal[k].test(q.label));
}
export function consentQuestion(q: Question) {
  return /동의|약관|마케팅|consent|agree|marketing/i.test(q.label);
}
export function validateAnswer(q: Question, answer: string[]): string[] | undefined {
  if (q.kind === 'text')
    return answer.length === 1 && (!q.required || !!answer[0]?.trim()) ? answer : undefined;
  if (!q.multiple && answer.length > 1) return undefined;
  if (q.maxChoices && answer.length > q.maxChoices) return undefined;
  if (q.required && !answer.length) return undefined;
  return answer.every((a) => q.options.some((o) => o.id === a)) &&
    new Set(answer).size === answer.length
    ? answer
    : undefined;
}
export function resolveAnswer(
  q: Question,
  plan: AnswerPlan | undefined,
  state: AutonomyState,
  saved: SavedAnswer[],
  text: string,
): { answer?: string[]; source: string; recommendation?: string[] } {
  const override = state.overrides[q.signature];
  if (override) return { answer: validateAnswer(q, override), source: 'user' };
  // First-time consent is never inferred from a broad recommendation setting.
  if (consentQuestion(q))
    return !q.required && /마케팅|marketing/i.test(q.label)
      ? { answer: [], source: 'optional_marketing_off' }
      : { source: 'consent_required' };
  if (state.reused?.[q.signature])
    return { answer: validateAnswer(q, state.reused[q.signature]!), source: 'job_memory' };
  const key = personalKey(q);
  if (key) {
    const value = state.profile[key];
    const answer =
      q.kind === 'text' ? [value] : q.options.filter((o) => o.label === value).map((o) => o.id);
    return { answer: value ? validateAnswer(q, answer) : undefined, source: 'profile' };
  }
  const exact = saved.find((a) => a.origin === state.origin && a.signature === q.signature);
  if (exact) return { answer: validateAnswer(q, exact.answer), source: 'memory' };
  if (!plan) return { source: 'missing_plan' };
  const factual =
    /이용한|사용한|경험|구매|방문한|회원|가입|횟수|빈도|자격|성별|생년|have you|how often|previously|eligib/i.test(
      q.label,
    );
  if (plan.source === 'memory') {
    const memory = saved.find((a) => a.id === plan.sourceId && a.origin === state.origin);
    // Facts require an exact question/options match. Semantic reuse is preference-only.
    if (!factual && memory && memory.category === 'preference' && plan.category === 'preference') {
      const answer = memory.answer.map(
        (label) => q.options.find((o) => o.id === label || o.label === label)?.id || label,
      );
      return { answer: validateAnswer(q, answer), source: 'semantic_memory' };
    }
  }
  let answer = plan.answer || [];
  if (!q.multiple && answer.length > 1 && state.policy.singleChoice === 'first')
    answer = answer.slice(0, 1);
  const valid = validateAnswer(q, answer);
  const allowed =
    plan.source === 'recommendation' &&
    ((plan.category === 'preference' && !!state.policy.preferenceRule) ||
      (plan.category === 'evaluation' && !!state.policy.evaluationRule) ||
      (plan.category === 'knowledge' && !!plan.evidenceQuote && text.includes(plan.evidenceQuote)));
  // Historical facts/eligibility are not created by the model, even under auto mode.
  if (allowed && !factual && valid)
    return {
      answer: state.policy.autoRecommendations ? valid : undefined,
      recommendation: valid,
      source: 'recommendation',
    };
  return { source: 'answer_required' };
}
export function redact(text: string, profile: Profile) {
  for (const value of Object.values(profile).filter((v) => v.length >= 2))
    text = text.split(value).join('[저장된 정보]');
  return text;
}
