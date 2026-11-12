import {
  chromium,
  type BrowserContext,
  type Page,
  type ElementHandle,
  type Browser as ConnectedBrowser,
  type Route,
} from 'playwright';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  observationErrorCode,
  transientObservation,
  type ObservationDiagnostic,
} from './job-notice.js';
import { privateDirectory } from './config.js';
import { maskPrivateText } from './private-text.js';
import { ServiceError } from './auth.js';
import type { Step } from './model.js';
import { searchUrl } from './evidence.js';
import { isMoaform, moaformSnapshot } from './forms.js';
import {
  inspectInstagram,
  waitForInstagram,
  type InstagramTarget,
  type InstagramView,
} from './instagram.js';
const observableControls =
  'a[href],button,input,textarea,select,[contenteditable=true],[role=textbox],[role=button],[role=checkbox],summary';

export type VisibleElement = {
  ref: string;
  tag: string;
  role: string;
  type: string;
  label: string;
  context?: string;
  href?: string;
  navigationOnly?: boolean;
  mediaNavigation?: 'next' | 'previous';
  mediaKey?: string;
  readDisclosure?: 'caption';
  disclosureKey?: string;
  readPoint?: { x: number; y: number };
  mediaBounds?: { x: number; y: number; width: number; height: number }[];
  x: number;
  y: number;
  width: number;
  height: number;
  checked?: boolean;
  value?: string;
};
export type BrowserEngine = 'chromium' | 'chrome' | 'connected';
export function browserProfileDirectory(dir: string, engine: BrowserEngine) {
  return join(dir, engine === 'chrome' ? 'browser-chrome' : 'browser');
}
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
  hasResponseFields?: boolean;
  instagram?: InstagramView;
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
  private manual = true;
  private jobPages = new Map<string, Page>();
  private attached = new WeakSet<Page>();
  private documentEpoch = new WeakMap<Page, number>();
  observationContext?: { signal: AbortSignal; report: (event: ObservationDiagnostic) => void };
  private readOnlyPages = new WeakSet<Page>();
  private readOnlyMode = false;
  private readOnlyBlocks = 0;
  private external?: ConnectedBrowser;
  private connectionKey = randomUUID();
  private pendingExternal?: ConnectedBrowser;
  private externalTabs = new Map<string, Page>();
  private externalRoute?: (route: Route) => Promise<void>;
  private externalPage?: Page;
  constructor(
    private dir: string,
    private demoOrigin: string,
    private headless = false,
    public engine: BrowserEngine = 'chromium',
  ) {
    this.evidence = privateDirectory(join(dir, 'evidence'));
  }
  async open() {
    if (this.engine === 'connected' && !this.context)
      throw new ServiceError('browser_reconnect_required');
    if (this.context) {
      await this.ensurePage();
      return;
    }
    if (this.opening) return this.opening;
    this.opening = this.launch();
    try {
      await this.opening;
    } finally {
      this.opening = undefined;
    }
  }
  private async ensurePage() {
    if (this.page && !this.page.isClosed()) return;
    if (this.engine === 'connected') throw new ServiceError('connected_tab_closed');
    this.ownerJobId = undefined;
    const page =
      this.context!.pages().find((p) => !p.isClosed()) || (await this.context!.newPage());
    if (this.page !== page) this.attach(page);
  }
  async selectJob(id: string) {
    await this.open();
    if (this.engine === 'connected' && this.ownerJobId && this.ownerJobId !== id)
      throw new ServiceError('connected_tab_owned_by_another_job');
    // Keep POST-backed forms alive while an independent job uses its own tab.
    if (this.ownerJobId && this.page && !this.page.isClosed())
      this.jobPages.set(this.ownerJobId, this.page);
    const saved = this.jobPages.get(id);
    if (saved && !saved.isClosed()) {
      this.attach(saved);
      this.ownerJobId = id;
    } else if (this.ownerJobId && this.ownerJobId !== id) {
      this.attach(await this.context!.newPage());
      this.ownerJobId = undefined;
    }
    this.jobPages.set(id, this.page!);
    this.invalidate();
    // Automatic job switches must not request foreground focus. Explicit
    // dashboard open/connect actions may bring the selected page forward.
  }
  releaseCompletedJob(id: string) {
    this.jobPages.delete(id);
    if (this.ownerJobId === id) this.ownerJobId = undefined;
  }
  jobPage(id: string) {
    const page = this.ownerJobId === id ? this.page : this.jobPages.get(id);
    return page && !page.isClosed() ? page : undefined;
  }
  setManual(manual: boolean) {
    this.manual = manual;
  }
  setReadOnlyMode(readOnly: boolean) {
    this.readOnlyMode = readOnly;
    if (this.page) {
      if (readOnly) this.readOnlyPages.add(this.page);
      else this.readOnlyPages.delete(this.page);
    }
  }
  profileKey() {
    return this.engine === 'connected' ? `connected:${this.connectionKey}` : this.engine;
  }
  info() {
    return {
      engine: this.engine,
      profileKey: this.profileKey(),
      open: !!this.context,
      manual: this.manual,
      profile:
        this.engine === 'connected'
          ? '직접 연결한 브라우저 · 선택한 탭'
          : this.engine === 'chrome'
            ? '쌀-GPT 전용 Chrome'
            : '쌀-GPT 전용 Chromium',
    };
  }
  async connectionStatus() {
    const page = this.page;
    if (!page || page.isClosed())
      return { state: 'closed', message: '전용 브라우저를 먼저 열어 주세요.' };
    let host = '';
    try {
      host = new URL(page.url()).hostname;
    } catch {}
    const service = /(^|\.)naver\.com$/.test(host)
      ? 'naver'
      : /(^|\.)(google|youtube)\.com$/.test(host)
        ? 'google'
        : /(^|\.)instagram\.com$/.test(host)
          ? 'instagram'
          : 'other';
    if (service === 'other')
      return {
        state: 'unknown',
        service,
        message: '이 페이지의 로그인 상태는 직접 확인해 주세요.',
      };
    // Only return status booleans, never page text, identifiers or cookie values.
    const signals = await page.evaluate(() => {
      const controls = [...document.querySelectorAll<HTMLElement>('a,button,[role=button]')]
        .filter((el) => {
          const s = getComputedStyle(el);
          return !!el.getClientRects().length && s.visibility !== 'hidden' && s.display !== 'none';
        })
        .map((el) =>
          (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
        );
      return {
        blocked:
          /브라우저\s*(?:또는|나)\s*앱[\s\S]{0,30}안전하지|this browser or app may not be secure/i.test(
            document.body.innerText,
          ),
        signOut: controls.some((label) => /^(로그아웃|sign out|log out)$/i.test(label)),
        signIn: controls.some((label) =>
          /^(?:(?:NAVER|네이버)\s*)?(로그인|sign in|log in)$/i.test(label),
        ),
        instagramProfile: [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].some((a) => {
          const label =
            (a.innerText || '') +
            ' ' +
            (a.getAttribute('aria-label') || '') +
            ' ' +
            (a.querySelector('img')?.alt || '');
          return (
            !!a.getClientRects().length &&
            /profile|프로필/i.test(label) &&
            /^\/[a-zA-Z0-9._]+\/?$/.test(a.getAttribute('href') || '') &&
            !/accounts|explore|direct|reels/.test(a.getAttribute('href') || '')
          );
        }),
        googleAccount: [...document.querySelectorAll<HTMLElement>('[aria-label]')].some(
          (el) =>
            !!el.getClientRects().length &&
            /^(Google 계정|Google Account):/.test(el.getAttribute('aria-label') || ''),
        ),
        password: [...document.querySelectorAll('input[type=password]')].some(
          (el) => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden',
        ),
      };
    });
    if (signals.blocked)
      return {
        state: 'blocked',
        service,
        message:
          '사이트가 이 브라우저의 로그인을 거부했습니다. 일반 브라우저의 직접 참여 경로를 이용할 수 있습니다.',
      };
    if (
      signals.signOut ||
      (!signals.password &&
        !signals.signIn &&
        ((service === 'instagram' && signals.instagramProfile) ||
          (service === 'google' && signals.googleAccount)))
    )
      return {
        state: 'signed_in_visible',
        service,
        message:
          '현재 화면의 계정 전용 표시로 로그인 상태를 확인했습니다. 마지막 관측 결과이며 세션 만료 시 다시 확인합니다.',
      };
    if (signals.signIn || signals.password)
      return {
        state: 'login_required',
        service,
        message:
          '현재 화면에서 로그인이 필요합니다. 네이버는 홈에서 확인하고, 로그인 상태 유지를 직접 선택해 주세요.',
      };
    return {
      state: 'unknown',
      service,
      message: '로그인 여부를 확정할 표시가 없습니다. 서비스 화면에서 직접 확인해 주세요.',
    };
  }
  async setEngine(engine: BrowserEngine) {
    if (engine === this.engine) return;
    const previous = this.engine;
    await this.close();
    this.engine = engine;
    try {
      await this.open();
    } catch {
      this.engine = previous;
      throw new ServiceError('browser_channel_unavailable');
    }
  }
  async inReadOnlyTab<T>(read: () => Promise<T>): Promise<T> {
    if (this.engine === 'connected')
      throw new ServiceError('connected_browser_extra_tab_not_granted');
    await this.open();
    const original = this.page!;
    const owner = this.ownerJobId;
    const previousReadOnly = this.readOnlyMode;
    this.readOnlyMode = true;
    const tab = await this.context!.newPage();
    this.attach(tab);
    this.readOnlyPages.add(tab);
    try {
      return await read();
    } finally {
      for (const popup of this.context?.pages() || []) {
        if (popup !== tab && (await popup.opener()) === tab) await popup.close().catch(() => {});
      }
      await tab.close().catch(() => {});
      this.readOnlyMode = previousReadOnly;
      this.attach(original);
      this.ownerJobId = owner;
    }
  }
  async evidenceImage(name: string) {
    if (!/^[a-f0-9-]+\.png$/.test(name)) throw new ServiceError('invalid_evidence_file');
    const { readFile } = await import('node:fs/promises');
    return readFile(join(this.evidence, name));
  }
  private async launch() {
    this.context = await chromium.launchPersistentContext(
      privateDirectory(browserProfileDirectory(this.dir, this.engine)),
      {
        channel: this.engine === 'chrome' ? 'chrome' : undefined,
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
        if (
          (this.readOnlyMode || this.readOnlyPages.has(route.request().frame().page())) &&
          !['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())
        ) {
          if (route.request().isNavigationRequest()) this.readOnlyBlocks++;
          return await route.abort('blockedbyclient');
        }
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
    const context = this.context;
    this.context.on('close', () => {
      if (this.context !== context) return;
      this.context = undefined;
      this.page = undefined;
      this.latest = undefined;
      this.ownerJobId = undefined;
    });
  }
  private attach(page: Page) {
    this.page = page;
    if (this.readOnlyMode) this.readOnlyPages.add(page);
    this.latest = undefined;
    if (this.attached.has(page)) return;
    this.attached.add(page);
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.documentEpoch.set(page, (this.documentEpoch.get(page) || 0) + 1);
        if (this.page === page) this.invalidate();
      }
    });
    // Manual login must leave native confirmation dialogs to the person at the browser.
    page.on('dialog', (dialog) => {
      if (!this.manual) void dialog.dismiss().catch(() => {});
    });
    page.on('download', (download) => void download.cancel().catch(() => {}));
    page.on('close', () => {
      if (this.page === page) {
        this.page = undefined;
        this.ownerJobId = undefined;
        this.invalidate();
      }
    });
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
  async observe(
    fullPage = false,
    secrets: string[] = [],
    instagram?: InstagramTarget,
  ): Promise<Observation> {
    const context = this.observationContext;
    context?.signal.throwIfAborted();
    await this.open();
    const intendedPage = this.page;
    let lastCode = '';
    for (let attempt = 0; attempt <= 2; attempt++) {
      context?.signal.throwIfAborted();
      const progress: { stage: ObservationDiagnostic['stage'] } = { stage: 'ready' };
      this.invalidate();
      try {
        if (!intendedPage || intendedPage.isClosed()) throw new ServiceError('browser_closed');
        if (this.page !== intendedPage) throw new ServiceError('observation_target_changed');
        const observation = await this.observeOnce(fullPage, secrets, instagram, progress);
        context?.signal.throwIfAborted();
        if (attempt)
          context?.report({
            at: Date.now(),
            stage: 'finalize',
            code: lastCode,
            attempt,
            outcome: 'recovered',
          });
        return observation;
      } catch (error) {
        this.invalidate();
        context?.signal.throwIfAborted();
        const code = observationErrorCode(error);
        const retry = transientObservation(code) && attempt < 2;
        context?.report({
          at: Date.now(),
          stage: progress.stage,
          code,
          attempt: attempt + 1,
          outcome: retry ? 'retrying' : 'stopped',
        });
        if (!retry)
          throw new ServiceError(
            transientObservation(code) ? 'browser_observation_unstable' : code,
          );
        lastCode = code;
        // Read again in the same tab, never reload, navigate or replay an action.
        await delay(250 * (attempt + 1), undefined, { signal: context?.signal });
      }
    }
    throw new ServiceError('browser_observation_unstable');
  }
  private async observeOnce(
    fullPage: boolean,
    secrets: string[],
    instagram: InstagramTarget | undefined,
    progress: { stage: ObservationDiagnostic['stage'] },
  ): Promise<Observation> {
    await this.open();
    const page = this.page!;
    const epoch = this.documentEpoch.get(page) || 0;
    if (!(await page.evaluate(() => !!document.body && document.readyState !== 'loading')))
      throw new ServiceError('observation_document_not_ready');
    if (page.isClosed()) throw new ServiceError('browser_closed');
    if (instagram) await waitForInstagram(page, instagram, observableControls);
    const url = page.url();
    if (
      /google\.[^/]+\/sorry\//i.test(url) ||
      (await page
        .locator('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],#challenge-running')
        // Background/hidden frames do not ask the person to solve a challenge.
        // Re-check every observation; a displayed challenge still pauses immediately.
        .filter({ visible: true })
        .count())
    ) {
      this.invalidate();
      throw new ServiceError('verification_required_manual');
    }
    if (
      /\/login|\/signin|\/challenge|\/checkpoint|accounts\.google|auth\.openai/i.test(url) ||
      (await page.locator('input[type=password]').filter({ visible: true }).count())
    ) {
      this.invalidate();
      throw new ServiceError('needs_login_manual');
    }
    for (const handle of this.handles.values()) await handle.dispose().catch(() => {});
    this.handles.clear();
    const id = randomUUID();
    progress.stage = 'controls';
    const handles = await page.locator(observableControls).elementHandles();
    const elements: VisibleElement[] = [];
    const social = instagram
      ? await inspectInstagram(page, instagram, observableControls, handles)
      : undefined;
    const socialRefs: InstagramView['controls'] = {};
    // Count only controls that serialize inside the viewport. Hidden navigation
    // trees and offscreen elements must not exhaust the visible control budget.
    // Preserve the exact indexes inspected for Instagram and release every handle.
    for (const [index, handle] of handles.entries()) {
      if (elements.length >= 500) {
        await handle.dispose().catch(() => {});
        continue;
      }
      const serialized = await handle
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
            return 'null';
          const input = el as HTMLInputElement;
          const label =
            el.getAttribute('aria-label') ||
            (input.labels ? [...input.labels].map((l) => l.innerText).join(' ') : '') ||
            el.innerText ||
            el.querySelector('svg[aria-label]')?.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            el.getAttribute('name') ||
            '';
          let navigationArea = false;
          for (
            let parent = el.parentElement;
            parent && parent !== document.body;
            parent = parent.parentElement
          ) {
            if (
              parent.matches('nav,header,[role=navigation]') ||
              /(?:^|[\s_-])(header|nav|gnb|lnb|menu)(?:[\s_-]|$)/i.test(
                `${parent.id} ${parent.className}`,
              )
            )
              navigationArea = true;
          }
          const navigationOnly =
            el instanceof HTMLAnchorElement &&
            navigationArea &&
            !el.closest('form') &&
            /^(javascript:|#)/i.test(el.getAttribute('href') || '') &&
            !!label.trim() &&
            !/가입|로그인|로그아웃|신청|등록|응모|제출|참여|신고|삭제|저장|동의|구매|결제|해지|login|logout|sign.?up|submit|send|post|delete|save|buy|follow|like/i.test(
              label,
            );
          // Only an arrow over the visible post's large media is a read control.
          // A generic Next button, a form control, or a feed/profile arrow is not.
          const direction = /^(다음|next)$/i.test(label.trim())
            ? 'next'
            : /^(이전|previous|prev)$/i.test(label.trim())
              ? 'previous'
              : undefined;
          let mediaIdentity: string | undefined;
          // Instagram reels expose the collapsed caption itself as a button.
          // Classify the clipping structure, not words such as "like" in its text.
          const clippedCaption =
            /^(www\.)?instagram\.com$/.test(location.hostname) &&
            /^\/(p|reel|reels)\/[^/]+\/?$/.test(location.pathname) &&
            el.matches('button,[role=button]') &&
            !el.closest('form,[contenteditable=true]') &&
            !el.hasAttribute('aria-pressed') &&
            !el.hasAttribute('aria-checked') &&
            !el.querySelector(
              'button,[role=button],input,textarea,select,[contenteditable=true]',
            ) &&
            label.trim().length >= 40 &&
            box.width >= 120 &&
            box.height <= 160 &&
            [el, ...el.querySelectorAll<HTMLElement>('div,span,p')].some((node) => {
              const css = getComputedStyle(node),
                lines = Number(css.webkitLineClamp);
              return (
                lines >= 1 &&
                lines <= 5 &&
                css.overflow === 'hidden' &&
                node.innerText.trim() === el.innerText.trim() &&
                node.clientHeight > 0 &&
                node.scrollHeight > node.clientHeight + 10
              );
            });
          // Hashtags may be links inside the clipped body. Select a point whose
          // nearest interactive ancestor is the caption itself, never a link.
          const readPoint = clippedCaption
            ? [
                [0.5, 0.5],
                [0.15, 0.25],
                [0.85, 0.25],
                [0.15, 0.75],
                [0.85, 0.75],
              ]
                .map(([x, y]) => ({ x: box.width * x!, y: box.height * y! }))
                .find(
                  (p) =>
                    document
                      .elementFromPoint(box.x + p.x, box.y + p.y)
                      ?.closest(
                        'a[href],button,[role=button],input,textarea,select,[contenteditable=true]',
                      ) === el,
                )
            : undefined;
          const mediaNavigation: 'next' | 'previous' | undefined =
            direction &&
            /^(www\.)?instagram\.com$/.test(location.hostname) &&
            /^\/(p|reel|reels)\/[^/]+\/?$/.test(location.pathname) &&
            el.matches('button,[role=button]') &&
            !el.closest('form') &&
            !el.hasAttribute('aria-pressed') &&
            !el.hasAttribute('aria-checked') &&
            [...document.querySelectorAll('main img,main video,article img,article video')].some(
              (media) => {
                const r = media.getBoundingClientRect(),
                  s = getComputedStyle(media);
                const matches =
                  r.width >= 200 &&
                  r.height >= 160 &&
                  s.visibility !== 'hidden' &&
                  s.display !== 'none' &&
                  box.width <= 80 &&
                  box.height <= 80 &&
                  box.left >= r.left &&
                  box.right <= r.right &&
                  box.top >= r.top &&
                  box.bottom <= r.bottom &&
                  (direction === 'next'
                    ? box.left > r.left + r.width * 0.65
                    : box.right < r.left + r.width * 0.35);
                if (matches)
                  mediaIdentity = `${(media as HTMLImageElement).currentSrc || media.getAttribute('src')}|${media.getAttribute('alt') || ''}`;
                return matches;
              },
            )
              ? direction
              : undefined;
          return JSON.stringify({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || '',
            type:
              el instanceof HTMLInputElement || el instanceof HTMLButtonElement
                ? el.type
                : el.getAttribute('type') || '',
            label: label.slice(0, 240),
            // A directory row's rendered type (e.g. survey vs comment) helps
            // rank its link. Never collect response controls or entire tables.
            context:
              el instanceof HTMLAnchorElement &&
              el.closest('tr')?.querySelector('a[href]') === el &&
              !el
                .closest('tr')!
                .querySelector(
                  'input,textarea,select,[contenteditable=true],[data-private],[aria-hidden=true]',
                )
                ? (el.closest('tr') as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 300)
                : undefined,
            href: el instanceof HTMLAnchorElement ? el.href : undefined,
            navigationOnly,
            mediaNavigation,
            mediaIdentity,
            readDisclosure: readPoint ? ('caption' as const) : undefined,
            disclosureIdentity: readPoint ? `${location.pathname}|${label}` : undefined,
            readPoint,
            mediaBounds: direction
              ? [...document.querySelectorAll('main img,main video,article img,article video')]
                  .map((media) => media.getBoundingClientRect())
                  .filter((r) => r.width >= 200 && r.height >= 160)
                  .slice(0, 8)
                  .map(({ x, y, width, height }) => ({ x, y, width, height }))
              : undefined,
            x: Math.max(0, box.x),
            y: Math.max(0, box.y),
            width: box.width,
            height: box.height,
            checked:
              'checked' in input
                ? input.checked
                : el.hasAttribute('aria-pressed')
                  ? el.getAttribute('aria-pressed') === 'true'
                  : undefined,
            value: input.type === 'radio' || input.type === 'checkbox' ? input.value : undefined,
          });
        })
        .catch(() => 'null');
      const item = JSON.parse(serialized) as
        | (Omit<VisibleElement, 'ref'> & { mediaIdentity?: string; disclosureIdentity?: string })
        | null;
      if (!item) {
        await handle.dispose();
        continue;
      }
      const ref = `e${elements.length + 1}`;
      this.handles.set(ref, handle as ElementHandle<HTMLElement>);
      const { mediaIdentity, disclosureIdentity, ...visibleItem } = item;
      elements.push({
        ref,
        ...visibleItem,
        mediaKey: mediaIdentity
          ? createHash('sha256').update(mediaIdentity).digest('hex')
          : undefined,
        disclosureKey: disclosureIdentity
          ? createHash('sha256').update(disclosureIdentity).digest('hex')
          : undefined,
      });
      if (social)
        for (const [kind, targetIndex] of Object.entries(social.controls)) {
          if (index === targetIndex) socialRefs[kind as keyof typeof socialRefs] = ref;
        }
    }
    // evaluateAll injects a selector engine into the page's main world, where
    // legacy sites may replace Map. These fixed DOM reads need no selector engine
    // and must not restore/overwrite the site's globals to make it work.
    const frames: Omit<VisibleElement, 'ref'>[] = JSON.parse(
      await page.evaluate(() =>
        JSON.stringify(
          [...document.querySelectorAll('iframe[src]')].flatMap((frame) => {
            const el = frame as HTMLIFrameElement;
            const box = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            if (
              !box.width ||
              !box.height ||
              box.bottom <= 0 ||
              box.top >= innerHeight ||
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              !/^https?:/.test(el.src)
            )
              return [];
            return [
              {
                tag: 'iframe',
                role: 'link',
                type: 'frame',
                label: el.title || '내장 본문을 별도 페이지로 읽기',
                href: el.src,
                x: Math.max(0, box.x),
                y: Math.max(0, box.y),
                width: box.width,
                height: box.height,
              },
            ];
          }),
        ),
      ),
    );
    for (const frame of frames) elements.push({ ref: `frame${elements.length + 1}`, ...frame });
    progress.stage = 'text';
    let text = await page.evaluate((fullPage) => {
      if (!document.body) return null;
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
            (fullPage || (b.bottom > 0 && b.top < innerHeight)) &&
            b.right > 0 &&
            b.left < innerWidth,
        );
        const style = getComputedStyle(parent);
        if (visible && style.visibility !== 'hidden' && style.display !== 'none') lines.push(value);
      }
      return lines.join('\n').slice(0, 18000);
    }, fullPage);
    if (text === null) throw new ServiceError('observation_document_not_ready');
    text = maskPrivateText(text, secrets);
    for (const element of elements) {
      element.label = maskPrivateText(element.label, secrets);
      if (element.context) element.context = maskPrivateText(element.context, secrets);
    }
    if (fullPage && (await page.evaluate(() => document.documentElement.scrollHeight)) > 12000)
      throw new ServiceError('form_page_too_large');
    progress.stage = 'screenshot';
    const image = await page.screenshot({
      type: 'png',
      animations: 'disabled',
      fullPage,
      mask: [
        page.locator(
          'input:not([type=radio]):not([type=checkbox]),textarea,select,[contenteditable=true],[role=textbox],[data-private]',
        ),
        ...secrets
          .filter((v) => v.length >= 2)
          .map((value) => page.getByText(value, { exact: false })),
      ],
      timeout: 10_000,
    });
    // Playwright temporarily adds screenshot masking styles; capture revision after cleanup.
    progress.stage = 'finalize';
    const revision = await page.evaluate(() => Number((window as any).__ssalRevision || 0));
    const screenshot = `${id}.png`;
    await writeFile(join(this.evidence, screenshot), image, { mode: 0o600 });
    const viewport =
      page.viewportSize() ||
      (await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })));
    const hasResponseFields = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          'input,textarea,select,[role=checkbox],[role=radio],[contenteditable=true]',
        ),
      ].some((el) => {
        if (['hidden', 'submit', 'button', 'reset'].includes((el as HTMLInputElement).type))
          return false;
        const style = getComputedStyle(el);
        return (
          (!!el.getClientRects().length &&
            style.display !== 'none' &&
            style.visibility !== 'hidden') ||
          [...((el as HTMLInputElement).labels || [])].some((l) => !!l.getClientRects().length)
        );
      }),
    );
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
      hasResponseFields,
      instagram: social ? { ...social, controls: socialRefs } : undefined,
      fingerprint,
      screenshot,
      image,
      capturedAt: Date.now(),
    };
    if (this.page !== page) throw new ServiceError('observation_target_changed');
    if (page.url() !== url || (this.documentEpoch.get(page) || 0) !== epoch)
      throw new ServiceError('observation_navigation_changed');
    this.latest = observation;
    return observation;
  }
  async assertFresh(id: string, action?: Step['action']) {
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
    // Reading or opening an explicitly validated URL does not use a DOM target.
    // Decorative animations must not prevent obtaining the next observation.
    // Clicks/inputs/evidence still require the exact revision. Tab, URL and age
    // checks apply to every action, including these read-only operations.
    if (revision !== o.revision && !['scroll', 'wait', 'navigate', 'search'].includes(action || ''))
      throw new ServiceError('stale_observation');
    return o;
  }
  async formSnapshot() {
    if (
      isMoaform(this.page!) ||
      (await this.page!.locator(
        '[role=radio]:not(input),[role=checkbox]:not(input),[role=listbox][jsname=W85ice],[draggable=true],fieldset button,[role=listitem] [role=button]',
      ).count())
    )
      return moaformSnapshot(this.page!);
    return this.page!.evaluate(() => {
      const helpers = {
        label(el: Element) {
          return (
            el.getAttribute('aria-label') ||
            (el.getAttribute('aria-labelledby') || '')
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent?.trim() || '')
              .join(' ')
              .trim() ||
            [...((el as HTMLInputElement).labels || [])]
              .map((l) => l.textContent?.trim())
              .join(' ') ||
            ''
          );
        },
      };
      const forms = [...document.forms];
      const scopes = forms.length ? forms : [document.body];
      return scopes.map((form) => {
        const groups = [...form.querySelectorAll('fieldset,[role=group],[role=radiogroup]')];
        return {
          action: form instanceof HTMLFormElement ? form.action : location.href,
          method: form instanceof HTMLFormElement ? form.method : undefined,
          fields: [
            ...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
              'input,textarea,select',
            ),
          ]
            .filter((el) => !['hidden', 'password', 'submit', 'button', 'reset'].includes(el.type))
            .map((el, index) => {
              const group = el.closest('fieldset,[role=group],[role=radiogroup]');
              const heading = group
                ?.querySelector('legend,h1,h2,h3,h4,[role=heading]')
                ?.textContent?.trim();
              const choice = ['checkbox', 'radio'].includes(el.type);
              return {
                name: el.name || el.getAttribute('aria-label'),
                type: el.type,
                value:
                  el.type === 'file'
                    ? Array.from((el as HTMLInputElement).files || [])
                        .map((f) => f.name)
                        .join(', ')
                    : el.value,
                checked: el instanceof HTMLInputElement ? el.checked : undefined,
                label:
                  heading ||
                  (group ? helpers.label(group) : '') ||
                  (!choice ? helpers.label(el) : ''),
                optionLabel: choice ? helpers.label(el) : undefined,
                displayValue:
                  el instanceof HTMLSelectElement
                    ? [...el.selectedOptions].map((o) => o.label)
                    : undefined,
                group: choice
                  ? el.name || (group ? `group-${groups.indexOf(group)}` : `field-${index}`)
                  : `field-${index}`,
              };
            }),
        };
      });
    });
  }
  async act(step: Step, secrets: string[] = []) {
    let o: Observation;
    let rebound = false;
    const prior = this.latest;
    try {
      o = await this.assertFresh(step.observationId, step.action);
    } catch (error) {
      const old = prior?.elements.find((e) => e.ref === step.ref);
      if (
        !(error instanceof ServiceError) ||
        error.code !== 'stale_observation' ||
        step.action !== 'click' ||
        prior?.id !== step.observationId ||
        !((old?.mediaNavigation && old.mediaKey) || (old?.readDisclosure && old.disclosureKey)) ||
        !this.page ||
        !this.readOnlyPages.has(this.page) ||
        this.page.url() !== prior.url
      )
        throw error;
      const fresh = await this.observe(false, secrets);
      const matches = fresh.elements.filter(
        (e) =>
          e.mediaNavigation === old.mediaNavigation &&
          e.mediaKey === old.mediaKey &&
          e.readDisclosure === old.readDisclosure &&
          e.disclosureKey === old.disclosureKey &&
          e.tag === old.tag &&
          e.role === old.role &&
          e.label === old.label,
      );
      if (fresh.url !== prior.url || matches.length !== 1) throw error;
      step = { ...step, observationId: fresh.id, ref: matches[0]!.ref };
      // One rebind only, with a new handle. A changed image or another mutation stops.
      o = await this.assertFresh(step.observationId, step.action);
      rebound = true;
    }
    const page = this.page!;
    const blockedBefore = this.readOnlyBlocks;
    const target = step.ref ? this.handles.get(step.ref) : undefined;
    if (step.ref && !target) throw new ServiceError('unknown_element');
    this.invalidate();
    if (step.action === 'navigate') {
      if (!step.url) throw new ServiceError('url_required');
      await this.navigate(step.url);
    } else if (step.action === 'search') {
      if (!step.text) throw new ServiceError('query_required');
      await this.navigate(searchUrl(step.text, step.searchEngine));
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
          const labelElement = label?.asElement();
          const clickTarget =
            labelElement && (await labelElement.isVisible()) ? labelElement : target;
          if (element?.readDisclosure) {
            const point = element.readPoint;
            if (
              !point ||
              !(await target.evaluate((el, p) => {
                const b = el.getBoundingClientRect();
                return (
                  document
                    .elementFromPoint(b.x + p.x, b.y + p.y)
                    ?.closest(
                      'a[href],button,[role=button],input,textarea,select,[contenteditable=true]',
                    ) === el
                );
              }, point))
            )
              throw new ServiceError('stale_observation');
            await clickTarget.click({ timeout: 6000, position: point });
          } else await clickTarget.click({ timeout: 6000 });
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
    if (this.readOnlyPages.has(page) && this.readOnlyBlocks > blockedBefore)
      throw new ServiceError('read_only_request_blocked');
    return rebound;
  }
  async close() {
    if (this.external) {
      if (this.externalPage && this.externalRoute)
        await this.externalPage.unroute('**/*', this.externalRoute).catch(() => {});
      await this.external.close();
      this.external = undefined;
      this.externalPage = undefined;
      this.externalRoute = undefined;
    } else await this.context?.close();
    this.context = undefined;
    this.page = undefined;
    this.ownerJobId = undefined;
    this.jobPages.clear();
    this.invalidate();
  }

  async listConnection(endpoint: string) {
    const url = new URL(endpoint);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new ServiceError('local_debugging_endpoint_required');
    const response = await fetch(new URL('/json/version', url), {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    const version = (await response.json()) as { webSocketDebuggerUrl?: string };
    const ws = new URL(version.webSocketDebuggerUrl || 'invalid:');
    if (
      ws.protocol !== 'ws:' ||
      ws.hostname !== '127.0.0.1' ||
      ws.port !== url.port ||
      ws.username ||
      ws.password ||
      !/^\/devtools\/browser\/[a-f0-9-]+$/.test(ws.pathname)
    )
      throw new ServiceError('local_debugging_endpoint_required');
    await this.pendingExternal?.close();
    this.pendingExternal = await chromium.connectOverCDP(ws.href, { timeout: 10000 });
    this.externalTabs.clear();
    const tabs = [];
    for (const context of this.pendingExternal.contexts()) {
      for (const page of context.pages()) {
        const id = randomUUID();
        this.externalTabs.set(id, page);
        // Connection inventory only. No body, screenshot, cookies or unrelated tabs' inputs.
        tabs.push({ id, url: page.url(), title: await page.title().catch(() => '') });
      }
    }
    return tabs;
  }
  async connectTab(id: string) {
    const selected = this.externalTabs.get(id),
      pending = this.pendingExternal;
    if (!selected || selected.isClosed() || !pending)
      throw new ServiceError('connection_tab_not_available');
    await this.close();
    this.external = pending;
    this.pendingExternal = undefined;
    this.externalTabs.clear();
    this.engine = 'connected';
    this.connectionKey = randomUUID();
    this.context = selected.context();
    this.externalPage = selected;
    this.attach(selected);
    this.externalRoute = async (route) => {
      try {
        if (this.readOnlyMode && !['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
          this.readOnlyBlocks++;
          await route.abort('blockedbyclient');
          return;
        }
        await validateUrl(route.request().url(), this.demoOrigin);
        await route.continue();
      } catch {
        await route.abort('blockedbyclient').catch(() => {});
      }
    };
    await selected.route('**/*', this.externalRoute);
    const track = () => {
      if ((window as any).__ssalExternalTracking) return;
      (window as any).__ssalExternalTracking = true;
      (window as any).__ssalRevision = 0;
      new MutationObserver(() => {
        (window as any).__ssalRevision++;
      }).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      window.addEventListener(
        'input',
        () => {
          (window as any).__ssalRevision++;
        },
        true,
      );
      window.addEventListener(
        'scroll',
        () => {
          (window as any).__ssalRevision++;
        },
        true,
      );
    };
    await selected.addInitScript(track);
    await selected.evaluate(track);
    this.setManual(true);
    this.setReadOnlyMode(false);
    await selected.bringToFront();
  }
  async disconnectPending() {
    await this.pendingExternal?.close();
    this.pendingExternal = undefined;
    this.externalTabs.clear();
  }
}
