import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discoveryState,
  discoverySwitchLimit,
  guardDiscoverySearch,
  nextDiscoveryRoute,
  noteSearch,
  observeDiscovery,
  rejectSource,
  similarQuery,
  excludedSource,
  discoveryPageKey,
  selectedDiscoveryLink,
  noteDiscoveryRead,
  stalledDiscoveryRead,
} from '../src/discovery.js';
import type { Job } from '../src/store.js';
import type { Observation } from '../src/browser.js';
import { actionPolicy } from '../src/runner.js';

const job = () =>
  ({
    kind: 'discover',
    steps: 0,
    maxSteps: 40,
    goal: '무료 이벤트',
    searchEngine: 'naver',
    skippedUrls: [],
    uncertain: false,
  }) as unknown as Job;
test('search similarity catches reordered Korean and normalized Instagram queries without matching unrelated terms', () => {
  assert.ok(
    similarQuery(
      '인스타그램 이벤트 좋아요 댓글 팔로우 2026',
      '2026 팔로우 댓글 좋아요 이벤트 instagram',
    ),
  );
  assert.ok(
    similarQuery('무료 인스타 이벤트 팔로우 좋아요 댓글', '인스타 이벤트 댓글 좋아요 팔로우 경품'),
  );
  assert.equal(similarQuery('종로 수영장 회원', '라면 디지털 캠페인'), false);
});
test('repeated and stagnant searches switch engine without increasing the decision budget', () => {
  const j = job();
  for (const query of ['봄 축제 경품', '도시 문화 주간', '온라인 무료 추첨']) {
    noteSearch(j, 'naver', query);
    j.steps++;
  }
  const decision = guardDiscoverySearch(j, {
    action: 'search',
    observationId: 'o',
    reason: 'test',
    text: '새로운 주제',
  });
  assert.equal(decision?.route?.engine, 'google');
  assert.equal(j.maxSteps, 40);
  assert.equal(
    guardDiscoverySearch(j, { action: 'scroll', observationId: 'o', reason: 'test' }),
    undefined,
  );
});
test('only observed readable frontier links are used when both engines already searched a query', () => {
  const j = job();
  const o = {
    url: 'https://example.org/list',
    elements: [
      { href: 'https://example.org/login', label: '이벤트 로그인' },
      { href: 'javascript:alert(1)', label: '이벤트' },
      { href: 'https://brand.example/event/1', label: '새 인스타 이벤트' },
    ],
  } as Observation;
  observeDiscovery(j, o);
  noteSearch(j, 'naver', '무료 이벤트');
  noteSearch(j, 'google', '무료 이벤트');
  assert.equal(nextDiscoveryRoute(j)?.url, 'https://brand.example/event/1');
  rejectSource(j, 'https://brand.example/event/1?utm_source=test', '종료됨');
  assert.equal(nextDiscoveryRoute(j), undefined);
  assert.equal(excludedSource(j, 'https://brand.example/event/1'), true);
});
test('blocked engines, exclusion reasons and switch limits persist across serialization and resume', () => {
  const j = job();
  discoveryState(j).blockedEngines.push('google');
  rejectSource(j, 'https://example.org/event', '필수 방문 과제');
  const resumed = JSON.parse(JSON.stringify(j)) as Job;
  assert.equal(nextDiscoveryRoute(resumed, '다른 쿼리', 'naver'), undefined);
  assert.equal(discoveryState(resumed).rejected[0]?.reason, '필수 방문 과제');
  discoveryState(resumed).blockedEngines = [];
  discoveryState(resumed).switches = 6;
  assert.equal(nextDiscoveryRoute(resumed, '다른 쿼리'), undefined);
  resumed.steps = resumed.maxSteps;
  discoveryState(resumed).switches = 0;
  assert.equal(nextDiscoveryRoute(resumed), undefined);
});
test('source exclusion cannot replace consent or entry actions in apply and uncertain jobs', () => {
  const j = job(),
    o = { id: 'o', elements: [], url: 'https://example.org' } as unknown as Observation;
  const s = { action: 'skip_source' as const, observationId: 'o', reason: 'test' };
  assert.equal(actionPolicy(j, s, o), 'allow');
  j.kind = 'apply';
  assert.equal(actionPolicy(j, s, o), 'block');
  j.kind = 'discover';
  j.uncertain = true;
  assert.equal(actionPolicy(j, s, o), 'block');
});

