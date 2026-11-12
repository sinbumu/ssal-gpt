import type { Observation } from './browser.js';
import type { Step } from './model.js';
import { canonicalUrl, type Job } from './store.js';
import { searchUrl } from './evidence.js';

type Engine = 'naver' | 'google';
type DiscoveryLink = { url: string; label: string; source: string; context?: string };
export const DEFAULT_DISCOVERY_SWITCHES = 6;
export type DiscoveryState = {
  searches: { engine: Engine; query: string; step: number }[];
  visited: string[];
  frontier: DiscoveryLink[];
  rejected: { url: string; reason: string; host?: string; basis?: 'observed_conditions' }[];
  blockedEngines: Engine[];
  lastProgressStep: number;
  switches: number;
  switchLimit?: number;
  readCounts?: Record<string, number>;
  navigationCounts?: Record<string, number>;
  replans?: number;
  needsFreshSearch?: boolean;
  rejectedSinceSearch?: number;
  filteredLinks?: { url: string; reason: string }[];
  redirects?: { requested: string; resolved: string }[];
  contextSize?: { samples: number; originalChars: number; submittedChars: number };
  reusedRejections?: { fromJob: string; url: string }[];
  reusedCandidates?: { fromJob: string; eventId: string; url: string }[];
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
export function discoverySwitchLimit(job: Job) {
  const value = job.discovery?.switchLimit;
  return Number.isInteger(value) && value! >= 1 && value! <= 100
    ? value!
    : DEFAULT_DISCOVERY_SWITCHES;
}
// Navigation wrappers and tracking parameters are not new source material.
export function discoveryPageKey(raw: string) {
  const u = new URL(raw);
  // The visible event's participation link carries the same detail ID. Only
  // this exact directory route is an alias; lists, other links and IDs are not.
  if (
    /^(www\.)?suto\.co\.kr$/.test(u.hostname) &&
    u.pathname === '/bbs/link.php' &&
    u.searchParams.get('bo_table') === 'cpevent' &&
    /^\d+$/.test(u.searchParams.get('wr_id') || '') &&
    u.searchParams.get('no') === '1' &&
    ['bo_table', 'wr_id', 'no'].every((k) => u.searchParams.getAll(k).length === 1) &&
    [...u.searchParams.keys()].every(
      (k) => ['bo_table', 'wr_id', 'no'].includes(k) || /^utm_/.test(k),
    )
  )
    return `https://www.suto.co.kr/cpevent/${u.searchParams.get('wr_id')}`;
  if (/^(www\.)?suto\.co\.kr$/.test(u.hostname)) u.hostname = 'www.suto.co.kr';
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
  s.rejectedSinceSearch = 0;
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
        p.selectionKey === job.selectionKey &&
        p.prepareOne?.revision === job.prepareOne?.revision &&
        p.browserEngine === job.browserEngine &&
        Date.parse(p.updatedAt) <= Date.parse(job.createdAt) &&
        now - Date.parse(p.updatedAt) <= 6 * 60 * 60_000,
    )
    .slice(0, 10)) {
    for (const r of past.discovery?.rejected || []) {
      // Technical failures and inferred user facts are not durable source exclusions.
      if (
        (r.basis !== 'observed_conditions' &&
          !past.history.some(
            (h) =>
              h.action === 'skip_source' &&
              discoveryPageKey(h.url) === discoveryPageKey(r.url) &&
              h.reason === r.reason,
          )) ||
        /인증|로그인|읽기 실패|접근 실패|접속 실패/.test(r.reason)
      )
        continue;
      rejectSource(job, r.url, r.reason, !!r.host, true);
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
    u.hostname === 'ader.naver.com' ||
    (/^(www\.)?suto\.co\.kr$/.test(u.hostname) && /^\/membership\/?$/.test(u.pathname)) ||
    /(?:^|\/)(?:advertise|advertising|ads)(?:\/|$)/i.test(u.pathname) ||
    /광고\s*(?:문의|상품|단가|집행)|이벤트\s*홍보가\s*필요|추천\s*캠페인\s*집행|매체\s*소개서|advertis(?:e with us|ing rates)/i.test(
      label,
    )
  );
}

