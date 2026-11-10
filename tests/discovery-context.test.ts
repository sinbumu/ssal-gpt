import test from 'node:test';
import assert from 'node:assert/strict';
import { compactDiscoveryContext } from '../src/discovery-context.js';
import {
  noteDiscoveryDestination,
  observeDiscovery,
  discoveryState,
  promotionalLink,
  excludedSource,
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
