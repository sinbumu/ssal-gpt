import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { readJson, writePrivate } from './config.js';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

export type ProviderChoice = { kind: 'chatgpt' | 'api'; accountId?: string; model: string };
export type Account = {
  clientId: string;
  subject: string;
  email: string;
  label: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  scopes: string[];
};
type Vault = { hostId: string; accounts: Account[]; apiKey?: string };
type Attempt = {
  state: string;
  nonce: string;
  verifier: string;
  redirect: string;
  expires: number;
  clientId?: string;
  subject?: string;
};
type TokenReply = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
};

export class ServiceError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
const userMessages: Record<string, string> = {
  selection_changed_start_new_search:
    '선정 설정이 바뀌었습니다. 이전 제외 사유를 적용하지 않도록 새 탐색을 시작해 주세요.',
  personal_response_policy_stop:
    '추가 개인 응답 제외 설정에 따라 멈췄습니다. 이미 승인·실행한 과제가 있으면 자동으로 다른 후보를 시작하지 않습니다.',
  selection_call_limit: '선정 설정의 이 작업 AI 호출 상한에 도달했습니다. 운영 탭에서 확인하세요.',
  selection_token_limit:
    '선정 설정의 이 작업 보고 토큰 상한에 도달했습니다. 운영 탭에서 확인하세요.',
  preferred_prizes_required: '선호 경품만 허용하려면 경품 키워드를 하나 이상 입력해 주세요.',
  inbox_not_available:
    '현재 이 확인함에 답변할 수 없습니다. 갱신된 작업 상태를 확인해 주세요. 중지·완료된 작업은 실행 기록에 보관됩니다.',
  instagram_preview_required:
    '현재 계정과 과제 대상을 다시 확인해야 합니다. 새 화면에서 재개한 뒤 승인하세요.',
  instagram_account_not_identified:
    '현재 인스타 로그인 계정을 화면에서 확정하지 못했습니다. 전용 브라우저에서 로그인 상태를 확인하세요.',
  instagram_target_unavailable:
    '필수 인스타 대상 페이지를 사용할 수 없습니다. 원문의 대상 계정을 임의로 바꾸지 않습니다.',
  instagram_target_not_identified:
    '현재 인스타 화면에서 대상 게시물과 필요한 동작을 구분하지 못했습니다. 새 화면에서 재개해 다시 확인할 수 있습니다.',
  instagram_receipt_changed:
    '댓글 증거를 화면에 표시하는 동안 계정·대상 또는 댓글이 달라졌습니다. 재게시하지 않고 확인을 기다립니다.',
  instagram_account_or_target_changed:
    '승인 이후 인스타 계정 또는 대상이 바뀌었습니다. 동작하지 않았으며 새 화면에서 재개해 다시 승인해야 합니다.',
  instagram_account_restricted:
    '인스타가 계정 제한이나 자동화 경고를 표시했습니다. 추가 동작 없이 중단했습니다.',
  instagram_follow_requested:
    '팔로우 요청 상태입니다. 상대의 수락 전에는 팔로우 완료로 표시하지 않습니다.',
  completion_comment_requires_form:
    '참여 완료 댓글은 실제 폼 접수 뒤에 배치해야 합니다. 과제 순서를 다시 확인하세요.',
  picker_existing_file_requires_review:
    '같은 이름의 첨부가 있지만 이 허용으로 선택한 파일인지 확인할 수 없습니다. 브라우저에서 실제 파일을 확인하세요. 자동 교체·재업로드하지 않습니다.',
  task_target_ambiguous:
    '같은 행동 버튼이 여러 개여서 대상 게시물을 확정하지 못했습니다. 직접 확인하거나 과제를 수행한 뒤 결과를 기록하세요.',
  event_qualification_review_required:
    '저장한 자격·선택 기준을 충족하지 않거나 원문 조건이 불명확합니다. 기회 선택 기준과 원문을 확인하세요.',
  task_route_not_permitted:
    '해당 서비스의 자동 실행 허용 경로가 확인되지 않았거나 만료됐습니다. 과제 확인함에서 직접 수행 결과를 기록할 수 있습니다.',
  task_action_outside_grant:
    '계획한 과제·대상·게시 내용과 동작이 일치하지 않아 실행하지 않았습니다.',
  task_decision_recovery_exhausted:
    '실행 전 판단 오류를 자동 복구 한도까지 재검토했지만 해결하지 못했습니다. 실행 내역에 원인을 남겼으며 기존 승인과 완료 과제는 보존됩니다.',
  task_target_changed:
    '과제 대상 주소가 바뀌어 중단했습니다. 기존 승인을 다른 게시물에 적용하지 않습니다.',
  possible_existing_comment:
    '같은 댓글이 이미 보여 중복 게시를 중단했습니다. 본인의 기존 참여인지 확인하세요.',
  comment_content_changed: '게시할 댓글이 승인한 내용과 달라 전송하지 않았습니다.',
  picker_login_required:
    '파일 선택기에 Google 로그인이 필요합니다. 전용 브라우저에서 직접 로그인한 뒤 재개하세요.',
  picker_not_visible:
    '지원하는 파일 선택기를 확인하지 못했습니다. 전용 브라우저의 현재 파일 선택 화면을 확인하세요.',
  picker_control_ambiguous:
    '파일 또는 선택 버튼이 여러 개이거나 불명확합니다. 직접 대상 파일을 확인하세요.',
  picker_recipient_not_authorized:
    'Google Drive와 이 폼 주최자에게 선택 파일을 전달하는 허용이 필요합니다.',
  rank_not_changed:
    '드래그 후 순위가 바뀌지 않았습니다. 화면을 다시 확인하거나 직접 순위를 선택하세요.',
  daily_call_limit:
    '오늘 설정한 AI 호출 한도에 도달했습니다. 다음 날 재개하거나 운영 설정을 조정하세요.',
  daily_token_limit: '오늘 보고된 토큰 사용량이 설정 한도에 도달했습니다.',
  daily_estimated_cost_limit: '오늘의 API 추정 비용 한도에 도달했습니다.',
  cost_rate_required_for_selected_provider:
    '비용 제한을 사용하려면 선택한 API 모델의 단가를 입력하세요. ChatGPT 플랜은 금액으로 환산하지 않습니다.',
  unreported_usage_requires_review:
    '사용량을 확인하지 못한 호출이 있어 비용 제한에 따라 멈췄습니다. 공급자 사용 내역을 확인하세요.',
  attachment_upload_state_unknown:
    '파일 첨부를 시도했지만 현재 상태를 확인할 수 없습니다. 브라우저에서 확인 후 재개해 파일을 다시 선택하세요.',
  attachment_type_not_accepted: '이 문항에서 허용하지 않는 파일 형식입니다.',
  attachment_type_not_supported: 'PNG·JPEG·PDF 파일만 지원합니다.',
  attachment_size_limit: '첨부 파일은 5MB 이하여야 합니다.',
  attachment_outside_grant: '이 작업과 문항에 허용된 첨부 파일이 아닙니다.',
  browser_reconnect_required: '기존 브라우저 연결에서 사용할 탭을 다시 선택하세요.',
  connected_tab_closed:
    '선택한 탭이 닫혔습니다. 다른 탭을 자동으로 제어하지 않습니다. 직접 다시 연결하세요.',
  connected_tab_owned_by_another_job:
    '연결한 탭에서 다른 작업이 대기 중입니다. 전용 브라우저 모드에서 독립 작업을 진행할 수 있습니다.',
  connected_browser_extra_tab_not_granted:
    '선택한 탭 외 별도 조사 탭은 허용되지 않았습니다. 전용 브라우저 모드를 이용하세요.',
  local_debugging_endpoint_required:
    '직접 준비한 http://127.0.0.1:포트 형식의 로컬 디버깅 주소를 입력하세요.',
  result_requires_user_check:
    '공식 발표를 자동 확인하지 못했습니다. 당첨·낙첨은 확정하지 않았습니다.',
};
export function safeMessage(error: unknown): string {
  const entryMessages: Record<string, string> = {
    manual_participation_check_required:
      '수동 참여 여부가 미확인입니다. 처리 방법 선택에서 외부 참여가 없었는지 직접 확인하거나 수동으로 마무리하세요.',
    entry_management_unavailable:
      '실행 중이거나 완료한 응모는 여기서 정리할 수 없습니다. 진행 중 작업을 먼저 일시정지하세요.',
    entry_retry_unsafe:
      '새 응모를 안전하게 시작할 수 없는 상태입니다. 기존 작업과 제출 결과를 확인하거나 수동 진행을 선택하세요.',
    entry_management_blocks_automation:
      '드랍·수동 진행으로 정리한 후보입니다. 먼저 진행할 기회로 복원하세요.',
    entry_owned_by_another_job: '이전 실행 기록입니다. 현재 응모에 연결된 작업을 확인하세요.',
    retry_source_unavailable:
      '지정한 이벤트 원문을 확인할 수 없어 재도전을 멈췄습니다. 다른 이벤트로 바꾸지 않았습니다.',
    retry_target_changed:
      '재도전 대상과 다른 참여 주소가 제안되어 중단했습니다. 기존 응모 기록은 유지합니다.',
    manual_entry_not_active: '수동 진행 중인 후보에서만 직접 완료를 기록할 수 있습니다.',
  };
  if (error instanceof ServiceError && entryMessages[error.code]) return entryMessages[error.code]!;
  if (error instanceof ServiceError && userMessages[error.code]) return userMessages[error.code]!;
  if (error instanceof ServiceError)
    return typeof error.code === 'string' && error.code ? error.code : 'service_error';
  if (error instanceof Error && error.name === 'AbortError') return '작업이 중단되었습니다.';
  // Do not expose remote response bodies, authorization URLs, or browser exceptions.
  return '작업을 완료하지 못했습니다. 연결 상태와 실행 기록을 확인해 주세요.';
}

