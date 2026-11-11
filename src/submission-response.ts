import { completionMessage } from './completion.js';
import { maskPrivateText } from './private-text.js';

export type ReceiptField = {
  kind: 'code' | 'message' | 'receipt' | 'success' | 'status' | 'error';
  key: string;
  value: string;
};
export type SubmissionResponse = {
  id: string;
  intentHash: string;
  url: string;
  status: number;
  at: number;
  fields: ReceiptField[];
  bodyHash?: string;
  bodyState: 'reading' | 'parsed' | 'unsupported' | 'too_large' | 'unavailable';
};
export type ReceiptOutcome =
  'accepted' | 'rejected' | 'existing' | 'pending' | 'conflict' | 'unconfirmed';
export type ReceiptSignal = {
  kind: 'response' | 'dialog' | 'page';
  outcome: ReceiptOutcome;
  message: string;
  status?: number;
  codes?: string[];
  receiptNumbers?: string[];
};
export type ReceiptCheck = {
  intentHash: string;
  evidenceHash: string;
  outcome: ReceiptOutcome;
  method: 'rules' | 'ai';
  reason: string;
  at: number;
  signals: ReceiptSignal[];
};

const keyKind = (key: string): ReceiptField['kind'] | undefined => {
  const k = key.replace(/[_\s-]/g, '').toLowerCase();
  if (/^(?:code|resultcode|returncode|statuscode|responsecode|errorcode)$/.test(k)) return 'code';
  if (/^(?:message|msg|resultmessage|resultmsg|responsemessage|detail)$/.test(k)) return 'message';
  if (
    /^(?:receipt(?:no|number|id)|application(?:no|number)|submission(?:no|number|id)|registration(?:no|number)|접수번호|응모번호)$/.test(
      k,
    )
  )
    return 'receipt';
  if (/^(?:success|issuccess|ok)$/.test(k)) return 'success';
  if (/^(?:status|state|resultstatus)$/.test(k)) return 'status';
  if (/^(?:error|errors|errormessage|errormsg)$/.test(k)) return 'error';
};

// Only bounded result fields, never headers, cookies, echoed payloads or generic IDs.
export function responseFields(body: string, secrets: string[]): ReceiptField[] {
  const parsed: unknown = JSON.parse(body);
  const fields: ReceiptField[] = [];
  function walk(value: unknown, path = '', depth = 0) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return;
    for (const [key, v] of Object.entries(value)) {
      if (fields.length >= 16) return;
      const name = path ? `${path}.${key}` : key;
      const kind = keyKind(key);
      if (kind && ['string', 'number', 'boolean'].includes(typeof v)) {
        const text = maskPrivateText(String(v), secrets)
          .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[이메일]')
          .replace(/\b01[016789][ -]?\d{3,4}[ -]?\d{4}\b/g, '[전화번호]');
        fields.push({ kind, key: name.slice(0, 80), value: text.slice(0, 1000) });
      } else if (depth < 2 && /^(?:data|result|response|error|errors)$/i.test(key))
        walk(v, name, depth + 1);
    }
  }
  walk(parsed);
  return fields;
}

