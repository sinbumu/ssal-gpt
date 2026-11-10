import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server.js';
import { Runner } from '../../src/runner.js';
import type { ModelClient, Step } from '../../src/model.js';
import type { Job } from '../../src/store.js';
import { searchUrl } from '../../src/evidence.js';

function job(startUrl: string): Job {
  return {
    id: randomUUID(),
    kind: 'discover',
    goal: '무료 인스타 이벤트',
    provider: { kind: 'api', model: 'synthetic' },
    startUrl,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    candidateLimit: 1,
    maxSteps: 10,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    note: '',
    uncertain: false,
    allowedOrigins: [new URL(startUrl).origin],
    approvedTexts: [],
    history: [],
    searchEngine: 'naver',
  };
}
function model(fn: (ctx: any) => Partial<Step>): ModelClient {
  return {
    async decide(_p, _i, ctx: any, image) {
      assert.ok(image.length > 1000);
      assert.equal(ctx.searchEngineOverride, undefined);
      return {
        step: { observationId: ctx.observation.id, reason: '합성 탐색 검증', ...fn(ctx) } as Step,
        inputTokens: 0,
        outputTokens: 0,
      };
    },
  };
}
async function fixture(
  run: (app: Awaited<ReturnType<typeof createApp>>, visits: string[]) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-discovery-'));
  const app = await createApp({ dir, port: 0, headless: true });
  const visits: string[] = [];
  try {
    await app.browser.open();
    await app.browser.page!.context().route('**/*', async (r) => {
      if (r.request().resourceType() !== 'document') return r.abort();
      const url = r.request().url();
      visits.push(url);
      assert.equal(r.request().method(), 'GET', 'discovery never writes');
      const content = url.includes('/event')
        ? '<h1>가상 이벤트</h1><p>무료 댓글 이벤트, 마감 2099년 12월 1일, 가상 경품 10명.</p>'
        : `<h1>이벤트 목록</h1><a href="${app.origin}/demo/event">새 인스타 이벤트</a>`;
      await r.fulfill({ contentType: 'text/html; charset=utf-8', body: content });
    });
    await run(app, visits);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
test('default Naver does not override an explicit model choice of Google', async () =>
  fixture(async (app, visits) => {
    const j = job(searchUrl('첫 검색'));
    let calls = 0;
    const runner = new Runner(
      app.store,
      app.browser,
      model(() =>
        ++calls === 1
          ? { action: 'search', text: '다른 검색', searchEngine: 'google' }
          : { action: 'done' },
      ),
      app.origin,
    );
    app.store.saveJob(j);
    runner.start(j.id);
    await runner.finished();
    assert.equal(visits[1], searchUrl('다른 검색', 'google'));
    assert.equal(app.store.job(j.id)!.searchEngine, 'google');
  }));
test('repeated search switches engine then follows observed frontier and records a new candidate without intervention', async () =>
  fixture(async (app, visits) => {
    const query = '인스타 이벤트 좋아요 댓글 팔로우';
    const j = job(searchUrl(query));
    const runner = new Runner(
      app.store,
      app.browser,
      model((ctx) => {
        if (ctx.observation.url === `${app.origin}/demo/event`)
          return {
            action: 'record_event',
            candidate: {
              title: '가상 이벤트',
              organizer: '가상 주최',
              entryUrl: ctx.observation.url,
              deadline: null,
              deadlineDate: '2099-12-01',
              prize: '가상 경품',
              winners: 10,
              requirements: ['댓글'],
              blockers: [],
              evidenceQuote: '무료 댓글 이벤트',
              evidenceKind: 'text',
              effortMinutes: 2,
            },
          };
        return { action: 'search', text: query, searchEngine: 'naver' };
      }),
      app.origin,
    );
    app.store.saveJob(j);
    runner.start(j.id);
    await runner.finished();
    const result = app.store.job(j.id)!;
    assert.equal(result.status, 'completed', result.note);
    assert.equal(result.steps, 3);
    assert.equal(result.maxSteps, 10);
    assert.deepEqual(visits, [
      searchUrl(query),
      searchUrl(query, 'google'),
      `${app.origin}/demo/event`,
    ]);
    assert.equal(result.discovery!.switches, 2);
    assert.equal(app.store.events().length, 1);
    assert.equal(result.history.filter((h) => h.action === 'discovery_repeat_prevented').length, 2);
  }));
test('search challenge is left untouched and switches engine without showing challenge content to the model', async () =>
  fixture(async (app, visits) => {
    const j = job('https://www.google.com/sorry/index');
    j.searchEngine = 'google';
    const runner = new Runner(
      app.store,
      app.browser,
      model((ctx) => {
        assert.ok(ctx.observation.url.startsWith('https://search.naver.com/'));
        assert.deepEqual(ctx.discovery.blockedEngines, ['google']);
        return { action: 'done' };
      }),
      app.origin,
    );
    app.store.saveJob(j);
    runner.start(j.id);
    await runner.finished();
    assert.equal(app.store.job(j.id)!.status, 'completed');
    assert.equal(visits.length, 2);
    assert.equal(app.store.job(j.id)!.discovery!.rejected.length, 1);
  }));
test('exhausted persisted source budget pauses without approval, submission or extending maxSteps', async () =>
  fixture(async (app, visits) => {
    const j = job(searchUrl('무료 이벤트'));
    j.discovery = {
      searches: [{ engine: 'naver', query: '무료 이벤트', step: 0 }],
      visited: [],
      frontier: [],
      rejected: [],
      blockedEngines: [],
      lastProgressStep: 0,
      switches: 6,
    };
    const runner = new Runner(
      app.store,
      app.browser,
      model(() => ({ action: 'search', text: '무료 이벤트' })),
      app.origin,
    );
    app.store.saveJob(j);
    runner.start(j.id);
    await runner.finished();
    const result = app.store.job(j.id)!;
    assert.equal(result.status, 'paused');
    assert.equal(result.maxSteps, 10);
    assert.equal(result.approval, undefined);
    assert.equal(result.uncertain, false);
    assert.equal(visits.length, 1);
  }));

test('source exclusion keeps the reason and moves only to a rendered new link', async () =>
  fixture(async (app, visits) => {
    const j = job(`${app.origin}/demo/expired`);
    const runner = new Runner(
      app.store,
      app.browser,
      model((ctx) => {
        if (ctx.observation.url.endsWith('/expired'))
          return { action: 'skip_source', reason: '마감이 지난 가상 이벤트' };
        assert.equal(ctx.discovery.rejectedSources[0].reason, '마감이 지난 가상 이벤트');
        return { action: 'done' };
      }),
      app.origin,
    );
    app.store.saveJob(j);
    runner.start(j.id);
    await runner.finished();
    const result = app.store.job(j.id)!;
    assert.deepEqual(visits, [`${app.origin}/demo/expired`, `${app.origin}/demo/event`]);
    assert.equal(result.status, 'completed');
    assert.equal(result.discovery!.switches, 1);
    assert.deepEqual(result.skippedUrls, [j.startUrl]);
  }));

test('model selects the next observed source while excluding an unsuitable page, without spending an automatic recovery', async () =>
  fixture(async (app, visits) => {
    const j = job(`${app.origin}/demo/expired`);
    const runner = new Runner(
      app.store,
      app.browser,
      model((ctx) =>
        ctx.observation.url.endsWith('/expired')
          ? {
              action: 'skip_source',
              reason: '조건 불일치',
              skipCategory: 'requirements',
              url: `${app.origin}/demo/event`,
            }
          : { action: 'done' },
      ),
      app.origin,
    );
    app.store.saveJob(j);
    runner.start(j.id);
    await runner.finished();
    const result = app.store.job(j.id)!;
    assert.equal(result.status, 'completed');
    assert.deepEqual(visits, [`${app.origin}/demo/expired`, `${app.origin}/demo/event`]);
    assert.equal(result.discovery!.switches, 0);
    assert.equal(result.steps, 2);
    assert.ok(result.history.some((h) => h.action === 'skip_source'));
  }));

test('reading a long unproductive source is bounded and switches to another observed source without manual restart', async () =>
  fixture(async (app, visits) => {
    const j = job(`${app.origin}/demo/list`);
    const runner = new Runner(
      app.store,
      app.browser,
      model((ctx) =>
        ctx.observation.url === j.startUrl ? { action: 'scroll', delta: 500 } : { action: 'done' },
      ),
      app.origin,
    );
    app.store.saveJob(j);
    runner.start(j.id);
    await runner.finished();
    const result = app.store.job(j.id)!;
    assert.equal(result.status, 'completed', result.note);
    assert.deepEqual(visits, [j.startUrl, `${app.origin}/demo/event`]);
    assert.equal(result.steps, 10);
    assert.equal(result.maxSteps, 10);
    assert.equal(result.history.filter((h) => h.action === 'scroll').length, 8);
    assert.ok(result.history.some((h) => h.action === 'discovery_read_stalled'));
  }));

test('an observed iframe redirect loop is abandoned after two attempts without widening navigation permissions', async () =>
  fixture(async (app, visits) => {
    const j = job(`${app.origin}/demo/list`),
      frame = `${app.origin}/demo/loop-target`;
    await app.browser.context!.route('**/demo/list', (r) =>
      r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<a href="${frame}">본문 보기</a><a href="${app.origin}/demo/event">다른 이벤트</a>`,
      }),
    );
    let loops = 0;
    await app.browser.context!.route('**/demo/loop-target', (r) => {
      loops++;
      return r.fulfill({ status: 302, headers: { location: j.startUrl } });
    });
    const runner = new Runner(
      app.store,
      app.browser,
      model((ctx) =>
        ctx.observation.url === j.startUrl
          ? { action: 'navigate', url: frame }
          : { action: 'done' },
      ),
      app.origin,
    );
    app.store.saveJob(j);
    runner.start(j.id);
    await runner.finished();
    const result = app.store.job(j.id)!;
    assert.equal(result.status, 'completed', result.note);
    assert.equal(loops, 2);
    assert.equal(result.steps, 4);
    assert.equal(result.discovery!.switches, 1);
    assert.ok(visits.includes(`${app.origin}/demo/event`));
  }));

test('an exhausted frontier requests a new model search within the existing budget instead of stopping early', async () =>
  fixture(async (app, visits) => {
    const j = job(`${app.origin}/demo/empty`);
    j.discovery = {
      searches: [],
      visited: [],
      frontier: [],
      rejected: [],
      blockedEngines: ['google'],
      lastProgressStep: 0,
      switches: 0,
    };
    await app.browser.context!.route('**/demo/empty', (r) =>
      r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<p>종료된 행사. 다른 링크 없음.</p>',
      }),
    );
    const runner = new Runner(
      app.store,
      app.browser,
      model((ctx) => {
        if (ctx.discovery.needsFreshSearch)
          return { action: 'search', searchEngine: 'naver', text: '다른 주최자 온라인 경품' };
        return ctx.observation.url === j.startUrl
          ? { action: 'skip_source', reason: '종료된 행사' }
          : { action: 'done' };
      }),
      app.origin,
    );
    app.store.saveJob(j);
    runner.start(j.id);
    await runner.finished();
    const result = app.store.job(j.id)!;
    assert.equal(result.status, 'completed', result.note);
    assert.equal(result.steps, 3);
    assert.equal(result.maxSteps, 10);
    assert.equal(result.discovery!.replans, 1);
    assert.equal(result.discovery!.needsFreshSearch, false);
    assert.ok(visits.includes(searchUrl('다른 주최자 온라인 경품')));
  }));

test('failed replanning remains bounded after resume and reports missing sources separately from decision exhaustion', async () =>
  fixture(async (app) => {
    const j = job(`${app.origin}/demo/empty`);
    j.discovery = {
      searches: [],
      visited: [],
      frontier: [],
      rejected: [],
      blockedEngines: ['google'],
      lastProgressStep: 0,
      switches: 0,
      replans: 2,
    };
    await app.browser.context!.route('**/demo/empty', (r) =>
      r.fulfill({ contentType: 'text/html; charset=utf-8', body: '<p>다른 링크 없음.</p>' }),
    );
    const runner = new Runner(
      app.store,
      app.browser,
      model(() => ({ action: 'skip_source', reason: '조건 불일치' })),
      app.origin,
    );
    app.store.saveJob(j);
    runner.start(j.id);
    await runner.finished();
    const result = app.store.job(j.id)!;
    assert.equal(result.status, 'paused');
    assert.equal(result.steps, 1);
    assert.equal(result.discovery!.replans, 2);
    assert.match(result.note, /출처/);
    assert.doesNotMatch(result.note, /판단 한도에 도달/);
    assert.equal(result.approval, undefined);
  }));

test('a model-selected next source uses the normal read failure recovery instead of asking the user to repair it', async () =>
  fixture(async (app, visits) => {
    const j = job(`${app.origin}/demo/expired`),
      blocked = 'https://example.org:8443/event';
    await app.browser.context!.route('**/demo/expired', (r) =>
      r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<a href="${blocked}">다음 이벤트</a><a href="${app.origin}/demo/event">다른 이벤트</a>`,
      }),
    );
    const runner = new Runner(
      app.store,
      app.browser,
      model((ctx) =>
        ctx.observation.url === j.startUrl
          ? {
              action: 'skip_source',
              reason: '종료된 행사',
              url: ctx.skippedUrls.includes(blocked) ? `${app.origin}/demo/event` : blocked,
            }
          : { action: 'done' },
      ),
      app.origin,
    );
    app.store.saveJob(j);
    runner.start(j.id);
    await runner.finished();
    const result = app.store.job(j.id)!;
    assert.equal(result.status, 'completed', result.note);
    assert.ok(result.skippedUrls!.includes(blocked));
    assert.equal(result.approval, undefined);
    assert.equal(visits.includes(blocked), false);
    assert.ok(visits.includes(`${app.origin}/demo/event`));
  }));
