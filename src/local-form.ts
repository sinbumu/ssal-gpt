import type { ElementHandle, Page, Route } from 'playwright';
import { ServiceError } from './auth.js';
import { inspectForm, type FormView } from './forms.js';

type LocalState = {
  blocks: number;
  route: (route: Route) => Promise<void>;
  fields: {
    handle: ElementHandle<HTMLInputElement | HTMLTextAreaElement>;
    value: string;
    label: string;
  }[];
};
const states = new WeakMap<Page, LocalState>();

// A dialog-opening probe is local-only, not authorization to send a form.
// Keep the guard through user review, including requests from a newly opened tab.
export async function holdLocalForm(page: Page) {
  if (states.has(page)) return;
  const state: LocalState = {
    blocks: 0,
    fields: [],
    route: async (route) => {
      let owner: Page | null;
      try {
        owner = route.request().frame().page();
      } catch {
        // The initial popup navigation can precede its frame/page attachment.
        // An unbound request cannot be allowed through a local-only probe.
        state.blocks++;
        return route.abort('blockedbyclient');
      }
      for (let depth = 0; owner && depth < 8; depth++, owner = await owner.opener()) {
        if (owner === page) {
          state.blocks++;
          await route.abort('blockedbyclient');
          return;
        }
      }
      await route.fallback();
    },
  };
  states.set(page, state);
  await page.context().route('**/*', state.route);
  await page.route('**/*', state.route);
  page.once('close', () => {
    void releaseLocalForm(page).catch(() => {});
  });
}

export function localFormBlocks(page: Page) {
  return states.get(page)?.blocks || 0;
}

export async function rememberLocalFields(page: Page, view: FormView) {
  const state = states.get(page);
  if (!state) throw new ServiceError('local_form_not_opened');
  const fresh = await inspectForm(page);
  if (fresh.view.fingerprint !== view.fingerprint) throw new ServiceError('form_structure_changed');
  for (const q of view.questions) {
    const binding = fresh.bindings.get(q.id)!;
    if (q.kind !== 'text' || binding.custom || binding.indices.length !== 1)
      throw new ServiceError('local_form_not_opened');
    const handle = await page
      .locator('input,textarea,select')
      .nth(binding.indices[0]!)
      .elementHandle();
    if (!handle) throw new ServiceError('form_structure_changed');
    state.fields.push({
      handle: handle as ElementHandle<HTMLInputElement | HTMLTextAreaElement>,
      value: await handle.inputValue(),
      label: q.label,
    });
  }
}

export async function localFormReview(page: Page) {
  const state = states.get(page);
  if (!state) throw new ServiceError('autonomy_live_page_required');
  for (const field of state.fields) {
    if (
      !(await field.handle.evaluate(
        (el, value) => el.isConnected && el.value === value,
        field.value,
      ))
    )
      throw new ServiceError('local_form_answers_changed');
  }
  return [
    {
      action: page.url(),
      fields: state.fields.map((f) => ({ label: f.label, type: 'text', value: f.value })),
    },
  ];
}

export async function releaseLocalForm(page: Page) {
  const state = states.get(page);
  if (!state) return;
  await page.context().unroute('**/*', state.route);
  await page.unroute('**/*', state.route).catch(() => {});
  states.delete(page);
  await Promise.all(state.fields.map((f) => f.handle.dispose().catch(() => {})));
}
