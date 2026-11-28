import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Job } from '../src/store.js';
import {
  dmScope,
  queueDmCheck,
  assessDm,
  storeDmFinding,
  reviewDmFinding,
  dmReadRequest,
  type DmFinding,
} from '../src/instagram-dm.js';
import { outcomes } from '../src/outcomes.js';
import { startDmBatch, recoverResultBatch, resultBatch } from '../src/result-batch.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-dm-')),
    store = new Store(dir);
  const e = store.record(
    {
      title: '합성 달력 이벤트',
      organizer: 'fixture_host',
      entryUrl: 'https://www.instagram.com/p/TEST_POST/',
      deadline: null,
      prize: '달력',
      winners: 1,
      requirements: [],
      blockers: [],
      evidenceQuote: 'fixture',
      evidenceKind: 'text',
      effortMinutes: 1,
    },
    'https://www.instagram.com/p/TEST_POST/',
    'fixture',
    'test.png',
  ).event;
  const id = randomUUID();
  const j = {
    id,
    kind: 'apply',
    eventId: e.id,
    status: 'completed',
    browserEngine: 'chromium',
    history: [],
    tasks: [
      {
        id: 'follow',
        kind: 'follow',
        url: 'https://www.instagram.com/fixture_host/',
        state: 'verified',
        proof: { actor: 'browser' },
        preview: { actor: 'fixture_user', subject: 'fixture_host' },
        approval: { actor: 'fixture_user', subject: 'fixture_host' },
      },
    ],
  } as unknown as Job;
  store.saveJob(j);
  store.claimSubmission(e.id, id);
  store.markSubmission(e.id, 'completed', '{}');
  return {
    store,
    e,
    j,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const base: DmFinding = {
  organizer: 'fixture_host',
  state: 'unavailable',
  at: Date.now(),
  reason: '',
};
test('DM targets require completed proof, exact approved actor/subject and original profile', () => {
  const f = fixture();
  try {
    assert.equal(dmScope(f.store, f.e.id)?.actor, 'fixture_user');
    assert.throws(
      () => queueDmCheck(f.store, f.e.id, { kind: 'api', model: 'fixture' }, 'chrome'),
      /dm_profile_mismatch/,
    );
    assert.throws(
      () => queueDmCheck(f.store, randomUUID(), { kind: 'api', model: 'fixture' }, 'chromium'),
      /dm_completed_scope_required/,
    );
    const id = queueDmCheck(f.store, f.e.id, { kind: 'api', model: 'fixture' }, 'chromium');
    assert.equal(queueDmCheck(f.store, f.e.id, { kind: 'api', model: 'fixture' }, 'chromium'), id);
    f.j.tasks![0]!.preview!.subject = 'other_host';
    f.store.saveJob(f.j);
    assert.equal(dmScope(f.store, f.e.id), undefined);
  } finally {
    f.close();
  }
});
test('DM read request policy rejects mutations and arbitrary POSTs, allows bounded UI read queries', () => {
  assert.equal(
    dmReadRequest(
      'POST',
      'https://www.instagram.com/graphql/query',
      'fb_api_req_friendly_name=PolarisProfilePageContentQuery&doc_id=123',
    ),
    true,
  );
  assert.equal(
    dmReadRequest(
      'POST',
      'https://www.instagram.com/graphql/query/',
      'fb_api_req_friendly_name=SendMessageMutation&doc_id=123',
    ),
    false,
  );
  assert.equal(
    dmReadRequest(
      'POST',
      'https://www.instagram.com/api/graphql',
      'fb_api_req_friendly_name=PolarisProfilePageContentQuery&doc_id=123',
    ),
    true,
  );
  assert.equal(
    dmReadRequest(
      'POST',
      'https://evil.test/api/graphql',
      'fb_api_req_friendly_name=ReadQuery&doc_id=123',
    ),
    false,
  );
  assert.equal(
    dmReadRequest(
      'POST',
      'https://www.instagram.com/api/v1/direct_v2/threads/broadcast/text/',
      'text=hello',
    ),
    false,
  );
});
test('optimistic thread user lookup is a read query while actual thread creation remains blocked', () => {
  assert.equal(
    dmReadRequest(
      'POST',
      'https://www.instagram.com/api/graphql',
      'fb_api_req_friendly_name=useIGDCreateOptimisticThreadUserQuery&doc_id=123',
    ),
    true,
  );
  assert.equal(
    dmReadRequest('POST', 'https://www.instagram.com/api/v1/direct_v2/create_group_thread/', ''),
    false,
  );
});

test('grounded personal winner needs exact event identity; missing DM/masked list/own words never become loss', () => {
  const event = { title: '합성 달력 이벤트', entryUrl: 'https://www.instagram.com/p/TEST_POST/' };
  const msg = '합성 달력 이벤트에 당첨되셨습니다! 이름과 주소를 12월 1일까지 보내주세요.';
  const a = {
    kind: 'winner' as const,
    quote: '당첨되셨습니다!',
    eventQuote: '합성 달력 이벤트',
    requested: ['name', 'address', 'phone'] as ('name' | 'address' | 'phone')[],
    deadlineQuote: '12월 1일까지',
  };
  const f = assessDm(event, base, [msg], a);
  assert.equal(f.state, 'won');
  assert.deepEqual(f.requested, ['name', 'address']);
  assert.equal(assessDm(event, base, [msg], { ...a, eventQuote: '다른 행사' }).state, 'review');
  assert.equal(assessDm(event, base, [], a).state, 'no_evidence');
  assert.equal(
    assessDm(event, base, ['당첨되지 않았습니다. 합성 달력 이벤트'], {
      ...a,
      quote: '당첨되지 않았습니다.',
    }).state,
    'review',
  );
  assert.equal(
    assessDm(event, base, ['당첨자라면 주소를 보내주세요.'], {
      ...a,
      quote: '당첨자라면 주소를 보내주세요.',
    }).state,
    'review',
  );
});
test('rescan dedupes review and preserves confirmed reply/reward status', () => {
  const f = fixture();
  try {
    const finding = {
      ...base,
      state: 'review' as const,
      key: 'a'.repeat(64),
      quote: '달력 당첨되셨습니다!',
      requested: ['address' as const],
    };
    storeDmFinding(f.store, f.e.id, finding);
    assert.equal(outcomes(f.store)[0]!.status, 'pending');
    reviewDmFinding(f.store, f.e.id, finding.key, true);
    let o = outcomes(f.store)[0]!;
    assert.equal(o.status, 'won');
    assert.equal(o.reportedBy, 'user');
    o.followUp!.state = 'replied';
    o.reward!.status = 'received';
    f.store.setSettings('outcomes', [o]);
    storeDmFinding(f.store, f.e.id, finding);
    o = outcomes(f.store)[0]!;
    assert.equal(o.followUp!.state, 'replied');
    assert.equal(o.reward!.status, 'received');
    assert.equal(o.dmChecks![0]!.reviewed, 'confirmed');
    assert.throws(
      () => reviewDmFinding(f.store, f.e.id, finding.key, true),
      /dm_review_unavailable/,
    );
    storeDmFinding(f.store, f.e.id, { ...base, state: 'no_evidence' });
    assert.equal(outcomes(f.store)[0]!.status, 'won');
  } finally {
    f.close();
  }
});
test('manual DM batch uses completed targets and is paused on restart', () => {
  const f = fixture();
  try {
    assert.throws(
      () => startDmBatch(f.store, { kind: 'api', model: 'fixture' }, 'chromium', [randomUUID()]),
      /dm_completed_scope_required/,
    );
    startDmBatch(f.store, { kind: 'api', model: 'fixture' }, 'chromium', [f.e.id]);
    assert.equal(resultBatch(f.store)?.mode, 'instagram_dm');
    recoverResultBatch(f.store);
    assert.equal(resultBatch(f.store)?.state, 'paused');
  } finally {
    f.close();
  }
});

import { configureDmMonitor, dmMonitor, tickDmMonitor } from '../src/result-batch.js';
import { dmReplyPreview, sendApprovedDm, replyAttempt } from '../src/dm-reply.js';
import { currentNotices } from '../src/reward-notifications.js';
import type { Runner } from '../src/runner.js';
import type { Browser } from '../src/browser.js';

test('scheduled organizer checks use the announcement date without a public announcement; do not restart disabled or active batches', () => {
  const f = fixture();
  try {
    const now = Date.now();
    const entry = f.store.completedEntries()[0]!;
    f.store.completedEntries = () => [
      {
        ...entry,
        completedAt: new Date(now).toISOString(),
        announcementDate: new Date(now - 86400000).toISOString().slice(0, 10),
      },
    ];
    const runner = { isBusy: () => false, browser: { profileKey: () => 'chromium' } } as Runner;
    tickDmMonitor(f.store, runner, now);
    assert.equal(resultBatch(f.store), null);
    configureDmMonitor(f.store, true, { kind: 'api', model: 'fixture' }, 'chromium');
    tickDmMonitor(f.store, runner, now + 100);
    const batch = resultBatch(f.store)!;
    assert.deepEqual(
      batch.items.map((i) => i.eventId),
      [entry.eventId],
    );
    assert.ok(dmMonitor(f.store).nextAt! > now);
    tickDmMonitor(f.store, runner, now + 86400000);
    assert.equal(resultBatch(f.store)?.id, batch.id);
  } finally {
    f.close();
  }
});
test('reply binds source, recipient, approved text and consent, keeps a durable lock on uncertain dispatch', async () => {
  const f = fixture();
  try {
    const key = 'e'.repeat(64);
    const source =
      '합성 달력 이벤트 당첨을 축하합니다. 성함과 개인정보 동의 여부를 회신 부탁드립니다.';
    const finding = {
      ...base,
      state: 'review' as const,
      quote: '당첨을 축하합니다.',
      requested: ['name', 'consent'] as ('name' | 'consent')[],
      key,
    };
    storeDmFinding(f.store, f.e.id, finding);
    assert.ok(currentNotices(f.store).some((n) => n.kind === 'dm_review'));
    reviewDmFinding(f.store, f.e.id, key, true);
    f.store.setSettings('dmSource:' + f.e.id + ':' + key, source);
    f.store.setSettings('autonomy', { profile: { name: '테스트' }, policy: {}, revision: 'test' });
    assert.equal(dmReplyPreview(f.store, f.e.id, 'unset').approval, null);
    const preview = dmReplyPreview(f.store, f.e.id, 'accept');
    assert.ok(preview.approval);
    const b = {
      profileKey: () => 'chromium',
      replyToOrganizer: async (
        _a: string,
        _o: string,
        _s: string,
        _t: string,
        intent: () => void,
      ) => {
        intent();
        return false;
      },
    } as Browser;
    await assert.rejects(
      sendApprovedDm(f.store, b, f.e.id, 'accept', preview.approval, 'tampered'),
      /dm_reply_changed/,
    );
    assert.equal(replyAttempt(f.store, f.e.id), null);
    await assert.rejects(
      sendApprovedDm(f.store, b, f.e.id, 'accept', preview.approval, preview.text),
      /dm_reply_unknown/,
    );
    assert.equal(replyAttempt(f.store, f.e.id)?.status, 'unconfirmed');
    assert.equal(dmReplyPreview(f.store, f.e.id, 'decline').approval, null);
    await assert.rejects(
      sendApprovedDm(f.store, b, f.e.id, 'accept', preview.approval, preview.text),
      /dm_reply_changed/,
    );
  } finally {
    f.close();
  }
});
