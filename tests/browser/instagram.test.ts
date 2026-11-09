import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings } from '../../src/autonomy.js';
import { approveTask, type EntryTask } from '../../src/tasks.js';
import type { Job } from '../../src/store.js';
const url = 'https://www.instagram.com/p/fixture/';
const icon = (s: string) =>
  `<svg aria-label="${s}" width="24" height="24"><title>${s}</title><circle cx="12" cy="12" r="8" /></svg>`;
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-ig-')),
    app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  const data = {
    likes: 0,
    follows: 0,
    comments: [] as string[],
    posts: 0,
    actor: 'fixture_user',
    hideOwn: false,
    renderDelay: 0,
    otherLikes: 0,
  };
  app.store.setSettings('autonomy', syntheticSettings);
  app.store.setSettings('instagramBrowser', { enabled: true, revision: 'fixture-route' });
  await app.browser.open();
  await app.browser.context!.route('https://www.instagram.com/**', async (route) => {
    const req = route.request(),
      p = new URL(req.url()).pathname;
    if (req.method() === 'POST') {
      if (p === '/fixture/like') data.likes++;
      if (p === '/fixture/follow') data.follows++;
      if (p === '/fixture/other') data.otherLikes++;
      if (p === '/fixture/comment') {
        data.posts++;
        data.comments.push(req.postData() || '');
      }
      return route.fulfill({ body: 'ok' });
    }
    const comments = data.hideOwn
      ? ''
      : data.comments
          .map(
            (text) =>
              `<div class="row"><a href="/fixture_user/">fixture_user</a><span>${text}</span><button>${icon('좋아요')}</button></div>`,
          )
          .join('');
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><style>nav,main{visibility:${data.renderDelay ? 'hidden' : 'visible'}}body{font:18px sans-serif}nav{position:absolute;left:20px;top:20px}main{margin-left:230px;width:720px}button{padding:12px}section{padding:15px}textarea{width:400px;height:60px}.row{margin:15px}</style><nav><a href="/${data.actor}/"><img width="40" height="40" alt="${data.actor} 프로필 사진" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"></a></nav><main><div id="post"><header><a href="/fixture_host/">fixture_host</a><button id="follow">${data.follows ? '팔로잉' + icon('아래쪽 방향 V자형 아이콘') : '팔로우'}</button></header><div><p>합성 이벤트</p><div class="row"><a href="/other_user/">other_user</a><span>합성 응모합니다</span><button onclick="fetch('/fixture/other',{method:'POST'})">${icon('좋아요')}</button></div>${comments}</div><section><button id="like">${icon(data.likes ? '좋아요 취소' : '좋아요')}</button><button>${icon('댓글 달기')}</button></section><section><form onsubmit="return false"><textarea placeholder="댓글 달기..."></textarea><button id="send">게시</button></form></section></div><article><button>${icon('좋아요')}</button><a href="/other_host/">추천 게시물</a></article></main><script>setTimeout(()=>document.querySelectorAll('nav,main').forEach(e=>e.style.visibility='visible'),${data.renderDelay});async function send(kind,text){await fetch('/fixture/'+kind,{method:'POST',body:text||''});location.reload()}document.querySelector('#like').onclick=()=>send('like');document.querySelector('#follow').onclick=()=>send('follow');document.querySelector('#send').onclick=()=>send('comment',document.querySelector('textarea').value);</script>`,
    });
  });
  app.runner.model.decide = async (_p, _i, c: any, image) => {
    assert.ok(image.length > 100);
    const o = c.observation,
      kind = c.task.kind;
    const key = kind === 'comment' ? (c.editorMatchesApproved ? 'post' : 'comment') : kind;
    assert.ok(o.instagram.controls[key]);
    assert.ok(o.elements.every((e: any) => Object.values(o.instagram.controls).includes(e.ref)));
    return {
      step: {
        action: key === 'comment' ? 'type' : 'click',
        observationId: o.id,
        ref: o.instagram.controls[key],
        text: key === 'comment' ? c.approvedText : undefined,
        reason: '합성 인스타 과제',
      },
      inputTokens: 1,
      outputTokens: 1,
    };
  };
  const make = (kinds: string[]) => {
    const tasks: EntryTask[] = kinds.map((kind, i) => ({
      id: 't' + i,
      kind: kind as EntryTask['kind'],
      url,
      instruction: '합성 ' + kind,
      quote: '합성 이벤트',
      dependsOn: i ? ['t' + (i - 1)] : [],
      state: 'pending',
      draft: kind === 'comment' ? '합성 응모합니다' : undefined,
    }));
    const j = {
      id: randomUUID(),
      kind: 'apply',
      provider: { kind: 'api', model: 'fixture' },
      startUrl: url,
      status: 'queued',
      tasks,
      autonomy: createAutonomy(syntheticSettings, 'https://www.instagram.com', true),
      maxSteps: 20,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      uncertain: false,
      allowedOrigins: ['https://www.instagram.com'],
      approvedTexts: [],
      history: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Job;
    app.store.saveJob(j);
    return j;
  };
  const approve = (id: string) => {
    const j = app.store.job(id)!;
    for (const t of j.tasks!)
      approveTask(app.store, j, {
        taskId: t.id,
        mode: 'approve',
        text: t.kind === 'comment' ? '합성 응모합니다' : '',
      });
  };
  return {
    app,
    data,
    make,
    approve,
    async close() {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('Instagram scopes real-looking SVG controls and batches approval; verifies persisted own comment, not another author', async () => {
  const f = await fixture();
  try {
    const j = f.make(['like', 'follow', 'comment']);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    const preview = f.app.store.job(j.id)!;
    assert.equal(preview.status, 'needs_user', preview.note);
    assert.ok(
      preview.tasks!.every(
        (t) => t.preview?.actor === 'fixture_user' && t.preview.subject === 'fixture_host',
      ),
    );
    assert.equal(f.data.likes + f.data.follows + f.data.posts, 0);
    f.approve(j.id);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    const done = f.app.store.job(j.id)!;
    assert.equal(done.status, 'completed', done.note);
    assert.deepEqual([f.data.likes, f.data.follows, f.data.posts, f.data.otherLikes], [1, 1, 1, 0]);
    assert.ok(done.tasks!.every((t) => t.state === 'verified'));
    const same = f.make(['like', 'follow', 'comment']);
    f.app.runner.start(same.id);
    await f.app.runner.finished();
    f.approve(same.id);
    f.app.runner.start(same.id);
    await f.app.runner.finished();
    assert.equal(f.app.store.job(same.id)!.status, 'completed');
    assert.deepEqual([f.data.likes, f.data.follows, f.data.posts], [1, 1, 1]);
  } finally {
    await f.close();
  }
});
test('Instagram account change and revoked delegation prevent external actions', async () => {
  const f = await fixture();
  try {
    const j = f.make(['like']);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    f.approve(j.id);
    f.data.actor = 'changed_user';
    await f.app.browser.navigate(url);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    assert.equal(f.data.likes, 0);
    assert.match(f.app.store.job(j.id)!.note, /계정.*바뀌/);
    f.data.actor = 'fixture_user';
    await f.app.browser.navigate(url);
    const k = f.make(['like']);
    f.app.runner.start(k.id);
    await f.app.runner.finished();
    f.approve(k.id);
    f.app.store.setSettings('instagramBrowser', { enabled: false, revision: 'revoked' });
    f.app.runner.start(k.id);
    await f.app.runner.finished();
    assert.equal(f.data.likes, 0);
  } finally {
    await f.close();
  }
});
test('Instagram uncertain comment is never posted a second time across resume', async () => {
  const f = await fixture();
  try {
    f.data.hideOwn = true;
    const j = f.make(['comment']);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    f.approve(j.id);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    assert.equal(f.app.store.job(j.id)!.status, 'submission_unknown');
    assert.equal(f.data.posts, 1);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    assert.equal(f.data.posts, 1);
    assert.equal(f.app.store.job(j.id)!.status, 'submission_unknown');
  } finally {
    await f.close();
  }
});
test('form receipt precedes completion comment; dashboard approves phases and no incomplete entry is marked completed', async () => {
  const f = await fixture();
  try {
    const j = f.make(['comment']),
      formUrl = f.app.origin + '/demo/form-before-comment';
    let submissions = 0;
    j.tasks!.unshift({
      id: 'form',
      kind: 'form',
      url: formUrl,
      instruction: '설문 제출',
      quote: '설문 후 댓글',
      dependsOn: [],
      state: 'pending',
    });
    j.tasks![1]!.dependsOn = ['form'];
    j.autonomy!.policy.finalSubmit = 'review';
    f.app.store.saveJob(j);
    await f.app.browser.context!.route(formUrl, async (route) => {
      if (route.request().method() === 'POST') {
        submissions++;
        f.app.store.submitDemo(j.id);
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '<h1>답변이 제출되었습니다.</h1>',
        });
      }
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<form method="post"><label>이름<input name="name" required></label><button>제출</button></form>',
      });
    });
    const socialModel = f.app.runner.model.decide;
    f.app.runner.model.decide = async (p, i, c: any, image, signal) => {
      if (c.task) {
        assert.equal(submissions, 1);
        return socialModel(p, i, c, image, signal);
      }
      const o = c.observation;
      return {
        step: o.text.includes('답변이 제출되었습니다.')
          ? {
              action: 'done',
              observationId: o.id,
              evidenceQuote: '답변이 제출되었습니다.',
              reason: '합성 접수',
            }
          : {
              action: 'form_plan',
              observationId: o.id,
              buttonId: c.form.buttons[0].id,
              answers: c.form.questions.map((q: any) => ({
                questionId: q.id,
                category: 'fact',
                source: 'unknown',
                reason: '가상 프로필',
              })),
              reason: '합성 폼',
            },
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    let current = f.app.store.job(j.id)!;
    assert.equal(current.autonomy!.inbox?.final, true, current.note);
    assert.equal(current.tasks![1]!.state, 'pending');
    assert.equal(f.data.posts, 0);
    const state = (await (await fetch(f.app.origin + '/api/state')).json()) as any;
    const response = await fetch(f.app.origin + `/api/jobs/${j.id}/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
      body: JSON.stringify({ inboxId: current.autonomy!.inbox!.id, confirm: true }),
    });
    assert.equal(response.status, 200, await response.text());
    await f.app.runner.finished();
    current = f.app.store.job(j.id)!;
    assert.equal(submissions, 1);
    assert.equal(current.status, 'needs_user', current.note);
    assert.equal(current.tasks![0]!.state, 'verified');
    assert.equal(current.tasks![1]!.state, 'review');
    assert.equal(f.data.posts, 0);
    approveTask(f.app.store, current, { taskId: 't0', mode: 'approve', text: '합성 응모합니다' });
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    current = f.app.store.job(j.id)!;
    assert.equal(current.status, 'completed', current.note);
    assert.equal(submissions, 1);
    assert.equal(f.data.posts, 1);
    assert.ok(current.tasks!.every((t) => t.state === 'verified'));
  } finally {
    await f.close();
  }
});
test('dashboard shows account/targets and posts approved social batch through the normal UI', async () => {
  const f = await fixture();
  const { chromium } = await import('playwright');
  const ui = await chromium.launch();
  try {
    const page = await ui.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(f.app.origin + '/#connections');
    await page.locator('#instagram-browser-enabled').uncheck();
    await page.locator('#instagram-browser-form button').click();
    await page.waitForFunction(() =>
      document.querySelector('#toast')?.textContent?.includes('저장했습니다'),
    );
    assert.equal(f.app.store.settings<any>('instagramBrowser', {}).enabled, false);
    await page.locator('#instagram-browser-enabled').check();
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/instagram-browser')),
      page.locator('#instagram-browser-form button').click(),
    ]);
    const j = f.make(['like', 'follow', 'comment']);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    await page.goto(f.app.origin + '/#attention');
    const form = page.locator(`[data-task-review="${j.id}"]`);
    await form.waitFor();
    assert.match(await form.innerText(), /fixture_user/);
    assert.match(await form.innerText(), /fixture_host/);
    assert.equal(await form.locator('fieldset').count(), 3);
    await form.locator('textarea').fill('합성 응모합니다');
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/task')),
      form.getByRole('button').click(),
    ]);
    await f.app.runner.finished();
    assert.equal(f.app.store.job(j.id)!.status, 'completed', f.app.store.job(j.id)!.note);
    assert.equal(f.data.posts, 1);
  } finally {
    await ui.close();
    await f.close();
  }
});

test('Instagram waits for delayed rendered account and controls before review and receipt', async () => {
  const f = await fixture();
  try {
    f.data.renderDelay = 1200;
    const j = f.make(['like']);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    const review = f.app.store.job(j.id)!;
    assert.equal(review.status, 'needs_user', review.note);
    assert.equal(review.tasks![0]!.preview?.actor, 'fixture_user');
    assert.equal(f.data.likes, 0);
    f.approve(j.id);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    const done = f.app.store.job(j.id)!;
    assert.equal(done.status, 'completed', done.note);
    assert.equal(f.data.likes, 1);
  } finally {
    await f.close();
  }
});

test('Instagram reconciles an attempted follow with a decorative icon without clicking again', async () => {
  const f = await fixture();
  try {
    const j = f.make(['follow']);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    f.approve(j.id);
    const interrupted = f.app.store.job(j.id)!;
    interrupted.tasks![0]!.state = 'attempted';
    interrupted.tasks![0]!.attempt = { at: Date.now(), beforeText: '팔로우' };
    interrupted.uncertain = true;
    interrupted.status = 'submission_unknown';
    f.app.store.saveJob(interrupted);
    f.data.follows = 1;
    await f.app.browser.navigate(url);
    const o = await f.app.browser.observe(false, [], { url, kind: 'follow' });
    assert.equal(o.instagram?.following, true);
    assert.equal(o.elements.find((e) => e.ref === o.instagram?.controls.follow)?.label, '팔로잉');
    await f.app.browser.page!.goto('about:blank');
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    const done = f.app.store.job(j.id)!;
    assert.equal(done.status, 'completed', done.note);
    assert.equal(f.data.follows, 1);
    assert.equal(done.steps, 0);
  } finally {
    await f.close();
  }
});

test('Instagram rebinds approved actions after unrelated live changes without another model call', async () => {
  const f = await fixture();
  try {
    const j = f.make(['like', 'follow', 'comment']);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    f.approve(j.id);
    const decide = f.app.runner.model.decide.bind(f.app.runner.model);
    let calls = 0;
    f.app.runner.model.decide = async (...args) => {
      const result = await decide(...args);
      calls++;
      await f.app.browser.page!.evaluate(() => {
        const b = document.createElement('button');
        b.textContent = '새로운 알림';
        document.body.prepend(b);
      });
      return result;
    };
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    const done = f.app.store.job(j.id)!;
    assert.equal(done.status, 'completed', done.note);
    assert.deepEqual([f.data.likes, f.data.follows, f.data.posts, f.data.otherLikes], [1, 1, 1, 0]);
    assert.equal(calls, 4);
    assert.equal(done.autonomy!.metrics.recoveries, 0);
    assert.ok(done.history.some((h) => h.action === 'task_scope_refreshed'));
  } finally {
    await f.close();
  }
});

test('Instagram fresh action binding rejects account changes during model reasoning', async () => {
  const f = await fixture();
  try {
    const j = f.make(['like']);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    f.approve(j.id);
    const decide = f.app.runner.model.decide.bind(f.app.runner.model);
    f.app.runner.model.decide = async (...args) => {
      const result = await decide(...args);
      await f.app.browser
        .page!.locator('nav a')
        .evaluate((el) => el.setAttribute('href', '/changed_user/'));
      return result;
    };
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    assert.equal(f.app.store.job(j.id)!.status, 'needs_user');
    assert.equal(f.data.likes, 0);
  } finally {
    await f.close();
  }
});

test('Instagram preserves an intervening comment draft instead of overwriting it', async () => {
  const f = await fixture();
  try {
    const j = f.make(['comment']);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    f.approve(j.id);
    const decide = f.app.runner.model.decide.bind(f.app.runner.model);
    f.app.runner.model.decide = async (...args) => {
      const result = await decide(...args);
      await f.app.browser.page!.locator('textarea').fill('사용자가 직접 작성 중인 문구');
      return result;
    };
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    assert.equal(f.app.store.job(j.id)!.status, 'needs_user');
    assert.equal(f.data.posts, 0);
    assert.equal(
      await f.app.browser.page!.locator('textarea').inputValue(),
      '사용자가 직접 작성 중인 문구',
    );
  } finally {
    await f.close();
  }
});

test('Instagram resumes a still-valid task grant after rechecking the same account and target', async () => {
  const f = await fixture();
  try {
    const j = f.make(['comment']);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    f.approve(j.id);
    const retry = f.app.store.job(j.id)!;
    retry.tasks![0]!.state = 'review';
    delete retry.tasks![0]!.preview;
    f.app.store.saveJob(retry);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    const done = f.app.store.job(j.id)!;
    assert.equal(done.status, 'completed', done.note);
    assert.equal(f.data.posts, 1);
  } finally {
    await f.close();
  }
});
