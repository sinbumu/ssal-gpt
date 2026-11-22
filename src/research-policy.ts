import { createHash } from 'node:crypto';
import type { Job } from './store.js';

export type ResearchProgress = {
  calls: number;
  priorAllocation?: number;
  capacity?: number;
  searches: string[];
  failedUrls: string[];
  stops: { code: string; at: number }[];
};

function chargedResearch(job: Job) {
  const progress = job.autonomy?.researchProgress;
  return progress
    ? progress.calls + (progress.priorAllocation || 0)
    : job.autonomy?.researched?.length
      ? job.steps
      : 0;
}

// An explicit, job-local extension adds allocation, never refunds past calls.
// Freeze the conservative legacy charge before retry clears unresolved signatures.
export function extendDecisionBudget(job: Job, extra: 20 | 40 | 80) {
  const added = Math.min(extra, Math.max(0, 300 - job.maxSteps));
  if (!added) return 0;
  if (job.autonomy) {
    const charged = chargedResearch(job);
    const progress = (job.autonomy.researchProgress ??= {
      calls: 0,
      priorAllocation: charged,
      searches: [],
      failedUrls: [],
      stops: [],
    });
    progress.capacity =
      Math.max(progress.capacity ?? Math.floor(job.maxSteps * 0.65), charged) +
      Math.floor(added * 0.65);
  }
  job.maxSteps += added;
  return added;
}

export function researchBudget(job: Job, pending = 1) {
  // These are allocations inside the existing job cap, never extra calls.
  const reserve = Math.max(4, Math.ceil(job.maxSteps * 0.15));
  const progress = job.autonomy?.researchProgress;
  const calls = chargedResearch(job);
  const remaining = Math.max(
    0,
    Math.min(
      job.maxSteps - job.steps - reserve,
      (progress?.capacity ?? Math.floor(job.maxSteps * 0.65)) - calls,
    ),
  );
  return {
    reserve,
    remaining,
    allowance: Math.min(10, Math.ceil(remaining / Math.max(1, pending))),
  };
}

export function searchTerms(query: string) {
  return [
    ...new Set(
      query
        .normalize('NFKC')
        .toLowerCase()
        .replace(/site:\S+/g, '')
        .match(/[\p{L}\p{N}]+/gu) || [],
    ),
  ]
    .sort()
    .join(' ');
}
export function repeatedSearch(previous: string[], query: string) {
  const words = new Set(searchTerms(query).split(' ').filter(Boolean));
  return previous.some((q) => {
    const old = new Set(q.split(' ').filter(Boolean));
    const union = new Set([...words, ...old]);
    const common = [...words].filter((w) => old.has(w)).length;
    return union.size > 0 && common / union.size >= 0.8;
  });
}
export function researchFingerprint(url: string, text: string, controls: unknown) {
  return createHash('sha256')
    .update(JSON.stringify([url, text.replace(/\s+/g, ' '), controls]))
    .digest('hex');
}
