import test from 'node:test';
import assert from 'node:assert/strict';
import type { Job } from '../src/store.js';
import type { Observation } from '../src/browser.js';
import {
  discoveryState,
  discoveryPageKey,
  discoveryContext,
  observeDiscovery,
  noteDiscoveryDestination,
  rejectSource,
  excludedSource,
  nextDiscoveryRoute,
  reuseDiscoveryRejections,
  selectedDiscoveryLink,
  guardDiscoverySearch,
  noteSearch,
  discoveryNeedsReplan,
} from '../src/discovery.js';

const job = () =>
  ({
    kind: 'discover',
    goal: '새 다중페이지 네이버폼 이벤트',
    steps: 0,
    maxSteps: 40,
    searchEngine: 'naver',
    startUrl: 'https://example.org/events',
  }) as Job;

test('form discovery retains survey rows and direct links ahead of social bonuses and new searches', () => {
  const j = job();
  const form = 'https://form.naver.com/response/new_form';
  observeDiscovery(j, {
    url: j.startUrl,
    elements: [
      { href: 'https://opengov.example.org/plan', label: '홈페이지 만족도 조사 추진계획 결재문서' },
      { href: 'https://ader.naver.com/v1/example', label: '만족도 조사 이벤트' },
      { href: 'https://www.instagram.com/p/Social/', label: '새 이벤트' },
      {
        href: 'https://example.org/events/row',
        label: '기관 홈페이지 의견',
        context: '설문/투표 커피 50명',
      },
      { href: 'https://example.org/events/survey', label: '설문 참여' },
      { href: form, label: '참여하기' },
      {
        href: 'https://www.suto.co.kr/membership/?utm_content=wish',
        label: '이벤트 당첨 소원 빌기',
      },
    ],
  } as Observation);
  assert.equal(discoveryState(j).frontier[0]!.url, form);
  assert.ok(discoveryState(j).frontier.some((f) => f.label === '설문 참여'));
  assert.ok(!discoveryState(j).frontier.some((f) => f.url.includes('/membership/')));
  assert.ok(!discoveryState(j).frontier.some((f) => f.url.includes('ader.naver.com')));
  assert.ok(excludedSource(j, 'https://ader.naver.com/v1/example'));
  assert.ok(!discoveryState(j).frontier.some((f) => f.url === 'https://opengov.example.org/plan'));
  assert.equal(
    nextDiscoveryRoute(j)?.url,
    form,
    'use an observed matching form before another search',
  );
  rejectSource(j, form, '종료');
  assert.ok(nextDiscoveryRoute(j)?.url.startsWith('https://example.org/events/'));
  assert.equal(j.maxSteps, 40);
  assert.equal(discoveryContext(j).formSearch?.preferred, 'naver');
  j.steps = 40;
  assert.equal(nextDiscoveryRoute(j), undefined, 'matching links do not bypass the budget');
});

test('Google respondent links outrank notices while tool pages and tags never become fallback destinations', () => {
  const j = job();
  j.goal = '새 다중페이지 Google Forms 이벤트, 네이버폼 제외';
  const form = 'https://docs.google.com/forms/d/e/example/viewform';
  const junk = [
    ['https://workspace.google.com/intl/ko/products/forms/', 'Google Forms 온라인 설문조사'],
    ['https://www.google.com/intl/ko/forms/about/', '설문조사'],
    ['https://docs.google.com/forms/u/0/', '설문 만들기'],
    ['https://blog.example/tag/survey/', '설문 이벤트'],
    ['https://blog.example/tools', '설문조사 도구 비교 및 사용법'],
  ];
  const o = {
    url: j.startUrl,
    elements: [
      ...junk.map(([href, label]) => ({ href, label })),
      { href: 'https://example.org/notice/new', label: '홈페이지 만족도 설문 경품 안내' },
      { href: 'https://form.naver.com/response/other', label: '참여하기' },
      { href: form, label: '응답하기' },
      { href: 'https://forms.gle/shortId', label: '참여 링크' },
    ],
  } as Observation;
  observeDiscovery(j, o);
  assert.equal(discoveryContext(j).formSearch?.preferred, 'google');
  assert.equal(nextDiscoveryRoute(j)?.url, form);
  for (const [url] of junk) {
    assert.ok(!discoveryState(j).frontier.some((v) => v.url === url));
    assert.equal(selectedDiscoveryLink(j, o, url), undefined);
  }
  assert.equal(discoveryState(j).filteredLinks?.length, 5);
  rejectSource(j, form, '종료');
  assert.equal(nextDiscoveryRoute(j)?.url, 'https://forms.gle/shortId');
  assert.equal(
    selectedDiscoveryLink(j, o, 'https://example.org/notice/new'),
    'https://example.org/notice/new',
  );
});