export function validateCallback(attempt: Attempt, params: URLSearchParams) {
  const state = params.get('state') || '';
  if (
    attempt.expires < Date.now() ||
    state.length !== attempt.state.length ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(attempt.state))
  )
    throw new ServiceError('oauth_invalid_state');
  if (params.has('error')) throw new ServiceError('oauth_access_denied');
  const clientId = params.get('client_id') || attempt.clientId;
  if (
    !clientId ||
    clientId === 'dynamic_agent_client' ||
    (attempt.clientId && clientId !== attempt.clientId)
  ) {
    throw new ServiceError('oauth_client_mismatch');
  }
  const code = params.get('code');
  if (!code) throw new ServiceError('oauth_missing_code');
  return { clientId, code };
}

async function tokenRequest(body: Record<string, string>) {
  const response = await fetch(TOKEN, {
    method: 'POST',
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!response.ok) throw new ServiceError(`oauth_token_http_${response.status}`, 502);
  const value = (await response.json()) as TokenReply;
  if (
    !value.access_token ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0 ||
    (value.token_type && value.token_type.toLowerCase() !== 'bearer')
  )
    throw new ServiceError('oauth_invalid_token_response', 502);
  return value;
}

export class Auth {
  private vault: Vault;
  private file: string;
  private pending = new Map<string, Attempt>();
  private refreshes = new Map<string, Promise<string>>();
  lastResult: string | null = null;

  constructor(dir: string) {
    this.file = join(dir, 'credentials.json');
    this.vault = readJson<Vault>(this.file, { hostId: `urn:uuid:${randomUUID()}`, accounts: [] });
    this.save();
  }
  private save() {
    writePrivate(this.file, this.vault);
  }
  publicInfo() {
    return {
      accounts: this.vault.accounts.map((a) => ({
        id: a.clientId,
        label: a.label,
        email: a.email,
        connected: Boolean(a.accessToken),
        planEnabled: a.scopes.includes('chatgpt.tokens.use.direct'),
      })),
      apiConfigured: Boolean(this.vault.apiKey || process.env.OPENAI_API_KEY),
      lastResult: this.lastResult,
    };
  }
  setApiKey(key: string) {
    if (!key || key.length < 12 || /\s/.test(key)) throw new ServiceError('invalid_api_key');
    this.vault.apiKey = key;
    this.save();
  }
  removeApiKey() {
    delete this.vault.apiKey;
    this.save();
  }
  begin(redirect: string, accountId?: string) {
    const old = accountId ? this.vault.accounts.find((a) => a.clientId === accountId) : undefined;
    if (accountId && !old) throw new ServiceError('account_not_found');
    for (const [key, value] of this.pending)
      if (value.expires < Date.now()) this.pending.delete(key);
    const attempt: Attempt = {
      state: randomBytes(24).toString('base64url'),
      nonce: randomBytes(24).toString('base64url'),
      verifier: randomBytes(48).toString('base64url'),
      redirect,
      expires: Date.now() + 10 * 60_000,
      clientId: old?.clientId,
      subject: old?.subject,
    };
    this.pending.set(attempt.state, attempt);
    this.lastResult = null;
    const url = new URL(`${ISSUER}/api/accounts/authorize`);
    url.search = new URLSearchParams({
      client_id: old?.clientId || 'dynamic_agent_client',
      ext_agent_host_id: this.vault.hostId,
      response_type: 'code',
      redirect_uri: redirect,
      scope: SCOPES,
      resource: RESOURCE,
      state: attempt.state,
      nonce: attempt.nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
    }).toString();
    if (old?.idToken) url.searchParams.set('id_token_hint', old.idToken);
    if (!old) url.searchParams.set('agent_name_hint', 'ssal-gpt');
    return url.toString();
  }
  async callback(params: URLSearchParams) {
    const state = params.get('state') || '';
    const attempt = this.pending.get(state);
    if (!attempt) throw new ServiceError('oauth_invalid_state');
    this.pending.delete(state);
    const { clientId, code } = validateCallback(attempt, params);
    const tokens = await tokenRequest({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: attempt.verifier,
      redirect_uri: attempt.redirect,
      resource: RESOURCE,
    });
    if (!tokens.id_token) throw new ServiceError('oauth_missing_identity');
    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer: ISSUER,
      audience: clientId,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp', 'nonce'],
    });
    if (
      payload.nonce !== attempt.nonce ||
      !payload.sub ||
      (attempt.subject && payload.sub !== attempt.subject)
    ) {
      throw new ServiceError('oauth_identity_mismatch');
    }
    const existing = this.vault.accounts.find((a) => a.clientId === clientId);
    if (existing && existing.subject !== payload.sub)
      throw new ServiceError('oauth_identity_mismatch');
    const account: Account = {
      clientId,
      subject: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : '',
      label: existing?.label || `ChatGPT ${this.vault.accounts.length + 1}`,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      scopes: (tokens.scope || '').split(/\s+/).filter(Boolean),
    };
    this.vault.accounts = [...this.vault.accounts.filter((a) => a.clientId !== clientId), account];
    this.save();
    this.lastResult = account.scopes.includes('chatgpt.tokens.use.direct')
      ? 'connected'
      : 'plan_permission_missing';
  }
  async bearer(choice: ProviderChoice): Promise<string> {
    if (choice.kind === 'api') {
      const key = this.vault.apiKey || process.env.OPENAI_API_KEY;
      if (!key) throw new ServiceError('api_key_required');
      return key;
    }
    const account = this.vault.accounts.find((a) => a.clientId === choice.accountId);
    if (!account?.accessToken) throw new ServiceError('chatgpt_login_required');
    if (!account.scopes.includes('chatgpt.tokens.use.direct'))
      throw new ServiceError('chatgpt_plan_permission_required');
    if (account.expiresAt > Date.now() + 60_000) return account.accessToken;
    const existing = this.refreshes.get(account.clientId);
    if (existing) return existing;
    const refresh = (async () => {
      if (!account.refreshToken) throw new ServiceError('chatgpt_login_required');
      const tokens = await tokenRequest({
        grant_type: 'refresh_token',
        client_id: account.clientId,
        refresh_token: account.refreshToken,
        resource: RESOURCE,
      });
      account.accessToken = tokens.access_token;
      account.refreshToken = tokens.refresh_token || account.refreshToken;
      account.expiresAt = Date.now() + tokens.expires_in * 1000;
      if (tokens.scope !== undefined) account.scopes = tokens.scope.split(/\s+/);
      this.save();
      if (!account.scopes.includes('chatgpt.tokens.use.direct'))
        throw new ServiceError('chatgpt_plan_permission_required');
      return account.accessToken;
    })();
    this.refreshes.set(account.clientId, refresh);
    try {
      return await refresh;
    } finally {
      this.refreshes.delete(account.clientId);
    }
  }
  async signOut(id: string) {
    await this.refreshes.get(id)?.catch(() => {});
    const account = this.vault.accounts.find((a) => a.clientId === id);
    if (!account) throw new ServiceError('account_not_found');
    // The server only permits disconnect while no worker/refresh is active.
    let revoked = !account.refreshToken;
    if (account.refreshToken) {
      try {
        const response = await fetch(`${ISSUER}/api/accounts/oauth/revoke`, {
          method: 'POST',
          body: new URLSearchParams({
            token: account.refreshToken,
            token_type_hint: 'refresh_token',
            client_id: account.clientId,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        revoked = response.status === 200;
      } catch {
        /* Report unconfirmed remote revocation after local removal. */
      }
    }
    delete account.accessToken;
    delete account.refreshToken;
    delete account.idToken;
    account.expiresAt = 0;
    account.scopes = [];
    this.save();
    return { revoked };
  }
}