export function receiptTextOutcome(text: string): ReceiptOutcome {
  if (
    /이미[^\n.!?]{0,60}(?:참여|응모|접수|제출|등록)|중복\s*(?:참여|응모|접수|신청)|already\b[^\n]{0,50}(?:submitted|participated|registered)|duplicate\s*(?:entry|submission)/i.test(
      text,
    )
  )
    return 'existing';
  if (/접수\s*전|예시|(?:제출|응모|접수|등록|참여|동의)하면|완료될|example|will be/i.test(text))
    return 'unconfirmed';
  if (
    /완료\s*되지|(?:제출|접수|응모|등록|참여)\s*되지|실패|오류|미완료|잘못|유효하지|invalid|failed|failure|\berror\b|not\s+(?:been\s+)?(?:completed|submitted|recorded)/i.test(
      text,
    )
  )
    return 'rejected';
  if (
    /처리\s*중|접수\s*대기|처리\s*대기|승인\s*대기|pending|processing|queued|awaiting/i.test(text)
  )
    return 'pending';
  // A blank receipt-number label is often just part of a form or help text.
  if (
    /접수번호/.test(text) &&
    !/접수번호\s*[:：#]?\s*[A-Z0-9][A-Z0-9_-]{2,}/i.test(text) &&
    !completionMessage(text.replace(/접수번호/g, ''), text.replace(/접수번호/g, ''))
  )
    return 'unconfirmed';
  return completionMessage(text, text) ? 'accepted' : 'unconfirmed';
}

export function classifyResponse(r: SubmissionResponse): ReceiptSignal {
  const messages = r.fields
    .filter((f) => f.kind === 'message' || f.kind === 'error')
    .map((f) => f.value);
  const codes = r.fields.filter((f) => f.kind === 'code').map((f) => f.value);
  const receiptNumbers = r.fields
    .filter((f) => f.kind === 'receipt' && f.value.trim() && !f.value.includes('['))
    .map((f) => f.value);
  const states = r.fields
    .filter((f) => ['status', 'success', 'code'].includes(f.kind))
    .map((f) => f.value.toLowerCase());
  const outcomes = messages.map(receiptTextOutcome);
  const positive =
    outcomes.includes('accepted') ||
    (receiptNumbers.length > 0 &&
      (r.status === 201 ||
        states.some((v) =>
          /^(?:true|success|succeeded|accepted|completed|submitted|received)$/.test(v),
        )));
  const negative =
    r.status >= 400 ||
    states.some((v) => /^(?:false|error|fail|failed|failure|rejected|invalid)$/.test(v)) ||
    outcomes.includes('rejected') ||
    r.fields.some((f) => f.kind === 'error' && !/^(?:false|0|null|none|)$/i.test(f.value.trim()));
  const existing =
    outcomes.includes('existing') ||
    states.some((v) => /^(?:duplicate|already_submitted|already_participated)$/.test(v));
  const pending =
    r.status === 202 ||
    outcomes.includes('pending') ||
    states.some((v) => /^(?:pending|processing|queued)$/.test(v));
  const outcome: ReceiptOutcome =
    positive && (negative || existing || pending)
      ? 'conflict'
      : existing
        ? 'existing'
        : negative
          ? 'rejected'
          : pending
            ? 'pending'
            : positive && r.status >= 200 && r.status < 300
              ? 'accepted'
              : 'unconfirmed';
  return {
    kind: 'response',
    outcome,
    message: messages.join('\n').slice(0, 2000),
    status: r.status,
    codes,
    receiptNumbers,
  };
}

export function combineReceiptSignals(signals: ReceiptSignal[]): ReceiptOutcome {
  if (signals.some((s) => s.outcome === 'conflict')) return 'conflict';
  const accepted = signals.some((s) => s.outcome === 'accepted');
  const blocked = signals.find((s) => ['existing', 'rejected', 'pending'].includes(s.outcome));
  return accepted && blocked
    ? 'conflict'
    : blocked?.outcome || (accepted ? 'accepted' : 'unconfirmed');
}
export const receiptReasons: Record<ReceiptOutcome, string> = {
  accepted: '이번 제출과 연결된 접수 완료 증거를 확인했습니다.',
  rejected: '제출 결과에 오류·거절 안내가 있습니다. 자동 재제출하지 않습니다.',
  existing: '이미 참여했다는 안내입니다. 이번 시도의 신규 접수로 계산하지 않습니다.',
  pending: '서버가 처리 중·대기를 안내했습니다. 접수 완료는 아직 확정하지 않습니다.',
  conflict: '서버 응답·알림·화면의 결과가 서로 충돌합니다. 재제출 없이 확인이 필요합니다.',
  unconfirmed: '응답을 받았지만 명시적인 접수 완료를 확정하지 못했습니다. 재제출하지 않습니다.',
};
