import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { inspectForm, applyAnswers, advanceForm, moaformSnapshot } from '../../src/forms.js';
import { createAutonomy, syntheticSettings, resolveAnswer } from '../../src/autonomy.js';

async function fixture(html: string, run: (page: Page) => Promise<void>) {
  const b = await chromium.launch();
  try {
    const p = await b.newPage();
    await p.route('https://example.org/**', (r) =>
      r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }),
    );
    await p.goto('https://example.org/event');
    await run(p);
  } finally {
    await b.close();
  }
}
const signal = () => new AbortController().signal;
const scales = ['정보를 찾기 편한가요?', '디자인에 만족하시나요?']
  .map(
    (label, i) =>
      `<dl><dt><span>${label}</span></dt><dd><ul>${['매우만족', '만족', '보통']
        .map(
          (answer, n) =>
            `<li><input type="radio" name="rating${i}" id="r${i}-${n === 2 ? 1 : n}" value="${n}"><label for="r${i}-${n}">${answer}</label></li>`,
        )
        .join('')}</ul></dd></dl>`,
  )
  .join('');

test('legacy definition lists distinguish identical scales and broken label IDs; bounded phone parts fill once', async () =>
  fixture(
    `<form>${scales}<dl><dt>홈페이지 개선 의견</dt><textarea title="개선사항"></textarea></dl>
    <fieldset><li><label for="name">이름</label><input id="name"></li>
    <li><label for="p1">휴대폰번호</label><input id="p1" maxlength="3"> - <input id="p2" maxlength="4"> - <input id="p3" maxlength="4"><input type="hidden" name="phone"></li></fieldset>
    <button type="submit">제출</button></form>`,
    async (page) => {
      const { view } = await inspectForm(page);
      assert.equal(view.questions.length, 7);
      assert.deepEqual(
        view.questions.slice(0, 2).map((q) => q.label),
        ['정보를 찾기 편한가요?', '디자인에 만족하시나요?'],
      );
      assert.deepEqual(
        view.questions[0]!.options.map((o) => o.label),
        ['매우만족', '만족', '보통'],
      );
      const state = createAutonomy(syntheticSettings, 'https://example.org');
      const answers = new Map(
        view.questions
          .filter((q) => /휴대폰/.test(q.label))
          .map((q) => [q.id, resolveAnswer(q, undefined, state, [], '').answer!]),
      );
      assert.equal(answers.size, 3);
      assert.deepEqual([...answers.values()], [['010'], ['0000'], ['0000']]);
      answers.set(view.questions[0]!.id, ['만족']);
      answers.set(view.questions[1]!.id, ['보통']);
      await applyAnswers(page, view, answers, () => {}, signal());
      assert.equal(await page.locator('#p1').inputValue(), '010');
      assert.equal(await page.locator('#p2').inputValue(), '0000');
      assert.equal(await page.locator('[name=rating1]:checked').getAttribute('value'), '2');
      assert.match(JSON.stringify(await moaformSnapshot(page)), /세 번째 4자리/);
      assert.equal((await inspectForm(page)).view.fingerprint, view.fingerprint);
    },
  ));

