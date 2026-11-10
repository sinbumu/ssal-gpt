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
  readCounts?: Record<string, number>;
  navigationCounts?: Record<string, number>;
  replans?: number;
  needsFreshSearch?: boolean;
  redirects?: { requested: string; resolved: string }[];
  contextSize?: { samples: number; originalChars: number; submittedChars: number };
  reusedRejections?: { fromJob: string; url: string }[];
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
// Navigation wrappers and tracking parameters are not new source material.
export function discoveryPageKey(raw: string) {
  const u = new URL(raw);
  if (u.hostname === 'blog.naver.com' && u.pathname === '/PostView.naver') {
    const blog = u.searchParams.get('blogId'),
      post = u.searchParams.get('logNo');
    if (blog && post)
      return `https://blog.naver.com/${encodeURIComponent(blog)}/${encodeURIComponent(post)}`;
  }
  // Carousel position changes the view, not which Instagram event was rejected.
  if (
    /^(www\.)?instagram\.com$/.test(u.hostname) &&
    /^\/(?:[\w.]+\/)?(?:p|reels?)\/[\w-]+\/?$/.test(u.pathname)
  ) {
    u.pathname = u.pathname.replace('/reels/', '/reel/');
    u.searchParams.delete('img_index');
  }
  if (/\/(sorry|challenge|checkpoint)(\/|$)/.test(u.pathname)) u.search = '';
  for (const key of [...u.searchParams.keys()])
    if (/^__cf_|^dtm_/i.test(key)) u.searchParams.delete(key);
  return canonicalUrl(u.toString());
}
function sourceFamily(raw: string) {
  const u = new URL(discoveryPageKey(raw));
  return u.hostname === 'blog.naver.com'
    ? `${u.hostname}/${u.searchParams.get('blogId') || u.pathname.split('/')[1]}`
    : u.hostname.replace(/^www\./, '');
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
  s.needsFreshSearch = false;
}
export function excludedSource(job: Job, raw: string) {
  const s = discoveryState(job);
  const aliases = new Set([discoveryPageKey(raw)]);
  // Follow observed redirect aliases in either direction; cycles stay bounded.
  for (let i = 0; i <= (s.redirects?.length || 0); i++) {
    const size = aliases.size;
    for (const r of s.redirects || []) {
      const from = discoveryPageKey(r.requested),
        to = discoveryPageKey(r.resolved);
      if (aliases.has(from) || aliases.has(to)) {
        aliases.add(from);
        aliases.add(to);
      }
    }
    if (aliases.size === size) break;
  }
  return [...aliases].some(
    (key) =>
      promotionalLink(key) ||
      s.rejected.some((r) => r.host === new URL(key).hostname.replace(/^www\./, '')) ||
      [...(job.skippedUrls || []), ...s.rejected.map((r) => r.url)].some(
        (u) => discoveryPageKey(u) === key,
      ),
  );
}

// A prior factual rejection can save a repeated check, never grant entry permission.
export function reuseDiscoveryRejections(job: Job, pastJobs: Job[], now = Date.now()) {
  const s = discoveryState(job);
  if (s.reusedRejections || !job.prepareOne) return;
  s.reusedRejections = [];
  for (const past of pastJobs
    .filter(
      (p) =>
        p.id !== job.id &&
        p.kind === 'discover' &&
        p.goal === job.goal &&
        p.prepareOne?.revision === job.prepareOne?.revision &&
        p.browserEngine === job.browserEngine &&
        Date.parse(p.updatedAt) <= Date.parse(job.createdAt) &&
        now - Date.parse(p.updatedAt) <= 6 * 60 * 60_000,
    )
    .slice(0, 10)) {
    for (const r of past.discovery?.rejected || []) {
      // Technical failures and inferred user facts are not durable source exclusions.
      if (
        !past.history.some(
          (h) =>
            h.action === 'skip_source' &&
            discoveryPageKey(h.url) === discoveryPageKey(r.url) &&
            h.reason === r.reason,
        ) ||
        /인증|로그인|읽기 실패|접근 실패|접속 실패/.test(r.reason)
      )
        continue;
      rejectSource(job, r.url, r.reason, !!r.host);
      s.reusedRejections.push({ fromJob: past.id, url: r.url });
    }
    // Only aliases connected to an imported rejection are needed.
    for (const r of past.discovery?.redirects || []) {
      const probe = { ...job, discovery: { ...s, redirects: past.discovery!.redirects } };
      if (
        excludedSource(probe, r.requested) &&
        !s.redirects?.some((v) => v.requested === r.requested && v.resolved === r.resolved)
      )
        s.redirects = [...(s.redirects || []), r].slice(-100);
    }
  }
  if (s.reusedRejections.length)
    job.history.push({
      action: 'discovery_rejections_reused',
      reason: `같은 목표·위임으로 최근 확인한 제외 사유 ${s.reusedRejections.length}개를 재사용합니다.`,
      url: job.startUrl,
    });
}

