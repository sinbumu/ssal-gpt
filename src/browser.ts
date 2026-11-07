import { chromium, type BrowserContext, type Page, type ElementHandle } from 'playwright';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { privateDirectory } from './config.js';
import { ServiceError } from './auth.js';
import type { Step } from './model.js';

export type VisibleElement = {
  ref: string;
  tag: string;
  role: string;
  type: string;
  label: string;
  href?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  checked?: boolean;
  value?: string;
};
export type Observation = {
  id: string;
  url: string;
  title: string;
  text: string;
  elements: VisibleElement[];
  width: number;
  height: number;
  fingerprint: string;
  screenshot: string;
  image: Buffer;
  capturedAt: number;
  revision: number;
};
export function privateAddress(address: string) {
  const a = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (a.includes(':'))
    return (
      a === '::' ||
      a === '::1' ||
      a.startsWith('fc') ||
      a.startsWith('fd') ||
      a.startsWith('fe80:') ||
      a.startsWith('::ffff:')
    );
  const [x = 0, y = 0] = a.split('.').map(Number);
  return (
    x === 0 ||
    x === 10 ||
    x === 127 ||
    (x === 169 && y === 254) ||
    (x === 172 && y >= 16 && y <= 31) ||
    (x === 192 && y === 168) ||
    (x === 100 && y >= 64 && y <= 127) ||
    x >= 224
  );
}
export async function validateUrl(raw: string, demoOrigin?: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ServiceError('invalid_url');
  }
  if (demoOrigin && url.origin === demoOrigin && url.pathname.startsWith('/demo/')) return url;
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !['80', '443'].includes(url.port))
  )
    throw new ServiceError('unsupported_url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    !host.includes('.')
  )
    throw new ServiceError('private_network_blocked');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => privateAddress(a.address)))
    throw new ServiceError('private_network_blocked');
  return url;
}

