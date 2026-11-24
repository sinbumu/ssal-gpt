import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, type EventRecord } from '../src/store.js';
import { evaluateCandidate } from '../src/selection.js';
import { preparationReasons } from '../src/workflow.js';
import {
  QualificationProfileSchema,
  participantConditions,
  saveEventQualifications,
  jobParticipantCheck,
  verifyQualificationActor,
} from '../src/qualifications.js';

const url = 'https://www.instagram.com/p/fixture/';
const adult = {
  key: 'adult',
  acceptedValues: ['성인'],
  quote: '1. 본 이벤트는 성인만 참여 가능합니다.',
};
const account = {
  key: 'account_type',
  acceptedValues: ['공개 계정이며 이벤트 계정이 아님'],
  quote: '2. 비공개 계정, 이벤트 계정은 참여가 제외됩니다.',
};
const member = {
  key: 'system_user',
  acceptedValues: ['예시포털 시스템 사용자'],
  quote: '□ 참여 대상: 예시포털 시스템 사용자',
};
const follower = {
  key: 'follower_status',
  acceptedValues: ['이벤트 기간 내 신규 팔로워'],
  quote: '이벤트 기간 내 신규 팔로워만 해당',
};
const course = '교육원에서 수강한 강좌 중 추천하는 강좌명을 적어주세요.';
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-conditions-'));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const text = [
    adult.quote,
    account.quote,
    member.quote,
    follower.quote,
    course,
    '공개 계정 전환 필수',
    '댓글 작성',
  ].join('\n');
  const e = store.record(
    {
      title: '가상교육원 설문',
      organizer: '가상교육원',
      entryUrl: url,
      deadline: '2099-03-11T00:00:00Z',
      prize: '커피',
      winners: 1,
      effortMinutes: 2,
      evidenceQuote: text,
      evidenceKind: 'text',
      eligibility: [adult, account],
      requirements: ['댓글 작성'],
      blockers: ['성인 여부 및 공개·비이벤트 계정 자격 확인 필요'],
      tasks: [
        {
          kind: 'comment',
          url,
          instruction: '댓글 작성',
          quote: '댓글 작성',
          id: 'a',
          dependsOn: [],
        },
      ],
    },
    url,
    'fixture',
    'fixture.png',
    {
      sourceEvidence: [
        { id: 'fixture', url, text, title: '공고', observedAt: 0, screenshot: 'fixture.png' },
      ],
    },
  ).event;
  store.setSettings('instagramBrowser', { enabled: true });
  return { e, store };
}
test('common facts resolve an entire duplicate summary only with observed terms and the specified participant', (t) => {
  const { store, e } = fixture(t);
  assert.equal(evaluateCandidate(store, e).state, 'review');
  store.setSettings('autonomy', { profile: { ageRange: '30대' }, policy: {}, revision: 'r' });
  assert.equal(
    evaluateCandidate(store, e).conditions.find((c) => c.kind === 'adult')?.basis,
    '저장된 연령대',
  );
  const p = QualificationProfileSchema.parse({
    instagram: '@Demo',
    publicAccount: 'yes',
    eventAccount: 'no',
  });
  assert.equal(p.instagram, 'demo');
  store.setSettings('qualificationProfile', p);
  assert.deepEqual(preparationReasons(store, e), []);
  const check = { participantCheck: jobParticipantCheck(store, e) };
  verifyQualificationActor(check, 'demo');
  assert.throws(() => verifyQualificationActor(check, 'different'), /qualification_actor_mismatch/);
  const changed = { ...e, blockers: [e.blockers[0] + ' 및 구매 필수'] };
  assert.equal(evaluateCandidate(store, changed).state, 'review');
  assert.equal(evaluateCandidate(store, { ...e, sourceEvidence: [] }).state, 'review');
  store.setSettings('qualificationProfile', { ...p, eventAccount: 'yes' });
  assert.equal(evaluateCandidate(store, e).state, 'excluded');
  assert.equal(e.blockers.length, 1);
});
test('service membership is exact, or can be answered for one observed event and revoked', (t) => {
  const { store, e } = fixture(t);
  const event = { ...e, eligibility: [member], blockers: ['예시포털 시스템 사용자 여부 미확인'] };
  const check = () => evaluateCandidate(store, event);
  store.setSettings('qualificationProfile', { services: ['다른포털', '예시포털2'] });
  assert.equal(check().state, 'review');
  const { id } = check().conditions[0]!;
  const save = (value: 'unknown' | 'yes' | 'no') =>
    saveEventQualifications(store, event, { answers: [{ id, value }] });
  save('no');
  assert.equal(check().state, 'excluded');
  save('yes');
  assert.equal(check().state, 'eligible');
  assert.equal(evaluateCandidate(store, { ...event, id: 'different' }).state, 'review');
  save('unknown');
  assert.equal(check().state, 'review');
  store.setSettings('qualificationProfile', { services: ['예시포털'] });
  assert.equal(check().state, 'eligible');
  save('no');
  assert.equal(check().state, 'excluded');
  save('unknown');
  assert.equal(check().state, 'eligible');
});
test('event-only course and period-dependent follower checks do not cross accounts, dates or changes to the conditions', (t) => {
  const { store, e } = fixture(t);
  const event: EventRecord = {
    ...e,
    eligibility: [follower],
    entryNeeds: { personalResponse: { required: true, quote: course }, logins: [] },
    requirements: ['공개 계정 전환 필수'],
    blockers: ['가상교육원 강좌 수강 경험 및 기간 내 신규 팔로워 여부 확인 필요'],
  };
  const p = { instagram: 'demo', publicAccount: 'yes' };
  const checks = () => participantConditions(store, event).checks;
  const missing = checks().find((c) => c.kind === 'follower')!;
  assert.ok(missing.needsAccount);
  assert.throws(() =>
    saveEventQualifications(store, event, { answers: [{ id: missing.id, value: 'yes' }] }),
  );
  store.setSettings('qualificationProfile', p);
  const answers = checks()
    .filter((c) => c.scope === 'event')
    .map((c) => ({ id: c.id, value: 'yes' as const }));
  assert.equal(answers.length, 2);
  saveEventQualifications(store, event, { answers });
  assert.deepEqual(preparationReasons(store, event), []);
  assert.equal(evaluateCandidate(store, { ...event, deadlineDate: '2099-03-12' }).state, 'review');
  store.setSettings('qualificationProfile', { ...p, instagram: 'new' });
  assert.equal(evaluateCandidate(store, event).state, 'review');
  assert.throws(
    () => saveEventQualifications(store, event, { answers }),
    /qualification_question_changed/,
  );
  store.claimSubmission(event.id, 'ownership');
  assert.throws(
    () => saveEventQualifications(store, event, { answers }),
    /cannot_review_started_event/,
  );
});
