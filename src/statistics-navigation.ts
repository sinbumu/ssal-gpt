import type { AutonomyState } from './autonomy.js';
import type { SourceEvidence } from './evidence.js';

export const STATISTICS_RESEARCH_VERSION = 'sgis-visible-lookups-v2';
export type StatisticsSource = { url: string; label: string };

export function statisticsRoute(raw: string) {
  try {
    const u = new URL(raw);
    if (u.origin !== 'https://sgis.mods.go.kr' || u.username || u.password) return;
    if (
      !/^\/(?:view\/(?:index|common\/(?:analMapMain|serviceMain)|thematicMap\/categoryList|map\/(?:interactiveMap(?:Main|\/(?:companyView|publicDataView))?|thematicMap)|house\/houseAnalysisMap|syrStats\/main|indrStats\/indrStatsMap)|publicsmodel\/newAging(?:2)?\.vw)?$/.test(
        u.pathname,
      )
    )
      return;
    return u.href;
  } catch {
    return;
  }
}

// Read the destination literal in an observed SGIS menu. Never execute the
// JavaScript href, copy logging calls, or accept an arbitrary script expression.
export function statisticsMenuDestination(page: string, href: string, label: string) {
  if (new URL(page).origin !== 'https://sgis.mods.go.kr') return;
  const match = href
    .replace(/^javascript:/i, '')
    .match(
      /(?:^|;)\s*logWriteAndMove\(\s*'(?:[^'\\]*)'\s*,\s*'(?:[^'\\]*)'\s*,\s*'(?:[^'\\]*)'\s*,\s*'(?:[^'\\]*)'\s*,\s*'(?:[^'\\]*)'\s*,\s*'(?:[^'\\]*)'\s*,\s*'([^'\\]+)'\s*,\s*(?:true|false)\s*\)\s*;?$/,
    );
  if (!match) return;
  return statisticsRoute(new URL(match[1]!, page).href);
}

export function collectStatisticsSources(previous: StatisticsSource[], evidence: SourceEvidence[]) {
  const sources = new Map(previous.map((s) => [s.url, s]));
  for (const e of evidence) {
    if (statisticsRoute(e.url)) sources.set(e.url, { url: e.url, label: e.title });
    for (const url of e.links || []) if (statisticsRoute(url)) sources.set(url, { url, label: '' });
  }
  return [...sources.values()].slice(-60);
}

export function statisticsSourceRank(source: StatisticsSource, hint: string) {
  const path = new URL(source.url).pathname;
  const compact = hint.replace(/\s/g, '');
  if (/청년통계|주택소유청년/.test(compact) && path === '/view/syrStats/main') return 100;
  if (/고령화|85세/.test(compact) && path === '/publicsmodel/newAging.vw') return 110;
  if (/고령화|85세/.test(compact) && path === '/publicsmodel/newAging2.vw') return 90;
  if (/살고싶은|연립.*다세대/.test(compact) && path === '/view/house/houseAnalysisMap') return 100;
  if (/업종통계|생활서비스업/.test(compact) && path === '/view/indrStats/indrStatsMap') return 100;
  if (/통계주제도|1인가구변화/.test(compact) && /categoryList|thematicMap$/.test(path)) return 100;
  if (/사업체/.test(compact) && /companyView$/.test(path)) return 110;
  if (/공공데이터|정부청사역/.test(compact) && /publicDataView$/.test(path)) return 110;
  if (/대화형|사업체|정부청사역/.test(compact) && /interactiveMap$/.test(path)) return 100;
  if (path === '/' || path === '/view/index') return 20;
  return 1;
}

// A capability upgrade permits one deliberate retry, not a reset of the ordinary
// retry counter, search history, research allocation or job/global usage.
export function statisticsUpgradeRetry(state: AutonomyState | undefined) {
  return (
    !!state &&
    state.researchVersion !== STATISTICS_RESEARCH_VERSION &&
    state.origin === 'https://sgis.mods.go.kr' &&
    !!state.inbox?.items.some(
      (q) =>
        q.category === 'knowledge' &&
        /통계|지도|인구|사업체/.test(q.label + ' ' + (q.description || '')),
    )
  );
}
