import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store.js';
import { searchPage, observedQuote, type SourceEvidence } from './evidence.js';
import {
  ConsentPolicySchema,
  ConsentAssessmentSchema,
  decideConsent,
  recordConsent,
  userConsentDecision,
  type ConsentAudit,
  type ConsentDecision,
} from './consent.js';

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
    semanticPreferenceReuse: z.boolean().default(false),
    preferenceRule: z.string().max(1500).default(''),
    evaluationRule: z.string().max(1500).default(''),
    singleChoice: z.enum(['ask', 'first']).default('ask'),
    finalSubmit: z.enum(['review', 'auto']).default('review'),
    maxRecoveries: z.number().int().min(0).max(5).default(3),
    consent: ConsentPolicySchema.default(() => ConsentPolicySchema.parse({})),
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
  description?: string;
  kind: 'text' | 'radio' | 'checkbox' | 'select' | 'file' | 'rank';
  picker?: boolean;
  required: boolean;
  options: { id: string; label: string }[];
  multiple: boolean;
  maxChoices?: number;
};
export const AnswerPlanSchema = z
  .object({
    questionId: z.string(),
    category: z.enum(['fact', 'preference', 'evaluation', 'knowledge', 'consent']),
    source: z.enum(['profile', 'memory', 'recommendation', 'evidence', 'unknown']),
    sourceId: z.string().optional(),
    answer: z.array(z.string().max(2000)).max(30).optional(),
    evidenceQuote: z.string().max(1000).optional(),
    reason: z.string().max(300),
    consentAssessment: ConsentAssessmentSchema.optional(),
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
  organizer?: string;
  consents?: ConsentAudit[];
  synthetic?: boolean;
  plan?: { fingerprint: string; answers: AnswerPlan[]; buttonId?: string };
  overrides: Record<string, string[]>;
  reused?: Record<string, string[]>;
  privateAnswers?: string[];
  evidence?: SourceEvidence[];
  entryChannel?: string;
  researched?: string[];
  researchRetries?: number;
  introAdvances?: number;
  inbox?: {
    id: string;
    fingerprint: string;
    items: InboxItem[];
    final?: boolean;
    buttonLabel?: string;
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
  const saved = store.settings<Settings>('autonomy', {
    ...SettingsSchema.parse({ profile: {}, policy: {} }),
    revision: 'initial',
  });
  return {
    ...SettingsSchema.parse({ profile: saved.profile, policy: saved.policy }),
    revision: saved.revision,
  };
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
    policy: PolicySchema.parse(config.policy),
    profile: { ...config.profile },
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
    // The synthetic demo explicitly delegates declining its optional marketing.
    // Real/new settings still default to manual consent review.
    consent: { mode: 'routine' },
  }),
};
const personal: Record<keyof Profile, RegExp> = {
  name: /성명|성함|이름|\bname\b/i,
  email: /이메일|전자우편|\be-?mail\b/i,
  phone: /연락처|전화|휴대|\bphone\b|\bmobile\b/i,
  region: /거주|지역|\bregion\b/i,
  occupation: /직업|\boccupation\b/i,
  ageRange: /연령|나이|age/i,
};
export function personalKey(q: Question) {
  if (
    /친구|타인|추천인|보호자|만족|평가|의견|설명|예시|friend|guardian|referr|opinion|describe|example/i.test(
      q.label,
    )
  )
    return undefined;
  return (Object.keys(personal) as (keyof Profile)[]).find((k) => personal[k].test(q.label));
}
export function consentQuestion(q: Question) {
  return /동의|약관|마케팅|consent|agree|marketing/i.test(q.label);
}
export function validateAnswer(q: Question, answer: string[]): string[] | undefined {
  if (q.kind === 'file')
    return (!q.required && answer.length === 0) ||
      (answer.length === 1 && /^(asset|drive):[a-f0-9-]{36}$/.test(answer[0]!))
      ? answer
      : undefined;
  if (q.kind === 'text')
    return answer.length === 1 && (!q.required || !!answer[0]?.trim()) ? answer : undefined;
  if (q.kind === 'rank' && answer.length !== q.options.length) return undefined;
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
): { answer?: string[]; source: string; recommendation?: string[]; consent?: ConsentDecision } {
  const isConsent = consentQuestion(q) || plan?.category === 'consent';
  const override = state.overrides[q.signature];
  if (q.kind === 'file') {
    const answer = state.overrides[q.id];
    return {
      answer: answer ? validateAnswer(q, answer) : !q.required ? [] : undefined,
      source: answer ? 'user_file' : 'file_required',
    };
  }
  if (override) {
    const answer = validateAnswer(q, override);
    const consent = isConsent && answer ? userConsentDecision(q, answer) : undefined;
    if (consent) recordConsent(state, q, consent, 'user');
    return { answer, source: 'user', consent };
  }
  // Consent has its own grant; recommendations and saved answers cannot grant it.
  if (isConsent) {
    const consent = decideConsent(q, state, plan?.consentAssessment);
    recordConsent(state, q, consent);
    return {
      answer: consent.answer ? validateAnswer(q, consent.answer) : undefined,
      source: consent.reason,
      consent,
    };
  }
  if (state.reused?.[q.signature])
    return { answer: validateAnswer(q, state.reused[q.signature]!), source: 'job_memory' };
  const key = personalKey(q);
  if (key) {
    let value = state.profile[key];
    // Formatting is local and never changes the saved identity. Only honor an
    // explicit instruction beside this field, not arbitrary page-wide text.
    const hint = `${q.label}\n${q.description || ''}`;
    if (key === 'phone' && q.kind === 'text') {
      const digits = value.replace(/[\s-]/g, '');
      if (/^01\d\d{7,8}$/.test(digits)) {
        if (
          /하이픈.{0,12}(?:제외|없이|빼)|-\s*없이|(?:숫자|번호)만|digits only|without hyphens/i.test(
            hint,
          )
        )
          value = digits;
        else if (/하이픈.{0,12}(?:포함|넣|입력)|with hyphens/i.test(hint))
          value = digits.replace(/^(01\d)(\d{3,4})(\d{4})$/, '$1-$2-$3');
      }
    }
    const answer =
      q.kind === 'text' ? [value] : q.options.filter((o) => o.label === value).map((o) => o.id);
    return { answer: value ? validateAnswer(q, answer) : undefined, source: 'profile' };
  }
  const exact = saved.find((a) => a.origin === state.origin && a.signature === q.signature);
  if (exact) return { answer: validateAnswer(q, exact.answer), source: 'memory' };
  if (
    state.entryChannel &&
    /참여\s*경로|알게\s*된\s*경로|어떻게\s*알|접한\s*경로|유입\s*경로/.test(q.label)
  ) {
    const channel = state.entryChannel;
    const aliases =
      channel === '인스타그램'
        ? /인스타|instagram/i
        : channel === '네이버'
          ? /네이버|naver/i
          : /구글|google/i;
    const options = q.options.filter((o) => aliases.test(o.label));
    const answer =
      q.kind === 'text' ? [channel] : options.length === 1 ? [options[0]!.id] : undefined;
    if (answer) return { answer: validateAnswer(q, answer), source: 'observed_entry_channel' };
  }
  if (!plan) return { source: 'missing_plan' };
  const factual =
    /이름|성명|이메일|전화번호|연락처|이용한|사용한|경험|구매|방문한|회원|가입|횟수|빈도|자격|성별|생년|have you|how often|previously|eligib|email|phone|friend/i.test(
      q.label,
    );
  if (plan.source === 'memory') {
    const memory = saved.find((a) => a.id === plan.sourceId && a.origin === state.origin);
    const negative = /않|싫|제외|비선호|원하지|\bnot\b|least|dislike|avoid|except/i;
    // Facts require an exact question/options match. Semantic reuse is preference-only.
    if (
      state.policy.semanticPreferenceReuse &&
      !factual &&
      memory &&
      memory.category === 'preference' &&
      plan.category === 'preference' &&
      negative.test(q.label) === negative.test(memory.question)
    ) {
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
  if (plan.source === 'evidence' && plan.category === 'knowledge' && !factual && valid) {
    const source = state.evidence?.find((s) => s.id === plan.sourceId);
    if (
      source &&
      !searchPage(source.url) &&
      plan.evidenceQuote &&
      observedQuote(source.text, plan.evidenceQuote)
    )
      return { answer: valid, source: 'observed_public_evidence' };
  }
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
export function redactContext(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') {
    for (const secret of secrets.filter((s) => s.length >= 2)) {
      value = (value as string).split(secret).join('[저장된 정보]');
      value = (value as string).split(encodeURIComponent(secret)).join('[저장된 정보]');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactContext(item, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactContext(item, secrets)]),
    );
  return value;
}
