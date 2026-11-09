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
