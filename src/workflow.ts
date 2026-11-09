import { randomUUID } from 'node:crypto';
import { createAutonomy, settings } from './autonomy.js';
import { canonicalUrl, deadlineState, scoreCandidate, type Job, type Store } from './store.js';
import { evaluateCandidate } from './selection.js';
import { buildTasks } from './tasks.js';

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
    .filter((e) => {
      try {
        buildTasks(e);
      } catch {
        return false;
      }
      const url = new URL(e.entryUrl);
      return (
        e.jobId === parent.id &&
        !store.submission(e.id) &&
        url.protocol === 'https:' &&
        ((url.hostname === 'form.naver.com' && /^\/response\//.test(url.pathname)) ||
          (url.hostname === 'moaform.com' && /^\/q\//.test(url.pathname)) ||
          (url.hostname === 'answer.moaform.com' && /^\/answers\//.test(url.pathname)) ||
          (url.hostname === 'docs.google.com' && /^\/forms\//.test(url.pathname)) ||
          !!e.tasks?.length) &&
        deadlineState(e) === 'available' &&
        !e.blockers.length &&
        evaluateCandidate(store, e).state === 'eligible' &&
        !/구매|결제|방문|친구.*태그|구독|리그램/.test(e.requirements.join(' ')) &&
        (!/팔로우|좋아요|댓글/.test(e.requirements.join(' ')) || !!e.tasks?.length) &&
        e.sourceEvidence?.some((s) => canonicalUrl(s.url) === canonicalUrl(e.entryUrl))
      );
    })
    .sort(
      (a, b) =>
        evaluateCandidate(store, b).score - evaluateCandidate(store, a).score ||
        a.effortMinutes - b.effortMinutes,
    )[0];
  if (!event) {
    parent.note =
      '탐색을 마쳤습니다. 조건이 확인된 미참여 지원 폼이 없어 자동 응모 준비를 시작하지 않았습니다.';
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
    maxSteps: 60,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    note: '탐색 결과에서 자동 선택한 응모입니다.',
    uncertain: false,
    allowedOrigins: [new URL(event.entryUrl).origin],
    approvedTexts: [],
    history: [],
    autonomy: createAutonomy(config, new URL(event.entryUrl).origin),
    tasks: buildTasks(event),
  };
  child.autonomy!.evidence = event.sourceEvidence;
  child.autonomy!.organizer = event.organizer;
  child.autonomy!.entryChannel = event.entryChannel;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    if (!store.claimSubmission(event.id, child.id)) {
      store.db.exec('ROLLBACK');
      return;
    }
    grant.childId = child.id;
    parent.note = '조건이 확인된 지원 폼 1건을 골라 저장된 위임으로 응모 준비를 시작합니다.';
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