export function formDiscovery(job: Pick<Job, 'goal'>) {
  return /구글\s*폼|google\s*forms?|네이버\s*폼|naver\s*form|웹\s*폼|다중\s*페이지.{0,20}폼|폼\s*(?:이벤트|설문|응모)/i.test(
    job.goal,
  );
}

function directForm(raw: string): 'google' | 'naver' | undefined {
  const u = new URL(raw);
  if (u.hostname === 'form.naver.com' && /^\/response\/[\w-]+\/?$/.test(u.pathname)) return 'naver';
  if (
    (u.hostname === 'forms.gle' && /^\/[\w-]+\/?$/.test(u.pathname)) ||
    (u.hostname === 'docs.google.com' &&
      /^\/forms\/d\/(?:e\/)?[\w-]+\/viewform\/?$/.test(u.pathname))
  )
    return 'google';
}

function preferredForm(job: Pick<Job, 'goal'>) {
  // Use the first named provider: later goal clauses may explicitly exclude others.
  const first = job.goal.match(/구글\s*폼|google\s*forms?|네이버\s*폼|naver\s*forms?/i)?.[0];
  return first ? (/구글|google/i.test(first) ? 'google' : 'naver') : 'web';
}

export function unrelatedDiscoveryLink(job: Job, link: Pick<DiscoveryLink, 'url' | 'label'>) {
  if (!formDiscovery(job) || directForm(link.url)) return;
  const u = new URL(link.url);
  const path = u.pathname;
  if (
    (u.hostname === 'workspace.google.com' && /\/products\/forms\/?$/.test(path)) ||
    (/^(www\.)?google\.com$/.test(u.hostname) && /\/forms\/about\/?$/.test(path)) ||
    (u.hostname === 'docs.google.com' && /^\/forms(?:\/u\/\d+)?\/?$/.test(path))
  )
    return '참여 폼이 아닌 설문 도구 소개·생성 페이지입니다.';
  if (/\/(?:tag|tags)\//i.test(path)) return '개별 응모 안내가 아닌 블로그 태그 모음입니다.';
  if (
    /(?:설문|survey|구글\s*폼|google\s*forms?).{0,50}(?:도구|툴\b|자동화|사용법|만들기|만드는\s*방법|제작\s*방법|tool|software|tutorial)/i.test(
      link.label,
    ) ||
    /(?:surveymonkey|타입폼|typeform).{0,30}(?:소개|비교|활용|사용법|리뷰)/i.test(link.label) ||
    /추진\s*계획|결재\s*문서|입찰\s*공고|과업\s*지시서|용역\s*계약/.test(link.label)
  )
    return '응모 안내가 아닌 설문 도구·행정 문서입니다.';
}

function formLinkScore(link: Pick<DiscoveryLink, 'url' | 'label' | 'context'>, job: Job) {
  const provider = directForm(link.url),
    preferred = preferredForm(job);
  return (
    (provider ? (preferred === 'web' || provider === preferred ? 30 : -40) : 0) +
    (/구글\s*폼|google\s*forms?|네이버\s*폼|naver\s*form/i.test(link.label) ? 12 : 0) +
    (/설문|만족도|의견\s*조사|survey/i.test(link.label + ' ' + (link.context || '')) ? 10 : 0) -
    // Administrative documents may describe surveys but are not participation
    // notices. Lower their priority without excluding other pages on the host.
    (/추진\s*계획|결재\s*문서|입찰\s*공고|과업\s*지시서|용역\s*계약/.test(link.label) ? 40 : 0)
  );
}
function eligibleFrontier(job: Job) {
  const s = discoveryState(job);
  return s.frontier.filter(
    (v) =>
      !s.visited.includes(discoveryPageKey(v.url)) &&
      !excludedSource(job, v.url) &&
      !unrelatedDiscoveryLink(job, v),
  );
}
export function discoveryNeedsReplan(job: Job) {
  const s = discoveryState(job);
  return (
    formDiscovery(job) &&
    (s.rejectedSinceSearch || 0) >= 3 &&
    !eligibleFrontier(job).some((v) => directForm(v.url) && formLinkScore(v, job) >= 30)
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
        /이벤트|event|퀴즈|댓글|응모|경품|팔로우|좋아요|공지|notice|설문|만족도|투표|survey/i.test(
          label,
        ) ||
        directForm(raw) ||
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
      !readableLink(e.href, e.label + ' ' + (e.context || ''), o.url) ||
      s.visited.includes(discoveryPageKey(e.href)) ||
      excludedSource(job, e.href)
    )
      continue;
    const irrelevant = unrelatedDiscoveryLink(job, { url: e.href, label: e.label });
    if (irrelevant) {
      s.filteredLinks ??= [];
      if (!s.filteredLinks.some((v) => discoveryPageKey(v.url) === discoveryPageKey(e.href!)))
        s.filteredLinks.push({ url: e.href, reason: irrelevant });
      s.filteredLinks = s.filteredLinks.slice(-40);
      continue;
    }
    if (!s.frontier.some((v) => discoveryPageKey(v.url) === discoveryPageKey(e.href!))) {
      s.frontier.push({
        url: e.href,
        label: e.label.slice(0, 200),
        source: o.url,
        context: e.context,
      });
      (s.readCounts ??= {})[key] = 0;
    }
  }
  s.frontier = s.frontier
    .filter(
      (v) =>
        !s.visited.includes(discoveryPageKey(v.url)) &&
        !excludedSource(job, v.url) &&
        !unrelatedDiscoveryLink(job, v) &&
        !promotionalLink(v.url, v.label),
    )
    .sort((a, b) => {
      const score = (link: typeof a) =>
        words(job.goal).filter((w) => link.label.toLowerCase().includes(w)).length +
        (formDiscovery(job)
          ? formLinkScore(link, job)
          : /instagram\.com\/(?:[\w.]+\/)?(?:p|reel)\//.test(link.url)
            ? 8
            : 0) +
        (nextPageLink(link.url, link.label, link.source) ? 5 : 0) -
        s.rejected.filter((r) => sourceFamily(r.url) === sourceFamily(link.url)).length * 4;
      return score(b) - score(a);
    })
    .slice(0, 100);
  s.visited = s.visited.slice(-200);
}
export function rejectSource(
  job: Job,
  url: string,
  reason: string,
  restricted = false,
  factual = false,
) {
  const s = discoveryState(job);
  url = discoveryPageKey(url);
  const host = restricted ? new URL(url).hostname.replace(/^www\./, '') : undefined;
  const existing = s.rejected.find((v) => discoveryPageKey(v.url) === url);
  if (existing && host) existing.host = host;
  const basis = factual ? ('observed_conditions' as const) : undefined;
  if (existing && basis) {
    existing.basis = basis;
    existing.reason = reason.slice(0, 500);
  }
  if (!existing) s.rejected.push({ url, reason: reason.slice(0, 500), host, basis });
  s.rejected = s.rejected.slice(-80);
  job.skippedUrls = [...new Set([...(job.skippedUrls || []), url])].slice(-80);
}
export function selectedDiscoveryLink(job: Job, o: Observation, url?: string) {
  if (!url || discoveryPageKey(url) === discoveryPageKey(o.url) || excludedSource(job, url)) return;
  const link =
    o.elements.find((e) => e.href === url) ||
    discoveryState(job).frontier.find((e) => e.url === url);
  if (unrelatedDiscoveryLink(job, { url, label: link?.label || '' })) return;
  // A visited list is still an observed destination after leaving the frontier.
  if (job.visitedUrls?.includes(url)) return url;
  return link && readableLink(url, link.label + ' ' + (link.context || ''), o.url)
    ? url
    : undefined;
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
    formSearch: formDiscovery(job)
      ? {
          preferred: preferredForm(job),
          strategy:
            'Prefer actual respondent form links and organizer survey notices with prizes. Forms product pages, survey software tutorials, blog tags and administrative plans are not entry opportunities. Generic event footers are not evidence of a survey. Preserve target provider and page-count requirements; do not invent personal experience.',
          queryApproaches: [
            '현재 연월 홈페이지 만족도 조사 경품',
            `현재 연월 설문 이벤트 ${preferredForm(job) === 'google' ? '구글폼' : preferredForm(job) === 'naver' ? '네이버폼' : '참여'}`,
            '현재 연월 온라인 의견 조사 추첨',
            '현재 연월 기관 홈페이지 이용자 만족도 설문 커피',
          ],
        }
      : undefined,
    preferredEngine: job.searchEngine || 'naver',
    blockedEngines: s.blockedEngines,
    recentSearches: s.searches.slice(-8),
    rejectedSources: s.rejected.slice(-12),
    freshLinks: eligibleFrontier(job).slice(0, 16),
    filteredLinks: s.filteredLinks?.slice(-8),
    rejectedSinceSearch: s.rejectedSinceSearch || 0,
    switches: s.switches,
    switchLimit: discoverySwitchLimit(job),
    replans: s.replans || 0,
    needsFreshSearch: !!s.needsFreshSearch,
    remainingDecisions: job.maxSteps - job.steps,
    readsWithoutNewLinks: s.readCounts?.[discoveryPageKey(job.currentUrl || job.startUrl)] || 0,
  };
}
export type DiscoveryRoute = { url: string; reason: string; engine?: Engine; query?: string };
export function nextDiscoverySource(job: Job): DiscoveryRoute | undefined {
  if (job.steps >= job.maxSteps || discoveryState(job).switches >= discoverySwitchLimit(job))
    return;
  // General/SNS discovery keeps its observed-link-first fallback. Form goals
  // must pass the relevance and replan checks rather than draining every link.
  const link = !formDiscovery(job) && eligibleFrontier(job)[0];
  return link
    ? { url: link.url, reason: `관측된 다음 출처를 확인합니다: ${link.label.slice(0, 100)}` }
    : nextDiscoveryRoute(job);
}
// Read-only alternatives are either standard search URLs or actually observed links.
// No candidate is invented, and this function cannot authorize entry actions.
export function nextDiscoveryRoute(
  job: Job,
  query?: string,
  from?: Engine,
): DiscoveryRoute | undefined {
  const s = discoveryState(job);
  if (s.switches >= discoverySwitchLimit(job) || job.steps >= job.maxSteps) return;
  if (discoveryNeedsReplan(job)) return;
  const fresh = eligibleFrontier(job);
  const current = from || job.searchEngine || 'naver';
  const relevantForm =
    formDiscovery(job) &&
    fresh.find(
      (v) =>
        formLinkScore(v, job) >= 10 &&
        !s.visited.includes(discoveryPageKey(v.url)) &&
        !excludedSource(job, v.url),
    );
  if (relevantForm)
    return {
      url: relevantForm.url,
      reason: `관측한 폼·설문 후보를 우선 확인합니다: ${relevantForm.label.slice(0, 100)}`,
    };
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
  const link = fresh.find((v) => !formDiscovery(job) || nextPageLink(v.url, v.label, v.source));
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
  const stagnant =
    !s.needsFreshSearch && previous.filter((v) => v.step >= s.lastProgressStep).length >= 3;
  if (s.blockedEngines.includes(engine) || exact || similar >= 2 || stagnant)
    return {
      route: nextDiscoveryRoute(job, query, engine),
      reason: '동일·유사 검색 반복 또는 새 출처 확보 없는 검색 누적을 감지했습니다.',
    };
}
