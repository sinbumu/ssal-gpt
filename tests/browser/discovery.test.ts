import { selectionKey } from '../../src/selection.js';
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
import {
  discoveryState,
  noteDiscoveryDestination,
  rejectSource,
  excludedSource,
} from '../../src/discovery.js';

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
      // Let the production read-only guard reject writes, including navigation
      // attempted by a page script. Synthetic GET fixtures must not mask it.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(r.request().method())) return r.fallback();
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

test('directory row context observes the primary link only and masks private echoes without reading response rows', async () =>
  fixture(async (app) => {
    await app.browser.context!.route('**/demo/rows', (r) =>
      r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<table><tr><td>설문/투표</td><td><a href="/demo/survey">기관 의견</a></td><td>private-recipient <a href="/demo/gift">커피 경품</a></td></tr>
      <tr><td><a href="/demo/response">응답 링크</a></td><td><input value="never-read"></td></tr>
      <tr><td><a href="/demo/private">개인 링크</a></td><td data-private>never-read</td></tr></table>`,
      }),
    );
    await app.browser.navigate(app.origin + '/demo/rows');
    const o = await app.browser.observe(false, ['private-recipient']);
    assert.match(o.elements.find((e) => e.label === '기관 의견')!.context!, /설문\/투표/);
    assert.ok(!JSON.stringify(o.elements).includes('private-recipient'));
    for (const label of ['커피 경품', '응답 링크', '개인 링크'])
      assert.equal(o.elements.find((e) => e.label === label)!.context, undefined);
  }));

test('rejecting the observed original prevents reopening its directory detail and selects a fresh multi-page form', async () =>
  fixture(async (app, visits) => {
    const list = app.origin + '/demo/catalog';
    const detail = 'https://www.suto.co.kr/cpevent/42';
    const link = 'https://www.suto.co.kr/bbs/link.php?bo_table=cpevent&wr_id=42&no=1';
    const original = 'https://example.org/event/social';
    const form = 'https://form.naver.com/response/new_fixture';
    await app.browser.context!.route('**/*', async (r) => {
      if (r.request().method() !== 'GET') return r.fallback();
      const url = r.request().url();
      if (![list, detail, link, original, form].includes(url)) return r.fallback();
      visits.push(url);
      if (url === link)
        return r.fulfill({
          contentType: 'text/html',
          body: `<script>location.replace(${JSON.stringify(original)})</script>`,
        });
      const body =
        url === list
          ? `<h1>행사 목록</h1><a href="${detail}">퀴즈 이벤트</a><a href="${form}">설문 참여</a>`
          : url === detail
            ? `<h1>퀴즈 이벤트 안내</h1><a href="${link}">응모하기</a>`
            : url === original
              ? '<h1>공식 행사 원문</h1><p>댓글로만 참여합니다.</p>'
              : '<h1>무료 설문 이벤트</h1><p>1/2 · 누구나 참여, 마감 2099년 12월 1일, 커피 10명</p><label>이름<input required></label><button type="button" id="nsv_page_control_next">다음</button>';
      await r.fulfill({ contentType: 'text/html; charset=utf-8', body });
    });
    const j = job(list);
    j.goal = '새 다중페이지 네이버폼 이벤트';
    let calls = 0;
    const runner = new Runner(
      app.store,
      app.browser,
      model((ctx) => {
        calls++;
        assert.equal(ctx.discovery.formSearch.preferred, 'naver');
        if (calls === 1) return { action: 'navigate', url: detail };
        if (calls === 2) return { action: 'navigate', url: link };
        if (calls === 3) {
          assert.equal(ctx.observation.url, original);
          assert.ok(ctx.observation.text.includes('댓글로만 참여합니다.'));
          return {
            action: 'skip_source',
            skipCategory: 'requirements',
            reason: '댓글형 행사여서 폼 조건과 다릅니다.',
            url: list,
          };
        }
        if (calls === 4) return { action: 'navigate', url: detail }; // stale model choice must be intercepted
        assert.equal(ctx.observation.url, form);
        assert.ok(ctx.observation.text.includes('1/2'));
        return {
          action: 'record_event',
          candidate: {
            title: '가상 다중페이지 폼',
            organizer: '가상 기관',
            entryUrl: form,
            deadline: null,
            deadlineDate: '2099-12-01',
            prize: '커피',
            winners: 10,
            requirements: ['설문'],
            blockers: [],
            evidenceQuote: '무료 설문 이벤트',
            evidenceKind: 'text',
            effortMinutes: 3,
          },
        };
      }),
      app.origin,
    );
    app.store.saveJob(j);
    runner.start(j.id);
    await runner.finished();
    const result = app.store.job(j.id)!;
    assert.equal(result.status, 'completed', result.note);
    assert.equal(calls, 5);
    assert.equal(result.maxSteps, 10);
    assert.deepEqual(visits, [list, detail, link, original, list, form]);
    assert.ok(excludedSource(result, detail));
    assert.equal(excludedSource(result, list), false);
    assert.ok(result.history.some((h) => h.action === 'discovery_repeat_prevented'));
    assert.equal(app.store.events()[0]!.entryUrl, form);
    assert.equal(result.uncertain, false);
  }));

test('candidate evidence remains bound to its screenshot despite decorative DOM changes, never another URL', async () => {
  for (const changeUrl of [false, true])
    await fixture(async (app) => {
      const j = job(`${app.origin}/demo/event`);
      j.maxSteps = 1;
      const runner = new Runner(
        app.store,
        app.browser,
        {
          async decide(_p, _i, c: any) {
            if (changeUrl) await app.browser.navigate(`${app.origin}/demo/other`);
            else
              await app.browser.page!.evaluate(() =>
                document.body.append(document.createElement('span')),
              );
            return {
              step: {
                action: 'record_event',
                observationId: c.observation.id,
                reason: '관찰한 원문 보관',
                candidate: {
                  title: '가상 이벤트',
                  organizer: '가상 주최',
                  entryUrl: c.observation.url,
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
              },
              inputTokens: 1,
              outputTokens: 1,
            };
          },
        },
        app.origin,
      );
      app.store.saveJob(j);
      runner.start(j.id);
      await runner.finished();
      assert.equal(app.store.events().length, changeUrl ? 0 : 1);
      assert.equal(app.store.job(j.id)!.status, changeUrl ? 'paused' : 'completed');
      assert.ok(app.store.job(j.id)!.readTraces?.length);
    });
});
test('automatic discovery counts preparable candidates, preserves unready leads and never extends its budget', async () => {
  for (const mode of ['automatic', 'collect', 'capped'])
    await fixture(async (app, visits) => {
      const first = 'https://form.naver.com/response/unready';
      const next = 'https://form.naver.com/response/ready';
      await app.browser.page!.context().route('https://form.naver.com/**', async (r) => {
        visits.push(r.request().url());
        assert.equal(r.request().method(), 'GET');
        await r.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<h1>무료 설문 이벤트</h1><p>국내 한정. 마감 2099년 12월 1일, 커피 10명.</p><a href="${next}">다른 이벤트</a>`,
        });
      });
      const j = job(first);
      if (mode !== 'collect') j.prepareOne = { revision: 'fixture', expires: Date.now() + 10000 };
      j.maxSteps = mode === 'capped' ? 1 : 3;
      let calls = 0;
      const runner = new Runner(
        app.store,
        app.browser,
        model((ctx) => {
          calls++;
          if (calls === 2) {
            assert.equal(ctx.history.at(-1).action, 'candidate_unready');
            assert.match(ctx.history.at(-1).reason, /저장하지 않은 자격/);
            return { action: 'navigate', url: next };
          }
          return {
            action: 'record_event',
            candidate: {
              title: calls === 1 ? '자격 미확인 후보' : '준비 가능한 후보',
              organizer: '가상 주최',
              entryUrl: ctx.observation.url,
              deadline: null,
              deadlineDate: '2099-12-01',
              prize: '커피',
              winners: 10,
              requirements: ['설문'],
              blockers: [],
              evidenceQuote: '무료 설문 이벤트',
              evidenceKind: 'text',
              effortMinutes: 2,
              ...(calls === 1
                ? {
                    eligibility: [
                      { key: 'region', acceptedValues: ['대한민국'], quote: '국내 한정.' },
                    ],
                  }
                : {}),
            },
          };
        }),
        app.origin,
      );
      app.store.saveJob(j);
      runner.start(j.id);
      await runner.finished();
      const result = app.store.job(j.id)!;
      assert.equal(result.maxSteps, mode === 'capped' ? 1 : 3);
      assert.equal(result.steps, mode === 'automatic' ? 3 : 1);
      assert.equal(result.status, mode === 'capped' ? 'paused' : 'completed');
      assert.equal(app.store.events().length, mode === 'automatic' ? 2 : 1);
      assert.equal(app.store.jobs().filter((j) => j.kind === 'apply').length, 0);
      assert.equal(
        app.store.events().find((e) => e.title === '자격 미확인 후보')!.eligibility![0]!.key,
        'region',
      );
      assert.equal(result.approval, undefined);
      assert.equal(result.uncertain, false);
    });
});

