import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store.js';
import { searchPage, observedQuote, type SourceEvidence } from './evidence.js';
import { maskPrivateText } from './private-text.js';
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
    shippingAddress: z.string().trim().max(300).default(''),
    shippingAddressDetail: z.string().trim().max(200).default(''),
    postalCode: z
      .string()
      .trim()
      .regex(/^(?:\d{5})?$/, '우편번호는 비워두거나 5자리 숫자로 입력하세요.')
      .default(''),
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
  reviewDraft?: boolean;
  condition?: { questionId: string; optionId: string };
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
    drafts?: {
      status: 'preparing' | 'ready' | 'partial' | 'unavailable';
      reason?: string;
      at: number;
    };
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
const personal = {
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
  return (Object.keys(personal) as (keyof typeof personal)[]).find((k) =>
    personal[k].test(q.label),
  );
}

function shippingField(q: Question, questions: Question[]) {
  const label = q.label.replace(/\s+/g, ''),
    hint = `${q.label}\n${q.description || ''}`;
  if (/이메일|전자우편|e-?mail|웹|홈페이지|website|url/i.test(label)) return;
  if (!/주소|배송지|수령지|우편번호|address|postal|zip.?code/i.test(label)) return;
  if (
    q.kind !== 'text' ||
    /친구|타인|회사|직장|사업장|행사장|매장|추천인|보호자|예시|설명|의견|friend|company|office|example/i.test(
      hint,
    )
  )
    return 'review';
  if (/시[·/\s]?도|시[·/\s]?군|군[·/\s]?구|읍[·/\s]?면|지역.*(?:만|까지)/.test(hint))
    return 'review';
  if (/우편번호/.test(label) && /주소/.test(label)) return 'review';
  if (/우편번호|postal|zip.?code/i.test(label)) return 'postalCode';
  if (/(?:상세주소|동[·/\s]?호수).*(?:포함|까지)|전체주소/.test(label)) return 'full';
  const otherDetail = questions.some(
    (other) =>
      other.id !== q.id &&
      /(?:상세|나머지)\s*주소|동[·/\s]?호수|address\s*line\s*2/i.test(other.label),
  );
  const otherBase = questions.some(
    (other) =>
      other.id !== q.id && /기본\s*주소|도로명\s*주소|address\s*line\s*1/i.test(other.label),
  );
  if (otherBase && /상세주소|동[·/\s]?호수/i.test(label)) return 'shippingAddressDetail';
  if (/배송|수령|받[을으].*주소|shipping|delivery/i.test(label))
    return otherDetail ? 'shippingAddress' : 'full';
  if (/상세주소|나머지주소|동[·/\s]?호수|addressline2|apartment|suite/i.test(label))
    return 'shippingAddressDetail';
  if (/기본주소|도로명주소|지번주소|addressline1/i.test(label)) return 'shippingAddress';
  const delivery = /배송|(?:경품|상품|물품).*?(?:발송|수령)|shipping|delivery/i;
  // Questions come from one inspected form. Its explicit consent notice may
  // explain a bare address field, but does not itself authorize that consent.
  if (
    delivery.test(q.description || '') ||
    questions.some(
      (other) =>
        consentQuestion(other) && delivery.test(`${other.label}\n${other.description || ''}`),
    )
  )
    return otherDetail ? 'shippingAddress' : 'full';
  return 'review';
}
export function consentQuestion(q: Question) {
  return /동의|약관|마케팅|consent|agree|marketing/i.test(q.label);
}
export function verificationQuestion(q: Question) {
  return /인증\s*문자|보안\s*문자|자동\s*(?:기입|입력)\s*방지|captcha|verification code/i.test(
    `${q.label}\n${q.description || ''}`,
  );
}
// Suggestions are review material, not facts about the participant or a grant
// to enter them. Restrict this path to requests for proposed wording.
export function textDraftEligible(q: Question) {
  const hint = `${q.label}\n${q.description || ''}`;
  return (
    q.kind === 'text' &&
    !consentQuestion(q) &&
    !verificationQuestion(q) &&
    !personalKey(q) &&
    !/주소|배송지|우편번호|계좌|주민등록|정답|퀴즈|실제.{0,12}경험|체험담|구매\s*후기|방문\s*후기|이용\s*후기|사용\s*후기|인증|password|email|phone|address/i.test(
      hint,
    ) &&
    /개선\s*(?:의견|사항)|건의|제안|바라는|바라시는|기대|축하|응원|희망|suggestion|improvement|congratulat/i.test(
      hint,
    )
  );
}
export function reviewDraft(q: Question, plan?: AnswerPlan) {
  if (
    !textDraftEligible(q) ||
    plan?.source !== 'recommendation' ||
    !['preference', 'evaluation'].includes(plan.category)
  )
    return;
  const valid = validateAnswer(q, plan.answer || []);
  if (!valid?.[0]?.trim()) return;
  // Reject obvious invented experiences even as drafts. The planner also must
  // phrase these as future requests, never imply it verified a personal story.
  if (
    /(?:이용|사용|방문|구매|참여)(?:했|하였|해\s*봤|해\s*보았|한\s*적|한\s*경험)|불편했|느꼈|겪었|어려웠|발생했|(?:저는|제가).{0,30}(?:거주|살고|직업)|항상\s*(?:이용|사용)|(?:이용|사용)하고\s*있/.test(
      valid[0],
    )
  )
    return;
  return valid;
}
export function otherTextCondition(q: Question, questions: Question[]) {
  if (q.kind !== 'text' || q.required) return;
  const match = q.label.match(/^(.+) — (?:기타(?:\s*(?:작성|입력|의견))?|other)$/i);
  if (!match) return;
  const parents = questions.filter(
    (parent) =>
      parent.id !== q.id &&
      parent.label === match[1] &&
      ['radio', 'checkbox', 'select'].includes(parent.kind),
  );
  const parent = parents.length === 1 ? parents[0] : undefined;
  const options = parent?.options.filter((o) => /^(기타|other)\s*[:：]?$/i.test(o.label.trim()));
  return parent && options?.length === 1
    ? { questionId: parent.id, optionId: options[0]!.id }
    : undefined;
}
export function validateAnswer(q: Question, answer: string[]): string[] | undefined {
  // Refusal of a mandatory, single-checkbox consent is a valid user decision;
  // the runner stops participation instead of forcing an affirmative answer.
  if (q.kind === 'checkbox' && consentQuestion(q) && answer.length === 0) return [];
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
  questions: Question[] = [],
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
  if (verificationQuestion(q))
    return {
      source:
        '인증문자는 현재 브라우저에서 본인이 확인해 입력해야 합니다. 자동 추론하거나 재사용하지 않습니다.',
    };
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
  const shipping = shippingField(q, questions);
  if (shipping) {
    if (shipping === 'review')
      return {
        source: '주소의 용도·입력 범위를 확인해야 합니다. 배송 주소를 임의로 사용하지 않습니다.',
      };
    const value =
      shipping === 'full'
        ? [state.profile.shippingAddress, state.profile.shippingAddressDetail]
            .filter(Boolean)
            .join(', ')
        : state.profile[shipping];
    const hasBase = shipping !== 'full' || !!state.profile.shippingAddress;
    return { answer: value && hasBase ? validateAnswer(q, [value]) : undefined, source: 'profile' };
  }
  const key = personalKey(q);
  if (key) {
    let value = state.profile[key];
    // Formatting is local and never changes the saved identity. Only honor an
    // explicit instruction beside this field, not arbitrary page-wide text.
    const hint = `${q.label}\n${q.description || ''}`;
    if (key === 'phone' && q.kind === 'text') {
      const digits = value.replace(/[\s-]/g, '');
      if (/^01\d\d{7,8}$/.test(digits)) {
        const part = hint.match(
          /(?:첫\s*번째|첫째|두\s*번째|둘째|세\s*번째|셋째|마지막)\s*([34])자리/,
        );
        if (part) {
          const parts = digits.match(/^(01\d)(\d{3,4})(\d{4})$/)!;
          const index = /첫/.test(part[0]) ? 1 : /두|둘/.test(part[0]) ? 2 : 3;
          if (parts[index]!.length !== Number(part[1]))
            return { source: '전화번호 구간의 길이를 확인해야 합니다.' };
          value = parts[index]!;
        } else if (
          /하이픈.{0,12}(?:제외|없이|빼)|-\s*없이|(?:숫자|번호)만|digits only|without hyphens/i.test(
            hint,
          )
        )
          value = digits;
        else if (/하이픈.{0,12}(?:포함|넣|입력)|with hyphens/i.test(hint))
          value = digits.replace(/^(01\d)(\d{3,4})(\d{4})$/, '$1-$2-$3');
      }
    }
    let answer =
      q.kind === 'text' ? [value] : q.options.filter((o) => o.label === value).map((o) => o.id);
    if (key === 'region' && q.kind !== 'text' && !answer.length) {
      const province = (s: string) =>
        s
          .trim()
          .match(
            /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청북|충청남|전라북|전라남|경상북|경상남|제주)(?:특별자치도|특별자치시|특별시|광역시|도)?$/,
          )?.[1];
      const region = province(value);
      const matches = region ? q.options.filter((o) => province(o.label) === region) : [];
      if (matches.length === 1) answer = [matches[0]!.id];
    }
    return { answer: value ? validateAnswer(q, answer) : undefined, source: 'profile' };
  }
  const exact = saved.find((a) => a.origin === state.origin && a.signature === q.signature);
  if (exact) return { answer: validateAnswer(q, exact.answer), source: 'memory' };
  if (
    state.entryChannel &&
    (/참여\s*경로|유입\s*경로/.test(q.label) ||
      /(?:이벤트|행사|설문|조사).{0,20}(?:알게\s*된\s*경로|어떻게\s*알|접한\s*경로)/.test(q.label))
  ) {
    const channel = state.entryChannel;
    const aliases =
      channel === '인스타그램'
        ? /인스타|instagram/i
        : channel === '네이버'
          ? /네이버|naver/i
          : /구글|google/i;
    const options = q.options.filter(
      (o) => aliases.test(o.label) && !/이용증|회원가입|앱\s*이용|결제/.test(o.label),
    );
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
  const draft = reviewDraft(q, plan);
  if (draft) return { source: 'review_draft', recommendation: draft };
  return { source: 'answer_required' };
}
export function redact(text: string, profile: Profile) {
  return maskPrivateText(text, Object.values(profile));
}
export function redactContext(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') {
    return maskPrivateText(value, secrets);
  }
  if (Array.isArray(value)) return value.map((item) => redactContext(item, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactContext(item, secrets)]),
    );
  return value;
}