test('normal input hides placeholder, adds clear button and inserts hidden controls without invalidating or misbinding answers', async () =>
  fixture(
    `<form action="/submit"><div role="listitem"><div role="heading">이름</div><input aria-label="이름"><span aria-hidden="true">내 답변</span><output></output></div>
  <div role="listitem"><div role="heading">개인정보 동의</div><p class="notice">받는 자: 예시기관. 이름을 경품 발송에 이용, 7일 보관.</p>
  <div role="radiogroup" aria-label="개인정보 동의"><div role="radio" aria-label="동의" aria-checked="false">동의</div><div role="radio" aria-label="미동의" aria-checked="false">미동의</div></div></div><button type="submit">제출</button></form>
  <script>window.posts=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.posts++};
  document.querySelector('input').oninput=e=>{document.querySelector('span').style.display='none';document.querySelector('output').textContent=e.target.value;document.querySelector('form').insertAdjacentHTML('afterbegin','<input type="hidden"><button type="button">선택 해제</button>');};
  document.querySelectorAll('[role=radio]').forEach(el=>el.onclick=()=>{el.parentElement.querySelectorAll('[role=radio]').forEach(c=>c.setAttribute('aria-checked',String(c===el)));document.body.insertAdjacentHTML('afterbegin','<div role="radio" style="display:none"></div>')});</script>`,
    async (page) => {
      const { view } = await inspectForm(page);
      assert.match(view.questions[1]!.description!, /예시기관.*7일/);
      const answers = new Map([
        [view.questions[0]!.id, ['가상 참가자']],
        [view.questions[1]!.id, ['동의']],
      ]);
      await applyAnswers(page, view, answers, () => {}, signal());
      assert.equal((await inspectForm(page)).view.fingerprint, view.fingerprint);
      assert.equal(await page.locator('[aria-label=동의]').getAttribute('aria-checked'), 'true');
      assert.doesNotMatch(JSON.stringify((await inspectForm(page)).view), /가상 참가자/);
      await advanceForm(page, view, view.buttons[0]!.id, signal());
      assert.equal(await page.evaluate(() => (window as any).posts), 1);
      await page
        .locator('.notice')
        .evaluate((el) => (el.textContent = '받는 자: 다른 회사. 영구 보관.'));
      await assert.rejects(
        applyAnswers(page, view, answers, () => {}, signal()),
        /form_structure_changed/,
      );
      await assert.rejects(
        advanceForm(page, view, view.buttons[0]!.id, signal()),
        /form_structure_changed/,
      );
      assert.equal(await page.evaluate(() => (window as any).posts), 1);
    },
  ));

test('real question, option, validation, destination changes still invalidate a batch', async () => {
  for (const mutation of [
    "document.querySelector('legend').textContent='새 질문'",
    "document.querySelector('label').lastChild.textContent='새 선택지'",
    "document.querySelector('input').value='changed-wire-value'",
    "document.querySelector('input').required=true",
    "document.querySelector('form').action='/different'",
    "document.querySelector('form').target='_blank'",
  ])
    await fixture(
      '<form action="/submit"><fieldset><legend>평가</legend><label><input type="radio" name="r" value="yes">만족</label></fieldset><button>제출</button></form>',
      async (page) => {
        const { view } = await inspectForm(page);
        await page.evaluate(mutation);
        await assert.rejects(
          applyAnswers(
            page,
            view,
            new Map([[view.questions[0]!.id, ['만족']]]),
            () => {},
            signal(),
          ),
          /form_structure_changed/,
        );
      },
    );
});

test('genuinely ambiguous repeated groups remain blocked instead of receiving positional identities', async () =>
  fixture(
    '<form><label><input type="radio" name="a">만족</label><label><input type="radio" name="b">만족</label></form>',
    async (page) => {
      await assert.rejects(inspectForm(page), /ambiguous_form_questions/);
    },
  ));

test('visible local image participation control is clickable once; handler or destination change invalidates it', async () =>
  fixture(
    '<label>이름<input></label><a href="#this" onclick="window.posts=(window.posts||0)+1"><img alt="참여하기" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%2250%22/%3E"></a><a href="https://elsewhere.invalid" onclick="window.posts=100">참여하기</a>',
    async (page) => {
      const { view } = await inspectForm(page);
      assert.equal(view.buttons.length, 1);
      await advanceForm(page, view, view.buttons[0]!.id, signal());
      assert.equal(await page.evaluate(() => (window as any).posts), 1);
      await page
        .locator('a')
        .first()
        .evaluate((el) => el.setAttribute('onclick', 'window.posts=200'));
      await assert.rejects(
        advanceForm(page, view, view.buttons[0]!.id, signal()),
        /form_structure_changed/,
      );
    },
  ));
