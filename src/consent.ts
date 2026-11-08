import { z } from 'zod';
import type { AutonomyState, Question } from './autonomy.js';

export const ConsentPolicySchema = z
  .object({
    mode: z.enum(['manual', 'routine', 'adaptive']).default('manual'),
    fields: z
      .array(z.enum(['name', 'email', 'phone', 'region', 'occupation', 'ageRange']))
      .max(6)
      .default(['name', 'email', 'phone']),
    extraFields: z
      .array(z.enum(['nickname', 'interest', 'entryChannel']))
      .max(3)
      .default(['nickname', 'interest', 'entryChannel']),
    maxRetentionDays: z.number().int().min(1).max(366).default(31),
    allowThirdParty: z.boolean().default(false),
    recipients: z.array(z.string().trim().min(2).max(120)).max(20).default([]),
    declineOptional: z.boolean().default(true),
    blockedRequired: z.enum(['ask', 'skip']).default('ask'),
  })
  .strict();
export type ConsentPolicy = z.infer<typeof ConsentPolicySchema>;
export const ConsentAssessmentSchema = z
  .object({
    risk: z.enum(['low', 'uncertain', 'high']),
    noticeQuote: z.string().min(1).max(10000),
    reason: z.string().min(1).max(400),
  })
  .strict();
