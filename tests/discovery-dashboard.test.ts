import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Job } from '../src/store.js';
import { discoveryStart, discoveryQuery, EVENT_DIRECTORY } from '../src/discovery-start.js';
import {
  discoveryState,
  unrelatedDiscoveryLink,
  noteDiscoveryRead,
  stalledDiscoveryRead,
  rejectDiscoveryCandidate,
  excludedSource,
  discoveryNeedsReplan,
  nextDiscoverySource,
} from '../src/discovery.js';
import { jobBudget, meteredModel } from '../src/operations.js';
import { SelectionSchema } from '../src/selection.js';
import type { Observation } from '../src/browser.js';
const job = () =>
  ({
    id: 'fixture',
    kind: 'discover',
    goal: '온라인 무료 이벤트',
    steps: 0,
    maxSteps: 80,
    inputTokens: 0,
    outputTokens: 0,
    history: [],
    startUrl: EVENT_DIRECTORY,
  }) as unknown as Job;

test('automatic start uses a directory or focused query, preserves explicit sources and learns only from finished empty runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-start-')),
    store = new Store(dir),
    now = Date.parse('2026-11-13T04:00:00Z');
  try {
    const goal =
      '구매·방문·친구 태그 없이 온라인으로 참여할 수 있는 커피·상품권 이벤트를 찾아줘. 공식 원문에서 현재 참여 가능한지 확인해줘.';
    const query = discoveryQuery(goal, now);
    assert.equal(query, '2026 11월 커피 상품권 이벤트 경품');
    assert.equal(discoveryStart(store, { goal }, now).url, EVENT_DIRECTORY);
    assert.match(
      discoveryStart(store, { goal: '새 다중페이지 구글폼 설문 이벤트' }, now).url,
      /search\.naver/,
    );
    assert.equal(
      discoveryStart(
        store,
        { goal, discoverySource: 'custom', sourceUrl: 'https://example.org/event' },
        now,
      ).url,
      'https://example.org/event',
    );
    for (let i = 0; i < 2; i++)
      store.saveJob({
        ...job(),
        id: 'empty' + i,
        status: 'completed',
        steps: 10,
        createdAt: new Date(now - 1000).toISOString(),
        updatedAt: new Date(now - 1000).toISOString(),
        discoveryStart: { mode: 'auto', url: EVENT_DIRECTORY, reason: 'fixture' },
      });
    assert.match(discoveryStart(store, { goal }, now).url, /search\.naver/);
    store.saveJob({
      ...job(),
      id: 'recent-short',
      status: 'completed',
      steps: 3,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      discoveryStart: { mode: 'auto', url: EVENT_DIRECTORY, reason: 'fixture' },
    });
    assert.equal(
      discoveryStart(store, { goal }, now).url,
      EVENT_DIRECTORY,
      'short newer success must break the older failure streak',
    );
    assert.match(
      discoveryStart(store, { goal: 'new Google Forms event' }, now).url,
      /search\.naver/,
    );
    assert.match(
      discoveryStart(store, { goal, discoverySource: 'google' }, now).url,
      /google\.com/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('general discovery filters product/ad destinations without blocking brand notices or real forms', () => {
  const j = job();
  for (const url of [
    'https://cr3.shopping.naver.com/v2/bridge/searchGate?query=event',
    'https://smartstore.naver.com/brand/products/1234',
    'https://search.shopping.naver.com/catalog/1234',
    'https://adcr.naver.com/ad',
  ])
    assert.ok(unrelatedDiscoveryLink(j, { url, label: '무료 이벤트' }), url);
  for (const url of [
    'https://smartstore.naver.com/brand/notices/1234',
    'https://www.instagram.com/p/new/',
    'https://form.naver.com/response/new',
  ])
    assert.equal(unrelatedDiscoveryLink(j, { url, label: '참여 이벤트' }), undefined, url);
  assert.ok(
    unrelatedDiscoveryLink(j, {
      url: 'https://agency.example/docs/1',
      label: '설문조사 용역 계약',
    }),
  );
});
test('one event budget persists across announcement, entry, tabs and CSRF aliases without excluding another event', () => {
  const j = job(),
    announcement = 'https://library.example/nambu/board/view.do?board_idx=7',
    form =
      'https://library.example/nambu/module/quizReq/index.do?search_quiz_month=11&csrfToken=one',
    tab = 'https://library.example/nambu/module/quizReq/index.do';
  const action = { action: 'navigate' as const, observationId: 'o', reason: 'fixture', url: form };
  noteDiscoveryRead(j, announcement, action);
  noteDiscoveryRead(j, form, { ...action, url: tab });
  for (let i = 0; i < 7; i++)
    noteDiscoveryRead(j, i % 2 ? tab : announcement, {
      ...action,
      action: 'click',
      url: undefined,
    });
  assert.equal(stalledDiscoveryRead(j, { url: tab } as Observation, action), undefined);
  noteDiscoveryRead(j, tab, { ...action, url: announcement });
  const restored = JSON.parse(JSON.stringify(j)) as Job;
  assert.match(
    stalledDiscoveryRead(restored, { url: form.replace('one', 'two') } as Observation, action)!,
    /같은 행사/,
  );
  assert.equal(
    stalledDiscoveryRead(restored, { url: tab } as Observation, {
      ...action,
      action: 'record_event',
    }),
    undefined,
  );
  rejectDiscoveryCandidate(restored, tab, '읽기 예산 소진');
  assert.ok(excludedSource(restored, announcement));
  assert.ok(excludedSource(restored, form));
  assert.equal(
    excludedSource(restored, 'https://library.example/nambu/board/view.do?board_idx=8'),
    false,
  );
  assert.equal(excludedSource(restored, form.replace('month=11', 'month=12')), false);
});
test('general sources replan after repeated failures instead of draining an old unrelated frontier', () => {
  const j = job(),
    d = discoveryState(j);
  d.rejectedSinceSearch = 3;
  d.frontier = [
    {
      url: 'https://agency.example/notices/old',
      label: '이벤트 공지',
      source: 'https://agency.example/list',
    },
  ];
  assert.equal(discoveryNeedsReplan(j), true);
  assert.equal(nextDiscoverySource(j), undefined);
  d.frontier.push({
    url: 'https://www.instagram.com/p/new/',
    label: '새 이벤트',
    source: EVENT_DIRECTORY,
  });
  assert.equal(discoveryNeedsReplan(j), false);
});
test('policy calls cap displayed remaining decisions and failed calls still count without increasing either limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-effective-budget-')),
    store = new Store(dir);
  try {
    store.setSettings(
      'selectionPolicy',
      SelectionSchema.parse({ mode: 'broad', discoveryCalls: 60 }),
    );
    const j = job();
    j.steps = 59;
    for (let i = 0; i < 60; i++)
      store.db
        .prepare('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?)')
        .run(
          'call' + i,
          '2026-11-13',
          j.id,
          1,
          1,
          null,
          i === 59 ? 'unreported' : 'reported',
          Date.now(),
        );
    const b = jobBudget(store, j)!;
    assert.equal(b.calls, 60);
    assert.equal(b.remainingDecisions, 0);
    assert.equal(b.callLimit, 60);
    let calls = 0;
    const model = meteredModel(
      store,
      {
        decide: async () => {
          calls++;
          throw new Error('should not run');
        },
      },
      j,
    );
    await assert.rejects(
      model.decide(
        { kind: 'api', model: 'fixture' },
        '',
        {},
        Buffer.alloc(0),
        new AbortController().signal,
      ),
      /selection_call_limit/,
    );
    assert.equal(calls, 0);
    assert.equal(j.maxSteps, 80);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
