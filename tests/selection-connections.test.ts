import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Job } from '../src/store.js';
import {
  selection,
  SelectionSchema,
  SELECTION_PRESETS,
  evaluateCandidate,
  enforcePersonalResponsePolicy,
} from '../src/selection.js';
import {
  saveConnection,
  requireConnection,
  connectionSummary,
  connectionReady,
  registerCandidateConnections,
} from '../src/connections.js';
import { winnerNotice } from '../src/notifications.js';
import { meteredModel } from '../src/operations.js';
import { reuseDiscoveryRejections, discoveryState } from '../src/discovery.js';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-policy-')),
    store = new Store(dir);
  const text =
    '누구나 참여. 로그인 필수. 본인의 실제 경험을 작성. 신규 회원가입 필수. 당첨자에게 개별 DM 안내. 댓글 발표.';
  const url = 'https://www.instagram.com/p/fixture/';
  const e = store.record(
    {
      title: '합성 후보',
      organizer: '합성',
      entryUrl: url,
      deadline: '2099-01-01T00:00:00Z',
      prize: '컵',
      winners: 5,
      requirements: ['정답 댓글'],
      blockers: [],
      evidenceQuote: text,
      evidenceKind: 'text',
      effortMinutes: 2,
      tasks: [
        {
          id: 'comment',
          kind: 'comment',
          url,
          instruction: '정답 댓글',
          quote: '정답 댓글',
          dependsOn: [],
        },
      ],
    },
    url,
    'job',
    'fixture.png',
    {
      connectionProfile: 'chromium',
      sourceEvidence: [
        { id: 's', url, text, title: '합성', screenshot: 'fixture.png', observedAt: Date.now() },
      ],
    },
  ).event;
  return {
    store,
    e,
    dir,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('balanced legacy defaults, preset scope and prize filters change eligibility without requiring three social actions', () => {
  const f = fixture();
  try {
    assert.equal(selection(f.store).mode, 'balanced');
    assert.equal(SelectionSchema.parse({ mode: 'strict' }).personalResponses, 'skip');
    assert.equal(
      SelectionSchema.parse({ mode: 'strict', personalResponses: 'ask' }).personalResponses,
      'ask',
    );
    assert.equal(evaluateCandidate(f.store, f.e).state, 'eligible');
    f.store.setSettings('selectionPolicy', SelectionSchema.parse(SELECTION_PRESETS.strict));
    assert.equal(evaluateCandidate(f.store, f.e).state, 'excluded');
    assert.match(evaluateCandidate(f.store, f.e).reasons.join(' '), /선호 경품만/);
    assert.equal(
      evaluateCandidate(f.store, {
        ...f.e,
        prize: '커피',
        entryType: 'quiz',
        entryUrl: 'https://form.naver.com/response/quiz',
        tasks: undefined,
      }).state,
      'excluded',
    );

    f.store.setSettings('selectionPolicy', {
      ...SELECTION_PRESETS.balanced,
      allowedTasks: ['form'],
    });
    assert.equal(evaluateCandidate(f.store, f.e).state, 'excluded');
    f.store.setSettings('selectionPolicy', SELECTION_PRESETS.broad);
    assert.equal(
      evaluateCandidate(f.store, { ...f.e, blockers: ['참여 자격 불명'] }).state,
      'review',
    );
    assert.equal(
      evaluateCandidate(f.store, { ...f.e, deadline: '2000-01-01T00:00:00Z' }).state,
      'review',
    );
  } finally {
    f.close();
  }
});
test('personal response and registration scope uses source evidence and preserves unknown facts', () => {
  const f = fixture();
  try {
    const e = {
      ...f.e,
      entryNeeds: {
        personalResponse: { required: true, quote: '본인의 실제 경험을 작성' },
        logins: [],
      },
    };
    f.store.setSettings('selectionPolicy', { personalResponses: 'skip' });
    assert.equal(evaluateCandidate(f.store, e).state, 'excluded');
    assert.equal(
      evaluateCandidate(f.store, {
        ...e,
        entryNeeds: { ...e.entryNeeds, personalResponse: { required: true, quote: 'invented' } },
      }).state,
      'review',
    );
    f.store.setSettings('selectionPolicy', { personalResponses: 'ask', registrations: 'ask' });
    assert.equal(evaluateCandidate(f.store, e).state, 'eligible');
    assert.equal(
      evaluateCandidate(f.store, {
        ...f.e,
        entryNeeds: { registration: { required: true, quote: '신규 회원가입 필수' }, logins: [] },
      }).state,
      'review',
    );
    registerCandidateConnections(
      f.store,
      {
        ...f.e,
        entryNeeds: { registration: { required: true, quote: '신규 회원가입 필수' }, logins: [] },
      },
      'chromium',
    );
    assert.match(
      connectionSummary(f.store, 'chromium').find((s) => s.id === 'instagram')!.requiredBy[0]
        .reason,
      /직접 가입/,
    );
    f.store.setSettings('selectionPolicy', { registrations: 'skip' });
    assert.equal(
      connectionSummary(f.store, 'chromium').find((s) => s.id === 'instagram')!.requiredBy.length,
      0,
    );
    const job = { id: 'draft', kind: 'apply', tasks: [], uncertain: false } as unknown as Job;
    f.store.setSettings('selectionPolicy', { personalResponses: 'skip' });
    assert.throws(
      () => enforcePersonalResponsePolicy(f.store, job),
      /personal_response_policy_stop/,
    );
    assert.ok(job.switchReason);
    const transmitted = { ...job, transmitted: true, switchReason: undefined };
    assert.throws(
      () => enforcePersonalResponsePolicy(f.store, transmitted),
      /personal_response_policy_stop/,
    );
    assert.equal(transmitted.switchReason, undefined);
  } finally {
    f.close();
  }
});
test('connection needs are grouped, observed, profile scoped and expire; checking login never grants posting', () => {
  const f = fixture();
  try {
    const e = { ...f.e, entryNeeds: { logins: [{ url: f.e.entryUrl, quote: '로그인 필수' }] } };
    registerCandidateConnections(f.store, e, 'chromium');
    registerCandidateConnections(f.store, e, 'chromium');
    assert.equal(
      connectionSummary(f.store, 'chromium').find((s) => s.id === 'instagram')!.requiredBy.length,
      1,
    );
    assert.equal(evaluateCandidate(f.store, e).state, 'review');
    saveConnection(
      f.store,
      'chrome',
      { service: 'instagram', state: 'signed_in_visible', message: 'fixture' },
      f.e.entryUrl,
    );
    assert.equal(evaluateCandidate(f.store, e).state, 'review');
    saveConnection(
      f.store,
      'chromium',
      { service: 'instagram', state: 'signed_in_visible', message: 'fixture' },
      f.e.entryUrl,
    );
    assert.equal(evaluateCandidate(f.store, e).state, 'eligible');
    assert.equal(
      connectionSummary(f.store, 'chromium').find((s) => s.id === 'instagram')!.requiredBy.length,
      0,
    );
    assert.equal(connectionReady(f.store, 'instagram', 'chromium', Date.now() + 86400001), false);
    assert.equal(f.store.settings('instagramBrowser', null), null);
    registerCandidateConnections(
      f.store,
      {
        ...e,
        id: 'fake',
        entryNeeds: { logins: [{ url: 'https://example.org/', quote: '로그인 필수' }] },
      },
      'chromium',
    );
    assert.ok(!connectionSummary(f.store, 'chromium').some((s) => s.id === 'https://example.org'));
    assert.equal(
      connectionSummary(f.store, 'chrome').find((s) => s.id === 'instagram')!.requiredBy.length,
      0,
    );
    saveConnection(
      f.store,
      'chromium',
      { service: 'instagram', state: 'login_required', message: 'expired' },
      f.e.entryUrl,
    );
    f.store.setSettings('selectionPolicy', { newConnections: 'skip' });
    assert.equal(
      connectionSummary(f.store, 'chromium').find((s) => s.id === 'instagram')!.requiredBy.length,
      0,
    );
    f.store.claimSubmission(e.id, 'active');
    assert.equal(
      connectionSummary(f.store, 'chromium').find((s) => s.id === 'instagram')!.requiredBy.length,
      1,
      'keep existing job reconnect request',
    );
  } finally {
    f.close();
  }
});
test('announcement evidence separates original channels, legacy estimates and unknown collected contacts', () => {
  const f = fixture();
  try {
    const explicit = winnerNotice({
      ...f.e,
      winnerNotice: {
        channels: ['instagram_dm', 'email'],
        basis: 'explicit',
        sourceUrl: f.e.entryUrl,
        quote: '당첨자에게 개별 DM 안내.',
        reason: '원문',
      },
    });
    assert.equal(explicit.basis, 'explicit');
    assert.deepEqual(explicit.channels, ['instagram_dm']);
    const unknown = winnerNotice({
      winnerNotice: {
        channels: ['email'],
        basis: 'explicit',
        sourceUrl: 'https://wrong.example',
        quote: '이메일 연락',
        reason: 'guess',
      },
    });
    assert.equal(unknown.basis, 'unknown');
    assert.deepEqual(unknown.channels, []);
    assert.equal(winnerNotice({ announcementNote: '개별 DM 안내' }).basis, 'inferred');
    assert.equal(
      winnerNotice({
        sourceEvidence: [
          { ...f.e.sourceEvidence![0], text: '이름, 전화번호, 이메일 수집. 경품 발송 목적.' },
        ],
      }).basis,
      'unknown',
    );
    const unrelated = winnerNotice({
      sourceEvidence: [
        {
          ...f.e.sourceEvidence![0],
          text: '스토리 공유 시 가산점. 홈페이지에서 이벤트 참여. 당첨자는 개별 DM 안내.',
        },
      ],
    });
    assert.deepEqual(unrelated.channels, ['instagram_dm']);
    const story = winnerNotice({
      sourceEvidence: [{ ...f.e.sourceEvidence![0], text: '당첨자 발표: 스토리 및 개별 DM 안내' }],
    });
    assert.deepEqual(story.channels, ['instagram_dm', 'story']);
    assert.equal(winnerNotice({}).basis, 'unknown');
  } finally {
    f.close();
  }
});
test('per-job budgets include all dates and do not trigger calls or change daily limits', async () => {
  const f = fixture();
  try {
    f.store.setSettings('selectionPolicy', { discoveryTokens: 100, discoveryCalls: 10 });
    const job = { id: 'metered', kind: 'discover' } as Job;
    let calls = 0;
    const model = meteredModel(
      f.store,
      {
        decide: async () => {
          calls++;
          return {
            step: { action: 'done', observationId: 'x', reason: 'fixture' },
            inputTokens: 50,
            outputTokens: 10,
          };
        },
      },
      job,
    );
    f.store.db
      .prepare('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?)')
      .run('old', '2020-01-01', job.id, 90, 10, null, 'reported', 1);
    await assert.rejects(
      () =>
        model.decide(
          { kind: 'api', model: 'fixture' },
          '',
          {},
          Buffer.alloc(0),
          new AbortController().signal,
        ),
      /selection_token_limit/,
    );
    assert.equal(calls, 0);
    f.store.setSettings('selectionPolicy', { discoveryCalls: 5 });
    for (let i = 0; i < 4; i++)
      f.store.db
        .prepare('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?)')
        .run('more' + i, '2020-01-01', job.id, 0, 0, null, 'reported', 1);
    await assert.rejects(
      () =>
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
    assert.equal(f.store.settings('operations', null), null);
  } finally {
    f.close();
  }
});

test('changed selection settings do not reuse exclusions from a different scope', () => {
  const stamp = new Date().toISOString();
  const prior = {
    id: 'prior',
    kind: 'discover',
    goal: 'same',
    selectionKey: 'strict',
    createdAt: stamp,
    updatedAt: stamp,
    browserEngine: 'chromium',
    prepareOne: { revision: 'same' },
    history: [
      { action: 'skip_source', url: 'https://example.org/event', reason: '필수 설문 제외 설정' },
    ],
  } as Job;
  discoveryState(prior).rejected = [
    { url: 'https://example.org/event', reason: '필수 설문 제외 설정' },
  ];
  const fresh = { ...prior, id: 'fresh', selectionKey: 'broad', history: [], discovery: undefined };
  reuseDiscoveryRejections(fresh, [prior]);
  assert.deepEqual(fresh.discovery?.reusedRejections, []);
});
