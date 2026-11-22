import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings } from '../../src/autonomy.js';
import { researchQuestion } from '../../src/research.js';
import type { Job } from '../../src/store.js';
import type { Model } from '../../src/model.js';

async function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-research-budget-'));
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
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    note: '',
    uncertain: false,
    allowedOrigins: [app.origin],
    approvedTexts: [],
    history: [],
    autonomy: createAutonomy(syntheticSettings, app.origin, true),
  };
  app.store.setSettings('autonomy', syntheticSettings);
  app.store.saveJob(job);
  await app.browser.navigate(job.startUrl);
  await app.browser.page!.setContent('<label>기존 답변<input value="keep"></label>');
  app.browser.ownerJobId = job.id;
  return { app, job, original: app.browser.page! };
}

const map = 'https://sgis.mods.go.kr/view/map/interactiveMap';
test('blocked background iframe POST does not discard a readable public GET page; top-level POST still stops', async (t) => {
  const { app, original } = await fixture(t);
  const url = app.origin + '/demo/public-read';
  const failed: string[] = [];
  app.browser.context!.on('requestfailed', (r) => {
    if (r.method() === 'POST') failed.push(new URL(r.url()).pathname);
  });
  await app.browser.context!.route(url, (r) =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<h1>공개 통계 안내</h1><p>본 자료는 로그인 없이 읽을 수 있는 공개 조회 안내입니다.</p>
    <iframe hidden name="session"></iframe><form target="session" id="auth" method="post" action="${app.origin}/demo/background-session"></form>
    <script>document.getElementById('auth').submit()</script>`,
    }),
  );
  await app.browser.context!.route(app.origin + '/demo/main-write', (r) =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<form id="write" method="post" action="${app.origin}/demo/main-submit"></form><script>document.getElementById('write').submit()</script>`,
    }),
  );
  await app.browser.inReadOnlyTab(async () => {
    await app.browser.navigate(app.origin + '/demo/fixture');
    let o = await app.browser.observe();
    await app.browser.act({ action: 'navigate', observationId: o.id, url, reason: 'public read' });
    o = await app.browser.observe();
    assert.match(o.text, /공개 통계 안내/);
    assert.ok(failed.includes('/demo/background-session'));
    await assert.rejects(
      app.browser.act({
        action: 'navigate',
        observationId: o.id,
        url: app.origin + '/demo/main-write',
        reason: 'must block',
      }),
      /read_only_request_blocked/,
    );
    assert.ok(failed.includes('/demo/main-submit'));
  });
  assert.equal(app.browser.page, original);
  assert.equal(await original.locator('input').inputValue(), 'keep');
});
test('explicit retry extends only the target legacy job and makes research usable without approving the inbox', async (t) => {
  const { app, job, original } = await fixture(t);
  job.steps = 41;
  job.maxSteps = 60;
  job.inputTokens = 12345;
  job.outputTokens = 678;
  job.status = 'needs_user';
  delete job.autonomy!.researchProgress;
  job.autonomy!.researched = ['public'];
  job.autonomy!.inbox = {
    id: randomUUID(),
    fingerprint: 'fixture',
    createdAt: Date.now(),
    items: [
      {
        id: 'public',
        signature: 'public',
        label: '공식 통계 수치는?',
        kind: 'radio',
        required: true,
        multiple: false,
        options: [{ id: 'one', label: '1' }],
        category: 'knowledge',
        reason: 'answer_required',
      },
    ],
  };
  app.store.saveJob(job);
  const other = { ...job, id: randomUUID() };
  app.store.saveJob(other);
  const savedOther = app.store.job(other.id);
  const config = app.store.settings('autonomy', null);
  const ops = app.store.settings('operations', null);
  const started: string[] = [];
  app.runner.start = (id) => {
    started.push(id);
  };
  const state: any = await fetch(app.origin + '/api/state').then((r) => r.json());
  const request = (extraSteps?: number) =>
    fetch(app.origin + `/api/jobs/${job.id}/retry-research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
      body: JSON.stringify({ extraSteps }),
    });
  const denied = await request();
  assert.equal(denied.status, 409);
  assert.match(await denied.text(), /budget_decision_limit/);
  assert.equal(app.store.job(job.id)!.autonomy!.researchRetries, undefined);
  const r = await request(80);
  assert.equal(r.status, 200);
  const saved = app.store.job(job.id)!;
  assert.deepEqual(
    [saved.steps, saved.maxSteps, saved.inputTokens, saved.outputTokens],
    [41, 140, 12345, 678],
  );
  assert.equal(saved.autonomy!.researchProgress!.priorAllocation, 41);
  assert.equal(saved.autonomy!.researchProgress!.capacity, 93);
  assert.equal(saved.autonomy!.researchRetries, 1);
  assert.deepEqual(saved.autonomy!.researched, []);
  assert.deepEqual(saved.autonomy!.overrides, {});
  assert.equal(saved.autonomy!.finalApproval, undefined);
  assert.equal(saved.uncertain, false);
  assert.deepEqual(app.store.job(other.id), savedOther);
  assert.deepEqual(app.store.settings('autonomy', null), config);
  assert.deepEqual(app.store.settings('operations', null), ops);
  assert.deepEqual(started, [job.id]);
  await app.browser.context!.route('https://search.naver.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<p>공식 자료를 찾아야 하는 공개 통계 검색 결과입니다. 검색 결과의 숫자는 답안 근거로 사용하지 않습니다.</p>',
    }),
  );
  let calls = 0;
  const model = {
    async decide(_p: unknown, _i: string, c: any) {
      calls++;
      return {
        step: { action: 'done', observationId: c.observation.id, reason: 'fixture stop' },
        inputTokens: 10,
        outputTokens: 2,
      };
    },
  } as unknown as Model;
  await researchQuestion(
    app.store,
    app.browser,
    model,
    saved,
    '공개 통계',
    new AbortController().signal,
    { pending: 7 },
  );
  assert.equal(calls, 1);
  assert.equal(saved.steps, 42);
  assert.equal(saved.inputTokens, 12355);
  assert.equal(saved.autonomy!.researchProgress!.calls, 1);
  assert.equal(app.browser.page, original);
  assert.equal(saved.autonomy!.metrics.fields, 0);
});
const mapHtml = `<h1>공개 통계지도</h1><div id="location_mapNavi_1" class="interactiveSelect">지역 선택</div>
<ul id="sidoSelect_mapNavi_1"><li onclick="document.querySelector('#region').textContent=this.textContent">가상도</li></ul>
<label>조사년도<select id="company_year"><option>2023</option><option>2024</option></select></label>
<div><p>임의반경 영역 설정(m)</p><div id="publicDataSlide"><a href="#" class="ui-slider-handle" tabindex="0" style="display:inline-block;width:20px;height:20px;position:relative;left:0%">반경</a></div>
<ul class="rbSlide_controll_bar"><li>100</li><li>300</li><li>500</li><li>1000</li></ul></div>
<p id="region"></p><p id="result">공개 가상 통계 결과 42개</p>
<form><select id="population_year"><option>2024</option></select><button>제출</button></form>
<button id="save">내 자료 저장</button>
<script>let index=0;const h=document.querySelector('.ui-slider-handle');h.onkeydown=e=>{if(e.key==='Home')index=0;else if(e.key==='ArrowRight')index=Math.min(3,index+1);h.style.left=(index*100/3)+'%';};</script>`;

test('statistics lookup uses observed region/year/radius controls and restores the entry form', async (t) => {
  const { app, job, original } = await fixture(t);
  await app.browser.context!.route('https://search.naver.com/**', (r) =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<p>Official source for a synthetic public quiz</p><a href="${map}">통계지도</a>`,
    }),
  );
  await app.browser.context!.route(map, (r) =>
    r.fulfill({ contentType: 'text/html; charset=utf-8', body: mapHtml }),
  );
  let calls = 0;
  const model = {
    async decide(_p: unknown, _i: string, c: any) {
      calls++;
      const o = c.observation;
      let step: any = { action: 'done', observationId: o.id, reason: '공개 결과 읽음' };
      if (calls === 1) step = { ...step, action: 'navigate', url: map };
      if (calls === 2) {
        assert.ok(
          !o.elements.find((e: any) => e.tag === 'select' && e.label === '2024')?.statisticsQuery,
        );
        step = {
          ...step,
          action: 'query',
          ref: o.elements.find((e: any) => e.label === '가상도').ref,
        };
      }
      if (calls === 3)
        step = {
          ...step,
          action: 'query',
          ref: o.elements.find((e: any) => e.statisticsQuery?.kind === 'select').ref,
          text: '2024',
        };
      if (calls === 4)
        step = {
          ...step,
          action: 'query',
          ref: o.elements.find((e: any) => e.statisticsQuery?.kind === 'radius').ref,
          text: '300m',
        };
      if (calls === 5) {
        assert.equal(
          o.elements.find((e: any) => e.statisticsQuery?.kind === 'select').statisticsQuery.value,
          '2024',
        );
        assert.match(
          o.elements.find((e: any) => e.statisticsQuery?.kind === 'radius').statisticsQuery.value,
          /33\.33/,
        );
      }
      return { step, inputTokens: 12, outputTokens: 3 };
    },
  } as unknown as Model;
  await researchQuestion(
    app.store,
    app.browser,
    model,
    job,
    '가상 지역 통계',
    new AbortController().signal,
  );
  assert.equal(calls, 5);
  assert.equal(job.steps, 5);
  assert.equal(job.inputTokens, 60);
  assert.equal(app.browser.page, original);
  assert.equal(await original.locator('input').inputValue(), 'keep');
  assert.ok(job.autonomy!.evidence!.some((e) => e.url === map && e.text.includes('42개')));
});

