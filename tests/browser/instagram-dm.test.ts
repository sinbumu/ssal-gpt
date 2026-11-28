import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../../src/server.js';
import type { Job } from '../../src/store.js';
import { startDmBatch, resultBatch } from '../../src/result-batch.js';
import { dmReplyPreview, sendApprovedDm, replyAttempt } from '../../src/dm-reply.js';
import { outcomes } from '../../src/outcomes.js';
import { collectNotices } from '../../src/reward-notifications.js';

const pixel =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2230%22 height=%2230%22%3E%3Crect width=%2230%22 height=%2230%22 fill=%22green%22/%3E%3C/svg%3E';
test('DM browser flow scopes recipient/incoming screenshot, links grounded win, queues ambiguous review and never sends messages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-dm-browser-')),
    app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  const ui = await chromium.launch({ headless: true });
  try {
    const ids: string[] = [];
    for (const host of [
      'fixture_host',
      'ambiguous_host',
      'empty_host',
      'wrong_host',
      'fallback_host',
      'headerless_host',
    ]) {
      const e = app.store.record(
        {
          title: '합성 달력 ' + host,
          organizer: host,
          entryUrl: 'https://www.instagram.com/p/' + host + '/',
          deadline: null,
          prize: '달력',
          winners: 1,
          requirements: [],
          blockers: [],
          evidenceQuote: 'fixture',
          evidenceKind: 'text',
          effortMinutes: 1,
        },
        'https://www.instagram.com/p/' + host + '/',
        'fixture',
        'test.png',
      ).event;
      const id = randomUUID();
      app.store.saveJob({
        id,
        kind: 'apply',
        eventId: e.id,
        status: 'completed',
        browserEngine: 'chromium',
        history: [],
        tasks: [
          {
            id: 'follow',
            kind: 'follow',
            url: 'https://www.instagram.com/' + host + '/',
            state: 'verified',
            proof: { actor: 'browser' },
            preview: { actor: 'fixture_user', subject: host },
            approval: { actor: 'fixture_user', subject: host },
          },
        ],
      } as unknown as Job);
      app.store.claimSubmission(e.id, id);
      app.store.markSubmission(e.id, 'completed', '{}');
      ids.push(e.id);
    }
    await app.browser.open();
    let writes = 0,
      calls = 0,
      threadReads = 0;
    await app.browser.context!.route('https://www.instagram.com/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/v1/direct_v2/create_group_thread/') return route.fallback();
      if (pathname === '/direct/t/existing/' && ++threadReads === 1)
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '<p>문제가 발생했습니다</p>',
        });
      if (pathname === '/direct/inbox/')
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<input placeholder="검색"><button onclick="location.href='/direct/t/existing/'">사용자 아바타 <span>fallback_host</span></button>`,
        });
      if (route.request().method() !== 'GET') {
        writes++;
        return route.abort();
      }
      const host = pathname.startsWith('/direct/t/') ? 'fallback_host' : pathname.split('/')[1]!;
      const sender = host === 'wrong_host' ? 'unrelated_host' : host;
      const text =
        host === 'ambiguous_host'
          ? '축하합니다! 달력에 당첨되셨습니다! 주소를 보내주세요.'
          : `합성 달력 ${host}에 당첨되셨습니다! 이름과 주소를 12월 1일까지 보내주세요.`;
      const incoming =
        host === 'empty_host'
          ? ''
          : `<div role="row"><a href="/${sender}/"><img src="${pixel}" alt="${sender}님의 프로필 사진"></a><p>${text}</p></div><div role="row"><a href="/fixture_user/">fixture_user</a><p>PRIVATE OUTGOING STREET</p></div>`;
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<style>body{font:16px sans-serif}nav{position:absolute;left:10px}main{margin-left:200px}.pane{position:fixed;left:600px;top:100px;width:450px;height:650px;background:#fff;border:1px solid #000}[role=row]{margin:10px}</style><nav><a href="/fixture_user/"><img src="${pixel}" alt="fixture_user 프로필 사진"></a></nav><main><h1>${host}</h1><button id="open">메시지 보내기</button></main><aside style="position:absolute;left:200px;top:500px">UNRELATED PRIVATE CHAT</aside><section class="pane" ${pathname.startsWith('/direct/t/') ? '' : 'hidden'}><header><div style="display:inline-block"><div><div><div><div><div><div><a href="/${sender}/" ${['empty_host', 'headerless_host'].includes(host) ? 'aria-label' : 'title'}="${sender}님의 프로필 페이지 열기">${sender}</a></div></div></div></div></div></div></div>${['empty_host', 'headerless_host'].includes(host) ? '' : '<button aria-label="대화 정보"></button>'}</header><div class="thread-body"><div role="row"><h2>${sender}</h2><p><span>${sender}</span><span> · Instagram</span></p><a href="/${sender}/">프로필 보기</a></div>${host === 'fixture_host' ? `<div><a href="/${sender}/" aria-label="Open the profile page of ${sender}"><img src="${pixel}"></a><div>${text}</div><div><button aria-label="${sender}님의 메시지에 답장하기"></button></div></div>` : incoming}<div><div contenteditable="true" role="textbox" aria-placeholder="메시지 입력..."></div><span aria-hidden="true">메시지 입력...</span></div></div><button onclick="fetch('/send/',{method:'POST'})">전송</button></section><script>document.querySelector('[contenteditable]').onkeydown = ev => {
        if(ev.key!=='Enter') return; ev.preventDefault();
        const row=document.createElement('div'); row.setAttribute('role','row');
        const self=document.createElement('a');self.href='/fixture_user/';self.textContent='fixture_user';row.append(self);
        const body=document.createElement('p');body.textContent=ev.target.innerText;row.append(body);
        ev.target.parentElement.before(row);ev.target.textContent='';
      };document.querySelector('#open').onclick=()=>{${host === 'fallback_host' ? `fetch('/api/v1/direct_v2/create_group_thread/',{method:'POST'}).catch(()=>{})` : `document.querySelector('.pane').hidden=false`}}</script>`,
      });
    });
    app.runner.model.decide = async (_p, _i, c: any, image) => {
      calls++;
      assert.ok(image.length > 100);
      assert.ok(!JSON.stringify(c).includes('PRIVATE'));
      assert.equal(c.observation.elements.length, 0);
      assert.ok(c.observation.text.includes('당첨되셨습니다'));
      return {
        step: {
          action: 'done',
          observationId: c.observation.id,
          reason: 'fixture',
          dmAssessment: {
            kind: 'winner',
            quote: '당첨되셨습니다!',
            eventQuote: c.organizer === 'ambiguous_host' ? '' : c.event.title,
            requested: ['address'],
            deadlineQuote: '',
          },
        },
        inputTokens: 20,
        outputTokens: 5,
      };
    };
    app.store.setSettings('selection', { kind: 'api', model: 'fixture' });
    const page = await ui.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.origin + '/#rewards');
    await page.waitForSelector('[data-dm-check]', { state: 'attached' });
    const res = await page.request.post(app.origin + '/api/outcomes/dm-batch', {
      data: { provider: { kind: 'api', model: 'fixture' }, eventIds: ids },
    });
    assert.equal(res.status(), 403);
    startDmBatch(app.store, { kind: 'api', model: 'fixture' }, 'chromium', ids);
    for (let i = 0; i < ids.length + 1; i++) {
      await app.scheduler.tick();
      await app.runner.finished();
    }
    assert.equal(resultBatch(app.store)?.state, 'completed');
    const all = outcomes(app.store);
    assert.equal(all.find((o) => o.eventId === ids[0])?.status, 'won', JSON.stringify(all));
    assert.equal(all.find((o) => o.eventId === ids[0])?.reportedBy, 'agent');
    assert.equal(all.find((o) => o.eventId === ids[1])?.dmChecks?.[0]?.state, 'review');
    assert.equal(all.find((o) => o.eventId === ids[2])?.dmChecks?.[0]?.state, 'no_evidence');
    assert.equal(all.find((o) => o.eventId === ids[3])?.dmChecks?.[0]?.state, 'unavailable');
    assert.equal(all.find((o) => o.eventId === ids[4])?.status, 'won', JSON.stringify(all));
    assert.equal(all.find((o) => o.eventId === ids[5])?.dmChecks?.[0]?.state, 'unavailable');
    assert.equal(calls, 3);
    assert.equal(threadReads, 2);
    assert.equal(
      app.store
        .jobs()
        .filter((j) => j.dmReadDiagnostics?.some((d) => d.reload && d.stage === 'scoped')).length,
      1,
    );
    assert.equal(writes, 0);
    collectNotices(app.store);
    await page.reload();
    await page.waitForSelector('#dm-reviews [data-dm-review]');
    assert.match(await page.locator('#dm-reviews').innerText(), /행사 연결 확인/);
    const approval = page.waitForResponse((r) => r.url().endsWith('/api/outcomes/dm-review'));
    await page.locator('#dm-reviews [data-confirm=true]').click();
    assert.equal((await approval).status(), 200);
    assert.equal(outcomes(app.store).find((o) => o.eventId === ids[1])?.reportedBy, 'user');
    assert.deepEqual(errors, []);
    assert.equal(writes, 0);
    // Exercise the exact-text send path only after the separate one-shot approval.
    app.store.setSettings('autonomy', {
      profile: { shippingAddress: '테스트 배송지' },
      policy: {},
      revision: 'fixture',
    });
    const preview = dmReplyPreview(app.store, ids[0]!, 'unset');
    assert.ok(preview.approval, preview.reason);
    await sendApprovedDm(app.store, app.browser, ids[0]!, 'unset', preview.approval, preview.text);
    assert.equal(replyAttempt(app.store, ids[0]!)?.status, 'sent');
    assert.equal(outcomes(app.store).find((o) => o.eventId === ids[0])?.followUp?.state, 'replied');
    await assert.rejects(
      sendApprovedDm(app.store, app.browser, ids[0]!, 'unset', preview.approval, preview.text),
    );
  } finally {
    await ui.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
