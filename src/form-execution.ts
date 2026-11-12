import type { Job } from './store.js';
import { hash } from './autonomy.js';

// Definition, entered values and transport outcome have separate lifetimes.
// No answers or raw DOM are stored in this journal.
export type FormExecution = {
  input?: {
    state: 'applying' | 'verified';
    definition: string;
    values?: string;
    fields: number;
    at: number;
  };
  transition?: {
    state: 'observing' | 'blocked' | 'verified';
    intentHash: string;
    attempts: number;
    at: number;
    reason?: string;
  };
  submission?: { state: 'review' | 'observing' | 'accepted' | 'unconfirmed'; at: number };
  pages: {
    at: number;
    definition?: string;
    attempts: number;
    screenshot?: string;
    requests: number;
    statuses: number[];
    reason: string;
  }[];
};
export function formExecution(job: Job) {
  return (job.formExecution ||= { pages: [] });
}
export function pendingFormStep(job: Job) {
  return (
    job.intent?.kind === 'step' &&
    (job.uncertain || ['observing', 'blocked'].includes(job.formExecution?.transition?.state || ''))
  );
}
export function pendingFormAction(job: Job) {
  return job.uncertain || pendingFormStep(job);
}
export function beginFormAction(job: Job) {
  const state = formExecution(job);
  if (job.intent?.kind === 'step') {
    job.uncertain = false;
    state.transition = {
      state: 'observing',
      intentHash: hash(job.intent),
      attempts: 0,
      at: Date.now(),
    };
  } else {
    job.uncertain = true;
    state.submission = { state: 'observing', at: Date.now() };
  }
}
export function recordFormTransition(job: Job, reason: string) {
  const state = formExecution(job);
  state.pages = [
    ...state.pages,
    {
      at: Date.now(),
      definition: state.input?.definition,
      attempts: state.transition?.attempts || 1,
      screenshot: job.screenshot,
      requests: job.receiptCapture?.requests || 0,
      statuses: (job.receiptResponses || []).map((r) => r.status),
      reason,
    },
  ].slice(-100);
  if (state.transition) {
    state.transition.state = 'verified';
    state.transition.reason = reason;
  }
  delete state.input;
}