for (const mode of ['repeat', 'switch', 'budget', 'blocked', 'failed_url', 'retry_url'] as const) {
  test(`research ${mode}: bounded requests, shared usage and original form preservation`, async (t) => {
    const { app, job, original } = await fixture(t);
    let calls = 0;
    const engines: string[] = [];
    await app.browser.context!.route(/https:\/\/(search.naver.com|www.google.com)\//, (r) => {
      engines.push(new URL(r.request().url()).hostname);
      return r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<p>공식 공개 자료를 찾는 가상 검색 결과입니다. 검색 결과는 정답 증거가 아닙니다.</p><a href="https://example.org/failing">원문</a>`,
      });
    });
    if (mode === 'budget') job.steps = 34;
    if (mode === 'failed_url' || mode === 'retry_url')
      job.autonomy!.researchProgress = {
        calls: 0,
        searches: [],
        failedUrls: ['https://example.org/failing'],
        retryUrls: mode === 'retry_url' ? ['https://example.org/failing'] : undefined,
        stops: [],
      };
    let revisits = 0;
    if (mode === 'retry_url')
      await app.browser.context!.route('https://example.org/failing', (r) => {
        revisits++;
        return r.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '<p>공개 자료를 새로 읽는 테스트입니다. 이전 실패 기록을 지우지 않고 한 번만 재방문을 허용합니다.</p><a href="https://example.org/failing">현재 자료</a>',
        });
      });
    if (mode === 'blocked')
      await app.browser.context!.route('https://example.org/failing', (r) =>
        r.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<form method="post" action="https://example.org/write" id="f"></form><script>document.getElementById('f').submit()</script>`,
        }),
      );
    const model = {
      async decide(_p: unknown, _i: string, c: any) {
        calls++;
        const step: any = { observationId: c.observation.id, reason: '가상 조사', action: 'done' };
        if (mode === 'repeat') Object.assign(step, { action: 'search', text: '통계 공개 가상' });
        if (mode === 'switch' && calls === 1)
          Object.assign(step, {
            action: 'search',
            searchEngine: 'google',
            text: '다른 정부 원문 자료',
          });
        if (mode === 'failed_url' || mode === 'retry_url' || (mode === 'blocked' && calls === 1))
          Object.assign(step, { action: 'navigate', url: 'https://example.org/failing' });
        return { step, inputTokens: 10, outputTokens: 2 };
      },
    } as unknown as Model;
    await researchQuestion(
      app.store,
      app.browser,
      model,
      job,
      '가상 공개 통계',
      new AbortController().signal,
    );
    if (mode === 'budget') {
      assert.equal(calls, 0);
      assert.equal(job.steps, 34);
      assert.equal(engines.length, 0);
    }
    if (mode === 'repeat') {
      assert.equal(calls, 1);
      assert.equal(engines.length, 1);
      assert.equal(job.autonomy!.researchProgress!.stops.at(-1)!.code, 'research_repeated_query');
    }
    if (mode === 'switch') {
      assert.deepEqual(engines, ['search.naver.com', 'www.google.com']);
      assert.equal(calls, 2);
    }
    if (mode === 'failed_url') {
      assert.equal(calls, 2);
      assert.equal(engines.length, 1);
    }
    if (mode === 'retry_url') {
      assert.equal(calls, 3);
      assert.equal(revisits, 1);
      assert.deepEqual(job.autonomy!.researchProgress!.failedUrls, ['https://example.org/failing']);
      assert.deepEqual(job.autonomy!.researchProgress!.retryUrls, []);
    }
    if (mode === 'blocked') {
      assert.equal(calls, 2);
      assert.ok(
        job.history.some(
          (h) => h.action === 'research_rejected' && h.reason === 'read_only_request_blocked',
        ),
      );
    }
    assert.equal(app.browser.page, original);
    assert.equal(await original.locator('input').inputValue(), 'keep');
  });
}

