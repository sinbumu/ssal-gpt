import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../../src/server.js';
import { syntheticSettings } from '../../src/autonomy.js';
import type { Job } from '../../src/store.js';

async function fixture(
  run: (app: Awaited<ReturnType<typeof createApp>>, page: any) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-life-ui-')),
    app = await createApp({ dir, port: 0, headless: true }),
    ui = await chromium.launch();
  app.scheduler.stop();
  app.auth.bearer = async () => 'synthetic-only';
  app.store.setSettings('selection', { kind: 'api', model: 'fixture' });
  app.store.setSettings('autonomy', {
    ...syntheticSettings,
    policy: { ...syntheticSettings.policy, finalSubmit: 'review' },
  });
  const page = await ui.newPage();
  page.setDefaultTimeout(8000);
  try {
    await run(app, page);
  } finally {
    await ui.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
function seed(app: Awaited<ReturnType<typeof createApp>>, unknown = false) {
  const url = `https://form.naver.com/response/${randomUUID()}`,
    quote = '가상 경품 커피 10명, 마감 2099년 1월 1일, 만족도 응답 후 제출';
  const candidate = {
    title: unknown ? '가상 결과 미확인' : '가상 중단 응모',
    organizer: url,
    entryUrl: url,
    deadline: '2099-01-01T00:00:00Z',
    prize: '커피',
    winners: 10,
    requirements: [],
    blockers: [],
    evidenceQuote: quote,
    evidenceKind: 'text' as const,
    effortMinutes: 2,
  };
  const e = app.store.record(candidate, url, 'old-discovery', 'old.png').event,
    at = new Date().toISOString();
  const j: Job = {
    id: randomUUID(),
    kind: 'apply',
    eventId: e.id,
    startUrl: url,
    goal: '가상 응모',
    status: unknown ? 'submission_unknown' : 'stopped',
    provider: { kind: 'api', model: 'fixture' },
    createdAt: at,
    updatedAt: at,
    candidateLimit: 1,
    maxSteps: 20,
    steps: 3,
    inputTokens: 100,
    outputTokens: 20,
    note: '기존 중단 사유',
    uncertain: unknown,
    allowedOrigins: [new URL(url).origin],
    approvedTexts: [],
    history: [],
  };
  app.store.saveJob(j);
  app.store.claimSubmission(e.id, j.id);
  if (unknown) app.store.markSubmission(e.id, 'unknown');
  return { e, j, candidate };
}
test('dashboard routes stopped entries through drop, restore and manual completion, preserving unknown outcomes and mobile layout', async () =>
  fixture(async (app, page) => {
    const { e, j } = seed(app),
      uncertain = seed(app, true),
      errors: string[] = [];
    const post = async (path: string, body: unknown) => {
      const state = await fetch(app.origin + '/api/state').then((r) => r.json());
      return fetch(app.origin + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
        body: JSON.stringify(body),
      });
    };
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(app.origin);
    const open = async (id: string) => page.locator(`[data-entry-manage="${id}"]`).click();
    await open(e.id);
    await page.locator('#entry-manager [value=dropped]').click();
    await page.waitForFunction(
      () => !document.querySelector('#entry-manager')?.hasAttribute('open'),
    );
    assert.equal(await page.locator(`[data-entry-manage="${e.id}"]`).count(), 0);
    await page.locator('#event-filter').selectOption('dropped');
    await open(e.id);
    await page.locator('#entry-manager [value=active]').click();
    await page.locator('#event-filter').selectOption('unfinished');
    await open(e.id);
    await page.locator('#entry-manager [value=manual]').click();
    await page.waitForFunction(
      () => document.querySelector<HTMLSelectElement>('#event-filter')?.value === 'manual',
    );
    await open(e.id);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page
        .locator('#entry-manager')
        .evaluate((d: HTMLElement) => d.scrollWidth <= d.clientWidth + 1),
    );
    await page.screenshot({ path: '/tmp/ssal-entry-management-mobile.png' });
    await page
      .locator('[data-entry-complete] [name=evidence]')
      .fill('필수 과제 수행 후 접수 완료 화면을 직접 확인했습니다.');
    await page.locator('[data-entry-complete] [name=confirmed]').check();
    await page.locator('[data-entry-complete] button').click();
    await page.locator('#completed-entries .completed-card').waitFor();
    assert.match(await page.locator('#completed-entries').innerText(), /수동 완료 · 사용자 보고/);
    assert.equal(app.store.job(j.id)!.status, 'stopped');
    assert.equal(app.store.job(j.id)!.inputTokens, 100);
    assert.equal(
      (await post(`/api/jobs/${j.id}/verify-result`, {})).ok,
      false,
      'superseded job cannot overwrite manual completion',
    );
    assert.equal(
      (await post(`/api/events/${uncertain.e.id}/retry`, { provider: j.provider })).ok,
      false,
      'unknown outcome cannot start a fresh entry',
    );
    await page.locator('#event-filter').selectOption('unknown');
    await open(uncertain.e.id);
    assert.equal(await page.locator('#entry-manager [value=retry]').count(), 0);
    assert.match(await page.locator('#entry-manager').innerText(), /제출했을 수 있습니다/);
    await page.locator('#entry-manager [value=dropped]').click();
    await page.waitForFunction(
      () => !document.querySelector('#entry-manager')?.hasAttribute('open'),
    );
    assert.equal(app.store.submission(uncertain.e.id)?.state, 'unknown');
    assert.equal(app.store.job(uncertain.j.id)!.uncertain, true);
    assert.deepEqual(errors, []);
  }));

