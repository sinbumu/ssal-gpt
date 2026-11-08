import type { Observation } from './browser.js';

export type SourceEvidence = {
  id: string;
  url: string;
  title: string;
  text: string;
  screenshot: string;
  observedAt: number;
};

export function collectEvidence(previous: SourceEvidence[], o: Observation) {
  if (previous.some((s) => s.url === o.url && s.text === o.text)) return previous;
  return [
    ...previous,
    {
      id: o.id,
      url: o.url,
      title: o.title,
      text: o.text,
      screenshot: o.screenshot,
      observedAt: o.capturedAt,
    },
  ].slice(-20);
}

export function searchPage(raw: string) {
  const u = new URL(raw);
  return (
    (/^(www\.)?google\./.test(u.hostname) && /^\/(search|sorry)/.test(u.pathname)) ||
    u.hostname === 'search.naver.com'
  );
}

export function channelFromTrail(urls: string[]) {
  for (const raw of urls) {
    const host = new URL(raw).hostname;
    if (/(^|\.)instagram\.com$/.test(host)) return '인스타그램';
    if (host === 'search.naver.com' || host === 'blog.naver.com') return '네이버';
    if (/(^|\.)google\.[a-z.]+$/.test(host)) return 'Google 검색';
  }
  return undefined;
}

export function searchUrl(query: string, engine: 'naver' | 'google' = 'naver') {
  return engine === 'google'
    ? `https://www.google.com/search?q=${encodeURIComponent(query)}`
    : `https://search.naver.com/search.naver?query=${encodeURIComponent(query)}`;
}
