import { createHash } from 'node:crypto';
import { ServiceError } from './auth.js';
import type { Browser } from './browser.js';
import { dmScope } from './instagram-dm.js';
import { claimReplyDraft, outcomes, putOutcome } from './outcomes.js';
import type { Store } from './store.js';

type Consent = 'unset' | 'accept' | 'decline';
type Attempt = { status: 'unconfirmed' | 'sent'; at: number };
const hash = (items: string[]) => createHash('sha256').update(JSON.stringify(items)).digest('hex');
export const replyAttempt = (store: Store, eventId: string) =>
  store.settings<Attempt | null>('claim-send:' + eventId, null);

export function dmReplyPreview(store: Store, eventId: string, consent: Consent) {
  const o = outcomes(store).find((o) => o.eventId === eventId);
  const f = o?.dmChecks?.find(
    (f) => f.state === 'won' && '@' + f.organizer === o.followUp?.recipient,
  );
  const scope = dmScope(store, eventId);
  if (
    !f?.key ||
    !scope ||
    !scope.organizers.includes(f.organizer) ||
    o?.status !== 'won' ||
    o.followUp?.channel !== 'instagram_dm' ||
    o.followUp.state !== 'needs_reply' ||
    (o.reward && o.reward.status !== 'expected')
  )
    throw new ServiceError('dm_reply_unavailable');
  const source = store.settings<string>('dmSource:' + eventId + ':' + f.key, '');
  const draft = claimReplyDraft(store, eventId, consent);
  const attempt = replyAttempt(store, eventId);
  const otherChannel =
    /(?:https?:\/\/|[\w.-]+@[\w.-]+\.[a-z]{2,}|폼.{0,12}(?:작성|입력|제출)|(?:링크|메일|이메일|카카오톡|오픈채팅|문자|댓글|홈페이지).{0,12}(?:통해|접속|보내|입력|제출|작성))/i.test(
      source,
    );
  const unsupported =
    /계좌|주민등록|신분증|신용카드|인증번호|비밀번호|입금|신청서|생년월일|마케팅|제3자|제삼자/.test(
      source,
    );
  let reason = '';
  if (attempt)
    reason =
      attempt.status === 'sent'
        ? '이미 회신을 확인했습니다.'
        : '발송을 시도했습니다. 대화에서 결과를 확인해 주세요.';
  else if (!source || !f.quote || !source.includes(f.quote))
    reason = '현재 수신 원문을 다시 확인해 주세요.';
  else if (otherChannel || unsupported)
    reason = '별도 접수 경로나 추가 요청이 있습니다. 주최자 원문의 수령 방법을 확인해 주세요.';
  else if (!/보내|부탁|회신|답장|작성|전달|남겨|알려|전송|답변|reply|please send/i.test(source))
    reason = 'DM 회신 요청을 확인하지 못했습니다.';
  else if (
    !f.requested?.length ||
    !o.followUp.requested.length ||
    [...new Set(o.followUp.requested)].sort().join() !== [...new Set(f.requested)].sort().join()
  )
    reason = '원문에서 확인한 요청 항목과 후속 기록을 확인해 주세요.';
  else if (draft.missing.length) reason = '확인 필요 · ' + draft.missing.join(', ');
  return {
    ...draft,
    text: otherChannel || unsupported ? '' : draft.text,
    source,
    actor: scope.actor,
    profile: scope.profile,
    organizer: f.organizer,
    reason,
    approval: reason
      ? null
      : hash([
          eventId,
          f.key,
          source,
          scope.profile,
          scope.actor,
          f.organizer,
          consent,
          draft.text,
        ]),
  };
}
export async function sendApprovedDm(
  store: Store,
  browser: Browser,
  eventId: string,
  consent: Consent,
  approval: string,
  text: string,
) {
  const validate = () => {
    const p = dmReplyPreview(store, eventId, consent);
    if (
      !p.approval ||
      p.approval !== approval ||
      text !== p.text ||
      browser.profileKey() !== p.profile
    )
      throw new ServiceError('dm_reply_changed');
    return p;
  };
  const p = validate();
  let attempted = false;
  try {
    const verified = await browser.replyToOrganizer(p.actor, p.organizer, p.source, text, () => {
      validate();
      store.setSettings('claim-send:' + eventId, { status: 'unconfirmed', at: Date.now() });
      attempted = true;
    });
    if (!verified) throw new ServiceError('dm_reply_unknown');
    const o = outcomes(store).find((o) => o.eventId === eventId)!;
    const now = new Date().toISOString();
    if (o.followUp?.state === 'needs_reply') {
      o.followUp.state = 'replied';
      o.followUp.repliedAt = now;
    }
    o.updatedAt = now;
    putOutcome(store, o);
    store.setSettings('claim-send:' + eventId, { status: 'sent', at: Date.now() });
  } catch (error) {
    if (attempted) throw new ServiceError('dm_reply_unknown');
    throw error instanceof ServiceError ? error : new ServiceError('dm_reply_preflight');
  }
}
