import test from 'node:test';
import assert from 'node:assert/strict';
import { draftProblem } from '../src/task-draft.js';
import type { Step } from '../src/model.js';

test('mandatory quiz answers cannot be replaced by cheering or an unverified score', () => {
  const task = {
    instruction: '4가지 OX퀴즈를 풀고 맞힌 문제 개수를 댓글로 남기세요.',
    quote: '퀴즈',
  };
  const step: Step = {
    action: 'done',
    observationId: 'o',
    reason: 'test',
    text: '응원합니다!',
    draftBasis: 'suggestion',
    draftRequirementsMet: true,
  };
  assert.match(draftProblem(task, step)!, /응원 문구/);
  assert.match(
    draftProblem(task, {
      ...step,
      draftBasis: 'inference',
      text: '4개 맞혔습니다!',
      draftScore: { correct: 4, total: 4 },
    })!,
    /검증하지 못했습니다/,
  );
  const quiz = [1, 2, 3, 4].map((number) => ({
    number,
    question: '합성 문제',
    answer: 'O' as const,
    screenshot: 'question',
    frame: 'question',
    key: {
      answer: number === 4 ? ('X' as const) : ('O' as const),
      quote: '합성 정답',
      screenshot: 'key',
    },
  }));
  assert.equal(
    draftProblem(
      task,
      {
        ...step,
        draftBasis: 'inference',
        text: '3개 정답입니다.',
        draftScore: { correct: 3, total: 4 },
      },
      quiz,
    ),
    undefined,
  );
  assert.ok(
    draftProblem(
      task,
      {
        ...step,
        draftBasis: 'inference',
        text: '4개 정답입니다.',
        draftScore: { correct: 4, total: 4 },
      },
      quiz,
    ),
  );
  assert.ok(
    draftProblem(
      task,
      {
        ...step,
        draftBasis: 'inference',
        text: '3개 정답입니다.',
        draftScore: { correct: 3, total: 3 },
      },
      quiz.slice(0, 3),
    ),
  );
  assert.ok(
    draftProblem(
      { instruction: '자유로운 응원 댓글', quote: '응원' },
      { ...step, draftRequirementsMet: false },
    ),
  );
  assert.equal(draftProblem({ instruction: '자유로운 응원 댓글', quote: '응원' }, step), undefined);
});
