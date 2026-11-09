import { z } from 'zod';
import { ServiceError } from './auth.js';
import type { Store } from './store.js';
import { eventType } from './selection.js';
import { outcomes } from './outcomes.js';

export const QualitySchema = z
  .object({
    eventId: z.string().uuid(),
    status: z.enum(['valid', 'invalid', 'missed', 'unconfirmed']),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
type Quality = z.infer<typeof QualitySchema> & { at: number };
export function recordQuality(store: Store, input: z.infer<typeof QualitySchema>) {
  if (!store.event(input.eventId)) throw new ServiceError('event_not_found');
  const audit = store.settings<Quality[]>('qualityAudit', []);
  store.setSettings('qualityAudit', [...audit, { ...input, at: Date.now() }]);
}
export const ActivitySchema = z
  .object({
    jobId: z.string().uuid(),
    sessionId: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    active: z.boolean(),
  })
  .strict();
export function recordActivity(
  store: Store,
  input: z.infer<typeof ActivitySchema>,
  now = Date.now(),
) {
  const job = store.job(input.jobId);
  if (!job || !['needs_user', 'approval', 'paused', 'submission_unknown'].includes(job.status))
    return;
  const key = `activity:${input.sessionId}`;
  const prior = store.settings<{
    at: number;
    jobId: string;
    sequence: number;
    active: boolean;
  } | null>(key, null);
  if (prior && input.sequence <= prior.sequence) return;
  store.setSettings(key, { ...input, at: now });
  const highWater = store.settings<number>('activityHighWater', 0);
  const elapsed =
    prior && prior.active && input.active && prior.jobId === job.id && now - prior.at <= 15_000
      ? Math.max(0, now - Math.max(prior.at, highWater))
      : 0;
  store.setSettings('activityHighWater', Math.max(highWater, now));
  const ledger = store.settings<{ ms: number; samples: number }>(`humanTime:${job.id}`, {
    ms: 0,
    samples: 0,
  });
  store.setSettings(`humanTime:${job.id}`, {
    ms: ledger.ms + elapsed,
    samples: ledger.samples + 1,
  });
}
export function report(
  store: Store,
  filters: { from?: string; to?: string; source?: string; type?: string } = {},
) {
  const jobs = store.jobs(),
    events = store.events(),
    results = outcomes(store);
  const quality = store.settings<Quality[]>('qualityAudit', []);
  const usage = store.db.prepare('SELECT * FROM usage').all() as {
    job_id: string;
    input_tokens: number;
    output_tokens: number;
    estimated_usd: number | null;
    state: string;
  }[];
  const rows = [
    ...events.map((e) => ({
      event: e,
      jobs: jobs.filter((j) => j.eventId === e.id),
      source: new URL(e.sourceUrl).hostname,
      type: eventType(e),
      at: e.foundAt,
    })),
    ...jobs
      .filter((j) => j.kind === 'discover')
      .map((j) => ({
        event: undefined,
        jobs: [j],
        source: '탐색 공통 비용',
        type: 'discovery',
        at: j.createdAt,
      })),
  ]
    .filter(
      (r) =>
        (!filters.from || r.at.slice(0, 10) >= filters.from) &&
        (!filters.to || r.at.slice(0, 10) <= filters.to) &&
        (!filters.source || r.source === filters.source) &&
        (!filters.type || r.type === filters.type),
    )
    .map((r) => {
      const ids = new Set(r.jobs.map((j) => j.id)),
        calls = usage.filter((u) => ids.has(u.job_id));
      const human = r.jobs.map((j) =>
        store.settings<{ ms: number; samples: number } | null>(`humanTime:${j.id}`, null),
      );
      const result = results.find((o) => o.eventId === r.event?.id),
        q = quality.findLast((q) => q.eventId === r.event?.id);
      return {
        eventId: r.event?.id,
        title: r.event?.title || r.jobs[0]?.goal || '',
        source: r.source,
        type: r.type,
        at: r.at,
        completed: r.jobs.some((j) => j.kind === 'apply' && j.status === 'completed') ? 1 : 0,
        unknown: r.jobs.some((j) => j.uncertain) ? 1 : 0,
        quality: q?.status || 'unconfirmed',
        qualityReason: q?.reason || '',
        invalid: q?.status === 'invalid' ? 1 : 0,
        missed: q?.status === 'missed' ? 1 : 0,
        won: result?.status === 'won' ? 1 : 0,
        lost: result?.status === 'lost' ? 1 : 0,
        resultPending: r.event && !['won', 'lost'].includes(result?.status || '') ? 1 : 0,
        humanMs: human.some(Boolean) ? human.reduce((s, t) => s + (t?.ms || 0), 0) : null,
        activeMs: r.jobs.reduce((s, j) => s + (j.activeMs || 0), 0),
        waitingMs: r.jobs.reduce((s, j) => s + (j.autonomy?.metrics.waitingMs || 0), 0),
        calls: calls.length,
        inputTokens: calls.reduce((s, c) => s + c.input_tokens, 0),
        outputTokens: calls.reduce((s, c) => s + c.output_tokens, 0),
        estimatedUsd: calls.some((c) => c.estimated_usd !== null)
          ? calls.reduce((s, c) => s + (c.estimated_usd || 0), 0)
          : null,
        unpricedCalls: calls.filter((c) => c.estimated_usd === null).length,
        received:
          result?.reward && ['received', 'used', 'expired'].includes(result.reward.status) ? 1 : 0,
        faceValueKrw: result?.reward?.faceValue || 0,
        realizedKrw: result?.reward?.status === 'used' ? result.reward.realizedValue : 0,
      };
    });
  const sums = [
    'completed',
    'unknown',
    'invalid',
    'missed',
    'won',
    'lost',
    'resultPending',
    'activeMs',
    'waitingMs',
    'calls',
    'inputTokens',
    'outputTokens',
    'unpricedCalls',
    'received',
    'faceValueKrw',
    'realizedKrw',
  ] as const;
  const groups = new Map<string, Record<string, string | number | null>>();
  for (const row of rows) {
    const key = `${row.source}|${row.type}`;
    const group = groups.get(key) || {
      source: row.source,
      type: row.type,
      entries: 0,
      humanMs: null,
      unmeasuredHuman: 0,
      estimatedUsd: null,
    };
    group.entries = Number(group.entries) + (row.eventId ? 1 : 0);
    for (const field of sums) group[field] = Number(group[field] || 0) + row[field];
    if (row.humanMs === null) group.unmeasuredHuman = Number(group.unmeasuredHuman) + 1;
    else group.humanMs = Number(group.humanMs || 0) + row.humanMs;
    if (row.estimatedUsd !== null)
      group.estimatedUsd = Number(group.estimatedUsd || 0) + row.estimatedUsd;
    groups.set(key, group);
  }
  return {
    rows,
    groups: [...groups.values()],
    notes:
      '대시보드가 보이고 최근 조작이 있는 검토 구간만 사람 시간에 포함합니다. 별도 브라우저·전화·개발 시간은 미계측입니다. 탐색 비용은 공통 행이며 응모 비용에 중복 배분하지 않습니다. USD 추정 비용과 KRW 실현 가치는 환산/상계하지 않습니다.',
  };
}
export function reportCsv(value: ReturnType<typeof report>) {
  const fields = [
    'title',
    'source',
    'type',
    'at',
    'completed',
    'unknown',
    'quality',
    'qualityReason',
    'humanMs',
    'activeMs',
    'calls',
    'inputTokens',
    'outputTokens',
    'estimatedUsd',
    'unpricedCalls',
    'won',
    'lost',
    'received',
    'realizedKrw',
  ] as const;
  const cell = (v: unknown) =>
    `"${String(v ?? '')
      .replace(/^[=+@\-\t\r]/, "'$&")
      .replaceAll('"', '""')}"`;
  return (
    '\ufeff' +
    [fields.join(','), ...value.rows.map((row) => fields.map((f) => cell(row[f])).join(','))].join(
      '\r\n',
    )
  );
}
