// Mask longer overlapping values first (e.g. an address before its province).
// Rendered line breaks must not turn a saved multi-word value into public text.
export function maskPrivateText(text: string, secrets: string[]) {
  const values = [...new Set(secrets.filter((v) => typeof v === 'string' && v.length >= 2))].sort(
    (a, b) => b.length - a.length,
  );
  for (const value of values) {
    const pattern = value
      .trim()
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+');
    if (pattern) text = text.replace(new RegExp(pattern, 'g'), '[저장된 정보]');
    text = text.split(encodeURIComponent(value)).join('[저장된 정보]');
  }
  return text;
}
