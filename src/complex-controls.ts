import type { ElementHandle, Frame, Locator, Page } from 'playwright';
import { ServiceError } from './auth.js';

export const rankLists = '[role=listbox],[role=list],ol,ul';
export const rankItems = ':scope > [draggable=true],:scope > [role=option]';
export async function rankOrder(list: Locator) {
  return list
    .locator(rankItems)
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute('aria-label') || (el as HTMLElement).innerText.trim()),
    );
}
export async function applyRank(page: Page, index: number, answer: string[], signal: AbortSignal) {
  const list = page.locator(rankLists).nth(index);
  const initial = await rankOrder(list);
  if (
    new Set(answer).size !== answer.length ||
    answer.length !== initial.length ||
    answer.some((v) => !initial.includes(v))
  )
    throw new ServiceError('invalid_rank_answer');
  for (let i = 0; i < answer.length; i++) {
    signal.throwIfAborted();
    const order = await rankOrder(list);
    if (order[i] === answer[i]) continue;
    if (order.length !== initial.length || order.some((v) => !initial.includes(v)))
      throw new ServiceError('form_structure_changed');
    const items = list.locator(rankItems),
      from = items.nth(order.indexOf(answer[i]!)),
      to = items.nth(i);
    await from.dragTo(to, { targetPosition: { x: 5, y: 2 }, timeout: 6000 });
    for (let n = 0; n < 10 && (await rankOrder(list))[i] !== answer[i]; n++) {
      signal.throwIfAborted();
      await page.waitForTimeout(100);
    }
    if ((await rankOrder(list))[i] !== answer[i]) throw new ServiceError('rank_not_changed');
  }
  if (JSON.stringify(await rankOrder(list)) !== JSON.stringify(answer))
    throw new ServiceError('field_verification_failed');
}

export type Upload = {
  id?: string;
  name: string;
  mimeType: string;
  buffer: Buffer;
  fromDrive?: boolean;
  allowPicker?: boolean;
  beforeUpload?: () => void;
};
const confirmedSelections = new WeakMap<Page, Map<string, ElementHandle>>();
const fileButton = /^(파일 추가|파일 업로드|add file|upload file)$/i;
export async function pickerContainer(page: Page, buttonIndex: number) {
  const button = page.locator('button,[role=button],input[type=button]').nth(buttonIndex);
  const container = button.locator('xpath=ancestor::*[@role="listitem" or self::fieldset][1]');
  if ((await container.count()) !== 1) throw new ServiceError('unlabelled_file_picker');
  return { button, container };
}
async function pickerFrame(page: Page) {
  for (let n = 0; n < 20; n++) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) {
        if (
          (await frame.getByRole('dialog').count()) === 1 &&
          (await frame.getByRole('dialog').isVisible())
        )
          return frame;
        continue;
      }
      const url = new URL(frame.url());
      const owner = await frame.frameElement();
      if (!(await owner.isVisible())) continue;
      if (url.hostname === 'accounts.google.com') throw new ServiceError('picker_login_required');
      if (
        url.protocol === 'https:' &&
        ['docs.google.com', 'drive.google.com'].includes(url.hostname) &&
        /picker/.test(url.pathname)
      )
        return frame;
    }
    await page.waitForTimeout(100);
  }
  throw new ServiceError('picker_not_visible');
}
async function singleVisible(locator: Locator) {
  const visible = locator.filter({ visible: true });
  if ((await visible.count()) !== 1) throw new ServiceError('picker_control_ambiguous');
  return visible;
}
export async function applyPicker(
  page: Page,
  buttonIndex: number,
  file: Upload,
  signal: AbortSignal,
) {
  if (!file.allowPicker) throw new ServiceError('picker_recipient_not_authorized');
  const { button, container } = await pickerContainer(page, buttonIndex);
  const key = `${buttonIndex}:${file.id || ''}`;
  const prior = confirmedSelections.get(page)?.get(key);
  if (
    prior &&
    (await prior
      .evaluate((el, name) => el.isConnected && el.textContent === name, file.name)
      .catch(() => false))
  )
    return;
  if (await container.getByText(file.name, { exact: true }).count())
    throw new ServiceError('picker_existing_file_requires_review');
  if (!fileButton.test((await button.innerText()).trim()))
    throw new ServiceError('picker_control_changed');
  signal.throwIfAborted();
  await button.click();
  const frame: Frame = await pickerFrame(page);
  if (file.fromDrive) {
    const search = await singleVisible(
      frame.getByRole('searchbox').or(frame.getByRole('textbox', { name: /검색|search/i })),
    );
    await search.fill(file.name);
    await search.press('Enter');
    const matches = frame
      .getByRole('option', { name: file.name, exact: true })
      .or(frame.getByRole('row', { name: file.name, exact: true }));
    await matches.first().waitFor({ state: 'visible', timeout: 5000 });
    const item = await singleVisible(matches);
    signal.throwIfAborted();
    file.beforeUpload?.();
    await item.click();
  } else {
    const uploadTab = frame
      .getByRole('tab', { name: /^(업로드|upload)$/i })
      .filter({ visible: true });
    if ((await uploadTab.count()) === 1) await uploadTab.click();
    const input = frame.locator('input[type=file]');
    signal.throwIfAborted();
    if ((await input.count()) === 1) {
      file.beforeUpload?.();
      await input.setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: file.buffer });
    } else {
      const choose = await singleVisible(
        frame.getByRole('button', {
          name: /^(찾아보기|기기에서 파일 선택|browse|select files from your device)$/i,
        }),
      );
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 5000 }),
        choose.click(),
      ]);
      signal.throwIfAborted();
      file.beforeUpload?.();
      await chooser.setFiles({ name: file.name, mimeType: file.mimeType, buffer: file.buffer });
    }
  }
  signal.throwIfAborted();
  const select = frame
    .getByRole('button', { name: /^(선택|삽입|업로드|select|insert|upload)$/i })
    .filter({ visible: true });
  if ((await select.count()) === 1 && (await select.isEnabled())) await select.click();
  // Verify the receiving form, not a file name left in a picker search box.
  await container
    .getByText(file.name, { exact: true })
    .waitFor({ state: 'visible', timeout: 8000 });
  if ((await container.getByText(file.name, { exact: true }).count()) !== 1)
    throw new ServiceError('picker_file_not_verified');
  const selected = await container.getByText(file.name, { exact: true }).elementHandle();
  if (!selected) throw new ServiceError('picker_file_not_verified');
  if (!confirmedSelections.has(page)) confirmedSelections.set(page, new Map());
  confirmedSelections.get(page)!.set(key, selected);
}
