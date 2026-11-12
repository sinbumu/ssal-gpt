import type { Page } from 'playwright';

export function googleFormId(url: string) {
  try {
    const u = new URL(url);
    if (u.origin !== 'https://docs.google.com' || u.username || u.password) return;
    return u.pathname.match(
      /^\/forms\/d\/(?:e\/)?([A-Za-z0-9_-]{5,160})\/(?:viewform|formResponse)$/,
    )?.[1];
  } catch {
    /* Not a supported public Google form. */
  }
}

// DOM navigation metadata only. Never read partialResponse, fbzx, answer values,
// cookies or Google client internals. The counter is a path, not a page total:
// branching can skip section numbers.
export async function googleFormState(page: Page) {
  if (!googleFormId(page.url())) return;
  return page.evaluate(() => {
    const id = location.pathname.match(
      /^\/forms\/d\/(?:e\/)?([A-Za-z0-9_-]{5,160})\/(?:viewform|formResponse)$/,
    )?.[1];
    const forms = [...document.forms];
    const eligible = forms.filter((f) => {
      const u = new URL(f.action);
      return (
        f.method.toLowerCase() === 'post' &&
        u.origin === location.origin &&
        u.pathname === location.pathname.replace(/\/(viewform|formResponse)$/, '/formResponse') &&
        !u.search &&
        !u.hash
      );
    });
    if (!id || eligible.length !== 1) return;
    const form = eligible[0]!;
    const paths = form.querySelectorAll<HTMLInputElement>('input[type=hidden][name=pageHistory]');
    if (paths.length !== 1 || !/^0(?:,\d{1,4}){0,99}$/.test(paths[0]!.value)) return;
    const history = paths[0]!.value.split(',').map(Number);
    const first = form.getAttribute('data-is-first-page');
    if (!['true', 'false'].includes(first || '') || (first === 'true') !== (history.length === 1))
      return;
    const controls = [...form.querySelectorAll<HTMLElement>('[role=button],button')].filter(
      (b) =>
        !!b.getClientRects().length &&
        getComputedStyle(b).visibility !== 'hidden' &&
        b.getAttribute('aria-disabled') !== 'true' &&
        !b.hasAttribute('disabled'),
    );
    const next = controls.filter(
      (b) =>
        b.getAttribute('role') === 'button' &&
        b.getAttribute('jsname') === 'OCpkoe' &&
        /^(다음|next)$/i.test(b.innerText.trim()),
    );
    const submit = controls.filter((b) => /^(제출|submit)$/i.test(b.innerText.trim()));
    const back = controls.filter((b) => /^(뒤로|이전|back)$/i.test(b.innerText.trim()));
    if ((next.length !== 1 || submit.length) && (submit.length !== 1 || next.length)) return;
    if (back.length > 1 || (first === 'true' && back.length)) return;
    return {
      history,
      first: first === 'true',
      back: back.length === 1,
      next: next.length === 1,
      submit: submit.length === 1,
      form: forms.indexOf(form),
    };
  });
}
