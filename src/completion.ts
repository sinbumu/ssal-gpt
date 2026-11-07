// Receipt wording is necessary but not sufficient: callers also require a persisted
// submission intent, a new visible result and a same-scope observation.
export function completionMessage(quote: string, visibleText: string) {
  if (!quote || !visibleText.includes(quote)) return false;
  const start = visibleText.indexOf(quote);
  const line = visibleText.slice(
    visibleText.lastIndexOf('\n', start) + 1,
    visibleText.indexOf('\n', start) >= 0 ? visibleText.indexOf('\n', start) : undefined,
  );
  if (
    /완료\s*되지|미완료|실패|오류|접수\s*전|not\s+(?:been\s+)?(?:completed|submitted|recorded)|incomplete|failed/i.test(
      line,
    )
  )
    return false;
  return /접수번호|접수.{0,12}완료|응모.{0,12}완료|제출.{0,12}완료|등록.{0,12}완료|설문(?:조사|응답)?(?:이|가)?\s*완료되었습니다|response.{0,20}recorded|successfully.{0,20}submitted|submission.{0,20}complete/i.test(
    quote,
  );
}
