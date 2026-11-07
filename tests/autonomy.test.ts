import test from 'node:test';
import assert from 'node:assert/strict';
import { completionMessage } from '../src/completion.js';
import { redactContext } from '../src/autonomy.js';
import {
  createAutonomy,
  syntheticSettings,
  resolveAnswer,
  type Question,
  type AnswerPlan,
  type SavedAnswer,
} from '../src/autonomy.js';
const q = (label: string, kind: Question['kind'] = 'radio'): Question => ({
  id: 'q1',
  signature: label,
  label,
  kind,
  required: true,
  multiple: false,
  options:
    kind === 'text'
      ? []
      : [
          { id: '예', label: '예' },
          { id: '아니요', label: '아니요' },
        ],
});
const plan: AnswerPlan = {
  questionId: 'q1',
  source: 'recommendation',
  category: 'evaluation',
  answer: ['예'],
  reason: 'test',
};
test('completion cannot be fabricated by quoting only the positive fragment of a failure', () => {
  assert.equal(completionMessage('제출 완료', '제출 완료되지 않았습니다.'), false);
  assert.equal(completionMessage('접수번호', '접수번호 오류가 발생했습니다.'), false);
  assert.equal(completionMessage('submission complete', 'submission complete: failed'), false);
  assert.equal(
    completionMessage('설문이 완료되었습니다.', '설문이 완료되었습니다.\n감사합니다.'),
    true,
  );
});
test('known private values are removed from nested model context including URL echoes', () => {
  const value = 'demo+user@example.invalid';
  const sanitized = JSON.stringify(
    redactContext(
      {
        url: `https://example.org/?email=${encodeURIComponent(value)}`,
        elements: [{ label: `recipient ${value}` }],
        quote: 'name "private"',
      },
      [value, '"private"'],
    ),
  );
  assert.ok(!sanitized.includes(value));
  assert.ok(!sanitized.includes(encodeURIComponent(value)));
  assert.ok(!sanitized.includes('private'));
});
test('profile resolves locally; unknown facts and first consent cannot be invented by auto recommendations', () => {
  const a = createAutonomy(syntheticSettings, 'https://example.org');
  assert.deepEqual(resolveAnswer(q('이름', 'text'), undefined, a, [], '').answer, [
    '테스트 참가자',
  ]);
  for (const label of ['이용한 경험이 있나요?', '회원인가요?', '개인정보 동의'])
    assert.equal(resolveAnswer(q(label), plan, a, [], '').answer, undefined);
  assert.equal(
    resolveAnswer(q('친구 이름', 'text'), { ...plan, answer: ['가짜이름'] }, a, [], '').answer,
    undefined,
  );
  assert.equal(
    resolveAnswer(
      q('전화번호 입력 예시를 설명해주세요', 'text'),
      { ...plan, answer: ['예시'] },
      a,
      [],
      '',
    ).answer,
    undefined,
  );
  assert.deepEqual(resolveAnswer(q('디자인이 적절하다'), plan, a, [], '').answer, ['예']);
  a.policy = { ...a.policy, autoRecommendations: false };
  assert.deepEqual(resolveAnswer(q('디자인이 적절하다'), plan, a, [], '').recommendation, ['예']);
  assert.equal(resolveAnswer(q('디자인이 적절하다'), plan, a, [], '').answer, undefined);
});
test('single-choice conflict uses explicit priority policy; exact memory stays origin scoped', () => {
  const a = createAutonomy(syntheticSettings, 'https://example.org');
  const p = { ...plan, answer: ['예', '아니요'] };
  assert.deepEqual(resolveAnswer(q('디자인'), p, a, [], '').answer, ['예']);
  a.policy = { ...a.policy, singleChoice: 'ask' };
  assert.equal(resolveAnswer(q('디자인'), p, a, [], '').answer, undefined);
  const question = q('회원인가요?');
  const memory: SavedAnswer = {
    id: 'm',
    question: question.label,
    signature: question.signature,
    kind: 'radio',
    answer: ['아니요'],
    origin: a.origin,
    category: 'fact',
    at: '',
  };
  assert.deepEqual(resolveAnswer(question, undefined, a, [memory], '').answer, ['아니요']);
  assert.equal(
    resolveAnswer(question, undefined, { ...a, origin: 'https://other.org' }, [memory], '').answer,
    undefined,
  );
  assert.equal(
    resolveAnswer(
      q('가입했나요?'),
      { ...plan, source: 'memory', sourceId: 'm', category: 'fact' },
      a,
      [memory],
      '',
    ).answer,
    undefined,
  );
});
test('semantic preference reuse requires its own delegation and cannot invert a preference', () => {
  const a = createAutonomy(syntheticSettings, 'https://example.org');
  const question = {
    ...q('원하는 경품은?'),
    options: [
      { id: '커피', label: '커피' },
      { id: '차', label: '차' },
    ],
  };
  const memory: SavedAnswer = {
    id: 'm',
    signature: 'other',
    question: '선호 경품',
    kind: 'radio',
    answer: ['커피'],
    origin: a.origin,
    category: 'preference',
    at: '',
  };
  const p: AnswerPlan = { ...plan, source: 'memory', sourceId: 'm', category: 'preference' };
  assert.equal(resolveAnswer(question, p, a, [memory], '').answer, undefined);
  a.policy = { ...a.policy, semanticPreferenceReuse: true };
  assert.deepEqual(resolveAnswer(question, p, a, [memory], '').answer, ['커피']);
  assert.equal(
    resolveAnswer({ ...question, label: '싫은 경품은?' }, p, a, [memory], '').answer,
    undefined,
  );
});