export type ConsentAssessment = z.infer<typeof ConsentAssessmentSchema>;
export type ConsentDecision = {
  decision: 'accept' | 'decline' | 'ask' | 'skip';
  reason: string;
  answer?: string[];
  fields?: string[];
  purpose?: string;
  recipient?: string;
  retention?: string;
  retentionDays?: number;
  thirdParty?: boolean;
};
export type ConsentAudit = Omit<ConsentDecision, 'answer'> & {
  signature: string;
  question: string;
  notice: string;
  mode: ConsentPolicy['mode'];
  revision: string;
  origin: string;
  at: string;
  actor: 'user' | 'policy';
  appliedAt?: string;
};
const compact = (s: string) => s.replace(/\s+/g, ' ').trim();
const identity = (s: string) => s.replace(/[\s.,()㈜]/g, '').toLocaleLowerCase();
const fieldNames: Record<string, RegExp> = {
  name: /성명|성함|이름/gi,
  email: /이메일(?:주소)?|전자우편(?:주소)?|e-?mail/gi,
  phone: /휴대(?:전화|폰)(?:번호)?|전화번호|연락처/gi,
  region: /거주지역|거주지(?:역)?|지역/gi,
  occupation: /직업/gi,
  ageRange: /연령대|나이대/gi,
  nickname: /닉네임|별명/gi,
  interest: /관심분야|관심사|선호분야/gi,
  entryChannel: /참여경로|유입경로/gi,
};
// Section labels, not model-supplied field/recipient claims, delimit the scope.
const headings = [
  [
    'items',
    '(?:수집\\s*(?:및\\s*이용)?\\s*(?:하는)?\\s*(?:개인정보)?\\s*항목|개인정보\\s*항목|제공\\s*(?:하는)?\\s*항목)',
  ],
  [
    'purpose',
    '(?:(?:개인정보\\s*)?수집\\s*(?:및\\s*이용)?\\s*목적|제공받는\\s*자(?:의)?\\s*이용\\s*목적|이용\\s*목적)',
  ],
  [
    'retention',
    '(?:(?:제공받는\\s*자(?:의)?\\s*)?(?:개인정보\\s*)?보유\\s*(?:및\\s*이용)?\\s*기간|보관\\s*기간)',
  ],
  ['recipient', '(?:제공받는\\s*자(?!의)|제공\\s*대상|수집\\s*기관|수신자)'],
].map(([key, pattern]) => ({ key: key!, pattern: pattern! }));
function noticeSections(q: Question) {
  let text = compact(q.description || '');
  // UI option labels are not part of the last retention/recipient section.
  for (const option of [...q.options].sort((a, b) => b.label.length - a.label.length))
    text = text.split(option.label).join(' ');
  const re = new RegExp(headings.map((h) => `(${h.pattern})`).join('|'), 'gi');
  const matches = [...text.matchAll(re)];
  const sections: Record<string, string[]> = {};
  matches.forEach((match, i) => {
    const key = headings.find((h) => new RegExp(`^(?:${h.pattern})$`, 'i').test(match[0]))?.key;
    if (!key) return;
    const value = text
      .slice(match.index! + match[0].length, matches[i + 1]?.index ?? text.length)
      .replace(/^[\s:：-]+|[\s.。;]+$/g, '')
      .trim();
    (sections[key] ||= []).push(value);
  });
  // Conflicting/duplicate notices require review, not choosing a favorable one.
  return Object.fromEntries(
    Object.entries(sections)
      .filter(([, values]) => values.length === 1)
      .map(([key, values]) => [key, values[0]!]),
  );
}
function consentAnswer(q: Question, accept: boolean) {
  if (q.kind === 'text' || q.kind === 'select') return;
  const yes = /^(?:동의(?:합니다|함)?|안내에\s*동의하고\s*진행|예|네|yes|agree|i agree)$/i;
  const no = /^(?:동의하지\s*않(?:습니다|음)|미동의|거부|아니[요오]|no|disagree|i do not agree)$/i;
  const options = q.options.filter((o) => (accept ? yes : no).test(o.label.trim()));
  if (options.length === 1) return [options[0]!.id];
  if (!accept && !q.required && q.kind === 'checkbox') return [];
}
export function decideConsent(
  q: Question,
  state: AutonomyState,
  assessment?: ConsentAssessment,
): ConsentDecision {
  const policy = ConsentPolicySchema.parse(state.policy.consent || {});
  const ask = (reason: string): ConsentDecision => ({ decision: 'ask', reason });
  if (policy.mode === 'manual') return ask('모든 동의를 직접 확인하도록 설정되어 있습니다.');
  const blocked = (reason: string): ConsentDecision => {
    if (!q.required && policy.declineOptional) {
      const answer = consentAnswer(q, false);
      return answer
        ? { decision: 'decline', reason, answer }
        : ask(`${reason} 거부 선택지를 정확히 연결하지 못했습니다.`);
    }
    return { decision: policy.blockedRequired === 'skip' ? 'skip' : 'ask', reason };
  };
  if (!q.required && policy.declineOptional) return blocked('선택 동의는 거부하도록 위임했습니다.');
  const notice = `${q.label}\n${q.description || ''}`;
  if (
    /약관|계약|마케팅|광고|홍보|판매|국외|해외\s*이전|무기한|영구|탈퇴\s*시|철회\s*시|주민등록|여권|신분증|계좌|신용카드|비밀번호|민감정보|건강정보|진료정보|정치|종교|생체|위치정보|초상권|저작권|password|passport|marketing|advertis|credit.?card|bank.account|payment|sensitive|biometric|precise.location|terms|contract|indefinite/i.test(
      notice,
    )
  )
    return blocked('마케팅·계약·민감정보 등 자동 동의 범위 밖의 내용이 있습니다.');
  const s = noticeSections(q);
  if (!s.items || !s.purpose || !s.retention)
    return ask('항목·목적·보관 기간을 구분해 확인할 수 없습니다.');
  let remainder = s.items.replace(/\s+/g, '');
  const fields: string[] = [];
  for (const [key, pattern] of Object.entries(fieldNames)) {
    pattern.lastIndex = 0;
    if (pattern.test(remainder)) {
      fields.push(key);
      remainder = remainder.replace(pattern, '');
    }
  }
  remainder = remainder.replace(/[,，·ㆍ/()및와과.]+/g, '');
  if (!fields.length || remainder)
    return blocked('허용 항목에 대응하지 않는 개인정보가 포함되어 있습니다.');
  const allowed = new Set<string>([
    ...policy.fields,
    ...(policy.mode === 'adaptive' ? policy.extraFields : []),
  ]);
  if (fields.some((key) => !allowed.has(key)))
    return blocked('설정에서 허용하지 않은 정보 항목입니다.');
  if (
    policy.mode === 'routine' &&
    fields.some((key) => !state.profile[key as keyof typeof state.profile])
  )
    return ask('통상 동의는 프로필에 실제로 저장된 정보 항목에만 적용합니다.');
  if (
    !/이벤트|응모|경품|당첨|참여자/.test(s.purpose) ||
    !/확인|안내|발송|추첨|운영|선정|배송|연락/.test(s.purpose) ||
    /기타|포괄|활용|연구|분석|통계/.test(s.purpose)
  )
    return blocked('응모 운영·경품 안내 이외의 이용 목적이거나 목적이 불명확합니다.');
  const thirdParty =
    /제\s*3\s*자|제삼자|third.party|제공받는\s*자|제공\s*대상|제공하는\s*항목/i.test(notice);
  const recipient = s.recipient || (!thirdParty ? state.organizer : undefined);
  if (!recipient) return ask('실제 정보를 받는 주체가 확인되지 않았습니다.');
  if (thirdParty && !policy.allowThirdParty)
    return blocked('제3자 제공 자동 동의를 허용하지 않았습니다.');
  if (
    ![state.organizer || '', ...policy.recipients]
      .filter(Boolean)
      .some((v) => identity(v) === identity(recipient))
  )
    return blocked('선택한 주최자나 명시적으로 허용한 수신자가 아닙니다.');
  const durations = [...s.retention.matchAll(/(\d+)\s*(일|개월|개\s*월|월|년)/g)];
  // Reject ambiguous retention and alternatives instead of taking the shortest duration.
  if (durations.length !== 1 || /또는|까지|별도|법령|연장|이상|약\s*\d/.test(s.retention))
    return ask('보관 기간의 상한을 명확히 확인할 수 없습니다.');
  if (
    !/^(?:(?:당첨자?\s*(?:발표|선정)|이벤트\s*(?:종료|마감)|경품\s*(?:발송|제공)|동의\s*(?:시점|일)|수집일|응모일|참여일)\s*(?:후|부터)\s*)?\d+\s*(?:일|개월|개\s*월|월|년)\s*(?:간\s*)?(?:(?:보관|보유)\s*)?(?:후\s*(?:파기|폐기|삭제))?$/.test(
      s.retention,
    )
  )
    return ask('보관 안내에 추가 조건이 있어 직접 확인이 필요합니다.');
  const retentionDays =
    Number(durations[0]![1]) *
    (durations[0]![2] === '일' ? 1 : durations[0]![2] === '년' ? 366 : 31);
  if (retentionDays > policy.maxRetentionDays)
    return blocked(`보관 기간이 허용한 ${policy.maxRetentionDays}일을 초과합니다.`);
  if (
    policy.mode === 'adaptive' &&
    (!assessment ||
      assessment.risk !== 'low' ||
      compact(assessment.noticeQuote) !== compact(q.description || q.label))
  )
    return ask('전체 동의 안내에 근거한 에이전트의 낮은 위험 판단이 필요합니다.');
  const answer = consentAnswer(q, true);
  if (!answer) return ask('동의 선택지를 정확히 연결하지 못했습니다.');
  return {
    decision: 'accept',
    answer,
    fields,
    purpose: s.purpose,
    recipient,
    retention: s.retention,
    retentionDays,
    thirdParty,
    reason:
      policy.mode === 'adaptive'
        ? `허용 범위 확인 및 에이전트 판단: ${assessment!.reason}`
        : '허용한 항목·목적·수신자·보관 기간 조건을 충족합니다.',
  };
}

export function recordConsent(
  state: AutonomyState,
  q: Question,
  decision: ConsentDecision,
  actor: ConsentAudit['actor'] = 'policy',
) {
  const { answer: _answer, ...summary } = decision;
  const row: ConsentAudit = {
    ...summary,
    signature: q.signature,
    question: q.label,
    notice: q.description || q.label,
    mode: ConsentPolicySchema.parse(state.policy.consent || {}).mode,
    revision: state.revision,
    origin: state.origin,
    at: new Date().toISOString(),
    actor,
  };
  state.consents = [
    ...(state.consents || []).filter(
      (c) => !(c.signature === q.signature && c.revision === state.revision),
    ),
    row,
  ].slice(-100);
}

export function userConsentDecision(q: Question, answer: string[]): ConsentDecision {
  const selected =
    q.kind === 'text' ? answer : q.options.filter((o) => answer.includes(o.id)).map((o) => o.label);
  const accept =
    answer.length > 0 &&
    !selected.some((label) =>
      /동의\s*하지|미동의|거부|아니[요오]|^no$|disagree|do not agree/i.test(label),
    );
  return {
    decision: accept ? 'accept' : 'decline',
    reason: '사용자가 확인함에서 직접 선택했습니다.',
  };
}
