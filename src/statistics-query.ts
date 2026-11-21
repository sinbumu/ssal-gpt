// Reviewed SGIS rendered controls and public region-list requests, 2026-11-22.
// No event-form controls, arbitrary selectors, scripts or direct data API calls.
export function statisticsPage(raw: string) {
  try {
    const u = new URL(raw);
    return (
      u.origin === 'https://sgis.mods.go.kr' &&
      [
        '/view/map/interactiveMap',
        '/view/map/thematicMap',
        '/view/indrStats/indrStatsMap',
      ].includes(u.pathname)
    );
  } catch {
    return false;
  }
}

export const statisticsSelectors =
  ',.interactiveSelect,[id^=sidoSelect_] li,[id^=sggSelect_] li,[id^=admSelect_] li,#navi-confirm,#navi-cancel,#publicDataSlide .ui-slider-handle';

export type StatisticsControl = {
  kind: 'click' | 'select' | 'radius';
  label: string;
  options?: string[];
  value?: string;
};

// Self-contained for execution in the page; reads rendered DOM only.
export function inspectStatisticsControl(el: HTMLElement): StatisticsControl | undefined {
  if (
    location.origin !== 'https://sgis.mods.go.kr' ||
    !['/view/map/interactiveMap', '/view/map/thematicMap', '/view/indrStats/indrStatsMap'].includes(
      location.pathname,
    )
  )
    return;
  const label = (
    el.getAttribute('aria-label') ||
    (el instanceof HTMLSelectElement ? el.getAttribute('title') : '') ||
    el.innerText ||
    el.getAttribute('alt') ||
    el.getAttribute('title') ||
    ''
  ).trim();
  if (
    el.closest('form,[role=dialog]') ||
    /로그인|저장|등록|제출|동의|신청|구매|삭제|다운로드/.test(label)
  )
    return;
  if (
    el instanceof HTMLSelectElement &&
    /^(?:company_year(?:_theme)?|mainIndex_(?:corp_)?year|population_year|household_year|house_year|sidoSelect|year_select[23]?|round_select[23]?)$/.test(
      el.id,
    )
  ) {
    if (el.disabled || el.multiple) return;
    const options = [...el.options]
      .filter((o) => !o.disabled && !o.hidden)
      .map((o) => o.label.trim());
    if (!options.length || new Set(options).size !== options.length) return;
    return {
      kind: 'select',
      label: label || el.id,
      options,
      value: el.selectedOptions[0]?.label.trim(),
    };
  }
  const radiusPanel = el.closest('#publicDataSlide')?.parentElement;
  if (
    el.matches('#publicDataSlide .ui-slider-handle') &&
    radiusPanel?.innerText.includes('임의반경 영역 설정(m)') &&
    [...radiusPanel.querySelectorAll('.rbSlide_controll_bar li')]
      .map((li) => li.textContent?.trim())
      .join(',') === '100,300,500,1000'
  )
    return {
      kind: 'radius',
      label: '임의 영역 반경',
      options: ['100m', '300m', '500m', '1000m'],
      value: el.style.left,
    };
  const region = el.closest('ul[id^=sidoSelect_],ul[id^=sggSelect_],ul[id^=admSelect_]');
  if (
    (region && el.matches('li,a') && /^[가-힣\d·\s()]+$/.test(label)) ||
    el.matches(
      '.interactiveSelect[id^=location_],.navi-action #navi-confirm,.navi-action #navi-cancel',
    ) ||
    (el.matches(
      '#companyBtn a,#publicDataBtn a,#map_left_btn,a.interactiveDataBoard,#buttonMakeBtn',
    ) &&
      label.length > 0) ||
    (el.matches('a.btn_stepSearch') && label === '검색') ||
    (location.pathname === '/view/indrStats/indrStatsMap' &&
      el.matches(
        'button.life-category,.life_m_wrap button.level_sel,button#industrySearchButton,button#rootSearchButton',
      ))
  )
    return { kind: 'click', label: label || '지역 선택' };
}

export function statisticsReadRequest(
  pageUrl: string,
  method: string,
  raw: string,
  body: string | null,
) {
  if (!statisticsPage(pageUrl) || method !== 'POST' || (body?.length || 0) > 16000) return false;
  try {
    const u = new URL(raw);
    if (u.origin !== 'https://sgis.mods.go.kr' || u.search) return false;
    if (
      new URL(pageUrl).pathname === '/view/indrStats/indrStatsMap' &&
      /^\/view\/indrStats\/(?:dashboard|analysis\/map-info|industry\/(?:biz-count|data-board\/(?:biz|sales|pop|selected|overview)))$/.test(
        u.pathname,
      )
    ) {
      const keys = new Set(
        'dashboard indrType indrCategory baseYear industrySearch indrProxy cd indrCd sidoCd sggCd selectedYear isSgg selectedIndicators searchSelectedIndicators industrySearchList rootSearch dataBoardSearch region subCategory analysisRequest analysisType rootCompanyRequest rootCompanyType minX maxX minY maxY commercialRequest commercialType guideRequest tooltipsRequest url'.split(
          ' ',
        ),
      );
      const valid = (v: unknown, depth = 0): boolean => {
        if (depth > 6) return false;
        if (v === null || typeof v === 'boolean') return true;
        if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) < 1e8;
        if (typeof v === 'string') return /^[a-zA-Z0-9_.-]{0,40}$/.test(v);
        if (Array.isArray(v)) return v.length <= 100 && v.every((x) => valid(x, depth + 1));
        return (
          !!v &&
          typeof v === 'object' &&
          Object.entries(v).every(
            ([k, x]) => keys.has(k) && (k !== 'url' || x === '') && valid(x, depth + 1),
          )
        );
      };
      const data = JSON.parse(body || 'null');
      return !!data && !Array.isArray(data) && typeof data === 'object' && valid(data);
    }
    const params = new URLSearchParams(body || '');
    const keys = [...params.keys()];
    if (new Set(keys).size !== keys.length) return false;
    if (
      new URL(pageUrl).pathname === '/view/map/interactiveMap' &&
      u.pathname === '/ServiceAPI/publicData/publicDataList.json'
    )
      return keys.length === 1 && params.get('type') === 'interactiveMap';
    if (
      new URL(pageUrl).pathname === '/view/map/interactiveMap' &&
      /^\/ServiceAPI\/publicData\/circleArea(?:TotInfo\.geojson|FullInfo\.json)$/.test(u.pathname)
    )
      return (
        params.has('area') &&
        [...params].every(([k, v]) =>
          k === 'area'
            ? /^CIRCLE\(\d{1,8}(?:\.\d+)? \d{1,8}(?:\.\d+)?,(?:100|300|500|1000)\)$/.test(v)
            : k === 'tot_list'
              ? /^[\d,]{0,12000}$/.test(v)
              : k === 'bnd_year' && /^\d{4}$/.test(v),
        )
      );
    if (!/^\/ServiceAPI\/map\/(?:sido|sgg|adm|all)AddressList\.json$/.test(u.pathname))
      return false;
    return [...params].every(([k, v]) =>
      /^(?:base_year|sido_cd|sgg_cd|adm_cd)$/.test(k)
        ? /^\d{1,10}$/.test(v)
        : /^(?:is_interactive|is_non_self|eng_yn)$/.test(k) && /^[YN]$/.test(v),
    );
  } catch {
    return false;
  }
}
