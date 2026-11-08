import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { inspectForm, applyAnswers, formValuesHash, moaformSnapshot } from '../../src/forms.js';
import { createAutonomy, syntheticSettings, resolveAnswer } from '../../src/autonomy.js';

const fixture = `<html><head><meta charset="utf-8"></head><body>
<p>이벤트 접수와 경품 발송을 위해 이름, 전화번호를 수집·이용합니다.</p>
<p>개인정보 수집 동의를 거부할 수 있으며, 거부하면 응모할 수 없습니다. 발송 후 폐기합니다.</p>
<div style="height:1000px">소개 이미지 자리</div>
<div class="js-question"><span class="wf-icon-required">*</span><div class="js-question-content">표시된 색상은?</div><ul>
<li class="select-one-and-many"><span class="wf-radio"><i class="fi-radio-btn-no"></i></span><div class="wf-style-mutiplechoice-text">파랑</div></li>
<li class="select-one-and-many"><span class="wf-radio"><i class="fi-radio-btn-no"></i></span><div class="wf-style-mutiplechoice-text">초록</div></li></ul></div>
<div class="js-question"><span class="wf-icon-required">*</span><div class="js-question-content">성함을 작성해주세요.</div><textarea></textarea><label class="wf-style-textanswer__placeholder">참여자 실명</label></div>
<div class="js-question"><span class="wf-icon-required">*</span><div class="js-question-content">휴대전화번호 (-없이 번호만 입력)</div><textarea></textarea></div>
<button type="submit">다음</button>
<script>document.querySelectorAll('.select-one-and-many').forEach(el=>el.onclick=()=>{document.querySelectorAll('.select-one-and-many').forEach(n=>{n.classList.remove('clicked');n.querySelector('i').className='fi-radio-btn-no'});el.classList.add('clicked');el.querySelector('i').className='fi-radio-btn-yes-dot'});</script>
</body></html>`;

test('Moaform binds rendered labels and choices, requires notice consent, verifies inputs and review changes', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.route('**/*', (r) => r.fulfill({ contentType: 'text/html', body: fixture }));
    await page.goto('https://answer.moaform.com/answers/synthetic');
    const { view } = await inspectForm(page);
    assert.equal(view.questions.length, 4);
    assert.ok(view.questions.every((q) => q.required));
    const consent = view.questions.find((q) => q.label.includes('동의'))!;
    const name = view.questions.find((q) => q.label.includes('성함'))!;
    const phone = view.questions.find((q) => q.label.includes('전화'))!;
    const quiz = view.questions.find((q) => q.label.includes('색상'))!;
    const state = createAutonomy(syntheticSettings, new URL(page.url()).origin, true);
    assert.equal(resolveAnswer(consent, undefined, state, [], '').consent?.decision, 'ask');
    assert.deepEqual(resolveAnswer(name, undefined, state, [], '').answer, ['테스트 참가자']);
    assert.deepEqual(resolveAnswer(phone, undefined, state, [], '').answer, ['01000000000']);
    const answers = new Map([
      [name.id, ['테스트 참가자']],
      [phone.id, ['01000000000']],
      [quiz.id, ['초록']],
    ]);
    await assert.rejects(
      applyAnswers(page, view, answers, () => {}, new AbortController().signal),
      /privacy_notice_not_accepted/,
    );
    assert.equal(await page.locator('textarea').first().inputValue(), '');
    answers.set(consent.id, ['동의하지 않음']);
    await assert.rejects(
      applyAnswers(page, view, answers, () => {}, new AbortController().signal),
      /privacy_notice_not_accepted/,
    );
    answers.set(consent.id, ['안내에 동의하고 진행']);
    await applyAnswers(page, view, answers, () => {}, new AbortController().signal);
    assert.equal((await inspectForm(page)).view.fingerprint, view.fingerprint);
    const review = await moaformSnapshot(page);
    assert.ok(review[0]!.fields.some((f) => f.value === '초록' && 'checked' in f && f.checked));
    assert.ok(review[0]!.fields.some((f) => f.label === name.label && f.value === '테스트 참가자'));
    const before = await formValuesHash(page);
    await page.locator('.select-one-and-many').first().click();
    assert.notEqual(
      await formValuesHash(page),
      before,
      'user choice changes invalidate final review',
    );
    await page
      .locator('.js-question-content')
      .first()
      .evaluate((el) => (el.textContent = '바뀐 질문'));
    await assert.rejects(
      applyAnswers(page, view, answers, () => {}, new AbortController().signal),
      /form_structure_changed/,
    );
  } finally {
    await browser.close();
  }
});

test('Moaform rejects unsupported choice widgets instead of ignoring their required answer', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.route('**/*', (r) =>
      r.fulfill({ contentType: 'text/html', body: fixture.replaceAll('wf-radio', 'wf-checkbox') }),
    );
    await page.goto('https://answer.moaform.com/answers/synthetic');
    await assert.rejects(inspectForm(page), /unsupported_moaform_question/);
  } finally {
    await browser.close();
  }
});
