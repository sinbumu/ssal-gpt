import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../../src/server.js';
import { Auth, ServiceError } from '../../src/auth.js';
import { Model } from '../../src/model.js';
import { runtimePath, privateDirectory, writePrivate } from '../../src/config.js';
import { createAutonomy, syntheticSettings } from '../../src/autonomy.js';
import { approveTask, type EntryTask } from '../../src/tasks.js';
import type { Job } from '../../src/store.js';
import { DRAFT_VERSION } from '../../src/task-draft.js';
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
    receiptPages: 0,
    carousel: false,
    revealedQuiz: false,
    imageQuiz: false,
    shifted: false,
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
    const cards = [
      'OX 퀴즈 2문제',
      '문제 1: 삼각형의 변은 3개다. O/X?',
      '문제 2: 5 더하기 4는 8이다. O/X?',
      '정답: 1번 O, 2번 X',
    ];
    const quizImage = (text: string) =>
      'data:image/svg+xml,' +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300"><rect width="640" height="300" fill="#e3effc"/><text x="24" y="120" font-size="26" font-family="sans-serif">${text}</text></svg>`,
      );
    const carousel = data.carousel
      ? `<div style="position:relative;width:${data.imageQuiz ? 640 : 360}px;height:${data.imageQuiz ? 300 : 180}px"><img id="card" width="${data.imageQuiz ? 640 : 360}" height="${data.imageQuiz ? 300 : 180}" alt="합성 카드" src="${quizImage(data.imageQuiz ? cards[0]! : '')}">${data.imageQuiz ? '' : '<p id="card-label" style="position:absolute;top:30px;left:20px">퀴즈 표지</p>'}<button id="next-card" aria-label="다음" style="position:absolute;right:4px;top:60px">→</button></div><script>let card=0;document.querySelector('#next-card').onclick=()=>{card++;${data.imageQuiz ? `document.querySelector('#card').src=${JSON.stringify(cards.map(quizImage))}[card]` : `document.querySelector('#card-label').textContent=['퀴즈 표지','문제 1: 1+1=2','문제 2: 2+2=5','정답: 1=O, 2=X'][card]`};if(card===3)document.querySelector('#next-card').remove()};</script>`
      : '';
    const comments = data.hideOwn
      ? ''
      : data.comments
          .map(
            (text) =>
              `<div class="row"><a href="/fixture_user/">fixture_user</a><span>${text}</span><button>${icon('좋아요')}</button></div>`,
          )
          .join('');
    const receiptScript = data.receiptPages
      ? `<script>let receiptPage=0;const pane=document.querySelector('#receipt-pane');pane.onscroll=()=>{if(receiptPage>=${data.receiptPages} || pane.scrollTop+pane.clientHeight<pane.scrollHeight-2)return;setTimeout(()=>{receiptPage++;pane.insertAdjacentHTML('beforeend',receiptPage>=${data.receiptPages} ? ${JSON.stringify(comments)} : '<p style="height:400px">다음 댓글 묶음</p>');},100)};</script>`
      : '';
    const renderedComments = data.receiptPages
      ? `<div id="receipt-pane" style="height:220px;overflow-y:auto"><a href="/other_user/">other_user</a><p style="height:400px">처음 로드된 댓글</p></div>`
      : comments;
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><style>nav,main{visibility:${data.renderDelay ? 'hidden' : 'visible'}}body{font:18px sans-serif}nav{position:absolute;left:20px;top:20px}main{margin-left:${data.shifted ? 330 : 230}px;width:720px}button{padding:12px}section{padding:15px}textarea{width:400px;height:60px}.row{margin:15px}</style><nav><a href="/${data.actor}/"><img width="40" height="40" alt="${data.actor} 프로필 사진" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E"></a></nav><main><div id="post"><header><a href="/fixture_host/">fixture_host</a><button id="follow">${data.follows ? '팔로잉' + icon('아래쪽 방향 V자형 아이콘') : '팔로우'}</button></header><div><p>합성 이벤트</p>${data.revealedQuiz ? '<p>퀴즈: 1+1=2인가요? 정답 O. 맞힌 개수를 댓글로 남겨주세요.</p>' : ''}${carousel}<div class="row"><a href="/other_user/">other_user</a><span>합성 응모합니다</span><button onclick="fetch('/fixture/other',{method:'POST'})">${icon('좋아요')}</button></div>${renderedComments}</div><section><button id="like">${icon(data.likes ? '좋아요 취소' : '좋아요')}</button><button>${icon('댓글 달기')}</button></section><section><form onsubmit="return false"><textarea placeholder="댓글 달기..."></textarea><button id="send">게시</button></form></section></div><article><button>${icon('좋아요')}</button><a href="/other_host/">추천 게시물</a></article></main><script>setTimeout(()=>document.querySelectorAll('nav,main').forEach(e=>e.style.visibility='visible'),${data.renderDelay});async function send(kind,text){await fetch('/fixture/'+kind,{method:'POST',body:text||''});location.reload()}document.querySelector('#like').onclick=()=>send('like');document.querySelector('#follow').onclick=()=>send('follow');document.querySelector('#send').onclick=()=>send('comment',document.querySelector('textarea').value);</script>${receiptScript}`,
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
        text: t.kind === 'comment' ? t.draft || '' : '',
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
test('an unavailable required target switches candidates only before grants or writes and preserves evidence', async () => {
  for (const mode of ['switch', 'policyOff', 'approved', 'unknown', 'missingActor']) {
    const f = await fixture();
    try {
      const j = f.make(['follow']);
      j.parentId = 'parent';
      j.startUrl = 'https://www.instagram.com/deleted_profile/';
      j.tasks![0]!.url = j.startUrl;
      if (mode === 'approved')
        j.tasks![0]!.approval = {
          id: 'grant',
          text: '',
          revision: syntheticSettings.revision,
          expires: Date.now() + 60000,
        };
      if (mode === 'unknown') j.uncertain = true;
      f.app.store.setSettings('selectionPolicy', {
        switchOnBurden: mode !== 'policyOff',
        maxSwitches: 1,
      });
      const parent = {
        ...j,
        id: 'parent',
        kind: 'discover',
        status: 'completed',
        tasks: undefined,
        autonomy: undefined,
        parentId: undefined,
        goal: '새 이벤트',
        maxSteps: 5,
        candidateLimit: 1,
        prepareOne: {
          revision: syntheticSettings.revision,
          expires: Date.now() + 60000,
          childId: j.id,
        },
      } as Job;
      f.app.store.saveJob(parent);
      f.app.store.saveJob(j);
      await f.app.browser.context!.route('https://www.instagram.com/**', async (r) => {
        assert.equal(r.request().method(), 'GET');
        await r.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<style>nav{position:absolute;left:20px;top:20px}main{margin:120px}</style>${mode === 'missingActor' ? '' : '<nav><a href="/fixture_user/"><img alt="프로필 사진" width="40" height="40" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E"></a></nav>'}<main><h2>죄송합니다. 페이지를 사용할 수 없습니다.</h2><p>클릭하신 링크가 잘못되었거나 페이지가 삭제되었습니다.</p></main>`,
        });
      });
      f.app.runner.model.decide = async (_p, _i, c: any) => {
        assert.equal(c.mode, 'discover');
        return {
          step: {
            action: 'done',
            observationId: c.observation.id,
            reason: '새 후보 탐색 모의 종료',
          },
          inputTokens: 0,
          outputTokens: 0,
        };
      };
      f.app.runner.start(j.id);
      await f.app.runner.finished();
      const done = f.app.store.job(j.id)!;
      assert.equal(
        done.status,
        mode === 'switch' ? 'stopped' : mode === 'unknown' ? 'submission_unknown' : 'needs_user',
      );
      assert.equal(!!done.switchReason, mode === 'switch');
      assert.ok(done.screenshot);
      const next = f.app.store
        .jobs()
        .filter((x) => x.parentId === 'parent' && x.kind === 'discover');
      assert.equal(next.length, mode === 'switch' ? 1 : 0);
      if (next.length) {
        assert.equal(next[0]!.maxSteps, 5);
        assert.equal(next[0]!.prepareOne!.switches, 1);
      }
      assert.deepEqual([f.data.likes, f.data.follows, f.data.posts], [0, 0, 0]);
    } finally {
      await f.close();
    }
  }
});

test('an unavailable-page phrase inside a valid post never overrides identified controls', async () => {
  const f = await fixture();
  try {
    await f.app.browser.navigate(url);
    await f.app.browser.page!.evaluate(() =>
      document.body.insertAdjacentHTML(
        'beforeend',
        '<p>죄송합니다. 페이지를 사용할 수 없습니다.</p>',
      ),
    );
    const o = await f.app.browser.observe(false, [], { url, kind: 'like' });
    assert.equal(o.instagram?.ready, true);
    assert.notEqual(o.instagram?.reason, 'instagram_target_unavailable');
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

test('Instagram control identity survives DOM insertion between handles and semantic inspection', async () => {
  const f = await fixture();
  try {
    await f.app.browser.navigate(url);
    const page = f.app.browser.page!;
    const evaluate = page.evaluate.bind(page);
    let injected = false;
    // observe captures element handles, then evaluates the Instagram scope.
    // Insert a new element only between those two reads, not during readiness polling.
    const original = page.locator.bind(page);
    page.locator = ((...args: Parameters<typeof page.locator>) => {
      const locator = original(...args);
      const handles = locator.elementHandles.bind(locator);
      locator.elementHandles = async () => {
        const captured = await handles();
        if (!injected && args[0].includes('[role=button]')) {
          injected = true;
          await evaluate(() => {
            const b = document.createElement('button');
            b.textContent = '새 알림';
            document.body.prepend(b);
          });
        }
        return captured;
      };
      return locator;
    }) as typeof page.locator;
    const o = await f.app.browser.observe(false, [], { url, kind: 'like' });
    assert.equal(injected, true);
    assert.equal(o.instagram?.ready, true);
    assert.equal(o.elements.find((e) => e.ref === o.instagram?.controls.like)?.label, '좋아요');
    assert.equal(f.data.likes + f.data.follows + f.data.posts + f.data.otherLikes, 0);
  } finally {
    await f.close();
  }
});

test('Instagram automatically reconsiders a rejected decision while preserving grants and verified follow', async () => {
  const f = await fixture();
  try {
    const j = f.make(['follow', 'like', 'comment']);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    f.approve(j.id);
    const grants = f.app.store.job(j.id)!.tasks!.map((t) => t.approval!.id);
    const decide = f.app.runner.model.decide.bind(f.app.runner.model);
    let wrong = true;
    f.app.runner.model.decide = async (...args) => {
      const c = args[2] as any;
      assert.ok(
        Object.keys(c.observation.instagram.controls).every((key) =>
          c.task.kind === 'comment' ? ['comment', 'post'].includes(key) : key === c.task.kind,
        ),
      );
      const result = await decide(...args);
      if (c.task.kind === 'like' && wrong) {
        wrong = false;
        result.step.ref = 'e1'; // Another observed control, never the target like.
      } else if (c.task.kind === 'like') {
        assert.equal(c.lastRejection, 'wrong_control');
        assert.equal(f.data.likes, 0);
        assert.equal(f.data.follows, 1);
      }
      return result;
    };
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    const done = f.app.store.job(j.id)!;
    assert.equal(done.status, 'completed', done.note);
    assert.deepEqual(
      done.tasks!.map((t) => t.approval!.id),
      grants,
    );
    assert.deepEqual([f.data.likes, f.data.follows, f.data.posts, f.data.otherLikes], [1, 1, 1, 0]);
    assert.equal(done.autonomy!.metrics.recoveries, 1);
    assert.equal(done.tasks![1]!.rejections![0]!.reason, 'wrong_control');
    assert.equal(done.tasks![1]!.rejections![0]!.retryScheduled, true);
    assert.ok(done.history.some((h) => h.action === 'task_decision_recovery'));
  } finally {
    await f.close();
  }
});

test('Instagram decision recovery is bounded, persists diagnostics without raw text, and preserves approval', async () => {
  const f = await fixture();
  try {
    const j = f.make(['like']);
    j.autonomy!.policy.maxRecoveries = 2;
    f.app.store.saveJob(j);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    f.approve(j.id);
    const grant = f.app.store.job(j.id)!.tasks![0]!.approval;
    f.app.runner.model.decide = async (_p, _i, c: any) => ({
      step: {
        action: 'click',
        observationId: c.observation.id,
        ref: 'private@example.invalid',
        text: 'unapproved private content',
        reason: 'untrusted reason',
      },
      inputTokens: 1,
      outputTokens: 1,
    });
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    let stopped = f.app.store.job(j.id)!;
    assert.equal(stopped.status, 'needs_user');
    assert.match(stopped.note, /자동 복구 한도/);
    assert.equal(stopped.steps, 3);
    assert.equal(stopped.autonomy!.metrics.recoveries, 2);
    assert.deepEqual(stopped.tasks![0]!.approval, grant);
    assert.equal(stopped.tasks![0]!.rejections!.at(-1)!.retryScheduled, false);
    assert.doesNotMatch(
      JSON.stringify(stopped.tasks![0]!.rejections),
      /private@|unapproved|untrusted/,
    );
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    stopped = f.app.store.job(j.id)!;
    assert.equal(stopped.steps, 4); // Another explicit resume does not reset the retry budget.
    assert.equal(stopped.autonomy!.metrics.recoveries, 2);
    assert.equal(f.data.likes + f.data.follows + f.data.posts + f.data.otherLikes, 0);
  } finally {
    await f.close();
  }
});

test('Instagram rechecks account after a rejected decision instead of recovering across an account change', async () => {
  const f = await fixture();
  try {
    const j = f.make(['like']);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    f.approve(j.id);
    f.app.runner.model.decide = async (_p, _i, c: any) => {
      await f.app.browser
        .page!.locator('nav a')
        .evaluate((e) => e.setAttribute('href', '/changed_user/'));
      return {
        step: {
          action: 'click',
          observationId: c.observation.id,
          ref: 'e999',
          reason: '합성 오류',
        },
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    const stopped = f.app.store.job(j.id)!;
    assert.equal(stopped.status, 'needs_user');
    assert.match(stopped.note, /계정.*바뀌/);
    assert.equal(stopped.steps, 1);
    assert.equal(f.data.likes + f.data.posts + f.data.otherLikes, 0);
  } finally {
    await f.close();
  }
});

test('Instagram reads paginated comment receipt and reveals its own row without reposting or more model calls', async () => {
  const f = await fixture();
  try {
    f.data.receiptPages = 3;
    const j = f.make(['comment']);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    f.approve(j.id);
    const grant = f.app.store.job(j.id)!.tasks![0]!.approval;
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    const done = f.app.store.job(j.id)!;
    assert.equal(done.status, 'completed', done.note);
    assert.equal(f.data.posts, 1);
    assert.equal(done.steps, 2); // Type and post only; receipt loading uses no AI calls.
    assert.equal(done.tasks![0]!.receiptReads, 3);
    assert.deepEqual(done.tasks![0]!.approval, grant);
    const row = await f.app.browser.page!.locator('#receipt-pane .row').boundingBox();
    const pane = await f.app.browser.page!.locator('#receipt-pane').boundingBox();
    assert.ok(row && pane && row.y >= pane.y && row.y + row.height <= pane.y + pane.height);
  } finally {
    await f.close();
  }
});

test('Instagram bounds persisted receipt scans and never sends an uncertain comment again', async () => {
  const f = await fixture();
  try {
    f.data.receiptPages = 100;
    f.data.hideOwn = true;
    const j = f.make(['comment']);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    f.approve(j.id);
    const pending = f.app.store.job(j.id)!;
    pending.tasks![0]!.attempt = { at: Date.now(), beforeText: 'previous view' };
    pending.tasks![0]!.state = 'attempted';
    pending.tasks![0]!.receiptReads = 19;
    pending.tasks![0]!.receiptScanStartedAt = Date.now();
    pending.uncertain = true;
    pending.status = 'submission_unknown';
    f.data.posts = 1;
    f.app.store.saveJob(pending);
    for (let i = 0; i < 2; i++) {
      f.app.runner.start(j.id);
      await f.app.runner.finished();
      const stopped = f.app.store.job(j.id)!;
      assert.equal(stopped.status, 'submission_unknown');
      assert.equal(stopped.tasks![0]!.receiptReads, 20);
      assert.equal(stopped.steps, 0);
      assert.equal(f.data.posts, 1);
    }
  } finally {
    await f.close();
  }
});

test('missing comment draft uses the visible page before batch review, shows its basis and posts only user-approved text', async () => {
  const f = await fixture(),
    ui = await chromium.launch({ headless: true });
  try {
    const j = f.make(['like', 'follow', 'comment']);
    delete j.tasks![2]!.draft;
    f.app.store.saveJob(j);
    const execute = f.app.runner.model.decide.bind(f.app.runner.model);
    let draftCalls = 0;
    f.app.runner.model.decide = async (p, instruction, c: any, image, signal) => {
      if (c.phase !== 'comment_draft') return execute(p, instruction, c, image, signal);
      draftCalls++;
      assert.ok(image.length > 100);
      assert.equal(c.task.url, url);
      assert.ok(c.observation.text.includes('합성 이벤트'));
      assert.equal(c.approvedText, undefined);
      return {
        step: {
          action: 'done',
          observationId: c.observation.id,
          text: '합성 응모합니다',
          draftBasis: 'source_text',
          draftRequirementsMet: true,
          evidenceQuote: '합성 이벤트',
          url,
          reason: '관측한 원문의 문구를 권장 댓글로 준비했습니다.',
        },
        inputTokens: 11,
        outputTokens: 7,
      };
    };
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    const prepared = f.app.store.job(j.id)!;
    assert.equal(prepared.status, 'needs_user', prepared.note);
    assert.equal(prepared.steps, 1);
    assert.deepEqual([prepared.inputTokens, prepared.outputTokens], [11, 7]);
    assert.equal(prepared.tasks![2]!.draft, '합성 응모합니다');
    assert.equal(prepared.tasks![2]!.draftPreparation?.state, 'ready');
    assert.equal(prepared.tasks![2]!.draftPreparation?.sourceUrl, url);
    assert.ok(prepared.tasks!.every((t) => !t.approval && !t.attempt));
    assert.deepEqual([f.data.likes, f.data.follows, f.data.posts], [0, 0, 0]);
    const page = await ui.newPage();
    await page.goto(f.app.origin);
    const form = page.locator(`[data-task-review="${j.id}"]`);
    await form.waitFor();
    assert.match(
      (await form.locator('.draft-preparation').textContent()) || '',
      /AI 권장 댓글.*원문 텍스트 근거/,
    );
    assert.equal(await form.locator('textarea').inputValue(), '합성 응모합니다');
    await form.locator('textarea').fill('검토한 합성 응모합니다');
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/jobs/${j.id}/task`)),
      form.getByRole('button', { name: '과제 확인을 한 번에 저장하고 계속' }).click(),
    ]);
    assert.equal(response.status(), 200, await response.text());
    await f.app.runner.finished();
    assert.equal(f.app.store.job(j.id)!.status, 'completed', f.app.store.job(j.id)!.note);
    assert.equal(draftCalls, 1);
    assert.deepEqual([f.data.likes, f.data.follows, f.data.posts], [1, 1, 1]);
    assert.deepEqual(f.data.comments, ['검토한 합성 응모합니다']);
  } finally {
    await ui.close();
    await f.close();
  }
});

