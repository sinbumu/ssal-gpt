// Reviewed SGIS rendered controls and public region-list requests, 2026-11-22.
// No event-form controls, arbitrary selectors, scripts or direct data API calls.
export function statisticsPage(raw: string) {
  try {
    const u = new URL(raw);
    return (
      u.origin === 'https://sgis.mods.go.kr' &&
      [
        '/view/index',
        '/view/thematicMap/categoryList',
        '/view/map/interactiveMap',
        '/view/map/interactiveMap/companyView',
        '/view/map/interactiveMap/publicDataView',
        '/view/map/thematicMap',
        '/view/indrStats/indrStatsMap',
        '/view/house/houseAnalysisMap',
        '/publicsmodel/newAging2.vw',
        '/publicsmodel/newAging.vw',
        '/view/syrStats/main',
      ].includes(u.pathname)
    );
  } catch {
    return false;
  }
}

export const statisticsSelectors =
  ',.interactiveSelect,[id^=sidoSelect_] li,[id^=sggSelect_] li,[id^=admSelect_] li,#navi-confirm,#navi-cancel,#publicDataSlide .ui-slider-handle,a[onclick^="pageMove"],.quickBox .radioType label,#housingLayer .area-select-wrap,#housingLayer .area-select,#housingLayer .area-select li,#housingLayer .index-checked li,[data-category][data-id],.sop-overlay-pane svg path.sop-interactive,.radio_ul li[onclick],.tab_ul li[onclick],.graph_ul li[onclick]';

export type StatisticsControl = {
  kind: 'click' | 'select' | 'radius' | 'region' | 'map';
  label: string;
  options?: string[];
  value?: string;
};

// Self-contained for execution in the page; reads rendered DOM only.
export function inspectStatisticsControl(el: HTMLElement): string {
  return JSON.stringify(
    ((): StatisticsControl | undefined => {
      if (
        location.origin !== 'https://sgis.mods.go.kr' ||
        ![
          '/view/map/interactiveMap',
          '/view/map/interactiveMap/companyView',
          '/view/map/interactiveMap/publicDataView',
          '/view/map/thematicMap',
          '/view/indrStats/indrStatsMap',
          '/view/house/houseAnalysisMap',
          '/publicsmodel/newAging.vw',
          '/publicsmodel/newAging2.vw',
          '/view/syrStats/main',
        ].includes(location.pathname)
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
      if (el.matches('.interactiveSelect[id^=location_],#housingLayer .area-select-wrap'))
        return {
          kind: 'region',
          label: '지역 선택: 시도 > 시군구 > 읍면동',
          value: el.innerText.trim().slice(0, 150),
        };
      if (el.matches('.sop-overlay-pane svg path.sop-interactive'))
        return { kind: 'map', label: label || '지도 구역 (화면에서 위치 확인)' };
      const path = location.pathname;
      if (path.startsWith('/publicsmodel/newAging')) {
        if (
          (el.matches('a[onclick^="pageMove"]') &&
            /^pageMove\('newAging(?:2)?'\);?$/.test(el.getAttribute('onclick') || '')) ||
          (el.matches('.quickBox .radioType label') && /노인|노령화/.test(label)) ||
          el.matches('#map_left_btn,a.interactiveDataBoard')
        )
          return { kind: 'click', label };
      }
      if (path === '/view/house/houseAnalysisMap') {
        if (
          (el.matches('button.closelayer,button.black') &&
            label === '닫기' &&
            el.closest('.openguide-wrap')) ||
          el.matches(
            'button.housing,#housingLayer .index-checked li,#housingLayer .area-select,#housingLayer .area-select li,#housingLayer .show-number-on,#housingLayer .show-number-off',
          ) ||
          (el.matches('li[data-category][data-id]') && /^[A-G]\d{3}$/.test(el.dataset.id || '')) ||
          (el.matches('button.inquiry') && label === '조회') ||
          (el.matches('button') && /^(?:선택|적용|확인)$/.test(label) && el.closest('[id^=pop]'))
        )
          return {
            kind: 'click',
            label: el.matches('#housingLayer .show-number-on,#housingLayer .show-number-off')
              ? '통계표출 ' + label
              : el.matches('li[data-category]')
                ? el.querySelector('h3')?.textContent?.trim() || label
                : label,
          };
      }
      if (path === '/view/syrStats/main') {
        if (
          el instanceof HTMLSelectElement &&
          (/^lb[1-4]_/.test(el.id) || el.matches('.selYear,.selStandard,.selSido,.selSgg'))
        ) {
          return {
            kind: 'select',
            label: label || el.id,
            options: [...el.options].filter((o) => !o.disabled).map((o) => o.label.trim()),
            value: el.selectedOptions[0]?.label.trim(),
          };
        }
        if (
          (el.matches('button,li') &&
            /^menuChange\('(?:menu|top|sub|bottom|range)'/.test(
              el.getAttribute('onclick') || '',
            )) ||
          el.matches(
            '.menuItem .btn01,.menuItem .btn02,.menuItem .btn03,[id^=ageTab] li,.selBox li,.radio_ul li[onclick],.tab_ul li[onclick],.graph_ul li[onclick]',
          )
        )
          return { kind: 'click', label };
      }
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
          '#companyBtn a,#publicDataBtn a,#publicDataLeftList a,#publicDataList a,#map_left_btn,a.interactiveDataBoard,#buttonMakeBtn',
        ) &&
          label.length > 0) ||
        (el.matches('a.btn_stepSearch') && label === '검색') ||
        (location.pathname === '/view/indrStats/indrStatsMap' &&
          el.matches(
            'button.life-category,.life_m_wrap button.level_sel,button#industrySearchButton,button#rootSearchButton',
          ))
      )
        return { kind: 'click', label: label || '지역 선택' };
    })() || null,
  );
}

