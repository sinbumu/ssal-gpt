import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { inspectForm, applyAnswers, formValuesHash, moaformSnapshot } from '../../src/forms.js';
import { Store, type Job } from '../../src/store.js';
import { createAutonomy, syntheticSettings, validateAnswer } from '../../src/autonomy.js';
import { addAttachment, addDriveSelection, loadAttachment } from '../../src/attachments.js';
import { createApp } from '../../src/server.js';
import { approveTask, type EntryTask } from '../../src/tasks.js';

const rankHtml = `<form><fieldset><legend>경품 우선순위</legend><ol aria-label="경품 우선순위"><li draggable="true" aria-label="커피">커피</li><li draggable="true" aria-label="차">차</li><li draggable="true" aria-label="쿠폰">쿠폰</li></ol></fieldset><button>제출</button></form><script>let dragged; document.querySelectorAll('li').forEach(el=>{el.ondragstart=e=>{dragged=el;e.dataTransfer.setData('text/plain',el.textContent)};el.ondragover=e=>e.preventDefault();el.ondrop=e=>{e.preventDefault();el.parentElement.insertBefore(dragged,el)}})</script>`;
test('rank drag uses rendered order, preserves question identity, invalidates review and rejects partial order', async () => {
  const browser = await chromium.launch(),
    page = await browser.newPage();
  try {
    await page.setContent(rankHtml);
    const { view } = await inspectForm(page),
      q = view.questions[0]!;
    assert.equal(q.kind, 'rank');
    assert.equal(validateAnswer(q, ['차']), undefined);
    const before = await formValuesHash(page);
    await applyAnswers(
      page,
      view,
      new Map([[q.id, ['차', '쿠폰', '커피']]]),
      () => {},
      new AbortController().signal,
    );
    assert.deepEqual(await page.locator('li').allTextContents(), ['차', '쿠폰', '커피']);
    assert.equal((await inspectForm(page)).view.fingerprint, view.fingerprint);
    assert.notEqual(await formValuesHash(page), before);
    assert.equal((await moaformSnapshot(page))[0]!.fields[0]!.value, '차 → 쿠폰 → 커피');
    await applyAnswers(
      page,
      view,
      new Map([[q.id, ['차', '쿠폰', '커피']]]),
      () => {},
      new AbortController().signal,
    );
  } finally {
    await browser.close();
  }
});