test('exhausted legacy job resume refuses before opening a tab or resetting usage', async (t) => {
  const { app, job } = await fixture(t);
  job.steps = job.maxSteps;
  app.store.saveJob(job);
  const before = app.browser.page;
  const state = (await fetch(app.origin + '/api/state').then((r) => r.json())) as any;
  const r = await fetch(app.origin + `/api/jobs/${job.id}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
    body: '{}',
  });
  assert.equal(r.status, 409);
  assert.match(await r.text(), /budget_decision_limit/);
  assert.equal(app.store.job(job.id)!.steps, 40);
  assert.equal(app.store.job(job.id)!.maxSteps, 40);
  assert.equal(app.browser.page, before);
  const ui = await chromium.launch({ headless: true });
  t.after(() => ui.close());
  const dashboard = await ui.newPage();
  await dashboard.goto(app.origin);
  await dashboard
    .getByText(
      '이 작업의 누적 판단 한도를 모두 사용했습니다. 재개나 앱 재시작으로 사용량이 초기화되지 않습니다.',
    )
    .waitFor();
  await dashboard.close();
});

test('lookup rejects stale/unknown options and cannot operate an entry control or leave read-only mode', async (t) => {
  const { app } = await fixture(t);
  await app.browser.context!.route(map, (r) =>
    r.fulfill({ contentType: 'text/html; charset=utf-8', body: mapHtml }),
  );
  await app.browser.inReadOnlyTab(async () => {
    await app.browser.navigate(map);
    let o = await app.browser.observe();
    let select = o.elements.find((e) => e.statisticsQuery?.kind === 'select')!;
    await assert.rejects(
      app.browser.act({
        action: 'query',
        observationId: o.id,
        ref: select.ref,
        text: '2099',
        reason: 'invalid',
      }),
      /statistics_option_not_observed/,
    );
    o = await app.browser.observe();
    select = o.elements.find((e) => e.statisticsQuery?.kind === 'select')!;
    await app.browser
      .page!.locator('#company_year')
      .evaluate((el) => el.insertAdjacentHTML('beforeend', '<option>2025</option>'));
    await assert.rejects(
      app.browser.act({
        action: 'query',
        observationId: o.id,
        ref: select.ref,
        text: '2024',
        reason: 'stale',
      }),
      /stale_observation/,
    );
    o = await app.browser.observe();
    const entry = o.elements.find((e) => e.label === '제출')!;
    await assert.rejects(
      app.browser.act({
        action: 'query',
        observationId: o.id,
        ref: entry.ref,
        reason: 'not lookup',
      }),
      /statistics_query_not_allowed/,
    );
    assert.equal(await app.browser.page!.locator('#company_year').inputValue(), '2023');
  });
  await app.browser.navigate(map);
  const o = await app.browser.observe();
  assert.ok(o.elements.every((e) => !e.statisticsQuery));
  await assert.rejects(
    app.browser.act({
      action: 'query',
      observationId: o.id,
      ref: o.elements.find((e) => e.tag === 'select')!.ref,
      text: '2024',
      reason: 'not read only',
    }),
    /statistics_query_not_allowed/,
  );
});

test('early research stop leaves decisions for dashboard answers, final review and exactly one submission', async (t) => {
  const { app, job } = await fixture(t);
  job.maxSteps = 12;
  job.steps = 5;
  job.autonomy!.synthetic = false;
  job.autonomy!.policy.finalSubmit = 'review';
  const form =
    '<meta charset="utf-8"><form method="post" action="/demo/research-submit"><label>공개 퀴즈 정답<input name="answer" required></label><button type="submit">제출</button></form>';
  let posts = 0;
  await app.browser.context!.route(app.origin + '/demo/**', async (r) => {
    if (r.request().method() === 'POST') {
      posts++;
      return r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<h1>응모가 완료되었습니다.</h1>',
      });
    }
    return r.fulfill({ contentType: 'text/html; charset=utf-8', body: form });
  });
  await app.browser.context!.route('https://search.naver.com/**', (r) =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<p>공식 공개 자료를 찾는 가상 검색 결과입니다. 아직 정답의 근거는 없습니다.</p>',
    }),
  );
  await app.browser.navigate(job.startUrl);
  app.runner.model.decide = (async (_p: unknown, _i: string, c: any) => {
    let step: any = { observationId: c.observation.id, reason: 'fixture' };
    if (!c.form) step = { ...step, action: 'search', text: '가상 공개 통계' };
    else if (!c.researchedQuestions.length)
      step = {
        ...step,
        action: 'research',
        questionId: c.form.questions[0].id,
        text: '가상 공개 통계',
      };
    else
      step = {
        ...step,
        action: 'form_plan',
        buttonId: c.form.buttons[0].id,
        answers: [
          {
            questionId: c.form.questions[0].id,
            category: 'knowledge',
            source: 'unknown',
            reason: '반복 검색을 중단해 정답 직접 확인이 필요합니다.',
          },
        ],
      };
    return { step, inputTokens: 10, outputTokens: 2 };
  }) as any;
  app.store.saveJob(job);
  app.runner.start(job.id);
  await app.runner.finished();
  let saved = app.store.job(job.id)!;
  assert.equal(saved.status, 'needs_user', saved.note);
  assert.equal(saved.steps, 8);
  assert.equal(posts, 0);
  assert.equal(saved.autonomy!.researchProgress!.stops.at(-1)!.code, 'research_repeated_query');
  const post = async (body: unknown) => {
    const s = (await fetch(app.origin + '/api/state').then((r) => r.json())) as any;
    const r = await fetch(app.origin + `/api/jobs/${job.id}/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': s.csrf },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 200, await r.text());
    await app.runner.finished();
    saved = app.store.job(job.id)!;
  };
  await post({
    inboxId: saved.autonomy!.inbox!.id,
    answers: { [saved.autonomy!.inbox!.items[0]!.id]: ['사용자가 확인한 가상 정답'] },
  });
  assert.equal(saved.autonomy!.inbox!.final, true, saved.note);
  assert.equal(posts, 0);
  await post({ inboxId: saved.autonomy!.inbox!.id, confirm: true });
  assert.equal(saved.status, 'completed', saved.note);
  assert.equal(posts, 1);
  assert.equal(saved.maxSteps, 12);
  assert.ok(saved.steps <= 12);
});

