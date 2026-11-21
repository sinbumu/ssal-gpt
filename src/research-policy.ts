import { createHash } from 'node:crypto';
import type { Job } from './store.js';

export type ResearchProgress = {
  calls: number;
  priorAllocation?: number;
  searches: string[];
  failedUrls: string[];
  stops: { code: string; at: number }[];
};

export function researchBudget(job: Job, pending = 1) {
  // These are allocations inside the existing job cap, never extra calls.
  const reserve = Math.max(4, Math.ceil(job.maxSteps * 0.15));
  const progress = job.autonomy?.researchProgress;
  const calls = progress
    ? progress.calls + (progress.priorAllocation || 0)
    : job.autonomy?.researched?.length
      ? job.steps
      : 0;
  const remaining = Math.max(
    0,
    Math.min(job.maxSteps - job.steps - reserve, Math.floor(job.maxSteps * 0.65) - calls),
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
