import { request as httpsRequest } from 'node:https';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readJson, writePrivate } from './config.js';
import { ServiceError, safeMessage } from './auth.js';
import type { Store } from './store.js';
import { collectNotices, currentNotices, notificationText } from './reward-notifications.js';

type Recipient = { id: number; label: string };
type Delivery = {
  id: string;
  noticeIds: string[];
  at: number;
  status: 'sending' | 'sent' | 'unknown' | 'failed' | 'retry';
  code?: string;
  attempts: number;
  retryAt?: number;
  messageId?: number;
  test?: boolean;
};
type State = {
  token?: string;
  username?: string;
  enabled: boolean;
  recipient?: Recipient;
  pair?: {
    nonce: string;
    createdAt: number;
    expires: number;
    offset?: number;
    candidate?: Recipient;
  };
  deliveries: Delivery[];
  connection?: {
    at: number;
    phase: 'bot' | 'webhook';
    state: 'checking' | 'ready' | 'failed';
    code?: string;
  };
};
export class TelegramFailure extends ServiceError {
  constructor(
    public code: string,
    public uncertain = false,
    public retryAfter?: number,
  ) {
    super(code);
  }
}
export type TelegramRequest = (
  token: string,
  method: string,
  body: Record<string, unknown>,
) => Promise<any>;
// Scope IPv4 to Telegram: avoid the observed dual-stack connection race without altering
// global DNS/TLS settings or retrying a send whose result could already be committed.
export function createTelegramRequest(request = httpsRequest): TelegramRequest {
  return async (token, method, body) => {
    const uncertain = method === 'sendMessage';
    try {
      const { status, data } = await new Promise<{ status: number; data: any }>(
        (resolve, reject) => {
          const fail = (code: string) => reject(new TelegramFailure(code, uncertain));
          const req = request(
            {
              protocol: 'https:',
              hostname: 'api.telegram.org',
              port: 443,
              path: `/bot${token}/${method}`,
              method: 'POST',
              family: 4,
              rejectUnauthorized: true,
              headers: { 'content-type': 'application/json' },
              signal: AbortSignal.timeout(15000),
            },
            (response) => {
              const status = response.statusCode || 0;
              response.on('aborted', () => fail('telegram_response_incomplete'));
              response.on('error', () => fail('telegram_response_incomplete'));
              if (status >= 300 && status < 400) {
                response.resume();
                fail('telegram_redirect_blocked');
                return;
              }
              const chunks: Buffer[] = [];
              let length = 0;
              response.on('data', (chunk: Buffer) => {
                length += chunk.length;
                if (length > 2_000_000) {
                  fail('telegram_response_too_large');
                  response.destroy();
                  return;
                }
                chunks.push(chunk);
              });
              response.on('end', () => {
                try {
                  resolve({ status, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
                } catch {
                  fail('telegram_response_invalid');
                }
              });
            },
          );
          req.on('error', (error: NodeJS.ErrnoException) => {
            fail(
              ['ETIMEDOUT', 'ABORT_ERR'].includes(error.code || '')
                ? 'telegram_network_timeout'
                : ['ENOTFOUND', 'EAI_AGAIN'].includes(error.code || '')
                  ? 'telegram_dns_failed'
                  : /CERT|TLS|SSL/.test(error.code || '')
                    ? 'telegram_tls_failed'
                    : 'telegram_network_failed',
            );
          });
          req.end(JSON.stringify(body));
        },
      );
      if (status < 200 || status >= 300 || data?.ok !== true) {
        const code = Number(data?.error_code || status);
        throw new TelegramFailure(
          code === 401
            ? 'telegram_token_invalid'
            : code === 403
              ? 'telegram_bot_blocked'
              : code === 409
                ? 'telegram_updates_conflict'
                : code === 429
                  ? 'telegram_rate_limited'
                  : 'telegram_rejected',
          uncertain && code >= 500,
          code === 429
            ? Math.max(1, Math.min(86400, Number(data?.parameters?.retry_after) || 60))
            : undefined,
        );
      }
      return data.result;
    } catch (error) {
      // Never surface raw request URLs, Telegram descriptions or token-bearing errors.
      if (error instanceof TelegramFailure) throw error;
      throw new TelegramFailure('telegram_network_failed', uncertain);
    }
  };
}
export const telegramRequest = createTelegramRequest();
export class TelegramNotifications {
  private state: State;
  private path: string;
  private work?: Promise<unknown>;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  dashboardPort?: number;
  constructor(
    private store: Store,
    private request: TelegramRequest = telegramRequest,
    private now = Date.now,
  ) {
    this.path = join(store.dir, 'telegram-private.json');
    this.state = readJson<State>(this.path, { enabled: false, deliveries: [] });
    for (const d of this.state.deliveries)
      if (d.status === 'sending') {
        d.status = 'unknown';
        d.code = 'telegram_interrupted';
      }
    if (this.state.connection?.state === 'checking') {
      this.state.connection.state = 'failed';
      this.state.connection.code = 'telegram_connection_interrupted';
    }
    if (this.state.deliveries.length || this.state.connection) this.save();
  }
  private save() {
    writePrivate(this.path, this.state);
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.work || this.closed) throw new ServiceError('telegram_busy');
    const p = fn();
    this.work = p;
    try {
      return await p;
    } finally {
      this.work = undefined;
    }
  }
  private confirmation() {
    const p = this.state.pair;
    const target = p && p.expires > this.now() ? p.candidate : this.state.recipient;
    return target
      ? createHash('sha256')
          .update(`${this.state.token}:${target.id}:${p?.nonce || 'bound'}`)
          .digest('hex')
      : undefined;
  }
  publicInfo() {
    const pair =
      this.state.pair && this.state.pair.expires > this.now() ? this.state.pair : undefined;
    return {
      configured: !!this.state.token,
      connection: this.state.connection
        ? {
            ...this.state.connection,
            message: this.state.connection.code
              ? safeMessage(new ServiceError(this.state.connection.code))
              : undefined,
          }
        : undefined,
      enabled: this.state.enabled,
      username: this.state.username,
      recipient: this.state.recipient?.label,
      candidate: pair?.candidate?.label,
      confirmation: this.confirmation(),
      pairUrl:
        pair && this.state.username
          ? `https://t.me/${this.state.username}?start=${pair.nonce}`
          : undefined,
      pairExpires: pair?.expires,
      deliveries: this.state.deliveries
        .slice(-20)
        .reverse()
        .map(({ messageId, ...d }) => d),
      deliveryByNotice: Object.fromEntries(
        this.state.deliveries.flatMap((d) => d.noticeIds.map((id) => [id, d.status])),
      ),
      busy: !!this.work,
    };
  }
  async pair(token: string) {
    if (!/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(token))
      throw new ServiceError('telegram_token_format');
    return this.exclusive(async () => {
      this.state.connection = { at: this.now(), phase: 'bot', state: 'checking' };
      this.save();
      try {
        const bot = await this.request(token, 'getMe', {});
        if (bot?.is_bot !== true || !/^[A-Za-z0-9_]{5,32}$/.test(bot.username || ''))
          throw new ServiceError('telegram_bot_invalid');
        this.state.connection.phase = 'webhook';
        this.save();
        const hook = await this.request(token, 'getWebhookInfo', {});
        if (typeof hook?.url !== 'string' || hook.url)
          throw new ServiceError('telegram_dedicated_bot_required');
        // Changing a bot revokes the former target and grant. Pairing alone never enables sends.
        this.state = {
          connection: { at: this.now(), phase: 'webhook', state: 'ready' },
          token,
          username: bot.username,
          enabled: false,
          deliveries: [],
          pair: {
            nonce: randomBytes(24).toString('base64url'),
            createdAt: this.now(),
            expires: this.now() + 600000,
          },
        };
        this.save();
        return this.publicInfo();
      } catch (error) {
        const code =
          error instanceof ServiceError && /^telegram_[a-z_]+$/.test(error.code)
            ? error.code
            : 'telegram_network_failed';
        this.state.connection = {
          at: this.now(),
          phase: this.state.connection!.phase,
          state: 'failed',
          code,
        };
        this.save();
        throw new ServiceError(code);
      }
    });
  }
  async findRecipient() {
    return this.exclusive(async () => {
      const p = this.state.pair;
      if (!this.state.token || !p || p.expires <= this.now())
        throw new ServiceError('telegram_pair_expired');
      for (let page = 0; page < 3; page++) {
        const updates = await this.request(this.state.token, 'getUpdates', {
          offset: p.offset,
          limit: 100,
          timeout: 0,
          allowed_updates: ['message'],
        });
        if (!Array.isArray(updates)) throw new ServiceError('telegram_updates_invalid');
        for (const u of updates) {
          if (!Number.isSafeInteger(u.update_id)) continue;
          p.offset = Math.max(p.offset || 0, u.update_id + 1);
          const m = u.message;
          if (
            m?.text !== `/start ${p.nonce}` ||
            m.chat?.type !== 'private' ||
            m.from?.is_bot !== false ||
            !Number.isSafeInteger(m.chat.id) ||
            m.chat.id <= 0 ||
            m.from.id !== m.chat.id ||
            !Number.isFinite(m.date) ||
            m.date * 1000 < p.createdAt - 5000 ||
            m.date * 1000 > this.now() + 5000
          )
            continue;
          const name = [m.from.first_name, m.from.last_name]
            .filter((x) => typeof x === 'string')
            .join(' ')
            .slice(0, 100);
          p.candidate = {
            id: m.chat.id,
            label: `${name || '개인 대화'}${/^[A-Za-z0-9_]+$/.test(m.from.username || '') ? ' (@' + m.from.username + ')' : ''} · 끝 ${String(m.chat.id).slice(-4)}`,
          };
        }
        if (updates.length < 100 || p.candidate) break;
      }
      this.save();
      return this.publicInfo();
    });
  }
  private async send(d: Delivery, recipient: Recipient, text: string) {
    d.status = 'sending';
    d.attempts++;
    delete d.retryAt;
    this.save();
    try {
      const result = await this.request(this.state.token!, 'sendMessage', {
        chat_id: recipient.id,
        text,
        link_preview_options: { is_disabled: true },
      });
      if (
        !Number.isSafeInteger(result?.message_id) ||
        result.chat?.id !== recipient.id ||
        result.chat?.type !== 'private'
      )
        throw new TelegramFailure('telegram_response_unknown', true);
      d.status = 'sent';
      d.messageId = result.message_id;
      delete d.code;
    } catch (error) {
      const e =
        error instanceof TelegramFailure
          ? error
          : new TelegramFailure('telegram_response_unknown', true);
      d.code = e.code;
      d.status = e.uncertain ? 'unknown' : e.retryAfter && d.attempts < 3 ? 'retry' : 'failed';
      if (d.status === 'retry') d.retryAt = this.now() + e.retryAfter! * 1000;
      if (e.code === 'telegram_token_invalid' || e.code === 'telegram_bot_blocked')
        this.state.enabled = false;
    }
    this.save();
    return d;
  }
  async activate(confirmation: string) {
    return this.exclusive(async () => {
      const p = this.state.pair;
      const recipient = p && p.expires > this.now() ? p.candidate : this.state.recipient;
      if (!recipient || !this.state.token) throw new ServiceError('telegram_recipient_required');
      if (!confirmation || confirmation !== this.confirmation())
        throw new ServiceError('telegram_target_changed');
      this.state.enabled = false;
      const d: Delivery = {
        id: randomUUID(),
        noticeIds: [],
        at: this.now(),
        status: 'sending',
        attempts: 0,
        test: true,
      };
      this.state.deliveries.push(d);
      await this.send(
        d,
        recipient,
        '쌀-GPT 개인 알림 연결 테스트입니다. 이 대화로 당첨·회신·수령 관련 알림의 종류와 건수만 보냅니다. 상세 내용은 연결된 컴퓨터의 대시보드에서 확인하세요.',
      );
      if (d.status === 'sent') {
        this.state.recipient = recipient;
        delete this.state.pair;
        this.state.enabled = true;
      }
      this.save();
      return this.publicInfo();
    });
  }
  async disable(disconnect = false) {
    return this.exclusive(async () => {
      this.state.enabled = false;
      if (disconnect) {
        delete this.state.token;
        delete this.state.username;
        delete this.state.recipient;
        delete this.state.pair;
      }
      this.save();
      return this.publicInfo();
    });
  }
  async tick() {
    if (this.work || this.closed) return;
    return this.exclusive(async () => {
      const all = collectNotices(this.store, this.now());
      const { enabled, token, recipient, deliveries } = this.state;
      if (!enabled || !token || !recipient) return;
      const active = new Set(currentNotices(this.store, this.now()).map((n) => n.key));
      const retry = deliveries.find((d) => !d.test && d.status === 'retry');
      if (retry) {
        if ((retry.retryAt || 0) > this.now()) return;
        const items = all.filter((n) => retry.noticeIds.includes(n.id) && active.has(n.key));
        if (items.length)
          await this.send(retry, recipient, notificationText(items, this.dashboardPort));
        else {
          retry.status = 'failed';
          retry.code = 'telegram_notice_resolved';
          this.save();
        }
        return;
      }
      // Any attempted delivery (including unknown/rejected) consumes its keys. No blind re-send after timeout/restart.
      const attempted = new Set(deliveries.flatMap((d) => d.noticeIds));
      const pending = all.filter((n) => active.has(n.key) && !attempted.has(n.id)).slice(0, 50);
      if (!pending.length) return;
      const d: Delivery = {
        id: randomUUID(),
        noticeIds: pending.map((n) => n.id),
        at: this.now(),
        status: 'sending',
        attempts: 0,
      };
      deliveries.push(d);
      await this.send(d, recipient, notificationText(pending, this.dashboardPort));
    });
  }
  start() {
    collectNotices(this.store, this.now());
    this.timer = setInterval(() => void this.tick().catch(() => {}), 30000);
    this.timer.unref();
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.work?.catch(() => {});
  }
}
