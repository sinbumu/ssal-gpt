import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../../src/server.js';
import { syntheticSettings } from '../../src/autonomy.js';
import { SelectionSchema } from '../../src/selection.js';
import { EVENT_DIRECTORY } from '../../src/discovery-start.js';
import type { Job } from '../../src/store.js';

const original = 'https://www.instagram.com/p/dashboard_fixture/';
const quote =
  '합성 정답을 댓글로 남기세요. 누구나 무료 참여. 경품 커피 10명, 마감 2099년 12월 1일.';
const icon = (text: string) =>
  `<svg aria-label="${text}" width="24" height="24"><title>${text}</title><circle cx="12" cy="12" r="8"/></svg>`;
test('unchanged dashboard defaults start an automatic directory, collect original evidence and prepare one reviewed comment without writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-discovery-ui-')),
    app = await createApp({ dir, port: 0, headless: true }),
    ui = await chromium.launch({ headless: true });
  app.scheduler.stop();
  app.auth.bearer = async () => 'fixture';
  app.store.setSettings('selection', { kind: 'api', model: 'fixture' });
  app.store.setSettings('autonomy', syntheticSettings);
  app.store.setSettings('instagramBrowser', { enabled: true, revision: 'fixture' });
  const visits: string[] = [];
  let writes = 0;
  try {
    await app.browser.open();
    await app.browser.context!.route('https://**/*', async (r) => {
      if (r.request().method() !== 'GET') {
        writes++;
        return r.abort();
      }
      if (r.request().resourceType() !== 'document') return r.abort();
      const url = r.request().url();
      visits.push(url);
      if (url === EVENT_DIRECTORY)
        return r.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<a href="https://cr3.shopping.naver.com/v2/bridge/searchGate?query=event">이벤트 상품 구매</a><a href="${original}">새 댓글 이벤트</a>`,
        });
      assert.equal(url, original);
      return r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><style>body{font:18px sans-serif}nav{position:absolute;left:20px;top:20px}main{margin-left:230px;width:720px}button{padding:12px}textarea{width:400px;height:60px}</style><nav><a href="/fixture_user/"><img width="40" height="40" alt="fixture_user 프로필 사진" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E"></a></nav><main><div id="post"><header><a href="/fixture_host/">fixture_host</a><button>팔로우</button></header><p>${quote}</p><section><button>${icon('좋아요')}</button><button>${icon('댓글 달기')}</button></section><section><form onsubmit="return false"><textarea placeholder="댓글 달기..."></textarea><button>게시</button></form></section></div></main>`,
      });
    });
    app.runner.model.decide = async (_p, _i, c: any) => {
      assert.ok(c.selectionPolicy, 'selection criteria also belong to the discovery prompt');
      const o = c.observation;
      return {
        step:
          o.url === EVENT_DIRECTORY
            ? {
                action: 'navigate',
                url: original,
                observationId: o.id,
                reason: '관측한 공식 이벤트',
              }
            : {
                action: 'record_event',
                observationId: o.id,
                reason: '원문 확인',
                candidate: {
                  title: '가상 대시보드 이벤트',
                  organizer: '가상 주최자',
                  entryUrl: original,
                  deadline: '2099-12-01T00:00:00Z',
                  prize: '커피',
                  winners: 10,
                  requirements: ['댓글 남기기'],
                  blockers: [],
                  evidenceQuote: quote,
                  evidenceKind: 'text',
                  effortMinutes: 1,
                  tasks: [
                    {
                      id: 'comment',
                      kind: 'comment',
                      url: original,
                      instruction: '합성 정답 댓글',
                      quote: '합성 정답을 댓글로 남기세요.',
                      dependsOn: [],
                      draft: '합성 정답',
                    },
                  ],
                },
              },
        inputTokens: 10,
        outputTokens: 2,
      };
    };
    const page = await ui.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(app.origin);
    await page.locator('#model option[value=fixture]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#discovery-source').inputValue(), 'auto');
    assert.equal(await page.locator('#candidate-limit').inputValue(), '1');
    assert.equal(await page.locator('#prepare-one').isChecked(), true);
    const [r] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/jobs') && r.request().method() === 'POST'),
      page.locator('#discover-form button[type=submit]').click(),
    ]);
    assert.equal(r.status(), 201, await r.text());
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLTextAreaElement>('[data-task-review] textarea')?.value ===
        '합성 정답',
    );
    const jobs = app.store.jobs(),
      parent = jobs.find((j) => j.kind === 'discover')!,
      child = jobs.find((j) => j.parentId === parent.id)!;
    assert.equal(parent.status, 'completed');
    assert.equal(parent.steps, 2);
    assert.equal(child.status, 'needs_user');
    assert.equal(parent.discoveryStart?.mode, 'auto');
    assert.equal(child.tasks?.[0]?.draft, '합성 정답');
    assert.ok(visits.every((u) => u === EVENT_DIRECTORY || u === original));
    assert.equal(writes, 0);
  } finally {
    await ui.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dashboard and resume endpoint agree on policy 60 versus requested 80, including failed calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-budget-ui-')),
    app = await createApp({ dir, port: 0, headless: true }),
    ui = await chromium.launch({ headless: true });
  app.scheduler.stop();
  try {
    app.store.setSettings(
      'selectionPolicy',
      SelectionSchema.parse({ mode: 'broad', discoveryCalls: 60 }),
    );
    const j = {
      id: randomUUID(),
      kind: 'discover',
      goal: 'fixture',
      provider: { kind: 'api', model: 'fixture' },
      startUrl: original,
      status: 'paused',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      maxSteps: 80,
      steps: 60,
      inputTokens: 1,
      outputTokens: 1,
      note: '한도',
      uncertain: false,
      allowedOrigins: [new URL(original).origin],
      approvedTexts: [],
      history: [],
    } as Job;
    app.store.saveJob(j);
    for (let i = 0; i < 60; i++)
      app.store.db
        .prepare('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?)')
        .run('call' + i, '2026-11-13', j.id, 1, 1, null, 'reported', Date.now());
    const page = await ui.newPage();
    await page.goto(app.origin);
    const card = page.locator(`[data-activity-job="${j.id}"]`);
    await card.waitFor();
    assert.match(await card.innerText(), /AI 호출 60\/60회/);
    assert.match(await card.innerText(), /남은 판단 최대 0회/);
    assert.equal(await card.locator('[data-action=resume]').isDisabled(), true);
    assert.equal(await card.locator('[data-action=resume-current]').isDisabled(), true);
    await page.locator('#step-limit').selectOption('80');
    assert.match(await page.locator('#discovery-budget-hint').innerText(), /최대 60회/);
    const state = await (await page.request.get(app.origin + '/api/state')).json();
    const response = await page.request.post(app.origin + `/api/jobs/${j.id}/resume`, {
      headers: { 'X-Ssal-Token': state.csrf },
      data: { extraSteps: 20 },
    });
    assert.equal(response.status(), 400);
    assert.equal(app.store.job(j.id)!.maxSteps, 80);
    assert.equal(app.runner.isBusy(), false);
  } finally {
    await ui.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
