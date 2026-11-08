import type { Page } from 'playwright';
import { hash, type Question } from './autonomy.js';
import { ServiceError } from './auth.js';

export type FormView = {
  url: string;
  fingerprint: string;
  questions: Question[];
  buttons: { id: string; label: string; action: string; form: number }[];
};
type Binding = { indices: number[]; optionValues: string[] };
// Rendered native controls only. Custom widgets are handed back to the visual/manual path.
export async function inspectForm(page: Page) {
  const raw = await page.evaluate(() => {
    const all = [
      ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        'input,textarea,select',
      ),
    ];
    const helpers = {
      visible(el: Element) {
        const s = getComputedStyle(el);
        return !!el.getClientRects().length && s.display !== 'none' && s.visibility !== 'hidden';
      },
      label(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
        return (
          el.getAttribute('aria-label') ||
          (el.getAttribute('aria-labelledby') || '')
            .split(' ')
            .map((id) => document.getElementById(id)?.textContent || '')
            .join(' ')
            .trim() ||
          [...(el.labels || [])].map((l) => l.textContent?.trim()).join(' ') ||
          el.getAttribute('placeholder') ||
          el.name
        );
      },
    };
    const groups: {
      label: string;
      description: string;
      kind: 'text' | 'radio' | 'checkbox' | 'select';
      required: boolean;
      multiple: boolean;
      options: { label: string; value: string }[];
      indices: number[];
      form: number;
    }[] = [];
    const forms = [...document.forms];
    const seen = new Set<number>();
    for (let index = 0; index < all.length; index++) {
      const el = all[index]!;
      if (
        seen.has(index) ||
        el.disabled ||
        ['hidden', 'submit', 'button', 'reset', 'password', 'file'].includes(el.type)
      )
        continue;
      if (!helpers.visible(el) && ![...(el.labels || [])].some(helpers.visible)) continue;
      const kind =
        el instanceof HTMLSelectElement
          ? 'select'
          : ['radio', 'checkbox'].includes(el.type)
            ? (el.type as 'radio' | 'checkbox')
            : 'text';
      const group =
        (kind === 'radio' || kind === 'checkbox') && el.name
          ? all.filter(
              (other) =>
                other.type === el.type &&
                other.name === el.name &&
                other.form === el.form &&
                !other.disabled &&
                (helpers.visible(other) || [...(other.labels || [])].some(helpers.visible)),
            )
          : [el];
      const indices = group.map((e) => all.indexOf(e));
      indices.forEach((i) => seen.add(i));
      const fieldset = el.closest('fieldset,[role=group],[role=radiogroup]');
      const describedBy = (el.getAttribute('aria-describedby') || '')
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((node): node is HTMLElement => !!node && helpers.visible(node))
        .map((node) => node.innerText)
        .join('\n');
      const heading = fieldset
        ?.querySelector('legend,h1,h2,h3,h4,[role=heading]')
        ?.textContent?.trim();
      const questionLabel = (
        heading ||
        (group.length > 1 ? fieldset?.getAttribute('aria-label') : '') ||
        helpers.label(el) ||
        `입력 ${index + 1}`
      ).slice(0, 1000);
      const options =
        kind === 'select'
          ? [...(el as HTMLSelectElement).options]
              .filter((o) => !o.disabled && o.value !== '')
              .map((o) => ({ label: o.label, value: o.value }))
          : kind === 'radio' || kind === 'checkbox'
            ? group.map((e) => ({ label: helpers.label(e).slice(0, 500), value: e.value }))
            : [];
      groups.push({
        label: questionLabel,
        description: [describedBy, fieldset instanceof HTMLElement ? fieldset.innerText : '']
          .filter(Boolean)
          .join('\n')
          .slice(0, 3000),
        kind,
        required:
          group.some((e) => e.required) ||
          fieldset?.getAttribute('aria-required') === 'true' ||
          /답변\s*필수/.test(questionLabel),
        multiple: kind === 'checkbox' || (el instanceof HTMLSelectElement && el.multiple),
        options,
        indices,
        form: forms.indexOf(el.form!),
      });
    }
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
        'button,input[type=submit]',
      ),
    ]
      .map((b, index) => ({
        index,
        label: (b.textContent || b.value || '').trim(),
        action: b.formAction || b.form?.action || location.href,
        form: forms.indexOf(b.form!),
        visible: helpers.visible(b),
        disabled: b.disabled,
        type: b.type,
      }))
      .filter(
        (b) =>
          b.visible &&
          !b.disabled &&
          (b.type === 'submit' || /^(다음|next|continue|제출|응모하기|submit)$/i.test(b.label)),
      );
    return { groups, buttons, forms: forms.map((f) => ({ action: f.action, method: f.method })) };
  });
  const bindings = new Map<string, Binding>();
  const questions: Question[] = raw.groups.map((g, i) => {
    const options = g.options.map((o) => ({ id: o.label, label: o.label }));
    if (new Set(options.map((o) => o.id)).size !== options.length)
      throw new ServiceError('ambiguous_form_options');
    const signature = hash({
      label: g.label.replace(/\s+/g, ' ').trim(),
      description: g.description.replace(/\s+/g, ' ').trim(),
      kind: g.kind,
      options: options.map((o) => o.label),
    });
    const id = `q${i + 1}-${signature.slice(0, 12)}`;
    bindings.set(id, { indices: g.indices, optionValues: g.options.map((o) => o.value) });
    return {
      id,
      signature,
      label: g.label,
      description: g.description,
      kind: g.kind,
      required: g.required,
      multiple: g.multiple,
      maxChoices: g.multiple
        ? Number(g.label.match(/(?:최대|max(?:imum)?)\s*(\d+)/i)?.[1]) || undefined
        : 1,
      options,
    };
  });
  if (new Set(raw.groups.map((g) => g.form)).size > 1)
    throw new ServiceError('multiple_forms_require_manual_selection');
  const buttons = raw.buttons.map((b) => ({
    id: `b${b.index}`,
    label: b.label,
    action: b.action,
    form: b.form,
  }));
  const view: FormView = {
    url: page.url(),
    questions,
    buttons,
    fingerprint: hash({
      url: page.url(),
      questions,
      buttons,
      forms: raw.forms,
      bindings: [...bindings],
    }),
  };
  return { view, bindings };
}
export async function applyAnswers(
  page: Page,
  expected: FormView,
  answers: Map<string, string[]>,
  onField: () => void,
  signal: AbortSignal,
) {
  for (const question of expected.questions) {
    const answer = answers.get(question.id);
    if (!answer) continue;
    const fresh = await inspectForm(page);
    if (fresh.view.fingerprint !== expected.fingerprint)
      throw new ServiceError('form_structure_changed');
    const binding = fresh.bindings.get(question.id)!;
    const controls = page.locator('input,textarea,select');
    for (let i = 0; i < binding.indices.length; i++) {
      signal.throwIfAborted();
      // Every action rebinds and checks structure; never replay stale element references.
      if ((await inspectForm(page)).view.fingerprint !== expected.fingerprint)
        throw new ServiceError('form_structure_changed');
      const control = controls.nth(binding.indices[i]!);
      if (question.kind === 'text') {
        if ((await control.inputValue()) !== answer[0]) await control.fill(answer[0] || '');
        if ((await control.inputValue()) !== answer[0])
          throw new ServiceError('field_verification_failed');
      } else if (question.kind === 'select') {
        const values = answer.map(
          (a) => binding.optionValues[question.options.findIndex((o) => o.id === a)]!,
        );
        await control.selectOption(values);
        const selected = await control.evaluate((el) =>
          [...(el as HTMLSelectElement).selectedOptions].map((o) => o.value),
        );
        if (hash(selected.slice().sort()) !== hash(values.slice().sort()))
          throw new ServiceError('field_verification_failed');
      } else {
        const checked = answer.includes(question.options[i]!.id);
        if ((await control.isChecked()) !== checked) {
          try {
            await control.setChecked(checked, { timeout: 1200 });
          } catch {
            // A styled input can be covered by its label. Check state before fallback.
            if ((await control.isChecked()) !== checked) {
              if ((await inspectForm(page)).view.fingerprint !== expected.fingerprint)
                throw new ServiceError('form_structure_changed');
              const label = await control.evaluateHandle(
                (el) => (el as HTMLInputElement).labels?.[0],
              );
              try {
                const element = label.asElement();
                if (!element) throw new ServiceError('field_not_actionable');
                await element.click({ timeout: 1500 });
              } finally {
                await label.dispose();
              }
            }
          }
        }
        if ((await control.isChecked()) !== checked)
          throw new ServiceError('field_verification_failed');
      }
    }
    onField();
  }
}
export async function formValuesHash(page: Page) {
  return hash(
    await page.locator('input,textarea,select').evaluateAll((els) =>
      els
        .filter((el) => !['hidden', 'password'].includes((el as HTMLInputElement).type))
        .map((el) => ({
          value: (el as HTMLInputElement).value,
          checked: (el as HTMLInputElement).checked,
        })),
    ),
  );
}
export async function advanceForm(
  page: Page,
  expected: FormView,
  buttonId: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if ((await inspectForm(page)).view.fingerprint !== expected.fingerprint)
    throw new ServiceError('form_structure_changed');
  const button = expected.buttons.find((b) => b.id === buttonId);
  if (!button) throw new ServiceError('unobserved_form_button');
  const locator = page.locator('button,input[type=submit]').nth(Number(buttonId.slice(1)));
  const valid = await locator.evaluate(
    (el) => !(el as HTMLButtonElement).form || (el as HTMLButtonElement).form!.checkValidity(),
  );
  if (!valid) throw new ServiceError('form_validation_failed');
  await locator.click({ timeout: 6000 });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(200);
}
