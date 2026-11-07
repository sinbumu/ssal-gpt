import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../../src/server.js';
import { Runner } from '../../src/runner.js';
import type { Model, Step } from '../../src/model.js';
import type { Job } from '../../src/store.js';
import type { Observation } from '../../src/browser.js';

function job(origin: string, layout = 'normal'): Job {
  const id = randomUUID();
  return {
    id,
    kind: 'demo',
    goal: 'Synthetic transport test; this is not a real LLM evaluation.',
    provider: { kind: 'api', model: 'synthetic-test-driver' },
    startUrl: `${origin}/demo/event?run=${id}&layout=${layout}`,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    candidateLimit: 1,
    maxSteps: 30,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    note: '',
    uncertain: false,
    allowedOrigins: [origin],
    approvedTexts: [],
    history: [],
  };
}
function testDriver(): Model {
  return {
    async decide(
      _choice: unknown,
      _instructions: string,
      context: any,
      image: Buffer,
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      assert.ok(image.length > 1000, 'real screenshot must reach the provider');
      const o = context.observation as Observation;
      const step = (s: Partial<Step>) => ({
        step: { observationId: o.id, reason: '합성 테스트 드라이버', ...s },
        inputTokens: 0,
        outputTokens: 0,
      });
      if (o.text.includes('접수번호:'))
        return step({ action: 'done', evidenceQuote: '응모가 완료되었습니다' });
      const close = o.elements.find((e) => e.label === '닫기');
      if (close)
        return step({
          action: 'click',
          x: close.x + close.width / 2,
          y: close.y + close.height / 2,
        });
      const coffee = o.elements.find((e) => e.type === 'radio' && e.value === 'coffee');
      if (coffee && !coffee.checked) return step({ action: 'click', ref: coffee.ref });
      const text = o.elements.find((e) => e.tag === 'textarea');
      if (text && !context.history.some((h: any) => h.action === 'type'))
        return step({ action: 'type', ref: text.ref, text: '가상의 커피 이벤트를 응원합니다.' });
      const required = o.elements.find((e) => e.type === 'checkbox' && e.label.includes('필수'));
      if (required && !required.checked) return step({ action: 'click', ref: required.ref });
      const submit = o.elements.find((e) => e.type === 'submit');
      if (submit && context.history.some((h: any) => h.action === 'type') && required?.checked)
        return step({ action: 'click', ref: submit.ref });
      return step({ action: 'scroll', delta: 500 });
    },
  } as unknown as Model;
}

