import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../../src/server.js';
import type { Job } from '../../src/store.js';
import { resultBatch } from '../../src/result-batch.js';
import { outcomes } from '../../src/outcomes.js';

test('dashboard batch automatically registers sources, runs sequentially with queue off and exposes partial results without external writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-batch-ui-'));
  const app = await createApp({ dir, port: 0, headless: true });
  app.scheduler.stop();
  const browser = await chromium.launch({ headless: true });
  try {
    app.store.setSettings('selection', { kind: 'api', model: 'fixture' });
    for (const name of ['first', 'blocked', 'scope', 'last']) {
      const e = app.store.record(
        {
          title: '합성 ' + name,
          organizer: 'Fixture',
          entryUrl: app.origin + '/demo/fixture/' + name,
          deadline: null,
          prize: '커피',
          winners: 1,
          requirements: [],
          blockers: [],
          evidenceQuote: '합성',
          evidenceKind: 'text',
          effortMinutes: 1,
        },
        app.origin + '/demo/fixture/' + name,
        'fixture',
        'test.png',
      ).event;
      const at = new Date().toISOString();
      const job = {
        id: randomUUID(),
        kind: 'apply',
        eventId: e.id,
        status: 'completed',
        createdAt: at,
        updatedAt: at,
        history: [],
      } as unknown as Job;
      app.store.saveJob(job);
      app.store.claimSubmission(e.id, job.id);
      app.store.markSubmission(e.id, 'completed', '{}');
    }
    await app.browser.open();
    let writes = 0;
    await app.browser.context!.route('**/demo/fixture/*', (route) => {
      if (route.request().method() !== 'GET') {
        writes++;
        return route.abort();
      }
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<h1>합성 당첨자 발표</h1><p>당첨자는 김**입니다.</p><form method="post"><button type="submit">상품 신청</button></form>',
      });
    });
    app.runner.model.decide = async (_p, _i, c: any) => ({
      step: {
        observationId: c.observation.id,
        reason: '합성 확인',
        ...(c.observation.url.endsWith('/scope')
          ? { action: 'navigate', url: 'https://outside.example/notice' }
          : c.observation.url.endsWith('/blocked')
            ? {
                action: 'click',
                ref: c.observation.elements.find((e: any) => e.type === 'submit')?.ref,
              }
            : c.observation.url.endsWith('/first')
              ? { action: 'done', resultKind: 'announced', evidenceQuote: '합성 당첨자 발표' }
              : { action: 'needs_user', reason: '합성 안내에는 이번 행사 발표 근거가 없습니다.' }),
      } as any,
      inputTokens: 10,
      outputTokens: 2,
    });
    const page = await browser.newPage(),
      errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.origin + '/#rewards');
    await page.waitForFunction(() =>
      document.querySelector('#result-batch-status')?.textContent?.includes('확인 가능 4건'),
    );
    assert.equal(await page.locator('#result-batch-start').isEnabled(), true);
    const created = page.waitForResponse((r) => r.url().endsWith('/api/outcomes/batch'));
    await page.locator('#result-batch-start').click();
    const response = await created;
    assert.equal(response.status(), 200, await response.text());
    for (let i = 0; i < 5; i++) {
      await app.runner.finished();
      await app.scheduler.tick();
    }
    assert.equal(resultBatch(app.store)?.state, 'completed');
    await page.reload();
    await page.waitForFunction(() =>
      document.querySelector('#result-batch-status')?.textContent?.includes('4/4건 처리'),
    );
    assert.equal(await page.locator('#result-batch-results article').count(), 4);
    const text = await page.locator('#result-batch-results').innerText();
    assert.match(text, /발표 발견 · 본인 결과 확인 필요/);
    assert.match(text, /자동 확인 불가/);
    assert.match(text, /확인 중단/);
    assert.match(text, /이번 공개 페이지 읽기 범위 밖의 주소/);
    assert.ok(!text.includes('result_source_outside_scope'));
    assert.ok(!text.includes('result_requires_user_check'));
    assert.equal(writes, 0);
    assert.ok(outcomes(app.store).every((o) => o.status === 'pending'));
    const s = await page.request.get(app.origin + '/api/state').then((r) => r.json());
    assert.equal(s.resultBatch.metrics.calls, 4);
    assert.equal(s.resultBatch.metrics.inputTokens, 40);
    assert.equal(s.operations.queueEnabled, false);
    assert.equal(s.outcomeAlerts.length, 1);
    const noCsrf = await page.request.post(app.origin + '/api/outcomes/batch', {
      data: { provider: { kind: 'api', model: 'fixture' } },
    });
    assert.equal(noCsrf.status(), 403);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
