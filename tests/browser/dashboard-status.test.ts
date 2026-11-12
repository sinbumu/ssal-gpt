import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../../src/server.js';
import { createAutonomy, syntheticSettings } from '../../src/autonomy.js';
import type { Job } from '../../src/store.js';

type App = Awaited<ReturnType<typeof createApp>>;
function waitingJob(app: App, status: Job['status'] = 'needs_user') {
  const id = randomUUID(),
    now = new Date().toISOString();
  const job: Job = {
    id,
    kind: 'autonomy_demo',
    goal: 'synthetic status fixture',
    provider: { kind: 'api', model: 'fixture' },
    startUrl: app.origin + '/demo/event',
    status,
    createdAt: now,
    updatedAt: now,
    maxSteps: 30,
    candidateLimit: 1,
    steps: 6,
    inputTokens: 0,
    outputTokens: 0,
    uncertain: status === 'submission_unknown',
    allowedOrigins: [app.origin],
    approvedTexts: [],
    history: [],
    note: '브라우저를 직접 조작할 수 있습니다. 재개 시 새 화면부터 확인합니다.',
    autonomy: createAutonomy(syntheticSettings, app.origin, true),
  };
  job.autonomy!.inbox = {
    id: randomUUID(),
    fingerprint: 'fixture',
    createdAt: Date.now(),
    items: [
      {
        id: 'consent',
        signature: 'consent',
        label: '개인정보 동의',
        kind: 'radio',
        required: true,
        multiple: false,
        category: 'consent',
        reason: '수신자 확인 필요',
        options: [
          { id: 'yes', label: '동의합니다' },
          { id: 'no', label: '동의하지 않습니다' },
        ],
      },
    ],
  };
  job.autonomy!.consents = [
    {
      signature: 'consent',
      question: '개인정보 동의',
      notice: '합성 동의 안내',
      decision: 'ask',
      reason: '수신자 확인 필요',
      mode: 'adaptive',
      revision: 'synthetic-v1',
      origin: app.origin,
      at: now,
      actor: 'policy',
    },
  ];
  app.store.saveJob(job);
  return job;
}

