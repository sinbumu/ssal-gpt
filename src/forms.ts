import type { Page } from 'playwright';
import {
  applyRank,
  applyPicker,
  rankOrder,
  rankLists,
  pickerContainer,
  type Upload,
} from './complex-controls.js';
import { hash, type Question } from './autonomy.js';
import { ServiceError } from './auth.js';

export type FormView = {
  url: string;
  fingerprint: string;
  questions: Question[];
  buttons: {
    id: string;
    label: string;
    action: string;
    form: number;
    providerControl?: 'naver-next' | 'naver-submit';
  }[];
};
type Binding = {
  indices: number[];
  optionValues: string[];
  custom?: 'moa-radio' | 'notice' | 'aria-choice' | 'rank' | 'picker';
};
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
        // Some legacy lists have duplicated/broken for/id pairs. A sole visible
        // label next to a sole choice still has an unambiguous rendered owner.
        const item = el.closest('li');
        const localLabels = item?.querySelectorAll('label');
        const localChoice =
          ['radio', 'checkbox'].includes(el.type) &&
          item?.querySelectorAll('input,textarea,select').length === 1 &&
          localLabels?.length === 1 &&
          helpers.visible(localLabels[0]!)
            ? localLabels[0]!.textContent?.trim()
            : '';
        return (
          el.getAttribute('aria-label') ||
          (el.getAttribute('aria-labelledby') || '')
            .split(' ')
            .map((id) => document.getElementById(id)?.textContent || '')
            .join(' ')
            .trim() ||
          localChoice ||
          [...(el.labels || [])].map((l) => l.textContent?.trim()).join(' ') ||
          el.getAttribute('placeholder') ||
          el.getAttribute('title') ||
          el.name
        );
      },
    };
    // Definition text excludes input values and control chrome. Keep visible
    // instructions/consent, including the outer question card, in the signature.
    const definitions = {
      text(root: Element) {
        const parts: string[] = [];
        const nodes = {
          walk(node: Node) {
            if (
              node instanceof Element &&
              (!helpers.visible(node) ||
                node.matches(
                  'input,textarea,select,output,button,[role=button],script,style,[aria-hidden=true]',
                ))
            )
              return;
            if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent || '');
            else node.childNodes.forEach((child) => nodes.walk(child));
          },
        };
        nodes.walk(root);
        return parts.join(' ').replace(/\s+/g, ' ').trim();
      },
    };
    const groups: {
      label: string;
      description: string;
      kind: 'text' | 'radio' | 'checkbox' | 'select' | 'file' | 'rank';
      required: boolean;
      multiple: boolean;
      options: { label: string; value: string }[];
      indices: number[];
      form: number;
      custom?: 'moa-radio' | 'notice' | 'aria-choice' | 'rank' | 'picker';
    }[] = [];
    const forms = [...document.forms];
    // Some native forms place their sole consent immediately before the form.
    // Only bind this explicit adjacent pair, never arbitrary outside controls.
    const precedingConsent = forms.length === 1 ? forms[0]!.previousElementSibling : null;
    const standalone = precedingConsent?.querySelector<HTMLInputElement>('input[type=checkbox]');
    const notice = precedingConsent?.previousElementSibling;
    const linkedConsent =
      standalone &&
      !standalone.form &&
      helpers.visible(standalone) &&
      precedingConsent!.querySelectorAll('input,textarea,select,button').length === 1 &&
      /동의|consent|agree/i.test(helpers.label(standalone)) &&
      notice instanceof HTMLElement &&
      helpers.visible(notice) &&
      /개인정보|personal information/i.test(notice.innerText)
        ? { element: standalone, text: notice.innerText.slice(0, 3000), form: 0 }
        : undefined;
    const lists = [...document.querySelectorAll('[role=listbox],[role=list],ol,ul')];
    for (let index = 0; index < lists.length; index++) {
      const list = lists[index]!;
      const label =
        list.getAttribute('aria-label') ||
        list.closest('fieldset')?.querySelector('legend')?.textContent?.trim() ||
        '';
      const items = [...list.querySelectorAll(':scope > [draggable=true],:scope > [role=option]')];
      if (
        !helpers.visible(list) ||
        !/순위|순서|우선|rank|order/i.test(label) ||
        !items.length ||
        !items.every((el) => el.getAttribute('draggable') === 'true' && helpers.visible(el))
      )
        continue;
      groups.push({
        label,
        description: '모든 항목을 원하는 순서로 배치',
        kind: 'rank',
        required: true,
        multiple: true,
        options: items
          .map((el) => ({
            label: el.getAttribute('aria-label') || (el as HTMLElement).innerText.trim(),
            value: '',
          }))
          .sort((a, b) => a.label.localeCompare(b.label)),
        indices: [index],
        form: forms.indexOf(list.closest('form')!),
        custom: 'rank',
      });
    }
    if (location.hostname === 'docs.google.com' || location.pathname.startsWith('/demo/')) {
      const controls = [
        ...document.querySelectorAll<HTMLElement>('button,[role=button],input[type=button]'),
      ];
      for (let index = 0; index < controls.length; index++) {
        const button = controls[index]!;
        if (
          !helpers.visible(button) ||
          !/^(파일 추가|파일 업로드|add file|upload file)$/i.test(button.innerText.trim())
        )
          continue;
        const block = button.closest('[role=listitem],fieldset');
        if (!block || block.querySelector('input[type=file]')) continue;
        const label =
          block.getAttribute('aria-label') ||
          block.querySelector('legend,[role=heading]')?.textContent?.trim();
        if (!label) throw new Error('unlabelled_file_picker');
        groups.push({
          label,
          description: '파일이 Google Drive 및 폼 주최자에게 전달될 수 있습니다.',
          kind: 'file',
          required: block.getAttribute('aria-required') === 'true' || /\*/.test(label),
          multiple: false,
          options: [],
          indices: [index],
          form: forms.indexOf(block.closest('form')!),
          custom: 'picker',
        });
      }
    }

    const seen = new Set<number>();
    for (let index = 0; index < all.length; index++) {
      const el = all[index]!;
      if (
        seen.has(index) ||
        el.disabled ||
        ['hidden', 'submit', 'image', 'button', 'reset', 'password'].includes(el.type)
      )
        continue;
      if (!helpers.visible(el) && ![...(el.labels || [])].some(helpers.visible)) continue;
      const kind =
        el.type === 'file'
          ? 'file'
          : el instanceof HTMLSelectElement
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
        'fieldset,[role=group],[role=radiogroup],[role=listitem]' + (moa ? ',.js-question' : ''),
      );
      const dl = el.closest('dl');
      const dd = el.closest('dd');
      const term =
        dd?.parentElement === dl
          ? dd.previousElementSibling
          : el.parentElement === dl
            ? el.previousElementSibling
            : null;
      const termHeading =
        term?.matches('dt') && helpers.visible(term) ? definitions.text(term) : '';
      // Three adjacent, length-bounded phone inputs are distinct parts, not
      // three copies of the full phone. Never infer parts from index alone.
      let phonePart = '';
      let phoneBlock = el.parentElement;
      for (
        let depth = 0;
        kind === 'text' && phoneBlock && depth < 3;
        depth++, phoneBlock = phoneBlock.parentElement
      ) {
        if (phoneBlock.matches('body,html,main,form,fieldset')) break;
        const inputs = [
          ...phoneBlock.querySelectorAll<HTMLInputElement>(
            'input:not([type=hidden]),textarea,select',
          ),
        ].filter(helpers.visible);
        if (inputs.length !== 3 || !inputs.every((e) => ['text', 'tel'].includes(e.type))) continue;
        const label = phoneBlock.querySelector('label');
        if (
          !label ||
          !/휴대|전화|phone|mobile/i.test(label.textContent || '') ||
          !label.control ||
          !inputs.includes(label.control as HTMLInputElement) ||
          inputs.map((e) => e.maxLength).join(',') !== '3,4,4'
        )
          continue;
        const ordinal = inputs.indexOf(el as HTMLInputElement);
        if (ordinal >= 0)
          phonePart = `${label.textContent?.trim()} ${['첫 번째 3자리', '두 번째 4자리', '세 번째 4자리'][ordinal]}`;
        break;
      }
      const describedBy = (el.getAttribute('aria-describedby') || '')
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((node): node is HTMLElement => !!node && helpers.visible(node))
        .map((node) => node.innerText)
        .join('\n');
      const heading = fieldset
        ?.querySelector('legend,h1,h2,h3,h4,[role=heading],.js-question-content')
        ?.textContent?.trim();
      // Plain HTML often groups a question in a div instead of a fieldset.
      // Use only a small visible container with this one control, never the
      // page-wide text (which can mix separate questions and private values).
      const localBlock = !fieldset && el.parentElement;
      const localText =
        localBlock &&
        !localBlock.matches('body,html,main,form') &&
        localBlock.querySelectorAll('input:not([type=hidden]),textarea,select').length === 1 &&
        helpers.visible(localBlock)
          ? definitions.text(localBlock).slice(0, 3000)
          : '';
      let nearbyConsent = '';
      if (kind === 'checkbox' && group.length === 1 && /동의|consent/i.test(helpers.label(el))) {
        let block = el.parentElement;
        for (let depth = 0; block && depth < 3; depth++, block = block.parentElement) {
          if (
            block.matches('body,html,main,form') ||
            block.querySelectorAll('input:not([type=hidden]),textarea,select').length !== 1
          )
            break;
          const previous = block.previousElementSibling;
          if (
            previous instanceof HTMLElement &&
            helpers.visible(previous) &&
            !previous.querySelector('input,textarea,select,button') &&
            /개인정보.{0,20}(?:수집|이용)|privacy|personal information/i.test(previous.innerText)
          ) {
            nearbyConsent = previous.innerText.slice(0, 3000);
            break;
          }
        }
      }
      const questionLabel = (
        phonePart ||
        (kind === 'text' &&
        fieldset?.matches('fieldset') &&
        fieldset.querySelectorAll('input:not([type=hidden]),textarea,select').length > 1
          ? helpers.label(el)
          : '') ||
        heading ||
        (kind === 'text' && helpers.label(el) && termHeading
          ? `${termHeading} — ${helpers.label(el)}`
          : termHeading) ||
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
          localText && localText !== helpers.label(el) ? localText : '',
          nearbyConsent,
          el.getAttribute('title') || '',
          el.getAttribute('placeholder') !== helpers.label(el)
            ? el.getAttribute('placeholder') || ''
            : '',
          linkedConsent?.element === el ? linkedConsent.text : '',
          linkedConsent &&
          el.form === forms[linkedConsent.form] &&
          /주소|배송|우편번호|address|postal/i.test(questionLabel)
            ? linkedConsent.text.match(/경품\s*(?:배송|발송)/)?.[0] || ''
            : '',
          el.type === 'file'
            ? `허용 파일: ${el.getAttribute('accept') || '형식 안내 없음'}; ${(el as HTMLInputElement).multiple ? '복수 파일 입력' : '단일 파일 입력'}`
            : '',
          moa && fieldset?.matches('.js-question')
            ? [
                heading,
                fieldset.querySelector('.wf-style-textanswer__placeholder')?.textContent?.trim(),
              ]
                .filter(Boolean)
                .join('\n')
            : fieldset instanceof HTMLElement &&
                !(
                  kind === 'text' &&
                  fieldset.matches('fieldset') &&
                  fieldset.querySelectorAll('input:not([type=hidden]),textarea,select').length > 1
                )
              ? definitions.text(fieldset)
              : '',
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 3000),
        kind,
        required:
          group.some((e) => e.required || e.getAttribute('aria-required') === 'true') ||
          fieldset?.getAttribute('aria-required') === 'true' ||
          (moa && !!fieldset?.querySelector('.wf-icon-required')) ||
          (linkedConsent?.element === el &&
            /동의를\s*거부할\s*경우[\s\S]{0,120}(?:이용|참여|응모)[\s\S]{0,60}(?:없|불가|제한)/.test(
              linkedConsent.text,
            )) ||
          /동의하지\s*않을\s*경우[\s\S]{0,80}(?:추첨|참여|응모)[\s\S]{0,40}(?:제외|불가|제한)/.test(
            nearbyConsent,
          ) ||
          /답변\s*필수/.test(questionLabel),
        multiple: kind === 'checkbox' || (el instanceof HTMLSelectElement && el.multiple),
        options,
        indices,
        form: linkedConsent?.element === el ? linkedConsent.form : forms.indexOf(el.form!),
      });
    }
    // ARIA choice groups, including grids, bind by visible labels and checked state.
    // No private framework state or hidden response payload is inspected.
    const aria = [...document.querySelectorAll<HTMLElement>('[role=radio],[role=checkbox]')];
    const visited = new Set<Element>();
    for (const control of aria) {
      if (!helpers.visible(control) || control.matches('input') || visited.has(control)) continue;
      const block = control.closest('[role=radiogroup],fieldset,[role=group],[role=listitem]');
      if (!block) throw new Error('unlabelled_custom_choice');
      const ariaHelpers = {
        labelBy(el: Element) {
          return (el.getAttribute('aria-labelledby') || '')
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent || '')
            .join(' ')
            .trim();
        },
      };
      const label =
        block.getAttribute('aria-label') ||
        ariaHelpers.labelBy(block) ||
        block.querySelector('legend,[role=heading],h1,h2,h3,h4')?.textContent?.trim();
      if (!label) throw new Error('unlabelled_custom_choice');
      const kind = control.getAttribute('role') === 'radio' ? 'radio' : 'checkbox';
      const options = aria.filter(
        (c) =>
          c.getAttribute('role') === kind &&
          c.closest('[role=radiogroup],fieldset,[role=group],[role=listitem]') === block &&
          helpers.visible(c) &&
          c.getAttribute('aria-disabled') !== 'true',
      );
      if (options.some((o) => !['true', 'false'].includes(o.getAttribute('aria-checked') || '')))
        throw new Error('unsupported_choice_state');
      options.forEach((o) => visited.add(o));
      groups.push({
        label,
        description: definitions.text(block.closest('[role=listitem]') || block).slice(0, 3000),
        kind,
        required:
          block.getAttribute('aria-required') === 'true' ||
          options.some((o) => o.getAttribute('aria-required') === 'true') ||
          /\*/.test(label),
        multiple: kind === 'checkbox',
        indices: options.map((o) => aria.indexOf(o)),
        form: forms.indexOf(block.closest('form')!),
        custom: 'aria-choice',
        options: options.map((o) => ({
          label: o.getAttribute('aria-label') || ariaHelpers.labelBy(o) || o.innerText.trim(),
          value: String(aria.indexOf(o)),
        })),
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
        'button,input[type=submit],input[type=image],[role=button],a[onclick]',
      ),
    ]
      .map((b, index) => ({
        index,
        label: (
          b.textContent?.trim() ||
          b.value ||
          b.getAttribute('alt') ||
          b.querySelector('img')?.alt ||
          ''
        ).trim(),
        action: b.hasAttribute('formaction')
          ? b.formAction
          : (b.form || b.closest('form'))?.action || location.href,
        form: forms.indexOf(b.form || b.closest('form')!),
        handler: b.getAttribute('onclick'),
        anchor: b.matches('a'),
        href: b.matches('a') ? b.getAttribute('href') : undefined,
        localAnchor:
          b.matches('a[onclick]') &&
          b.getAttribute('href')?.startsWith('#') &&
          (!!b.closest('form') || forms.length === 0),
        visible: helpers.visible(b),
        disabled: b.disabled,
        type: b.type,
        providerControl:
          location.origin === 'https://form.naver.com' &&
          /^\/response\/[A-Za-z0-9_-]{5,100}\/?$/.test(location.pathname) &&
          b instanceof HTMLButtonElement &&
          b.type === 'button' &&
          ['nsv_page_control_next', 'nsv_page_control_submit'].includes(b.id) &&
          document.querySelectorAll('#' + b.id).length === 1 &&
          ((b.id === 'nsv_page_control_next' &&
            /^(다음|next)$/i.test(b.textContent?.trim() || '')) ||
            (b.id === 'nsv_page_control_submit' &&
              /^(제출|submit)$/i.test(b.textContent?.trim() || '')))
            ? b.id === 'nsv_page_control_next'
              ? ('naver-next' as const)
              : ('naver-submit' as const)
            : undefined,
      }))
      .filter(
        (b) =>
          b.visible &&
          !b.disabled &&
          (b.anchor
            ? b.localAnchor && /^(참여하기|응모하기|제출하기)$/i.test(b.label)
            : ['submit', 'image'].includes(b.type) ||
              /^(다음|next|continue|제출(?:하기)?|응모하기|submit)$/i.test(b.label)),
      );
    return {
      groups,
      buttons,
      forms: forms.map((f) => ({ action: f.action, method: f.method, target: f.target })),
      constraints: groups.map((g) =>
        g.custom
          ? undefined
          : g.indices.map((i) => {
              const e = all[i]!;
              return [
                'type',
                'name',
                'id',
                'maxlength',
                'minlength',
                'pattern',
                'min',
                'max',
                'readonly',
              ].map((a) => e.getAttribute(a));
            }),
      ),
    };
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
      picker: g.custom === 'picker' || undefined,
      maxChoices: g.multiple
        ? Number((g.label + ' ' + g.description).match(/(?:최대|max(?:imum)?)\s*(\d+)/i)?.[1]) ||
          undefined
        : 1,
      options,
    };
  });
  if (new Set(questions.map((q) => q.signature)).size !== questions.length)
    throw new ServiceError('ambiguous_form_questions');
  if (new Set(raw.groups.map((g) => g.form)).size > 1)
    throw new ServiceError('multiple_forms_require_manual_selection');
  const buttons = raw.buttons.map((b, i) => ({
    id: `b${i}`,
    label: b.label,
    action: b.action,
    form: b.form,
    providerControl: b.providerControl,
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
      constraints: raw.constraints,
      buttonHandlers: raw.buttons.map((b) => [b.handler, b.href]),
      // Bindings are re-read before every action; hidden input insertions and
      // unrelated ARIA nodes must not invalidate an unchanged question.
      bindings: [...bindings].map(([id, b]) => [
        id,
        b.custom,
        b.custom === 'aria-choice' || b.custom === 'moa-radio' ? undefined : b.optionValues,
      ]),
    }),
  };
  return { view, bindings, buttonBindings: new Map(raw.buttons.map((b, i) => [`b${i}`, b.index])) };
}
export async function applyAnswers(
  page: Page,
  expected: FormView,
  answers: Map<string, string[]>,
  onField: () => void,
  signal: AbortSignal,
  attachment?: (ref: string, question: Question) => Promise<Upload>,
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
    const rebind = async () => {
      const current = await inspectForm(page);
      if (current.view.fingerprint !== expected.fingerprint)
        throw new ServiceError('form_structure_changed');
      return current.bindings.get(question.id)!;
    };
    if (binding.custom === 'notice') continue;
    if (binding.custom === 'rank') {
      await applyRank(page, binding.indices[0]!, answer, signal);
      onField();
      continue;
    }
    if (binding.custom === 'picker') {
      if (!answer.length && !question.required) continue;
      if (!attachment) throw new ServiceError('attachment_resolver_required');
      await applyPicker(page, binding.indices[0]!, await attachment(answer[0]!, question), signal);
      onField();
      continue;
    }
    if (binding.custom === 'aria-choice') {
      const controls = page.locator('[role=radio],[role=checkbox]');
      // Select radio target first; clicking the old radio would reselect it.
      const order = binding.indices
        .map((_, i) => i)
        .sort(
          (a, b) =>
            Number(answer.includes(question.options[b]!.id)) -
            Number(answer.includes(question.options[a]!.id)),
        );
      for (const i of order) {
        signal.throwIfAborted();
        const control = controls.nth((await rebind()).indices[i]!);
        const desired = answer.includes(question.options[i]!.id);
        const checked = (await control.getAttribute('aria-checked')) === 'true';
        if (desired !== checked && (question.multiple || desired)) await control.click();
      }
      for (let i = 0; i < binding.indices.length; i++) {
        if (
          ((await controls.nth((await rebind()).indices[i]!).getAttribute('aria-checked')) ===
            'true') !==
          answer.includes(question.options[i]!.id)
        )
          throw new ServiceError('field_verification_failed');
      }
      onField();
      continue;
    }
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
          .nth((await rebind()).indices[i]!)
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
      const currentBinding = await rebind();
      let control = controls.nth(currentBinding.indices[i]!);
      if (question.kind === 'file') {
        if (!answer.length) continue;
        if (!attachment) throw new ServiceError('attachment_resolver_required');
        const file = await attachment(answer[0]!, question);
        if (file.fromDrive) throw new ServiceError('drive_file_requires_picker');
        const accepted = ((await control.getAttribute('accept')) || '')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        if (
          accepted.length &&
          !accepted.some((a) =>
            a.startsWith('.')
              ? file.name.toLowerCase().endsWith(a)
              : a.endsWith('/*')
                ? file.mimeType.startsWith(a.slice(0, -1))
                : a === file.mimeType,
          )
        )
          throw new ServiceError('attachment_type_not_accepted');
        const present = await control.evaluate(async (el) => {
          const files = (el as HTMLInputElement).files;
          return files?.length
            ? {
                name: files[0]!.name,
                bytes: Array.from(new Uint8Array(await files[0]!.arrayBuffer())),
              }
            : null;
        });
        if (
          !present ||
          present.name !== file.name ||
          !file.buffer.equals(Buffer.from(present.bytes))
        ) {
          file.beforeUpload?.();
          await control.setInputFiles({
            name: file.name,
            mimeType: file.mimeType,
            buffer: file.buffer,
          });
        }
        const uploaded = await control.evaluate((el) =>
          [...((el as HTMLInputElement).files || [])].map((f) => ({ name: f.name, size: f.size })),
        );
        if (
          uploaded.length !== 1 ||
          uploaded[0]!.name !== file.name ||
          uploaded[0]!.size !== file.buffer.length
        )
          throw new ServiceError('field_verification_failed');
      } else if (question.kind === 'text') {
        if ((await control.inputValue()) !== answer[0]) await control.fill(answer[0] || '');
        control = controls.nth((await rebind()).indices[i]!);
        if ((await control.inputValue()) !== answer[0])
          throw new ServiceError('field_verification_failed');
      } else if (question.kind === 'select') {
        const values = answer.map(
          (a) => currentBinding.optionValues[question.options.findIndex((o) => o.id === a)]!,
        );
        await control.selectOption(values);
        control = controls.nth((await rebind()).indices[i]!);
        const selected = await control.evaluate((el) =>
          [...(el as HTMLSelectElement).selectedOptions].map((o) => o.value),
        );
        if (hash(selected.slice().sort()) !== hash(values.slice().sort()))
          throw new ServiceError('field_verification_failed');
      } else {
        const checked = answer.includes(question.options[i]!.id);
        if (question.kind === 'radio' && !checked) continue;
        if ((await control.isChecked()) !== checked) {
          try {
            await control.setChecked(checked, { timeout: 1200 });
          } catch {
            // A styled input can be covered by its label. Check state before fallback.
            control = controls.nth((await rebind()).indices[i]!);
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
        control = controls.nth((await rebind()).indices[i]!);
        if ((await control.isChecked()) !== checked)
          throw new ServiceError('field_verification_failed');
      }
    }
    if (question.kind === 'radio' && !binding.custom) {
      for (let i = 0; i < binding.indices.length; i++)
        if (
          (await controls.nth((await rebind()).indices[i]!).isChecked()) !==
          answer.includes(question.options[i]!.id)
        )
          throw new ServiceError('field_verification_failed');
    }
    onField();
  }
}
export async function formValuesHash(page: Page) {
  return hash(
    await page
      .locator(
        'input,textarea,select,.js-question .select-one-and-many,[role=radio],[role=checkbox],[draggable=true],[role=listitem] a,fieldset a',
      )
      .evaluateAll((els) =>
        els
          .filter((el) => !['hidden', 'password'].includes((el as HTMLInputElement).type))
          .map((el) => ({
            value: (el as HTMLInputElement).value,
            checked: (el as HTMLInputElement).checked,
            ariaChecked: el.getAttribute('aria-checked'),
            text: el.matches('[draggable=true],a')
              ? el.getAttribute('aria-label') || el.textContent
              : undefined,
            files: Array.from((el as HTMLInputElement).files || []).map((f) => ({
              name: f.name,
              size: f.size,
              lastModified: f.lastModified,
            })),
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
    if (b.custom === 'rank') {
      fields.push({
        label: q.label,
        type: q.kind,
        group: q.id,
        value: (await rankOrder(page.locator(rankLists).nth(b.indices[0]!))).join(' → '),
      });
      continue;
    }
    if (b.custom === 'picker') {
      const { container } = await pickerContainer(page, b.indices[0]!);
      fields.push({
        label: q.label,
        type: q.kind,
        group: q.id,
        value: await container.locator('a').allTextContents(),
      });
      continue;
    }
    if (b.custom === 'moa-radio' || b.custom === 'aria-choice') {
      for (let i = 0; i < b.indices.length; i++)
        fields.push({
          label: q.label,
          type: q.kind,
          group: q.id,
          optionLabel: q.options[i]!.label,
          value: q.options[i]!.label,
          checked: await page
            .locator(
              b.custom === 'aria-choice'
                ? '[role=radio],[role=checkbox]'
                : '.js-question .select-one-and-many',
            )
            .nth(b.indices[i]!)
            .evaluate((e) =>
              e.hasAttribute('aria-checked')
                ? e.getAttribute('aria-checked') === 'true'
                : e.classList.contains('clicked'),
            ),
        });
    } else {
      for (let i = 0; i < b.indices.length; i++) {
        const control = page.locator('input,textarea,select').nth(b.indices[i]!);
        const choice = ['radio', 'checkbox'].includes(q.kind);
        fields.push({
          label: q.label,
          type: q.kind,
          group: q.id,
          optionLabel: choice ? q.options[i]?.label : undefined,
          checked: choice ? await control.isChecked() : undefined,
          value:
            q.kind === 'file'
              ? await control.evaluate((el) =>
                  Array.from((el as HTMLInputElement).files || [])
                    .map((f) => f.name)
                    .join(', '),
                )
              : await control.inputValue(),
          displayValue:
            q.kind === 'select'
              ? await control.evaluate((el) =>
                  Array.from((el as HTMLSelectElement).selectedOptions).map((o) => o.label),
                )
              : undefined,
        });
      }
    }
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
  const fresh = await inspectForm(page);
  if (fresh.view.fingerprint !== expected.fingerprint)
    throw new ServiceError('form_structure_changed');
  const button = expected.buttons.find((b) => b.id === buttonId);
  if (!button) throw new ServiceError('unobserved_form_button');
  const locator = page
    .locator('button,input[type=submit],input[type=image],[role=button],a[onclick]')
    .nth(fresh.buttonBindings.get(buttonId)!);
  const valid = await locator.evaluate(
    (el) => ((el as HTMLButtonElement).form || el.closest('form'))?.checkValidity() ?? true,
  );
  if (!valid) throw new ServiceError('form_validation_failed');
  await locator.click({ timeout: 6000 });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(200);
}
