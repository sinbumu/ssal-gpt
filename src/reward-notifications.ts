import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { outcomes } from './outcomes.js';
import { dayKey } from './operations.js';

export const noticeLabels = {
  dm_review: '당첨 DM · 행사 연결 확인 필요',
  won: '당첨 확인',
  reply: '당첨 확인 · 회신 필요',
  delivery: '경품 수령 대기',
  deadline: '회신·수령 기한 확인',
  expiration: '쿠폰 만료일 확인',
  announced: '발표 확인 · 본인 결과 확인 필요',
};
export type RewardNotice = {
  id: string;
  key: string;
  eventId: string;
  kind: keyof typeof noticeLabels;
  createdAt: number;
  readAt?: number;
};
export function currentNotices(store: Store, now = Date.now()) {
  const today = dayKey(now);
  return outcomes(store).flatMap((o) => {
    const kinds: [RewardNotice['kind'], string][] = [];
    if (o.status === 'won') {
      if (
        !['received', 'used', 'expired'].includes(o.reward?.status || '') &&
        o.followUp?.state !== 'done'
      ) {
        const state = o.followUp?.state;
        kinds.push([state === 'needs_reply' ? 'reply' : state ? 'delivery' : 'won', '']);
        if ((!state || state === 'needs_reply') && o.claimBy && o.claimBy <= today)
          kinds.push(['deadline', o.claimBy]);
      }
      if (o.reward?.status === 'received' && o.reward.expiresOn && o.reward.expiresOn <= today)
        kinds.push(['expiration', o.reward.expiresOn]);
    } else if (o.status !== 'lost' && o.check?.state === 'announced') kinds.push(['announced', '']);
    if (!['won', 'lost'].includes(o.status))
      for (const f of o.dmChecks || [])
        if (f.state === 'review' && !f.reviewed && f.key) kinds.push(['dm_review', f.key]);
    return kinds.map(([kind, suffix]) => ({
      eventId: o.eventId,
      kind,
      key: createHash('sha256').update(`${o.eventId}:${kind}:${suffix}`).digest('hex'),
    }));
  });
}
export function collectNotices(store: Store, now = Date.now()) {
  const saved = store.settings<RewardNotice[]>('rewardNotices', []);
  const existing = new Set(saved.map((n) => n.key));
  const fresh = currentNotices(store, now)
    .filter((n) => !existing.has(n.key))
    .map((n) => ({ ...n, id: randomUUID(), createdAt: now }));
  if (fresh.length) store.setSettings('rewardNotices', [...saved, ...fresh]);
  return [...saved, ...fresh];
}
export function noticeInbox(store: Store, now = Date.now()) {
  const active = new Set(currentNotices(store, now).map((n) => n.key));
  return store
    .settings<RewardNotice[]>('rewardNotices', [])
    .map((n) => ({
      ...n,
      title: store.event(n.eventId)?.title || '응모 결과',
      label: noticeLabels[n.kind],
      active: active.has(n.key),
    }))
    .reverse();
}
export function readNotices(store: Store, ids: string[], now = Date.now()) {
  store.setSettings(
    'rewardNotices',
    store
      .settings<RewardNotice[]>('rewardNotices', [])
      .map((n) => (ids.includes(n.id) ? { ...n, readAt: n.readAt || now } : n)),
  );
}
// No titles, DM text, recipient identifiers, profile fields, coupon codes or private links leave the device.
export function notificationText(items: Pick<RewardNotice, 'kind'>[], localPort?: number) {
  const counts = new Map<RewardNotice['kind'], number>();
  for (const n of items) counts.set(n.kind, (counts.get(n.kind) || 0) + 1);
  return [
    '쌀-GPT · 당첨·수령 알림',
    ...[...counts].map(([kind, n]) => `${noticeLabels[kind]} ${n}건`),
    localPort
      ? `연결된 컴퓨터에서 열기 · http://127.0.0.1:${localPort}/#rewards`
      : '연결된 컴퓨터의 대시보드 → 08 결과·경품에서 확인하세요.',
  ].join('\n');
}
