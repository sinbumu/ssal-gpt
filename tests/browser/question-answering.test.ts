import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings, type Question } from '../../src/autonomy.js';
import { inspectForm, applyAnswers } from '../../src/forms.js';
import type { Job } from '../../src/store.js';

async function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-question-packets-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  app.store.setSettings('autonomy', syntheticSettings);
  const job: Job = {
    id: randomUUID(),
    kind: 'apply',
    provider: { kind: 'api', model: 'synthetic' },
    goal: '공개 퀴즈 풀이 검증',
    startUrl: app.origin + '/demo/packet-quiz',
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    candidateLimit: 1,
    maxSteps: 20,
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
  await app.browser.navigate(app.origin + '/demo/fixture');
  return { app, job };
}
const quiz = (source: string) => `<form method="post">
<fieldset><legend>두 지역의 합계는?</legend><table><tr><th>지역</th><th>개수</th></tr><tr><td>가상동</td><td>10</td></tr><tr><td>예시동</td><td>20</td></tr></table>
<label><input type="radio" name="sum" value="30" required>30</label><label><input type="radio" name="sum" value="40">40</label></fieldset>
<fieldset><legend>행사의 주제는?</legend><p>이번 행사 주제는 자원 순환입니다.</p>
<label><input type="radio" name="theme" value="reuse" required>자원 순환</label><label><input type="radio" name="theme" value="sports">운동</label></fieldset>
<fieldset><legend>공식 집계의 참여자 수는?</legend><a href="${source}">공식 자료 힌트</a>
<label><input type="radio" name="count" value="42" required>42명</label><label><input type="radio" name="count" value="84">84명</label></fieldset>
<button type="submit">제출</button></form>`;

test('question DOM material includes supporting table and hint links, excludes hidden state and input values, keeps control bindings stable', async (t) => {
  const { app } = await fixture(t);
  const page = app.browser.page!;
  await page.setContent(quiz(app.origin + '/demo/source') + '<aside>무관한 내용</aside>');
  await page
    .locator('fieldset')
    .first()
    .evaluate((el) => {
      el.insertAdjacentHTML(
        'beforeend',
        '<span hidden>숨은 정답표</span><input type="hidden" value="secret-key"><textarea style="display:none">비밀 입력</textarea><script type="application/json">{"answer":999}</script>',
      );
    });
  let { view } = await inspectForm(page);
  assert.match(view.questions[0]!.material!.text, /가상동.*10.*예시동.*20/);
  assert.doesNotMatch(
    JSON.stringify(view.questions.map((q) => q.material)),
    /숨은 정답표|비밀 입력|secret-key|999|무관한 내용/,
  );
  assert.deepEqual(view.questions[2]!.material!.links, [
    { label: '공식 자료 힌트', url: app.origin + '/demo/source' },
  ]);
  const fingerprint = view.fingerprint;
  await applyAnswers(
    page,
    view,
    new Map([[view.questions[0]!.id, ['30']]]),
    () => {},
    new AbortController().signal,
  );
  view = (await inspectForm(page)).view;
  assert.equal(view.fingerprint, fingerprint);
  await page
    .locator('table td')
    .last()
    .evaluate((el) => {
      el.textContent = '21';
    });
  const changed = (await inspectForm(page)).view;
  assert.match(changed.questions[0]!.material!.text, /21/);
  assert.notEqual(
    changed.fingerprint,
    fingerprint,
    'changed supporting definitions need a fresh observation',
  );
});

