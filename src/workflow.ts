import { randomUUID } from 'node:crypto';
import { createAutonomy, settings } from './autonomy.js';
import {
  canonicalUrl,
  deadlineState,
  scoreCandidate,
  type EventRecord,
  type Job,
  type Store,
} from './store.js';
import { evaluateCandidate, nextDiscoveryAfterSkip, selection } from './selection.js';
import { buildTasks, taskPermission } from './tasks.js';
import { discoveryState, excludedSource } from './discovery.js';

// A failed candidate consumes a switch, not a reset of the failed job's history.
// Reuse remaining candidates first; otherwise create a separately metered search.
export function nextWorkflowJob(store: Store, job: Job) {
  const retryParent = job.parentId ? store.job(job.parentId) : undefined;
  if (job.kind === 'apply' && retryParent?.retryEventId) return;
  const parent = nextDiscoveryAfterSkip(store, job);
  if (!parent) return prepareDiscoveredEntry(store, job);
  const existing = prepareDiscoveredEntry(store, parent);
  if (existing) return existing;
  const grant = parent.prepareOne!,
    config = settings(store);
  if (
    !config.policy.enabled ||
    grant.revision !== config.revision ||
    grant.expires <= Date.now() ||
    !parent.startUrl ||
    !parent.maxSteps
  )
    return;
  const now = new Date().toISOString();
  const next: Job = {
    id: randomUUID(),
    kind: 'discover',
    parentId: parent.id,
    provider: parent.provider,
    browserEngine: parent.browserEngine,
    goal: parent.goal,
    startUrl: parent.startUrl,
    searchEngine: parent.searchEngine,
    userContext: parent.userContext,
    candidateLimit: parent.candidateLimit,
    maxSteps: parent.maxSteps,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    uncertain: false,
    allowedOrigins: [new URL(parent.startUrl).origin],
    approvedTexts: [],
    history: [],
    prepareOne: { revision: grant.revision, expires: grant.expires, switches: grant.switches },
    note: `후보 전환 ${grant.switches}회: 새 공개 기회를 탐색합니다.`,
    memory: `이전 후보는 전송 전에 중단했습니다: ${job.switchReason}. 이미 시작한 이벤트는 재선택하지 마세요.`,
  };
  store.db.exec('BEGIN IMMEDIATE');
  try {
    grant.childId = next.id;
    parent.note = next.note;
    store.saveJob(next);
    store.saveJob(parent);
    store.db.exec('COMMIT');
    return next.id;
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}

// Shared by discovery stopping and preparation, so an unready saved lead is not success.
export function preparationReasons(store: Store, e: EventRecord, retry?: Job) {
  const assessment = evaluateCandidate(store, e);
  const reasons = assessment.state === 'eligible' ? [] : [...assessment.reasons];
  if (e.management?.mode && e.management.mode !== 'active')
    reasons.push(
      e.management.mode === 'dropped' ? '드랍한 후보입니다.' : '수동 진행으로 전환한 후보입니다.',
    );
  if (e.management?.manualAt && !e.management.manualNotEnteredAt)
    reasons.push('수동 참여 여부를 직접 확인해야 자동 응모를 요청할 수 있습니다.');
  if (store.submission(e.id) && !store.retryOwns(e.id, retry))
    reasons.push('이미 시작·완료·결과 미확인인 응모는 중복 실행하지 않습니다.');
  try {
    const tasks = buildTasks(e);
    if (tasks?.some((t) => t.kind !== 'form' && (t.kind === 'manual' || !taskPermission(store, t))))
      reasons.push('필수 과제의 자동 실행 경로 또는 사용자 위임 확인 필요');
  } catch {
    reasons.push('필수 과제의 대상·순서·원문 확인 필요');
  }
  const url = new URL(e.entryUrl);
  if (!(
    url.protocol === 'https:' &&
    ((url.hostname === 'form.naver.com' && /^\/response\//.test(url.pathname)) ||
      (url.hostname === 'moaform.com' && /^\/q\//.test(url.pathname)) ||
      (url.hostname === 'answer.moaform.com' && /^\/answers\//.test(url.pathname)) ||
      (url.hostname === 'docs.google.com' && /^\/forms\//.test(url.pathname)) ||
      !!e.tasks?.length)
  ))
    reasons.push('자동 준비를 검증한 참여 경로가 아닙니다.');
  if (/구매|결제|방문|친구.*태그|구독|리그램/.test(e.requirements.join(' ')))
    reasons.push('구매·방문·친구 태그·구독·리그램 필수 과제는 자동 준비 범위 밖입니다.');
  if (/팔로우|좋아요|댓글/.test(e.requirements.join(' ')) && !e.tasks?.length)
    reasons.push('SNS 필수 과제를 구조화하지 못했습니다.');
  if (!e.sourceEvidence?.some((s) => canonicalUrl(s.url) === canonicalUrl(e.entryUrl)))
    reasons.push('참여 페이지의 직접 관찰 근거가 필요합니다.');
  return [...new Set(reasons)];
}
export function canPrepareEntry(store: Store, e: EventRecord, retry?: Job) {
  return preparationReasons(store, e, retry).length === 0;
}

// Re-open a previously observed, unentered candidate before spending another search.
// Only current-page discovery may record it again and trigger normal preparation.
export function reuseUnenteredCandidates(store: Store, job: Job, now = Date.now()) {
  if (!job.prepareOne || job.retryEventId) return;
  const d = discoveryState(job),
    config = settings(store);
  if (
    d.reusedCandidates ||
    !config.policy.enabled ||
    job.prepareOne.revision !== config.revision ||
    job.prepareOne.expires <= now
  )
    return;
  d.reusedCandidates = [];
  for (const e of store.events()) {
    const prior = store.job(e.jobId);
    if (
      !prior ||
      prior.id === job.id ||
      prior.goal !== job.goal ||
      prior.browserEngine !== job.browserEngine ||
      now - Date.parse(e.foundAt) > 6 * 60 * 60_000 ||
      !canPrepareEntry(store, e) ||
      excludedSource(job, e.entryUrl)
    )
      continue;
    if (!d.frontier.some((f) => f.url === e.entryUrl))
      d.frontier.push({
        url: e.entryUrl,
        label: `미응모 후보 원문 재확인: ${e.title}`,
        source: e.sourceUrl,
      });
    d.reusedCandidates.push({ fromJob: prior.id, eventId: e.id, url: e.entryUrl });
    if (d.reusedCandidates.length >= 10) break;
  }
  if (d.reusedCandidates.length)
    job.history.push({
      action: 'discovery_candidates_reused',
      reason: `기존 미응모 후보 ${d.reusedCandidates.length}개의 현재 원문을 먼저 재확인합니다. 과거 조건만으로 참여하지 않습니다.`,
      url: job.startUrl,
    });
}

// A narrow, opt-in route. This is not permission for arbitrary SNS engagement.
export function prepareDiscoveredEntry(store: Store, parent: Job) {
  const grant = parent.prepareOne;
  if (parent.kind !== 'discover' || parent.status !== 'completed' || !grant || grant.childId)
    return;
  const config = settings(store);
  if (!config.policy.enabled || config.revision !== grant.revision || grant.expires < Date.now()) {
    parent.note =
      '탐색을 마쳤습니다. 위임 설정이 바뀌거나 만료되어 자동 응모 준비를 시작하지 않았습니다.';
    store.saveJob(parent);
    return;
  }
  const event = store
    .events()
    .filter(
      (e) =>
        e.jobId === parent.id &&
        (!parent.retryEventId || e.id === parent.retryEventId) &&
        canPrepareEntry(store, e, parent),
    )
    .sort(
      (a, b) =>
        evaluateCandidate(store, b).score - evaluateCandidate(store, a).score ||
        a.effortMinutes - b.effortMinutes,
    )[0];
  if (!event) {
    parent.note =
      '탐색을 마쳤습니다. 조건과 실행 경로가 확인된 미참여 이벤트가 없어 자동 응모 준비를 시작하지 않았습니다.';
    store.saveJob(parent);
    return;
  }
  const now = new Date().toISOString();
  const child: Job = {
    id: randomUUID(),
    kind: 'apply',
    provider: parent.provider,
    browserEngine: parent.browserEngine,
    parentId: parent.id,
    goal: `확인한 이벤트의 필수 조건을 충족하여 응모하세요. ${event.requirements.join(' / ')}`,
    startUrl: event.entryUrl,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    eventId: event.id,
    candidateLimit: 1,
    maxSteps: selection(store).maxCalls,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    note: '탐색 결과에서 자동 선택한 응모입니다.',
    uncertain: false,
    allowedOrigins: [new URL(event.entryUrl).origin],
    approvedTexts: [],
    history: [],
    userContext: parent.userContext,
    autonomy: createAutonomy(config, new URL(event.entryUrl).origin),
    tasks: buildTasks(event),
  };
  child.autonomy!.evidence = event.sourceEvidence;
  child.autonomy!.organizer = event.organizer;
  child.autonomy!.entryChannel = event.entryChannel;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    if (
      !(parent.retryEventId
        ? store.claimRetry(event.id, child.id, parent)
        : store.claimSubmission(event.id, child.id))
    ) {
      store.db.exec('ROLLBACK');
      return;
    }
    grant.childId = child.id;
    parent.note = '조건이 확인된 이벤트 1건을 골라 저장된 위임으로 응모 준비를 시작합니다.';
    store.saveJob(child);
    store.saveJob(parent);
    store.note(parent.id, parent.note);
    store.db.exec('COMMIT');
    return child.id;
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
