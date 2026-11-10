import test from 'node:test';
import assert from 'node:assert/strict';
import { compactDiscoveryContext } from '../src/discovery-context.js';
import {
  noteDiscoveryDestination,
  observeDiscovery,
  discoveryState,
  promotionalLink,
  excludedSource,
  discoveryPageKey,
  rejectSource,
  reuseDiscoveryRejections,
  selectedDiscoveryLink,
} from '../src/discovery.js';
import type { Observation } from '../src/browser.js';
import type { Job } from '../src/store.js';

test('ad destinations and their redirects never become fresh event opportunities', () => {
  const job = { goal: '새 인스타 이벤트', steps: 3 } as Job;
  const wrapper = 'https://example.org/link?id=7';
  const o = {
    url: 'https://example.org/list',
    elements: [
      {
        href: 'https://example.org/advertise/?utm_source=menu',
        label: '이벤트 홍보가 필요하신가요? 광고 상품·단가 보기',
      },
      { href: 'https://example.org/landing', label: '추천캠페인 집행 시 이벤트 조회수 증가' },
      { href: wrapper, label: '새 댓글 이벤트' },
      { href: 'https://example.org/event/ad-quiz', label: '광고 영상 퀴즈 이벤트' },
    ],
  } as Observation;
  observeDiscovery(job, o);
  assert.deepEqual(
    discoveryState(job).frontier.map((f) => f.url),
    [wrapper, 'https://example.org/event/ad-quiz'],
  );
  noteDiscoveryDestination(job, wrapper, 'https://example.org/event/7');
  const restored = JSON.parse(JSON.stringify(job));
  observeDiscovery(restored, o);
  assert.ok(!discoveryState(restored).frontier.some((f) => f.url === wrapper));
  assert.deepEqual(discoveryState(restored).redirects, [
    { requested: wrapper, resolved: 'https://example.org/event/7' },
  ]);
  assert.equal(excludedSource(restored, 'https://example.org/biz/ads/guide.php'), true);
  assert.equal(
    promotionalLink('https://example.org/event/ad-quiz', '광고 영상 퀴즈 이벤트'),
    false,
  );
});

test('compact discovery retains current evidence and targets while reducing repeated context', () => {
  const observation = {
    id: 'now',
    url: 'https://example.org/event',
    title: '공식 원문',
    text: '참여 조건과 정확한 마감 2099-01-01. '.repeat(100),
    width: 1280,
    height: 840,
    fingerprint: 'f'.repeat(64),
    capturedAt: Date.now(),
    revision: 5,
    screenshot: 'now.png',
    hasResponseFields: true,
    elements: Array.from({ length: 80 }, (_, i) => ({
      ref: `e${i}`,
      tag: 'button',
      role: 'button',
      type: 'button',
      label: '본문 조건 ' + i,
      href: `https://example.org/event/${i}`,
      x: 10.123456789,
      y: 20.123456789,
      width: 40.123456789,
      height: 60.123456789,
      navigationOnly: false,
      readDisclosure: 'caption',
      disclosureKey: 'k'.repeat(64),
      mediaBounds: [{ x: 10, y: 20, width: 400, height: 400 }],
    })),
  } as Omit<Observation, 'image'>;
  const input = {
    observation,
    history: Array.from({ length: 30 }, (_, i) => ({
      action: 'navigate',
      reason: '과거 출처 설명 '.repeat(30),
      url: `https://example.org/old/${i}`,
    })),
    observedUrls: observation.elements.map((e) => e.href!),
    memory: '아직 확인할 조건',
    knownEvents: [{ entryUrl: 'https://example.org/entered', submissionState: 'completed' }],
  };
  const original = JSON.stringify(input),
    result = compactDiscoveryContext(input);
  assert.equal(result.observation.text, input.observation.text);
  assert.deepEqual(
    result.observation.elements.map((e) => [e.ref, e.href, e.readDisclosure]),
    input.observation.elements.map((e) => [e.ref, e.href, e.readDisclosure]),
  );
  assert.deepEqual(result.knownEvents, input.knownEvents);
  assert.equal(result.memory, input.memory);
  assert.equal(result.observation.hasResponseFields, true);
  assert.ok(JSON.stringify(result).length < original.length * 0.75);
  assert.equal(JSON.stringify(input), original, 'stored source and history are not deleted');
});

