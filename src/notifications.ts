import { z } from 'zod';
import type { SourceEvidence } from './evidence.js';
import { observedQuote } from './evidence.js';

export const WinnerNoticeSchema = z.object({
  channels: z
    .array(
      z.enum([
        'instagram_dm',
        'direct_message',
        'email',
        'sms',
        'phone',
        'post_comment',
        'story',
        'site_notice',
        'other',
      ]),
    )
    .max(8),
  basis: z.enum(['explicit', 'inferred', 'unknown']),
  sourceUrl: z.string().url().optional(),
  quote: z.string().max(800).optional(),
  reason: z.string().max(500),
});
export type WinnerNotice = z.infer<typeof WinnerNoticeSchema>;
const patterns: [WinnerNotice['channels'][number], RegExp][] = [
  [
    'instagram_dm',
    /(?:인스타|instagram|개별|발표|안내|연락|당첨).{0,35}(?:DM|디엠)|(?:DM|디엠).{0,20}(?:안내|발송|연락)/i,
  ],
  [
    'email',
    /(?:이메일|e-?mail|메일)(?:로|을 통해|\s*(?:안내|발송|연락))|(?:개별|발표).{0,20}(?:이메일|메일)(?!\s*(?:수집|주소))/i,
  ],
  ['sms', /문자|SMS|MMS/i],
  ['phone', /전화(?:로|\s*연락|\s*안내|\s*통보)/],
  ['post_comment', /댓글.{0,15}발표|발표.{0,15}댓글/],
  ['story', /스토리|story/i],
  ['site_notice', /홈페이지|공지사항|사이트.{0,15}발표|게시판/],
];
function channels(text: string, sourceUrl?: string) {
  const instagram =
    /인스타|instagram/i.test(text) ||
    (!!sourceUrl && /(^|\.)instagram\.com$/.test(new URL(sourceUrl).hostname));
  return patterns
    .filter(([, re]) => re.test(text))
    .map(([kind]) => (kind === 'instagram_dm' && !instagram ? ('direct_message' as const) : kind));
}
export function winnerNotice(event: {
  winnerNotice?: WinnerNotice;
  announcementNote?: string;
  sourceEvidence?: SourceEvidence[];
}): WinnerNotice {
  const n = event.winnerNotice;
  if (n?.quote && n.sourceUrl && n.basis !== 'unknown') {
    const source = event.sourceEvidence?.find(
      (s) => s.url === n.sourceUrl && observedQuote(s.text, n.quote!),
    );
    if (source) {
      const detected = channels(n.quote, source.url);
      const requested = n.channels.filter((c) => detected.includes(c));
      if (requested.length && /당첨|발표|선정|개별|연락|안내/.test(n.quote))
        return {
          ...n,
          channels: requested,
          basis: n.basis === 'explicit' ? 'explicit' : 'inferred',
        };
    }
  }
  // Recover only announcement-related original lines, never infer delivery from a collected phone field.
  for (const source of event.sourceEvidence || []) {
    const lines = source.text.split(/\n/).filter((line) => /당첨|발표|선정/.test(line));
    for (const line of lines) {
      const found = channels(line, source.url);
      if (found.length)
        return {
          channels: found,
          basis: 'explicit',
          sourceUrl: source.url,
          quote: line.slice(0, 800),
          reason: '저장된 원문의 당첨 발표 안내에서 확인했습니다.',
        };
    }
  }
  const legacy = event.announcementNote || '';
  const found = channels(legacy);
  if (found.length)
    return {
      channels: found,
      basis: 'inferred',
      quote: legacy.slice(0, 800),
      reason: '기존 발표 메모를 바탕으로 표시합니다. 연결된 원문 근거는 재검증하지 못했습니다.',
    };
  return {
    channels: [],
    basis: 'unknown',
    reason:
      n?.basis === 'unknown' && n.reason
        ? n.reason
        : '저장된 원문에서 당첨 연락 수단을 확인하지 못했습니다. 연락처 수집 여부만으로 추측하지 않습니다.',
  };
}
