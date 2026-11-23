import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings } from '../../src/autonomy.js';
import { researchQuestion } from '../../src/research.js';
import type { Job } from '../../src/store.js';

const company = 'https://sgis.mods.go.kr/view/map/interactiveMap/companyView';
const industry = 'https://sgis.mods.go.kr/view/indrStats/indrStatsMap';
async function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-map-recovery-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const job: Job = {
    id: randomUUID(),
    kind: 'apply',
    provider: { kind: 'api', model: 'synthetic' },
    goal: 'test',
    startUrl: app.origin + '/demo/fixture',
    status: 'paused',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    candidateLimit: 1,
    maxSteps: 40,
    steps: 10,
    inputTokens: 1234,
    outputTokens: 56,
    note: '',
    uncertain: false,
    allowedOrigins: [app.origin],
    approvedTexts: [],
    history: [],
    autonomy: createAutonomy(syntheticSettings, app.origin, true),
  };
  job.autonomy!.evidence = [
    {
      id: 'map',
      url: company,
      title: '대화형통계지도',
      text: '공개 사업체 지도',
      screenshot: '',
      observedAt: Date.now(),
    },
  ];
  app.store.saveJob(job);
  await app.browser.navigate(job.startUrl);
  await app.browser.page!.setContent('<input value="original answer">');
  app.browser.ownerJobId = job.id;
  return { app, job, original: app.browser.page! };
}
const question = {
  id: 'quiz',
  signature: 'quiz',
  label: '공개 사업체 수?',
  kind: 'radio' as const,
  required: true,
  multiple: false,
  options: [{ id: '42', label: '42' }],
};

