import test from 'node:test';
import assert from 'node:assert/strict';
import { draftProblem, prepareCommentDraft, DRAFT_VERSION } from '../src/task-draft.js';
import type { Step } from '../src/model.js';
import type { EntryTask } from '../src/tasks.js';
import type { Job } from '../src/store.js';

test('prefixed read repair never restarts new failures, personal answers, evidence gaps or transmitted tasks', async () => {
  for (const scenario of [
    'new_version',
    'personal',
    'evidence',
    'plain_path',
    'other_host',
    'transmitted',
    'uncertain',
  ]) {
    const task = {
      kind: 'comment',
      state: 'review',
      url: 'https://www.instagram.com/brand/p/fixture/',
      draftPreparation: {
        version: DRAFT_VERSION,
        state: 'needs_input',
        failureKind: 'read_control',
        calls: 4,
      },
    } as EntryTask;
    const job = { steps: 10, maxSteps: 20, history: [] } as unknown as Job;
    if (scenario === 'new_version') task.draftPreparation!.readPathVersion = 1;
    if (scenario === 'personal') task.draftPreparation!.failureKind = 'personal_fact';
    if (scenario === 'evidence') task.draftPreparation!.failureKind = 'public_evidence';
    if (scenario === 'plain_path') task.url = 'https://www.instagram.com/p/fixture/';
    if (scenario === 'other_host') task.url = 'https://example.org/brand/p/fixture/';
    if (scenario === 'transmitted') job.transmitted = true;
    if (scenario === 'uncertain') job.uncertain = true;
    const unused = new Proxy(
      {},
      {
        get() {
          throw Error('no I/O expected: ' + scenario);
        },
      },
    ) as any;
    assert.equal(
      await prepareCommentDraft(unused, unused, unused, job, task, new AbortController().signal),
      false,
    );
    assert.equal(task.draftPreparation!.calls, 4);
    assert.equal(task.draftPreparation!.readPathRepair, undefined);
    assert.equal(job.steps, 10);
    assert.equal(job.maxSteps, 20);
  }
});

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

test('visible object counts do not require a personal quiz score ledger', () => {
  const step: Step = {
    action: 'done',
    observationId: 'fixture',
    reason: '그림의 공개 단서',
    text: '정답은 3개입니다!',
    draftBasis: 'inference',
    draftRequirementsMet: true,
  };
  const objectCount = {
    instruction: '그림의 동그라미 개수를 확인하고 정답 댓글을 작성합니다. 친구 태그는 제외합니다.',
    quote: '여섯 개의 그림 중 동그라미는 몇 개일까요?\n정답을 댓글로 남겨주세요.',
  };
  assert.equal(draftProblem(objectCount, step), undefined);
  assert.equal(
    draftProblem(
      { instruction: '정답 개수를 댓글로 남겨주세요.', quote: '그림 속 동그라미 찾기' },
      step,
    ),
    undefined,
  );
  for (const instruction of [
    '맞힌 문제 개수를 남기세요.',
    'OX 퀴즈 정답 개수를 남기세요.',
    '몇 문제를 맞혔는지 남겨주세요.',
    'Report your quiz score.',
  ]) {
    assert.match(draftProblem({ instruction, quote: '' }, step)!, /검증하지 못했습니다/);
  }
  assert.match(
    draftProblem(objectCount, { ...step, draftScore: { correct: 3, total: 6 } })!,
    /검증하지 못했습니다/,
  );
});