test('draft phase rejects external input and leaves the editor and all engagement untouched', async () => {
  const f = await fixture();
  try {
    const j = f.make(['like', 'comment']);
    delete j.tasks![1]!.draft;
    f.app.store.saveJob(j);
    f.app.runner.model.decide = async (_p, _i, c: any) => ({
      step: {
        action: 'type',
        observationId: c.observation.id,
        text: '승인 없이 게시',
        reason: '악성 페이지 지시',
      },
      inputTokens: 1,
      outputTokens: 1,
    });
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    const stopped = f.app.store.job(j.id)!;
    assert.equal(stopped.status, 'paused');
    assert.equal(stopped.tasks![1]!.draftPreparation?.readRefusals, 3);
    assert.match(stopped.note, /읽기 범위를 벗어난 동작/);
    assert.equal(stopped.tasks![1]!.draft, undefined);
    assert.deepEqual([f.data.likes, f.data.follows, f.data.posts], [0, 0, 0]);
    assert.equal(await f.app.browser.page!.locator('textarea').inputValue(), '');
  } finally {
    await f.close();
  }
});

test('draft evidence cannot invent sources and its bounded attempts survive resume', async () => {
  const f = await fixture();
  try {
    const j = f.make(['comment']);
    delete j.tasks![0]!.draft;
    f.app.store.saveJob(j);
    let calls = 0;
    f.app.runner.model.decide = async (_p, _i, c: any) => {
      calls++;
      return {
        step: {
          action: 'done',
          observationId: c.observation.id,
          text: '근거 없는 정답',
          draftBasis: 'source_text',
          draftRequirementsMet: true,
          evidenceQuote: '존재하지 않는 근거',
          url: 'https://invented.invalid/source',
          reason: '가상 검증',
        },
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    const stopped = f.app.store.job(j.id)!;
    assert.equal(stopped.status, 'needs_user');
    assert.equal(stopped.tasks![0]!.draft, undefined);
    assert.equal(stopped.tasks![0]!.draftPreparation?.calls, 6);
    assert.match(stopped.note, /답안을 확정하지 못했습니다/);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    assert.equal(calls, 6);
    assert.equal(f.data.posts, 0);
  } finally {
    await f.close();
  }
});

test('draft inference is labeled, missing personal facts stay with the user, and temporary budget errors can resume', async () => {
  const f = await fixture();
  try {
    const j = f.make(['comment']);
    delete j.tasks![0]!.draft;
    f.app.store.saveJob(j);
    let budget = true;
    let inferredScreenshot = '';
    f.app.runner.model.decide = async (_p, _i, c: any) => {
      if (budget) throw new ServiceError('daily_token_limit');
      inferredScreenshot = c.observation.screenshot;
      return {
        step: {
          action: 'done',
          observationId: c.observation.id,
          text: '공개 단서에서 추론한 합성 답안',
          draftBasis: 'inference',
          draftRequirementsMet: true,
          evidenceQuote: '합성 이벤트',
          reason: '이미지와 공개 설명을 함께 해석한 제안입니다.',
        },
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    assert.match(f.app.store.job(j.id)!.note, /토큰 사용량이 설정 한도/);
    assert.equal(f.app.store.job(j.id)!.tasks![0]!.draftPreparation?.state, 'reading');
    budget = false;
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    assert.equal(f.app.store.job(j.id)!.tasks![0]!.draftPreparation?.basis, 'inference');
    assert.equal(
      f.app.store.job(j.id)!.tasks![0]!.draftPreparation?.screenshot,
      inferredScreenshot,
    );
    assert.equal(f.data.posts, 0);
    const personal = f.make(['comment']);
    delete personal.tasks![0]!.draft;
    f.app.store.saveJob(personal);
    f.app.runner.model.decide = async (_p, _i, c: any) => ({
      step: {
        action: 'needs_user',
        observationId: c.observation.id,
        reason: '직접 사용한 경험이 필요한 질문이며 저장된 사실이 없습니다.',
        draftBasis: 'suggestion',
        draftRequirementsMet: true,
        commentPlan: {
          parts: [
            { text: '합성 이벤트 응원합니다. ' },
            { inputId: 'experience', prefix: '', suffix: '' },
          ],
          inputs: [
            {
              id: 'experience',
              label: '직접 사용한 경험을 알려주세요.',
              kind: 'text',
              options: [],
            },
          ],
        },
      },
      inputTokens: 1,
      outputTokens: 1,
    });
    f.app.runner.start(personal.id);
    await f.app.runner.finished();
    assert.equal(f.app.store.job(personal.id)!.tasks![0]!.draft, '합성 이벤트 응원합니다.');
    assert.equal(
      f.app.store.job(personal.id)!.tasks![0]!.draftPreparation?.commentPlan?.inputs[0]?.kind,
      'text',
    );
    assert.match(f.app.store.job(personal.id)!.note, /직접 사용한 경험/);
    assert.equal(f.data.posts, 0);
  } finally {
    await f.close();
  }
});

test('carousel quiz prepares a verified score from frozen earlier answers and replaces only unapproved legacy drafts', async () => {
  const f = await fixture();
  try {
    f.data.carousel = true;
    const j = f.make(['like', 'follow', 'comment']);
    const task = j.tasks![2]!;
    task.instruction = '2가지 OX퀴즈를 풀고 맞힌 문제 개수를 댓글로 남겨주세요.';
    task.draft = '근거 없이 응원합니다';
    task.draftPreparation = {
      state: 'ready',
      calls: 2,
      basis: 'suggestion',
      reason: '문항 미확인',
    };
    // B10: evidence from discovery must be retained on disk but not repeated in this phase.
    j.autonomy!.evidence = [
      {
        id: 'old',
        url: 'https://unrelated.invalid/old',
        title: '무관한 자료',
        text: 'unrelated '.repeat(10000),
        screenshot: 'old.png',
        observedAt: 1,
      },
    ];
    f.app.store.saveJob(j);
    const execute = f.app.runner.model.decide.bind(f.app.runner.model);
    let rejected = false;
    f.app.runner.model.decide = async (p, i, c: any, image, signal) => {
      if (c.phase !== 'comment_draft') return execute(p, i, c, image, signal);
      assert.ok(image.length > 100);
      assert.ok(!JSON.stringify(c).includes('unrelated.invalid'));
      const o = c.observation;
      const step: any = { observationId: o.id, reason: '합성 카드의 공개 자료 읽기' };
      if (!rejected) {
        rejected = true;
        Object.assign(step, {
          action: 'done',
          text: '응원합니다',
          draftBasis: 'suggestion',
          draftRequirementsMet: true,
        });
      } else if (o.text.includes('정답: 1=O')) {
        assert.equal(c.quizAttempts.length, 2);
        assert.equal(c.quizAttempts[0].answer, 'O');
        assert.equal(c.quizAttempts[1].answer, 'O'); // Wrong initial answer must not be rewritten.
        Object.assign(step, {
          action: 'done',
          text: '2문제 중 1개 정답입니다.',
          draftBasis: 'inference',
          draftRequirementsMet: true,
          evidenceQuote: '정답: 1=O, 2=X',
          draftScore: { correct: 1, total: 2 },
          quizAnswers: [{ number: 2, question: '문제 2', answer: 'X' }],
          quizKey: [
            { number: 1, answer: 'O', evidenceQuote: '정답: 1=O' },
            { number: 2, answer: 'X', evidenceQuote: '2=X' },
          ],
        });
      } else {
        assert.equal(o.hasResponseFields, true);
        const next = o.elements.find((e: any) => e.mediaNavigation === 'next');
        assert.ok(next, 'post image arrow is a read control despite comment editor');
        Object.assign(step, { action: 'click', ref: next.ref });
        if (o.text.includes('문제 1:'))
          step.quizAnswers = [{ number: 1, question: '1+1=2', answer: 'O' }];
        if (o.text.includes('문제 2:'))
          step.quizAnswers = [{ number: 2, question: '2+2=5', answer: 'O' }];
      }
      return { step, inputTokens: 1, outputTokens: 1 };
    };
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    const ready = f.app.store.job(j.id)!;
    assert.equal(ready.tasks![2]!.draft, '2문제 중 1개 정답입니다.', ready.note);
    assert.equal(ready.tasks![2]!.draftPreparation?.superseded?.draft, '근거 없이 응원합니다');
    assert.equal(ready.tasks![2]!.draftPreparation?.quiz?.[1]?.answer, 'O');
    assert.ok(ready.history.some((h) => h.action === 'comment_draft_rejected'));
    assert.ok(ready.autonomy!.evidence.some((s) => s.id === 'old'));
    assert.deepEqual([f.data.likes, f.data.follows, f.data.posts], [0, 0, 0]);
    f.approve(j.id);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    assert.equal(f.app.store.job(j.id)!.status, 'completed', f.app.store.job(j.id)!.note);
    assert.deepEqual([f.data.likes, f.data.follows, f.data.posts], [1, 1, 1]);
    assert.deepEqual(f.data.comments, ['2문제 중 1개 정답입니다.']);
  } finally {
    await f.close();
  }
});

test('read refusal is replayable and recovers without widening click permissions or posting', async () => {
  const f = await fixture();
  try {
    f.data.carousel = true;
    const j = f.make(['like', 'follow', 'comment']);
    delete j.tasks![2]!.draft;
    f.app.store.saveJob(j);
    let calls = 0;
    f.app.runner.model.decide = async (_p, _i, c: any) => {
      calls++;
      const next = c.observation.elements.find((e: any) => e.mediaNavigation === 'next');
      return {
        step:
          calls === 1
            ? {
                action: 'click',
                observationId: c.observation.id,
                x: next.x + 1,
                y: next.y + 1,
                reason: '합성 좌표 선택',
              }
            : calls === 2
              ? {
                  action: 'click',
                  observationId: c.observation.id,
                  ref: next.ref,
                  reason: '새 관찰 요소 선택',
                }
              : {
                  action: 'done',
                  observationId: c.observation.id,
                  text: '새 출발을 응원합니다!',
                  reason: '공개 응원 제안',
                  draftBasis: 'suggestion',
                  draftRequirementsMet: true,
                },
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    const ready = f.app.store.job(j.id)!;
    assert.equal(ready.status, 'needs_user', ready.note);
    assert.equal(ready.tasks![2]!.draft, '새 출발을 응원합니다!');
    assert.deepEqual(
      ready.readTraces?.map((r) => r.reason),
      ['missing_ref', 'read_action', 'draft_ready'],
    );
    assert.deepEqual([f.data.likes, f.data.follows, f.data.posts], [0, 0, 0]);
  } finally {
    await f.close();
  }
});

test('unverifiable quiz score skips only before approval under configured candidate policy', async () => {
  const f = await fixture();
  try {
    f.data.revealedQuiz = true;
    for (const enabled of [false, true]) {
      f.app.store.setSettings('selectionPolicy', { switchOnBurden: enabled });
      const j = f.make(['like', 'follow', 'comment']);
      j.parentId = 'synthetic-parent';
      delete j.tasks![2]!.draft;
      j.tasks![2]!.instruction = '퀴즈에서 맞힌 개수를 남겨주세요.';
      f.app.store.saveJob(j);
      f.app.runner.model.decide = async (_p, _i, c: any) => {
        assert.match(c.observation.text, /퀴즈: 1\+1=2인가요\? 정답 O/);
        return {
          step: {
            action: 'skip_source',
            skipCategory: 'requirements',
            observationId: c.observation.id,
            reason: '문제와 정답이 함께 보여 사전에 푼 답안 없이 맞힌 개수를 확인할 수 없습니다.',
          },
          inputTokens: 1,
          outputTokens: 1,
        };
      };
      f.app.runner.start(j.id);
      await f.app.runner.finished();
      const result = f.app.store.job(j.id)!;
      assert.equal(result.status, enabled ? 'stopped' : 'needs_user', result.note);
      assert.equal(result.tasks![2]!.draftPreparation?.failureKind, 'public_evidence');
      assert.equal(result.readTraces?.at(-1)?.reason, 'candidate_requirements_unresolved');
      assert.equal(result.readTraces?.at(-1)?.status, 'accepted');
      assert.equal(result.tasks![2]!.draft, undefined);
      assert.deepEqual([f.data.likes, f.data.follows, f.data.posts], [0, 0, 0]);
    }
  } finally {
    await f.close();
  }
});

// Opt-in only: uses the user's already connected ChatGPT plan, never an API fallback.
// Isolated fixture browser/store; no real Instagram requests or participation.
test(
  'live AI reads image-only quiz cards on two layouts before preparing review',
  { skip: process.env.SSAL_LIVE_COMMENT_QUIZ !== '1' },
  async () => {
    const dir = runtimePath();
    const live = new Model(new Auth(dir));
    const state = (await fetch('http://127.0.0.1:4317/api/state').then((r) => r.json())) as any;
    assert.equal(state.busy, false);
    assert.equal(state.selection.kind, 'chatgpt');
    assert.ok(state.operations.dailyCalls - state.usage.calls >= 20);
    assert.ok(state.operations.dailyTokens - state.usage.tokens >= 300000);
    const reportDir = privateDirectory(join(dir, 'benchmarks', 'image-quiz-' + Date.now()));
    const reports: any[] = [];
    const digest = () =>
      createHash('sha256')
        .update(
          ['browser', 'task-draft', 'tasks', 'model', 'research']
            .map((name) =>
              readFileSync(new URL('../../src/' + name + '.ts', import.meta.url), 'utf8'),
            )
            .join('\n'),
        )
        .digest('hex');
    const sourceDigest = digest();
    let usedCalls = 0,
      usedTokens = 0;
    for (const shifted of [false, true]) {
      const f = await fixture();
      let calls = 0;
      try {
        f.data.carousel = f.data.imageQuiz = true;
        f.data.shifted = shifted;
        const j = f.make(['comment']);
        j.provider = state.selection;
        j.tasks![0]!.instruction =
          '2가지 OX퀴즈를 직접 풀고 맞힌 문제 개수를 댓글로 남겨주세요. 이미지에 문항과 정답이 있습니다.';
        j.tasks![0]!.quote = '2가지 OX퀴즈를 풀고 댓글로 맞힌 문제 개수를 남겨주세요.';
        delete j.tasks![0]!.draft;
        f.app.store.saveJob(j);
        f.app.runner.model.decide = async (...args) => {
          assert.ok(++calls <= 10);
          assert.ok(++usedCalls <= 20);
          assert.equal(digest(), sourceDigest, 'freeze benchmark source during the run');
          const current = (await fetch('http://127.0.0.1:4317/api/state').then((r) =>
            r.json(),
          )) as any;
          assert.equal(current.busy, false, 'do not overlap with a real entry');
          assert.equal((args[2] as any).phase, 'comment_draft');
          assert.ok(current.usage.calls + usedCalls < current.operations.dailyCalls);
          assert.ok(current.usage.tokens + usedTokens < current.operations.dailyTokens);
          const result = await live.decide(...args);
          usedTokens += result.inputTokens + result.outputTokens;
          return result;
        };
        const start = Date.now();
        f.app.runner.start(j.id);
        await f.app.runner.finished();
        const done = f.app.store.job(j.id)!;
        const report = {
          sourceDigest,
          shifted,
          elapsedMs: Date.now() - start,
          calls,
          status: done.status,
          note: done.note,
          inputTokens: done.inputTokens,
          outputTokens: done.outputTokens,
          task: done.tasks![0],
          history: done.history,
        };
        reports.push(report);
        cpSync(join(f.app.store.dir, 'evidence'), join(reportDir, shifted ? 'shifted' : 'normal'), {
          recursive: true,
        });
        writePrivate(join(reportDir, 'results.json'), reports);
        console.log(
          JSON.stringify({
            shifted,
            calls,
            elapsedMs: report.elapsedMs,
            tokens: done.inputTokens + done.outputTokens,
            ready: report.task.draftPreparation?.state === 'ready',
            reportDir,
          }),
        );
        assert.equal(done.tasks![0]!.draftPreparation?.state, 'ready', done.note);
        const attempts = done.tasks![0]!.draftPreparation!.quiz!;
        assert.equal(attempts.length, 2);
        assert.deepEqual(
          attempts.map((q) => q.answer),
          ['O', 'X'],
        );
        assert.deepEqual(
          attempts.map((q) => q.key?.answer),
          ['O', 'X'],
        );
        assert.match(done.tasks![0]!.draft!, /2\s*(개|문제|문항)/);
        assert.deepEqual([f.data.likes, f.data.follows, f.data.posts], [0, 0, 0]);
      } finally {
        await f.close();
      }
    }
  },
);

test('object-count draft resumes an unapproved legacy failure and reaches review without a score ledger', async () => {
  const f = await fixture();
  try {
    const j = f.make(['comment']),
      task = j.tasks![0]!;
    delete task.draft;
    task.instruction =
      '그림의 동그라미 개수를 확인하고 정답 댓글을 작성합니다. 친구 태그는 제외합니다.';
    task.quote = '여섯 개의 그림 중 동그라미는 몇 개일까요? 정답을 댓글로 남겨주세요.';
    task.draftPreparation = {
      state: 'needs_input',
      calls: 6,
      version: DRAFT_VERSION - 1,
      reason: '이전 분류에서 문제 풀이 기록을 요구했습니다.',
    };
    f.app.store.saveJob(j);
    let calls = 0;
    f.app.runner.model.decide = async (_p, instructions, c: any) => {
      calls++;
      assert.match(instructions, /Counting visible objects/);
      return {
        step: {
          action: 'done',
          observationId: c.observation.id,
          text: '정답은 3개입니다!',
          draftBasis: 'inference',
          draftRequirementsMet: true,
          evidenceQuote: '합성 이벤트',
          reason: '합성 공개 그림의 개수를 판단한 제안입니다.',
        },
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    const ready = f.app.store.job(j.id)!;
    assert.equal(ready.status, 'needs_user', ready.note);
    assert.equal(ready.tasks![0]!.draft, '정답은 3개입니다!');
    assert.ok(ready.tasks![0]!.preview);
    assert.equal(ready.tasks![0]!.approval, undefined);
    assert.equal(ready.tasks![0]!.draftPreparation?.superseded?.calls, 6);
    assert.equal(ready.tasks![0]!.draftPreparation?.calls, 1);
    assert.equal(calls, 1);
    assert.deepEqual([f.data.likes, f.data.follows, f.data.posts], [0, 0, 0]);
  } finally {
    await f.close();
  }
});

test('partial AI comment asks only personal choice, blocks pasted guidance atomically, then posts composed approved copy once', async () => {
  const f = await fixture(),
    ui = await chromium.launch({ headless: true });
  try {
    const j = f.make(['like', 'follow', 'comment']);
    delete j.tasks![2]!.draft;
    f.app.store.saveJob(j);
    const execute = f.app.runner.model.decide.bind(f.app.runner.model);
    let calls = 0;
    f.app.runner.model.decide = async (p, instruction, c: any, image, signal) => {
      if (c.phase !== 'comment_draft') return execute(p, instruction, c, image, signal);
      calls++;
      assert.match(instruction, /commentPlan/);
      return {
        step: {
          action: 'needs_user',
          observationId: c.observation.id,
          reason: '공개 정답은 준비했고 수익 선호만 본인 선택이 필요합니다.',
          draftBasis: 'source_text',
          draftRequirementsMet: true,
          evidenceQuote: '합성 이벤트',
          url,
          commentPlan: {
            parts: [{ text: 'Q1 2번' }, { inputId: 'q2', prefix: ' / Q2 ', suffix: '' }],
            inputs: [
              {
                id: 'q2',
                label: '수익을 언제 받고 싶나요?',
                kind: 'choice',
                options: [
                  { id: 'once', label: '처음 한 번만', text: '1번' },
                  { id: 'each', label: '판매될 때마다', text: '2번' },
                ],
              },
            ],
          },
        },
        inputTokens: 11,
        outputTokens: 7,
      };
    };
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    const ready = f.app.store.job(j.id)!;
    assert.equal(ready.status, 'needs_user', ready.note);
    assert.equal(ready.tasks![2]!.draft, 'Q1 2번');
    assert.deepEqual([f.data.likes, f.data.follows, f.data.posts], [0, 0, 0]);
    const page = await ui.newPage();
    await page.goto(f.app.origin);
    const form = page.locator(`[data-task-review="${j.id}"]`);
    await form.waitFor();
    assert.equal(await form.locator('[data-comment-input]').count(), 1);
    assert.equal(await form.locator('textarea').inputValue(), 'Q1 2번');
    assert.equal(await form.locator('select').inputValue(), '');
    const csrf = (await (await page.request.get(f.app.origin + '/api/state')).json()).csrf;
    const items = ready.tasks!.map((t) => ({
      taskId: t.id,
      mode: 'approve',
      text: t.kind === 'comment' ? 'Q1 2번 / Q2 2번' : '',
    }));
    const missing = await page.request.post(f.app.origin + `/api/jobs/${j.id}/task`, {
      headers: { 'X-Ssal-Token': csrf },
      data: { items },
    });
    assert.equal(missing.status(), 400);
    assert.ok(f.app.store.job(j.id)!.tasks!.every((t) => !t.approval));
    await form.locator('select').selectOption('each');
    assert.equal(await form.locator('textarea').inputValue(), 'Q1 2번 / Q2 2번');
    await form
      .locator('textarea')
      .fill('Q1 2번 / Q2 2번. 저장된 개인 의견 직접 확인·게시 문구 승인 정책에 따른 요청입니다');
    const [blocked] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/jobs/${j.id}/task`)),
      form.getByRole('button', { name: '과제 확인을 한 번에 저장하고 계속' }).click(),
    ]);
    assert.equal(blocked.status(), 400);
    assert.match(await blocked.text(), /comment_contains_guidance/);
    assert.ok(f.app.store.job(j.id)!.tasks!.every((t) => !t.approval));
    assert.deepEqual([f.data.likes, f.data.follows, f.data.posts], [0, 0, 0]);
    await page.getByText('댓글에 앱 안내문이 섞여 있습니다.', { exact: false }).waitFor();
    // Choice changes do not silently overwrite the owner's edited text.
    await form.locator('select').selectOption('once');
    assert.match(await form.locator('textarea').inputValue(), /저장된/);
    await form.getByRole('button', { name: '선택한 답변으로 댓글 다시 만들기' }).click();
    assert.equal(await form.locator('textarea').inputValue(), 'Q1 2번 / Q2 1번');
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/jobs/${j.id}/task`)),
      form.getByRole('button', { name: '과제 확인을 한 번에 저장하고 계속' }).click(),
    ]);
    assert.equal(response.status(), 200, await response.text());
    await f.app.runner.finished();
    assert.equal(f.app.store.job(j.id)!.status, 'completed', f.app.store.job(j.id)!.note);
    assert.equal(calls, 1);
    assert.deepEqual(f.data.comments, ['Q1 2번 / Q2 1번']);
    assert.deepEqual([f.data.likes, f.data.follows, f.data.posts], [1, 1, 1]);
  } finally {
    await ui.close();
    await f.close();
  }
});

test('legacy approval containing instructions stops the whole phase before any external action', async () => {
  const f = await fixture();
  try {
    const j = f.make(['like', 'follow', 'comment']);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    f.approve(j.id);
    const old = f.app.store.job(j.id)!;
    old.tasks![2]!.approval!.text = '정답 2번. 대시보드에서 확인해 주세요.';
    f.app.store.saveJob(old);
    f.app.runner.start(j.id);
    await f.app.runner.finished();
    const stopped = f.app.store.job(j.id)!;
    assert.equal(stopped.status, 'needs_user', stopped.note);
    assert.equal(stopped.tasks![2]!.approval, undefined);
    assert.equal(stopped.history.at(-1)?.action, 'comment_content_blocked');
    assert.deepEqual([f.data.likes, f.data.follows, f.data.posts], [0, 0, 0]);
  } finally {
    await f.close();
  }
});