test('a planner requesting research with no allocation is routed to the inbox without burning the reserve', async (t) => {
  const { app, job } = await fixture(t);
  job.maxSteps = 12;
  job.steps = 8;
  job.autonomy!.synthetic = false;
  await app.browser.context!.route(job.startUrl, (r) =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<form><label>공개 퀴즈 정답<input name="answer" required></label><button type="submit">제출</button></form>',
    }),
  );
  await app.browser.navigate(job.startUrl);
  let calls = 0;
  app.runner.model.decide = (async (_p: unknown, _i: unknown, c: any) => {
    calls++;
    return {
      inputTokens: 1,
      outputTokens: 1,
      step: {
        action: 'research',
        observationId: c.observation.id,
        questionId: c.form.questions[0].id,
        text: '계속 검색',
        reason: 'fixture ignores budget',
      },
    };
  }) as any;
  app.store.saveJob(job);
  app.runner.start(job.id);
  await app.runner.finished();
  const saved = app.store.job(job.id)!;
  assert.equal(calls, 1);
  assert.equal(saved.steps, 9);
  assert.equal(saved.status, 'needs_user', saved.note);
  assert.equal(saved.autonomy!.inbox!.items.length, 1);
  assert.equal(saved.transmitted, undefined);
});

test('observed map fallback bypasses repeated search, preserves call cap and reads legacy controls', async (t) => {
  const { app, job, original } = await fixture(t);
  const aging = 'https://sgis.mods.go.kr/publicsmodel/newAging.vw';
  job.autonomy!.researchProgress!.searches = ['85세 고령화 통계'];
  job.autonomy!.evidence = [
    {
      id: 'source',
      url: aging,
      title: '고령화현황보기',
      text: '공식 지도',
      screenshot: '',
      observedAt: Date.now(),
      links: [],
    },
  ];
  await app.browser.context!.route(aging, (r) =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<h1>공식 고령화 통계지도</h1><div id="location_mapNavi_1" class="interactiveSelect" onclick="document.querySelector('#picker').hidden=false">가상도</div><div id="picker" hidden><ul id="sidoSelect_mapNavi_1"><li onclick="document.querySelector('#sggSelect_mapNavi_1').hidden=false">가상도</li></ul><ul id="sggSelect_mapNavi_1" hidden><li onclick="document.querySelector('#selected').textContent='가상도 가상군'">가상군</li></ul><span id="selected"></span><div class="navi-action"><button id="navi-confirm" onclick="document.querySelector('.interactiveSelect').textContent=document.querySelector('#selected').textContent;document.querySelector('#picker').hidden=true">확인</button></div></div><div class="quickBox"><ul class="radioType"><li><label onclick="document.querySelector('#data').textContent='가상도 가상군 2024 노인 중 85세 이상 비율 12.3%'">노인 중 85세 이상 비율</label></li></ul></div><p id="data"></p><script>window.Map=function LegacyMap(){};</script>`,
    }),
  );
  let calls = 0;
  const model = {
    async decide(_p: any, _i: any, c: any) {
      calls++;
      const o = c.observation;
      assert.equal(o.url, aging);
      let step: any = { action: 'done', observationId: o.id, reason: 'fixture evidence' };
      if (calls === 1) {
        const e = o.elements.find((e: any) => e.statisticsQuery?.kind === 'region');
        assert.ok(e);
        step = { ...step, action: 'query', ref: e.ref, text: '가상도 > 가상군' };
      }
      if (calls === 2) {
        assert.match(o.text, /가상도 가상군/);
        step = {
          ...step,
          action: 'query',
          ref: o.elements.find((e: any) => e.label === '노인 중 85세 이상 비율').ref,
        };
      }
      if (calls === 3) assert.match(o.text, /12.3%/);
      return { step, inputTokens: 10, outputTokens: 2 };
    },
  } as any;
  const before = { max: job.maxSteps, searches: [...job.autonomy!.researchProgress!.searches] };
  await researchQuestion(
    app.store,
    app.browser,
    model,
    job,
    '고령화 통계 85세',
    new AbortController().signal,
    { hint: '고령화현황보기' },
  );
  assert.equal(calls, 3);
  assert.equal(job.steps, 3);
  assert.equal(job.maxSteps, before.max);
  assert.equal(job.inputTokens, 30);
  assert.deepEqual(job.autonomy!.researchProgress!.searches, before.searches);
  assert.ok(job.history.some((h) => h.action === 'research_map_fallback'));
  assert.equal(app.browser.page, original);
  assert.equal(await original.locator('input').inputValue(), 'keep');
});

test('statistics capability retry preserves exhausted ordinary retries and all charged usage', async (t) => {
  const { app, job } = await fixture(t);
  const s = job.autonomy!;
  s.origin = 'https://sgis.mods.go.kr';
  s.researchRetries = 2;
  delete s.researchVersion;
  s.researchProgress = {
    calls: 6,
    capacity: 20,
    priorAllocation: 3,
    searches: ['old'],
    failedUrls: [],
    stops: [],
  };
  s.researched = ['q'];
  s.inbox = {
    id: 'i',
    fingerprint: 'f',
    createdAt: Date.now(),
    items: [
      {
        id: 'q',
        signature: 'q',
        label: '통계지도 인구 수',
        kind: 'radio',
        required: true,
        multiple: false,
        options: [{ id: 'a', label: '1' }],
        category: 'knowledge',
        reason: 'answer_required',
      },
    ],
  };
  job.status = 'needs_user';
  job.steps = 10;
  job.inputTokens = 123;
  app.store.saveJob(job);
  app.runner.start = () => {};
  const state: any = await fetch(app.origin + '/api/state').then((r) => r.json());
  const request = () =>
    fetch(app.origin + `/api/jobs/${job.id}/retry-research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
      body: '{}',
    });
  assert.equal((await request()).status, 200);
  const saved = app.store.job(job.id)!;
  assert.equal(saved.maxSteps, 40);
  assert.equal(saved.steps, 10);
  assert.equal(saved.inputTokens, 123);
  assert.equal(saved.autonomy!.researchRetries, 2);
  assert.equal(saved.autonomy!.researchProgress!.calls, 6);
  assert.equal(saved.autonomy!.researchProgress!.priorAllocation, 3);
  assert.equal(saved.autonomy!.researchProgress!.capacity, 20);
  assert.deepEqual(saved.autonomy!.researchProgress!.searches, ['old']);
  saved.autonomy!.inbox = s.inbox;
  saved.status = 'needs_user';
  app.store.saveJob(saved);
  assert.match(await (await request()).text(), /research_retry_unavailable/);
});

