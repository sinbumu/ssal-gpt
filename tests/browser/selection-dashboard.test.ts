import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server.js';
import { requireConnection, saveConnection } from '../../src/connections.js';
import type { Job } from '../../src/store.js';

test('dashboard filters completed opportunities, pages both lists, persists detailed scope and renders contact provenance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-selection-ui-')),
    app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  const ui = await chromium.launch(),
    page = await ui.newPage({ viewport: { width: 1280, height: 900 } }),
    errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    for (let i = 0; i < 50; i++) {
      const id = 'entry-' + i,
        url = `https://example.org/${id}`,
        now = new Date(Date.now() + i).toISOString();
      const e = app.store.record(
        {
          title: `합성 ${i < 25 ? '완료' : '미완료'} ${i}`,
          organizer: '가상 주최자',
          entryUrl: url,
          deadline: '2099-01-01T00:00:00Z',
          prize: '커피',
          winners: 5,
          requirements: [],
          blockers: [],
          evidenceQuote: '가상 이벤트',
          evidenceKind: 'text',
          effortMinutes: 2,
          announcementNote: i === 0 ? '개별 DM 안내' : undefined,
        },
        url,
        id,
        'fixture.png',
      ).event;
      if (i < 25) {
        const j: Job = {
          id,
          kind: 'apply',
          goal: 'fixture',
          provider: { kind: 'api', model: 'fixture' },
          startUrl: url,
          status: 'running',
          createdAt: now,
          updatedAt: now,
          eventId: e.id,
          maxSteps: 60,
          candidateLimit: 1,
          steps: 0,
          inputTokens: 0,
          outputTokens: 0,
          note: '',
          uncertain: false,
          allowedOrigins: [new URL(url).origin],
          approvedTexts: [],
          history: [],
        };
        app.store.saveJob(j);
        app.store.claimSubmission(e.id, id);
        app.store.complete(j, { quote: '가상 접수 완료', completedAt: now });
      }
    }
    await page.goto(app.origin);
    await page.locator('#events .event-card').first().waitFor();
    assert.equal(await page.locator('#events .event-card').count(), 20);
    assert.ok(!(await page.locator('#events').innerText()).includes('합성 완료'));
    assert.equal(await page.locator('#completed-entries .completed-card').count(), 20);
    await page.locator('#events-more').click();
    assert.equal(await page.locator('#events .event-card').count(), 25);
    await page.locator('#completed-more').click();
    assert.equal(await page.locator('#completed-entries .completed-card').count(), 25);
    assert.match(await page.locator('#completed-entries').innerText(), /예상 연락·발표 경로/);
    assert.match(await page.locator('#completed-entries').innerText(), /연락 경로 미확인/);
    await page.locator('#event-filter').selectOption('completed');
    assert.equal(await page.locator('#events .event-card').count(), 20);
    assert.ok(!(await page.locator('#events').innerText()).includes('합성 미완료'));
    await page.locator('#event-search').fill('합성 완료 0');
    assert.equal(await page.locator('#events .event-card').count(), 1);
    await page.locator('#completed-search').fill('합성 완료 0');
    assert.equal(await page.locator('#completed-entries .completed-card').count(), 1);
    await page.reload();
    await page.locator('#events .event-card').first().waitFor();
    assert.equal(await page.locator('#event-filter').inputValue(), 'unfinished');
    assert.equal(await page.locator('#events .event-card').count(), 20);
    const f = page.locator('#selection-policy-form');
    assert.equal(await f.locator('[name=mode]').inputValue(), 'balanced');
    await f.locator('[name=mode]').selectOption('strict');
    assert.equal(await f.locator('[name=prizeMode]').inputValue(), 'only');
    assert.equal(await f.locator('[name=personalResponses]').inputValue(), 'skip');
    assert.equal(await f.locator('[name=allowedTasks][value=form]').isChecked(), false);
    await f.locator('[name=mode]').selectOption('broad');
    assert.equal(await f.locator('[name=registrations]').inputValue(), 'ask');
    await f.locator('[name=mode]').selectOption('balanced');
    await f.locator('[name=maxMinutes]').fill('15');
    await f.locator('button[type=submit]').click();
    await page.waitForFunction(() =>
      document.querySelector('#toast')?.textContent?.includes('기회 선택 기준을 저장'),
    );
    const saved = app.store.settings<any>('selectionPolicy', {});
    assert.equal(saved.mode, 'balanced');
    assert.equal(saved.maxMinutes, 15);
    assert.equal(saved.prizeMode, 'prefer');
    assert.equal(saved.discoveryTokens, null);
    assert.deepEqual(saved.allowedTasks, ['like', 'follow', 'comment', 'form']);
    await page.reload();
    await f.locator('[name=maxMinutes]').waitFor();
    assert.equal(await f.locator('[name=maxMinutes]').inputValue(), '15');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#selection-policy').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/ssal-selection-mobile.png' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(errors, []);
  } finally {
    await ui.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('batched connection checks preserve waiting form and profile isolation and expose grouped needs without credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-connections-ui-')),
    app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  const ui = await chromium.launch(),
    page = await ui.newPage();
  try {
    await app.browser.navigate(app.origin + '/demo/event');
    const original = app.browser.page!;
    await original.evaluate(() => {
      const el = document.createElement('input');
      el.id = 'preserved';
      el.value = 'waiting';
      document.body.append(el);
    });
    app.browser.ownerJobId = 'waiting-job';
    await app.browser.context!.route('https://www.naver.com/**', (r) =>
      r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<p>private@example.invalid</p><script>setTimeout(() => {
          const link = document.createElement('a');link.href='/logout';link.textContent='로그아웃';
          document.body.append(link);
        }, 200)</script>`,
      }),
    );
    await app.browser.context!.route('https://www.instagram.com/**', (r) =>
      r.fulfill({ contentType: 'text/html; charset=utf-8', body: '<a href="/login">로그인</a>' }),
    );
    requireConnection(
      app.store,
      'https://www.naver.com/',
      'chromium',
      '합성 후보 A의 로그인 필요',
      'a',
    );
    requireConnection(
      app.store,
      'https://form.naver.com/response/a',
      'chromium',
      '합성 후보 B의 로그인 필요',
      'b',
    );
    await page.goto(app.origin);
    await page.locator('#connection-attention h3').waitFor();
    assert.match(
      await page.locator('#connection-attention').innerText(),
      /필요한 연결 · 1개 사이트/,
    );
    await page.locator('#needed-connections-check').click();
    await page.waitForFunction(() => !document.querySelector('#connection-attention h3'));
    assert.equal(app.browser.page, original);
    assert.equal(app.browser.ownerJobId, 'waiting-job');
    assert.equal(await original.locator('#preserved').inputValue(), 'waiting');
    const state = await fetch(app.origin + '/api/state').then((r) => r.json());
    const naver = state.connections.find((c: any) => c.id === 'naver');
    assert.equal(naver.state, 'signed_in_visible');
    assert.ok(naver.checkedAt);
    assert.ok(!JSON.stringify(state.connections).includes('private@example.invalid'));
    const post = (path: string, data: any) =>
      fetch(app.origin + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
        body: JSON.stringify(data),
      });
    await page.locator('[data-check-site=instagram]').click();
    await page.waitForFunction(() =>
      document.querySelector('#site-connections')?.textContent?.includes('로그인 필요'),
    );
    assert.equal(app.browser.page, original);
    app.store.setSettings('siteConnections', [
      ...app.store.settings<any[]>('siteConnections', []),
      {
        siteId: 'naver',
        profile: 'chrome',
        state: 'blocked',
        checkedAt: Date.now(),
        message: 'other profile',
      },
    ]);
    const still = await fetch(app.origin + '/api/state').then((r) => r.json());
    assert.equal(still.connections.find((c: any) => c.id === 'naver').state, 'signed_in_visible');
    assert.equal((await post('/api/connections/check', { ids: [] })).status, 400);
  } finally {
    await ui.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Google search notices stay out of attention and blocked form login offers direct participation without a login loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-google-attention-')),
    app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  const ui = await chromium.launch(),
    page = await ui.newPage();
  try {
    const at = new Date().toISOString();
    const j: Job = {
      id: 'fixture-search',
      kind: 'discover',
      goal: '가상 탐색',
      provider: { kind: 'api', model: 'fixture' },
      status: 'paused',
      createdAt: at,
      updatedAt: at,
      steps: 1,
      maxSteps: 10,
      candidateLimit: 1,
      inputTokens: 0,
      outputTokens: 0,
      note: '가상 출처 소진',
      uncertain: false,
      allowedOrigins: [],
      approvedTexts: [],
      history: [],
    };
    app.store.saveJob(j);
    requireConnection(
      app.store,
      'https://www.google.com/sorry/index',
      'chromium',
      '탐색 인증',
      j.id,
    );
    saveConnection(app.store, 'chromium', {
      service: 'google',
      state: 'blocked',
      message: '가상 로그인 거부',
    });
    await page.goto(app.origin);
    await page.locator('#site-connections .connection-card').first().waitFor();
    assert.equal(await page.locator('#connection-attention h3').count(), 0);
    const google = page
      .locator('#site-connections .connection-card')
      .filter({ hasText: 'Google · Forms' });
    assert.equal(await google.locator('[data-login]').count(), 0);
    assert.match(await google.innerText(), /로그인 상태는 전용 브라우저에 전달되지 않습니다/);
    const form = 'https://docs.google.com/forms/d/fixture/viewform';
    const event = app.store.record(
      {
        title: '가상 Google 폼 이벤트',
        organizer: '가상 주최자',
        entryUrl: form,
        deadline: '2099-01-01T00:00:00Z',
        prize: '커피',
        winners: 5,
        requirements: ['로그인'],
        blockers: [],
        evidenceQuote: '로그인 필요',
        evidenceKind: 'text',
        effortMinutes: 2,
      },
      form,
      j.id,
      'fixture.png',
    ).event;
    requireConnection(app.store, form, 'chromium', '폼 응답에 로그인 필요', j.id, event.id);
    await page.reload();
    await page.locator('#connection-attention h3').waitFor();
    assert.match(await page.locator('#connection-attention').innerText(), /가상 Google 폼 이벤트/);
    assert.equal(await page.locator('#connection-attention [data-login]').count(), 0);
    let external = '';
    await page.route('**/api/browser/external', async (route) => {
      external = route.request().postDataJSON().url;
      await route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    });
    const response = page.waitForResponse('**/api/browser/external');
    await page.locator('#connection-attention [data-external]').click();
    await response;
    assert.equal(external, form);
    assert.equal(app.store.job(j.id)!.status, 'paused');
    assert.equal(app.store.completedEntries().length, 0);
  } finally {
    await ui.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
