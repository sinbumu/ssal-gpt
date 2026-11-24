import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ServiceError } from './auth.js';
import { settings } from './autonomy.js';
import { observedQuote } from './evidence.js';
import { instagramTarget } from './instagram.js';
import { canonicalUrl, type EventRecord, type Store } from './store.js';

const answer = z.enum(['unknown', 'yes', 'no']);
type Answer = z.infer<typeof answer>;
export const QualificationProfileSchema = z
  .object({
    adult: answer.default('unknown'),
    instagram: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^(?:@?[a-z0-9._]{1,30})?$/)
      .transform((handle) => handle.replace(/^@/, ''))
      .default(''),
    publicAccount: answer.default('unknown'),
    eventAccount: answer.default('unknown'),
    services: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  })
  .strict()
  .refine(
    (p) => p.instagram || (p.publicAccount === 'unknown' && p.eventAccount === 'unknown'),
    '공개 여부·용도를 저장할 인스타 계정 아이디를 입력하세요.',
  );
export type QualificationProfile = z.infer<typeof QualificationProfileSchema>;
export const qualificationProfile = (store: Store) =>
  QualificationProfileSchema.parse(store.settings('qualificationProfile', {}));

type Kind = 'adult' | 'account' | 'public' | 'service' | 'follower' | 'course';
type Check = {
  kind: Kind;
  label: string;
  quote: string;
  value: Answer;
  scope: 'profile' | 'event';
  id: string;
  needsAccount?: boolean;
  basis?: string;
  account?: string;
};
type EventAnswers = Record<string, Answer>;

export function participantConditions(
  store: Store,
  event: EventRecord,
  profile = qualificationProfile(store),
) {
  const checks: Check[] = [];
  const handled = new Set<NonNullable<EventRecord['eligibility']>[number]>();
  const urls = [canonicalUrl(event.sourceUrl), canonicalUrl(event.entryUrl)];
  const source = (event.sourceEvidence || []).filter((s) => urls.includes(canonicalUrl(s.url)));
  const seen = (quote: string) => source.some((s) => observedQuote(s.text, quote));
  const ig =
    instagramTarget(event.entryUrl, 'comment') &&
    !!event.tasks?.some((t) => instagramTarget(t.url, t.kind));
  const add = (kind: Kind, label: string, quote: string, value?: Answer, basis?: string) => {
    if (!seen(quote)) return false;
    const accountBound = kind === 'follower' || kind === 'account' || kind === 'public';
    const id = createHash('sha256')
      .update(
        JSON.stringify([
          event.id,
          urls,
          event.deadline,
          event.deadlineDate,
          event.startsAt,
          kind,
          label,
          quote,
          accountBound
            ? [profile.instagram, event.tasks?.filter((t) => t.kind === 'follow').map((t) => t.url)]
            : null,
        ]),
      )
      .digest('hex');
    const saved =
      value === undefined || kind === 'service'
        ? store.settings<EventAnswers>('eligibility:' + event.id, {})[id]
        : undefined;
    const scope = saved || value === undefined ? 'event' : 'profile';
    if (!checks.some((c) => c.id === id))
      checks.push({
        kind,
        needsAccount: accountBound && !profile.instagram,
        account: accountBound ? profile.instagram : undefined,
        label,
        basis,
        quote,
        id,
        scope,
        value: accountBound && !profile.instagram ? 'unknown' : (saved ?? value ?? 'unknown'),
      });
    return true;
  };
  for (const condition of event.eligibility || []) {
    const { key, acceptedValues, quote } = condition;
    const accepted = acceptedValues.length === 1 ? acceptedValues[0]! : '';
    const text = quote
      .trim()
      .replace(/^\d+[.)]\s*/, '')
      .replace(/[.!]$/, '');
    let added = false;
    if (
      key === 'adult' &&
      accepted === '성인' &&
      /^(?:(?:본|해당) (?:이벤트|행사)는 )?성인만 (?:참여|응모) ?(?:가능(?:합니다)?|할 수 있습니다)$/.test(
        text,
      )
    ) {
      const previous = store
        .settings<{ facts?: { key: string; value: string }[] }>('selectionPolicy', {})
        .facts?.find((f) => f.key === 'adult');
      const previousAdult =
        previous?.value === '성인' ? 'yes' : previous?.value === '미성년자' ? 'no' : 'unknown';
      const declared = profile.adult === 'unknown' ? previousAdult : profile.adult;
      const band = settings(store).profile.ageRange.trim();
      const useBand =
        declared === 'unknown' && /^(?:만\s*)?[2-9]0대(?:\s*(?:초반|중반|후반|이상))?$/.test(band);
      added = add(
        'adult',
        '성인만 참여',
        quote,
        useBand ? 'yes' : declared,
        useBand
          ? '저장된 연령대'
          : previous && profile.adult === 'unknown'
            ? '운영 탭의 자격'
            : undefined,
      );
    }
    if (
      ig &&
      key === 'account_type' &&
      accepted === '공개 계정이며 이벤트 계정이 아님' &&
      /^비공개\s*계정(?:,\s*| 및 |과 |과\s*)이벤트(?: 전용)?\s*계정(?:은|의)? (?:참여가 |참여 )?(?:제외(?:됩니다)?|불가(?:합니다)?)$/.test(
        text,
      )
    ) {
      const result =
        profile.publicAccount === 'no' || profile.eventAccount === 'yes'
          ? 'no'
          : profile.publicAccount === 'yes' && profile.eventAccount === 'no'
            ? 'yes'
            : 'unknown';
      added = add('account', '공개 계정이며 이벤트 전용 계정이 아님', quote, result);
    }
    const service = /^(.+?) (?:시스템 사용자|서비스 이용자)$/.exec(accepted)?.[1];
    if (
      key === 'system_user' &&
      service &&
      text.replace(/^[□•\s]*(?:(?:참여|참가|응모)\s*대상\s*[:：]\s*)?/, '') === accepted
    )
      added = add(
        'service',
        accepted,
        quote,
        profile.services.includes(service) ? 'yes' : undefined,
      );
    if (
      ig &&
      key === 'follower_status' &&
      accepted === '이벤트 기간 내 신규 팔로워' &&
      /^이벤트 기간 내 신규 팔로워만 (?:해당|참여 가능)$/.test(text)
    )
      added = add('follower', '참여 계정이 이번 행사 기간의 신규 팔로워 조건에 해당', quote);
    // Unfamiliar wording can be answered for this exact event, never promoted to a reusable fact.
    if (!added) {
      const scopedKind =
        key === 'system_user'
          ? 'service'
          : ig && key === 'account_type'
            ? 'account'
            : ig && key === 'follower_status'
              ? 'follower'
              : undefined;
      if (scopedKind) added = add(scopedKind, acceptedValues.join(' 또는 '), quote);
    }
    if (added) handled.add(condition);
  }
  const personal = event.entryNeeds?.personalResponse;
  if (personal?.required && /수강한 강좌 중 추천/.test(personal.quote))
    add('course', '해당 서비스에서 수강했고 추천할 강좌가 있음', personal.quote);
  // Some older candidates recorded this condition only in requirements and the caption.
  if (ig) {
    const publicRule = /^(?:당첨자 연락처 (?:정보 )?요청을 위(?:한|해) )?공개 계정 전환 필수[.!]?$/;
    if (event.requirements.some((r) => publicRule.test(r.trim()))) {
      const caption = source
        .flatMap((s) => s.text.split('\n'))
        .map((line) => line.trim().replace(/^[✔☑✓️\s]+/u, ''))
        .find((line) => publicRule.test(line));
      if (caption) add('public', '참여 인스타 계정이 공개 상태', caption, profile.publicAccount);
      else
        return {
          checks,
          handled,
          blockers: [...event.blockers, '공개 계정 조건의 원문 확인 필요'],
          accountRequired: true,
        };
    }
  }
  // Old collections duplicated structured eligibility in free text. Every clause of a
  // known summary must have its own source-backed check; extra text remains a blocker.
  const covered = (blocker: string) => {
    const parts = blocker.replace(/(?:\s*(?:자격\s*)?확인 필요|\s*미확인)$/, '').split(/\s+및\s+/);
    return parts.every((part) =>
      checks.some((c) => {
        switch (c.kind) {
          case 'adult':
            return part === '성인 여부';
          case 'account':
            return part === '공개·비이벤트 계정';
          case 'service':
            return part === c.label + ' 여부' || part === c.label;
          case 'follower':
            return /^(?:이벤트 )?기간 내 신규 팔로워 여부$/.test(part);
          case 'course':
            return (
              part === event.organizer + ' 강좌 수강 경험' ||
              (part.endsWith(' 강좌 수강 경험') &&
                event.title.startsWith(part.slice(0, -' 강좌 수강 경험'.length) + ' '))
            );
          default:
            return false;
        }
      }),
    );
  };
  const blockers = event.blockers.filter((b) => !covered(b));
  return {
    checks,
    handled,
    blockers,
    accountRequired: checks.some((c) => ['account', 'public', 'follower'].includes(c.kind)),
  };
}

