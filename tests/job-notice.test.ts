import test from 'node:test';
import assert from 'node:assert/strict';
import { errorNotice, jobNotice, observationErrorCode } from '../src/job-notice.js';
import { ServiceError } from '../src/auth.js';
import type { Job } from '../src/store.js';

test('stop categories separate limits, user authentication and technical errors without persisting raw messages', () => {
  assert.equal(errorNotice(new ServiceError('selection_call_limit'), 'model').category, 'normal');
  assert.equal(errorNotice(new ServiceError('needs_login_manual'), 'observation').category, 'user');
  const error = new Error(
    'Execution context was destroyed private-password https://example.org/?token=secret',
  );
  assert.equal(observationErrorCode(error), 'observation_navigation_changed');
  const notice = errorNotice(error, 'observation');
  assert.equal(notice.category, 'technical');
  assert.doesNotMatch(JSON.stringify(notice), /password|https|token=|secret/);
  assert.equal(
    errorNotice(new ServiceError('browser_observation_unstable'), 'observation:text').phase,
    'observation:text',
  );
});
test('legacy errors are not guessed; submission uncertainty takes precedence over technical diagnostics', () => {
  const j = {
    status: 'needs_user',
    note: '작업을 완료하지 못했습니다. 연결 상태와 실행 기록을 확인해 주세요.',
  } as Job;
  assert.equal(jobNotice(j)?.code, 'legacy_error_without_diagnostics');
  assert.equal(jobNotice(j)?.category, 'technical');
  j.uncertain = true;
  j.stopReason = errorNotice(new Error(), 'action');
  assert.equal(jobNotice(j)?.category, 'user');
  assert.match(jobNotice(j)!.nextAction, /자동 재시도하지/);
  j.uncertain = false;
  j.status = 'running';
  assert.equal(jobNotice(j), undefined);
});

test('an old observation failure does not replace a new user question with a technical notice', () => {
  const j = {
    status: 'needs_user',
    note: '실제 이용 경험을 확인해 주세요.',
    observationDiagnostics: [
      {
        at: 1,
        stage: 'text',
        code: 'observation_navigation_changed',
        attempt: 3,
        outcome: 'stopped',
      },
    ],
    autonomy: { inbox: {} },
  } as Job;
  assert.equal(jobNotice(j)?.category, 'user');
  j.note = 'browser_observation_unstable';
  assert.equal(jobNotice(j)?.category, 'technical');
  assert.equal(jobNotice(j)?.at, 1, 'projected notices remain stable across polling');
});

test('incomplete local receipt observation is technical, not a server pending or consent request', () => {
  const j = {
    status: 'submission_unknown',
    uncertain: true,
    receiptCheck: { captureIncomplete: true, reason: '관찰 미완료', at: 42 },
  } as Job;
  assert.equal(jobNotice(j)?.category, 'technical');
  assert.equal(jobNotice(j)?.code, 'receipt_capture_incomplete');
  assert.match(jobNotice(j)!.nextAction, /재실행하지/);
  assert.equal(jobNotice(j)?.at, 42);
});

test('form parser/input failures are technical, while scoped review and live page recovery belong to the user', () => {
  for (const code of [
    'ambiguous_form_questions',
    'ambiguous_form_options',
    'form_structure_changed',
    'field_verification_failed',
  ]) {
    const notice = errorNotice(new ServiceError(code), 'form_input');
    assert.equal(notice.category, 'technical');
    assert.match(notice.nextAction, /직접 제출했다면 재개하지/);
    assert.equal(jobNotice({ status: 'needs_user', note: code } as Job)?.category, 'technical');
  }
  for (const code of [
    'autonomy_live_page_required',
    'final_review_changed',
    'form_validation_failed',
  ])
    assert.equal(errorNotice(new ServiceError(code), 'form_input').category, 'user');
  assert.equal(
    jobNotice({
      status: 'needs_user',
      note: '동의를 확인해 주세요.',
      autonomy: { inbox: {} },
    } as Job)?.category,
    'user',
  );
});

test('unverified Google Next shows a page transition issue instead of final receipt uncertainty', () => {
  const job = {
    status: 'submission_unknown',
    uncertain: true,
    note: 'unknown',
    intent: {
      kind: 'step',
      providerControl: 'google-next',
      at: 100,
      url: 'https://docs.google.com/forms/d/e/fixtureGoogle/viewform',
      beforeText: '',
    },
  } as Job;
  assert.equal(jobNotice(job)?.code, 'form_step_unverified');
  assert.equal(jobNotice(job)?.category, 'technical');
  assert.match(jobNotice(job)!.nextAction, /자동 재전송하지/);
  job.intent!.kind = 'submission';
  assert.notEqual(jobNotice(job)?.code, 'form_step_unverified');
});
test('comment read-control failure is technical while personal review and unknown receipt retain priority', () => {
  const job = {
    status: 'paused',
    note: '읽기 동작을 차단했습니다.',
    tasks: [
      { state: 'review', draftPreparation: { state: 'needs_input', failureKind: 'read_control' } },
    ],
  } as Job;
  assert.equal(jobNotice(job)?.category, 'technical');
  assert.equal(jobNotice(job)?.code, 'comment_read_control_unsupported');
  job.uncertain = true;
  assert.equal(jobNotice(job)?.category, 'user');
  job.uncertain = false;
  job.status = 'needs_user';
  job.tasks![0]!.draftPreparation!.failureKind = 'personal_fact';
  assert.equal(jobNotice(job)?.category, 'user');
});
