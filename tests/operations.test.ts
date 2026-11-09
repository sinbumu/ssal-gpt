import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Job } from '../src/store.js';
import {
  ScheduleSchema,
  saveSchedule,
  Scheduler,
  meteredModel,
  usage,
  dayKey,
  OperationsSchema,
  inWindow,
} from '../src/operations.js';
import type { Runner } from '../src/runner.js';

test('daily metering covers failures, blocks next inference, persists and uses Seoul midnight', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-budget-'));
  let store = new Store(dir);
  try {
    const job = { id: 'test' } as Job,
      provider = { kind: 'api' as const, model: 'fixture' };
    store.setSettings('operations', OperationsSchema.parse({ dailyCalls: 2 }));
    let calls = 0;
    const model = meteredModel(
      store,
      {
        async decide() {
          if (++calls === 2) throw new Error('connection lost after request');
          return {
            step: { action: 'done' as const, observationId: 'o', reason: 'test' },
            inputTokens: 20,
            outputTokens: 3,
          };
        },
      },
      job,
    );
    const args = [provider, '', {}, Buffer.alloc(0), new AbortController().signal] as const;
    await model.decide(...args);
    await assert.rejects(model.decide(...args));
    await assert.rejects(model.decide(...args), /daily_call_limit/);
    assert.equal(calls, 2);
    assert.equal(usage(store).unknown, 1);
    store.close();
    store = new Store(dir);
    assert.equal(usage(store).tokens, 23);
    assert.equal(usage(store).calls, 2);
    assert.equal(dayKey(Date.parse('2026-11-09T14:59:59Z')), '2026-11-09');
    assert.equal(dayKey(Date.parse('2026-11-09T15:00:00Z')), '2026-11-10');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('missed schedule coalesces, queue survives restart and policy changes revoke automatic preparation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-schedule-'));
  let store = new Store(dir);
  try {
    const at = Date.parse('2026-11-09T02:00:00Z');
    store.setSettings('operations', OperationsSchema.parse({ queueEnabled: true }));
    const schedule = saveSchedule(
      store,
      ScheduleSchema.parse({
        name: 'test',
        enabled: true,
        intervalMinutes: 60,
        sourceUrl: 'https://example.com/',
        provider: { kind: 'api', model: 'fixture' },
        goal: 'discover',
      }),
      at - 86400000,
    );
    const busyRunner = { isBusy: () => true } as Runner;
    const scheduler = new Scheduler(store, busyRunner);
    await Promise.all([scheduler.tick(at), scheduler.tick(at)]);
    assert.equal(store.jobs().length, 1);
    assert.equal(store.jobs()[0]!.scheduleId, schedule.id);
    await scheduler.tick(at + 7200000);
    assert.equal(store.jobs().length, 1);
    store.close();
    store = new Store(dir);
    assert.equal(store.jobs()[0]!.status, 'queued');
    const next = saveSchedule(
      store,
      ScheduleSchema.parse({ ...schedule, id: undefined, prepareOne: true }),
      at,
    );
    store.setSettings('autonomy', { revision: 'changed', profile: {}, policy: { enabled: true } });
    await new Scheduler(store, busyRunner).tick(at);
    assert.equal(
      store.settings<any[]>('schedules', []).find((s) => s.id === next.id).enabled,
      false,
    );
    assert.equal(
      inWindow({ ...schedule, startHour: 22, endHour: 6 }, Date.parse('2026-11-09T15:00:00Z')),
      true,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a provider missing its cost rate does not starve other eligible queued work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-budget-queue-')),
    store = new Store(dir);
  try {
    store.setSettings(
      'operations',
      OperationsSchema.parse({
        queueEnabled: true,
        dailyEstimatedUsd: 1,
        rates: [{ model: 'priced', inputPerMillion: 1, outputPerMillion: 1 }],
      }),
    );
    store.saveJob({
      id: 'blocked',
      status: 'queued',
      provider: { kind: 'api', model: 'missing-rate' },
    } as Job);
    store.saveJob({
      id: 'ready',
      status: 'queued',
      provider: { kind: 'api', model: 'priced' },
    } as Job);
    const started: string[] = [];
    const runner = {
      isBusy: () => false,
      start: (id: string) => started.push(id),
    } as unknown as Runner;
    await new Scheduler(store, runner).tick();
    assert.deepEqual(started, ['ready']);
    assert.equal(store.job('blocked')!.status, 'queued');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
