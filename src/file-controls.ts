import type { Locator, Page } from 'playwright';
import { createHash } from 'node:crypto';
import type { Upload } from './complex-controls.js';
import { ServiceError } from './auth.js';

export type FileSurfaceReceipt = { scope: string; marker: string };
const verified = new WeakMap<Page, Map<string, { marker: string; name: string }>>();
export async function fileSurface(control: Locator) {
  return control.evaluate((node) => {
    const input = node as HTMLInputElement;
    const block = input.closest('fieldset,[role=listitem],[role=group]') || input.parentElement!;
    const visibility = {
      shown(e: Element) {
        return !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
      },
    };
    const images = [...block.querySelectorAll('img,[style]')]
      .filter(visibility.shown)
      .flatMap((el) => {
        if (el instanceof HTMLImageElement)
          return el.complete && el.naturalWidth ? [el.currentSrc || el.src] : [];
        const bg = getComputedStyle(el).backgroundImage.match(/^url\(["']?(.+?)["']?\)$/)?.[1];
        return bg ? [bg] : [];
      });
    const removals = [...block.querySelectorAll('button,[role=button]')].filter(
      (el) =>
        visibility.shown(el) &&
        /(?:파일|사진|첨부).{0,10}삭제|(?:remove|delete).{0,10}(?:file|image)/i.test(
          el.getAttribute('aria-label') || el.textContent || '',
        ),
    ).length;
    return {
      images: [...new Set(images)],
      removals,
      disabled: input.disabled,
      countOne: /\b1\s*\/\s*1\b/.test((block as HTMLElement).innerText),
      files: [...(input.files || [])].map((f) => ({ name: f.name, size: f.size })),
      busy: !!block.querySelector('[aria-busy=true],[role=progressbar]'),
      controlsBusy: [...document.querySelectorAll<HTMLButtonElement>('button')].some(
        (b) =>
          visibility.shown(b) &&
          b.disabled &&
          /^(제출|submit|다음|next)$/i.test(b.textContent?.trim() || ''),
      ),
    };
  });
}
const marker = (s: Awaited<ReturnType<typeof fileSurface>>) =>
  createHash('sha256')
    .update(JSON.stringify({ images: s.images, removals: s.removals, countOne: s.countOne }))
    .digest('hex');
const thumbnail = (s: Awaited<ReturnType<typeof fileSurface>>) =>
  s.disabled && s.countOne && s.removals === 1 && s.images.length === 1;
export async function applyNativeFile(
  page: Page,
  control: Locator,
  signature: string,
  file: Upload,
  signal: AbortSignal,
) {
  const scope = `${page.url()}#${signature}`,
    before = await fileSurface(control);
  if (
    file.surface?.scope === scope &&
    file.surface.marker === marker(before) &&
    thumbnail(before)
  ) {
    const map = verified.get(page) || new Map();
    map.set(signature, { marker: marker(before), name: file.name });
    verified.set(page, map);
    return;
  }
  const present = await control.evaluate(async (node) => {
    const files = (node as HTMLInputElement).files;
    return files?.length === 1
      ? { name: files[0]!.name, bytes: Array.from(new Uint8Array(await files[0]!.arrayBuffer())) }
      : null;
  });
  if (!present || present.name !== file.name || !file.buffer.equals(Buffer.from(present.bytes))) {
    // A pre-existing thumbnail without this asset's transition proof is not ours to replace.
    if (before.disabled || before.removals || before.images.length)
      throw new ServiceError('attachment_upload_state_unknown');
    file.beforeUpload?.();
    await control.setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: file.buffer });
  }
  let last = '',
    stable = 0;
  for (let n = 0; n < 48; n++) {
    signal.throwIfAborted();
    await page.waitForTimeout(250);
    const current = await fileSurface(control);
    const native =
      current.files.length === 1 &&
      current.files[0]!.name === file.name &&
      current.files[0]!.size === file.buffer.length;
    const complete = !current.busy && !current.controlsBusy && (native || thumbnail(current));
    const key = JSON.stringify(current);
    stable = complete && key === last ? stable + 1 : 0;
    last = key;
    if (complete && stable >= 1) {
      if (thumbnail(current)) {
        const receipt = { scope, marker: marker(current) };
        file.confirmUpload?.(receipt);
        const map = verified.get(page) || new Map();
        map.set(signature, { marker: receipt.marker, name: file.name });
        verified.set(page, map);
      }
      return;
    }
  }
  throw new ServiceError('attachment_upload_state_unknown');
}
export async function verifiedFileName(page: Page, control: Locator, signature: string) {
  const receipt = verified.get(page)?.get(signature);
  if (!receipt) return '';
  const current = await fileSurface(control);
  return thumbnail(current) && marker(current) === receipt.marker ? receipt.name : '';
}
