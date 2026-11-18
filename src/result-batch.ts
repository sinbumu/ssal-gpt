import { dmCheckPlan, queueDmCheck } from './instagram-dm.js';
import { publicResultSource } from './result-sources.js';
export { publicResultSource } from './result-sources.js';
import { randomUUID } from 'node:crypto';
import type { Job, Store } from './store.js';
import type { Runner } from './runner.js';
import { ServiceError, safeMessage } from './auth.js';
import { outcomes, OutcomeSchema, putOutcome, queueResultCheck } from './outcomes.js';
import { budgetReason, dayKey } from './operations.js';

export type ResultBatch = {
  mode?: 'public' | 'instagram_dm';
  id: string;
  state: 'running' | 'paused' | 'completed' | 'stopped';
  at: number;
  updatedAt: number;
  provider: Job['provider'];
  engine: Job['browserEngine'];
  note: string;
  items: {
    eventId: string;
    sourceUrl: string;
    jobId?: string;
    state: 'pending' | 'running' | 'done' | 'skipped';
    reason?: string;
  }[];
};
export const resultBatch = (store: Store) =>
  store.settings<ResultBatch | null>('resultBatch', null);

export function resultCheckPlan(store: Store, now = Date.now()) {
  const saved = outcomes(store),
    jobs = store.jobs(),
    today = dayKey(now);
  return store.completedEntries().map((e) => {
    const o = saved.find((x) => x.eventId === e.eventId);
    const notice = e.winnerNotice;
    const sourceUrl = [o?.sourceUrl, e.sourceUrl, e.entryUrl].find(
      (url): url is string => !!url && publicResultSource(url),
    );
    let reason = '';
    if (o && ['won', 'lost'].includes(o.status)) reason = '이미 당첨·낙첨을 기록했습니다.';
    else if (o?.check?.state === 'announced')
      reason = '발표 근거가 있습니다. 본인의 결과를 확인해 주세요.';
    else if (e.announcementDate && e.announcementDate > today)
      reason = `발표 예정일 ${e.announcementDate} 전입니다.`;
    else if (
      jobs.some(
        (j) =>
          j.kind === 'result' &&
          j.eventId === e.eventId &&
          ['queued', 'running', 'paused'].includes(j.status) &&
          !j.archivedAt,
      )
    )
      reason = '기존 결과 확인 작업이 대기·진행·일시정지 중입니다.';
    else if (
      !(o?.sourceUrl && publicResultSource(o.sourceUrl)) &&
      notice.basis === 'explicit' &&
      notice.channels.length &&
      notice.channels.every((c) =>
        ['instagram_dm', 'direct_message', 'email', 'sms', 'phone', 'story'].includes(c),
      )
    )
      reason = '개별 연락·스토리로 안내하는 행사입니다. 이번 공개 페이지 일괄 확인 범위 밖입니다.';
    else if (!sourceUrl)
      reason = '저장된 공개 발표·원문 주소가 없습니다. 결과·경품 관리에서 주소를 지정해 주세요.';
    else if ((o?.check?.at || 0) > now - 86400000)
      reason = '최근 24시간 안에 확인했습니다. 필요하면 개별 확인을 실행하세요.';
    return {
      eventId: e.eventId,
      title: e.title,
      sourceUrl,
      eligible: !reason,
      reason:
        reason ||
        (o?.sourceUrl
          ? '저장한 발표 주소를 확인합니다.'
          : '응모할 때 저장한 원문에서 발표를 확인합니다.'),
      announcementDate: e.announcementDate,
      check: o?.check,
    };
  });
}

export function startResultBatch(
  store: Store,
  provider: Job['provider'],
  engine: Job['browserEngine'],
  limit = 10,
) {
  if (['running', 'paused'].includes(resultBatch(store)?.state || ''))
    throw new ServiceError('result_batch_exists');
  const items = resultCheckPlan(store)
    .filter((x) => x.eligible)
    .slice(0, limit)
    .map((x) => ({ eventId: x.eventId, sourceUrl: x.sourceUrl!, state: 'pending' as const }));
  if (!items.length) throw new ServiceError('result_batch_empty');
  const now = Date.now();
  const batch: ResultBatch = {
    id: randomUUID(),
    state: 'running',
    at: now,
    updatedAt: now,
    provider,
    engine,
    note: '공개 발표를 순서대로 확인합니다.',
    items,
  };
  store.setSettings('resultBatch', batch);
  return batch;
}

