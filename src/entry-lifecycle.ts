import { randomUUID } from 'node:crypto';
import { ServiceError, type ProviderChoice } from './auth.js';
import { settings } from './autonomy.js';
import { selection } from './selection.js';
import {
  deadlineState,
  unattemptedEntry,
  type Store,
  type EventRecord,
  type Job,
} from './store.js';
import type { BrowserEngine } from './browser.js';

export function entryLifecycle(store: Store, event: EventRecord) {
  const row = store.submission(event.id);
  const job = row ? store.job(String(row.job_id)) : undefined;
  const retry = event.management?.retryJobId ? store.job(event.management.retryJobId) : undefined;
  const rechecking =
    !!retry && !retry.archivedAt && !['completed', 'stopped', 'failed'].includes(retry.status);
  const completed = row?.state === 'completed';
  const unknown = row?.state === 'unknown' || !!job?.uncertain;
  const mode = event.management?.mode || 'active';
  const manualUnconfirmed = !!event.management?.manualAt && !event.management.manualNotEnteredAt;
  const status = completed
    ? 'completed'
    : mode !== 'active'
      ? mode
      : unknown
        ? 'unknown'
        : rechecking
          ? 'rechecking'
          : job?.status === 'stopped'
            ? 'stopped'
            : job?.status === 'failed'
              ? 'failed'
              : job?.archivedAt
                ? 'held'
                : job?.status || 'candidate';
  const labels: Record<string, string> = {
    completed: '응모 완료',
    dropped: '드랍',
    manual: '수동 진행',
    unknown: '제출 결과 미확인',
    rechecking: '원문 재확인 중',
    held: '보관됨',
    stopped: '중단됨',
    failed: '실행 오류',
    paused: '일시정지',
    needs_user: '답변·확인 필요',
    approval: '승인 대기',
    queued: '실행 대기',
    running: '응모 진행 중',
    candidate: '미응모 후보',
  };
  const canRetry =
    !completed &&
    !unknown &&
    mode === 'active' &&
    !manualUnconfirmed &&
    !rechecking &&
    row?.state === 'in_progress' &&
    unattemptedEntry(job) &&
    deadlineState(event) === 'available';
  const reason = unknown
    ? '제출했을 가능성이 있어 새 응모를 만들지 않습니다. 기존 접수 결과를 확인하세요.'
    : mode !== 'active'
      ? event.management?.note ||
        (mode === 'manual'
          ? '직접 참여 후 완료 여부를 기록하세요.'
          : '기본 목록과 자동 선정에서 제외했습니다.')
      : retry && !retry.prepareOne?.childId
        ? retry.note
        : job
          ? job.switchReason ||
            [...job.history]
              .reverse()
              .find((h) => /needs_user|skip_source|unavailable/.test(h.action))?.reason ||
            job.note
          : '';
  return {
    status,
    label: labels[status] || status,
    reason,
    unknown,
    manualUnconfirmed,
    canRetry,
    retryBlockedReason: canRetry
      ? ''
      : unknown
        ? '접수 결과 확인이 먼저 필요합니다.'
        : manualUnconfirmed
          ? '수동 진행으로 넘긴 적이 있습니다. 외부 참여가 없었는지 직접 확인해야 자율 재도전을 요청할 수 있습니다.'
          : row && !unattemptedEntry(job)
            ? '기존 실행·행동 기록이 있어 새 응모 대신 기존 작업 확인 또는 수동 처리가 필요합니다.'
            : deadlineState(event) !== 'available'
              ? '현재 참여 기간을 확인할 수 없습니다.'
              : '진행 상태를 먼저 정리하세요.',
    jobId: rechecking ? retry!.id : job?.id,
    jobArchived: rechecking ? !!retry!.archivedAt : !!job?.archivedAt,
    canResume: rechecking
      ? ['paused', 'failed', 'needs_user'].includes(retry!.status) && !retry!.archivedAt
      : !!job && !job.archivedAt && !unknown && ['paused', 'failed'].includes(job.status),
    canManage: !completed && job?.status !== 'running' && retry?.status !== 'running',
    hiddenByDefault: completed || mode !== 'active' || (!!job?.archivedAt && !event.management),
  };
}

