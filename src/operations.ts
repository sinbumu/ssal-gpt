import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ServiceError, safeMessage } from './auth.js';
import type { ModelClient } from './model.js';
import type { Job, Store } from './store.js';
import type { Runner } from './runner.js';
import { outcomes, queueResultCheck } from './outcomes.js';
import { settings } from './autonomy.js';

export const ProviderSchema = z.object({
  kind: z.enum(['chatgpt', 'api']),
  accountId: z.string().optional(),
  model: z.string().min(1).max(150),
});
export const OperationsSchema = z.object({
  queueEnabled: z.boolean().default(false),
  dailyCalls: z.number().int().min(1).max(10000).default(200),
  dailyTokens: z.number().int().min(1).max(100000000).default(3000000),
  dailyEstimatedUsd: z.number().positive().max(10000).nullable().default(null),
  rates: z
    .array(
      z.object({
        model: z.string().min(1).max(150),
        inputPerMillion: z.number().nonnegative(),
        outputPerMillion: z.number().nonnegative(),
      }),
    )
    .max(20)
    .default([]),
  maxPending: z.number().int().min(1).max(30).default(5),
});
export const ScheduleSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(false),
  intervalMinutes: z.number().int().min(15).max(43200),
  startHour: z.number().int().min(0).max(23).default(9),
  endHour: z.number().int().min(0).max(23).default(22),
  maxRunsPerDay: z.number().int().min(1).max(24).default(2),
  goal: z.string().min(1).max(2000),
  sourceUrl: z.string().url(),
  provider: ProviderSchema,
  browserEngine: z.enum(['chromium', 'chrome']).default('chromium'),
  maxSteps: z.number().int().min(5).max(300).default(60),
  candidateLimit: z.number().int().min(1).max(10).default(3),
  prepareOne: z.boolean().default(false),
});
export type Schedule = z.infer<typeof ScheduleSchema> & {
  id: string;
  nextAt: number;
  revision: string;
  lastJobId?: string;
  note?: string;
  runDay?: string;
  runsToday?: number;
};
export const operations = (store: Store) =>
  OperationsSchema.parse(store.settings('operations', {}));
export const schedules = (store: Store): Schedule[] => store.settings('schedules', []);
export const dayKey = (now = Date.now()) =>
  new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