export function startDmBatch(
  store: Store,
  provider: Job['provider'],
  engine: Job['browserEngine'],
  eventIds: string[],
) {
  if (['running', 'paused'].includes(resultBatch(store)?.state || ''))
    throw new ServiceError('result_batch_exists');
  const plan = dmCheckPlan(store),
    ids = [...new Set(eventIds)];
  if (!ids.length || ids.length > 20) throw new ServiceError('dm_batch_size');
  for (const id of ids) {
    const row = plan.find((p) => p.eventId === id);
    if (!row?.scope || row.scope.profile !== (engine || 'chromium') || engine === 'connected')
      throw new ServiceError('dm_completed_scope_required');
  }
  const now = Date.now();
  const batch: ResultBatch = {
    id: randomUUID(),
    mode: 'instagram_dm',
    state: 'running',
    at: now,
    updatedAt: now,
    provider,
    engine,
    note: '선택한 완료 응모의 주최자 DM만 확인합니다.',
    items: ids.map((eventId) => ({ eventId, sourceUrl: '', state: 'pending' })),
  };
  store.setSettings('resultBatch', batch);
  return batch;
}

export function recoverResultBatch(store: Store) {
  const b = resultBatch(store);
  if (b?.state === 'running') {
    b.state = 'paused';
    b.note = '앱이 재시작돼 일괄 확인을 멈췄습니다. 이어서 확인을 누르면 남은 작업만 처리합니다.';
    store.setSettings('resultBatch', b);
  }
}

export async function controlResultBatch(
  store: Store,
  runner: Runner,
  action: 'pause' | 'resume' | 'stop',
) {
  const b = resultBatch(store);
  if (!b || !['running', 'paused'].includes(b.state))
    throw new ServiceError('result_batch_unavailable');
  b.state = action === 'resume' ? 'running' : action === 'stop' ? 'stopped' : 'paused';
  b.note =
    action === 'resume'
      ? '남은 공개 발표 확인을 이어갑니다.'
      : action === 'stop'
        ? '일괄 확인을 종료했습니다. 확인한 근거는 보존합니다.'
        : '일괄 확인을 일시정지했습니다.';
  b.updatedAt = Date.now();
  if (action === 'resume')
    for (const item of b.items) {
      const j = item.jobId ? store.job(item.jobId) : undefined;
      if (j && ['paused', 'running'].includes(j.status)) {
        j.status = 'queued';
        store.saveJob(j);
      }
    }
  store.setSettings('resultBatch', b);
  if (action !== 'resume')
    for (const item of b.items) {
      if (!item.jobId) continue;
      const j = store.job(item.jobId);
      if (j && ['queued', 'running', 'paused'].includes(j.status))
        await runner.pause(j.id, action === 'stop');
    }
  return b;
}

