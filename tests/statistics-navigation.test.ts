import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectStatisticsSources,
  statisticsMenuDestination,
  statisticsSourceRank,
  statisticsUpgradeRetry,
  STATISTICS_RESEARCH_VERSION,
} from '../src/statistics-navigation.js';
import { statisticsReadRequest } from '../src/statistics-query.js';
import { createAutonomy, syntheticSettings } from '../src/autonomy.js';
const origin = 'https://sgis.mods.go.kr';
test('observed literal SGIS menu destinations are read without executing scripts', () => {
  const menu =
    "javascript:apiLogWrite2('F0','F10','menu','통계','','');logWriteAndMove('A0','02','09','01','','','/view/syrStats/main',false);";
  assert.equal(
    statisticsMenuDestination(origin + '/view/index', menu, ''),
    origin + '/view/syrStats/main',
  );
  for (const bad of [
    menu.replace('/view/syrStats/main', '/jsp/event/submit'),
    menu.replace('/view/syrStats/main', 'https://evil.invalid/view/syrStats/main'),
    menu.replace("'/view/syrStats/main'", 'window.target'),
    menu + 'submit();',
  ])
    assert.equal(statisticsMenuDestination(origin, bad, ''), undefined);
  assert.equal(statisticsMenuDestination('https://evil.invalid', menu, ''), undefined);
  const sources = collectStatisticsSources(
    [],
    [
      {
        url: origin + '/view/index',
        title: 'SGIS',
        links: [origin + '/view/syrStats/main', 'https://evil.invalid'],
      } as any,
    ],
  );
  assert.equal(sources.length, 2);
  assert.ok(
    statisticsSourceRank(sources[1]!, '청년통계지도 주거 이동') >
      statisticsSourceRank(sources[0]!, '청년통계지도 주거 이동'),
  );
});
test('public map POST exceptions reject unrelated routes, private fields and duplicate parameters', () => {
  assert.equal(
    statisticsReadRequest(
      origin + '/view/syrStats/main',
      'POST',
      origin + '/view/syrStats/ygmnBaseChartData',
      JSON.stringify({
        baseYear: '2024',
        refrnSggCd: '',
        totStatsIxNm: null,
        colCnt: 1,
        ordrColNm: 'cnt_value_02',
      }),
    ),
    true,
  );
  for (const body of [
    '{"phone":"01012345678"}',
    '{"baseYear":"2024","url":"https://evil.invalid"}',
  ])
    assert.equal(
      statisticsReadRequest(
        origin + '/view/syrStats/main',
        'POST',
        origin + '/view/syrStats/ygmnBaseChartData',
        body,
      ),
      false,
    );
  const regions = origin + '/ServiceAPI/map/allAddressList.json';
  assert.equal(
    statisticsReadRequest(
      origin + '/view/house/houseAnalysisMap',
      'POST',
      regions,
      'base_year=2024&sido_cd=11&sgg_cd=&dong_cd=',
    ),
    true,
  );
  assert.equal(
    statisticsReadRequest(
      origin + '/view/house/houseAnalysisMap',
      'POST',
      regions,
      'sido_cd=11&sido_cd=12',
    ),
    false,
  );
  assert.equal(
    statisticsReadRequest(origin + '/jsp/event/quiz.jsp', 'POST', regions, 'sido_cd=11'),
    false,
  );
  assert.equal(
    statisticsReadRequest(
      origin + '/view/syrStats/main',
      'POST',
      origin + '/view/syrStats/submit',
      '{}',
    ),
    false,
  );
});
test('capability retry is restricted to unresolved public SGIS questions and one version', () => {
  const s = createAutonomy(syntheticSettings, origin, true);
  s.researchRetries = 2;
  delete s.researchVersion;
  s.inbox = {
    id: 'x',
    fingerprint: 'x',
    createdAt: 0,
    items: [{ category: 'knowledge', label: '통계지도 인구', description: '' } as any],
  };
  assert.equal(statisticsUpgradeRetry(s), true);
  s.researchVersion = STATISTICS_RESEARCH_VERSION;
  assert.equal(statisticsUpgradeRetry(s), false);
  delete s.researchVersion;
  s.origin = 'https://example.org';
  assert.equal(statisticsUpgradeRetry(s), false);
  s.origin = origin;
  s.inbox.items[0]!.category = 'consent';
  assert.equal(statisticsUpgradeRetry(s), false);
});
