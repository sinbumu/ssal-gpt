import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings } from '../../src/autonomy.js';
import { inspectForm } from '../../src/forms.js';
import type { Job } from '../../src/store.js';
import { microsoftFormId } from '../../src/microsoft-forms.js';
const url = 'https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=fixtureOne';
function item(label: string, content: string) {
  return `<div data-automation-id="questionItem"><div data-automation-id="questionTitle" role="heading">${label}<span data-automation-id="requiredStar"></span></div>${content}</div>`;
}
test('respondent route: verified native answers, local Next, one reviewed final POST and a fresh receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-ms-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  try {
    assert.equal(
      microsoftFormId(
        'https://forms.cloud.microsoft.example/Pages/ResponsePage.aspx?id=fixtureOne',
      ),
      undefined,
    );
    assert.equal(microsoftFormId(url + '&id=duplicate'), undefined);
    const config = {
      ...syntheticSettings,
      policy: { ...syntheticSettings.policy, finalSubmit: 'review' as const },
    };
    app.store.setSettings('autonomy', config);
    const j: Job = {
      id: randomUUID(),
      kind: 'apply',
      provider: { kind: 'api', model: 'fixture' },
      goal: 'fixture',
      startUrl: url,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      maxSteps: 15,
      candidateLimit: 1,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      uncertain: false,
      note: '',
      allowedOrigins: [new URL(url).origin],
      approvedTexts: [],
      history: [],
      autonomy: createAutonomy(config, new URL(url).origin),
    };
    app.store.saveJob(j);
    let count = 0;
    await app.browser.selectJob(j.id);
    const field =
      '<input data-automation-id="textInput" aria-label="한 줄 텍스트" aria-required="true">';
    const last =
      item('이름', field) +
      item('이메일 주소', field) +
      '<button data-automation-id="submitButton">제출</button>';
    const first =
      item(
        '퀴즈',
        '<label><input type="radio" name="r" value="A">A</label><label><input type="radio" name="r" value="B">B</label>',
      ) + '<button data-automation-id="nextButton">다음</button>';
    await app.browser.context!.route('**/*', async (r) => {
      if (r.request().method() === 'POST') {
        assert.equal(r.request().url(), new URL('/fixture-submit', url).href);
        count++;
        return r.fulfill({ json: { message: '응답이 제출되었습니다.' } });
      }
      return r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<main>${first}</main><script>document.onclick=async e=>{if(e.target.matches('[data-automation-id=nextButton]')){if(!document.querySelector('input:checked'))throw Error();document.querySelector('main').innerHTML=${JSON.stringify(last)}}else if(e.target.matches('[data-automation-id=submitButton]')){await fetch('/fixture-submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({answers:[...document.querySelectorAll('input')].map(i=>i.value)})});document.querySelector('main').innerText='응답이 제출되었습니다.'}}</script>`,
      });
    });
    await app.browser.navigate(url);
    const view = (await inspectForm(app.browser.page!)).view;
    assert.deepEqual(
      view.questions[0]?.options.map((o) => o.label),
      ['A', 'B'],
    );
    j.autonomy!.overrides[view.questions[0]!.signature] = ['A'];
    app.store.saveJob(j);
    app.runner.model.decide = (async (_p: unknown, _i: unknown, c: any) => ({
      inputTokens: 0,
      outputTokens: 0,
      step: {
        action: 'form_plan',
        reason: 'fixture',
        observationId: c.observation.id,
        buttonId: c.form.buttons[0].id,
        answers: c.form.questions.map((q: any) => ({
          questionId: q.id,
          category: 'fact',
          source: q.kind === 'radio' ? 'unknown' : 'profile',
          sourceId: q.label === '이름' ? 'name' : 'email',
          reason: 'fixture',
        })),
      },
    })) as any;
    app.runner.start(j.id);
    await app.runner.finished();
    const ready = app.store.job(j.id)!;
    assert.equal(ready.autonomy?.inbox?.final, true, ready.note);
    assert.equal(count, 0);
    const { csrf } = (await (await fetch(app.origin + '/api/state')).json()) as { csrf: string };
    const response = await fetch(app.origin + '/api/jobs/' + j.id + '/inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': csrf },
      body: JSON.stringify({ inboxId: ready.autonomy!.inbox!.id, confirm: true }),
    });
    assert.equal(response.status, 200, await response.text());
    await app.runner.finished();
    const done = app.store.job(j.id)!;
    assert.equal(count, 1);
    assert.equal(done.status, 'completed', done.note);
    assert.equal(done.receiptCheck?.outcome, 'accepted');
    assert.deepEqual(
      done.receiptResponses?.map((r) => r.status),
      [200],
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