test('failed search replans to a map discovered in the current observation without inventing a URL', async (t) => {
  const { app, job, original } = await fixture(t);
  const youth = 'https://sgis.mods.go.kr/view/syrStats/main';
  await app.browser.context!.route('https://search.naver.com/**', (r) =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<p>Public source listing with an observed official statistics map link for this question.</p><a href="${youth}">청년 통계</a>`,
    }),
  );
  await app.browser.context!.route(youth, (r) =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<h1>청년통계 지도</h1><p>2024 전체 청년 기준의 공개 통계 자료를 화면에 표시합니다.</p>',
    }),
  );
  let calls = 0;
  const model = {
    async decide(_p: any, _i: any, c: any) {
      calls++;
      if (calls === 1)
        return {
          step: {
            action: 'search',
            text: '청년 통계 공개 자료',
            reason: 'repeat',
            observationId: c.observation.id,
          },
          inputTokens: 1,
          outputTokens: 1,
        };
      assert.equal(c.observation.url, youth);
      return {
        step: { action: 'done', reason: 'read', observationId: c.observation.id },
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  } as any;
  await researchQuestion(
    app.store,
    app.browser,
    model,
    job,
    '청년 통계 공개 자료',
    new AbortController().signal,
    { hint: '청년통계지도' },
  );
  assert.equal(calls, 2);
  assert.equal(job.steps, 2);
  assert.equal(job.maxSteps, 40);
  assert.ok(job.history.some((h) => h.action === 'research_map_fallback' && h.url === youth));
  assert.equal(app.browser.page, original);
});

test('map coordinates must hit the observed SVG region and cannot click an entry control', async (t) => {
  const { app } = await fixture(t);
  await app.browser.context!.route(map, (r) =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<h1>지도 조회</h1><div class="sop-overlay-pane"><svg width="200" height="100"><path class="sop-interactive" d="M0,0H100V100H0Z" onclick="document.querySelector(\'#value\').textContent=\'가상군 12%\'"/></svg></div><p id="value"></p><button onclick="document.querySelector(\'#value\').textContent=\'BAD\'">제출</button>',
    }),
  );
  await app.browser.inReadOnlyTab(async () => {
    await app.browser.navigate(map);
    let o = await app.browser.observe();
    let e = o.elements.find((e) => e.statisticsQuery?.kind === 'map')!;
    assert.ok(e);
    await assert.rejects(
      app.browser.act({
        action: 'query',
        ref: e.ref,
        x: 400,
        y: 400,
        observationId: o.id,
        reason: 'outside',
      }),
      /statistics_map_point_unverified/,
    );
    o = await app.browser.observe();
    e = o.elements.find((e) => e.statisticsQuery?.kind === 'map')!;
    await app.browser.act({
      action: 'query',
      ref: e.ref,
      x: e.x + 20,
      y: e.y + 20,
      observationId: o.id,
      reason: 'visible region',
    });
    o = await app.browser.observe();
    assert.match(o.text, /가상군 12%/);
    assert.doesNotMatch(o.text, /BAD/);
  });
});
