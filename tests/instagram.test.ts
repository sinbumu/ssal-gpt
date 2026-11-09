import test from 'node:test';
import assert from 'node:assert/strict';
import { instagramTarget } from '../src/instagram.js';
import { canonicalUrl } from '../src/store.js';
import { buildTasks } from '../src/tasks.js';
test('Instagram route is an exact public post or follow profile; completion claims depend on the form', () => {
  assert.ok(instagramTarget('https://www.instagram.com/p/abc/', 'comment'));
  assert.ok(instagramTarget('https://www.instagram.com/host/p/abc/', 'comment'));
  assert.equal(
    canonicalUrl('https://instagram.com/host/p/abc?igsh=tracking'),
    'https://www.instagram.com/p/abc/',
  );
  assert.ok(instagramTarget('https://www.instagram.com/fixture_host/', 'follow'));
  for (const url of [
    'https://evil.instagram.com/p/abc/',
    'https://www.instagram.com/direct/',
    'https://www.instagram.com/accounts/',
    'https://www.instagram.com/p/abc/comments/',
    'http://www.instagram.com/p/abc/',
  ])
    assert.equal(instagramTarget(url, 'comment'), false);
  const form = {
    id: 'f',
    kind: 'form' as const,
    url: 'https://form.naver.com/response/fixture',
    instruction: '폼 제출',
    quote: '폼 제출 후 참여완료 댓글',
    dependsOn: [],
  };
  const comment = {
    id: 'c',
    kind: 'comment' as const,
    url: 'https://www.instagram.com/p/fixture/',
    instruction: '참여완료 댓글',
    quote: form.quote,
    dependsOn: ['f'],
  };
  const event = {
    tasks: [form, comment],
    requirements: ['설문 후 댓글'],
    sourceEvidence: [form, comment].map((t, i) => ({
      id: String(i),
      url: t.url,
      title: '합성',
      text: form.quote,
      screenshot: 'fixture.png',
      observedAt: Date.now(),
    })),
  };
  assert.deepEqual(
    buildTasks(event)!.map((t) => t.kind),
    ['form', 'comment'],
  );
  assert.throws(
    () => buildTasks({ ...event, tasks: [{ ...comment, dependsOn: [] }, form] }),
    /completion_comment_requires_form/,
  );
});
