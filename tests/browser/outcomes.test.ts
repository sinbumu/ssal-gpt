import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server.js';
import {
  OutcomeSchema,
  saveOutcome,
  publicOutcomes,
  outcomes,
  queueResultCheck,
  outcomeAlerts,
} from '../../src/outcomes.js';
import type { Job } from '../../src/store.js';

test('announcement checks are read-only, never infer a win or loss; reward codes stay out of polling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-outcome-'));
  const app = await createApp({ dir, port: 0, headless: true });
  try {
    const event = app.store.record(
      {
        title: 'Test',
        organizer: 'Fixture',
        entryUrl: app.origin + '/demo/entry',
        deadline: null,
        prize: '커피',
        winners: 1,
        requirements: [],
        blockers: [],
        evidenceQuote: 'Test',
        evidenceKind: 'text',
        effortMinutes: 1,
      },
      app.origin + '/demo/result',
      'search',
      'test.png',
    ).event;
    const entry = {
      id: randomUUID(),
      kind: 'apply',
      eventId: event.id,
      status: 'completed',
      createdAt: new Date().toISOString(),
      history: [],
    } as unknown as Job;
    app.store.saveJob(entry);
    app.store.claimSubmission(event.id, entry.id);
    app.store.markSubmission(event.id, 'completed', '{}');
    const input = OutcomeSchema.parse({
      eventId: event.id,
      sourceUrl: app.origin + '/demo/result',
    });
    saveOutcome(app.store, input);
    const id = queueResultCheck(app.store, event.id, { kind: 'api', model: 'fixture' }, 'chromium');
    assert.equal(
      queueResultCheck(app.store, event.id, { kind: 'api', model: 'fixture' }, 'chromium'),
      id,
    );
    await app.browser.selectJob(id);
    let writes = 0;
    await app.browser.context!.route('**/demo/result', (r) => {
      if (r.request().method() !== 'GET') writes++;
      return r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<h1>Test 당첨자 발표</h1><p>당첨자는 김**입니다.</p>',
      });
    });
    app.runner.model.decide = async (_p, _i, c: any) => ({
      step: {
        action: 'done',
        observationId: c.observation.id,
        reason: '발표 확인',
        resultKind: 'announced',
        evidenceQuote: 'Test 당첨자 발표',
      },
      inputTokens: 1,
      outputTokens: 1,
    });
    app.runner.start(id);
    await app.runner.finished();
    assert.equal(app.store.job(id)?.status, 'completed', app.store.job(id)?.note);
    assert.equal(writes, 0);
    assert.equal(outcomes(app.store)[0]!.status, 'pending');
    assert.equal(outcomeAlerts(app.store, '2026-11-09').length, 1);
    assert.throws(() => saveOutcome(app.store, { ...input, status: 'won' }), /evidence_note/);
    saveOutcome(
      app.store,
      OutcomeSchema.parse({
        ...input,
        status: 'won',
        note: '공식 DM에서 직접 확인',
        reward: {
          name: '커피',
          status: 'received',
          code: 'PRIVATE-CODE',
          faceValue: 5000,
          expiresOn: '2026-11-01',
        },
      }),
    );
    assert.equal(JSON.stringify(publicOutcomes(app.store)).includes('PRIVATE-CODE'), false);
    const state = await fetch(app.origin + '/api/state').then((r) => r.json());
    assert.equal(JSON.stringify(state).includes('PRIVATE-CODE'), false);
    assert.ok(outcomeAlerts(app.store, '2026-11-09').some((a) => /만료/.test(a.message)));
    assert.equal(
      outcomes(app.store)[0]!.reward!.status,
      'received',
      'date alone never marks used or received',
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