test('local quiz answers survive a read-only lookup and finish real browser input and single submission without an inbox', async (t) => {
  const { app, job } = await fixture(t);
  const source = app.origin + '/demo/source';
  let posts = 0,
    researchCalls = 0,
    plannerCalls = 0;
  await app.browser.context!.route(job.startUrl, (route) => {
    if (route.request().method() === 'POST') {
      posts++;
      const values = new URLSearchParams(route.request().postData() || '');
      assert.deepEqual(
        [...values],
        [
          ['sum', '30'],
          ['theme', 'reuse'],
          ['count', '42'],
        ],
      );
      app.store.submitDemo(job.id);
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<h1>응모가 완료되었습니다.</h1>',
      });
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: quiz(source) });
  });
  await app.browser.context!.route(source, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<h1>공식 집계</h1><p>가상 행사 최종 참여자 수는 42명입니다. 이 수치는 공식 최종 집계 결과입니다.</p>',
    }),
  );
  await app.browser.navigate(job.startUrl);
  app.browser.ownerJobId = job.id;
  app.runner.model.decide = (async (_p, _i, ctx: any, image: Buffer) => {
    assert.ok(image.length > 1000);
    const base = { observationId: ctx.observation.id, reason: '합성 검증' };
    if (!ctx.form) {
      researchCalls++;
      assert.equal(
        ctx.observation.url,
        source,
        'follow observed same-origin hint instead of search',
      );
      assert.match(ctx.question.material.links[0].label, /힌트/);
      return {
        inputTokens: 20,
        outputTokens: 10,
        step: { ...base, action: 'done', reason: '공식 집계 참여자 42명' },
      };
    }
    if (ctx.observation.text.includes('응모가 완료'))
      return {
        inputTokens: 20,
        outputTokens: 10,
        step: { ...base, action: 'done', evidenceQuote: '응모가 완료되었습니다.' },
      };
    plannerCalls++;
    const evidence = ctx.publicEvidence.find((e: any) => e.url === source);
    if (evidence) assert.equal(ctx.preparedAnswers.length, 2);
    const answers = ctx.form.questions.map((q: Question, i: number) => {
      if (!evidence && i < 2)
        return {
          questionId: q.id,
          category: 'knowledge',
          source: 'question',
          answer: [i === 0 ? '30' : '자원 순환'],
          evidenceQuote: i === 0 ? '가상동 10 예시동 20' : '이번 행사 주제는 자원 순환입니다.',
          reason: i === 0 ? '10+20=30' : '설명에 주제가 명시되어 있습니다.',
        };
      if (evidence && i === 2)
        return {
          questionId: q.id,
          category: 'knowledge',
          source: 'evidence',
          sourceId: evidence.id,
          answer: ['42명'],
          evidenceQuote: '가상 행사 최종 참여자 수는 42명입니다.',
          reason: '원문 집계',
        };
      return {
        questionId: q.id,
        category: 'knowledge',
        source: 'unknown',
        reason: i < 2 ? '기존 준비 답안 사용' : '공식 자료 필요',
      };
    });
    return {
      inputTokens: 20,
      outputTokens: 10,
      step: { ...base, action: 'form_plan', answers, buttonId: ctx.form.buttons[0].id },
    };
  }) as any;
  app.store.saveJob(job);
  app.runner.start(job.id);
  await app.runner.finished();
  const done = app.store.job(job.id)!;
  assert.equal(
    done.status,
    'completed',
    JSON.stringify({ note: done.note, history: done.history, stop: done.stopReason }),
  );
  assert.equal(posts, 1);
  assert.equal(researchCalls, 1);
  assert.equal(plannerCalls, 2);
  assert.equal(done.autonomy!.metrics.inboxBatches, 0);
  assert.equal(done.autonomy!.metrics.fields, 3);
  assert.equal(done.autonomy!.preparedKnowledge!.length, 3);
  assert.equal(done.autonomy!.questionResearch![0]!.calls, 1);
  assert.equal(done.maxSteps, 20);
});

