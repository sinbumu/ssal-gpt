import type { Page, Request, CDPSession } from 'playwright';
import { hash } from './autonomy.js';

// Passive, bounded Chromium buffer: a reload can evict Playwright's response
// body before it is read. Never intercept, modify or replay the request.
export async function durableResponseReader(page: Page, origin: string) {
  let client: CDPSession | undefined;
  const candidates = new Map<string, { key: string; finished: boolean }>();
  const key = (url: string, body: string) => hash({ url, body });
  let open = true;
  try {
    client = await page.context().newCDPSession(page);
    client.on('Network.requestWillBeSent', (e) => {
      if (
        !open ||
        e.request.method !== 'POST' ||
        !e.request.postData ||
        new URL(e.request.url).origin !== origin ||
        candidates.size >= 8
      )
        return;
      candidates.set(e.requestId, { key: key(e.request.url, e.request.postData), finished: false });
    });
    client.on('Network.loadingFinished', (e) => {
      const c = candidates.get(e.requestId);
      if (c) c.finished = true;
    });
    client.on('Network.loadingFailed', (e) => candidates.delete(e.requestId));
    await client.send(
      'Network.enable',
      { maxTotalBufferSize: 262144, maxResourceBufferSize: 65536, maxPostDataSize: 65536 },
      { timeout: 2000 },
    );
    try {
      await client.send(
        'Network.configureDurableMessages',
        { maxTotalBufferSize: 262144, maxResourceBufferSize: 65536 },
        { timeout: 2000 },
      );
    } catch {
      await client.send(
        'Network.enable',
        {
          maxTotalBufferSize: 262144,
          maxResourceBufferSize: 65536,
          maxPostDataSize: 65536,
          enableDurableMessages: true,
        },
        { timeout: 2000 },
      );
    }
  } catch {
    await client?.detach().catch(() => {});
    client = undefined;
  }
  return {
    async read(request: Request): Promise<Buffer | undefined> {
      if (!client || !open) return;
      const matched = [...candidates].filter(
        ([, c]) => c.key === key(request.url(), request.postData() || ''),
      );
      if (matched.length !== 1) return;
      const [requestId, state] = matched[0]!;
      const until = Date.now() + 750;
      while (open && !state.finished && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (!open || !state.finished) return;
      try {
        const result = await client.send(
          'Network.getResponseBody',
          { requestId },
          { timeout: 1000 },
        );
        const body = Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8');
        return body.length <= 65536 ? body : undefined;
      } catch {
        return;
      }
    },
    close() {
      open = false;
      candidates.clear();
      void client?.detach().catch(() => {});
    },
  };
}
