import type { Page } from 'playwright';
import { hash, type Question } from './autonomy.js';
import { ServiceError } from './auth.js';

export type FormView = {
  url: string;
  fingerprint: string;
  questions: Question[];
  buttons: { id: string; label: string; action: string; form: number }[];
};
type Binding = { indices: number[]; optionValues: string[]; custom?: 'moa-radio' | 'notice' };
export const isMoaform = (page: Page) => new URL(page.url()).hostname === 'answer.moaform.com';
// Bind rendered controls only; never read provider-private response state.
export async function inspectForm(page: Page) {
  const raw = await page.evaluate(() => {
    const moa = location.hostname === 'answer.moaform.com';
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
      custom?: 'moa-radio' | 'notice';
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
      const fieldset = el.closest(
        'fieldset,[role=group],[role=radiogroup]' + (moa ? ',.js-question' : ''),
      );
      const describedBy = (el.getAttribute('aria-describedby') || '')
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((node): node is HTMLElement => !!node && helpers.visible(node))
        .map((node) => node.innerText)
        .join('\n');
      const heading = fieldset
        ?.querySelector('legend,h1,h2,h3,h4,[role=heading],.js-question-content')
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
        description: [
          describedBy,
          moa && fieldset?.matches('.js-question')
            ? [
                heading,
                fieldset.querySelector('.wf-style-textanswer__placeholder')?.textContent?.trim(),
              ]
                .filter(Boolean)
                .join('\n')
            : fieldset instanceof HTMLElement
              ? fieldset.innerText
              : '',
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 3000),
        kind,
        required:
          group.some((e) => e.required) ||
          fieldset?.getAttribute('aria-required') === 'true' ||
          (moa && !!fieldset?.querySelector('.wf-icon-required')) ||
          /답변\s*필수/.test(questionLabel),
        multiple: kind === 'checkbox' || (el instanceof HTMLSelectElement && el.multiple),
        options,
        indices,
        form: forms.indexOf(el.form!),
      });
    }
    if (moa) {
      const choices = [...document.querySelectorAll('.js-question .select-one-and-many')];
      for (const block of document.querySelectorAll<HTMLElement>('.js-question')) {
        if (!helpers.visible(block)) continue;
        const options = [...block.querySelectorAll('.select-one-and-many')];
        if (!options.length) {
          const native = [...block.querySelectorAll('textarea,input:not([type=hidden]),select')];
          if (
            native.length !== 1 ||
            !groups.some((g) => g.indices.includes(all.indexOf(native[0] as HTMLInputElement)))
          )
            throw new Error('unsupported_moaform_question');
          continue;
        }
        // Other, multiple, rank and media choices need their own verified binding.
        if (
          options.some(
            (e) => !e.querySelector('.wf-radio .fi-radio-btn-no,.wf-radio .fi-radio-btn-yes-dot'),
          ) ||
          block.querySelector('input,textarea,select')
        )
          throw new Error('unsupported_moaform_question');
        const label = block.querySelector<HTMLElement>('.js-question-content')?.innerText.trim();
        if (!label) throw new Error('unlabelled_moaform_question');
        if (
          options.some(
            (e) => !e.querySelector<HTMLElement>('.wf-style-mutiplechoice-text')?.innerText.trim(),
          )
        )
          throw new Error('unlabelled_moaform_option');
        groups.push({
          label,
          description: label,
          kind: 'radio',
          required: !!block.querySelector('.wf-icon-required'),
          multiple: false,
          options: options.map((e) => ({
            label:
              e.querySelector<HTMLElement>('.wf-style-mutiplechoice-text')?.innerText.trim() || '',
            value: String(choices.indexOf(e)),
          })),
          indices: options.map((e) => choices.indexOf(e)),
          form: forms.indexOf(block.closest('form')!),
          custom: 'moa-radio',
        });
      }
      const notice = document.body.innerText
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => /개인정보|수집.{0,20}이용|보관|폐기|동의/.test(s))
        .join('\n')
        .slice(0, 3000);
      if (
        /수집/.test(notice) &&
        /동의/.test(notice) &&
        !groups.some((g) => /동의|consent/i.test(g.label))
      ) {
        groups.push({
          label: '개인정보 수집·이용 안내 동의',
          description: notice,
          kind: 'radio',
          required: true,
          multiple: false,
          options: [
            { label: '안내에 동의하고 진행', value: 'accept' },
            { label: '동의하지 않음', value: 'decline' },
          ],
          indices: [],
          form: groups[0]?.form ?? -1,
          custom: 'notice',
        });
      }
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
    bindings.set(id, {
      indices: g.indices,
      optionValues: g.options.map((o) => o.value),
      custom: g.custom,
    });
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
  const initial = await inspectForm(page);
  if (initial.view.fingerprint !== expected.fingerprint)
    throw new ServiceError('form_structure_changed');
  for (const q of expected.questions) {
    if (
      initial.bindings.get(q.id)?.custom === 'notice' &&
      answers.get(q.id)?.[0] !== '안내에 동의하고 진행'
    )
      throw new ServiceError('privacy_notice_not_accepted');
  }
  for (const question of expected.questions) {
    const answer = answers.get(question.id);
    if (!answer) continue;
    const fresh = await inspectForm(page);
    if (fresh.view.fingerprint !== expected.fingerprint)
      throw new ServiceError('form_structure_changed');
    const binding = fresh.bindings.get(question.id)!;
    if (binding.custom === 'notice') continue;
    if (binding.custom === 'moa-radio') {
      signal.throwIfAborted();
      const selected = question.options.findIndex((o) => o.id === answer[0]);
      if (answer.length !== 1 || selected < 0) throw new ServiceError('invalid_form_answer');
      const options = page.locator('.js-question .select-one-and-many');
      const target = options.nth(binding.indices[selected]!);
      if (
        !(await target.evaluate(
          (e) => e.classList.contains('clicked') && !!e.querySelector('.fi-radio-btn-yes-dot'),
        ))
      )
        await target.click({ timeout: 3000 });
      for (let i = 0; i < binding.indices.length; i++) {
        const checked = await options
          .nth(binding.indices[i]!)
          .evaluate(
            (e) => e.classList.contains('clicked') && !!e.querySelector('.fi-radio-btn-yes-dot'),
          );
        if (checked !== (i === selected)) throw new ServiceError('field_verification_failed');
      }
      onField();
      continue;
    }
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
    await page
      .locator('input,textarea,select,.js-question .select-one-and-many')
      .evaluateAll((els) =>
        els
          .filter((el) => !['hidden', 'password'].includes((el as HTMLInputElement).type))
          .map((el) => ({
            value: (el as HTMLInputElement).value,
            checked: (el as HTMLInputElement).checked,
            selected: el.matches('.select-one-and-many')
              ? el.classList.contains('clicked')
              : undefined,
          })),
      ),
  );
}
export async function moaformSnapshot(page: Page) {
  const { view, bindings } = await inspectForm(page);
  const fields = [];
  for (const q of view.questions) {
    const b = bindings.get(q.id)!;
    if (b.custom === 'notice') continue;
    if (b.custom === 'moa-radio') {
      for (let i = 0; i < b.indices.length; i++)
        fields.push({
          label: q.label,
          type: 'radio',
          group: q.id,
          optionLabel: q.options[i]!.label,
          value: q.options[i]!.label,
          checked: await page
            .locator('.js-question .select-one-and-many')
            .nth(b.indices[i]!)
            .evaluate((e) => e.classList.contains('clicked')),
        });
    } else
      fields.push({
        label: q.label,
        type: q.kind,
        group: q.id,
        value: await page.locator('input,textarea,select').nth(b.indices[0]!).inputValue(),
      });
  }
  return [{ action: page.url(), fields }];
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
