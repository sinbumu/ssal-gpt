import type { Browser, Observation } from './browser.js';
import type { Job, Store } from './store.js';
import { hash } from './autonomy.js';
import { observedQuote } from './evidence.js';
import { inspectForm, type FormView } from './forms.js';
import { googleFormId, googleFormState } from './google-form-dom.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const nextLabel = /^(다음|next)$/i;
const finalLine = /^(제출|제출하기|submit|send)$/im;
const backLine = /^(뒤로|이전|back)$/im;

export function googleNextIntent(job: Job) {
  const i = job.intent;
  return !!(
    job.uncertain &&
    i &&
    googleFormId(i.url) &&
    nextLabel.test(i.controlLabel || '') &&
    (!i.providerControl || i.providerControl === 'google-next')
  );
}

// A settled, scoped response is supporting evidence of a Next transition, never
// proof of entry completion. Rejected/accepted/pending receipts remain locked.
function observedNext(job: Job) {
  const i = job.intent,
    c = job.receiptCapture;
  if (
    !googleNextIntent(job) ||
    !i?.at ||
    !c ||
    c.intentHash !== hash(i) ||
    !c.settled ||
    c.lifecycle !== 'closed' ||
    c.pendingTasks ||
    c.requests !== 1 ||
    c.diagnostics?.responses !== 1 ||
    c.diagnostics.failedRequests ||
    c.diagnostics.popups ||
    c.diagnostics.pageClosed ||
    job.receiptDialogs?.length ||
    (job.receiptCheck &&
      (job.receiptCheck.outcome !== 'unconfirmed' ||
        job.receiptCheck.signals.some((s) => s.outcome !== 'unconfirmed')))
  )
    return false;
  const responses = job.receiptResponses?.filter((r) => r.intentHash === hash(i));
  return (
    responses?.length === 1 &&
    responses[0]!.status === 200 &&
    responses[0]!.at >= i.at &&
    googleFormId(responses[0]!.url) === googleFormId(i.url) &&
    new URL(responses[0]!.url).pathname.endsWith('/formResponse')
  );
}

// Old versions recorded the first Google Next as a final submission. Reopening
// is allowed only for that one proven draft, never arbitrary unknown outcomes.
export function savedGoogleContinuation(job: Job) {
  if (
    !observedNext(job) ||
    job.history.filter((h) => h.action === 'form_batch').length !== 1 ||
    job.continuations?.length ||
    !job.intent!.url.endsWith('/viewform') ||
    !/^다음$|^next$/im.test(job.intent!.beforeText) ||
    backLine.test(job.intent!.beforeText) ||
    finalLine.test(job.intent!.beforeText)
  )
    return;
  const i = job.intent!;
  const after = job.receiptObservations
    ?.filter(
      (o) =>
        o.intentHash === hash(i) &&
        o.observedAt >= i.at! &&
        googleFormId(o.url) === googleFormId(i.url) &&
        o.url === job.currentUrl &&
        new URL(o.url).pathname.endsWith('/formResponse'),
    )
    .at(-1);
  if (
    !after ||
    !backLine.test(after.text) ||
    !/^(다음|next|제출|submit)$/im.test(after.text) ||
    after.text === i.beforeText
  )
    return;
  return { after };
}

// Migration for the first adapter revision, which omitted step observations.
// One restored first-Next only: the newly captured result must be byte-identical
// to the previously proven second-page screenshot. No visual similarity/AI guess,
// later-page replay, arbitrary image path or missing file can unlock a draft.
export async function savedRestoredGoogleContinuation(store: Store, job: Job) {
  const i = job.intent,
    prior = job.continuations?.[0];
  if (
    !observedNext(job) ||
    i?.providerControl !== 'google-next' ||
    JSON.stringify(i.googlePage?.history) !== '[0]' ||
    job.receiptObservations?.length ||
    job.continuations?.length !== 1 ||
    !prior ||
    prior.page !== 2 ||
    prior.quote !== '첫 다음 이동만 복원 · 최종 제출 아님' ||
    prior.from !== i.url ||
    prior.at >= i.at! ||
    job.history.filter((h) => h.action === 'form_batch').length !== 2 ||
    job.history.filter((h) => h.action === 'form_draft_restored').length !== 1 ||
    !i.url.endsWith('/viewform') ||
    googleFormId(job.currentUrl || '') !== googleFormId(i.url) ||
    !job.currentUrl?.endsWith('/formResponse') ||
    finalLine.test(i.beforeText) ||
    backLine.test(i.beforeText) ||
    ![prior.screenshot, job.screenshot].every((s) => /^[a-f0-9-]{36}\.png$/.test(s || ''))
  )
    return;
  try {
    const [before, after] = await Promise.all(
      [prior.screenshot, job.screenshot!].map((s) => readFile(join(store.dir, 'evidence', s))),
    );
    if (!before!.length || !before!.equals(after!)) return;
    return { after: { screenshot: job.screenshot!, url: job.currentUrl } };
  } catch {
    return;
  }
}

