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
  assert.equal(discoveryState(j).frontier.at(-1)!.url, 'https://opengov.example.org/plan');
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
