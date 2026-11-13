import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CommentPlanSchema,
  commentPlanProblem,
  commentContentProblem,
  commentAnswersProblem,
  composeComment,
  type CommentPlan,
} from '../src/comment-content.js';

const plan: CommentPlan = {
  parts: [{ text: 'Q1 2번' }, { inputId: 'q2', prefix: ' / Q2 ', suffix: '' }],
  inputs: [
    {
      id: 'q2',
      label: '수익을 언제 받고 싶나요?',
      kind: 'choice',
      options: [
        { id: 'once', label: '처음 한 번만', text: '1번' },
        { id: 'each', label: '판매될 때마다', text: '2번' },
      ],
    },
  ],
};
test('personal answers compose with public copy without inventing or leaking question labels', () => {
  assert.equal(commentPlanProblem(CommentPlanSchema.parse(plan)), undefined);
  assert.equal(composeComment(plan), 'Q1 2번');
  assert.equal(composeComment(plan, { q2: 'each' }), 'Q1 2번 / Q2 2번');
  assert.equal(commentAnswersProblem(plan, {}, 'Q1 2번'), 'comment_personal_answer_required');
  assert.equal(
    commentAnswersProblem(plan, { q2: 'invented' }, 'Q1 2번 / Q2 2번'),
    'comment_personal_answer_required',
  );
  assert.equal(
    commentAnswersProblem(plan, { q2: 'each' }, 'Q1 2번 / Q2 1번'),
    'comment_personal_answer_mismatch',
  );
  assert.equal(commentAnswersProblem(plan, { q2: 'each' }, 'Q1 2번 / Q2 2번!'), undefined);
  assert.equal(
    commentPlanProblem({ ...plan, parts: [...plan.parts, plan.parts[1]!] }),
    'comment_plan_invalid',
  );
  assert.equal(
    commentPlanProblem({ ...plan, parts: [{ inputId: 'other', prefix: '', suffix: '' }] }),
    'comment_plan_invalid',
  );
});
test('narrow guidance guard catches the real failure and placeholders without blocking ordinary opinions', () => {
  for (const text of [
    'Q1 2번 / Q2 2번. 저장된 개인 의견 직접 확인·게시 문구 승인 정책에 따른 요청입니다',
    '대시보드에서 검토해 주세요. 응원합니다!',
    '과제 확인을 한 번에 저장하고 계속',
    'Please click approve in dashboard. Per-task posting approval policy.',
  ])
    assert.equal(commentContentProblem(text), 'comment_contains_guidance', text);
  assert.equal(commentContentProblem('정답 {{answer}}'), 'comment_unresolved_placeholder');
  for (const text of [
    '정답은 2번입니다! 좋은 정책을 응원합니다.',
    '대시보드 디자인이 보기 좋아요.',
    'Q1 2번 / Q2 2번',
  ])
    assert.equal(commentContentProblem(text), undefined, text);
  const free: CommentPlan = {
    parts: [{ text: '내 의견: ' }, { inputId: 'opinion', prefix: '', suffix: '' }],
    inputs: [{ id: 'opinion', label: '의견', kind: 'text', options: [] }],
  };
  assert.equal(
    commentAnswersProblem(
      free,
      { opinion: '대시보드에서 승인해 주세요' },
      '내 의견: 대시보드에서 승인해 주세요',
    ),
    'comment_contains_guidance',
  );
});