// Called by the scheduler even when recurring discovery is off. Only a user-started batch runs.
export function tickResultBatch(store: Store, runner: Runner, now = Date.now()) {
  const b = resultBatch(store);
  if (!b || b.state !== 'running') return false;
  if (runner.isBusy()) return true;
  for (const item of b.items.filter((x) => x.state === 'running')) {
    const j = item.jobId ? store.job(item.jobId) : undefined;
    if (j?.status === 'paused' || j?.status === 'running') {
      b.state = 'paused';
      b.note = '진행 작업이 멈췄습니다. 이어서 확인을 누르면 남은 한도로 재개합니다.';
      store.setSettings('resultBatch', b);
      return false;
    }
    if (j?.status === 'queued') continue;
    item.state = 'done';
    item.reason = j?.note || '실행 기록을 찾지 못했습니다.';
  }
  if (b.items.every((x) => ['done', 'skipped'].includes(x.state))) {
    b.state = 'completed';
    b.note =
      b.mode === 'instagram_dm'
        ? '주최자 DM 확인을 마쳤습니다. 당첨 근거·연결 검토·확인 불가를 구분해 확인하세요.'
        : '일괄 확인을 마쳤습니다. 발표 발견·확인 불가·제외 이유를 확인하세요.';
  } else {
    const reason = budgetReason(store, b.provider, now);
    if (reason) {
      b.state = 'paused';
      b.note = safeMessage(new ServiceError(reason));
    } else {
      const item = b.items.find((x) => ['pending', 'running'].includes(x.state))!;
      try {
        if (!item.jobId) {
          const plan = resultCheckPlan(store, now).find((x) => x.eventId === item.eventId);
          if (b.mode === 'instagram_dm') {
            item.jobId = queueDmCheck(store, item.eventId, b.provider, b.engine);
            const job = store.job(item.jobId)!;
            job.resultBatchId = b.id;
            store.saveJob(job);
          } else if (!plan?.eligible || plan.sourceUrl !== item.sourceUrl) {
            item.state = 'skipped';
            item.reason = plan?.reason || '대상 또는 주소가 변경됐습니다.';
          } else {
            if (!outcomes(store).some((o) => o.eventId === item.eventId))
              putOutcome(store, {
                ...OutcomeSchema.parse({ eventId: item.eventId, sourceUrl: item.sourceUrl }),
                updatedAt: new Date(now).toISOString(),
                reportedBy: 'unconfirmed',
              });
            item.jobId = queueResultCheck(store, item.eventId, b.provider, b.engine);
            const job = store.job(item.jobId)!;
            job.startUrl = item.sourceUrl;
            job.allowedOrigins = [new URL(item.sourceUrl).origin];
            job.resultBatchId = b.id;
            store.saveJob(job);
          }
        }
        if (item.jobId) {
          item.state = 'running';
          b.note =
            b.mode === 'instagram_dm'
              ? '완료 응모의 주최자 대화를 읽고 있습니다. 메시지 작성·발송 기능은 없습니다.'
              : '공개 페이지를 읽고 있습니다. 게시·응모·개인 메시지 전송은 하지 않습니다.';
          store.setSettings('resultBatch', b);
          runner.start(item.jobId);
        }
      } catch (error) {
        item.state = 'done';
        item.reason = safeMessage(error);
      }
    }
  }
  b.updatedAt = now;
  store.setSettings('resultBatch', b);
  return b.state === 'running';
}

export function publicResultBatch(store: Store) {
  const b = resultBatch(store);
  if (!b) return null;
  const jobs = b.items.flatMap((i) => (i.jobId && store.job(i.jobId) ? [store.job(i.jobId)!] : []));
  const usage = jobs.flatMap((j) =>
    store.db
      .prepare('SELECT input_tokens, output_tokens, state FROM usage WHERE job_id=?')
      .all(j.id),
  );
  return {
    ...b,
    items: b.items.map((i) => ({
      ...i,
      title: store.event(i.eventId)?.title || '응모',
      check: outcomes(store).find((o) => o.eventId === i.eventId)?.check,
      dmChecks: outcomes(store).find((o) => o.eventId === i.eventId)?.dmChecks,
      note: i.reason || (i.jobId && store.job(i.jobId)?.note),
    })),
    metrics: {
      automaticRecoveries: jobs.reduce(
        (n, j) =>
          n +
          (j.dmReadDiagnostics || []).reduce(
            (count, d) =>
              count + (d.stage === 'scoped' ? Number(!!d.fallback) + Number(!!d.reload) : 0),
            0,
          ),
        0,
      ),
      calls: usage.length,
      inputTokens: usage.reduce((n, r) => n + Number(r.input_tokens), 0),
      outputTokens: usage.reduce((n, r) => n + Number(r.output_tokens), 0),
      unreported: usage.filter((r) => r.state !== 'reported').length,
      activeMs: jobs.reduce((n, j) => n + (j.activeMs || 0), 0),
    },
  };
}
