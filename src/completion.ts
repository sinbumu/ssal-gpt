// Receipt wording is necessary but not sufficient: callers also require a persisted
// submission intent, a new visible result and a same-scope observation.
export function receiptLineSafe(quote: string, visibleText: string) {
  if (!quote || !visibleText.includes(quote)) return false;
  const start = visibleText.indexOf(quote);
  const line = visibleText.slice(
    visibleText.lastIndexOf('\n', start) + 1,
    visibleText.indexOf('\n', start) >= 0 ? visibleText.indexOf('\n', start) : undefined,
  );
  if (
    /완료\s*되지|(?:제출|접수|응모|등록)되지|미완료|실패|오류|접수\s*전|예시|(?:제출|응모|접수|등록|동의)하면|완료될|not\s+(?:been\s+)?(?:completed|submitted|recorded)|incomplete|failed|example|will be/i.test(
      line,
    )
  )
    return false;
  return true;
}
export function completionMessage(quote: string, visibleText: string) {
  if (!receiptLineSafe(quote, visibleText)) return false;
  return /접수번호|접수.{0,12}완료|응모.{0,12}완료|제출.{0,12}완료|등록.{0,12}완료|(?:접수|응모|등록)(?:이|가)?\s*(?:되었습니다|됐습니다)|설문(?:조사|응답)?(?:이|가)?\s*완료되었습니다|(?:답변|응답)(?:이|가)?\s*제출되었습니다|response.{0,20}recorded|successfully.{0,20}submitted|submission.{0,20}complete/i.test(
    quote,
  );
}