test('Google picker upload and exact Drive selection bind recipient/file, verify receiving form, never repeat unknown upload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-picker-')),
    store = new Store(dir);
  const browser = await chromium.launch(),
    page = await browser.newPage();
  const host = 'https://docs.google.com';
  let uploads = 0;
  try {
    await page.route('https://docs.google.com/**', (route) => {
      if (route.request().url().includes('/picker'))
        return route.fulfill({
          contentType: 'text/html',
          body: `<input type="search" aria-label="Search"><div role="option" aria-label="proof.png" onclick="window.selected='proof.png'">proof.png</div><input type="file" onchange="window.selected=this.files[0].name"><button onclick="parent.postMessage({file:window.selected},'${host}')">Select</button>`,
        });
      return route.fulfill({
        contentType: 'text/html',
        body: `<form><fieldset aria-required="true"><legend>인증 파일 *</legend><button type="button" onclick="let f=document.createElement('iframe');f.src='/picker';document.body.append(f)">Add file</button><div id="files"></div></fieldset><button>Submit</button></form><script>onmessage=e=>{if(e.data.file){let a=document.createElement('a');a.textContent=e.data.file;document.querySelector('#files').append(a);document.querySelector('iframe').remove()}}</script>`,
      });
    });
    await page.goto(host + '/forms/fixture');
    const { view } = await inspectForm(page),
      q = view.questions[0]!;
    assert.equal(q.picker, true);
    const job = {
      id: randomUUID(),
      status: 'needs_user',
      kind: 'apply',
      autonomy: createAutonomy(syntheticSettings, host),
      uncertain: false,
    } as Job;
    job.autonomy!.inbox = {
      id: 'box',
      fingerprint: view.fingerprint,
      items: [{ ...q, reason: 'file', category: 'fact' }],
      createdAt: Date.now(),
    };
    store.saveJob(job);
    const png = await page.screenshot();
    await assert.rejects(
      addAttachment(store, dir, {
        jobId: job.id,
        questionId: q.id,
        name: 'proof.png',
        base64: png.toString('base64'),
        allowUpload: true,
        allowPicker: false,
      }),
      /recipient_not_authorized/,
    );
    const asset = await addAttachment(store, dir, {
      jobId: job.id,
      questionId: q.id,
      name: 'proof.png',
      base64: png.toString('base64'),
      allowUpload: true,
      allowPicker: true,
    });
    const resolve = async (ref: string) => {
      const file = await loadAttachment(store, dir, job.id, q.id, ref);
      return {
        ...file,
        beforeUpload() {
          file.beforeUpload();
          uploads++;
        },
      };
    };
    await applyAnswers(
      page,
      view,
      new Map([[q.id, [asset.id]]]),
      () => {},
      new AbortController().signal,
      resolve,
    );
    assert.equal(await page.locator('#files').innerText(), 'proof.png');
    await applyAnswers(
      page,
      view,
      new Map([[q.id, [asset.id]]]),
      () => {},
      new AbortController().signal,
      resolve,
    );
    assert.equal(uploads, 1);
    await page.reload();
    await assert.rejects(
      applyAnswers(
        page,
        view,
        new Map([[q.id, [asset.id]]]),
        () => {},
        new AbortController().signal,
        resolve,
      ),
      /upload_state_unknown/,
    );
    await page.reload();
    const drive = addDriveSelection(store, {
      jobId: job.id,
      questionId: q.id,
      name: 'proof.png',
      allowPicker: true,
    });
    await assert.rejects(loadAttachment(store, dir, randomUUID(), q.id, drive.id), /outside_grant/);
    await applyAnswers(
      page,
      view,
      new Map([[q.id, [drive.id]]]),
      () => {},
      new AbortController().signal,
      resolve,
    );
    assert.equal(await page.locator('#files').innerText(), 'proof.png');
    assert.equal(uploads, 2);
  } finally {
    await browser.close();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('social chain verifies existing state, executes only reviewed follow/comment and hands off to form without developer mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-tasks-')),
    app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  try {
    await app.browser.open();
    const url = app.origin + '/demo/social';
    await app.browser.context!.route('**/demo/social', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<button aria-pressed="true" onclick="window.likeClicks=(window.likeClicks||0)+1">좋아요</button><button onclick="this.textContent='팔로잉';window.follows=(window.follows||0)+1">팔로우</button><label>댓글<textarea></textarea></label><button onclick="document.querySelector('article').textContent=document.querySelector('textarea').value;window.posts=(window.posts||0)+1">게시</button><article></article>`,
      }),
    );
    let typed = false;
    app.runner.model.decide = async (_provider, _instructions, context: any, image) => {
      assert.ok(image.length > 100);
      const o = context.observation;
      const label = context.task.kind === 'follow' ? '팔로우' : typed ? '게시' : '댓글';
      const element = o.elements.find((e: any) => e.label === label);
      assert.ok(element);
      const action = context.task.kind === 'comment' && !typed ? 'type' : 'click';
      if (action === 'type') typed = true;
      return {
        step: {
          action,
          observationId: o.id,
          ref: element.ref,
          text: action === 'type' ? context.approvedText : undefined,
          reason: '합성 과제 처리',
        },
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    app.store.setSettings('autonomy', syntheticSettings);
    const tasks: EntryTask[] = ['like', 'follow', 'comment'].map((kind, i) => ({
      id: `t${i}`,
      kind: kind as EntryTask['kind'],
      url,
      instruction: kind,
      quote: '합성 과제',
      dependsOn: i ? [`t${i - 1}`] : [],
      state: 'review',
    }));
    const job = {
      id: randomUUID(),
      kind: 'apply',
      provider: { kind: 'api', model: 'fixture' },
      startUrl: url,
      status: 'needs_user',
      tasks,
      autonomy: createAutonomy(syntheticSettings, app.origin, true),
      maxSteps: 15,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      uncertain: false,
      allowedOrigins: [app.origin],
      approvedTexts: [],
      history: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Job;
    app.store.saveJob(job);
    for (const task of tasks)
      approveTask(app.store, job, {
        taskId: task.id,
        mode: 'approve',
        text: task.kind === 'comment' ? '합성 참여 메시지' : '',
      });
    app.runner.start(job.id);
    await app.runner.finished();
    const done = app.store.job(job.id)!;
    assert.equal(done.status, 'completed', done.note);
    assert.ok(done.tasks!.every((t) => t.state === 'verified'));
    assert.equal(done.steps, 3);
    assert.equal(await app.browser.page!.evaluate(() => (window as any).likeClicks || 0), 0);
    assert.equal(await app.browser.page!.evaluate(() => (window as any).posts), 1);
    assert.equal(await app.browser.page!.evaluate(() => (window as any).follows), 1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