test('legacy stopped/completed inboxes remain history; only actionable jobs expose review forms', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-status-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  const ui = await chromium.launch({ headless: true });
  try {
    const stopped = waitingJob(app, 'stopped'),
      completed = waitingJob(app, 'completed');
    // Old data can also contain an obsolete task/content approval. Neither is actionable.
    stopped.tasks = [
      {
        id: 'old',
        kind: 'comment',
        url: app.origin + '/demo/event',
        instruction: '과거 댓글',
        quote: '가상 과제',
        dependsOn: [],
        state: 'review',
      },
    ];
    stopped.approval = {
      id: 'old',
      action: { action: 'click', reason: '가상' },
      url: app.origin,
    } as any;
    app.store.saveJob(stopped);
    const paused = waitingJob(app, 'paused'),
      unknown = waitingJob(app, 'submission_unknown');
    const page = await ui.newPage();
    await page.goto(app.origin);
    await page.locator(`#jobs #job-${stopped.id}`).waitFor({ state: 'attached' });
    assert.equal(await page.locator('#active-jobs [data-inbox]').count(), 0);
    assert.equal(
      await page
        .locator('#jobs [data-inbox],#jobs [data-task-review],#jobs [data-action=approve]')
        .count(),
      0,
    );
    assert.equal(await page.locator('#pending-count').textContent(), '2');
    assert.equal(await page.locator(`#jobs #job-${completed.id}`).count(), 1);
    assert.match(
      (await page.locator(`#jobs #job-${stopped.id}`).textContent()) || '',
      /작업을 중지했습니다/,
    );
    assert.equal(await page.locator(`#jobs #job-${stopped.id} .consent-audit`).count(), 1);
    assert.equal(
      await page.locator(`#active-jobs #job-${paused.id} [data-action=resume-current]`).count(),
      1,
    );
    assert.equal(
      await page.locator(`#active-jobs #job-${unknown.id} [data-action=verify-result]`).count(),
      1,
    );
    await page.reload();
    await page.locator(`#jobs #job-${stopped.id}`).waitFor({ state: 'attached' });
    assert.equal(await page.locator(`[data-inbox="${stopped.id}"]`).count(), 0);
    assert.ok(app.store.job(stopped.id)!.autonomy!.inbox, 'keep original question/audit data');
  } finally {
    await ui.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('polling removes a stopped inbox even while its answer has focus', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-status-focus-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  const ui = await chromium.launch({ headless: true });
  try {
    const job = waitingJob(app),
      page = await ui.newPage();
    await page.goto(app.origin);
    const form = page.locator(`[data-inbox="${job.id}"]`);
    await form.getByLabel('동의하지 않습니다', { exact: true }).check();
    await app.runner.pause(job.id, true);
    await form.waitFor({ state: 'detached', timeout: 8000 });
    assert.equal(await page.locator(`#jobs #job-${job.id}`).count(), 1);
    assert.equal(await page.locator('#pending-count').textContent(), '0');
    assert.match(app.store.job(job.id)!.note, /작업을 중지했습니다/);
    assert.deepEqual(app.store.job(job.id)!.autonomy!.overrides, {});
  } finally {
    await ui.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stop racing an inbox submission returns a useful message and refreshes obsolete controls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-status-race-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  const ui = await chromium.launch({ headless: true });
  try {
    const job = waitingJob(app),
      page = await ui.newPage();
    const snapshot = await fetch(app.origin + '/api/state').then((r) => r.json());
    let stale = true;
    await page.route('**/api/state', (route) =>
      stale ? route.fulfill({ json: snapshot }) : route.continue(),
    );
    await page.route(`**/api/jobs/${job.id}/inbox`, (route) => {
      stale = false;
      return route.continue();
    });
    await page.goto(app.origin);
    const form = page.locator(`[data-inbox="${job.id}"]`);
    await form.getByLabel('동의하지 않습니다', { exact: true }).check();
    await app.runner.pause(job.id, true);
    await form.getByRole('button', { name: '한 번에 답변하고 재개' }).click();
    await form.waitFor({ state: 'detached' });
    await page.waitForFunction(() =>
      document
        .querySelector('#toast')
        ?.textContent?.includes('현재 이 확인함에 답변할 수 없습니다'),
    );
    assert.equal(await page.locator('#pending-count').textContent(), '0');
    assert.equal(app.store.job(job.id)!.status, 'stopped');
    assert.deepEqual(app.store.job(job.id)!.autonomy!.overrides, {});
    assert.equal(app.runner.isBusy(), false);
  } finally {
    await ui.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dashboard separates expected stops, technical faults and actionable user inboxes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-notices-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  const ui = await chromium.launch({ headless: true });
  try {
    const normal = waitingJob(app, 'paused'),
      technical = waitingJob(app),
      user = waitingJob(app),
      unknown = waitingJob(app, 'submission_unknown');
    delete normal.autonomy;
    normal.note = '행동 한도에 도달했습니다. 실행 기록을 확인하세요.';
    delete technical.autonomy;
    technical.kind = 'discover';
    technical.note = '작업을 완료하지 못했습니다. 연결 상태와 실행 기록을 확인해 주세요.';
    technical.observationDiagnostics = [
      {
        at: Date.now(),
        stage: 'text',
        code: 'observation_navigation_changed',
        attempt: 1,
        outcome: 'retrying',
      },
    ];
    app.store.saveJob(normal);
    app.store.saveJob(technical);
    const page = await ui.newPage();
    await page.goto(app.origin);
    const root = (j: Job) => page.locator(`#active-jobs #job-${j.id}`);
    await root(technical).waitFor();
    assert.match(await root(technical).innerText(), /기술 오류/);
    assert.match(await root(technical).innerText(), /당시 세부 원인은 기록되지 않았습니다/);
    assert.equal(await root(technical).locator('[data-job-context]').count(), 0);
    assert.match(
      await root(technical).locator('[data-action=resume]').innerText(),
      /남은 24회로 탐색 재개/,
    );
    await root(technical).locator('.job-diagnostics summary').click();
    assert.match(await root(technical).innerText(), /observation_navigation_changed/);
    assert.match(await root(normal).innerText(), /정상 중단/);
    assert.equal(await root(normal).locator('[data-job-context]').count(), 0);
    assert.match(await root(user).innerText(), /사용자 확인 필요/);
    assert.equal(await root(user).locator('[data-inbox]').count(), 1);
    assert.match(await root(unknown).innerText(), /자동 재시도하지 않습니다/);
    assert.equal(await root(unknown).locator('[data-action=verify-result]').count(), 1);
  } finally {
    await ui.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
