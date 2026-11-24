import type { Page } from 'playwright';
import type { Browser } from './browser.js';
import { canonicalUrl, type EventRecord, type Store } from './store.js';
import { ServiceError } from './auth.js';

export type DeadlineCheck = {
  date: string;
  source: string;
  at: number;
  state: 'open' | 'closed' | 'unknown';
  reason: string;
  quote?: string;
  until?: number;
  screenshot?: string;
};
const compact = (text: string) => text.replace(/\s/g, '');
export const supportedDeadlineSource = (raw: string) => {
  const u = new URL(raw);
  return (
    u.protocol === 'https:' &&
    !u.port &&
    !u.username &&
    !u.password &&
    ['instagram.com', 'www.instagram.com'].includes(u.hostname) &&
    /^\/(?:[\w.]+\/)?(?:p|reel)\/[\w-]+\/?$/.test(u.pathname)
  );
};
export function canCheckDeadline(e: EventRecord, now = Date.now()) {
  return (
    !e.deadline &&
    e.deadlineDate === new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) &&
    supportedDeadlineSource(e.sourceUrl) &&
    canonicalUrl(e.sourceUrl) === canonicalUrl(e.entryUrl)
  );
}

export function assessDeadline(
  e: EventRecord,
  caption: string,
  ownerCaption: boolean,
  now = Date.now(),
): DeadlineCheck {
  const result: DeadlineCheck = {
    date: e.deadlineDate!,
    source: e.sourceUrl,
    at: now,
    state: 'unknown',
    reason: '공식 게시물에서 현재 접수 여부를 확인할 수 없습니다.',
  };
  const task = e.tasks?.find((t) => t.kind === 'comment');
  if (!canCheckDeadline(e, now) || !task || !compact(caption).includes(compact(task.quote)))
    return result;
  const [year, month, day] = e.deadlineDate!.split('-').map(Number);
  const date = `(?:${year}|${String(year).slice(-2)})[.년/\\s-]+0?${month}[.월/\\s-]+0?${day}(?!\\d)(?:일|\\.)?(?:\\s*\\([월화수목금토일]\\))?`;
  const lines = caption
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean);
  const index = lines.findIndex((l) => /(?:참여|응모|접수|이벤트)\s*기간/.test(l));
  if (index < 0) return result;
  const window = lines
    .slice(index, index + 2)
    .join(' ')
    .slice(0, 350);
  const end = new RegExp(
    '(?:~|～|–|부터|\\s-\\s)\\s*' +
      date +
      '(?:\\s*(\\d{1,2})\\s*(?:시(?:\\s*(\\d{1,2})분)?|:(\\d{2})))?',
    'u',
  ).exec(window);
  if (!end) return result;
  result.quote = window;
  result.reason =
    '원문의 참여 기간은 오늘까지입니다. 접수 종료 시각과 현재 접수 상태는 확인되지 않았습니다.';
  if (!ownerCaption) return result;
  const closed = lines.find((l) =>
    /^(?:[📢📌✔️\s]*)(?:본\s*)?(?:이벤트|응모|접수|참여)(?:가|는|를)?\s*(?:조기\s*)?(?:마감|종료)(?:되었습니다|됐습니다|합니다|했습니다)[.!\s]*$/u.test(
      l,
    ),
  );
  if (closed)
    return {
      ...result,
      state: 'closed',
      reason: '주최자 게시물에 마감 안내가 있습니다.',
      quote: closed,
    };
  if (!end[1] || /조기\s*(?:종료|마감)|선착순|소진\s*시|오전|오후/.test(caption)) return result;
  const h = Number(end[1]),
    m = Number(end[2] || end[3] || 0);
  if (h > 23 || m > 59) return result;
  const until = Date.parse(
    `${result.date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`,
  );
  return {
    ...result,
    until,
    state: now < until ? 'open' : 'closed',
    reason:
      now < until
        ? '공식 게시물에 명시된 접수 시간 안입니다.'
        : '공식 게시물의 종료 시각이 지났습니다.',
  };
}

export async function readDeadline(page: Page, e: EventRecord, now = Date.now()) {
  const anchor = e.tasks?.find((t) => t.kind === 'comment')?.quote || '';
  const same = canonicalUrl(page.url()) === canonicalUrl(e.sourceUrl);
  if (!same || !anchor) return assessDeadline(e, '', false, now);
  const caption = await page.evaluate((quote) => {
    const visible = (el: HTMLElement) =>
      !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    const match = (el: HTMLElement) =>
      visible(el) && el.innerText.replace(/\s/g, '').includes(quote.replace(/\s/g, ''));
    // Only the unique post title can establish a closing time. Surrounding text can
    // corroborate a date, but a comment or an enabled editor cannot prove acceptance.
    const titles = [...document.querySelectorAll<HTMLElement>('main h1,article h1')].filter(match);
    return titles.length === 1
      ? { text: titles[0]!.innerText, owner: true }
      : { text: document.body.innerText.slice(0, 24000), owner: false };
  }, anchor);
  return assessDeadline(e, caption.text, caption.owner, now);
}

export async function recheckDeadline(store: Store, browser: Browser, id: string) {
  const event = store.event(id);
  if (
    !event ||
    !canCheckDeadline(event) ||
    store.submission(id) ||
    (event.management && event.management.mode !== 'active')
  )
    throw new ServiceError('deadline_check_unavailable');
  const check = await browser.inReadOnlyTab(async () => {
    await browser.navigate(event.sourceUrl);
    const page = browser.page!;
    await page
      .waitForFunction(() => document.body.innerText.trim().length > 100, undefined, {
        timeout: 5000,
      })
      .catch(() => {});
    const observation = await browser.observe(false);
    const result = await readDeadline(page, event);
    return { ...result, screenshot: observation.screenshot };
  });
  const current = store.event(id)!;
  if (
    !canCheckDeadline(current) ||
    current.sourceUrl !== check.source ||
    current.deadlineDate !== check.date ||
    store.submission(id) ||
    (current.management && current.management.mode !== 'active')
  )
    throw new ServiceError('deadline_check_unavailable');
  store.saveEvent({ ...current, deadlineCheck: check });
  return check;
}
