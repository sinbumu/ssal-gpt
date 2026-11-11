// Passive receipt routing only: never grants navigation, input or direct API writes.
export type SubmissionContract = 'naver-form-answer';
export function submissionRoute(pageUrl: string, requestUrl: string) {
  try {
    const page = new URL(pageUrl),
      request = new URL(requestUrl);
    if (request.username || request.password) return;
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
  if (approved.length < 2 || !approved.some((v) => v.length >= 3)) return 'insufficient_values';
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
    } else if (!contract && contentType.includes('application/x-www-form-urlencoded'))
      parts.push(...new URLSearchParams(body).values());
    else return 'unsupported_body';
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