function recordContinuation(
  store: Store,
  job: Job,
  o: Pick<Observation, 'screenshot' | 'url'>,
  page: number,
  quote: string,
  restart: boolean,
) {
  const legacy = job.intent?.providerControl !== 'google-next';
  job.continuations = [
    ...(job.continuations || []),
    {
      at: Date.now(),
      screenshot: o.screenshot,
      quote,
      from: job.intent!.url,
      page,
    },
  ].slice(-10);
  const reason = restart
    ? '구글폼 첫 다음 단계의 응답·추가 문항 증거를 확인했습니다. 저장한 답변으로 첫 페이지의 다음 이동만 복원하며 최종 제출은 다시 검토합니다.'
    : '같은 구글폼의 다음 입력 단계임을 페이지 경로·뒤로 버튼·새 문항으로 확인했습니다. 현재 문항에서 계속합니다.';
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
    if (legacy || restart) job.autonomy.metrics.recoveries++;
  }
  if (job.eventId) store.markSubmission(job.eventId, 'in_progress');
  job.history.push({
    action: restart ? 'form_draft_restored' : 'form_progress_verified',
    reason,
    url: o.url,
  });
  job.note = reason;
  store.saveJob(job);
  store.note(job.id, reason);
}

export async function verifyGoogleContinuation(
  store: Store,
  browser: Browser,
  job: Job,
  o: Observation,
  view: FormView,
) {
  const marker = view.googlePage,
    i = job.intent;
  if (!i) return false;
  // A native Next with a recorded section path can lead to optional-only
  // questions (for example, contact details for a prize draw). Requiredness is
  // not navigation evidence. Legacy intents keep their stricter required-field
  // rule because they do not carry the same verified control/path metadata.
  const nativeStep = i.kind === 'step' && i.providerControl === 'google-next' && i.googlePage;
  const newQuestion = view.questions.find(
    (q) =>
      (q.required || nativeStep) &&
      !observedQuote(i.beforeText, q.label) &&
      (!i.googlePage || !i.googlePage.signatures.includes(q.signature)),
  );
  if (
    browser.ownerJobId !== job.id ||
    !observedNext(job) ||
    googleFormId(o.url) !== googleFormId(i.url) ||
    !marker?.back ||
    marker.first ||
    !view.buttons.some((b) => b.providerControl?.startsWith('google-')) ||
    !newQuestion
  )
    return false;
  const before = i.googlePage?.history;
  if (before) {
    if (
      marker.history.length !== before.length + 1 ||
      !before.every((p, n) => marker.history[n] === p) ||
      before.includes(marker.history.at(-1)!)
    )
      return false;
  } else if (marker.history.length !== 2 || !savedGoogleContinuation(job)) return false;
  await browser.assertFresh(o.id, 'navigate');
  if ((await inspectForm(browser.page!)).view.fingerprint !== view.fingerprint) return false;
  recordContinuation(store, job, o, marker.history.length, newQuestion.label, false);
  return true;
}

export async function restoreGoogleDraft(store: Store, browser: Browser, job: Job) {
  const proof = savedGoogleContinuation(job) || (await savedRestoredGoogleContinuation(store, job)),
    page = browser.page;
  if (
    !proof ||
    !page ||
    browser.engine === 'connected' ||
    !['about:blank', job.intent!.url].includes(page.url())
  )
    return false;
  const before = job.intent!.beforeText,
    original = job.intent!.url;
  // Only GET the original first page. No direct endpoint calls or replayed body.
  browser.setReadOnlyMode(true);
  if (page.url() === 'about:blank') await browser.navigate(original);
  await page.waitForTimeout(500);
  const { view } = await inspectForm(page);
  if (
    view.url !== original ||
    !view.googlePage?.first ||
    view.googlePage.back ||
    !view.buttons.some((b) => b.providerControl === 'google-next') ||
    !view.questions.length ||
    !view.questions.every((q) => q.kind !== 'file' && observedQuote(before, q.label)) ||
    // Restoration may reuse only the user's exact first-page answers. No model
    // guesses, new permissions or changed questions/options are replayed.
    !view.questions.every((q) => job.autonomy?.overrides[q.signature])
  )
    return false;
  const o = await browser.observe(true, [
    ...Object.values(job.autonomy?.profile || {}),
    ...(job.autonomy?.privateAnswers || []),
  ]);
  await browser.assertFresh(o.id, 'navigate');
  if (JSON.stringify(await googleFormState(page)) !== JSON.stringify(view.googlePage)) return false;
  recordContinuation(store, job, proof.after, 2, '첫 다음 이동만 복원 · 최종 제출 아님', true);
  browser.ownerJobId = job.id;
  return true;
}
