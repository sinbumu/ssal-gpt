import {
  hash,
  publicResearchQuestion,
  resolveAnswer,
  type AnswerPlan,
  type AutonomyState,
  type InboxItem,
  type Question,
} from './autonomy.js';
import type { FormView } from './forms.js';
import type { Job } from './store.js';
import { researchBudget } from './research-policy.js';
import { observedQuote } from './evidence.js';

export function materialHash(q: Question) {
  return hash([q.signature, q.material || null]);
}

// Bound context by question, so a long opening section cannot evict the last
// question. Material remains untrusted rendered data, never executable HTML.
export function formForPlanner(view: FormView) {
  const allowance = Math.min(6000, Math.floor(24000 / Math.max(1, view.questions.length)));
  return {
    ...view,
    questions: view.questions.map((q) => ({
      ...q,
      material: q.material && {
        ...q.material,
        text: q.material.text.slice(0, allowance),
        truncated: q.material.truncated || q.material.text.length > allowance,
      },
    })),
  };
}

export function preparedAnswer(state: AutonomyState, q: Question) {
  const saved = state.preparedKnowledge?.find(
    (s) => s.signature === q.signature && s.materialHash === materialHash(q),
  );
  if (!saved) return;
  const plan = { ...saved.plan, questionId: q.id };
  const check = resolveAnswer(
    q,
    plan,
    {
      ...state,
      evidence: saved.evidence ? [...(state.evidence || []), saved.evidence] : state.evidence,
    },
    [],
    `${q.label}\n${q.description || ''}\n${q.material?.text || ''}`,
  );
  return check.answer ? { plan, evidence: saved.evidence } : undefined;
}

export function rememberKnowledge(
  state: AutonomyState,
  q: Question,
  plan: AnswerPlan | undefined,
  source: string,
) {
  if (
    !plan ||
    plan.category !== 'knowledge' ||
    !publicResearchQuestion(q) ||
    !['observed_public_evidence', 'observed_question_material', 'recommendation'].includes(source)
  )
    return;
  state.preparedKnowledge = [
    ...(state.preparedKnowledge || []).filter((s) => s.signature !== q.signature),
    {
      signature: q.signature,
      materialHash: materialHash(q),
      label: q.label,
      plan,
      evidence:
        plan.source === 'evidence'
          ? state.evidence?.find((e) => e.id === plan.sourceId)
          : undefined,
    },
  ].slice(-80);
}

export function knowledgeBlocker(job: Job, q: InboxItem) {
  if (q.category !== 'knowledge' || q.recommended?.length || !publicResearchQuestion(q)) return;
  const attempt = job.autonomy?.questionResearch?.findLast((a) => a.signature === q.signature);
  const legacy = !attempt && job.autonomy?.researched?.includes(q.signature);
  const code =
    attempt?.lastError ||
    attempt?.stopCode ||
    (legacy ? job.autonomy?.researchProgress?.stops.at(-1)?.code : undefined) ||
    (researchBudget(job).remaining === 0
      ? 'research_budget_reserved'
      : 'knowledge_evidence_missing');
  const budget = /budget|allocation/.test(code);
  const technical =
    /rejection|controls|read_only|navigation|unavailable|stale|statistics_|observation/.test(code);
  return {
    kind: budget ? 'budget' : technical ? 'technical' : 'evidence',
    code,
    reason: budget
      ? '정답 조사에 배정된 한도를 사용했습니다. 개인 답변이 필요한 문항은 아닙니다.'
      : technical
        ? '앱이 자료 조회 또는 결과 읽기를 끝내지 못했습니다. 사용자만 답할 수 있는 문항은 아닙니다.'
        : code === 'verification_required_manual'
          ? '조사 출처에 인증 화면이 나타나 정답 근거를 확보하지 못했습니다.'
          : '정답을 뒷받침할 자료를 확보하지 못했습니다.',
    planReason: job.autonomy?.plan?.answers.find((a) => a.questionId === q.id)?.reason,
    calls: attempt?.calls,
    legacy: !!legacy,
  };
}

export function knowledgeSummary(job: Job) {
  const state = job.autonomy;
  if (!state) return [];
  // Old paused jobs can display existing plans without rerunning a model or
  // altering their approvals, counters or inbox fingerprint.
  const plans = state.preparedKnowledge?.length
    ? state.preparedKnowledge.map((s) => ({ plan: s.plan, label: s.label, evidence: s.evidence }))
    : (state.plan?.answers || [])
        .filter((p) => p.category === 'knowledge' && p.source === 'evidence' && p.answer?.length)
        .map((p) => ({
          plan: p,
          label: p.questionId.match(/^q(\d+)-/)?.[1]
            ? `퀴즈 ${p.questionId.match(/^q(\d+)-/)![1]}`
            : '준비한 퀴즈',
          evidence: state.evidence?.find((e) => e.id === p.sourceId),
        }));
  return plans
    .filter(
      ({ plan, evidence }) =>
        plan.source !== 'evidence' ||
        (evidence && plan.evidenceQuote && observedQuote(evidence.text, plan.evidenceQuote)),
    )
    .map(({ plan, label, evidence }) => ({
      label,
      answer: plan.answer,
      reason: plan.reason,
      quote: plan.evidenceQuote,
      source:
        plan.source === 'question'
          ? '문항의 공개 설명·표'
          : plan.source === 'evidence'
            ? '관찰한 공개 원문'
            : '문제 해석·계산',
      url: evidence?.url,
    }));
}
