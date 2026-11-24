// Only respondent pages with an unambiguous public form identifier.
export function microsoftFormId(raw: string) {
  try {
    const url = new URL(raw);
    const values = url.searchParams.getAll('id');
    if (
      ['https://forms.cloud.microsoft', 'https://forms.office.com'].includes(url.origin) &&
      !url.username &&
      !url.password &&
      /^\/pages\/responsepage\.aspx$/i.test(url.pathname) &&
      values.length === 1 &&
      /^[A-Za-z0-9_-]{5,250}$/.test(values[0]!)
    )
      return values[0];
  } catch {
    /* outside the verified route */
  }
}