test('generic event footer leftovers trigger a fresh query rather than an unrelated fallback', () => {
  const j = job();
  j.goal = '구글폼 이벤트';
  const s = discoveryState(j);
  s.blockedEngines = ['google'];
  observeDiscovery(j, {
    url: j.startUrl,
    elements: [
      { href: 'https://tech.example/events/webinar', label: 'Google Workspace 세미나 이벤트' },
      { href: 'https://game.example/notice/', label: '공지사항' },
    ],
  } as Observation);
  assert.equal(nextDiscoveryRoute(j), undefined);
  assert.equal(j.maxSteps, 40);
});

test('three rejected sources replan despite survey leftovers but an observed matching form remains useful', () => {
  const j = job();
  j.goal = 'Google Forms 설문';
  const s = discoveryState(j);
  observeDiscovery(j, {
    url: j.startUrl,
    elements: [{ href: 'https://example.org/survey-old', label: '만족도 조사' }],
  } as Observation);
  s.rejectedSinceSearch = 3;
  assert.ok(discoveryNeedsReplan(j));
  assert.equal(nextDiscoveryRoute(j), undefined);
  s.needsFreshSearch = true;
  s.searches = ['A 무료 경품', 'B 홈페이지 조사', 'C 의견 조사'].map((query, step) => ({
    query,
    step,
    engine: 'naver',
  }));
  assert.equal(
    guardDiscoverySearch(j, {
      action: 'search',
      observationId: 'o',
      reason: '새 전략',
      text: '지역 문화 포털 이용자 만족도',
    }),
    undefined,
  );
  assert.ok(
    guardDiscoverySearch(j, {
      action: 'search',
      observationId: 'o',
      reason: '반복',
      text: 'A 무료 경품',
    }),
  );
  observeDiscovery(j, {
    url: j.startUrl,
    elements: [{ href: 'https://forms.gle/new', label: '응모하기' }],
  } as Observation);
  assert.equal(discoveryNeedsReplan(j), false);
  assert.equal(nextDiscoveryRoute(j)?.url, 'https://forms.gle/new');
  noteSearch(j, 'naver', '지역 문화 포털 이용자 만족도');
  assert.equal(s.rejectedSinceSearch, 0);
  assert.equal(s.needsFreshSearch, false);
});

test('the exact directory participation ID joins detail and observed destination without merging lists or other events', () => {
  const j = job();
  const detail = 'https://www.suto.co.kr/cpevent/42';
  const link = 'https://www.suto.co.kr/bbs/link.php?bo_table=cpevent&wr_id=42&no=1';
  const post = 'https://www.instagram.com/p/Rejected/';
  noteDiscoveryDestination(j, link, post);
  rejectSource(j, post, '친구 태그 필수', false, true);
  const restored = JSON.parse(JSON.stringify(j));
  assert.equal(discoveryPageKey(link), detail);
  assert.ok(excludedSource(restored, detail));
  assert.ok(excludedSource(restored, link));
  for (const other of [
    'https://www.suto.co.kr/cpevent',
    'https://www.suto.co.kr/cpevent/43',
    link.replace('no=1', 'no=2'),
    link + '&wr_id=43',
    link.replace('bo_table=cpevent', 'bo_table=other'),
    link.replace('www.suto.co.kr', 'other.example.org'),
    link + '&target=another',
    'https://www.instagram.com/p/Other/',
  ])
    assert.equal(excludedSource(restored, other), false, other);
});

test('explicit factual rejections survive a truncated history and carry aliases only within the same scope', () => {
  const now = Date.now();
  const before = {
    ...job(),
    id: 'prior',
    createdAt: new Date(now - 2000).toISOString(),
    updatedAt: new Date(now - 1000).toISOString(),
    prepareOne: { revision: 'same', expires: now + 10000 },
    history: [],
  } as Job;
  const post = 'https://www.instagram.com/p/Rejected/';
  noteDiscoveryDestination(
    before,
    'https://www.suto.co.kr/bbs/link.php?bo_table=cpevent&wr_id=42&no=1',
    post,
  );
  rejectSource(before, post, '댓글형 행사', false, true);
  rejectSource(
    before,
    'https://example.org/temporary',
    '읽기 실패: read_only_request_blocked',
    false,
    true,
  );
  const after = {
    ...job(),
    id: 'new',
    createdAt: new Date(now).toISOString(),
    prepareOne: { ...before.prepareOne! },
    history: [],
  } as Job;
  reuseDiscoveryRejections(after, [before], now);
  assert.ok(excludedSource(after, 'https://www.suto.co.kr/cpevent/42'));
  assert.equal(excludedSource(after, 'https://example.org/temporary'), false);
  const changed = {
    ...job(),
    id: 'changed',
    goal: '다른 목표',
    createdAt: after.createdAt,
    prepareOne: { ...after.prepareOne! },
    history: [],
  } as Job;
  reuseDiscoveryRejections(changed, [before], now);
  assert.equal(excludedSource(changed, post), false);
});
