import { setTimeout as wait } from 'node:timers/promises';
import type { Browser } from './browser.js';
import { ServiceError } from './auth.js';
import type { EventRecord, Store } from './store.js';
import { observedQuote } from './evidence.js';

export const SITES = [
  {
    id: 'instagram',
    name: 'Instagram',
    url: 'https://www.instagram.com/',
    note: '댓글·좋아요·팔로우에 사용하는 계정',
  },
  {
    id: 'naver',
    name: 'Naver',
    url: 'https://www.naver.com/',
    note: '네이버 폼 등 로그인 필요 경로',
  },
  {
    id: 'google',
    name: 'Google · Forms',
    url: 'https://accounts.google.com/',
    note: '로그인 필요 폼용 · 자동화 브라우저 로그인 거부 가능, 실서비스 제출 미검증',
  },
  {
    id: 'moaform',
    name: '모아폼',
    url: 'https://www.moaform.com/',
    note: '일반 설문 응답은 회원가입·로그인 불필요',
  },
];
export function siteFor(raw: string) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return undefined;
    const host = url.hostname;
    const id = /(^|\.)instagram\.com$/.test(host)
      ? 'instagram'
      : /(^|\.)naver\.com$/.test(host)
        ? 'naver'
        : /(^|\.)(google|youtube)\.com$/.test(host)
          ? 'google'
          : /(^|\.)moaform\.com$/.test(host)
            ? 'moaform'
            : undefined;
    return (
      SITES.find((s) => s.id === id) || {
        id: url.origin,
        name: host,
        url: url.origin + '/',
        note: '사이트별 로그인 자동 판별 미지원 · 확인할 수 없으면 미확인으로 표시',
      }
    );
  } catch {
    return undefined;
  }
}
export type ConnectionRecord = {
  siteId: string;
  profile: string;
  state: string;
  checkedAt: number;
  message: string;
};
export type ConnectionNeed = {
  siteId: string;
  url: string;
  profile: string;
  reason: string;
  jobId?: string;
  eventId?: string;
  at: number;
};
export function saveConnection(
  store: Store,
  profile: string,
  result: { service?: string; state: string; message: string },
  url?: string,
) {
  const site = url ? siteFor(url) : SITES.find((s) => s.id === result.service);
  if (!site || result.state === 'closed') return;
  const all = store.settings<ConnectionRecord[]>('siteConnections', []);
  const record = {
    siteId: site.id,
    profile,
    state: result.state,
    checkedAt: Date.now(),
    message: result.message,
  };
  store.setSettings(
    'siteConnections',
    [...all.filter((r) => r.siteId !== site.id || r.profile !== profile), record].slice(-100),
  );
  return record;
}
export function requireConnection(
  store: Store,
  url: string,
  profile: string,
  reason: string,
  jobId?: string,
  eventId?: string,
) {
  const site = siteFor(url);
  if (!site || site.id === 'moaform') return;
  const all = store.settings<ConnectionNeed[]>('connectionNeeds', []);
  store.setSettings(
    'connectionNeeds',
    [
      ...all.filter(
        (n) =>
          !(
            n.siteId === site.id &&
            n.profile === profile &&
            n.jobId === jobId &&
            n.eventId === eventId
          ),
      ),
      {
        siteId: site.id,
        url: site.url,
        profile,
        reason: reason.slice(0, 500),
        jobId,
        eventId,
        at: Date.now(),
      },
    ].slice(-200),
  );
}
export function connectionReady(store: Store, siteId: string, profile: string, now = Date.now()) {
  const r = store
    .settings<ConnectionRecord[]>('siteConnections', [])
    .find((r) => r.siteId === siteId && r.profile === profile);
  return !!r && r.state === 'signed_in_visible' && now - r.checkedAt < 24 * 60 * 60_000;
}
export function registerCandidateConnections(store: Store, event: EventRecord, profile: string) {
  for (const need of event.entryNeeds?.logins || []) {
    if (
      event.sourceEvidence?.some((s) => observedQuote(s.text, need.quote)) &&
      [
        event.entryUrl,
        ...(event.tasks || []).map((t) => t.url),
        ...(event.sourceEvidence || []).map((s) => s.url),
      ].some((url) => siteFor(url)?.id === siteFor(need.url)?.id)
    )
      requireConnection(store, need.url, profile, need.quote, event.jobId, event.id);
  }
}
export function connectionSummary(store: Store, profile: string) {
  const needs = store
    .settings<ConnectionNeed[]>('connectionNeeds', [])
    .filter(
      (n) =>
        n.profile === profile &&
        !connectionReady(store, n.siteId, profile) &&
        (!n.eventId || store.submission(n.eventId)?.state !== 'completed') &&
        (!n.jobId ||
          store.job(n.jobId)?.kind !== 'apply' ||
          store.job(n.jobId)?.status !== 'stopped'),
    );
  const policy = store.settings<{ mode?: string; newConnections?: string }>('selectionPolicy', {});
  const ask = (policy.newConnections || (policy.mode === 'strict' ? 'skip' : 'ask')) === 'ask';
  const records = store
    .settings<ConnectionRecord[]>('siteConnections', [])
    .filter((r) => r.profile === profile);
  const sites = new Map(SITES.map((s) => [s.id, s]));
  for (const need of needs) {
    const site = siteFor(need.url);
    if (site) sites.set(site.id, site);
  }
  for (const r of records) {
    const site = siteFor(r.siteId);
    if (site) sites.set(site.id, site);
  }
  return [...sites.values()].map((site) => ({
    ...site,
    ...records.find((r) => r.siteId === site.id),
    profile,
    skippedNeeds: ask ? 0 : needs.filter((n) => n.siteId === site.id).length,
    requiredBy: needs
      .filter(
        (n) => (ask || (!!n.eventId && !!store.submission(n.eventId))) && n.siteId === site.id,
      )
      .map((n) => ({
        ...n,
        title: n.eventId ? store.event(n.eventId)?.title : '탐색 중 확인한 연결',
      })),
    state:
      site.id === 'moaform'
        ? 'not_required'
        : records.find((r) => r.siteId === site.id)?.state || 'unknown',
    stale: records.some((r) => r.siteId === site.id && Date.now() - r.checkedAt >= 86400000),
  }));
}
export async function checkConnections(store: Store, browser: Browser, ids: string[]) {
  const known = connectionSummary(store, browser.profileKey());
  const sites = [...new Set(ids)].map((id) => known.find((s) => s.id === id)).filter((s) => !!s);
  if (sites.length !== new Set(ids).size) throw new ServiceError('unknown_connection_site');
  const results = [];
  for (const site of sites) {
    if (site.id === 'moaform') continue;
    try {
      const result = await browser.inReadOnlyTab(async () => {
        await browser.navigate(site.url);
        let status = await browser.connectionStatus();
        const until = Date.now() + 3000;
        while (status.state === 'unknown' && status.service !== 'other' && Date.now() < until) {
          await wait(250);
          status = await browser.connectionStatus();
        }
        return status;
      });
      // Redirects to a different provider never prove that the requested site's session exists.
      const actual = result.service;
      results.push(
        saveConnection(
          store,
          browser.profileKey(),
          actual === site.id || (!SITES.some((s) => s.id === site.id) && actual === 'other')
            ? result
            : {
                state: 'unknown',
                message: '다른 서비스로 이동해 이 사이트의 로그인 상태를 확인하지 못했습니다.',
              },
          site.url,
        ),
      );
    } catch {
      results.push(
        saveConnection(
          store,
          browser.profileKey(),
          {
            state: 'unknown',
            message:
              '확인 페이지를 읽지 못했습니다. 직접 열어 로그인한 뒤 현재 화면을 확인해 주세요.',
          },
          site.url,
        ),
      );
    }
  }
  return results;
}
