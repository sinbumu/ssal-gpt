import { randomUUID } from 'node:crypto';
import { ServiceError, safeMessage } from './auth.js';
import { hash, settings } from './autonomy.js';
import { budgetReason } from './operations.js';
import { evaluateCandidate } from './selection.js';
import type { EventRecord, Job, Store } from './store.js';
import type { Runner } from './runner.js';
import { createPreparedEntry, preparationReasons } from './workflow.js';

type Item = {
  eventId: string;
  title: string;
  scope: string;
  score: number;
  state: 'pending' | 'current' | 'completed' | 'skipped';
  jobId?: string;
  note?: string;
};

type EntryBatch = {
  id: string;
  state: 'running' | 'completed' | 'stopped';
  provider: Job['provider'];
  profileKey: string;
  revision: string;
  expires: number;
  items: Item[];
  note: string;
};

export const entryBatch = (store: Store) => store.settings<EntryBatch | null>('entryBatch', null);

function scope(e: EventRecord) {
  return hash([
    e.id,
    e.title,
    e.organizer,
    e.sourceUrl,
    e.entryUrl,
    e.requirements,
    e.eligibility,
    e.tasks,
    e.entryNeeds,
    e.startsAt,
    e.deadline,
    e.deadlineDate,
    e.prize,
    e.connectionProfile,
  ]);
}

export function entryBatchCandidate(e: EventRecord, score: number): Item {
  return { eventId: e.id, title: e.title, scope: scope(e), score, state: 'pending' };
}

export function entryBatchPlan(store: Store, profileKey: string, candidates?: Item[]) {
  const items =
    candidates ??
    store.events().flatMap((e) => {
      const assessment = evaluateCandidate(store, e, Date.now(), profileKey);
      return !preparationReasons(store, e, undefined, assessment).length
        ? [entryBatchCandidate(e, assessment.score)]
        : [];
    });
  items.sort((a, b) => b.score - a.score);
  return { key: hash([settings(store).revision, profileKey, items.map((i) => i.scope)]), items };
}

export function startEntryBatch(
  store: Store,
  profileKey: string,
  provider: Job['provider'],
  key: string,
) {
  if (entryBatch(store)?.state === 'running') throw new ServiceError('entry_batch_active');
  const config = settings(store);
  if (!config.policy.enabled) throw new ServiceError('delegation_not_enabled');
  const plan = entryBatchPlan(store, profileKey);
  if (key !== plan.key) throw new ServiceError('entry_batch_plan_changed');
  if (!plan.items.length) throw new ServiceError('entry_batch_empty');
  const b: EntryBatch = {
    id: randomUUID(),
    state: 'running',
    provider,
    profileKey,
    revision: config.revision,
    expires: Date.now() + 86400000,
    items: plan.items,
    note: '브라우저가 비면 첫 응모를 시작합니다.',
  };
  store.setSettings('entryBatch', b);
  return b;
}

export function stopEntryBatch(store: Store, id: string) {
  const b = entryBatch(store);
  if (!b || b.id !== id || b.state !== 'running') throw new ServiceError('entry_batch_changed');
  b.state = 'stopped';
  b.note = '남은 대기열을 종료했습니다. 이미 시작한 응모는 진행·확인함에서 관리할 수 있습니다.';
  store.setSettings('entryBatch', b);
}

// Only the current item owns a submission. Review/inbox actions use the existing job routes;
// the next item is not claimed until the current receipt or an explicit disposition is known.
export function tickEntryBatch(store: Store, runner: Runner, now = Date.now()) {
  const b = entryBatch(store);
  if (!b || b.state !== 'running' || runner.isBusy()) return false;
  const note = (message: string) => {
    if (b.note !== message) {
      b.note = message;
      store.setSettings('entryBatch', b);
    }
  };
  const current = b.items.find((i) => i.state === 'current');
  if (current) {
    const row = store.submission(current.eventId);
    const job = current.jobId && store.job(current.jobId);
    if (job && job.status === 'queued') {
      // A restart between claiming the event and starting its worker leaves this row queued.
      job.status = 'paused';
      job.note = '응모 시작 전에 실행기가 중단됐습니다. 확인함에서 이 작업을 재개할 수 있습니다.';
      store.saveJob(job);
    }
    if (row?.state === 'completed' && row.job_id === current.jobId) {
      current.state = 'completed';
    } else if (
      job &&
      (job.archivedAt ||
        job.status === 'stopped' ||
        ['manual', 'dropped'].includes(store.event(current.eventId)?.management?.mode || ''))
    ) {
      current.state = 'skipped';
      current.note = job.note;
    } else {
      note(job ? job.note : '현재 응모 기록을 확인해야 합니다.');
      return false;
    }
    store.setSettings('entryBatch', b);
  }
  const item = b.items.find((i) => i.state === 'pending');
  if (!item) {
    b.state = 'completed';
    b.note = '순차 응모를 마쳤습니다.';
    store.setSettings('entryBatch', b);
    return false;
  }
  const config = settings(store);
  if (
    !config.policy.enabled ||
    config.revision !== b.revision ||
    b.expires <= now ||
    runner.browser.profileKey() !== b.profileKey
  ) {
    b.state = 'stopped';
    b.note =
      '위임이 만료되었거나 프로필·위임 또는 브라우저가 변경됐습니다. 남은 후보는 현재 설정으로 다시 시작할 수 있습니다.';
    store.setSettings('entryBatch', b);
    return false;
  }
  const budget = budgetReason(store, b.provider, now);
  if (budget) {
    note(safeMessage(new ServiceError(budget)));
    return false;
  }
  const event = store.event(item.eventId);
  const reason =
    !event || scope(event) !== item.scope
      ? '행사 또는 참여 조건이 변경됐습니다.'
      : preparationReasons(
          store,
          event,
          undefined,
          evaluateCandidate(store, event, now, b.profileKey),
        )[0];
  if (reason || !event) {
    item.state = 'skipped';
    item.note = reason;
    store.setSettings('entryBatch', b);
    return true;
  }

  const job = createPreparedEntry(store, event, b.provider, runner.browser.engine);
  job.entryBatchId = b.id;
  job.autonomy!.expires = Math.min(job.autonomy!.expires, b.expires);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    if (!store.claimSubmission(event.id, job.id)) {
      item.state = 'skipped';
      item.note = '이미 시작된 응모입니다.';
    } else {
      item.state = 'current';
      item.jobId = job.id;
      b.note = '응모를 진행하고 있습니다.';
      store.saveJob(job);
    }
    store.setSettings('entryBatch', b);
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  if (item.jobId) {
    try {
      runner.start(job.id);
    } catch (error) {
      job.status = 'paused';
      job.note = safeMessage(error);
      store.saveJob(job);
    }
  }
  return true;
}