export function usage(store: Store, now = Date.now()) {
  const rows = store.db.prepare('SELECT * FROM usage WHERE day=?').all(dayKey(now));
  return rows.reduce<{
    calls: number;
    tokens: number;
    estimatedUsd: number;
    unknown: number;
    unpriced: number;
  }>(
    (sum, r) => ({
      calls: sum.calls + 1,
      tokens: sum.tokens + Number(r.input_tokens) + Number(r.output_tokens),
      estimatedUsd: sum.estimatedUsd + Number(r.estimated_usd || 0),
      unknown: sum.unknown + (r.state !== 'reported' ? 1 : 0),
      unpriced: sum.unpriced + (r.estimated_usd === null ? 1 : 0),
    }),
    { calls: 0, tokens: 0, estimatedUsd: 0, unknown: 0, unpriced: 0 },
  );
}
export function budgetReason(store: Store, provider: Job['provider'], now = Date.now()) {
  const config = operations(store),
    used = usage(store, now);
  if (used.calls >= config.dailyCalls) return 'daily_call_limit';
  if (used.tokens >= config.dailyTokens) return 'daily_token_limit';
  if (config.dailyEstimatedUsd !== null) {
    if (provider.kind !== 'api' || !config.rates.some((r) => r.model === provider.model))
      return 'cost_rate_required_for_selected_provider';
    if (used.estimatedUsd >= config.dailyEstimatedUsd) return 'daily_estimated_cost_limit';
    if (used.unknown) return 'unreported_usage_requires_review';
  }
  return undefined;
}
// All model paths (research, recovery, receipt checks included) pass this boundary.
export function meteredModel(store: Store, model: ModelClient, job: Job): ModelClient {
  return {
    async decide(...args) {
      args[4].throwIfAborted();
      const reason = budgetReason(store, args[0]);
      if (reason) throw new ServiceError(reason);
      const id = randomUUID(),
        day = dayKey();
      store.db
        .prepare('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?)')
        .run(id, day, job.id, 0, 0, null, 'pending', Date.now());
      try {
        const result = await model.decide(...args);
        const rate =
          args[0].kind === 'api'
            ? operations(store).rates.find((r) => r.model === args[0].model)
            : undefined;
        const cost = rate
          ? (result.inputTokens * rate.inputPerMillion +
              result.outputTokens * rate.outputPerMillion) /
            1000000
          : null;
        store.db
          .prepare(
            'UPDATE usage SET input_tokens=?,output_tokens=?,estimated_usd=?,state=? WHERE id=?',
          )
          .run(result.inputTokens, result.outputTokens, cost, 'reported', id);
        return result;
      } catch (error) {
        store.db.prepare("UPDATE usage SET state='unreported' WHERE id=?").run(id);
        throw error;
      }
    },
  };
}
export function saveSchedule(
  store: Store,
  input: z.infer<typeof ScheduleSchema>,
  now = Date.now(),
) {
  const all = schedules(store),
    old = all.find((s) => s.id === input.id);
  if (!old && all.length >= 20) throw new ServiceError('schedule_limit');
  const schedule: Schedule = {
    ...input,
    id: input.id || randomUUID(),
    nextAt: now,
    revision: settings(store).revision,
    runDay: old?.runDay,
    runsToday: old?.runsToday,
  };
  store.setSettings('schedules', [...all.filter((s) => s.id !== schedule.id), schedule]);
  return schedule;
}
export function inWindow(schedule: Schedule, now: number) {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Seoul',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(now),
  );
  return (
    schedule.startHour === schedule.endHour ||
    (schedule.startHour < schedule.endHour
      ? hour >= schedule.startHour && hour < schedule.endHour
      : hour >= schedule.startHour || hour < schedule.endHour)
  );
}
export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  constructor(
    readonly store: Store,
    readonly runner: Runner,
    readonly blocked: () => boolean = () => false,
  ) {}
  start() {
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 2000);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  async tick(now = Date.now()) {
    if (this.ticking || this.blocked()) return;
    this.ticking = true;
    try {
      const config = operations(this.store);
      if (!config.queueEnabled) return;
      const all = schedules(this.store);
      let pending = this.store
        .jobs()
        .filter(
          (j) =>
            !j.archivedAt &&
            [
              'queued',
              'running',
              'needs_user',
              'approval',
              'paused',
              'submission_unknown',
            ].includes(j.status),
        ).length;
      for (const s of all) {
        if (!s.enabled || s.nextAt > now || !inWindow(s, now)) continue;
        if (
          s.prepareOne &&
          (s.revision !== settings(this.store).revision || !settings(this.store).policy.enabled)
        ) {
          s.enabled = false;
          s.note = '위임 설정이 변경됐습니다. 예약을 다시 저장해 적용 범위를 확인하세요.';
          continue;
        }
        if (s.runDay !== dayKey(now)) {
          s.runDay = dayKey(now);
          s.runsToday = 0;
        }
        const reason = budgetReason(this.store, s.provider, now);
        if (
          reason ||
          pending >= config.maxPending ||
          (s.runsToday || 0) >= s.maxRunsPerDay ||
          this.store
            .jobs()
            .some((j) => j.scheduleId === s.id && ['queued', 'running'].includes(j.status))
        ) {
          s.note = reason
            ? safeMessage(new ServiceError(reason))
            : '대기 작업 또는 오늘 실행 횟수 한도에 도달했습니다.';
          continue;
        }
        const id = randomUUID(),
          at = new Date(now).toISOString();
        const job: Job = {
          id,
          kind: 'discover',
          scheduleId: s.id,
          provider: s.provider,
          browserEngine: s.browserEngine,
          goal: s.goal,
          startUrl: s.sourceUrl,
          status: 'queued',
          createdAt: at,
          updatedAt: at,
          candidateLimit: s.candidateLimit,
          maxSteps: s.maxSteps,
          steps: 0,
          inputTokens: 0,
          outputTokens: 0,
          note: '예약된 탐색이 대기 중입니다.',
          uncertain: false,
          allowedOrigins: [new URL(s.sourceUrl).origin],
          approvedTexts: [],
          history: [],
          searchEngine: 'naver',
          prepareOne: s.prepareOne ? { revision: s.revision, expires: now + 86400000 } : undefined,
        };
        // Queue insertion and next due time commit together. Missed intervals coalesce to one run.
        this.store.db.exec('BEGIN IMMEDIATE');
        try {
          this.store.saveJob(job);
          s.nextAt = now + s.intervalMinutes * 60000;
          s.runsToday = (s.runsToday || 0) + 1;
          s.lastJobId = id;
          s.note = '탐색 대기열에 추가했습니다.';
          this.store.setSettings('schedules', all);
          this.store.db.exec('COMMIT');
          pending++;
        } catch (e) {
          this.store.db.exec('ROLLBACK');
          throw e;
        }
      }
      this.store.setSettings('schedules', all);
      const selected = this.store.settings<Job['provider'] | null>('selection', null);
      if (selected && !budgetReason(this.store, selected, now)) {
        for (const o of outcomes(this.store)) {
          if (pending >= config.maxPending) break;
          if (
            !o.autoCheck ||
            !o.nextCheckAt ||
            o.nextCheckAt > now ||
            ['won', 'lost'].includes(o.status)
          )
            continue;
          queueResultCheck(this.store, o.eventId, selected, this.runner.browser.engine);
          pending++;
        }
      }
      if (this.runner.isBusy() || this.blocked()) return;
      const job = this.store
        .jobs()
        .reverse()
        .find(
          (j) =>
            j.status === 'queued' && !j.archivedAt && !budgetReason(this.store, j.provider, now),
        );
      if (!job || budgetReason(this.store, job.provider, now)) return;
      try {
        this.runner.start(job.id);
      } catch (e) {
        job.status = 'paused';
        job.note = e instanceof ServiceError ? safeMessage(e) : '대기 작업을 시작하지 못했습니다.';
        this.store.saveJob(job);
      }
    } finally {
      this.ticking = false;
    }
  }
}
