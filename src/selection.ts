import { z } from 'zod';
import { ServiceError } from './auth.js';
import { deadlineState, scoreCandidate, type EventRecord, type Job, type Store } from './store.js';
import { observedQuote } from './evidence.js';
import { settings, type Profile } from './autonomy.js';

export const SelectionSchema = z
  .object({
    facts: z
      .array(z.object({ key: z.string().min(1).max(100), value: z.string().min(1).max(200) }))
      .max(40)
      .default([]),
    preferredPrizes: z
      .array(z.string().min(1).max(80))
      .max(20)
      .default(['커피', '상품권', '기프티콘']),
    excludedTypes: z.array(z.enum(['survey', 'quiz', 'social', 'mixed', 'other'])).default([]),
    maxMinutes: z.number().min(1).max(120).default(8),
    maxQuestions: z.number().int().min(1).max(200).default(40),
    maxCalls: z.number().int().min(1).max(300).default(60),
    maxSwitches: z.number().int().min(0).max(5).default(2),
    switchOnBurden: z.boolean().default(true),
  })
  .strict();
export const selection = (store: Store) =>
  SelectionSchema.parse(store.settings('selectionPolicy', {}));
export function eventType(e: Pick<EventRecord, 'requirements' | 'entryType'>) {
  if (e.entryType) return e.entryType;
  const text = e.requirements.join(' ');
  const social = /댓글|팔로우|좋아요|구독/.test(text);
  return social
    ? /폼|설문|퀴즈/.test(text)
      ? 'mixed'
      : 'social'
    : /퀴즈|OX/.test(text)
      ? 'quiz'
      : /설문|조사/.test(text)
        ? 'survey'
        : 'other';
}
const PROFILE_QUALIFICATION_KEYS: Record<string, keyof Profile> = {
  거주지역: 'region',
  지역: 'region',
  region: 'region',
  연령대: 'ageRange',
  ageRange: 'ageRange',
  직업: 'occupation',
  occupation: 'occupation',
};

// A saved Korean province establishes domestic residence, never nationality or a narrower district.
function domesticRegion(value: string, acceptedValues: string[], quote: string) {
  return (
    acceptedValues.some((v) => ['대한민국', '한국'].includes(v.trim())) &&
    /국내|대한민국|한국/.test(quote) &&
    /^(?:대한민국|한국|서울(?:특별시)?|부산(?:광역시)?|대구(?:광역시)?|인천(?:광역시)?|광주(?:광역시)?|대전(?:광역시)?|울산(?:광역시)?|세종(?:특별자치시)?|경기(?:도)?|강원(?:도|특별자치도)?|충청북도|충북|충청남도|충남|전북(?:특별자치도)?|전라북도|전라남도|전남|경상북도|경북|경상남도|경남|제주(?:도|특별자치도)?)(?:\s|$)/.test(
      value.trim(),
    )
  );
}
export function evaluateCandidate(store: Store, e: EventRecord, now = Date.now()) {
  const p = selection(store),
    reasons: string[] = [];
  let state: 'eligible' | 'excluded' | 'review' = 'eligible';
  const reject = (reason: string, review = false) => {
    reasons.push(reason);
    if (state !== 'excluded') state = review ? 'review' : 'excluded';
  };
  if (deadlineState(e, now) !== 'available') reject('접수 가능 기간 확인 필요', true);
  if (e.startsAt && Date.parse(e.startsAt) > now) reject('아직 접수 시작 전');
  if (e.blockers.length) reject(e.blockers.join(' / '), true);
  if (p.excludedTypes.includes(eventType(e))) reject('제외한 과제 유형');
  if (e.effortMinutes > p.maxMinutes) reject('예상 시간이 설정 상한을 초과');
  for (const condition of e.eligibility || []) {
    if (!e.sourceEvidence?.some((s) => observedQuote(s.text, condition.quote))) {
      reject(`자격 원문 확인 필요: ${condition.key}`, true);
      continue;
    }
    const profileKey = PROFILE_QUALIFICATION_KEYS[condition.key];
    const savedValue = profileKey ? settings(store).profile[profileKey] : undefined;
    const fact =
      p.facts.find((f) => f.key === condition.key) ||
      (profileKey
        ? p.facts.find((f) => PROFILE_QUALIFICATION_KEYS[f.key] === profileKey)
        : undefined) ||
      (savedValue ? { key: condition.key, value: savedValue } : undefined);
    if (!fact) reject(`저장하지 않은 자격: ${condition.key}`, true);
    else if (!condition.acceptedValues.includes(fact.value)) {
      if (
        profileKey === 'region' &&
        domesticRegion(fact.value, condition.acceptedValues, condition.quote)
      )
        reasons.push('저장된 거주지역으로 국내 범위를 확인');
      else reject(`자격 불일치: ${condition.key}`);
    }
  }
  const preferred = p.preferredPrizes.filter((v) => e.prize.includes(v));
  if (preferred.length) reasons.push(`선호 경품: ${preferred.join(', ')}`);
  return {
    state,
    reasons,
    type: eventType(e),
    score:
      state === 'eligible'
        ? scoreCandidate(e, now).score + preferred.length * 10 - e.effortMinutes
        : 0,
  };
}

// Stop only before an external transmission. Waiting and human time are not execution time.
export function assessBurden(
  store: Store,
  job: Job,
  segmentStarted: number,
  questionIds: string[] = [],
) {
  if (!job.parentId || job.kind !== 'apply' || job.uncertain || job.transmitted) return;
  const p = selection(store);
  job.seenQuestions = [...new Set([...(job.seenQuestions || []), ...questionIds])];
  const reason =
    job.seenQuestions.length > p.maxQuestions
      ? '실제 문항 수가 설정 상한을 초과'
      : job.steps >= p.maxCalls
        ? '판단 횟수가 설정 상한에 도달'
        : (job.activeMs || 0) + Date.now() - segmentStarted > p.maxMinutes * 60_000
          ? '실제 실행 시간이 설정 상한을 초과'
          : undefined;
  if (reason && p.switchOnBurden) {
    job.switchReason = reason;
    throw new ServiceError('candidate_burden_exceeded');
  }
}

export function nextDiscoveryAfterSkip(store: Store, job: Job) {
  if (
    !job.switchReason ||
    job.uncertain ||
    job.transmitted ||
    job.status !== 'stopped' ||
    !job.parentId
  )
    return;
  const parent = store.job(job.parentId),
    p = selection(store);
  if (
    !parent?.prepareOne ||
    parent.prepareOne.childId !== job.id ||
    !p.switchOnBurden ||
    (parent.prepareOne.switches || 0) >= p.maxSwitches
  )
    return;
  parent.prepareOne.switches = (parent.prepareOne.switches || 0) + 1;
  delete parent.prepareOne.childId;
  store.note(parent.id, `후보 전환: ${job.switchReason}. 기존 응모 잠금은 유지합니다.`);
  store.saveJob(parent);
  return parent;
}

export function switchableFailure(store: Store, job: Job, error: unknown) {
  if (
    !job.parentId ||
    job.transmitted ||
    job.uncertain ||
    !selection(store).switchOnBurden ||
    !(error instanceof ServiceError)
  )
    return false;
  if (
    ![
      'browser_navigation_failed',
      'browser_navigation_timeout',
      'form_structure_changed',
      'field_verification_failed',
      'unsupported_moaform_question',
      'rank_not_changed',
    ].includes(error.code)
  )
    return false;
  job.switchReason = `전송 전 실행 경로 실패: ${error.code}`;
  return true;
}
