// Passive receipt routing only: never grants navigation, input or direct API writes.
export type SubmissionContract = 'naver-form-answer' | 'campaign-g20-entry';
export function submissionRoute(pageUrl: string, requestUrl: string) {
  try {
    const page = new URL(pageUrl),
      request = new URL(requestUrl);
    if (request.username || request.password) return;
    if (
      page.origin === 'https://campaign.daum-kg.net' &&
      page.pathname === '/2028g20incheon/' &&
      request.origin === page.origin &&
      request.pathname === '/2028g20incheon/process/event_join_register.php' &&
      !request.search &&
      !request.hash
    )
      return 'campaign-g20-entry' as const;
    if (page.origin === request.origin) return 'same-origin' as const;
    const id = page.pathname.match(/^\/response\/([A-Za-z0-9_-]{5,100})\/?$/)?.[1];
    if (
      page.origin === 'https://form.naver.com' &&
      id &&
      request.origin === 'https://survey-api.naver.com' &&
      request.pathname === `/api/form/surveys/${id}/answers` &&
      !request.search &&
      !request.hash
    )
      return 'naver-form-answer' as const;
  } catch {
    /* Invalid/unrelated URLs are not submission evidence. */
  }
}

export function submissionBodyMatch(
  body: string,
  contentType: string,
  values: string[],
  contract?: SubmissionContract,
): 'matched' | 'insufficient_values' | 'unsupported_body' | 'payload_mismatch' {
  const approved = [...new Set(values.filter((v) => v.trim()))];
  // A Naver final page may contain only a phone field. The exact survey POST
  // route already supplies identity; require one substantial exact answer there.
  if (
    contract === 'naver-form-answer'
      ? !approved.length || !approved.some((v) => v.trim().length >= 6)
      : approved.length < 2 || !approved.some((v) => v.length >= 3)
  )
    return 'insufficient_values';
  if (Buffer.byteLength(body) > 65536) return 'unsupported_body';
  const parts: string[] = [];
  try {
    if (contentType.includes('application/json')) {
      const data: unknown = JSON.parse(body);
      if (contract === 'naver-form-answer') {
        // The published client posts {items:[{questionId,value,...}],taToken,extras}.
        // Compare answer values only; auth tokens and extras cannot bind a submission.
        const items = (data as { items?: unknown })?.items;
        if (!Array.isArray(items) || items.length > 500) return 'unsupported_body';
        for (const item of items)
          if (item && typeof item === 'object' && typeof item.value === 'string')
            parts.push(item.value);
      } else {
        let nodes = 0;
        const walk = (v: unknown, depth: number) => {
          if (++nodes > 2000 || depth > 8 || parts.length > 500) throw new Error('body_limit');
          if (typeof v === 'string') parts.push(v);
          else if (Array.isArray(v)) for (const item of v) walk(item, depth + 1);
          else if (v && typeof v === 'object')
            for (const [key, value] of Object.entries(v))
              if (!/token|password|cookie|authorization|secret/i.test(key)) walk(value, depth + 1);
        };
        walk(data, 0);
      }
    } else if (
      contract !== 'naver-form-answer' &&
      contentType.includes('application/x-www-form-urlencoded')
    )
      parts.push(...new URLSearchParams(body).values());
    else if (contract !== 'naver-form-answer' && /^multipart\/form-data\s*;/i.test(contentType)) {
      const boundary = contentType.match(/;\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))/i);
      const token = boundary?.[1] || boundary?.[2];
      if (!token || token.length > 70 || !/^[\w'()+,./:=? -]+$/.test(token))
        return 'unsupported_body';
      const delimiter = '--' + token;
      if (
        !body.startsWith(delimiter + '\r\n') ||
        (!body.endsWith(delimiter + '--\r\n') && !body.endsWith(delimiter + '--'))
      )
        return 'unsupported_body';
      const segments = body.split(delimiter).slice(1, -1);
      if (segments.length > 500) return 'unsupported_body';
      for (const segment of segments) {
        if (!segment.startsWith('\r\n') || !segment.endsWith('\r\n')) return 'unsupported_body';
        const split = segment.indexOf('\r\n\r\n');
        if (split < 0 || split > 4096) return 'unsupported_body';
        const headers = segment.slice(2, split);
        const dispositions = headers.split('\r\n').filter((h) => /^content-disposition:/i.test(h));
        if (dispositions.length !== 1) return 'unsupported_body';
        const disposition = dispositions[0]!;
        const name = disposition.match(
          /^content-disposition:\s*form-data;\s*name="([^"\r\n]*)"(?:;|$)/i,
        )?.[1];
        if (name === undefined) return 'unsupported_body';
        // Do not match answers against file bytes or authentication fields.
        if (
          /;\s*filename\*?=/i.test(disposition) ||
          /token|password|cookie|authorization|secret/i.test(name)
        )
          continue;
        parts.push(segment.slice(split + 4, -2));
      }
    } else return 'unsupported_body';
  } catch {
    return 'unsupported_body';
  }
  const normalize = (s: string) =>
    s.replace(/\r\n/g, '\n').replace(/[ ]+/g, ' ').replace(/\n\n+/g, '\n\n').trim();
  return approved.every((v) =>
    parts.some((p) => (contract ? normalize(p) === normalize(v) : p.includes(v))),
  )
    ? 'matched'
    : 'payload_mismatch';
}
