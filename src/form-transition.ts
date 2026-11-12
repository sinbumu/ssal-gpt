import type { Store, Job } from './store.js';
import type { Browser, Observation } from './browser.js';
import type { ModelClient } from './model.js';
import type { FormView } from './forms.js';
import { formExecution, recordFormTransition } from './form-execution.js';
import {
  googleNextIntent,
  googleTransitionReason,
  verifyGoogleContinuation,
} from './google-progress.js';
import { verifyNaverContinuation } from './naver-progress.js';
import { verifyFormContinuation } from './form-progress.js';
import { pageProgress } from './page-progress.js';

// This stage never enters values, advances a page or evaluates final receipts.
export async function verifyPageTransition(
  store: Store,
  browser: Browser,
  model: ModelClient,
  job: Job,
  o: Observation,
  view: FormView,
  signal: AbortSignal,
) {
  const flow = formExecution(job);
  if (flow.transition) flow.transition.attempts++;
  if (googleNextIntent(job)) {
    if (await verifyGoogleContinuation(store, browser, job, o, view)) return true;
    if (flow.transition) flow.transition.reason = googleTransitionReason(job, view);
    return false;
  }
  if (await verifyNaverContinuation(store, browser, job, o, view)) return true;
  // Native counters are sufficient only for a recorded Next in the same form.
  const i = job.intent,
    p = pageProgress(o.text, o.url);
  if (
    i?.kind === 'step' &&
    i.progress &&
    p &&
    o.url === i.url &&
    p.current > i.progress.current &&
    p.total === i.progress.total &&
    view.buttons.length &&
    browser.ownerJobId === job.id
  ) {
    await browser.assertFresh(o.id, 'navigate');
    recordFormTransition(job, '같은 폼의 페이지 번호 증가 확인');
    job.uncertain = false;
    delete job.intent;
    delete job.receiptObservations;
    delete job.receiptResponses;
    delete job.receiptCapture;
    if (job.eventId) store.markSubmission(job.eventId, 'in_progress');
    return true;
  }
  if (
    job.steps < job.maxSteps &&
    view.questions.length &&
    (await verifyFormContinuation(store, browser, model, job, o, view, signal))
  )
    return true;
  if (flow.transition) flow.transition.reason = 'step_page_or_controls_unverified';
  return false;
}
