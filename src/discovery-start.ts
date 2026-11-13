import type { Store } from './store.js';
import { searchUrl } from './evidence.js';

export const DiscoverySources = ['auto', 'culture', 'naver', 'google', 'custom'] as const;
export type DiscoverySource = (typeof DiscoverySources)[number];
export const EVENT_DIRECTORY = 'https://www.suto.co.kr/cpevent';
const CULTURE = 'https://www.culture.go.kr/portal/bbs/B0000101/list.do?menuNo=200031';

// Eligibility stays in the full goal; search keywords do not include negative instructions.
export function discoveryQuery(goal: string, now = Date.now()) {
  const date = new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const positive = goal
    .replace(/(?:구매|방문|친구\s*태그|가입|로그인)[^.!?\n]{0,65}?(?:없이|제외|금지|빼고)/g, ' ')
    .replace(/(?:공식\s*원문|저장된|필요한\s*확인|이미\s*응모)[^.!?\n]*/g, ' ')
    .replace(/(?:찾아|확인해|진행해|준비해|부탁|수집해|골라)[^.!?\n]*/g, ' ')
    .replace(/구글\s*폼/gi, '구글폼')
    .replace(/네이버\s*폼/gi, '네이버폼');
  const stop =
    /^(?:현재|오늘|새로운|새|무료|온라인|온라인으로|참여|참여할|가능한|가능한지|수|있는|있고|할|한|개|건|기회|응모|응모할|이벤트를|이벤트들|경품을|나에게|적합한|조건|서비스|제한|없이|및|또는|그리고|해줘|해주세요|부터|까지|\d+|\d+년|\d+월|\d+일)$/;
  const tokens = (positive.match(/[\p{L}\p{N}]+/gu) || [])
    .map((t) => t.replace(/(?:에서|으로|들을|만을|를|을)$/, ''))
    .filter((t) => !stop.test(t) && t.length > 1)
    .slice(0, 8);
  return [
    ...new Set([date.slice(0, 4), `${Number(date.slice(5, 7))}월`, ...tokens, '이벤트', '경품']),
  ].join(' ');
}

export function discoveryStart(
  store: Store,
  input: { discoverySource?: DiscoverySource; goal: string; sourceUrl?: string },
  now = Date.now(),
) {
  const mode = input.discoverySource || 'auto';
  if (mode === 'custom') {
    if (!input.sourceUrl) throw new Error('discovery_source_required');
    return { mode, url: input.sourceUrl, reason: '직접 지정한 공개 출처에서 시작합니다.' };
  }
  if (mode === 'culture')
    return { mode, url: CULTURE, reason: '지정한 문화포털 목록에서 시작합니다.' };
  const form = /구글\s*폼|google\s*forms?|네이버\s*폼|naver\s*form|설문|만족도|웹\s*폼/i.test(
    input.goal,
  );
  const events = store.events();
  const recent = store
    .jobs()
    .filter(
      (j) =>
        j.kind === 'discover' &&
        j.discoveryStart?.mode === 'auto' &&
        j.startUrl === EVENT_DIRECTORY &&
        (j.status === 'completed' ||
          (j.status === 'paused' &&
            [
              'selection_call_limit',
              'discovery_decision_limit',
              'discovery_no_alternative',
              'discovery_switch_limit',
            ].includes(j.stopReason?.code || ''))) &&
        now - Date.parse(j.updatedAt) < 24 * 60 * 60_000,
    )
    .slice(0, 2);
  const unproductive =
    recent.length === 2 &&
    recent.every((j) => j.steps >= 5 && !events.some((e) => e.jobId === j.id));
  if (mode === 'auto' && !form && !unproductive)
    return {
      mode,
      url: EVENT_DIRECTORY,
      reason:
        '현재 행사 링크가 모인 이벤트 목록에서 시작하고 공식 원문을 확인합니다. 사이트·과제 종류를 제한하지 않습니다.',
    };
  const engine = mode === 'google' ? 'google' : 'naver';
  const query = discoveryQuery(input.goal, now);
  return {
    mode,
    url: searchUrl(query, engine),
    query,
    reason:
      unproductive && mode === 'auto'
        ? '최근 목록 탐색 2건의 성과가 없어 목적에 맞는 짧은 웹 검색으로 전환합니다.'
        : '목적에서 짧은 검색어를 만들고 참여 조건은 별도로 유지합니다.',
  };
}