test('a prior rejected carousel redirect is skipped and an observed next page is read without manual recovery', async () =>
  fixture(async (app, visits) => {
    const source = 'https://example.org/catalog',
      next = source + '?page=2';
    const post = 'https://www.instagram.com/p/old/?img_index=2';
    const wrapper = 'https://example.org/link?id=old';
    await app.browser.page!.context().route('https://example.org/**', async (r) => {
      assert.equal(r.request().method(), 'GET');
      visits.push(r.request().url());
      await r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<h1>이벤트 목록</h1><a href="${wrapper}">이벤트 원문</a><a href="${next}">2</a>`,
      });
    });
    const prior = job(source);
    prior.selectionKey = selectionKey(app.store);
    prior.status = 'completed';
    prior.prepareOne = { revision: 'same', expires: Date.now() + 10000 };
    rejectSource(prior, post, '친구 태그 필수');
    noteDiscoveryDestination(prior, wrapper, post);
    prior.history = [{ action: 'skip_source', url: post, reason: '친구 태그 필수' }];
    app.store.saveJob(prior);
    const j = job(source);
    j.prepareOne = { ...prior.prepareOne };
    j.maxSteps = 3;
    discoveryState(j).blockedEngines = ['google', 'naver'];
    const runner = new Runner(
      app.store,
      app.browser,
      model((ctx) =>
        ctx.observation.url === source ? { action: 'navigate', url: wrapper } : { action: 'done' },
      ),
      app.origin,
    );
    app.store.saveJob(j);
    runner.start(j.id);
    await runner.finished();
    const result = app.store.job(j.id)!;
    assert.deepEqual(visits, [source, next]);
    assert.equal(result.status, 'completed');
    assert.equal(result.steps, 2);
    assert.equal(result.maxSteps, 3);
    assert.equal(result.discovery?.reusedRejections?.length, 1);
    assert.equal(result.discovery?.switches, 1);
    assert.equal(result.approval, undefined);
    assert.equal(app.store.events().length, 0);
    assert.equal(result.uncertain, false);
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
    assert.deepEqual(app.store.settings('connectionNeeds', []), []);
    assert.deepEqual(app.store.settings('siteConnections', []), []);
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

test('search challenge with no fresh links replans from the last readable page without requesting login', async () =>
  fixture(async (app, visits) => {
    const oldQuery = '오늘 커피',
      newQuery = '공공기관 문화 설문 안내';
    await app.browser.context!.route('https://search.naver.com/**', async (r) => {
      visits.push(r.request().url());
      await r.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>공개 검색 결과</h1>' });
    });
    await app.browser.context!.route('https://www.google.com/search?**', async (r) => {
      visits.push(r.request().url());
      await r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<div id="challenge-running">추가 인증이 필요합니다</div>',
      });
    });
    const j = job(searchUrl(oldQuery));
    let calls = 0;
    const runner = new Runner(
      app.store,
      app.browser,
      model((ctx) => {
        calls++;
        assert.ok(ctx.observation.url.startsWith('https://search.naver.com/'));
        if (calls === 1) return { action: 'search', text: oldQuery, searchEngine: 'google' };
        assert.deepEqual(ctx.discovery.blockedEngines, ['google']);
        if (calls === 2) {
          assert.equal(ctx.discovery.needsFreshSearch, true);
          return { action: 'search', text: newQuery, searchEngine: 'naver' };
        }
        assert.equal(ctx.observation.url, searchUrl(newQuery));
        return { action: 'done' };
      }),
      app.origin,
    );
    app.store.saveJob(j);
    runner.start(j.id);
    await runner.finished();
    const result = app.store.job(j.id)!;
    assert.equal(result.status, 'completed', result.note);
    assert.equal(calls, 3);
    assert.equal(result.discovery!.replans, 1);
    assert.equal(result.maxSteps, 10);
    assert.deepEqual(app.store.settings('connectionNeeds', []), []);
    assert.deepEqual(visits, [
      searchUrl(oldQuery),
      searchUrl(oldQuery, 'google'),
      searchUrl(oldQuery),
      searchUrl(newQuery),
    ]);
  }));

test('a blocked read with no fresh links replans from a fresh public observation without permitting the POST', async () => {
  for (const limit of ['none', 'decisions', 'replans', 'switches', 'engines'] as const)
    await fixture(async (app, visits) => {
      const first = searchUrl('기존 설문 경품'),
        next = searchUrl('공공기관 새 퀴즈'),
        blocked = `${app.origin}/demo/blocked-read`,
        write = `${app.origin}/demo/write`;
      await app.browser.context!.route('https://search.naver.com/**', (r) => {
        visits.push(r.request().url());
        return r.fulfill({
          contentType: 'text/html; charset=utf-8',
          body:
            r.request().url() === first
              ? `<h1>공개 검색 결과</h1><a href="${blocked}">설문 이벤트 원문</a>`
              : '<h1>새 공개 검색 결과</h1>',
        });
      });
      await app.browser.context!.route('**/demo/blocked-read', (r) => {
        visits.push(r.request().url());
        return r.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<h1>공개 안내</h1><iframe name="target"></iframe>
            <form method="post" action="${write}" target="target"></form>
            <script>document.querySelector('form').submit()</script>`,
        });
      });
      const failures: string[] = [];
      app.browser.context!.on('requestfailed', (request) => {
        if (request.url() === write) failures.push(request.failure()?.errorText || '');
      });
      const j = job(first);
      j.maxSteps = limit === 'decisions' ? 1 : 10;
      discoveryState(j).blockedEngines = limit === 'engines' ? ['google', 'naver'] : ['google'];
      discoveryState(j).replans = limit === 'replans' ? 2 : 0;
      discoveryState(j).switches = limit === 'switches' ? 6 : 0;
      let calls = 0;
      let beforeRead: string | undefined;
      const runner = new Runner(
        app.store,
        app.browser,
        model((ctx) => {
          calls++;
          if (calls === 1) {
            beforeRead = ctx.observation.id;
            return { action: 'navigate', url: blocked };
          }
          assert.equal(limit, 'none', 'an exhausted limit must stop before another AI call');
          if (calls === 2) {
            assert.equal(ctx.observation.url, first);
            assert.notEqual(ctx.observation.id, beforeRead, 'fallback re-observes the public page');
            assert.equal(ctx.discovery.needsFreshSearch, true);
            assert.ok(ctx.skippedUrls.includes(blocked));
            return { action: 'search', searchEngine: 'naver', text: '공공기관 새 퀴즈' };
          }
          assert.equal(ctx.observation.url, next);
          return { action: 'done' };
        }),
        app.origin,
      );
      app.store.saveJob(j);
      runner.start(j.id);
      await runner.finished();
      const result = app.store.job(j.id)!;
      assert.equal(result.maxSteps, j.maxSteps);
      assert.equal(result.uncertain, false);
      assert.deepEqual(app.store.settings('connectionNeeds', []), []);
      assert.ok(result.readTraces?.some((t) => t.reason === 'read_only_request_blocked'));
      assert.deepEqual(failures, ['net::ERR_BLOCKED_BY_CLIENT']);
      assert.equal(visits.includes(write), false, 'no POST reaches the synthetic destination');
      assert.equal(
        visits.filter((url) => url === blocked).length,
        1,
        'blocked source is not retried',
      );
      if (limit === 'none') {
        assert.equal(result.status, 'completed', result.note);
        assert.equal(calls, 3);
        assert.equal(result.discovery!.replans, 1);
        assert.equal(result.discovery!.needsFreshSearch, false);
        assert.deepEqual(visits, [first, blocked, first, next]);
      } else {
        assert.equal(result.status, 'paused', result.note);
        assert.equal(calls, 1);
        assert.equal(result.discovery!.replans, limit === 'replans' ? 2 : 0);
        assert.equal(result.discovery!.needsFreshSearch, false);
        assert.deepEqual(visits, [first, blocked]);
      }
    });
});
