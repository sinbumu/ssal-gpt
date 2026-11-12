import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings } from '../../src/autonomy.js';
import { captureReceipt } from '../../src/receipt.js';
import { researchQuestion } from '../../src/research.js';
import type { Job } from '../../src/store.js';
import type { Model } from '../../src/model.js';
import { ConsentPolicySchema } from '../../src/consent.js';

function prepare(app: Awaited<ReturnType<typeof createApp>>, suffix = '') {
  const event = app.store.record(
    {
      title: '새 공개 퀴즈' + suffix,
      organizer: '가상 주최자',
      entryUrl: app.origin + '/demo/fixture' + (suffix ? `?case=${suffix}` : ''),
      prize: '테스트 커피',
      winners: 10,
      deadline: '2099-12-31T00:00:00+09:00',
      requirements: ['퀴즈'],
      blockers: [],
      evidenceQuote: '퀴즈',
      evidenceKind: 'text',
      effortMinutes: 2,
    },
    app.origin + '/demo/source',
    'discovery',
    'source.png',
  ).event;
  const id = randomUUID();
  const job: Job = {
    id,
    kind: 'apply',
    provider: { kind: 'api', model: 'synthetic-test-driver' },
    goal: 'test',
    startUrl: event.entryUrl,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    eventId: event.id,
    candidateLimit: 1,
    maxSteps: 30,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    note: '',
    uncertain: false,
    allowedOrigins: [app.origin],
    approvedTexts: [],
    history: [],
    autonomy: createAutonomy(syntheticSettings, app.origin, true),
  };
  // This is a fixture of a real apply route, not the built-in synthetic receipt table.
  job.autonomy!.synthetic = false;
  job.autonomy!.policy = { ...job.autonomy!.policy, finalSubmit: 'review' };
  app.store.setSettings('autonomy', syntheticSettings);
  app.store.claimSubmission(event.id, id);
  app.store.saveJob(job);
  return job;
}