test('dashboard retry uses new screenshots and current conditions, then finishes a synthetic form after the normal final review with one POST', async () =>
  fixture(async (app, page) => {
    const { e, j, candidate } = seed(app);
    let posts = 0,
      reads = 0,
      calls = 0;
    await app.browser.open();
    await app.browser.context!.route('**/*', async (route) => {
      if (route.request().resourceType() !== 'document') return route.abort();
      assert.equal(route.request().url(), e.entryUrl);
      if (route.request().method() === 'POST') {
        posts++;
        await route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '<h1>답변이 제출되었습니다.</h1>',
        });
        return;
      }
      reads++;
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<h1>가상 응모</h1><p>${candidate.evidenceQuote}</p><form method="post"><label>화면 편리성 평가<select name="rating" required><option value="">선택</option><option>그렇다</option></select></label><button type="submit">제출</button></form>`,
      });
    });
    app.runner.model.decide = async (_p, _i, c: any, image) => {
      calls++;
      assert.ok(image.length > 1000);
      const base = { observationId: c.observation.id, reason: '가상 종단 재도전 검증' };
      if (c.mode === 'discover') {
        assert.equal(c.retryTarget.entryUrl, e.entryUrl);
        assert.ok(!c.knownEvents.some((k: any) => k.entryUrl === e.entryUrl));
        return {
          step: { ...base, action: 'record_event', candidate },
          inputTokens: 1,
          outputTokens: 1,
        };
      }
      if (c.observation.text.includes('답변이 제출되었습니다.'))
        return {
          step: { ...base, action: 'done', evidenceQuote: '답변이 제출되었습니다.' },
          inputTokens: 1,
          outputTokens: 1,
        };
      return {
        step: {
          ...base,
          action: 'form_plan',
          answers: c.form.questions.map((q: any) => ({
            questionId: q.id,
            source: 'recommendation',
            category: 'evaluation',
            answer: ['그렇다'],
            reason: '위임된 일반 평가',
          })),
          buttonId: c.form.buttons[0].id,
        },
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    await page.goto(app.origin);
    await page.locator(`[data-entry-manage="${e.id}"]`).click();
    await page.locator('#entry-manager [name=context]').fill('실제 사용자 보충 답변');
    await page.locator('#entry-manager [value=retry]').click();
    await page.waitForFunction(() =>
      document.querySelector('[data-inbox] button')?.textContent?.includes('최종 제출'),
    );
    assert.equal(posts, 0);
    assert.ok(reads >= 2);
    assert.equal(app.store.job(j.id)!.inputTokens, 100);
    const current = app.store.job(String(app.store.submission(e.id)!.job_id))!;
    assert.notEqual(current.id, j.id);
    assert.equal(current.userContext, '실제 사용자 보충 답변');
    const before = calls;
    await page.locator('[data-inbox] button').click();
    await page.locator('#completed-entries .completed-card').waitFor();
    await app.runner.finished();
    assert.equal(posts, 1);
    assert.equal(app.store.submission(e.id)!.state, 'completed');
    assert.ok(calls >= before);
    assert.equal(app.store.job(j.id)!.status, 'stopped');
    assert.equal(app.store.jobs().filter((x) => x.kind === 'discover').length, 1);
  }));
