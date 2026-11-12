import type { Page } from 'playwright';
import type { Job } from './store.js';
import type { SubmissionResponse } from './submission-response.js';
import { receiptTextOutcome } from './submission-response.js';
import { googleFormId } from './google-form-dom.js';
import { observedQuote } from './evidence.js';
import { hash } from './autonomy.js';

export type GoogleConfirmationView = { formId: string; message: string };

// This is a rendered provider component, not a receipt by itself. Form closure,
// errors and custom prose still need the bound final response and text checks.
export async function observeGoogleConfirmation(page: Page) {
  const formId = googleFormId(page.url());
  if (!formId || !new URL(page.url()).pathname.endsWith('/formResponse')) return;
  const message = await page.evaluate(() => {
    const helpers = {
      visible(e: Element) {
        return !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
      },
    };
    if (
      document.forms.length ||
      [
        ...document.querySelectorAll(
          'input:not([type=hidden]),textarea,select,[role=radio],[role=checkbox],[role=listbox],[contenteditable=true]',
        ),
      ].some(helpers.visible)
    )
      return;
    const messages = [...document.querySelectorAll<HTMLElement>('.idZHHb > .vHW8K')].filter(
      helpers.visible,
    );
    if (messages.length !== 1) return;
    const text = messages[0]!.innerText.trim();
    return text.length >= 4 && text.length <= 1000 ? text : undefined;
  });
  return message ? { formId, message } : undefined;
}

export function boundGoogleConfirmation(
  job: Job,
  screen: NonNullable<Job['receiptObservations']>[number] | undefined,
  network: SubmissionResponse[],
) {
  const intent = job.intent,
    capture = job.receiptCapture,
    marker = screen?.googleConfirmation;
  if (
    !job.uncertain ||
    intent?.kind !== 'submission' ||
    intent.providerControl !== 'google-submit' ||
    !/^(제출|submit)$/i.test(intent.controlLabel || '') ||
    !intent.at ||
    !marker ||
    !screen ||
    marker.formId !== googleFormId(intent.url) ||
    marker.formId !== googleFormId(screen.url) ||
    !new URL(screen.url).pathname.endsWith('/formResponse') ||
    capture?.intentHash !== screen.intentHash ||
    capture.intentHash !== hash(intent) ||
    !capture.settled ||
    capture.lifecycle !== 'closed' ||
    capture.pendingTasks !== 0 ||
    capture.requests !== 1 ||
    capture.diagnostics?.responses !== 1 ||
    capture.diagnostics.failedRequests ||
    network.length !== 1 ||
    network[0]!.status !== 200 ||
    network[0]!.intentHash !== screen.intentHash ||
    network[0]!.at < intent.at ||
    screen.observedAt < network[0]!.at ||
    marker.formId !== googleFormId(network[0]!.url) ||
    !new URL(network[0]!.url).pathname.endsWith('/formResponse') ||
    intent.beforeText.includes(marker.message)
  )
    return;
  const quote = observedQuote(screen.text, marker.message);
  if (
    !quote ||
    !['accepted', 'unconfirmed'].includes(receiptTextOutcome(quote)) ||
    /(?:응답|설문|접수).{0,30}(?:받지|종료|마감|중단)|no longer|not accepting|closed|unavailable/i.test(
      quote,
    )
  )
    return;
  return quote;
}

// A thank-you is deterministic evidence only inside the fully bound provider
// result above. Unfamiliar custom messages remain candidates for semantic review.
export function responseAcknowledgement(text: string) {
  return (
    /^(?:응답|답변|설문(?:조사)?|참여|제출).{0,30}(?:주셔서|주신).{0,15}감사(?:합니다|드립니다)[.!。！]?$/u.test(
      text.replace(/\s/g, ''),
    ) ||
    /^thank you for (?:your (?:response|submission|answers?)|(?:responding|answering|submitting|completing)\b.{0,80})[.!]?$/i.test(
      text.trim(),
    )
  );
}