test('source facts, profile and route leave only consent and final review; completed entries are separate from logs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-continuity-'));
  const app = await createApp({ dir, port: 0, headless: true });
  const ui = await chromium.launch({ headless: true });
  try {
    const job = prepare(app);
    job.autonomy!.entryChannel = '인스타그램';
    job.autonomy!.evidence = [
      {
        id: 'original',
        url: 'https://example.org/official',
        title: '공식 정답 근거',
        text: '공식 자료: 정답은 3입니다.',
        screenshot: 'source.png',
        observedAt: Date.now(),
      },
    ];
    app.store.saveJob(job);
    let posts = 0,
      semantic = 0;
    await app.browser.open();
    await app.browser.page!.route('**/demo/fixture', (route) => {
      if (route.request().method() === 'POST') {
        posts++;
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '<h1>응답을 안전하게 저장했어요.</h1>',
        });
      }
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<form method="post"><label>이름<input name="n" required></label>
      <label>퀴즈 정답<input name="q" required></label>
      <fieldset><legend>이 이벤트를 알게 된 경로</legend><label><input required type="radio" name="r" value="ig">인스타그램</label><label><input type="radio" name="r" value="fb">페이스북</label></fieldset>
      <fieldset><legend>개인정보 수집 동의</legend><p>경품 제공에 사용하고 한 달 뒤 폐기합니다.</p><label><input required type="checkbox" name="c">동의합니다</label></fieldset><button type="submit">제출</button></form>`,
      });
    });
    app.runner.model.decide = async (_p, _i, raw: any) => {
      const o = raw.observation;
      if (raw.purpose === 'verify_receipt') {
        semantic++;
        return {
          step: {
            action: 'done',
            observationId: o.id,
            reason: '명시적 접수 확인',
            receiptKind: 'accepted',
            evidenceQuote: '응답을 안전하게 저장했어요.',
          },
          inputTokens: 0,
          outputTokens: 0,
        };
      }
      if (o.text.includes('저장했어요'))
        return {
          step: {
            action: 'done',
            observationId: o.id,
            reason: '접수 확인',
            evidenceQuote: '응답을 안전하게 저장했어요.',
          },
          inputTokens: 0,
          outputTokens: 0,
        };
      return {
        step: {
          action: 'form_plan',
          observationId: o.id,
          reason: '근거로 준비',
          buttonId: raw.form.buttons[0].id,
          answers: raw.form.questions.map((q: any) => ({
            questionId: q.id,
            category: q.label.includes('정답')
              ? 'knowledge'
              : q.label.includes('동의')
                ? 'consent'
                : 'fact',
            source: q.label.includes('정답') ? 'evidence' : 'unknown',
            sourceId: 'original',
            evidenceQuote: '정답은 3입니다.',
            answer: q.label.includes('정답') ? ['3'] : [],
            reason: '관측 근거',
          })),
        },
        inputTokens: 0,
        outputTokens: 0,
      };
    };
    app.runner.start(job.id);
    await app.runner.finished();
    assert.equal(
      app.store.job(job.id)!.autonomy!.inbox!.items.length,
      1,
      JSON.stringify(app.store.job(job.id)!.autonomy!.inbox!.items),
    );
    const page = await ui.newPage();
    await page.goto(app.origin);
    await page.waitForSelector('[data-inbox]');
    assert.equal(await page.locator('#active-jobs [data-question]').count(), 1);
    await page.getByLabel('동의합니다', { exact: true }).check();
    await page.getByRole('button', { name: '한 번에 답변하고 재개' }).click();
    await page.getByRole('button', { name: '최종 제출하고 결과 확인' }).waitFor();
    assert.equal(await page.locator('.review-answer').count(), 4);
    assert.ok((await page.locator('.submission-review').innerText()).includes('테스트 참가자'));
    assert.ok(!(await page.locator('.submission-review').innerText()).includes('페이스북'));
    assert.equal(await page.locator('.review-raw pre').isVisible(), false);
    await page.getByRole('button', { name: '최종 제출하고 결과 확인' }).click();
    await page.waitForFunction(
      () => document.querySelector('#completed-count')?.textContent === '1',
    );
    assert.equal(posts, 1);
    assert.equal(semantic, 1);
    assert.equal(app.store.job(job.id)!.status, 'completed');
    assert.equal(await page.locator('#active-jobs [data-inbox]').count(), 0);
    assert.ok((await page.locator('#completed-entries').innerText()).includes('새 공개 퀴즈'));
    await page.locator('#completed-search').fill('없는 경품');
    assert.ok(
      (await page.locator('#completed-entries').innerText()).includes('검색 결과가 없습니다'),
    );
    await page.locator('#completed-search').fill('커피');
    assert.equal(await page.locator('.completed-card').count(), 1);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  } finally {
    await ui.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manual reconciliation keeps the paused job visible and resumes its live page without replaying navigation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-reconcile-ui-'));
  const app = await createApp({ dir, port: 0, headless: true });
  const ui = await chromium.launch({ headless: true });
  try {
    const job = prepare(app);
    let gets = 0;
    let posts = 0;
    await app.browser.open();
    await app.browser.page!.route(job.startUrl, (route) => {
      if (route.request().method() === 'POST') posts++;
      else gets++;
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<p>2 / 2 페이지</p><form method="post"><fieldset><legend>개인정보 수집 동의</legend><label><input type="checkbox" name="c" required>동의합니다</label></fieldset><button>제출</button></form>',
      });
    });
    await app.browser.navigate(job.startUrl);
    app.browser.ownerJobId = job.id;
    job.currentUrl = job.startUrl;
    job.status = 'submission_unknown';
    job.uncertain = true;
    job.intent = {
      url: job.startUrl,
      beforeText: '첫 문항\n다음',
      kind: 'submission',
      at: Date.now(),
    };
    app.store.saveJob(job);
    app.runner.model.decide = async (_p, _i, raw: any) => ({
      step: {
        action: 'form_plan',
        observationId: raw.observation.id,
        reason: '현재 문항 확인',
        buttonId: raw.form.buttons[0].id,
        answers: raw.form.questions.map((q: any) => ({
          questionId: q.id,
          category: 'consent',
          source: 'unknown',
          answer: [],
          reason: '본인 동의 필요',
        })),
      },
      inputTokens: 0,
      outputTokens: 0,
    });
    const page = await ui.newPage();
    await page.goto(app.origin);
    const card = page.locator(`#active-jobs #job-${job.id}`);
    page.on('dialog', (dialog) => void dialog.accept());
    await card.getByRole('button', { name: '미제출 직접 확인', exact: true }).click();
    await card.getByText('정상 중단', { exact: true }).waitFor();
    assert.equal(await page.locator(`#jobs #job-${job.id}`).count(), 0);
    assert.equal(await page.locator('#pending-count').innerText(), '1');
    assert.equal(app.store.job(job.id)!.uncertain, false);
    await card.getByRole('button', { name: '현재 브라우저 화면에서 재개', exact: true }).click();
    await card.locator('[data-inbox]').waitFor();
    assert.equal(app.store.job(job.id)!.status, 'needs_user');
    assert.equal(gets, 1, 'resume must preserve the live page');
    assert.equal(posts, 0, 'reconciliation must not transmit answers or consent');
    assert.equal(app.store.completedEntries().length, 0);
  } finally {
    await ui.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('consent modes gate real browser input, preserve missing facts and keep final review independent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-consent-modes-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    for (const mode of ['manual', 'routine', 'adaptive'] as const) {
      const job = prepare(app, mode);
      job.autonomy!.organizer = '가상 주최자';
      job.autonomy!.policy.consent = ConsentPolicySchema.parse({ mode });
      app.store.saveJob(job);
      let posts = 0;
      await app.browser.selectJob(job.id);
      await app.browser.page!.unrouteAll();
      await app.browser.page!.route(job.startUrl, (r) => {
        if (r.request().method() === 'POST') {
          posts++;
          return r.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: '<h1>답변이 제출되었습니다.</h1>',
          });
        }
        return r.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<form method="post"><label>이름<input name="n" required></label>${mode === 'adaptive' ? '<label>닉네임<input name="nick" required></label>' : ''}<fieldset><legend>개인정보 수집 및 이용 동의</legend><p>수집 항목: ${mode === 'adaptive' ? '이름, 닉네임' : '이름'}<br>수집 및 이용 목적: 이벤트 참여자 확인 및 경품 발송<br>보관 기간: 1개월</p><label><input type="radio" name="c" value="yes" required>동의합니다</label><label><input type="radio" name="c" value="no">동의하지 않습니다</label></fieldset><button>제출</button></form>`,
        });
      });
      app.runner.model.decide = async (_p, _i, raw: any, image) => {
        assert.ok(image.length > 1000);
        return {
          step: raw.observation.text.includes('답변이 제출되었습니다.')
            ? {
                action: 'done',
                observationId: raw.observation.id,
                reason: '완료',
                evidenceQuote: '답변이 제출되었습니다.',
              }
            : {
                action: 'form_plan',
                observationId: raw.observation.id,
                reason: '동의 정책에 따른 계획',
                buttonId: raw.form.buttons[0].id,
                answers: raw.form.questions.map((q: any) => ({
                  questionId: q.id,
                  category: q.label.includes('동의') ? 'consent' : 'fact',
                  source: 'unknown',
                  reason: '모델은 정보나 권한을 만들지 않음',
                  ...(q.label.includes('동의')
                    ? {
                        consentAssessment: {
                          risk: 'low',
                          noticeQuote: q.description,
                          reason: '원문의 항목·목적·기간이 허용 범위에 해당',
                        },
                      }
                    : {}),
                })),
              },
          inputTokens: 0,
          outputTokens: 0,
        };
      };
      const postInbox = async (data: unknown) => {
        const state = await fetch(app.origin + '/api/state').then((r) => r.json());
        const response = await fetch(app.origin + `/api/jobs/${job.id}/inbox`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
          body: JSON.stringify(data),
        });
        assert.equal(response.status, 200, await response.text());
        await app.runner.finished();
      };
      app.runner.start(job.id);
      await app.runner.finished();
      let current = app.store.job(job.id)!;
      assert.equal(posts, 0);
      if (mode !== 'routine') {
        const inbox = current.autonomy!.inbox!;
        assert.equal(inbox.items.length, 1, current.note);
        const q = inbox.items[0]!;
        assert.equal(q.category, mode === 'manual' ? 'consent' : 'fact');
        assert.equal(
          await app.browser.page!.locator('[name=n]').inputValue(),
          '',
          'unknown facts or consent block the batch',
        );
        await postInbox({
          inboxId: inbox.id,
          answers: {
            [q.id]:
              mode === 'manual'
                ? [q.options.find((o) => o.label === '동의합니다')!.id]
                : ['가상별명'],
          },
        });
      }
      current = app.store.job(job.id)!;
      assert.equal(current.autonomy!.inbox!.final, true, current.note);
      assert.equal(posts, 0, 'auto consent never bypasses final review');
      assert.equal(current.autonomy!.consents!.at(-1)!.decision, 'accept');
      assert.ok(current.autonomy!.consents!.at(-1)!.appliedAt);
      await postInbox({ inboxId: current.autonomy!.inbox!.id, confirm: true });
      assert.equal(posts, 1);
      assert.equal(app.store.job(job.id)!.status, 'completed');
      const entry = app.store.completedEntries().find((e) => e.jobId === job.id)!;
      assert.equal(entry.consents.length, 1);
      assert.equal(entry.consents[0]!.actor, mode === 'manual' ? 'user' : 'policy');
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('optional refusal and required skip never accidentally transmit an out-of-scope consent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-consent-denial-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    for (const required of [false, true]) {
      const job = prepare(app, required ? 'blocked' : 'optional');
      job.autonomy!.organizer = '가상 주최자';
      job.autonomy!.policy.consent = ConsentPolicySchema.parse({
        mode: 'routine',
        blockedRequired: 'skip',
      });
      app.store.saveJob(job);
      let posts = 0;
      await app.browser.selectJob(job.id);
      await app.browser.page!.unrouteAll();
      await app.browser.page!.route(job.startUrl, (r) => {
        if (r.request().method() === 'POST') posts++;
        return r.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<form method="post"><label>이름<input name="n" required></label><fieldset><legend>${required ? '필수' : '선택'} 마케팅 동의</legend><label><input name="m" type="checkbox" ${required ? 'required' : ''}>동의합니다</label></fieldset><button>제출</button></form>`,
        });
      });
      app.runner.model.decide = async (_p, _i, raw: any) => ({
        step: {
          action: 'form_plan',
          observationId: raw.observation.id,
          reason: '합성',
          buttonId: raw.form.buttons[0].id,
          answers: raw.form.questions.map((q: any) => ({
            questionId: q.id,
            category: q.label.includes('동의') ? 'consent' : 'fact',
            source: 'unknown',
            reason: '합성',
          })),
        },
        inputTokens: 0,
        outputTokens: 0,
      });
      app.runner.start(job.id);
      await app.runner.finished();
      const current = app.store.job(job.id)!;
      assert.equal(posts, 0);
      assert.equal(await app.browser.page!.locator('[name=m]').isChecked(), false);
      assert.equal(current.status, required ? 'stopped' : 'needs_user', current.note);
      if (required) {
        assert.equal(await app.browser.page!.locator('[name=n]').inputValue(), '');
        assert.equal(app.store.submission(job.eventId!)!.state, 'skipped_consent');
      } else {
        assert.equal(current.autonomy!.inbox!.final, true);
        assert.equal(current.autonomy!.consents![0]!.decision, 'decline');
        const fresh = { ...syntheticSettings, revision: 'changed-consent-grant' };
        app.store.setSettings('autonomy', fresh);
        current.autonomy!.inbox = undefined;
        current.autonomy!.plan = undefined;
        app.store.saveJob(current);
        app.runner.start(job.id);
        await app.runner.finished();
        assert.match(app.store.job(job.id)!.note, /delegation|위임/);
        assert.equal(posts, 0);
      }
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('consent settings migrate to manual and round-trip all three levels through the dashboard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-consent-settings-'));
  const app = await createApp({ dir, port: 0, headless: true });
  const ui = await chromium.launch({ headless: true });
  try {
    const { consent: _old, ...oldPolicy } = syntheticSettings.policy;
    app.store.setSettings('autonomy', {
      ...syntheticSettings,
      policy: { ...oldPolicy, finalSubmit: 'review' },
    });
    const page = await ui.newPage();
    await page.goto(app.origin);
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLInputElement>('[name=consentMode]:checked')?.value === 'manual',
    );
    assert.equal(await page.locator('#consent-auto-controls').isVisible(), false);
    for (const mode of ['routine', 'adaptive', 'manual']) {
      await page.locator(`[name=consentMode][value=${mode}]`).check();
      if (mode !== 'manual') {
        await page.locator('[name=consentRetention]').fill('62');
        await page.locator('[name=consentRecipients]').fill('추가 기관');
        await page.locator('[name=consentThirdParty]').check();
      }
      assert.equal(
        await page.locator('#consent-adaptive-controls').isVisible(),
        mode === 'adaptive',
      );
      await page.getByRole('button', { name: '정보·정책 저장', exact: true }).click();
      await page.waitForFunction(
        (mode) => document.querySelector('#toast')?.textContent?.includes('저장했습니다'),
        mode,
      );
      const saved = await fetch(app.origin + '/api/autonomy').then((r) => r.json());
      assert.equal(saved.policy.consent.mode, mode);
      assert.equal(saved.policy.consent.maxRetentionDays, 62);
      assert.equal(saved.policy.finalSubmit, 'review');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[name=consentMode][value=adaptive]').check();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  } finally {
    await ui.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archiving an unknown outcome preserves its claim and evidence and blocks stale resume requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-hold-'));
  const app = await createApp({ dir, port: 0, headless: true });
  const ui = await chromium.launch({ headless: true });
  try {
    const job = prepare(app);
    job.status = 'submission_unknown';
    job.uncertain = true;
    job.holdNote = '추가 문항으로 이동했으나 화면을 잃어 접수를 확인하지 못했습니다.';
    app.store.saveJob(job);
    app.store.markSubmission(job.eventId!, 'unknown');
    const page = await ui.newPage();
    await page.goto(app.origin);
    await page
      .locator(`#active-jobs #job-${job.id}`)
      .getByRole('button', { name: '미확인 상태로 보관', exact: true })
      .click();
    await page.waitForFunction((id) => !document.querySelector(`#active-jobs #job-${id}`), job.id);
    const archived = app.store.job(job.id)!;
    assert.ok(archived.archivedAt);
    assert.equal(archived.uncertain, true);
    assert.equal(archived.status, 'submission_unknown');
    assert.equal(app.store.claimSubmission(job.eventId!, 'another'), false);
    assert.equal(app.store.completedEntries().length, 0);
    const state = await fetch(app.origin + '/api/state').then((r) => r.json());
    const stale = await fetch(app.origin + `/api/jobs/${job.id}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
      body: '{}',
    });
    assert.notEqual(stale.status, 200);
    await page.getByText('지난 실행 내역 펼치기', { exact: true }).click();
    await page
      .locator(`#jobs #job-${job.id}`)
      .getByRole('button', { name: '진행 목록으로 복원', exact: true })
      .click();
    await page.locator(`#active-jobs #job-${job.id}`).waitFor();
    assert.equal(app.store.job(job.id)!.archivedAt, undefined);
    assert.equal(app.store.job(job.id)!.uncertain, true);
    assert.equal(app.runner.isBusy(), false);
  } finally {
    await ui.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saved receipt survives restart and verifies without opening a browser or resubmitting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-proof-'));
  let app = await createApp({ dir, port: 0, headless: true });
  try {
    const job = prepare(app);
    await app.browser.navigate(job.startUrl);
    await app.browser.page!.setContent('<h1>답변이 제출되었습니다.</h1>');
    job.uncertain = true;
    job.status = 'submission_unknown';
    job.intent = {
      kind: 'submission',
      url: job.startUrl,
      beforeText: '질문과 제출 버튼',
      at: Date.now() - 1000,
    };
    captureReceipt(job, await app.browser.observe());
    app.store.saveJob(job);
    await app.close();
    app = await createApp({ dir, port: 0, headless: true });
    const state = await fetch(app.origin + '/api/state').then((r) => r.json());
    const response = await fetch(app.origin + `/api/jobs/${job.id}/verify-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).verified, true);
    assert.equal(app.browser.info().open, false);
    assert.equal(app.store.completedEntries().length, 1);
    assert.equal(app.store.claimSubmission(job.eventId!, 'duplicate'), false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('public research restores the original form and rejects a proposed write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-research-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const job = prepare(app);
    await app.browser.navigate(job.startUrl);
    await app.browser.page!.setContent('<label>작성 중<input value="keep"></label>');
    const original = app.browser.page!;
    app.browser.ownerJobId = job.id;
    await app.browser.context!.route('https://search.naver.com/**', (r) =>
      r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<p>검색 결과</p><form><button>게시</button></form>',
      }),
    );
    const model = {
      async decide(_p: unknown, _i: string, ctx: any) {
        return {
          step: {
            action: 'click',
            observationId: ctx.observation.id,
            reason: 'untrusted write',
            ref: ctx.observation.elements[0]?.ref,
          },
          inputTokens: 0,
          outputTokens: 0,
        };
      },
    } as unknown as Model;
    await researchQuestion(
      app.store,
      app.browser,
      model,
      job,
      '공개 정답',
      new AbortController().signal,
    );
    assert.equal(app.browser.page, original);
    assert.equal(app.browser.ownerJobId, job.id);
    assert.equal(await original.locator('input').inputValue(), 'keep');
    assert.equal(app.browser.context!.pages().length, 1);
    assert.equal(job.autonomy!.evidence!.length, 1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('public research records an unobserved URL rejection and recovers without visiting it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-research-recovery-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const job = prepare(app);
    await app.browser.navigate(job.startUrl);
    const original = app.browser.page!;
    const source = 'https://example.org/observed-source';
    let forbiddenVisits = 0;
    await app.browser.context!.route('https://example.org/unobserved', (r) => {
      forbiddenVisits++;
      return r.fulfill({ body: 'Must never visit' });
    });
    await app.browser.context!.route('https://search.naver.com/**', (r) =>
      r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<p>공개 검색 결과에서 찾은 공식 기관 자료입니다. 아래 링크로 원문을 확인할 수 있습니다.</p><a href="${source}">공식 자료</a>`,
      }),
    );
    await app.browser.context!.route(source, (r) =>
      r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<p>공식 기관의 원문 자료이며 공개 퀴즈의 정답은 가상자료입니다. 이 내용은 테스트용입니다.</p>',
      }),
    );
    let calls = 0;
    const model = {
      async decide(_p: unknown, _i: string, ctx: any) {
        calls++;
        if (calls === 2)
          assert.ok(
            ctx.history.some(
              (h: any) => h.action === 'research_rejected' && h.reason.startsWith('unobserved_url'),
            ),
          );
        return {
          step: {
            action: calls < 3 ? 'navigate' : 'done',
            observationId: ctx.observation.id,
            reason: '공식 원문 읽기',
            url: calls === 1 ? 'https://example.org/unobserved' : source,
          },
          inputTokens: 0,
          outputTokens: 0,
        };
      },
    } as unknown as Model;
    await researchQuestion(
      app.store,
      app.browser,
      model,
      job,
      '공개 퀴즈',
      new AbortController().signal,
    );
    assert.equal(calls, 3);
    assert.equal(forbiddenVisits, 0);
    assert.equal(app.browser.page, original);
    assert.ok(job.autonomy!.evidence!.some((e) => e.url === source && e.text.includes('가상자료')));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery automatically starts exactly one observed form and waits at the dashboard final review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-chain-browser-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const config = {
      ...syntheticSettings,
      policy: { ...syntheticSettings.policy, finalSubmit: 'review' as const },
    };
    app.store.setSettings('autonomy', config);
    const source = prepare(app); // Reuse the fixture shape, then create a distinct discovery.
    app.store.setSettings('autonomy', config);
    const parent = {
      ...source,
      id: randomUUID(),
      kind: 'discover' as const,
      eventId: undefined,
      autonomy: undefined,
      prepareOne: { revision: config.revision, expires: Date.now() + 60000 },
      startUrl: app.origin + '/demo/source',
    };
    app.store.saveJob(parent);
    const formUrl = 'https://form.naver.com/response/synthetic-fixture';
    await app.browser.open();
    await app.browser.page!.route('**/demo/source', (r) =>
      r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<a href="${formUrl}">공식 참여 폼</a>`,
      }),
    );
    let posts = 0;
    await app.browser.context!.route(formUrl, (r) => {
      if (r.request().method() === 'POST') posts++;
      return r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<h1>공식 새 이벤트</h1><p>1 / 2 페이지</p><button type="button">다음</button><script>document.querySelector('button').onclick=()=>{document.body.innerHTML='<p>2 / 2 페이지</p><form><label>이름<input required name="name"></label><button type="submit">제출</button></form>'}</script>`,
      });
    });
    app.runner.model.decide = async (_p, _i, ctx: any) => {
      const o = ctx.observation;
      const base = { observationId: o.id, reason: 'fixture' };
      if (ctx.mode === 'discover')
        return {
          step:
            o.url === formUrl
              ? {
                  ...base,
                  action: 'record_event',
                  candidate: {
                    title: '자동 선택 시험',
                    organizer: 'fixture',
                    entryUrl: formUrl,
                    deadline: '2099-01-01T00:00:00Z',
                    prize: '커피',
                    winners: 10,
                    requirements: ['이름 입력'],
                    blockers: [],
                    evidenceQuote: '공식 새 이벤트',
                    evidenceKind: 'text',
                    effortMinutes: 1,
                  },
                }
              : { ...base, action: 'navigate', url: formUrl },
          inputTokens: 0,
          outputTokens: 0,
        };
      return {
        step: {
          ...base,
          action: 'form_plan',
          answers: ctx.form.questions.map((q: any) => ({
            questionId: q.id,
            category: 'fact',
            source: 'profile',
            reason: 'profile',
          })),
          buttonId: ctx.form.buttons[0].id,
        },
        inputTokens: 0,
        outputTokens: 0,
      };
    };
    app.runner.start(parent.id);
    await app.runner.finished();
    const childId = app.store.job(parent.id)!.prepareOne!.childId!;
    assert.ok(childId);
    assert.equal(app.store.job(childId)!.autonomy!.inbox!.final, true);
    assert.equal(app.store.job(childId)!.status, 'needs_user');
    assert.equal(app.store.job(childId)!.autonomy!.introAdvances, 1);
    assert.equal(posts, 0);
    assert.equal(app.store.jobs().filter((j) => j.parentId === parent.id).length, 1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('public research opens a visible embedded article before asking the model for its source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-research-frame-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const job = prepare(app);
    await app.browser.navigate(job.startUrl);
    const original = app.browser.page!;
    app.browser.ownerJobId = job.id;
    const source = 'https://example.org/public-source';
    await app.browser.context!.route('https://search.naver.com/**', (r) =>
      r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<iframe src="${source}" style="width:1200px;height:800px"></iframe>`,
      }),
    );
    await app.browser.context!.route(source, (r) =>
      r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<p>이것은 공식 기관의 공개 자료입니다. 현재 인정기관은 모두 12곳이며 원문에서 이 내용을 확인할 수 있습니다.</p>',
      }),
    );
    let calls = 0;
    const model = {
      async decide(_p: unknown, _i: string, ctx: any) {
        calls++;
        assert.equal(ctx.observation.url, source);
        assert.ok(ctx.observation.text.includes('12곳'));
        return {
          step: { action: 'done', observationId: ctx.observation.id, reason: '공식 원문 확인' },
          inputTokens: 0,
          outputTokens: 0,
        };
      },
    } as unknown as Model;
    await researchQuestion(
      app.store,
      app.browser,
      model,
      job,
      '공개 기관',
      new AbortController().signal,
    );
    assert.equal(calls, 1);
    assert.equal(app.browser.page, original);
    assert.ok(job.autonomy!.evidence!.some((e) => e.url === source));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dashboard can retry only unresolved public knowledge without approving consent or repeating submissions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-research-retry-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const job = prepare(app);
    const knowledge = {
      id: 'knowledge',
      signature: 'knowledge',
      label: '공식 기관 수는?',
      kind: 'radio' as const,
      required: true,
      multiple: false,
      options: [{ id: '12', label: '12' }],
      category: 'knowledge' as const,
      reason: 'answer_required',
    };
    job.status = 'needs_user';
    job.autonomy!.researched = ['knowledge'];
    job.autonomy!.inbox = {
      id: randomUUID(),
      fingerprint: 'fixture',
      createdAt: Date.now(),
      items: [knowledge],
    };
    app.store.saveJob(job);
    app.runner.model.decide = async (_p, _i, ctx: any) => ({
      step: { action: 'needs_user', observationId: ctx.observation.id, reason: 'fixture stop' },
      inputTokens: 0,
      outputTokens: 0,
    });
    const state = await fetch(app.origin + '/api/state').then((r) => r.json());
    const response = await fetch(app.origin + `/api/jobs/${job.id}/retry-research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
      body: '{}',
    });
    assert.equal(response.status, 200);
    await app.runner.finished();
    const saved = app.store.job(job.id)!;
    assert.equal(saved.autonomy!.researchRetries, 1);
    assert.deepEqual(saved.autonomy!.overrides, {});
    assert.equal(saved.autonomy!.metrics.fields, 0);
    assert.equal(saved.uncertain, false);
    const second = await fetch(app.origin + `/api/jobs/${job.id}/retry-research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
      body: '{}',
    });
    assert.notEqual(second.status, 200);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Naver numbered pages advance automatically but consent and final submission still require dashboard input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-numbered-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const job = prepare(app);
    const url = 'https://form.naver.com/response/synthetic';
    job.startUrl = url;
    job.allowedOrigins = ['https://form.naver.com'];
    job.autonomy!.origin = 'https://form.naver.com';
    app.store.saveJob(job);
    let posts = 0;
    await app.browser.open();
    await app.browser.page!.route(url, (r) => {
      if (r.request().method() === 'POST') posts++;
      const heading = `<div>설문 진행 상태</div><div>${posts + 1}/2</div>`;
      const body =
        posts === 0
          ? `${heading}<form method="post"><label>이름<input name="n" required></label><button>다음</button></form>`
          : posts === 1
            ? `${heading}<form method="post"><fieldset><legend>개인정보 수집 동의</legend><label><input type="checkbox" name="c" required>동의합니다</label></fieldset><button>제출</button></form>`
            : '<h1>답변이 제출되었습니다.</h1>';
      return r.fulfill({ contentType: 'text/html; charset=utf-8', body });
    });
    app.runner.model.decide = async (_p, _i, raw: any, image) => {
      assert.ok(image.length > 1000);
      const o = raw.observation;
      return {
        step: o.text.includes('답변이 제출되었습니다.')
          ? {
              action: 'done',
              observationId: o.id,
              reason: '접수 확인',
              evidenceQuote: '답변이 제출되었습니다.',
            }
          : {
              action: 'form_plan',
              observationId: o.id,
              reason: '합성 문항 계획',
              buttonId: raw.form.buttons[0].id,
              answers: raw.form.questions.map((q: any) => ({
                questionId: q.id,
                category: q.label.includes('동의') ? 'consent' : 'fact',
                source: 'unknown',
                answer: [],
                reason: '로컬 프로필 또는 사용자 동의',
              })),
            },
        inputTokens: 0,
        outputTokens: 0,
      };
    };
    app.runner.start(job.id);
    await app.runner.finished();
    let current = app.store.job(job.id)!;
    assert.equal(posts, 1, current.note);
    assert.equal(current.uncertain, false);
    assert.equal(current.autonomy!.inbox!.items.length, 1);
    assert.equal(current.autonomy!.inbox!.final, undefined);
    assert.equal(app.store.completedEntries().length, 0);
    const post = async (data: unknown) => {
      const state = await fetch(app.origin + '/api/state').then((r) => r.json());
      const result = await fetch(app.origin + `/api/jobs/${job.id}/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
        body: JSON.stringify(data),
      });
      assert.equal(result.status, 200, await result.text());
      await app.runner.finished();
    };
    const inbox = current.autonomy!.inbox!;
    const consent = inbox.items[0]!;
    await post({ inboxId: inbox.id, answers: { [consent.id]: [consent.options[0]!.id] } });
    current = app.store.job(job.id)!;
    assert.equal(posts, 1, 'consent alone cannot submit the final page');
    assert.equal(current.autonomy!.inbox!.final, true);
    await post({ inboxId: current.autonomy!.inbox!.id, confirm: true });
    assert.equal(posts, 2);
    assert.equal(app.store.job(job.id)!.status, 'completed');
    assert.equal(app.store.completedEntries().length, 1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('counterless Next recovery verifies the live new page without replaying an external action', async () => {
  const { inspectForm } = await import('../../src/forms.js');
  const { verifyFormContinuation } = await import('../../src/form-progress.js');
  const dir = mkdtempSync(join(tmpdir(), 'ssal-progress-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const job = prepare(app);
    const url = 'https://answer.moaform.com/answers/synthetic';
    await app.browser.open();
    let requests = 0;
    await app.browser.page!.route(url, (r) => {
      requests++;
      return r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<title>고정 행사</title><form><input type="hidden" id="pid" value="two"><input type="hidden" id="pnumber" value="2"><label>새 필수 문항<input required></label><button id="js-prev" type="button">이전</button><button>다음</button></form>',
      });
    });
    await app.browser.navigate(url);
    app.browser.ownerJobId = job.id;
    job.uncertain = true;
    job.intent = {
      url,
      beforeText: '이름\n다음',
      controlLabel: '다음',
      pageMarker: { id: 'one', number: 1 },
      kind: 'submission',
      at: Date.now(),
    };
    app.store.saveJob(job);
    const o = await app.browser.observe(true);
    const { view } = await inspectForm(app.browser.page!);
    const model = {
      async decide(_p: unknown, _i: string, ctx: any) {
        assert.equal(ctx.purpose, 'verify_form_continuation');
        return {
          step: {
            action: 'done',
            observationId: ctx.observation.id,
            evidenceQuote: '새 필수 문항',
            reason: 'new stage',
          },
          inputTokens: 0,
          outputTokens: 0,
        };
      },
    } as unknown as Model;
    assert.equal(
      await verifyFormContinuation(
        app.store,
        app.browser,
        model,
        job,
        o,
        view,
        new AbortController().signal,
      ),
      true,
    );
    assert.equal(requests, 1);
    assert.equal(job.uncertain, false);
    assert.equal(job.continuations!.length, 1);
    assert.equal(app.store.submission(job.eventId!)!.state, 'in_progress');
    assert.equal(app.store.completedEntries().length, 0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