test('dashboard separates failed quiz research from personal answers and preserves prepared evidence on old paused jobs', async (t) => {
  const { app, job } = await fixture(t);
  await app.browser.page!.setContent(quiz(app.origin + '/demo/source'));
  const qs = (await inspectForm(app.browser.page!)).view.questions;
  job.status = 'needs_user';
  job.autonomy!.plan = {
    fingerprint: 'f',
    answers: [
      {
        questionId: qs[0]!.id,
        category: 'knowledge',
        source: 'evidence',
        sourceId: 'e',
        answer: ['30'],
        evidenceQuote: '공식 합계 30',
        reason: '공식 집계',
      },
    ],
  };
  job.autonomy!.evidence = [
    {
      id: 'e',
      url: app.origin + '/demo/source',
      title: '자료',
      text: '공식 합계 30',
      screenshot: '',
      observedAt: 1,
    },
  ];
  job.autonomy!.inbox = {
    id: 'inbox',
    fingerprint: 'f',
    createdAt: Date.now(),
    items: [
      { ...qs[2]!, category: 'knowledge', reason: 'answer_required' },
      {
        ...qs[1]!,
        id: 'personal',
        label: '실제 방문 경험은?',
        category: 'fact',
        reason: 'answer_required',
      },
    ],
  };
  job.autonomy!.questionResearch = [
    {
      questionId: qs[2]!.id,
      signature: qs[2]!.signature,
      calls: 2,
      startedAt: 1,
      sourceIds: [],
      stopCode: 'research_controls_or_evidence_unavailable',
      diagnostics: [
        {
          at: 1,
          phase: 'query',
          code: 'statistics_query_unavailable',
          errorName: 'TimeoutError',
          message: '조회 컨트롤이 준비되지 않았습니다.',
          frames: ['browser.ts:12:3'],
          recovery: 'stopped',
        },
      ],
    },
  ];
  app.store.saveJob(job);
  const before = app.store.job(job.id);
  const ui = await chromium.launch({ headless: true });
  t.after(() => ui.close());
  const page = await ui.newPage();
  await page.goto(app.origin);
  const card = page.locator(`[data-activity-job="${job.id}"]`);
  await card.getByText('정답 조사 중단 · 조회 기능 확인', { exact: true }).waitFor();
  await card.getByText('준비된 퀴즈 답안', { exact: false }).click();
  assert.match((await card.textContent()) || '', /공식 합계 30/);
  const form = card.locator('[data-inbox]');
  await form.getByText('조회 오류·복구 상세', { exact: true }).click();
  assert.equal(
    await form.getByText('조회 컨트롤이 준비되지 않았습니다.', { exact: true }).isVisible(),
    true,
  );
  assert.equal(await form.locator('[data-quiz-fields]').isVisible(), false);
  assert.equal(await form.locator('button[type=submit]').isDisabled(), true);
  assert.equal(await form.getByText('실제 방문 경험은?', { exact: true }).isVisible(), true);
  await form.locator('[data-manual-quiz]').check();
  assert.equal(await form.locator('[data-quiz-fields]').isVisible(), true);
  assert.equal(await form.locator('button[type=submit]').isEnabled(), true);
  await page.reload();
  await card.locator('[data-manual-quiz]:checked').waitFor();
  assert.equal(await card.locator('[data-quiz-fields]').isVisible(), true);
  assert.deepEqual(
    app.store.job(job.id),
    before,
    'viewing legacy status must not mutate job or approvals',
  );
});

test('failed lookup records its own cause and keeps solved questions without input or submission', async (t) => {
  const { app, job } = await fixture(t);
  const source = app.origin + '/demo/unavailable-source';
  await app.browser.context!.route(job.startUrl, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: quiz(source),
    }),
  );
  await app.browser.context!.route(source, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<h1>공식 자료</h1><p>현재 화면에는 통계 결과가 없고 조회 도구가 지원되지 않습니다. 나중에 다시 조회해 주세요.</p>',
    }),
  );
  await app.browser.navigate(job.startUrl);
  app.browser.ownerJobId = job.id;
  app.runner.model.decide = (async (_p, _i, ctx: any) => ({
    inputTokens: 10,
    outputTokens: 5,
    step: ctx.form
      ? {
          action: 'form_plan',
          observationId: ctx.observation.id,
          reason: '공개 문제 풀이',
          buttonId: ctx.form.buttons[0].id,
          answers: ctx.form.questions.map((q: Question, i: number) => ({
            questionId: q.id,
            category: 'knowledge',
            source: i === 2 ? 'unknown' : 'question',
            answer: i === 2 ? [] : [i === 0 ? '30' : '자원 순환'],
            evidenceQuote: i === 0 ? '가상동 10 예시동 20' : '이번 행사 주제는 자원 순환입니다.',
            reason: i === 2 ? '자료에 공개 집계가 없습니다.' : '설명과 표에서 풀이',
          })),
        }
      : {
          action: 'needs_user',
          observationId: ctx.observation.id,
          reason: '현재 조회 도구로 결과를 읽을 수 없습니다.',
        },
  })) as any;
  app.store.saveJob(job);
  app.runner.start(job.id);
  await app.runner.finished();
  const stopped = app.store.job(job.id)!;
  assert.match(stopped.note, /정답 조사 중단 1개/);
  assert.equal(stopped.autonomy!.inbox!.items.length, 1);
  assert.equal(stopped.autonomy!.preparedKnowledge!.length, 2);
  assert.equal(
    stopped.autonomy!.questionResearch![0]!.stopCode,
    'research_controls_or_evidence_unavailable',
  );
  assert.equal(stopped.autonomy!.metrics.fields, 0);
  assert.equal(stopped.intent, undefined);
  const state: any = await fetch(app.origin + '/api/state').then((r) => r.json());
  const publicJob = state.jobs.find((j: Job) => j.id === job.id);
  assert.equal(publicJob.notice.category, 'technical');
  assert.equal(publicJob.autonomy.knowledgeSummary.length, 2);
  assert.equal(publicJob.autonomy.inbox.items[0].blocker.calls, 1);
});
