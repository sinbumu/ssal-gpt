import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAutonomy,
  syntheticSettings,
  renewAutonomy,
  delegationIssue,
} from '../src/autonomy.js';
import { errorNotice } from '../src/job-notice.js';
import { ServiceError } from '../src/auth.js';

test('explicit time renewal preserves answers, costs and exhausted recovery budget, never approvals', () => {
  const state = createAutonomy(syntheticSettings, 'https://example.org');
  state.expires = Date.now() - 1;
  state.overrides = { preference: ['A'] };
  state.reused = { inferred: ['B'] };
  state.metrics.modelCalls = 4;
  state.metrics.recoveries = 3;
  state.plan = { fingerprint: 'old', answers: [] };
  state.inbox = { id: 'old', fingerprint: 'old', items: [], createdAt: 1, final: true };
  state.finalApproval = 'old';
  assert.equal(delegationIssue(state, syntheticSettings), 'expired');
  const renewed = renewAutonomy(state, syntheticSettings);
  assert.equal(delegationIssue(renewed, syntheticSettings), undefined);
  assert.deepEqual(renewed.overrides, state.overrides);
  assert.deepEqual(renewed.metrics, state.metrics);
  assert.equal(renewed.origin, state.origin);
  assert.ok(renewed.expires > Date.now());
  for (const key of ['inbox', 'plan', 'finalApproval', 'reused'] as const)
    assert.equal(renewed[key], undefined);
  assert.equal(state.finalApproval, 'old', 'renewal does not mutate the input before commit');
  assert.deepEqual(
    renewAutonomy(state, { ...syntheticSettings, revision: 'changed' }).overrides,
    {},
  );
  const notice = errorNotice(new ServiceError('delegation_expired_or_changed'), 'form_navigation');
  assert.match(notice.reason, /24시간/);
  assert.match(notice.nextAction, /위임 갱신하고 현재 화면에서 재개/);
});
