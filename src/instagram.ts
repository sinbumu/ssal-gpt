import type { Page } from 'playwright';

export type InstagramTarget = { url: string; kind: 'like' | 'follow' | 'comment'; text?: string };
export type InstagramView = {
  actor?: string;
  subject?: string;
  ready: boolean;
  reason?: string;
  liked: boolean;
  following: boolean;
  requested: boolean;
  ownComment: boolean;
  editorMatches: boolean;
  controls: Partial<Record<'like' | 'follow' | 'comment' | 'post', string>>;
};
export function instagramTarget(raw: string, kind: string) {
  try {
    const u = new URL(raw);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.port ||
      !['www.instagram.com', 'instagram.com'].includes(u.hostname)
    )
      return false;
    if (!['like', 'follow', 'comment'].includes(kind)) return false;
    if (/^\/(?:[\w.]+\/)?(p|reel)\/[\w-]+\/?$/.test(u.pathname)) return true;
    return (
      kind === 'follow' &&
      /^\/[\w.]+\/?$/.test(u.pathname) &&
      !/^\/(accounts|direct|explore|reels|stories|about|legal)\/?$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}

// Read only rendered DOM. No internal APIs, cookies, React state or CSS class dependencies.
// Element indexes refer to Browser.observe's freshly captured handle list.
export async function waitForInstagram(page: Page, target: InstagramTarget, selector: string) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (
      /\/login|\/signin|\/challenge|\/checkpoint/i.test(page.url()) ||
      (await page.locator('input[type=password]').count())
    )
      return;
    const view = await inspectInstagram(page, target, selector);
    if (
      view.ready ||
      !['instagram_account_not_identified', 'instagram_target_not_identified'].includes(
        view.reason || '',
      )
    )
      return;
    await page.waitForTimeout(250);
  }
}
export async function inspectInstagram(page: Page, target: InstagramTarget, selector: string) {
  return page.evaluate(
    ({ target, selector }) => {
      const helpers = {
        norm(s: string) {
          return s.replace(/\s+/g, ' ').trim();
        },
        visible(el: Element) {
          const r = el.getBoundingClientRect(),
            s = getComputedStyle(el);
          return (
            r.width > 0 &&
            r.height > 0 &&
            s.display !== 'none' &&
            s.visibility !== 'hidden' &&
            !el.closest('[hidden],[aria-hidden=true]')
          );
        },
        label(el: Element) {
          return helpers.norm(
            el.getAttribute('aria-label') ||
              (el as HTMLElement).innerText ||
              el.querySelector('svg[aria-label]')?.getAttribute('aria-label') ||
              el.getAttribute('placeholder') ||
              '',
          );
        },
        path(raw: string) {
          try {
            return new URL(raw, location.href).pathname
              .replace(/^\/[\w.]+\/(p|reel)\//, '/$1/')
              .replace(/\/$/, '');
          } catch {
            return '';
          }
        },
        handle(raw: string) {
          return /^\/[\w.]+$/.test(helpers.path(raw))
            ? helpers.path(raw).slice(1).toLowerCase()
            : undefined;
        },
      };
      const { norm, visible, label, path, handle } = helpers;
      const all = [...document.querySelectorAll<HTMLElement>(selector)];
      const actors = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
        .filter((a) => {
          const img = a.querySelector('img');
          return (
            visible(a) &&
            img &&
            /프로필|profile/i.test(img.alt) &&
            (!!a.closest('nav,aside,[role=navigation]') || a.getBoundingClientRect().x < 160)
          );
        })
        .map((a) => handle(a.href))
        .filter(Boolean);
      const uniqueActors = [...new Set(actors)];
      const actor = uniqueActors.length === 1 ? uniqueActors[0] : undefined;
      const blocked =
        /잠시 후 다시|활동이 제한|계정.*제한|자동화된 행동|try again later|action blocked|suspect automated/i.test(
          document.body.innerText,
        );
      const targetPath = path(target.url);
      const post = /^\/(p|reel)\//.test(targetPath);
      let root: HTMLElement | undefined;
      let editor: HTMLElement | undefined;
      if (post) {
        const editors = all.filter(
          (e) =>
            visible(e) &&
            e.matches('textarea,[contenteditable=true]') &&
            /댓글|comment/i.test(label(e)),
        );
        if (editors.length === 1) {
          editor = editors[0];
          for (let p = editor!.parentElement; p && p !== document.body; p = p.parentElement) {
            if (
              [...p.querySelectorAll('section svg[aria-label]')].some((e) =>
                /^(댓글 달기|comment)$/i.test(e.getAttribute('aria-label') || ''),
              )
            ) {
              root = p;
              break;
            }
          }
        }
      } else {
        const headers = [...document.querySelectorAll<HTMLElement>('main header,header')].filter(
          visible,
        );
        root = headers.find((e) =>
          [...e.querySelectorAll('h1,h2')].some(
            (h) => norm(h.textContent || '').toLowerCase() === targetPath.slice(1).toLowerCase(),
          ),
        );
      }
      const buttons = root
        ? all.filter((e) => root!.contains(e) && visible(e) && e.matches('button,[role=button]'))
        : [];
      const actionSections = root
        ? [...root.querySelectorAll('section')].filter((s) =>
            [...s.querySelectorAll('svg[aria-label]')].some((e) =>
              /^(댓글 달기|comment)$/i.test(e.getAttribute('aria-label') || ''),
            ),
          )
        : [];
      const like = buttons.filter(
        (e) =>
          /^(좋아요|좋아요 취소|like|unlike)$/i.test(label(e)) &&
          actionSections.some((s) => s.contains(e)),
      );
      const follow = buttons.filter(
        (e) =>
          /^(팔로우|팔로잉|요청됨|follow|following|requested)$/i.test(label(e)) &&
          !e.closest('li,[role=listitem]'),
      );
      let subject: string | undefined;
      if (!post) subject = targetPath.slice(1).toLowerCase();
      else if (root) {
        // Post's first visible profile link is its author; comments are below it.
        const authors = [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(
          (a) => visible(a) && handle(a.href),
        );
        subject = authors.length ? handle(authors[0]!.href) : undefined;
      }
      const form = editor?.closest('form');
      const publish = buttons.filter(
        (e) => /^(게시|등록|post|send)$/i.test(label(e)) && !!form?.contains(e),
      );
      const ownComment = !!(
        root &&
        actor &&
        target.text &&
        [...root.querySelectorAll<HTMLElement>('span,div,p')].some((e) => {
          if (!visible(e) || e.closest('form') || norm(e.innerText || '') !== norm(target.text!))
            return false;
          for (
            let row = e.parentElement, depth = 0;
            row && row !== root && depth < 5;
            row = row.parentElement, depth++
          ) {
            const authors = [...row.querySelectorAll<HTMLAnchorElement>('a[href]')]
              .map((a) => handle(a.href))
              .filter(Boolean);
            if (authors.length) return authors.every((a) => a === actor) && authors.includes(actor);
          }
          return false;
        })
      );
      const controls: Partial<Record<'like' | 'follow' | 'comment' | 'post', number>> = {};
      const controlHelper = {
        add(key: keyof typeof controls, els: HTMLElement[]) {
          if (els.length === 1) controls[key] = all.indexOf(els[0]!);
        },
      };
      controlHelper.add('like', like);
      controlHelper.add('follow', follow);
      controlHelper.add('comment', editor ? [editor] : []);
      controlHelper.add('post', publish);
      const controlExists =
        target.kind === 'comment'
          ? !!editor
          : target.kind === 'like'
            ? like.length === 1
            : follow.length === 1;
      return {
        actor,
        subject,
        controls,
        ready:
          !!actor &&
          !!subject &&
          !!root &&
          !blocked &&
          path(location.href) === targetPath &&
          controlExists,
        reason: blocked
          ? 'instagram_account_restricted'
          : !actor
            ? 'instagram_account_not_identified'
            : !root || !subject || !controlExists
              ? 'instagram_target_not_identified'
              : path(location.href) !== targetPath
                ? 'task_target_changed'
                : undefined,
        liked:
          like.length === 1 &&
          (/^(좋아요 취소|unlike)$/i.test(label(like[0]!)) ||
            like[0]!.getAttribute('aria-pressed') === 'true'),
        following: follow.length === 1 && /^(팔로잉|following)$/i.test(label(follow[0]!)),
        requested: follow.length === 1 && /^(요청됨|requested)$/i.test(label(follow[0]!)),
        ownComment,
        editorMatches:
          !!editor && ((editor as HTMLTextAreaElement).value ?? editor.innerText) === target.text,
      };
    },
    { target, selector },
  );
}
