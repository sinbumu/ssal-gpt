import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings, type Question } from '../../src/autonomy.js';
import { prepareProofAttachments, approveProofAttachment } from '../../src/proof-attachments.js';
import { loadAttachment } from '../../src/attachments.js';
import { inspectForm, applyAnswers } from '../../src/forms.js';
import type { Job } from '../../src/store.js';

test('verified task screenshots reach upload and final receipt through dashboard only, with scoped previews', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-proof-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  const ui = await chromium.launch();
  let posts = 0;
  const config = {
    ...syntheticSettings,
    policy: { ...syntheticSettings.policy, finalSubmit: 'review' as const },
  };
  app.store.setSettings('autonomy', config);
  const id = randomUUID(),
    url = app.origin + '/demo/proof-form';
  const job = {
    id,
    kind: 'apply',
    status: 'queued',
    provider: { kind: 'api', model: 'synthetic' },
    goal: 'proof test',
    startUrl: url,
    currentUrl: url,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    maxSteps: 10,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    candidateLimit: 1,
    note: '',
    uncertain: false,
    history: [],
    allowedOrigins: [app.origin],
    approvedTexts: [],
    autonomy: createAutonomy(config, app.origin),
    taskFormStarted: true,
    transmitted: true,
    tasks: [],
  } as Job;
  app.runner.model.decide = (async (_p, _i, ctx: any) => ({
    inputTokens: 10,
    outputTokens: 5,
    step: {
      action: 'form_plan',
      observationId: ctx.observation.id,
      reason: '묶음',
      buttonId: ctx.form.buttons[0].id,
      answers: ctx.form.questions.map((q: Question) => ({
        questionId: q.id,
        source: 'unknown',
        category: 'fact',
        reason: '파일',
      })),
    },
  })) as typeof app.runner.model.decide;
  try {
    await app.browser.open();
    await app.browser.page!.route(url, async (r) => {
      if (r.request().method() === 'POST') {
        posts++;
        const body = r.request().postDataBuffer()!;
        assert.ok(body.includes(png), 'original screenshot bytes reach the form');
        await r.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '응모가 완료되었습니다.',
        });
      } else
        await r.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '<form method="post" enctype="multipart/form-data"><label>팔로우 인증 캡처 @fixture<input name="follow" type="file" accept="image/png" required></label><label>댓글 인증 캡처<input name="comment" type="file" accept="image/png" required></label><button>제출</button></form>',
        });
    });
    const png = await app.browser.page!.screenshot();
    mkdirSync(join(dir, 'evidence'), { recursive: true });
    for (const kind of ['follow', 'comment'] as const) {
      const screenshot = `${randomUUID()}.png`;
      writeFileSync(join(dir, 'evidence', screenshot), png);
      app.store.db
        .prepare('INSERT INTO evidence_assets VALUES (?,?,?)')
        .run(screenshot, id, 'observation');
      const sourceUrl = `https://www.instagram.com/${kind === 'follow' ? 'fixture/' : 'p/fixture/'}`;
      job.tasks!.push({
        id: kind,
        kind,
        state: 'verified',
        url: sourceUrl,
        instruction: kind,
        quote: kind,
        dependsOn: [],
        approval: {
          id: randomUUID(),
          text: 'fixture',
          actor: 'fixture_user',
          subject: 'fixture',
          revision: 'fixture',
          expires: Date.now() + 100000,
        },
        proof: { quote: 'verified', url: sourceUrl, screenshot, actor: 'browser', at: Date.now() },
      });
    }
    job.tasks!.push({
      id: 'form',
      kind: 'form',
      state: 'pending',
      url,
      instruction: '인증 첨부',
      quote: '인증 첨부',
      dependsOn: ['follow', 'comment'],
    });
    app.store.saveJob(job);
    app.runner.start(id);
    await app.runner.finished();
    const saved = app.store.job(id)!;
    assert.equal(saved.status, 'needs_user', saved.note);
    const box = saved.autonomy!.inbox!;
    assert.equal(box.items.length, 2);
    assert.ok(box.items.every((q) => q.proofAttachment));
    assert.equal(posts, 0);
    const q = box.items[0]!;
    const args = {
      jobId: id,
      inboxId: box.id,
      questionId: q.id,
      sha256: q.proofAttachment!.sha256,
      allowUpload: true as const,
      allowPicker: false,
    };
    await assert.rejects(
      approveProofAttachment(app.store, { ...args, inboxId: randomUUID() }),
      /unavailable/,
    );
    const altered = structuredClone(saved);
    altered.tasks![0]!.state = 'manual_reported';
    assert.equal(await prepareProofAttachments(app.store, altered), 1);
    altered.tasks![0]!.state = 'verified';
    altered.autonomy!.inbox!.items[0]!.label = '팔로우와 댓글 인증 캡처';
    assert.equal(
      await prepareProofAttachments(app.store, altered),
      1,
      'combined requirements are not guessed',
    );
    altered.autonomy!.inbox!.items[0]!.label = '팔로우 인증 캡처 @different';
    assert.equal(await prepareProofAttachments(app.store, altered), 1);
    app.store.db
      .prepare('UPDATE evidence_assets SET job_id=? WHERE name=?')
      .run(randomUUID(), q.proofAttachment!.screenshot);
    await assert.rejects(approveProofAttachment(app.store, args), /proof_changed/);
    app.store.db
      .prepare('UPDATE evidence_assets SET job_id=? WHERE name=?')
      .run(id, q.proofAttachment!.screenshot);
    writeFileSync(
      join(dir, 'evidence', q.proofAttachment!.screenshot),
      Buffer.concat([png, Buffer.from('changed')]),
    );
    await assert.rejects(approveProofAttachment(app.store, args), /proof_changed/);
    writeFileSync(join(dir, 'evidence', q.proofAttachment!.screenshot), png);
    const [a, b] = await Promise.all([
      approveProofAttachment(app.store, args),
      approveProofAttachment(app.store, args),
    ]);
    assert.equal(a.id, b.id);
    const page = await ui.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.origin);
    const form = page.locator(`[data-inbox="${id}"]`);
    await form.waitFor();
    assert.equal(await form.locator('.proof-attachment img').count(), 2);
    assert.equal(await form.locator('input[type=file][required]').count(), 0);
    await form.locator('input[name^="upload-"]').nth(0).check();
    await form.locator('input[name^="upload-"]').nth(1).check();
    await form.getByRole('button', { name: '한 번에 답변하고 재개' }).click();
    await page.getByRole('button', { name: '최종 제출하고 결과 확인', exact: true }).waitFor();
    assert.equal(posts, 0);
    assert.equal(
      await app.browser
        .page!.locator('input[type=file]')
        .evaluateAll((els) => els.every((el) => (el as HTMLInputElement).files?.length === 1)),
      true,
    );
    const once = await loadAttachment(app.store, dir, id, q.id, a.id);
    assert.throws(() => once.beforeUpload(), /state_unknown/);
    await page.getByRole('button', { name: '최종 제출하고 결과 확인', exact: true }).click();
    await page.waitForFunction((id) => !document.querySelector(`[data-inbox="${id}"]`), id);
    await app.runner.finished();
    assert.equal(app.store.job(id)!.status, 'completed', app.store.job(id)!.note);
    assert.equal(posts, 1);
    assert.ok(app.store.job(id)!.tasks!.every((t) => t.state === 'verified'));
    assert.deepEqual(errors, []);
  } finally {
    await ui.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('native checkbox inside labelled ARIA wrapper is recognized and filled exactly once', async () => {
  const browser = await chromium.launch(),
    page = await browser.newPage();
  try {
    await page.setContent(
      '<form><fieldset><legend>답변 필수5. 개인정보 수집 및 이용 동의</legend><div role="checkbox" aria-checked="false" aria-label="개인정보 수집 및 이용에 동의합니다."><input type="checkbox" required></div></fieldset><button>제출</button></form>',
    );
    const { view } = await inspectForm(page);
    assert.equal(view.questions.length, 1);
    const q = view.questions[0]!;
    assert.equal(q.required, true);
    assert.equal(q.options[0]!.label, '개인정보 수집 및 이용에 동의합니다.');
    await applyAnswers(
      page,
      view,
      new Map([[q.id, [q.options[0]!.id]]]),
      () => {},
      new AbortController().signal,
    );
    assert.equal(await page.locator('input').isChecked(), true);
  } finally {
    await browser.close();
  }
});

test('unlabelled native sibling and labelled ARIA consent share one answer and preserve required hint', async () => {
  const browser = await chromium.launch(),
    page = await browser.newPage();
  try {
    await page.setContent(
      `<form><fieldset><legend>답변 필수 개인정보 수집 및 이용 동의</legend><input type="checkbox" style="opacity:0"><div role="checkbox" aria-checked="false" aria-label="개인정보 수집 및 이용에 동의합니다." onclick="this.setAttribute('aria-checked','true');this.previousElementSibling.checked=true">개인정보 수집 및 이용에 동의합니다.</div></fieldset><button>제출</button></form>`,
    );
    const { view } = await inspectForm(page);
    assert.equal(view.questions.length, 1);
    const q = view.questions[0]!;
    assert.equal(q.required, true);
    assert.equal(q.options[0]!.label, '개인정보 수집 및 이용에 동의합니다.');
    await applyAnswers(
      page,
      view,
      new Map([[q.id, [q.options[0]!.id]]]),
      () => {},
      new AbortController().signal,
    );
    assert.equal(await page.locator('input').isChecked(), true);
    assert.equal((await inspectForm(page)).view.fingerprint, view.fingerprint);
  } finally {
    await browser.close();
  }
});