export class Browser {
  context?: BrowserContext;
  page?: Page;
  latest?: Observation;
  ownerJobId?: string;
  private handles = new Map<string, ElementHandle<HTMLElement>>();
  private opening?: Promise<void>;
  private evidence: string;
  constructor(
    private dir: string,
    private demoOrigin: string,
    private headless = false,
  ) {
    this.evidence = privateDirectory(join(dir, 'evidence'));
  }
  async open() {
    if (this.context) return;
    if (this.opening) return this.opening;
    this.opening = this.launch();
    try {
      await this.opening;
    } finally {
      this.opening = undefined;
    }
  }
  private async launch() {
    this.context = await chromium.launchPersistentContext(
      privateDirectory(join(this.dir, 'browser')),
      {
        headless: this.headless,
        viewport: { width: 1280, height: 840 },
        deviceScaleFactor: 1,
        acceptDownloads: false,
        serviceWorkers: 'block',
      },
    );
    this.context.setDefaultTimeout(6000);
    await this.context.route('**/*', async (route) => {
      const url = route.request().url();
      if (/^(data:|blob:)/.test(url)) return route.continue();
      try {
        await validateUrl(url, this.demoOrigin);
        await route.continue();
      } catch {
        await route.abort('blockedbyclient').catch(() => {});
      }
    });
    await this.context.addInitScript(() => {
      (window as any).__ssalRevision = 0;
      new MutationObserver((mutations) => {
        // Hidden timers / rotating form tokens do not change the observed controls.
        // Type, visibility, name and all visible field mutations still invalidate actions.
        const relevant = mutations.some(
          (m) =>
            !(
              m.type === 'attributes' &&
              m.attributeName === 'value' &&
              m.target instanceof HTMLInputElement &&
              m.target.type === 'hidden'
            ),
        );
        if (relevant) (window as any).__ssalRevision++;
      }).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      window.addEventListener(
        'scroll',
        () => {
          (window as any).__ssalRevision++;
        },
        true,
      );
      window.addEventListener(
        'input',
        () => {
          (window as any).__ssalRevision++;
        },
        true,
      );
    });
    this.context.on('page', (page) => this.attach(page));
    this.page = this.context.pages()[0] || (await this.context.newPage());
    this.attach(this.page);
    this.context.on('close', () => {
      this.context = undefined;
      this.page = undefined;
      this.latest = undefined;
      this.ownerJobId = undefined;
    });
  }
  private attach(page: Page) {
    this.page = page;
    this.latest = undefined;
    page.on('dialog', (dialog) => void dialog.dismiss().catch(() => {}));
    page.on('download', (download) => void download.cancel().catch(() => {}));
  }
  invalidate() {
    this.latest = undefined;
  }
  async navigate(raw: string) {
    const url = await validateUrl(raw, this.demoOrigin);
    await this.open();
    this.invalidate();
    try {
      await this.page!.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (error) {
      throw new ServiceError(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'browser_navigation_timeout'
          : 'browser_navigation_failed',
      );
    }
  }
  async observe(): Promise<Observation> {
    await this.open();
    const page = this.page!;
    if (page.isClosed()) throw new ServiceError('browser_closed');
    const url = page.url();
    if (
      /google\.[^/]+\/sorry\//i.test(url) ||
      (await page
        .locator('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],#challenge-running')
        .count())
    ) {
      this.invalidate();
      throw new ServiceError('verification_required_manual');
    }
    if (
      /\/login|\/signin|\/challenge|\/checkpoint|accounts\.google|auth\.openai/i.test(url) ||
      (await page.locator('input[type=password]').count())
    ) {
      this.invalidate();
      throw new ServiceError('needs_login_manual');
    }
    for (const handle of this.handles.values()) await handle.dispose().catch(() => {});
    this.handles.clear();
    const id = randomUUID();
    const handles = await page
      .locator('a[href],button,input,textarea,select,[role="button"],[role="checkbox"],summary')
      .elementHandles();
    const elements: VisibleElement[] = [];
    for (const handle of handles.slice(0, 300)) {
      const item = await handle
        .evaluate((el: HTMLElement) => {
          const box = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (
            !box.width ||
            !box.height ||
            box.bottom <= 0 ||
            box.right <= 0 ||
            box.top >= innerHeight ||
            box.left >= innerWidth ||
            style.visibility === 'hidden' ||
            style.display === 'none'
          )
            return null;
          const input = el as HTMLInputElement;
          const label =
            el.getAttribute('aria-label') ||
            (input.labels ? [...input.labels].map((l) => l.innerText).join(' ') : '') ||
            el.innerText ||
            el.getAttribute('placeholder') ||
            el.getAttribute('name') ||
            '';
          return {
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || '',
            type:
              el instanceof HTMLInputElement || el instanceof HTMLButtonElement
                ? el.type
                : el.getAttribute('type') || '',
            label: label.slice(0, 240),
            href: el instanceof HTMLAnchorElement ? el.href : undefined,
            x: Math.max(0, box.x),
            y: Math.max(0, box.y),
            width: box.width,
            height: box.height,
            checked: 'checked' in input ? input.checked : undefined,
            value: input.type === 'radio' || input.type === 'checkbox' ? input.value : undefined,
          };
        })
        .catch(() => null);
      if (!item) {
        await handle.dispose();
        continue;
      }
      const ref = `e${elements.length + 1}`;
      this.handles.set(ref, handle as ElementHandle<HTMLElement>);
      elements.push({ ref, ...item });
    }
    const text = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const lines: string[] = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        if (
          !parent ||
          parent.closest('script,style,textarea,input,[hidden],[aria-hidden="true"],[data-private]')
        )
          continue;
        const value = node.textContent?.trim();
        if (!value) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const visible = [...range.getClientRects()].some(
          (b) =>
            b.width > 0 &&
            b.height > 0 &&
            b.bottom > 0 &&
            b.top < innerHeight &&
            b.right > 0 &&
            b.left < innerWidth,
        );
        const style = getComputedStyle(parent);
        if (visible && style.visibility !== 'hidden' && style.display !== 'none') lines.push(value);
      }
      return lines.join('\n').slice(0, 18000);
    });
    const image = await page.screenshot({
      type: 'png',
      animations: 'disabled',
      mask: [page.locator('input:not([type=radio]):not([type=checkbox]),textarea,[data-private]')],
      timeout: 10_000,
    });
    // Playwright temporarily adds screenshot masking styles; capture revision after cleanup.
    const revision = await page.evaluate(() => Number((window as any).__ssalRevision || 0));
    const screenshot = `${id}.png`;
    await writeFile(join(this.evidence, screenshot), image, { mode: 0o600 });
    const viewport = page.viewportSize() || { width: 1280, height: 840 };
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ url, text, elements }))
      .digest('hex');
    const observation = {
      id,
      url,
      title: await page.title(),
      text,
      elements,
      ...viewport,
      revision,
      fingerprint,
      screenshot,
      image,
      capturedAt: Date.now(),
    };
    this.latest = observation;
    return observation;
  }
  async assertFresh(id: string) {
    const o = this.latest;
    if (
      !o ||
      o.id !== id ||
      !this.page ||
      this.page.isClosed() ||
      this.page.url() !== o.url ||
      Date.now() - o.capturedAt > 180_000
    )
      throw new ServiceError('stale_observation');
    const revision = await this.page.evaluate(() => Number((window as any).__ssalRevision || 0));
    if (revision !== o.revision) throw new ServiceError('stale_observation');
    return o;
  }
  async formSnapshot() {
    return this.page!.locator('form').evaluateAll((forms) =>
      forms.map((form) => ({
        action: (form as HTMLFormElement).action,
        method: (form as HTMLFormElement).method,
        fields: [...form.querySelectorAll('input,textarea,select')]
          .filter((el) => !['hidden', 'password'].includes((el as HTMLInputElement).type))
          .map((el) => ({
            name: (el as HTMLInputElement).name || el.getAttribute('aria-label'),
            type: (el as HTMLInputElement).type,
            value: (el as HTMLInputElement).value,
            checked: (el as HTMLInputElement).checked,
          })),
      })),
    );
  }
  async act(step: Step) {
    const o = await this.assertFresh(step.observationId);
    const page = this.page!;
    const target = step.ref ? this.handles.get(step.ref) : undefined;
    if (step.ref && !target) throw new ServiceError('unknown_element');
    this.invalidate();
    if (step.action === 'navigate') {
      if (!step.url) throw new ServiceError('url_required');
      await this.navigate(step.url);
    } else if (step.action === 'search') {
      if (!step.text) throw new ServiceError('query_required');
      await this.navigate(`https://www.google.com/search?q=${encodeURIComponent(step.text)}`);
    } else if (step.action === 'scroll') {
      // A page may scroll inside a panel; wheel over the observed content, not the window corner.
      const x = step.x ?? o.width / 2;
      const y = step.y ?? o.height * 0.65;
      if (x < 0 || y < 0 || x >= o.width || y >= o.height)
        throw new ServiceError('invalid_scroll_target');
      await page.mouse.move(x, y);
      await page.mouse.wheel(0, step.delta || 650);
    } else if (step.action === 'click') {
      if (target) {
        const element = o.elements.find((e) => e.ref === step.ref);
        // Styled radios/checkboxes often put the associated label over the input.
        const label =
          element && ['radio', 'checkbox'].includes(element.type)
            ? await target.evaluateHandle((el) => (el as HTMLInputElement).labels?.[0] || null)
            : undefined;
        try {
          await (label?.asElement() || target).click({ timeout: 6000 });
        } finally {
          await label?.dispose();
        }
      } else if (
        step.x !== undefined &&
        step.y !== undefined &&
        step.x < o.width &&
        step.y < o.height
      )
        await page.mouse.click(step.x, step.y);
      else throw new ServiceError('invalid_click_target');
    } else if (step.action === 'type') {
      if (!target || step.text === undefined) throw new ServiceError('input_target_required');
      await target.fill(step.text);
    } else if (step.action === 'key') {
      if (
        !['Tab', 'Shift+Tab', 'Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'Space'].includes(
          step.text || '',
        )
      )
        throw new ServiceError('unsupported_key');
      await page.keyboard.press(step.text!);
    } else if (step.action === 'wait') await page.waitForTimeout(750);
    else throw new ServiceError('not_a_browser_action');
    await page.waitForTimeout(250);
  }
  async close() {
    await this.context?.close();
    this.context = undefined;
  }
}
