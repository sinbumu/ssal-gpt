import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  inspectForm,
  applyAnswers,
  advanceForm,
  formValuesHash,
  moaformSnapshot,
} from '../../src/forms.js';
import { addAttachment, loadAttachment } from '../../src/attachments.js';
import { Store, type Job } from '../../src/store.js';
import { createAutonomy, syntheticSettings, resolveAnswer } from '../../src/autonomy.js';

test('visible ARIA grid and multiple choices bind labels, preserve selected states and invalidate changed review', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<form><div role="radiogroup" aria-label="첫 항목" aria-required="true"><div role="radio" aria-checked="true">보통</div><div role="radio" aria-checked="false">좋음</div></div><div role="radiogroup" aria-label="둘째 항목"><div role="radio" aria-checked="false">보통</div><div role="radio" aria-checked="true">좋음</div></div><div role="group" aria-label="관심사 최대 2"><div role="checkbox" aria-checked="false">커피</div><div role="checkbox" aria-checked="false">차</div></div><div role="button">제출</div></form><script>document.querySelectorAll('[aria-checked]').forEach(el => el.onclick=()=>{ if(el.role==='radio') el.parentElement.querySelectorAll('[role=radio]').forEach(c=>c.setAttribute('aria-checked','false')); el.setAttribute('aria-checked',el.getAttribute('aria-checked')==='true'?'false':'true') });document.querySelector('[role=button]').onclick=()=>document.body.innerHTML='응답 완료';</script>`,
    );
    const { view } = await inspectForm(page);
    assert.equal(view.questions.length, 3);
    assert.equal(view.questions[2]!.maxChoices, 2);
    const answers = new Map(
      view.questions.map((q, i) => [q.id, i === 2 ? ['커피', '차'] : ['좋음']]),
    );
    await applyAnswers(page, view, answers, () => {}, new AbortController().signal);
    await applyAnswers(page, view, answers, () => {}, new AbortController().signal);
    const review = await moaformSnapshot(page);
    assert.equal(review[0]!.fields.filter((f) => 'checked' in f && f.checked).length, 4);
    const fingerprint = await formValuesHash(page);
    await page.getByRole('checkbox', { name: '차' }).click();
    assert.notEqual(await formValuesHash(page), fingerprint);
    await advanceForm(page, view, view.buttons[0]!.id, new AbortController().signal);
    assert.equal(await page.locator('body').innerText(), '응답 완료');
  } finally {
    await browser.close();
  }
});
test('attachment approval binds bytes to one job and question; repeated batch does not upload twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-files-')),
    store = new Store(dir);
  const browser = await chromium.launch(),
    page = await browser.newPage();
  try {
    await page.setContent(
      '<form><label>실제 인증 화면<input type="file" accept="image/png" required></label><button>제출</button></form><script>window.changes=0;document.querySelector("input").onchange=()=>window.changes++;</script>',
    );
    const { view } = await inspectForm(page),
      q = view.questions[0]!;
    assert.equal(q.kind, 'file');
    const job = {
      id: randomUUID(),
      kind: 'apply',
      status: 'needs_user',
      autonomy: createAutonomy(syntheticSettings, 'https://example.com'),
      uncertain: false,
      history: [],
    } as unknown as Job;
    job.autonomy!.inbox = {
      id: randomUUID(),
      fingerprint: view.fingerprint,
      items: [{ ...q, category: 'fact', reason: 'file' }],
      createdAt: Date.now(),
    };
    store.saveJob(job);
    assert.equal(
      resolveAnswer(
        q,
        {
          questionId: q.id,
          category: 'fact',
          source: 'recommendation',
          answer: ['asset:' + randomUUID()],
          reason: 'fake',
        },
        job.autonomy!,
        [],
        '',
      ).answer,
      undefined,
    );
    const png = await page.screenshot();
    const asset = await addAttachment(store, dir, {
      jobId: job.id,
      questionId: q.id,
      name: 'actual.png',
      base64: png.toString('base64'),
      allowUpload: true,
    });
    await assert.rejects(loadAttachment(store, dir, randomUUID(), q.id, asset.id), /outside_grant/);
    await assert.rejects(
      loadAttachment(store, dir, job.id, 'different question', asset.id),
      /outside_grant/,
    );
    const answer = new Map([[q.id, [asset.id]]]);
    const load = (ref: string) => loadAttachment(store, dir, job.id, q.id, ref);
    await applyAnswers(page, view, answer, () => {}, new AbortController().signal, load);
    await applyAnswers(page, view, answer, () => {}, new AbortController().signal, load);
    assert.equal(await page.evaluate(() => (window as any).changes), 1);
    assert.equal(
      await page.locator('input').evaluate((el) => (el as HTMLInputElement).files![0]!.size),
      png.length,
    );
    await page.locator('input').setInputFiles([]);
    await assert.rejects(
      applyAnswers(page, view, answer, () => {}, new AbortController().signal, load),
      /attachment_upload_state_unknown/,
    );
  } finally {
    await browser.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
