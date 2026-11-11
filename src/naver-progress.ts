import type { Browser, Observation } from './browser.js';
import type { Job, Store } from './store.js';
import { hash } from './autonomy.js';
import { observedQuote } from './evidence.js';
import { inspectForm, type FormView } from './forms.js';
import { pageProgress } from './page-progress.js';

// The published Naver client distinguishes next/submit with separate DOM IDs.
// Recovery additionally requires a completely observed interval with no POST,
// not merely the absence of a matched response or an HTTP 200.
function noPostNext(job: Job) {
  const intent = job.intent,
    capture = job.receiptCapture;
  if (
    !job.uncertain ||
    !intent ||
    !intent.at ||
    !capture ||
    !/^https:\/\/form\.naver\.com\/response\/[A-Za-z0-9_-]{5,100}\/?$/.test(intent.url) ||
    job.currentUrl !== intent.url ||
    !/^(다음|next)$/i.test(intent.controlLabel || '') ||
    (intent.providerControl && intent.providerControl !== 'naver-next') ||
    capture.intentHash !== hash(intent) ||
    !capture.settled ||
    capture.requests !== 0 ||
    capture.diagnostics?.observedPosts !== 0 ||
    capture.diagnostics.responses !== 0 ||
    Object.keys(capture.diagnostics.rejected).length ||
    job.receiptResponses?.length ||
    job.receiptDialogs?.length ||
    (job.receiptCheck && job.receiptCheck.outcome !== 'unconfirmed')
  )
    return false;
  return true;
}

export function savedNaverContinuation(job: Job) {
  if (!noPostNext(job) || job.history.filter((h) => h.action === 'form_batch').length !== 1) return;
  const intent = job.intent!;
  const after = job.receiptObservations
    ?.filter(
      (o) => o.url === intent.url && o.intentHash === hash(intent) && o.observedAt >= intent.at!,
    )
    .at(-1);
  const progress = after && pageProgress(after.text, after.url);
  // Narrow first-Next migration. A later page, validation error, final submit,
  // changed survey, incomplete capture or unobserved state cannot be restarted.
  if (
    !after ||
    progress?.current !== 2 ||
    !/^이전$|^previous$|^back$/im.test(after.text) ||
    !/^설문 진행 상태$/m.test(intent.beforeText) ||
    /^(제출|제출하기|submit|send)$/im.test(intent.beforeText)
  )
    return;
  return { after, progress };
}

function recordContinuation(
  store: Store,
  job: Job,
  o: Pick<Observation, 'screenshot' | 'url'>,
  page: number,
  quote: string,
  restart: boolean,
) {
  job.continuations = [
    ...(job.continuations || []),
    {
      at: Date.now(),
      screenshot: o.screenshot,
      quote,
      from: o.url,
      page,
    },
  ].slice(-10);
  job.uncertain = false;
  delete job.intent;
  delete job.receiptObservations;
  delete job.receiptDialogs;
  delete job.receiptResponses;
  delete job.receiptCapture;
  delete job.receiptCheck;
  delete job.receiptAiAttempts;
  if (job.autonomy) {
    delete job.autonomy.plan;
    delete job.autonomy.finalApproval;
    delete job.autonomy.inbox;
    job.autonomy.metrics.recoveries++;
  }
  if (job.eventId) store.markSubmission(job.eventId, 'in_progress');
  const reason = restart
    ? '서버 제출 없이 첫 다음 단계로 이동한 기록을 확인했습니다. 종료된 폼을 다시 열어 저장된 답변을 복원하며 최종 제출은 다시 검토합니다.'
    : '네이버 폼의 다음 입력 단계이며 서버 제출 요청은 없음을 확인했습니다. 현재 화면에서 계속합니다.';
  job.history.push({
    action: restart ? 'form_draft_restored' : 'form_progress_verified',
    reason,
    url: o.url,
  });
  job.note = reason;
  store.saveJob(job);
  store.note(job.id, reason);
}

export async function verifyNaverContinuation(
  store: Store,
  browser: Browser,
  job: Job,
  o: Observation,
  view: FormView,
) {
  if (
    browser.ownerJobId !== job.id ||
    !noPostNext(job) ||
    o.url !== job.intent!.url ||
    !view.questions.some((q) => q.required) ||
    view.questions.some((q) => observedQuote(job.intent!.beforeText, q.label)) ||
    !view.buttons.some((b) => b.providerControl)
  )
    return false;
  const progress = pageProgress(o.text, o.url);
  const before = job.intent!.progress;
  if (
    !progress ||
    (before
      ? progress.current <= before.current || progress.total !== before.total
      : job.intent!.providerControl === 'naver-next'
        ? progress.current < 2
        : !savedNaverContinuation(job))
  )
    return false;
  const back = browser.page!.locator('#nsv_page_control_prev');
  if ((await back.count()) !== 1 || !(await back.isVisible()) || !(await back.isEnabled()))
    return false;
  await browser.assertFresh(o.id, 'navigate');
  recordContinuation(
    store,
    job,
    o,
    progress.current,
    view.questions.find((q) => q.required)!.label,
    false,
  );
  return true;
}

// Only a lost first-page draft can be reopened, using stored no-POST + next-page
// evidence. Live unrelated pages and any possible final submission stay locked.
export async function restoreNaverDraft(store: Store, browser: Browser, job: Job) {
  const proof = savedNaverContinuation(job),
    page = browser.page;
  if (
    !proof ||
    !page ||
    browser.engine === 'connected' ||
    !['about:blank', job.intent!.url].includes(page.url())
  )
    return false;
  const before = job.intent!.beforeText;
  if (page.url() === 'about:blank') await browser.navigate(job.intent!.url);
  const { view } = await inspectForm(browser.page!);
  if (
    view.url !== job.intent!.url ||
    !view.questions.length ||
    view.questions.some((q) => q.kind === 'file') ||
    !view.questions.every((q) => observedQuote(before, q.label)) ||
    !view.buttons.some((b) => b.providerControl === 'naver-next') ||
    (await browser.page!.locator('#nsv_page_control_prev').count())
  )
    return false;
  recordContinuation(
    store,
    job,
    proof.after,
    proof.progress.current,
    '제출 요청 0건 · 같은 폼 첫 다음 단계의 저장 증거',
    true,
  );
  browser.ownerJobId = job.id;
  return true;
}
