import type { ElementHandle, Page } from 'playwright';

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
  editorEmpty: boolean;
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
export async function inspectInstagram(
  page: Page,
  target: InstagramTarget,
  selector: string,
  observedElements?: ElementHandle<Node>[],
) {
  return page.evaluate(
    ({ target, selector, observedElements }) => {
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
      // Indexes must address the exact handles captured by observe. Re-querying here
      // can shift every index when Instagram inserts a comment or navigation item.
      const all = (observedElements || [
        ...document.querySelectorAll<HTMLElement>(selector),
      ]) as HTMLElement[];
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
        editorEmpty: !!editor && !((editor as HTMLTextAreaElement).value ?? editor.innerText),
        editorMatches:
          !!editor && ((editor as HTMLTextAreaElement).value ?? editor.innerText) === target.text,
      };
    },
    { target, selector, observedElements },
  );
}

// Read-only view movement for receipt verification. Never clicks a social button,
// fetches a hidden API, or scrolls unrelated feeds outside this post's comment root.
export async function moveInstagramReceiptView(
  page: Page,
  target: InstagramTarget,
  actor: string,
  mode: 'advance' | 'reveal',
) {
  return page.evaluate(
    ({ target, actor, mode }) => {
      const helpers = {
        norm(s: string) {
          return s.replace(/\s+/g, ' ').trim();
        },
        path(s: string) {
          return new URL(s, location.href).pathname
            .replace(/^\/[\w.]+\/(p|reel)\//, '/$1/')
            .replace(/\/$/, '');
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
      };
      const { norm, path, visible } = helpers;
      if (target.kind !== 'comment' || path(location.href) !== path(target.url)) return false;
      const editors = [
        ...document.querySelectorAll<HTMLElement>('textarea,[contenteditable=true]'),
      ].filter(
        (e) =>
          visible(e) &&
          /댓글|comment/i.test(e.getAttribute('aria-label') || e.getAttribute('placeholder') || ''),
      );
      if (editors.length !== 1) return false;
      let root: HTMLElement | null = editors[0]!.parentElement;
      while (
        root &&
        root !== document.body &&
        ![...root.querySelectorAll('section svg[aria-label]')].some((e) =>
          /^(댓글 달기|comment)$/i.test(e.getAttribute('aria-label') || ''),
        )
      )
        root = root.parentElement;
      if (!root || root === document.body) return false;
      if (mode === 'reveal') {
        const matches = [...root.querySelectorAll<HTMLElement>('span,div,p')].filter((e) => {
          if (
            !target.text ||
            !visible(e) ||
            e.closest('form') ||
            norm(e.innerText || '') !== norm(target.text)
          )
            return false;
          for (
            let row = e.parentElement, depth = 0;
            row && row !== root && depth < 5;
            row = row.parentElement, depth++
          ) {
            const authors = [...row.querySelectorAll<HTMLAnchorElement>('a[href]')]
              .map((a) => path(a.href))
              .filter((p) => /^\/[\w.]+$/.test(p));
            if (authors.length) return authors.every((p) => p.slice(1).toLowerCase() === actor);
          }
          return false;
        });
        if (!matches.length) return false;
        matches[0]!.scrollIntoView({ block: 'center', inline: 'nearest' });
        return true;
      }
      const panes = [...root.querySelectorAll<HTMLElement>('div,ul')].filter(
        (e) =>
          visible(e) &&
          e.clientHeight > 100 &&
          e.scrollHeight > e.clientHeight + 100 &&
          /auto|scroll/.test(getComputedStyle(e).overflowY) &&
          !!e.querySelector('a[href]') &&
          !e.contains(editors[0]!),
      );
      if (panes.length !== 1) return false;
      panes[0]!.scrollTop = panes[0]!.scrollHeight;
      return true;
    },
    { target, actor, mode },
  );
}
