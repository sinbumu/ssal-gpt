import type { BrowserContext, Page } from 'playwright';
import { ServiceError } from './auth.js';

/** Create a real tab in the same profile, without activating its native window. */
export async function backgroundPage(context: BrowserContext, anchor: Page): Promise<Page> {
  const session = await context.newCDPSession(anchor);
  let created: string | undefined;
  let listener: ((page: Page) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { targetInfo } = await session.send('Target.getTargetInfo');
    let resolvePage!: (page: Page) => void;
    let rejectPage!: (error: Error) => void;
    const ready = new Promise<Page>((resolve, reject) => {
      resolvePage = resolve;
      rejectPage = reject;
    });
    // Register before createTarget: Playwright's page event can precede its response.
    const seen: Page[] = [];
    const inspect = async (page: Page) => {
      if (!created || page.isClosed()) return;
      const probe = await context.newCDPSession(page).catch(() => undefined);
      if (!probe) return;
      try {
        const { targetInfo: candidate } = await probe.send('Target.getTargetInfo');
        if (candidate.targetId === created) resolvePage(page);
      } catch {
        // A different tab may close while the intended one initializes.
      } finally {
        await probe.detach().catch(() => {});
      }
    };
    listener = (page) => {
      seen.push(page);
      void inspect(page);
    };
    context.on('page', listener);
    const result = await session.send('Target.createTarget', {
      url: 'about:blank',
      ...(targetInfo.browserContextId ? { browserContextId: targetInfo.browserContextId } : {}),
      background: true,
      focus: false,
    });
    created = result.targetId;
    timer = setTimeout(() => rejectPage(new Error('background_tab_not_ready')), 10_000);
    for (const page of seen) void inspect(page);
    return await ready;
  } catch (error) {
    // Only our new blank tab is disposable. Never retry by opening an active tab.
    if (created) await session.send('Target.closeTarget', { targetId: created }).catch(() => {});
    throw new ServiceError('browser_background_tab_failed');
  } finally {
    if (timer) clearTimeout(timer);
    if (listener) context.off('page', listener);
    await session.detach().catch(() => {});
  }
}

/** Window activation is explicit in the dashboard; input/element focus stays native. */
export const scriptWindowFocusGuard = `Object.defineProperty(window, 'focus', {
  configurable: true, writable: true, value: function focus() {}
});`;
