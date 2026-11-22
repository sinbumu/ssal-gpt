import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extendDecisionBudget,
  researchBudget,
  repeatedSearch,
  searchTerms,
} from '../src/research-policy.js';
import { statisticsPage, statisticsReadRequest } from '../src/statistics-query.js';
import { jobNotice } from '../src/job-notice.js';
import type { Job } from '../src/store.js';

const job = (steps: number, calls = 0) =>
  ({ maxSteps: 40, steps, autonomy: { researchProgress: { calls } } }) as Job;
test('explicit extension grants research to an exhausted legacy job without resetting usage', () => {
  const legacy = {
    maxSteps: 40,
    steps: 40,
    inputTokens: 12345,
    outputTokens: 678,
    autonomy: { researched: ['prior-question'] },
  } as Job;
  assert.equal(researchBudget(legacy).remaining, 0);
  assert.equal(extendDecisionBudget(legacy, 20), 20);
  legacy.autonomy!.researched = [];
  assert.deepEqual(researchBudget(legacy, 7), { reserve: 9, remaining: 11, allowance: 2 });
  assert.equal(legacy.autonomy!.researchProgress!.priorAllocation, 40);
  assert.deepEqual([legacy.steps, legacy.inputTokens, legacy.outputTokens], [40, 12345, 678]);
  const restored = JSON.parse(JSON.stringify(legacy));
  assert.deepEqual(researchBudget(restored), researchBudget(legacy));
  restored.steps = 51;
  assert.equal(researchBudget(restored).remaining, 0);
});
test('extensions preserve research history and actual calls and respect the job ceiling', () => {
  const j = job(28, 26);
  j.autonomy!.researchProgress!.searches = ['previous'];
  j.autonomy!.researchProgress!.stops = [{ code: 'research_no_progress', at: 1 }];
  assert.equal(extendDecisionBudget(j, 80), 80);
  assert.equal(researchBudget(j, 7).allowance, 8);
  assert.equal(j.autonomy!.researchProgress!.calls, 26);
  assert.deepEqual(j.autonomy!.researchProgress!.searches, ['previous']);
  assert.equal(j.autonomy!.researchProgress!.stops.length, 1);
  j.maxSteps = 295;
  assert.equal(extendDecisionBudget(j, 20), 5);
  assert.equal(j.maxSteps, 300);
  assert.equal(extendDecisionBudget(j, 80), 0);
});
test('research shares the existing cap and reserves planning/input/review decisions across restarts', () => {
  assert.deepEqual(researchBudget(job(2), 7), { reserve: 6, remaining: 26, allowance: 4 });
  assert.equal(researchBudget(job(12, 25)).allowance, 1);
  assert.equal(researchBudget(job(34)).allowance, 0);
  assert.equal(researchBudget(job(40)).allowance, 0);
  const restored = JSON.parse(JSON.stringify(job(18, 26)));
  assert.equal(researchBudget(restored).allowance, 0);
  assert.equal(restored.steps, 18);
  assert.equal(restored.maxSteps, 40);
  assert.match(jobNotice({ ...job(40), status: 'paused' })!.reason, /초기화되지/);
});
test('reordered near-identical search and site-only edits cannot reset research progress', () => {
  const p = [searchTerms('SGIS 해밀동 2024 1인 가구 증감률')];
  assert.equal(repeatedSearch(p, 'site:sgis.mods.go.kr 해밀동 1인 가구 SGIS 2024 증감률?'), true);
  assert.equal(repeatedSearch(p, 'SGIS 초량3동 2024 사업체 수'), false);
});
test('statistics POST exceptions are exact public reads, never general SGIS or form writes', () => {
  const page = 'https://sgis.mods.go.kr/view/map/interactiveMap';
  const region = 'https://sgis.mods.go.kr/ServiceAPI/map/sggAddressList.json';
  assert.ok(statisticsReadRequest(page, 'POST', region, 'sido_cd=11&base_year=2024'));
  for (const body of ['sido_cd=11&name=Alice', 'sido_cd=11&sido_cd=12', 'base_year=anything'])
    assert.equal(statisticsReadRequest(page, 'POST', region, body), false);
  for (const url of [
    region + '?extra=1',
    region.replace('sgis.mods', 'evil.mods'),
    'https://sgis.mods.go.kr/ServiceAPI/quiz/quiz.json',
  ])
    assert.equal(statisticsReadRequest(page, 'POST', url, 'sido_cd=11'), false);
  assert.equal(
    statisticsReadRequest('https://sgis.mods.go.kr/jsp/event/test', 'POST', region, 'sido_cd=11'),
    false,
  );
  assert.equal(statisticsPage(page.replace('/interactiveMap', '/interactiveMapFake')), false);
  const radius = 'https://sgis.mods.go.kr/ServiceAPI/publicData/circleAreaFullInfo.json';
  assert.ok(
    statisticsReadRequest(
      page,
      'POST',
      radius,
      'area=CIRCLE(1000000 2000000,300)&bnd_year=2024&tot_list=123,456',
    ),
  );
  assert.equal(
    statisticsReadRequest(page, 'POST', radius, 'area=CIRCLE(1000000 2000000,99999)'),
    false,
  );
  const industry = 'https://sgis.mods.go.kr/view/indrStats/indrStatsMap';
  const target = 'https://sgis.mods.go.kr/view/indrStats/industry/data-board/biz';
  const params = {
    industrySearch: { indrCd: 'L200', sidoCd: '33', baseYear: '2024', isSgg: false },
  };
  assert.ok(statisticsReadRequest(industry, 'POST', target, JSON.stringify(params)));
  assert.equal(
    statisticsReadRequest(
      industry,
      'POST',
      target,
      JSON.stringify({ ...params, phone: '01012345678' }),
    ),
    false,
  );
  assert.equal(
    statisticsReadRequest(industry, 'POST', target, JSON.stringify({ url: 'https://evil.test' })),
    false,
  );
});
