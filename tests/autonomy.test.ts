import test from 'node:test';
import assert from 'node:assert/strict';
import { completionMessage } from '../src/completion.js';
import { redact, redactContext, ProfileSchema } from '../src/autonomy.js';
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
  assert.equal(
    completionMessage(
      '답변이 제출되었습니다.',
      '답변이 제출되었습니다.\n다음 달에도 참여 바랍니다.',
    ),
    true,
  );
  assert.equal(
    completionMessage(
      '답변이 제출되었습니다.',
      '답변이 제출되었습니다. 처리 오류가 발견되었습니다.',
    ),
    false,
  );
  assert.equal(completionMessage('답변이 제출되었습니다.', '답변이 제출되지 않았습니다.'), false);
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
test('phone formatting follows the field hint without changing profile or inventing digits', () => {
  const a = createAutonomy(syntheticSettings, 'https://example.org');
  a.profile = { ...a.profile, phone: '01000000000' };
  const question = { ...q('연락처', 'text'), description: '중간에 하이픈을 넣어주세요.' };
  assert.deepEqual(resolveAnswer(question, undefined, a, [], '').answer, ['010-0000-0000']);
  assert.equal(a.profile.phone, '01000000000');
  assert.deepEqual(
    resolveAnswer(q('연락처', 'text'), undefined, a, [], '하이픈을 넣어주세요').answer,
    ['01000000000'],
  );
  a.profile.phone = '010-0000-0000';
  assert.deepEqual(
    resolveAnswer({ ...question, description: '하이픈 없이 숫자만 입력' }, undefined, a, [], '')
      .answer,
    ['01000000000'],
  );
  a.profile.phone = '+82 10 0000 0000';
  assert.deepEqual(resolveAnswer(question, undefined, a, [], '').answer, ['+82 10 0000 0000']);
});

test('shipping profile separates region, base, detail and postal code; ambiguous or other-party addresses stay unanswered', () => {
  const a = createAutonomy(syntheticSettings, 'https://example.org');
  a.profile = ProfileSchema.parse({
    region: '가상도',
    shippingAddress: '가상도 예시시 테스트로 10',
    shippingAddressDetail: '101호',
  });
  const base = { ...q('배송 주소', 'text'), id: 'base' },
    detail = { ...q('상세 주소', 'text'), id: 'detail' };
  assert.deepEqual(resolveAnswer(q('거주지역', 'text'), undefined, a, [], '').answer, ['가상도']);
  assert.deepEqual(resolveAnswer(base, undefined, a, [], '', [base, detail]).answer, [
    a.profile.shippingAddress,
  ]);
  assert.deepEqual(resolveAnswer(detail, undefined, a, [], '', [base, detail]).answer, ['101호']);
  assert.deepEqual(resolveAnswer(base, undefined, a, [], '').answer, [
    `${a.profile.shippingAddress}, 101호`,
  ]);
  assert.deepEqual(resolveAnswer(q('주소 (상세주소 포함)', 'text'), undefined, a, [], '').answer, [
    `${a.profile.shippingAddress}, 101호`,
  ]);
  assert.equal(
    resolveAnswer(q('우편번호', 'text'), { ...plan, answer: ['99999'] }, a, [], '').answer,
    undefined,
  );
  for (const label of [
    '친구 배송주소',
    '회사 주소',
    '행사장 주소',
    '주소',
    '주소 (시·도까지만)',
    '배송주소와 우편번호',
  ])
    assert.equal(
      resolveAnswer(
        q(label, 'text'),
        { ...plan, answer: ['가짜 주소'] },
        a,
        [],
        '경품 배송용입니다',
      ).answer,
      undefined,
      label,
    );
  a.profile.postalCode = '01234';
  assert.deepEqual(resolveAnswer(q('우편번호', 'text'), undefined, a, [], '').answer, ['01234']);
  a.profile.email = 'fixture@example.invalid';
  assert.deepEqual(resolveAnswer(q('이메일 주소', 'text'), undefined, a, [], '').answer, [
    'fixture@example.invalid',
  ]);
  assert.throws(() => ProfileSchema.parse({ postalCode: '123' }));
});

test('overlapping region and shipping address are masked longest first, including wrapped text and URL echoes', () => {
  const profile = ProfileSchema.parse({
    region: '가상도',
    shippingAddress: '가상도 예시시 테스트로 10',
    shippingAddressDetail: '101호',
  });
  const text = `${profile.shippingAddress}, 101호`;
  assert.equal(redact(text, profile), '[저장된 정보], [저장된 정보]');
  const result = JSON.stringify(
    redactContext(
      { text: text.replaceAll(' ', '\n'), url: encodeURIComponent(text) },
      Object.values(profile),
    ),
  );
  for (const word of ['예시시', '테스트로', '101호']) {
    assert.ok(!result.includes(word));
    assert.ok(!result.includes(encodeURIComponent(word)));
  }
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

test('public evidence and observed route are reusable, but never authorize invented personal facts or consent', () => {
  const a = createAutonomy(syntheticSettings, 'https://example.org');
  a.evidence = [
    {
      id: 'source',
      url: 'https://example.org/article',
      title: '원문',
      text: '정답은 예입니다.',
      screenshot: 'test.png',
      observedAt: Date.now(),
    },
  ];
  const p: AnswerPlan = {
    ...plan,
    source: 'evidence',
    sourceId: 'source',
    category: 'knowledge',
    answer: ['예'],
    evidenceQuote: '정답은 예입니다.',
  };
  assert.deepEqual(resolveAnswer(q('퀴즈'), p, a, [], '').answer, ['예']);
  assert.equal(
    resolveAnswer(q('퀴즈'), { ...p, evidenceQuote: '거짓 근거' }, a, [], '').answer,
    undefined,
  );
  for (const label of ['회원인가요?', '구매한 경험', '개인정보 동의'])
    assert.equal(resolveAnswer(q(label), p, a, [], '').answer, undefined);
  a.evidence[0]!.url = 'https://search.naver.com/search.naver?query=quiz';
  assert.equal(resolveAnswer(q('퀴즈'), p, a, [], '').answer, undefined);
  a.entryChannel = '인스타그램';
  assert.deepEqual(resolveAnswer(q('참여 경로', 'text'), undefined, a, [], '').answer, [
    '인스타그램',
  ]);
  assert.equal(
    resolveAnswer(q('평소 이용하는 SNS', 'text'), undefined, a, [], '').answer,
    undefined,
  );
});
