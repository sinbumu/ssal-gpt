import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAutonomy,
  syntheticSettings,
  resolveAnswer,
  type Question,
  type AnswerPlan,
} from '../src/autonomy.js';
import {
  rememberKnowledge,
  preparedAnswer,
  knowledgeBlocker,
  formForPlanner,
} from '../src/question-answering.js';
import type { Job } from '../src/store.js';

const question: Question = {
  id: 'q1',
  signature: 's1',
  label: '두 지역의 합계는?',
  kind: 'radio',
  required: true,
  multiple: false,
  options: [
    { id: '30', label: '30' },
    { id: '40', label: '40' },
  ],
  material: {
    text: '공개 표: 가상동 10개, 예시동 20개.',
    links: [],
    imageAlts: [],
    truncated: false,
  },
};
const plan: AnswerPlan = {
  questionId: 'q1',
  category: 'knowledge',
  source: 'question',
  answer: ['30'],
  evidenceQuote: '가상동 10개, 예시동 20개.',
  reason: '10+20=30',
};
test('rendered local supporting material can answer a quiz without delegating personal recommendations', () => {
  const state = createAutonomy(syntheticSettings, 'https://example.org', true);
  state.policy.autoRecommendations = false;
  assert.deepEqual(resolveAnswer(question, plan, state, [], '').answer, ['30']);
  for (const evidenceQuote of ['30', '두 지역의 합계는?', '보이지 않는 정답은 30'])
    assert.equal(
      resolveAnswer(question, { ...plan, evidenceQuote }, state, [], '').answer,
      undefined,
    );
  for (const label of ['실제 방문한 경험은?', '이름', '개인정보 수집 동의', '인증문자'])
    assert.equal(resolveAnswer({ ...question, label }, plan, state, [], '').answer, undefined);
});
test('prepared answers keep primary-source evidence after research eviction and invalidate changed material', () => {
  const state = createAutonomy(syntheticSettings, 'https://example.org', true);
  const evidence = {
    id: 'e',
    url: 'https://example.org/report',
    title: '보고',
    text: '공식 합계 30개',
    screenshot: 'public.png',
    observedAt: 1,
  };
  state.evidence = [evidence];
  const sourced: AnswerPlan = {
    ...plan,
    source: 'evidence',
    sourceId: 'e',
    evidenceQuote: evidence.text,
  };
  rememberKnowledge(state, question, sourced, 'observed_public_evidence');
  state.evidence = [];
  assert.equal(preparedAnswer(state, question)?.evidence?.id, 'e');
  assert.equal(
    preparedAnswer(state, { ...question, material: { ...question.material!, text: '변경된 표' } }),
    undefined,
  );
  assert.equal(preparedAnswer(state, { ...question, signature: 'different' }), undefined);
});
test('research causes are question-scoped and legacy limits do not become personal-response requests', () => {
  const state = createAutonomy(syntheticSettings, 'https://example.org', true);
  const job = { autonomy: state, maxSteps: 40, steps: 4 } as Job;
  state.questionResearch = [
    {
      signature: 's1',
      questionId: 'q1',
      startedAt: 1,
      calls: 2,
      sourceIds: [],
      stopCode: 'research_rejection_limit',
      lastError: 'statistics_region_unverified',
    },
  ];
  const item = { ...question, category: 'knowledge' as const, reason: 'answer_required' };
  assert.equal(knowledgeBlocker(job, item)?.kind, 'technical');
  assert.equal(knowledgeBlocker(job, item)?.code, 'statistics_region_unverified');
  assert.equal(knowledgeBlocker(job, { ...item, category: 'fact' }), undefined);
  state.questionResearch = [];
  state.researchProgress = { calls: 26, capacity: 26, searches: [], failedUrls: [], stops: [] };
  assert.equal(knowledgeBlocker(job, item)?.kind, 'budget');
  assert.equal(job.maxSteps, 40);
  assert.equal(state.researchProgress.calls, 26);
});
test('large question packets share a bounded material budget including the last question', () => {
  const questions = Array.from({ length: 8 }, (_, i) => ({
    ...question,
    id: `q${i}`,
    material: { ...question.material!, text: 'x'.repeat(6000) },
  }));
  const view = formForPlanner({
    url: 'https://example.org',
    fingerprint: 'f',
    buttons: [],
    questions,
  });
  assert.equal(
    view.questions.reduce((n, q) => n + q.material!.text.length, 0),
    24000,
  );
  assert.ok(view.questions.every((q) => q.material!.truncated));
  assert.equal(questions[7]!.material.text.length, 6000);
});