export const EventAnswersSchema = z
  .object({
    answers: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-f0-9]{64}$/),
            value: answer,
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export function saveEventQualifications(
  store: Store,
  event: EventRecord,
  input: z.infer<typeof EventAnswersSchema>,
) {
  if (store.submission(event.id) || (event.management && event.management.mode !== 'active'))
    throw new ServiceError('cannot_review_started_event');
  const profile = qualificationProfile(store);
  const { checks } = participantConditions(store, event, profile);
  const available = checks.filter(
    (c) => (c.scope === 'event' || c.kind === 'service') && !c.needsAccount,
  );
  if (input.answers.some((a) => !available.some((c) => c.id === a.id)))
    throw new ServiceError('qualification_question_changed');
  const saved = store.settings<EventAnswers>('eligibility:' + event.id, {});
  for (const a of input.answers) {
    if (a.value === 'unknown') delete saved[a.id];
    else saved[a.id] = a.value;
  }
  store.setSettings('eligibility:' + event.id, saved);
}

export function jobParticipantCheck(store: Store, event: EventRecord) {
  const profile = qualificationProfile(store);
  const { checks, accountRequired } = participantConditions(store, event, profile);
  return checks.length ? { instagram: accountRequired ? profile.instagram : undefined } : undefined;
}

export function verifyQualificationActor(
  job: { participantCheck?: { instagram?: string } },
  actor?: string,
) {
  if (job.participantCheck?.instagram && actor?.toLowerCase() !== job.participantCheck.instagram)
    throw new ServiceError('qualification_actor_mismatch');
}
