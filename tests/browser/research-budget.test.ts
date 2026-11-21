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
      contentType: 'text/html',
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

for (const mode of ['repeat', 'switch', 'budget', 'blocked', 'failed_url'] as const) {
  test(`research ${mode}: bounded requests, shared usage and original form preservation`, async (t) => {
    const { app, job, original } = await fixture(t);
    let calls = 0;
    const engines: string[] = [];
    await app.browser.context!.route(/https:\/\/(search.naver.com|www.google.com)\//, (r) => {
      engines.push(new URL(r.request().url()).hostname);
      return r.fulfill({
        contentType: 'text/html',
        body: `<p>공식 공개 자료를 찾는 가상 검색 결과입니다. 검색 결과는 정답 증거가 아닙니다.</p><a href="https://example.org/failing">원문</a>`,
      });
    });
    if (mode === 'budget') job.steps = 34;
    if (mode === 'failed_url')
      job.autonomy!.researchProgress = {
        calls: 0,
        searches: [],
        failedUrls: ['https://example.org/failing'],
        stops: [],
      };
    if (mode === 'blocked')
      await app.browser.context!.route('https://example.org/failing', (r) =>
        r.fulfill({
          contentType: 'text/html',
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
        if (mode === 'failed_url' || (mode === 'blocked' && calls === 1))
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
      contentType: 'text/html',
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