test('a rejected Instagram event includes carousel views and observed redirect aliases, not other posts', () => {
  const job = { goal: '새 인스타 이벤트', steps: 1 } as Job;
  const post = 'https://www.instagram.com/p/example/';
  const link = 'https://example.org/link?id=7';
  noteDiscoveryDestination(job, link, post + '?img_index=2');
  noteDiscoveryDestination(job, 'https://example.org/short/7', link);
  noteDiscoveryDestination(job, post, 'https://example.org/short/7'); // cycle
  rejectSource(job, post + '?img_index=1', '좋아요 필수가 없음');
  const restored = JSON.parse(JSON.stringify(job));
  for (const url of [post, post + '?img_index=5', link, 'https://example.org/short/7'])
    assert.equal(excludedSource(restored, url), true);
  assert.equal(excludedSource(restored, 'https://www.instagram.com/p/other/'), false);
  assert.equal(
    discoveryPageKey('https://instagram.com/author/reels/example/?img_index=2'),
    'https://www.instagram.com/reel/example/',
  );
  assert.notEqual(
    discoveryPageKey('https://example.org/article?img_index=1'),
    discoveryPageKey('https://example.org/article?img_index=2'),
  );
});

test('observed forward pagination is retained, while unrelated, backward and guessed pages are not', () => {
  const source = 'https://example.org/events?category=social&page=2';
  const next = 'https://example.org/events?category=social&page=3';
  const job = { goal: '새 이벤트', steps: 1, maxSteps: 40 } as Job;
  const o = {
    url: source,
    elements: [
      { href: next, label: '3' },
      { href: 'https://example.org/events?category=social&page=1', label: '1' },
      { href: 'https://evil.example/events?category=social&page=3', label: '다음' },
      { href: 'https://example.org/events?category=shopping&page=3', label: '다음' },
    ],
  } as Observation;
  observeDiscovery(job, o);
  assert.deepEqual(
    discoveryState(job).frontier.map((f) => f.url),
    [next],
  );
  assert.equal(selectedDiscoveryLink(job, o, next), next);
  assert.equal(
    selectedDiscoveryLink(job, o, 'https://example.org/events?category=social&page=4'),
    undefined,
  );
  assert.equal(job.maxSteps, 40);
});

test('recent factual rejections are reused only for the same goal, delegation and browser; failures are not inherited', () => {
  const now = Date.now();
  const make = (id: string) =>
    ({
      id,
      kind: 'discover',
      goal: '세 과제 필수',
      startUrl: 'https://example.org/events',
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now - 1000).toISOString(),
      browserEngine: 'chromium',
      prepareOne: { revision: 'same' },
      history: [],
    }) as unknown as Job;
  const prior = make('prior'),
    current = make('new');
  const url = 'https://www.instagram.com/p/rejected/?img_index=1';
  const technical = 'https://example.org/unavailable';
  rejectSource(prior, url, '친구 태그 필수');
  rejectSource(prior, technical, '일시적인 접속 실패');
  prior.history = [
    { action: 'skip_source', url, reason: '친구 태그 필수' },
    { action: 'skip_source', url: technical, reason: '일시적인 접속 실패' },
  ];
  noteDiscoveryDestination(prior, 'https://example.org/link', url);
  const different = { ...prior, id: 'other', goal: '다른 목표' };
  for (const changed of [
    different,
    { ...prior, prepareOne: { revision: 'changed' } },
    { ...prior, browserEngine: 'chrome' },
    { ...prior, updatedAt: new Date(now - 7 * 60 * 60_000).toISOString() },
  ]) {
    const fresh = make('isolated');
    reuseDiscoveryRejections(fresh, [changed as Job], now);
    assert.equal(discoveryState(fresh).rejected.length, 0);
  }
  reuseDiscoveryRejections(current, [prior], now);
  assert.equal(excludedSource(current, 'https://www.instagram.com/p/rejected/'), true);
  assert.equal(excludedSource(current, 'https://example.org/link'), true);
  assert.equal(excludedSource(current, technical), false);
  const restored = JSON.parse(JSON.stringify(current));
  reuseDiscoveryRejections(restored, [prior], now);
  assert.equal(restored.discovery.reusedRejections.length, 1);
  assert.equal(
    restored.history.filter((h: any) => h.action === 'discovery_rejections_reused').length,
    1,
  );
});