export function manageEntry(
  store: Store,
  event: EventRecord,
  mode: 'active' | 'dropped' | 'manual',
  note?: string,
  confirmedNoParticipation = false,
) {
  if (!entryLifecycle(store, event).canManage)
    throw new ServiceError('entry_management_unavailable');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    // Keep evidence, grants and the duplicate lock; archived jobs cannot be scheduled.
    const row = store.submission(event.id);
    for (const id of [row?.job_id, event.management?.retryJobId]) {
      const job = id ? store.job(String(id)) : undefined;
      if (!job) continue;
      if (mode !== 'active') {
        if (job.status === 'queued') job.status = 'paused';
        job.archivedAt = new Date().toISOString();
        store.saveJob(job);
      }
    }
    event.management = {
      ...event.management,
      mode,
      at: new Date().toISOString(),
      note,
      retryJobId: event.management?.retryJobId,
    };
    if (mode === 'manual') {
      event.management.manualAt = new Date().toISOString();
      delete event.management.manualNotEnteredAt;
    } else if (mode === 'active' && confirmedNoParticipation && event.management.manualAt) {
      event.management.manualNotEnteredAt = new Date().toISOString();
    }
    store.saveEvent(event);
    store.db.exec('COMMIT');
  } catch (e) {
    store.db.exec('ROLLBACK');
    throw e;
  }
}

export function retryEntry(
  store: Store,
  event: EventRecord,
  provider: ProviderChoice,
  engine: BrowserEngine,
  context?: string,
) {
  if (!entryLifecycle(store, event).canRetry) throw new ServiceError('entry_retry_unsafe');
  const config = settings(store);
  if (!config.policy.enabled) throw new ServiceError('delegation_not_enabled');
  const row = store.submission(event.id)!;
  const prior = store.job(String(row.job_id))!;
  if ((prior.browserEngine || 'chromium') !== engine)
    throw new ServiceError('job_browser_profile_mismatch');
  const now = new Date().toISOString();
  const job: Job = {
    id: randomUUID(),
    kind: 'discover',
    retryEventId: event.id,
    retryFromJobId: prior.id,
    parentId: prior.id,
    provider,
    browserEngine: engine,
    goal: `이 이벤트 하나만 원문에서 기간·자격·필수 과제를 다시 확인하고 같은 참여 주소의 후보를 기록하세요: ${event.title}. 참여 불가하면 이유를 남기고 종료하세요. 다른 이벤트로 전환하지 마세요.`,
    startUrl: event.entryUrl,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    candidateLimit: 1,
    maxSteps: selection(store).discoveryCalls,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    uncertain: false,
    note: '기존 실행 기록을 보존하고 이 이벤트의 원문을 다시 확인합니다.',
    allowedOrigins: [new URL(event.entryUrl).origin],
    approvedTexts: [],
    history: [],
    userContext: [prior.userContext, context].filter(Boolean).join('\n').slice(-12000),
    prepareOne: { revision: config.revision, expires: Date.now() + 24 * 60 * 60_000 },
  };
  store.db.exec('BEGIN IMMEDIATE');
  try {
    if (!entryLifecycle(store, store.event(event.id)!).canRetry)
      throw new ServiceError('entry_retry_unsafe');
    prior.archivedAt = now;
    store.saveJob(prior);
    const previousRetry = event.management?.retryJobId
      ? store.job(event.management.retryJobId)
      : undefined;
    if (previousRetry) {
      previousRetry.archivedAt = now;
      store.saveJob(previousRetry);
    }
    store.saveJob(job);
    event.management = { ...event.management, mode: 'active', at: now, retryJobId: job.id };
    store.saveEvent(event);
    store.db.exec('COMMIT');
    return job;
  } catch (e) {
    store.db.exec('ROLLBACK');
    throw e;
  }
}

export function reportManualCompletion(store: Store, event: EventRecord, evidence: string) {
  if (event.management?.mode !== 'manual' || !entryLifecycle(store, event).canManage)
    throw new ServiceError('manual_entry_not_active');
  const row = store.submission(event.id),
    prior = row ? store.job(String(row.job_id)) : undefined;
  const now = new Date().toISOString();
  const job: Job = {
    id: randomUUID(),
    parentId: prior?.id,
    kind: 'apply',
    eventId: event.id,
    provider: prior?.provider || { kind: 'api', model: 'manual-no-model-call' },
    goal: '사용자가 직접 완료한 응모 기록',
    startUrl: event.entryUrl,
    status: 'completed',
    createdAt: now,
    updatedAt: now,
    candidateLimit: 1,
    maxSteps: 0,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    uncertain: false,
    note: '사용자가 직접 완료를 보고했습니다. 앱의 접수 검증은 아닙니다.',
    allowedOrigins: [],
    approvedTexts: [],
    history: [
      {
        action: 'manual_completion',
        reason: '사용자가 완료 근거를 기록했습니다. 기존 시도·불확실성 기록은 보존합니다.',
        url: event.entryUrl,
      },
    ],
  };
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.saveJob(job);
    if (!row) store.claimSubmission(event.id, job.id);
    else store.db.prepare('UPDATE submissions SET job_id=? WHERE event_id=?').run(job.id, event.id);
    store.markSubmission(
      event.id,
      'completed',
      JSON.stringify({ verification: 'user_reported', quote: evidence, completedAt: now }),
    );
    store.db.exec('COMMIT');
  } catch (e) {
    store.db.exec('ROLLBACK');
    throw e;
  }
}
