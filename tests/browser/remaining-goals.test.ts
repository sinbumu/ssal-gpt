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
import { journeyState } from '../../src/journey-demo.js';
import { prepareDiscoveredEntry } from '../../src/workflow.js';

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

test('social chain verifies existing state and executes only reviewed follow/comment without duplication', async () => {
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

test('dashboard batches social approvals, selects real fixture file, reviews rank and submits full mixed journey once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-journey-')),
    app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  app.auth.bearer = async () => 'fixture';
  const uiBrowser = await chromium.launch(),
    page = await uiBrowser.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    let typed = false;
    app.runner.model.decide = async (_provider, _instructions, c: any) => {
      const o = c.observation;
      if (c.task) {
        const label =
          c.task.kind === 'like'
            ? '좋아요'
            : c.task.kind === 'follow'
              ? '팔로우'
              : typed
                ? '게시'
                : '댓글';
        const el = o.elements.find((e: any) => e.label === label),
          action = c.task.kind === 'comment' && !typed ? 'type' : 'click';
        if (action === 'type') typed = true;
        return {
          step: {
            action,
            observationId: o.id,
            ref: el.ref,
            text: action === 'type' ? c.approvedText : undefined,
            reason: '합성 과제',
          },
          inputTokens: 1,
          outputTokens: 1,
        };
      }
      if (o.text.includes('답변이 제출되었습니다.'))
        return {
          step: {
            action: 'done',
            observationId: o.id,
            evidenceQuote: '답변이 제출되었습니다.',
            reason: '합성 접수 확인',
          },
          inputTokens: 1,
          outputTokens: 1,
        };
      return {
        step: {
          action: 'form_plan',
          observationId: o.id,
          buttonId: c.form.buttons[0].id,
          answers: c.form.questions.map((q: any) => ({
            questionId: q.id,
            category: q.kind === 'rank' ? 'preference' : 'fact',
            source: q.kind === 'rank' ? 'recommendation' : 'unknown',
            answer: q.kind === 'rank' ? ['커피', '차', '쿠폰'] : undefined,
            reason: '가상 사용자 설정 적용',
          })),
          reason: '묶음 작성',
        },
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    app.store.setSettings('selection', { kind: 'api', model: 'fixture' });
    await page.goto(app.origin);
    await page.locator('#journey-demo').click();
    const taskForm = page.locator('[data-task-review]');
    await taskForm.waitFor();
    assert.equal(await taskForm.locator('fieldset').count(), 3);
    await taskForm.locator('textarea').fill('합성 이벤트 참여 테스트입니다.');
    await Promise.all([
      page.waitForResponse((r) => /\/task$/.test(r.url()) && r.request().method() === 'POST'),
      taskForm.getByRole('button').click(),
    ]);
    await app.runner.finished();
    const job = app.store.jobs().find((j) => j.kind === 'autonomy_demo')!;
    assert.ok(
      job.autonomy!.inbox?.items.some((q) => q.kind === 'file'),
      job.note,
    );
    await page.locator('[data-inbox] input[type=file]').waitFor();
    const png = await page.screenshot();
    await page
      .locator('[data-inbox] input[type=file]')
      .setInputFiles({ name: 'synthetic-proof.png', mimeType: 'image/png', buffer: png });
    await page.locator('[data-inbox] input[name^=upload-]').check();
    await Promise.all([
      page.waitForResponse((r) => /\/inbox$/.test(r.url()) && r.request().method() === 'POST'),
      page.locator('[data-inbox] button[type=submit]').click(),
    ]);
    await app.runner.finished();
    assert.equal(app.store.job(job.id)!.autonomy!.inbox?.final, true, app.store.job(job.id)!.note);
    await page.getByRole('button', { name: '최종 제출하고 결과 확인', exact: true }).waitFor();
    assert.match(await page.locator('[data-inbox]').innerText(), /커피 → 차 → 쿠폰/);
    await Promise.all([
      page.waitForResponse((r) => /\/inbox$/.test(r.url()) && r.request().method() === 'POST'),
      page.getByRole('button', { name: '최종 제출하고 결과 확인', exact: true }).click(),
    ]);
    await app.runner.finished();
    assert.equal(app.store.job(job.id)!.status, 'completed', app.store.job(job.id)!.note);
    assert.deepEqual(journeyState(app.store, job.id), {
      likes: 1,
      follows: 1,
      comments: ['합성 이벤트 참여 테스트입니다.'],
      submissions: 1,
    });
    assert.deepEqual(errors, []);
  } finally {
    await uiBrowser.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime discovers excess questions and switches to another candidate without transmitting the abandoned form', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-switch-')),
    app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  try {
    app.store.setSettings('autonomy', syntheticSettings);
    app.store.setSettings('selectionPolicy', { maxQuestions: 1 });
    await app.browser.open();
    let posts = 0,
      calls = 0;
    await app.browser.context!.route('https://form.naver.com/**', (route) => {
      if (route.request().method() === 'POST') {
        posts++;
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '답변이 제출되었습니다.',
        });
      }
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: route.request().url().endsWith('long')
          ? '<form><label>첫 질문<input></label><label>둘째 질문<input></label><button>제출</button></form>'
          : '<form method="post"><label>이름<input name="name" required></label><button>제출</button></form>',
      });
    });
    app.runner.model.decide = async (_p, _i, c: any) => {
      calls++;
      return {
        step: c.observation.text.includes('답변이 제출되었습니다.')
          ? {
              action: 'done',
              observationId: c.observation.id,
              evidenceQuote: '답변이 제출되었습니다.',
              reason: '접수',
            }
          : {
              action: 'form_plan',
              observationId: c.observation.id,
              buttonId: c.form.buttons[0].id,
              answers: c.form.questions.map((q: any) => ({
                questionId: q.id,
                category: 'fact',
                source: 'unknown',
                reason: '저장 프로필',
              })),
              reason: '입력',
            },
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    const parent = {
      id: randomUUID(),
      kind: 'discover',
      status: 'completed',
      prepareOne: { revision: syntheticSettings.revision, expires: Date.now() + 60000 },
      provider: { kind: 'api', model: 'fixture' },
    } as Job;
    app.store.saveJob(parent);
    for (const [i, name] of ['long', 'short'].entries()) {
      const url = 'https://form.naver.com/response/' + name;
      app.store.record(
        {
          title: name,
          organizer: 'fixture',
          entryUrl: url,
          deadline: '2099-01-01T00:00:00Z',
          prize: '커피',
          winners: 1,
          requirements: ['설문'],
          blockers: [],
          evidenceQuote: '설문',
          evidenceKind: 'text',
          effortMinutes: i + 1,
        },
        url,
        parent.id,
        'fixture.png',
        {
          sourceEvidence: [
            {
              id: name,
              url,
              title: name,
              text: '설문',
              screenshot: 'fixture.png',
              observedAt: Date.now(),
            },
          ],
        },
      );
    }
    const first = prepareDiscoveredEntry(app.store, parent)!;
    app.runner.start(first);
    await app.runner.finished();
    const jobs = app.store.jobs().filter((j) => j.kind === 'apply');
    assert.equal(jobs.length, 2);
    assert.equal(app.store.job(first)!.status, 'stopped');
    assert.ok(
      jobs.some((j) => j.status === 'completed'),
      jobs.map((j) => j.note).join(' / '),
    );
    assert.equal(posts, 1);
    assert.equal(calls, 1); // Clear receipt needs no extra model call.
    assert.equal(app.store.job(parent.id)!.prepareOne!.switches, 1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown social post survives resume without a second post; user report remains distinct', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-unknown-task-')),
    app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  try {
    await app.browser.open();
    const url = app.origin + '/demo/social-unknown';
    await app.browser.context!.route('**/demo/social-unknown', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<label>댓글<textarea></textarea></label><button onclick="window.posts=(window.posts||0)+1">게시</button>',
      }),
    );
    let calls = 0;
    app.runner.model.decide = async (_p, _i, c: any) => {
      const action = calls++ ? 'click' : 'type',
        el = c.observation.elements.find(
          (e: any) => e.label === (action === 'type' ? '댓글' : '게시'),
        );
      return {
        step: {
          action,
          observationId: c.observation.id,
          ref: el.ref,
          text: action === 'type' ? c.approvedText : undefined,
          reason: '합성 전송',
        },
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    const job = {
      id: randomUUID(),
      kind: 'apply',
      provider: { kind: 'api', model: 'fixture' },
      startUrl: url,
      status: 'needs_user',
      tasks: [
        {
          id: 't',
          kind: 'comment',
          url,
          instruction: '합성',
          quote: '합성',
          dependsOn: [],
          state: 'review',
        },
      ],
      autonomy: createAutonomy(syntheticSettings, app.origin, true),
      maxSteps: 10,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      uncertain: false,
      allowedOrigins: [app.origin],
      approvedTexts: [],
      history: [],
      createdAt: new Date().toISOString(),
    } as Job;
    app.store.saveJob(job);
    approveTask(app.store, job, { taskId: 't', mode: 'approve', text: '합성 댓글' });
    app.runner.start(job.id);
    await app.runner.finished();
    assert.equal(app.store.job(job.id)!.status, 'submission_unknown');
    app.runner.start(job.id);
    await app.runner.finished();
    assert.equal(calls, 2);
    assert.equal(await app.browser.page!.evaluate(() => (window as any).posts), 1);
    const unknown = app.store.job(job.id)!;
    approveTask(app.store, unknown, {
      taskId: 't',
      mode: 'manual',
      evidence: '합성 사용자 직접 게시 확인',
    });
    app.runner.start(job.id);
    await app.runner.finished();
    const done = app.store.job(job.id)!;
    assert.equal(done.status, 'completed');
    assert.equal(done.tasks![0]!.proof!.actor, 'user');
    assert.match(done.note, /사용자/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
