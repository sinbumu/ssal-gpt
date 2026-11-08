// Only explicit progress labels count. A fraction in a quiz or a date must not
// turn a possible final submission into an automatically approved Next click.
export function pageProgress(text: string, url?: string) {
  const matches = [
    ...text.matchAll(
      /(?:^|\n)[ \t]*(\d{1,3})[ \t]*\/[ \t]*(\d{1,3})[ \t]*(?:page|페이지)(?=\s|$)/gi,
    ),
  ];
  if (url && new URL(url).hostname === 'form.naver.com') {
    matches.push(
      ...text.matchAll(
        /(?:^|\n)[ \t]*설문 진행 상태[ \t]*\n[ \t]*(\d{1,3})[ \t]*\/[ \t]*(\d{1,3})[ \t]*(?=\n|$)/g,
      ),
    );
  }
  const values = matches.map((match) => ({ current: Number(match[1]), total: Number(match[2]) }));
  if (
    !values.length ||
    values.some(({ current, total }) => current < 1 || total < current || total > 200)
  )
    return;
  const first = values[0]!;
  if (values.some(({ current, total }) => current !== first.current || total !== first.total))
    return;
  return first;
}