function publicQueryJson(body: string | null, keys: string[]) {
  try {
    const valid = (v: unknown, depth = 0): boolean => {
      if (depth > 5) return false;
      if (v === null || typeof v === 'boolean') return true;
      if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) < 1e8;
      if (typeof v === 'string') return /^[a-zA-Z0-9_.-]{0,80}$/.test(v);
      if (Array.isArray(v)) return v.length <= 100 && v.every((x) => valid(x, depth + 1));
      return (
        !!v &&
        typeof v === 'object' &&
        Object.entries(v).every(([k, x]) => keys.includes(k) && valid(x, depth + 1))
      );
    };
    const value = JSON.parse(body || 'null');
    return !!value && typeof value === 'object' && !Array.isArray(value) && valid(value);
  } catch {
    return false;
  }
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
    const pagePath = new URL(pageUrl).pathname;
    if (pagePath === '/view/syrStats/main') {
      if (
        /^\/view\/syrStats\/(?:ygmnBaseYrList|mainYgmnYrTotList|mainYgmnYrHousPsnList|mainYgmnYrCllUseDtl)$/.test(
          u.pathname,
        )
      )
        return body === '""' || body === '{}';
      if (
        /^\/view\/syrStats\/(?:ygmn(?:Sido|Sgg)List|ygmn(?:Age|AgeBase|Region|Time|TimeBase|Base)?(?:Amt)?ChartData)$/.test(
          u.pathname,
        )
      )
        return publicQueryJson(
          body,
          'baseYear sidoCd sggCd statsIxCd startAge endAge ageCd onePsnFamilyYn menu top sub bottom chkSgg sexCd familyTypeCd range refrnSggCd totStatsIxNm colCnt ordrColNm statsCd'.split(
            ' ',
          ),
        );
    }
    if (
      pagePath === '/view/house/houseAnalysisMap' &&
      /^\/view\/house\/(?:getUpperAreaList|getIndicatorAreaList|getIndicatorRecommendList|getRegionStatusDataList|getHouseStatusDataBySelectedArea|getHouseStatusDataList|getPplSummary|getHouseSummary|getCompanySummary)$/.test(
        u.pathname,
      )
    )
      return publicQueryJson(
        body,
        'regionCd regionCdList classId baseYear admCd base_year adm_cd'.split(' '),
      );
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
      /^\/publicsmodel\/newAging(?:2)?\.vw$/.test(pagePath) &&
      /^\/publicsmodel\/getStatValues_2018(?:_2)?\.do$/.test(u.pathname)
    )
      return (
        keys.length > 0 &&
        [...params].every(([k, v]) =>
          k === 'admin'
            ? /^(?:\d{1,10}|'\d{1,10}'(?:,'\d{1,10}')*)$/.test(v)
            : /^(?:fieldValue|baseYear|kairosbaseYear|kosisbaseYear)$/.test(k)
              ? /^[\d,]{0,150}$/.test(v)
              : k === 'tblId'
                ? /^DT_[A-Z0-9_]{1,40}$/.test(v)
                : /^(?:vlaueFieldNm|adminFieldNm|detailItem|prdSe|addData)$/.test(k) &&
                  /^[A-Za-z0-9_]{0,30}$/.test(v),
        )
      );
    if (
      /^\/view\/map\/interactiveMap(?:\/(?:companyView|publicDataView))?$/.test(pagePath) &&
      u.pathname === '/ServiceAPI/publicData/publicDataList.json'
    )
      return keys.length === 1 && params.get('type') === 'interactiveMap';
    if (
      /^\/view\/map\/interactiveMap(?:\/(?:companyView|publicDataView))?$/.test(pagePath) &&
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
      k === 'base_year'
        ? /^\d{4}$/.test(v)
        : /^(?:sido_cd|sgg_cd|adm_cd|dong_cd)$/.test(k)
          ? /^\d{0,10}$/.test(v)
          : /^(?:is_interactive|is_non_self|eng_yn)$/.test(k) && /^[YN]$/.test(v),
    );
  } catch {
    return false;
  }
}