test('configured source limit allows remaining transitions without resetting counts or decision cap', () => {
  const j = job(),
    s = discoveryState(j);
  s.switches = 6;
  assert.equal(discoverySwitchLimit(j), 6);
  assert.equal(nextDiscoveryRoute(j, '새 설문'), undefined);
  s.switchLimit = 20;
  assert.ok(nextDiscoveryRoute(j, '새 설문'));
  assert.equal(s.switches, 6);
  j.steps = j.maxSteps;
  assert.equal(nextDiscoveryRoute(j, '새 설문'), undefined);
  j.steps = 0;
  s.switches = 20;
  assert.equal(nextDiscoveryRoute(j, '새 설문'), undefined);
  s.switchLimit = 101;
  assert.equal(discoverySwitchLimit(j), 6);
});

test('explicitly restricted sources exclude alternate pages on that host, not other organizers', () => {
  const j = job();
  rejectSource(j, 'https://www.example.org/event/1', '출처에서 자동 수집을 금지함', true);
  assert.equal(excludedSource(j, 'https://example.org/event/2?view=other'), true);
  assert.equal(excludedSource(j, 'https://another.example.org/event/2'), false);
});

test('fallback excludes tracking ads, purchase offers, winners and generic mirror profiles', () => {
  const j = job();
  observeDiscovery(j, {
    url: 'https://example.org/list',
    elements: [
      { href: 'https://mkt.example.org/card?eventCode=1', label: '적립적인 멤버십 전용카드' },
      { href: 'https://example.org/event/plan', label: '무료 요금제 개통 혜택' },
      { href: 'https://example.org/event/result', label: '이벤트 당첨자 발표' },
      { href: 'https://mirror.example/profile/name', label: 'Instagram 프로필' },
      { href: 'https://www.instagram.com/p/ObservedPost/', label: '원문' },
    ],
  } as Observation);
  assert.deepEqual(
    discoveryState(j).frontier.map((v) => v.url),
    ['https://www.instagram.com/p/ObservedPost/'],
  );
  const social = job();
  observeDiscovery(social, {
    url: 'https://www.instagram.com/p/Event/',
    elements: [
      { href: 'https://www.instagram.com/p/Recommendation/', label: '바다 여행 사진 댓글 20개' },
    ],
  } as Observation);
  assert.equal(discoveryState(social).frontier.length, 0);
});
test('Naver article wrappers share identity and a skip can only select an observed readable URL', () => {
  const j = job(),
    article = 'https://blog.naver.com/brand/123';
  const wrapper = 'https://blog.naver.com/PostView.naver?blogId=brand&logNo=123&redirect=Dlog';
  assert.equal(discoveryPageKey(wrapper), article);
  rejectSource(j, wrapper, '종료');
  assert.ok(excludedSource(j, article));
  const o = {
    url: article,
    elements: [{ href: 'https://example.org/event/new', label: '새 이벤트' }],
  } as Observation;
  assert.equal(
    selectedDiscoveryLink(j, o, 'https://example.org/event/new'),
    'https://example.org/event/new',
  );
  assert.equal(selectedDiscoveryLink(j, o, 'https://unseen.example/event'), undefined);
  assert.equal(
    discoveryPageKey('https://www.google.com/sorry/index?q=challenge&continue=private'),
    'https://www.google.com/sorry/index',
  );
});

test('excluding a detail page may return to an already observed list, but never to a rejected list', () => {
  const j = job(),
    url = 'https://example.org/cpevent?isActive=1';
  j.visitedUrls = [url];
  const o = { url: 'https://example.org/cpevent/123', elements: [] } as unknown as Observation;
  assert.equal(selectedDiscoveryLink(j, o, url), url);
  rejectSource(j, url, '금지', true);
  assert.equal(selectedDiscoveryLink(j, o, url), undefined);
});

test('stalled reading and failed navigation counters survive resume but do not block candidate recording', () => {
  const j = job(),
    o = { url: 'https://example.org/long', elements: [] } as unknown as Observation;
  const scroll = { action: 'scroll' as const, observationId: 'o', reason: 'read', delta: 500 };
  for (let i = 0; i < 8; i++) noteDiscoveryRead(j, o.url, scroll);
  const resumed = JSON.parse(JSON.stringify(j));
  assert.ok(stalledDiscoveryRead(resumed, o, scroll));
  assert.equal(stalledDiscoveryRead(resumed, o, { ...scroll, action: 'record_event' }), undefined);
  const navigate = {
    action: 'navigate' as const,
    observationId: 'o',
    reason: 'read',
    url: 'https://example.org/frame',
  };
  noteDiscoveryRead(resumed, o.url, navigate);
  noteDiscoveryRead(resumed, o.url, navigate);
  assert.ok(stalledDiscoveryRead(resumed, o, navigate));
  observeDiscovery(resumed, {
    ...o,
    elements: [{ href: 'https://example.org/event/new', label: '새 행사 이벤트' }],
  } as Observation);
  assert.equal(stalledDiscoveryRead(resumed, o, scroll), undefined);
});