test('map notice dismisses without model call; arbitrary OK and consent remain unavailable', async (t) => {
  const { app, job, original } = await fixture(t);
  await app.browser.context!.route(company, (r) =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<h1>공식 통계 조회</h1><div class="popupWrapper mAlert"><div class="topbar"><a id="myXbtn_test" href="#" onclick="this.closest('.mAlert').remove()">닫기</a></div><div class="messageBox">지도 확대 수준을 확인하세요.</div><a id="okBtn_test" href="#" onclick="window.bad=1">확인</a></div><p>가상군 사업체 수는 42개로 조회됩니다.</p>`,
    }),
  );
  let calls = 0;
  const model: any = {
    decide: async (_p: any, _i: any, c: any) => {
      calls++;
      assert.ok(!c.observation.text.includes('확대 수준'));
      return {
        step: { action: 'done', observationId: c.observation.id, reason: '42개 확인' },
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
  await researchQuestion(
    app.store,
    app.browser,
    model,
    job,
    '대화형통계지도 사업체',
    new AbortController().signal,
    { question },
  );
  assert.equal(calls, 1);
  assert.equal(job.autonomy!.researchProgress!.noticeDismissals, 1);
  assert.equal(job.maxSteps, 40);
  assert.equal(job.steps, 11);
  assert.equal(job.inputTokens, 1235);
  assert.equal(app.browser.page, original);
  assert.equal(await original.locator('input').inputValue(), 'original answer');
  await app.browser.inReadOnlyTab(async () => {
    await app.browser.navigate(company);
    await app.browser
      .page!.locator('.messageBox')
      .evaluate((e) => (e.textContent = '개인정보 제공에 동의하고 제출합니다.'));
    const o = await app.browser.observe();
    assert.ok(!o.elements.some((e) => e.statisticsQuery?.dismiss));
    assert.ok(!o.elements.find((e) => e.label === '확인')?.statisticsQuery);
  });
});

test('industry guide close and separate company lookup controls use actual UI, never delete or consent', async (t) => {
  const { app } = await fixture(t);
  await app.browser.context!.route(industry, (r) =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<h1>공개 지도</h1><div class="dash_view"><div class="dash_wrap"><div class="head"><h2>업종통계지도</h2><button class="dash_close" onclick="this.closest('.dash_view').remove()">닫기</button></div></div></div>`,
    }),
  );
  await app.browser.context!.route(company, (r) =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<h1>전국사업체조사</h1><a id="companySearchBtn" class="btn_stepSearch">검색</a><div id="company_TreeBox"><span class="easytree-title">전체산업</span></div><a class="btnStyle02" href="javascript:$interactiveLeftMenu.ui.addSearchBtn();">산업조건 버튼생성</a><div id="searchBtnResultRgn"><li class="dragItem"><a class="drag" onclick="document.querySelector('p').textContent='가상군 42개'">2024 전체산업 사업체수</a><a class="sqdel">삭제</a></li></div><p>아직 조회 전</p>`,
    }),
  );
  await app.browser.inReadOnlyTab(async () => {
    await app.browser.navigate(industry);
    let o = await app.browser.observe();
    let e = o.elements.find((e) => e.statisticsQuery?.dismiss)!;
    assert.ok(e);
    await app.browser.act({
      action: 'query',
      ref: e.ref,
      observationId: o.id,
      reason: 'close guide',
    });
    assert.equal(await app.browser.page!.locator('.dash_view').count(), 0);
    await app.browser.navigate(company);
    o = await app.browser.observe();
    assert.ok(o.elements.some((e) => e.label.includes('전체 사업체 통계 조회 아님')));
    assert.ok(o.elements.some((e) => e.label === '산업분류 선택: 전체산업'));
    assert.ok(o.elements.some((e) => e.label.startsWith('선택 통계 조건 생성:')));
    assert.ok(!o.elements.find((e) => e.label === '삭제')?.statisticsQuery);
    e = o.elements.find((e) => e.label.startsWith('통계 조회 실행:'))!;
    await app.browser.act({ action: 'query', ref: e.ref, observationId: o.id, reason: 'lookup' });
    assert.equal(await app.browser.page!.locator('p').innerText(), '가상군 42개');
  });
});

for (const repeat of [false, true])
  test(`unexpected read-only query exception is recorded and bounded, repeated=${repeat}`, async (t) => {
    const { app, job, original } = await fixture(t);
    await app.browser.context!.route(company, (r) =>
      r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<h1>공식 지도</h1><select id="company_year"><option>2024</option><option>2023</option></select><p>공개 통계 조회 자료입니다.</p>',
      }),
    );
    const act = app.browser.act.bind(app.browser);
    let queries = 0,
      calls = 0;
    const ids: string[] = [];
    app.browser.act = async (step, ...args) => {
      if (step.action === 'query' && (queries++ === 0 || repeat))
        throw new TypeError('elementHandle.evaluate: temporary map rendering failure');
      return act(step, ...args);
    };
    const model: any = {
      decide: async (_p: any, _i: any, c: any) => {
        calls++;
        ids.push(c.observation.id);
        return {
          step:
            calls <= 2
              ? {
                  action: 'query',
                  ref: c.observation.elements.find((e: any) => e.statisticsQuery?.kind === 'select')
                    .ref,
                  text: '2023',
                  observationId: c.observation.id,
                  reason: 'select year',
                }
              : { action: 'done', observationId: c.observation.id, reason: 'public source read' },
          inputTokens: 2,
          outputTokens: 1,
        };
      },
    };
    await researchQuestion(
      app.store,
      app.browser,
      model,
      job,
      '대화형통계지도 사업체',
      new AbortController().signal,
      { question },
    );
    const a = job.autonomy!.questionResearch![0]!;
    assert.ok(a.finishedAt);
    assert.equal(a.diagnostics![0]!.errorName, 'TypeError');
    assert.match(a.diagnostics![0]!.message, /temporary map rendering/);
    assert.equal(job.autonomy!.researchProgress!.runtimeRecoveries, 1);
    assert.equal(new Set(ids).size, calls);
    assert.equal(calls, repeat ? 2 : 3, JSON.stringify({ history: job.history, attempt: a }));
    assert.equal(a.stopCode, repeat ? 'research_browser_error' : 'research_evidence_review');
    assert.equal(job.maxSteps, 40);
    assert.equal(job.steps, 10 + calls);
    assert.equal(job.inputTokens, 1234 + calls * 2);
    assert.equal(job.uncertain, false);
    assert.equal(job.intent, undefined);
    assert.equal(app.browser.page, original);
    assert.equal(await original.locator('input').inputValue(), 'original answer');
  });

test('animated chart may change after reobservation, but a changed query option is rejected', async (t) => {
  const { app } = await fixture(t);
  await app.browser.context!.route(company, (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<h1>Statistics</h1><select id="company_year"><option>2024</option><option>2023</option></select>',
    }),
  );
  await app.browser.inReadOnlyTab(async () => {
    await app.browser.navigate(company);
    const observe = app.browser.observe.bind(app.browser);
    const o = await observe();
    const e = o.elements.find((e) => e.statisticsQuery?.kind === 'select')!;
    await app.browser.page!.evaluate(() => document.body.appendChild(document.createElement('hr')));
    app.browser.observe = async (...args) => {
      const fresh = await observe(...args);
      await app.browser.page!.evaluate(() =>
        document.body.appendChild(document.createElement('hr')),
      );
      return fresh;
    };
    assert.equal(
      await app.browser.act({
        action: 'query',
        ref: e.ref,
        observationId: o.id,
        text: '2023',
        reason: 'chart animation',
      }),
      true,
    );
    assert.equal(await app.browser.page!.locator('#company_year').inputValue(), '2023');
    app.browser.observe = observe;
    const next = await observe();
    const select = next.elements.find((e) => e.statisticsQuery?.kind === 'select')!;
    await app.browser.page!.evaluate(() =>
      document.querySelector('select')!.appendChild(new Option('2025')),
    );
    await assert.rejects(
      app.browser.act({
        action: 'query',
        ref: select.ref,
        observationId: next.id,
        text: '2024',
        reason: 'changed choices',
      }),
      /stale_observation/,
    );
  });
});

test('model failure still closes the question diagnostic without retrying or losing the original form', async (t) => {
  const { app, job, original } = await fixture(t);
  await app.browser.context!.route(company, (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<h1>Official statistics map</h1><p>Public primary-source statistics with sufficient rendered text.</p>',
    }),
  );
  let calls = 0;
  const model: any = {
    decide: async () => {
      calls++;
      throw new TypeError('provider unexpected response');
    },
  };
  await assert.rejects(
    researchQuestion(
      app.store,
      app.browser,
      model,
      job,
      '대화형통계지도 사업체',
      new AbortController().signal,
      { question },
    ),
    /provider unexpected response/,
  );
  const a = job.autonomy!.questionResearch![0]!;
  assert.equal(calls, 1);
  assert.ok(a.finishedAt);
  assert.equal(a.diagnostics![0]!.phase, 'model');
  assert.equal(a.diagnostics![0]!.recovery, 'stopped');
  assert.equal(app.browser.page, original);
});

test('industry region query follows visible dependent lists and confirms the selected name', async (t) => {
  const { app } = await fixture(t);
  await app.browser.context!.route(industry, (r) =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<h1>업종 통계 지도</h1><div class="location_wrap"><div class="addr_wrap" onclick="document.querySelector('.addres_wrap').hidden=false">가상시</div><div class="addres_wrap" hidden><div class="area01"><ul><li onclick="this.dataset.selected='yes'">가상도</li></ul></div><div class="area02"><ul><li>가상군</li></ul></div><button id="address_ok_btn" onclick="document.querySelector('.addr_wrap').textContent='가상도 가상군';this.parentElement.hidden=true">확인</button></div></div>`,
    }),
  );
  await app.browser.inReadOnlyTab(async () => {
    await app.browser.navigate(industry);
    const o = await app.browser.observe();
    const e = o.elements.find((e) => e.statisticsQuery?.kind === 'region')!;
    assert.ok(e);
    await app.browser.act({
      action: 'query',
      ref: e.ref,
      observationId: o.id,
      text: '가상도 > 가상군',
      reason: 'public area',
    });
    assert.equal(await app.browser.page!.locator('.addr_wrap').innerText(), '가상도 가상군');
  });
});
