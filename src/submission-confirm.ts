import type { Dialog, Page } from 'playwright';

type Grant = { url: string; expires: number; valid: () => boolean };
const grants = new WeakMap<Page, Grant>();

// This only repeats the approved final-submit intent. Consent, payment, prompts,
// unrelated tabs and later confirmations never inherit that authorization.
export function armSubmissionConfirm(page: Page, valid: () => boolean) {
  const grant = { url: page.url(), expires: Date.now() + 15_000, valid };
  grants.set(page, grant);
  return () => {
    if (grants.get(page) === grant) grants.delete(page);
  };
}

export function acceptsSubmissionConfirm(dialog: Dialog) {
  const page = dialog.page(),
    grant = page && grants.get(page);
  if (!page || !grant || dialog.type() !== 'confirm') return false;
  grants.delete(page); // At most one attempt, including an unexpected prompt.
  return (
    Date.now() <= grant.expires &&
    grant.valid() &&
    page.url() === grant.url &&
    page
      .frames()
      .every(
        (f) => f === page.mainFrame() || ['about:blank', 'about:srcdoc', ''].includes(f.url()),
      ) &&
    /^(?:(?:이벤트에?|설문을?)\s*)?(?:참여|응모|제출|접수|등록)(?:\s*하시겠습니까|\s*할까요)\s*[?？]$/.test(
      dialog.message().trim(),
    )
  );
}