const PAGE_LINK_LABEL = /^(?:\d+|다음(?:\s*페이지)?|next(?:\s*page)?|[›»>])$/i;
function nextPageLink(raw: string, label: string, source?: string) {
  if (!source || !PAGE_LINK_LABEL.test(label.trim())) return false;
  const u = new URL(raw),
    base = new URL(source);
  if (u.origin !== base.origin || u.pathname !== base.pathname) return false;
  const keys = ['page', 'p', 'pg', 'pageNo', 'page_num', 'pageno'];
  const key = keys.find((k) => u.searchParams.has(k));
  if (!key || !/^\d+$/.test(u.searchParams.get(key)!)) return false;
  const target = Number(u.searchParams.get(key)),
    current = Number(base.searchParams.get(key) || 1);
  u.searchParams.delete(key);
  base.searchParams.delete(key);
  return (
    target > current &&
    target <= current + 10 &&
    canonicalUrl(u.toString()) === canonicalUrl(base.toString())
  );
}
export function promotionalLink(raw: string, label = '') {
  const u = new URL(raw);
  return (
    /(?:^|\/)(?:advertise|advertising|ads)(?:\/|$)/i.test(u.pathname) ||
    /광고\s*(?:문의|상품|단가|집행)|이벤트\s*홍보가\s*필요|추천\s*캠페인\s*집행|매체\s*소개서|advertis(?:e with us|ing rates)/i.test(
      label,
    )
  );
}
export function noteDiscoveryDestination(job: Job, requested: string, resolved: string) {
  const s = discoveryState(job),
    from = discoveryPageKey(requested),
    to = discoveryPageKey(resolved);
  if (!s.visited.includes(to) && !searchLocation(resolved)) s.lastProgressStep = job.steps;
  s.needsFreshSearch = false;
  s.visited = [...new Set([...s.visited, from, to])].slice(-200);
  if (from !== to && !(s.redirects || []).some((r) => r.requested === from && r.resolved === to))
    s.redirects = [...(s.redirects || []), { requested: from, resolved: to }].slice(-100);
  s.frontier = s.frontier.filter(
    (f) => !s.visited.includes(discoveryPageKey(f.url)) && !promotionalLink(f.url, f.label),
  );
}
function readableLink(raw: string, label: string, source?: string) {
  try {
    const u = new URL(raw);
    return (
      /^https?:$/.test(u.protocol) &&
      !u.username &&
      !u.password &&
      !searchLocation(raw) &&
      !promotionalLink(raw, label) &&
      (!PAGE_LINK_LABEL.test(label.trim()) || nextPageLink(raw, label, source)) &&
      !/\/login|\/signin|\/challenge|\/checkpoint|\/accounts|logout|signout/i.test(u.pathname) &&
      !/^(accounts|nid|auth)\./.test(u.hostname) &&
      !/로그인|로그아웃|회원가입|개인정보|이용약관|광고문의/.test(label) &&
      !/당첨자\s*발표|당첨\s*결과|요금제|유심|개통|카드\s*발급|멤버십\s*전용|사용후기|예약\s*구매/.test(
        label,
      ) &&
      // A tracking query such as ?eventCode=ad is not an event link.
      !(
        source &&
        /^(www\.)?instagram\.com$/.test(new URL(source).hostname) &&
        /^(www\.)?instagram\.com$/.test(u.hostname) &&
        !/이벤트|event|경품|응모/i.test(label)
      ) &&
      (nextPageLink(raw, label, source) ||
        /이벤트|event|퀴즈|댓글|응모|경품|팔로우|좋아요|공지|notice/i.test(label) ||
        /(?:^|\/)events?(?:\/|\.|$)|\/notice(?:\/|$)/i.test(u.pathname) ||
        (/^(www\.)?instagram\.com$/.test(u.hostname) &&
          /^\/(?:[\w.]+\/)?(?:p|reel)\//.test(u.pathname)))
    );
  } catch {
    return false;
  }
}
export function observeDiscovery(job: Job, o: Observation) {
  const s = discoveryState(job),
    key = discoveryPageKey(o.url),
    search = searchLocation(o.url);
  if (!s.visited.includes(key)) {
    s.visited.push(key);
    s.needsFreshSearch = false;
    if (!search) s.lastProgressStep = job.steps;
    // Count the initial search, too. Later searches are persisted before navigation.
    if (
      search?.query &&
      !s.searches.some((v) => v.engine === search.engine && v.query === search.query)
    )
      noteSearch(job, search.engine, search.query);
  }
  for (const e of o.elements) {
    if (
      !e.href ||
      !readableLink(e.href, e.label, o.url) ||
      s.visited.includes(discoveryPageKey(e.href)) ||
      excludedSource(job, e.href)
    )
      continue;
    if (!s.frontier.some((v) => discoveryPageKey(v.url) === discoveryPageKey(e.href!))) {
      s.frontier.push({ url: e.href, label: e.label.slice(0, 200), source: o.url });
      (s.readCounts ??= {})[key] = 0;
    }
  }
  s.frontier = s.frontier
    .filter(
      (v) =>
        !s.visited.includes(discoveryPageKey(v.url)) &&
        !excludedSource(job, v.url) &&
        !promotionalLink(v.url, v.label),
    )
    .sort((a, b) => {
      const score = (link: typeof a) =>
        words(job.goal).filter((w) => link.label.toLowerCase().includes(w)).length +
        (/instagram\.com\/(?:[\w.]+\/)?(?:p|reel)\//.test(link.url) ? 8 : 0) +
        (nextPageLink(link.url, link.label, link.source) ? 5 : 0) -
        s.rejected.filter((r) => sourceFamily(r.url) === sourceFamily(link.url)).length * 4;
      return score(b) - score(a);
    })
    .slice(0, 100);
  s.visited = s.visited.slice(-200);
}
export function rejectSource(job: Job, url: string, reason: string, restricted = false) {
  const s = discoveryState(job);
  url = discoveryPageKey(url);
  const host = restricted ? new URL(url).hostname.replace(/^www\./, '') : undefined;
  const existing = s.rejected.find((v) => discoveryPageKey(v.url) === url);
  if (existing && host) existing.host = host;
  if (!existing) s.rejected.push({ url, reason: reason.slice(0, 500), host });
  s.rejected = s.rejected.slice(-80);
  job.skippedUrls = [...new Set([...(job.skippedUrls || []), url])].slice(-80);
}
export function selectedDiscoveryLink(job: Job, o: Observation, url?: string) {
  if (!url || discoveryPageKey(url) === discoveryPageKey(o.url) || excludedSource(job, url)) return;
  // A visited list is still an observed destination after leaving the frontier.
  if (job.visitedUrls?.includes(url)) return url;
  const link =
    o.elements.find((e) => e.href === url) ||
    discoveryState(job).frontier.find((e) => e.url === url);
  return link && readableLink(url, link.label, o.url) ? url : undefined;
}
export function noteDiscoveryRead(job: Job, source: string, step: Step) {
  const s = discoveryState(job),
    key = discoveryPageKey(source);
  if (['scroll', 'wait', 'navigate'].includes(step.action))
    (s.readCounts ??= {})[key] = (s.readCounts?.[key] || 0) + 1;
  if (step.action === 'navigate' && step.url && !searchLocation(step.url)) {
    const target = JSON.stringify([key, discoveryPageKey(step.url)]);
    (s.navigationCounts ??= {})[target] = (s.navigationCounts?.[target] || 0) + 1;
  }
}
export function stalledDiscoveryRead(job: Job, o: Observation, step: Step) {
  const s = discoveryState(job),
    key = discoveryPageKey(o.url);
  if (['scroll', 'wait'].includes(step.action) && (s.readCounts?.[key] || 0) >= 8)
    return '새 행사 링크 확보 없이 같은 출처를 8회 읽어 다른 출처로 전환합니다.';
  if (
    step.action === 'navigate' &&
    step.url &&
    !searchLocation(step.url) &&
    (s.navigationCounts?.[JSON.stringify([key, discoveryPageKey(step.url)])] || 0) >= 2
  )
    return '같은 출처에서 동일한 주소로 이동을 반복해 해당 읽기 경로를 제외합니다.';
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
    replans: s.replans || 0,
    needsFreshSearch: !!s.needsFreshSearch,
    remainingDecisions: job.maxSteps - job.steps,
    readsWithoutNewLinks: s.readCounts?.[discoveryPageKey(job.currentUrl || job.startUrl)] || 0,
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
    (v) => !s.visited.includes(discoveryPageKey(v.url)) && !excludedSource(job, v.url),
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
