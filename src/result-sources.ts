// These are public reading targets, never private inboxes, participation forms or action URLs.
export function publicResultSource(value: string) {
  try {
    const u = new URL(value);
    const path = decodeURIComponent(u.pathname);
    const query = decodeURIComponent(u.search);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return false;
    if (
      /^(?:forms\.gle|forms\.g(?:oogle)?\.com|form\.naver\.com|naver\.me|mail\.|accounts\.)/i.test(
        u.hostname,
      )
    )
      return false;
    if (u.hostname === 'docs.google.com' && /^\/forms\//.test(path)) return false;
    if (
      /(?:^|\/)(?:direct|inbox|messages|login|logout|signin|signout|oauth|delete|submit|unsubscribe)(?:\/|\.|$)/i.test(
        path,
      )
    )
      return false;
    if (/[?&](?:access_token|token|auth|code|key|action)=/i.test(query)) return false;
    if (/(^|\.)instagram\.com$/i.test(u.hostname)) return /^\/(?:p|reel)\/[\w-]+\/?$/.test(path);
    return true;
  } catch {
    return false;
  }
}