test('real Chromium completes synthetic fixtures across layouts using fresh screenshots, coordinates, inputs and receipts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-browser-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    for (const layout of ['normal', 'shift']) {
      const j = job(app.origin, layout);
      app.store.saveJob(j);
      const runner = new Runner(app.store, app.browser, testDriver(), app.origin);
      runner.start(j.id);
      await runner.finished();
      const result = app.store.job(j.id)!;
      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.ok(app.store.receipt(j.id));
      assert.ok(result.steps > 4);
      assert.equal(result.uncertain, false);
      const count = app.store.db
        .prepare('SELECT count(*) AS n FROM demo_receipts WHERE run=?')
        .get(j.id);
      assert.equal(count?.n, 1);
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stale elements and manual layout changes invalidate pending browser actions; login pages never become observations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-browser-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    await app.browser.navigate(`${app.origin}/demo/event?run=stale`);
    const o = await app.browser.observe();
    await app.browser.page!.evaluate(() => document.body.append(document.createElement('p')));
    await assert.rejects(
      () =>
        app.browser.act({ action: 'click', observationId: o.id, x: 50, y: 50, reason: 'stale' }),
      /stale_observation/,
    );
    await app.browser.page!.evaluate(() => {
      const p = document.createElement('input');
      p.type = 'password';
      document.body.append(p);
    });
    await assert.rejects(() => app.browser.observe(), /needs_login_manual/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lost submission response is recorded as unknown and resume reconciles without posting again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-browser-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const j = job(app.origin);
    app.store.saveJob(j);
    const original = app.browser.act.bind(app.browser);
    let transmitted = 0;
    app.browser.act = async (step) => {
      const e = app.browser.latest?.elements.find((e) => e.ref === step.ref);
      await original(step);
      if (step.action === 'click' && e?.type === 'submit') {
        transmitted++;
        throw new Error('Synthetic network response loss');
      }
    };
    const runner = new Runner(app.store, app.browser, testDriver(), app.origin);
    runner.start(j.id);
    await runner.finished();
    assert.equal(app.store.job(j.id)?.status, 'submission_unknown');
    assert.ok(app.store.receipt(j.id));
    runner.start(j.id);
    await runner.finished();
    assert.equal(app.store.job(j.id)?.status, 'completed');
    assert.equal(transmitted, 1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dashboard loads without script errors, keeps links usable and blocks untrusted mutation origins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-ui-'));
  const app = await createApp({ dir, port: 0, headless: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.origin);
    await page.locator('#account option').waitFor({ state: 'attached' });
    assert.deepEqual(errors, []);
    await page.getByRole('link', { name: '04 · 연결 설정' }).click();
    assert.equal(new URL(page.url()).hash, '#settings');
    await page.getByRole('button', { name: '기회 찾아보기' }).click();
    await page.getByRole('status').filter({ hasText: '모델 목록' }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    const state = await (await fetch(`${app.origin}/api/state`)).json();
    const response = await fetch(`${app.origin}/api/auth/api-key`, {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
        'X-Ssal-Token': state.csrf,
      },
      body: JSON.stringify({ key: 'synthetic-key' }),
    });
    assert.equal(response.status, 403);
    const noToken = await fetch(`${app.origin}/api/auth/api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(noToken.status, 403);
  } finally {
    await browser.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('approval is invalidated by a page change instead of executing old coordinates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-review-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const j = job(app.origin);
    j.kind = 'apply';
    app.store.saveJob(j);
    const runner = new Runner(app.store, app.browser, testDriver(), app.origin);
    runner.start(j.id);
    await runner.finished();
    const pending = app.store.job(j.id)!;
    assert.equal(pending.status, 'approval');
    assert.ok(pending.approval);
    await app.browser.page!.getByRole('button', { name: '닫기' }).evaluate((el) => {
      el.textContent = '변경된 버튼';
    });
    runner.approve(j.id, pending.approval!.id);
    await runner.finished();
    const result = app.store.job(j.id)!;
    assert.equal(result.note, 'approval_page_changed');
    assert.equal(result.history.length, 0);
    assert.equal(result.uncertain, false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pause cancels an in-flight decision before manual takeover; resume uses a fresh observation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-pause-'));
  const app = await createApp({ dir, port: 0, headless: true });
  let started!: () => void;
  const deciding = new Promise<void>((resolve) => {
    started = resolve;
  });
  let firstId = '';
  const model = {
    async decide(
      _choice: unknown,
      _instructions: string,
      context: any,
      _image: Buffer,
      signal: AbortSignal,
    ) {
      firstId = context.observation.id;
      started();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      throw new Error('unreachable');
    },
  } as unknown as Model;
  try {
    const j = job(app.origin);
    app.store.saveJob(j);
    const runner = new Runner(app.store, app.browser, model, app.origin);
    runner.start(j.id);
    await deciding;
    await runner.pause(j.id);
    assert.equal(runner.isBusy(), false);
    assert.equal(app.store.job(j.id)?.status, 'paused');
    assert.equal(app.store.job(j.id)?.history.length, 0);
    await app.browser.page!.getByRole('button', { name: '닫기' }).click();
    const fresh = await app.browser.observe();
    assert.notEqual(fresh.id, firstId);
    const resumed = new Runner(app.store, app.browser, testDriver(), app.origin);
    resumed.start(j.id);
    await resumed.finished();
    assert.equal(app.store.job(j.id)?.status, 'completed');
    assert.ok(app.store.receipt(j.id));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resuming a different job restores its own page instead of operating on the last job', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-owner-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const a = job(app.origin);
    a.status = 'paused';
    a.currentUrl = a.startUrl;
    app.store.saveJob(a);
    const b = job(app.origin);
    await app.browser.navigate(b.startUrl);
    app.browser.ownerJobId = b.id;
    const seen: string[] = [];
    const model = {
      async decide(_p: unknown, _i: string, context: any) {
        seen.push(context.observation.url);
        return {
          step: {
            action: 'needs_user',
            observationId: context.observation.id,
            reason: 'End isolated navigation test',
          },
          inputTokens: 0,
          outputTokens: 0,
        };
      },
    } as unknown as Model;
    const runner = new Runner(app.store, app.browser, model, app.origin);
    runner.start(a.id);
    await runner.finished();
    assert.deepEqual(seen, [a.startUrl]);
    assert.equal(app.browser.ownerJobId, a.id);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery opens an observed link without invoking its page-provided click handler', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-readonly-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const j = job(app.origin);
    j.kind = 'discover';
    j.currentUrl = j.startUrl;
    await app.browser.navigate(j.startUrl);
    app.browser.ownerJobId = j.id;
    const destination = `${app.origin}/demo/event?run=read-only-target`;
    await app.browser.page!.evaluate((url) => {
      document.body.replaceChildren();
      const link = document.createElement('a');
      link.textContent = '공개 이벤트';
      link.href = url;
      link.onclick = (event) => {
        event.preventDefault();
        document.title = 'CLICK HANDLER MUST NOT RUN';
      };
      document.body.append(link);
    }, destination);
    app.store.saveJob(j);
    let calls = 0;
    const model = {
      async decide(_p: unknown, _i: string, context: any) {
        const o = context.observation as Observation;
        const step =
          calls++ === 0
            ? { action: 'click', ref: o.elements.find((e) => e.href === destination)!.ref }
            : { action: 'needs_user' };
        return {
          step: { ...step, observationId: o.id, reason: 'Synthetic read-only navigation test' },
          inputTokens: 0,
          outputTokens: 0,
        };
      },
    } as unknown as Model;
    const runner = new Runner(app.store, app.browser, model, app.origin);
    runner.start(j.id);
    await runner.finished();
    assert.equal(app.browser.page!.url(), destination);
    assert.notEqual(await app.browser.page!.title(), 'CLICK HANDLER MUST NOT RUN');
    assert.equal(app.store.job(j.id)?.uncertain, false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wheel scroll reaches a nested panel and invalidates the previous observation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-scroll-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    await app.browser.navigate(`${app.origin}/demo/event?run=nested-scroll`);
    await app.browser.page!.evaluate(() => {
      document.body.innerHTML =
        '<div id="panel" style="position:fixed;inset:80px 120px;overflow:auto"><div style="height:2000px">안내문 상단</div><p>스크롤 후 조건</p></div>';
      document.body.style.overflow = 'hidden';
    });
    const o = await app.browser.observe();
    await app.browser.act({
      action: 'scroll',
      observationId: o.id,
      delta: 650,
      reason: 'Read panel',
    });
    assert.ok((await app.browser.page!.locator('#panel').evaluate((el) => el.scrollTop)) > 0);
    await assert.rejects(() => app.browser.assertFresh(o.id), /stale_observation/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a completion message visible before an attempted submission is not fresh proof', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-old-receipt-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const j = job(app.origin);
    j.kind = 'apply';
    j.currentUrl = j.startUrl;
    j.uncertain = true;
    app.store.submitDemo(j.id);
    await app.browser.navigate(j.startUrl);
    app.browser.ownerJobId = j.id;
    const o = await app.browser.observe();
    j.intent = { beforeText: o.text, url: o.url };
    app.store.saveJob(j);
    const model = {
      async decide(_p: unknown, _i: string, context: any) {
        return {
          step: {
            action: 'done',
            observationId: context.observation.id,
            reason: 'Synthetic old receipt test',
            evidenceQuote: '응모가 완료되었습니다',
          },
          inputTokens: 0,
          outputTokens: 0,
        };
      },
    } as unknown as Model;
    const runner = new Runner(app.store, app.browser, model, app.origin);
    runner.start(j.id);
    await runner.finished();
    assert.equal(app.store.job(j.id)?.status, 'submission_unknown');
    assert.equal(app.store.job(j.id)?.note, 'completion_requires_receipt_or_new_comment');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('user review keeps source evidence and context updates revoke pending approvals without clearing unknown submissions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-context-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const candidate = {
      title: 'Synthetic event',
      organizer: 'Fixture',
      entryUrl: 'https://93.184.216.34/source',
      deadline: null,
      deadlineDate: '2099-01-01',
      prize: 'Synthetic coffee',
      winners: 1,
      requirements: ['Answer truthfully'],
      blockers: ['Unverified link'],
      evidenceQuote: 'Synthetic evidence',
      evidenceKind: 'text' as const,
      effortMinutes: 5,
    };
    const { event } = app.store.record(candidate, candidate.entryUrl, 'fixture', 'fixture.png');
    const state = await (await fetch(`${app.origin}/api/state`)).json();
    const post = async (path: string, value: unknown) =>
      fetch(app.origin + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
        body: JSON.stringify(value),
      });
    const response = await post(`/api/events/${event.id}/review`, {
      entryUrl: 'https://93.184.216.34/form',
      deadlineDate: '2099-01-01',
      blockers: [],
      note: 'Observed public form, synthetic review',
    });
    assert.equal(response.status, 200);
    const revised = app.store.event(event.id)!;
    assert.equal(revised.sourceUrl, candidate.entryUrl);
    assert.equal(revised.reviews?.[0]?.previousBlockers[0], 'Unverified link');
    const j = job(app.origin);
    j.kind = 'apply';
    j.eventId = event.id;
    j.uncertain = true;
    j.status = 'submission_unknown';
    app.store.saveJob(j);
    app.store.claimSubmission(event.id, j.id);
    const context = await post(`/api/jobs/${j.id}/context`, {
      text: 'The user supplied a synthetic answer.',
    });
    assert.equal(context.status, 200);
    assert.equal(app.store.job(j.id)?.uncertain, true);
    assert.equal(app.store.job(j.id)?.status, 'submission_unknown');
    assert.equal(app.store.job(j.id)?.userContext, 'The user supplied a synthetic answer.');
    const denied = await post(`/api/events/${event.id}/review`, {
      entryUrl: candidate.entryUrl,
      deadlineDate: null,
      blockers: [],
      note: 'Cannot alter a started entry',
    });
    assert.equal(denied.status, 400);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hidden form timers do not invalidate observation but visible field changes do', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-timer-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    await app.browser.navigate(`${app.origin}/demo/event?run=timer`);
    await app.browser.page!.evaluate(() => {
      const timer = document.createElement('input');
      timer.type = 'hidden';
      timer.id = 'timer';
      document.body.append(timer);
    });
    const o = await app.browser.observe();
    await app.browser.page!.locator('#timer').evaluate((el) => el.setAttribute('value', '2'));
    await app.browser.assertFresh(o.id);
    await app.browser.page!.locator('#timer').evaluate((el) => el.setAttribute('type', 'text'));
    await assert.rejects(() => app.browser.assertFresh(o.id), /stale_observation/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit manual handoff resumes a live form without GET reloading it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-live-form-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const j = job(app.origin);
    j.status = 'paused';
    j.currentUrl = j.startUrl;
    app.store.saveJob(j);
    await app.browser.navigate(j.startUrl);
    await app.browser.page!.evaluate(() => {
      document.body.innerHTML = '<p>Transient form step preserved</p>';
    });
    const observed: string[] = [];
    app.runner.model.decide = async (_choice, _instructions, context: any) => {
      observed.push(context.observation.text);
      return {
        step: {
          action: 'needs_user',
          observationId: context.observation.id,
          reason: 'Synthetic handoff test',
        },
        inputTokens: 0,
        outputTokens: 0,
      };
    };
    const state = await (await fetch(`${app.origin}/api/state`)).json();
    const response = await fetch(`${app.origin}/api/jobs/${j.id}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ssal-Token': state.csrf },
      body: JSON.stringify({ useCurrentPage: true }),
    });
    assert.equal(response.status, 200);
    await app.runner.finished();
    assert.deepEqual(observed, ['Transient form step preserved']);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('styled radio labels work and a numbered Next page stays in progress instead of becoming a final submission', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-multistep-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const j = job(app.origin);
    j.currentUrl = j.startUrl;
    app.store.saveJob(j);
    await app.browser.navigate(j.startUrl);
    app.browser.ownerJobId = j.id;
    await app.browser.page!.evaluate(() => {
      document.body.innerHTML =
        '<p id="progress">1 / 3page</p><form><div style="position:relative;height:40px"><input id="answer" type="radio" name="answer" value="first"><label for="answer" style="position:absolute;inset:0;background:white;margin:0">First visit</label></div><button type="submit">다음</button></form>';
      document.querySelector('form')!.onsubmit = (event) => {
        event.preventDefault();
        document.querySelector('#progress')!.textContent = '2 / 3page';
      };
    });
    const model = {
      async decide(_choice: unknown, _instructions: string, context: any) {
        const o = context.observation as Observation;
        const radio = o.elements.find((e) => e.type === 'radio')!;
        const step = o.text.includes('2 / 3page')
          ? { action: 'needs_user' }
          : !radio.checked
            ? { action: 'click', ref: radio.ref }
            : { action: 'click', ref: o.elements.find((e) => e.type === 'submit')!.ref };
        return {
          step: { ...step, observationId: o.id, reason: 'Synthetic multi-page form test' },
          inputTokens: 0,
          outputTokens: 0,
        };
      },
    } as unknown as Model;
    const runner = new Runner(app.store, app.browser, model, app.origin);
    runner.start(j.id);
    await runner.finished();
    const result = app.store.job(j.id)!;
    assert.equal(result.status, 'needs_user');
    assert.equal(result.uncertain, false);
    assert.equal(result.steps, 3);
    assert.equal(result.intent, undefined);
    assert.equal(app.store.receipt(j.id), undefined);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('visible choices remain clickable when their associated label is hidden or has no box', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-hidden-label-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    await app.browser.navigate(`${app.origin}/demo/event?run=hidden-label`);
    await app.browser.page!.evaluate(() => {
      document.body.innerHTML =
        '<input id="rating" type="radio" name="rating" value="agree" aria-label="Agree"><label for="rating" style="display:none">Agree</label>' +
        '<input id="choice" type="checkbox" aria-label="Select"><label for="choice" style="display:block;width:0;height:0;overflow:hidden;margin:0">Select</label>';
      document.body.dataset.changes = '0';
      document.body.addEventListener('change', () => {
        document.body.dataset.changes = String(Number(document.body.dataset.changes) + 1);
      });
    });
    for (const type of ['radio', 'checkbox']) {
      const o = await app.browser.observe();
      const choice = o.elements.find((e) => e.type === type)!;
      assert.ok(choice, 'the input must be observed on screen');
      await app.browser.act({
        action: 'click',
        observationId: o.id,
        ref: choice.ref,
        reason: 'Synthetic hidden-label test',
      });
      assert.equal(await app.browser.page!.locator(`input[type="${type}"]`).isChecked(), true);
    }
    assert.equal(await app.browser.page!.locator('body').getAttribute('data-changes'), '2');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('survey completion is recognized after submission, while thanks alone or an incomplete survey stays uncertain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-survey-receipt-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    for (const [message, completed] of [
      ['설문이 완료되었습니다.', true],
      ['참여해 주셔서 감사합니다.', false],
      ['설문이 완료되지 않았습니다.', false],
    ] as const) {
      const j = job(app.origin);
      j.kind = 'apply';
      j.currentUrl = j.startUrl;
      app.store.saveJob(j);
      await app.browser.navigate(j.startUrl);
      app.browser.ownerJobId = j.id;
      await app.browser.page!.evaluate((result) => {
        document.body.innerHTML =
          '<form><p>참여해 주셔서 감사합니다.</p><button type="submit">설문제출</button></form>';
        document.body.dataset.submissions = '0';
        document.querySelector('form')!.onsubmit = (event) => {
          event.preventDefault();
          document.body.dataset.submissions = String(Number(document.body.dataset.submissions) + 1);
          document.body.innerHTML = `<p>${result}</p>`;
        };
      }, message);
      const model = {
        async decide(_p: unknown, _i: string, context: any) {
          const o = context.observation as Observation;
          const submit = o.elements.find((e) => e.type === 'submit');
          return {
            step: {
              ...(submit
                ? { action: 'click', ref: submit.ref }
                : { action: 'done', evidenceQuote: message }),
              observationId: o.id,
              reason: 'Synthetic survey completion test',
            },
            inputTokens: 0,
            outputTokens: 0,
          };
        },
      } as unknown as Model;
      const runner = new Runner(app.store, app.browser, model, app.origin);
      runner.start(j.id);
      await runner.finished();
      assert.equal(app.store.job(j.id)?.status, 'approval');
      runner.approve(j.id, app.store.job(j.id)!.approval!.id);
      await runner.finished();
      const result = app.store.job(j.id)!;
      assert.equal(result.status, completed ? 'completed' : 'submission_unknown', message);
      assert.equal(result.uncertain, !completed);
      assert.equal(await app.browser.page!.locator('body').getAttribute('data-submissions'), '1');
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
