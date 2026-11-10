import type { Observation } from './browser.js';
import type { Step } from './model.js';
import { canonicalUrl, type Job } from './store.js';
import { searchUrl } from './evidence.js';

type Engine = 'naver' | 'google';
export const MAX_DISCOVERY_SWITCHES = 6;
export type DiscoveryState = {
  searches: { engine: Engine; query: string; step: number }[];
  visited: string[];
  frontier: { url: string; label: string; source: string }[];
  rejected: { url: string; reason: string; host?: string }[];
  blockedEngines: Engine[];
  lastProgressStep: number;
  switches: number;
};
export function discoveryState(job: Job): DiscoveryState {
  return (job.discovery ??= {
    searches: [],
    visited: [],
    frontier: [],
    rejected: [],
    blockedEngines: [],
    lastProgressStep: 0,
    switches: 0,
  });
}
export function searchLocation(raw: string) {
  const u = new URL(raw);
  if (u.hostname === 'search.naver.com')
    return { engine: 'naver' as const, query: u.searchParams.get('query') || '' };
  if (/^(www\.)?google\.[a-z.]+$/.test(u.hostname) && /^\/(search|sorry)/.test(u.pathname))
    return { engine: 'google' as const, query: u.searchParams.get('q') || '' };
}
function words(query: string) {
  return [
    ...new Set(
      query
        .normalize('NFKC')
        .toLowerCase()
        .replace(/instagram|인스타그램/g, '인스타')
        .match(/-?(?:site:)?[\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]+)*/gu) || [],
    ),
  ].sort();
}
export function similarQuery(a: string, b: string) {
  const x = words(a),
    y = words(b);
  if (!x.length || !y.length) return false;
  if (x.join(' ') === y.join(' ')) return true;
  const common = x.filter((w) => y.includes(w)).length;
  return common >= 3 && common / new Set([...x, ...y]).size >= 0.65;
}
export function noteSearch(job: Job, engine: Engine, query: string) {
  const s = discoveryState(job);
  if (!s.searches.some((v) => v.engine === engine && v.step === job.steps && v.query === query))
    s.searches.push({ engine, query: query.slice(0, 1000), step: job.steps });
  s.searches = s.searches.slice(-80);
  job.searchEngine = engine;
}
export function excludedSource(job: Job, raw: string) {
  const key = canonicalUrl(raw);
  const host = new URL(raw).hostname.replace(/^www\./, '');
  if (discoveryState(job).rejected.some((v) => v.host === host)) return true;
  return [...(job.skippedUrls || []), ...discoveryState(job).rejected.map((r) => r.url)].some(
    (u) => canonicalUrl(u) === key,
  );
}
function readableLink(raw: string, label: string) {
  try {
    const u = new URL(raw);
    return (
      /^https?:$/.test(u.protocol) &&
      !u.username &&
      !u.password &&
      !searchLocation(raw) &&
      !/\/login|\/signin|\/challenge|\/checkpoint|\/accounts|logout|signout/i.test(u.pathname) &&
      !/^(accounts|nid|auth)\./.test(u.hostname) &&
      !/로그인|로그아웃|회원가입|개인정보|이용약관|광고문의/.test(label) &&
      /이벤트|event|퀴즈|댓글|응모|경품|팔로우|좋아요|instagram|인스타|공지|notice/i.test(
        label + ' ' + raw,
      )
    );
  } catch {
    return false;
  }
}
export function observeDiscovery(job: Job, o: Observation) {
  const s = discoveryState(job),
    key = canonicalUrl(o.url),
    search = searchLocation(o.url);
  if (!s.visited.includes(key)) {
    s.visited.push(key);
    if (!search) s.lastProgressStep = job.steps;
    // Count the initial search, too. Later searches are persisted before navigation.
    if (
      search?.query &&
      !s.searches.some((v) => v.engine === search.engine && v.query === search.query)
    )
      noteSearch(job, search.engine, search.query);
  }
  for (const e of o.elements) {
    if (!e.href || !readableLink(e.href, e.label)) continue;
    if (!s.frontier.some((v) => canonicalUrl(v.url) === canonicalUrl(e.href!)))
      s.frontier.push({ url: e.href, label: e.label.slice(0, 200), source: o.url });
  }
  s.frontier = s.frontier
    .filter((v) => !s.visited.includes(canonicalUrl(v.url)) && !excludedSource(job, v.url))
    .sort((a, b) => {
      const score = (link: typeof a) =>
        words(job.goal).filter((w) => link.label.toLowerCase().includes(w)).length +
        (/instagram\.com\/(?:[\w.]+\/)?(?:p|reel)\//.test(link.url) ? 8 : 0);
      return score(b) - score(a);
    })
    .slice(0, 100);
  s.visited = s.visited.slice(-200);
}
export function rejectSource(job: Job, url: string, reason: string, restricted = false) {
  const s = discoveryState(job);
  const host = restricted ? new URL(url).hostname.replace(/^www\./, '') : undefined;
  const existing = s.rejected.find((v) => canonicalUrl(v.url) === canonicalUrl(url));
  if (existing && host) existing.host = host;
  if (!existing) s.rejected.push({ url, reason: reason.slice(0, 500), host });
  s.rejected = s.rejected.slice(-80);
  job.skippedUrls = [...new Set([...(job.skippedUrls || []), url])].slice(-80);
}
export function discoveryContext(job: Job) {
  const s = discoveryState(job);
  return {
    preferredEngine: job.searchEngine || 'naver',
    blockedEngines: s.blockedEngines,
    recentSearches: s.searches.slice(-8),
    rejectedSources: s.rejected.slice(-12),
    freshLinks: s.frontier.slice(0, 16),
    switches: s.switches,
    remainingDecisions: job.maxSteps - job.steps,
  };
}
export type DiscoveryRoute = { url: string; reason: string; engine?: Engine; query?: string };
// Read-only alternatives are either standard search URLs or actually observed links.
// No candidate is invented, and this function cannot authorize entry actions.
export function nextDiscoveryRoute(
  job: Job,
  query?: string,
  from?: Engine,
): DiscoveryRoute | undefined {
  const s = discoveryState(job);
  if (s.switches >= MAX_DISCOVERY_SWITCHES || job.steps >= job.maxSteps) return;
  const current = from || job.searchEngine || 'naver';
  const q = query || s.searches.at(-1)?.query || job.goal.slice(0, 500);
  const alternate: Engine = current === 'naver' ? 'google' : 'naver';
  if (
    !s.blockedEngines.includes(alternate) &&
    !s.searches.some((v) => v.engine === alternate && similarQuery(v.query, q))
  ) {
    return {
      url: searchUrl(q, alternate),
      engine: alternate,
      query: q,
      reason: `반복·실패 검색을 건너뛰고 ${alternate === 'google' ? 'Google' : '네이버'} 검색으로 전환합니다.`,
    };
  }
  const link = s.frontier.find(
    (v) => !s.visited.includes(canonicalUrl(v.url)) && !excludedSource(job, v.url),
  );
  if (link)
    return {
      url: link.url,
      reason: `반복 검색 대신 아직 확인하지 않은 관측 링크를 읽습니다: ${link.label.slice(0, 100)}`,
    };
}
export function guardDiscoverySearch(job: Job, step: Step) {
  const location = step.action === 'navigate' && step.url ? searchLocation(step.url) : undefined;
  if (step.action !== 'search' && !location) return;
  const s = discoveryState(job);
  const engine = location?.engine || step.searchEngine || job.searchEngine || 'naver';
  const query = location?.query || step.text || '';
  const previous = s.searches.filter((v) => v.engine === engine);
  const exact = previous.some((v) => words(v.query).join(' ') === words(query).join(' '));
  const similar = previous.filter((v) => similarQuery(v.query, query)).length;
  const stagnant = previous.filter((v) => v.step >= s.lastProgressStep).length >= 3;
  if (s.blockedEngines.includes(engine) || exact || similar >= 2 || stagnant)
    return {
      route: nextDiscoveryRoute(job, query, engine),
      reason: '동일·유사 검색 반복 또는 새 출처 확보 없는 검색 누적을 감지했습니다.',
    };
}
