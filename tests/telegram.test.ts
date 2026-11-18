import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { OutcomeSchema, putOutcome, outcomes } from '../src/outcomes.js';
import { collectNotices, noticeInbox, readNotices } from '../src/reward-notifications.js';
import {
  TelegramNotifications,
  TelegramFailure,
  telegramRequest,
  type TelegramRequest,
} from '../src/telegram.js';
const token = '123456:fixture_token_without_real_credentials';
function win(store: Store, extra: Record<string, unknown> = {}) {
  const o = {
    ...OutcomeSchema.parse({
      eventId: randomUUID(),
      status: 'won',
      sourceUrl: 'https://example.org/notice',
      note: 'synthetic',
      followUp: { state: 'needs_reply', deadlineText: 'private deadline text' },
      reward: { name: 'private reward', code: 'PRIVATE_COUPON' },
      ...extra,
    }),
    updatedAt: new Date().toISOString(),
    reportedBy: 'user' as const,
  };
  putOutcome(store, o);
  return o;
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-telegram-')),
    store = new Store(dir);
  let now = Date.now();
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let updates: any[] = [],
    failure: Error | undefined,
    webhook = '';
  const request: TelegramRequest = async (_token, method, body) => {
    calls.push({ method, body });
    if (method === 'getMe') return { is_bot: true, username: 'FixtureAlertsBot' };
    if (method === 'getWebhookInfo') return { url: webhook };
    if (method === 'getUpdates') return updates;
    if (method === 'sendMessage') {
      if (failure) throw failure;
      return { message_id: calls.length, chat: { id: body.chat_id, type: 'private' } };
    }
    throw new Error('unexpected method');
  };
  const instance = () => new TelegramNotifications(store, request, () => now);
  const t = instance();
  const update = (nonce: string, changes = {}) => ({
    update_id: 1,
    message: {
      date: Math.floor(now / 1000),
      text: '/start ' + nonce,
      chat: { id: 12345678, type: 'private' },
      from: { id: 12345678, is_bot: false, first_name: 'Fixture', username: 'fixture_self' },
      ...changes,
    },
  });
  const pair = async () => {
    await t.pair(token);
    const nonce = new URL(t.publicInfo().pairUrl!).searchParams.get('start')!;
    updates = [update(nonce)];
    await t.findRecipient();
  };
  return {
    dir,
    store,
    t,
    calls,
    pair,
    update,
    instance,
    setUpdates: (v: any[]) => (updates = v),
    setFailure: (v?: Error) => (failure = v),
    setWebhook: (v: string) => (webhook = v),
    advance: (ms: number) => (now += ms),
    cleanup: async () => {
      await t.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('local notification inbox persists without Telegram and read state does not resolve a win', async () => {
  const f = fixture();
  try {
    const o = win(f.store);
    await f.t.tick();
    assert.equal(f.calls.length, 0);
    let inbox = noticeInbox(f.store);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]!.kind, 'reply');
    readNotices(f.store, [inbox[0]!.id]);
    await f.t.tick();
    assert.ok(noticeInbox(f.store)[0]!.readAt);
    assert.equal(outcomes(f.store)[0]!.followUp?.state, 'needs_reply');
    putOutcome(f.store, { ...o, followUp: { ...o.followUp!, state: 'replied' } });
    await f.t.tick();
    inbox = noticeInbox(f.store);
    assert.equal(inbox.length, 2);
    assert.equal(inbox[1]!.active, false);
    assert.equal(inbox[0]!.kind, 'delivery');
  } finally {
    await f.cleanup();
  }
});
test('pair requires fresh nonce in a private self chat, explicit activation and private token storage', async () => {
  const f = fixture();
  try {
    await f.t.pair(token);
    const nonce = new URL(f.t.publicInfo().pairUrl!).searchParams.get('start')!;
    f.setUpdates([
      f.update('wrong'),
      f.update(nonce, { chat: { id: -123, type: 'group' } }),
      f.update(nonce, { date: 1 }),
      f.update(nonce, { from: { id: 99, is_bot: false } }),
    ]);
    await f.t.findRecipient();
    assert.equal(f.t.publicInfo().candidate, undefined);
    await assert.rejects(f.t.activate(f.t.publicInfo().confirmation || ''), /recipient_required/);
    f.setUpdates([f.update(nonce)]);
    await f.t.findRecipient();
    assert.match(f.t.publicInfo().candidate!, /fixture_self/);
    assert.equal(f.calls.filter((c) => c.method === 'sendMessage').length, 0);
    assert.equal(f.t.publicInfo().enabled, false);
    assert.ok(!JSON.stringify(f.t.publicInfo()).includes(token));
    assert.equal(statSync(join(f.dir, 'telegram-private.json')).mode & 0o777, 0o600);
    await f.t.activate(f.t.publicInfo().confirmation || '');
    assert.equal(f.t.publicInfo().enabled, true);
    assert.equal(f.t.publicInfo().pairUrl, undefined);
    await f.t.disable(true);
    assert.equal(f.t.publicInfo().configured, false);
    assert.ok(!readFileSync(join(f.dir, 'telegram-private.json'), 'utf8').includes(token));
    await f.t.tick();
    assert.equal(f.calls.filter((c) => c.method === 'sendMessage').length, 1);
  } finally {
    await f.cleanup();
  }
});
test('existing webhook and expired pairing cannot bind or enable an alert target', async () => {
  const f = fixture();
  try {
    f.setWebhook('https://example.org/existing');
    await assert.rejects(f.t.pair(token), /dedicated_bot/);
    assert.equal(f.t.publicInfo().configured, false);
    f.setWebhook('');
    await f.pair();
    f.advance(600001);
    await assert.rejects(f.t.findRecipient(), /pair_expired/);
    await assert.rejects(f.t.activate(f.t.publicInfo().confirmation || ''), /recipient_required/);
    assert.equal(f.calls.filter((c) => c.method === 'sendMessage').length, 0);
  } finally {
    await f.cleanup();
  }
});
test('batches contain only types/counts, deduplicate across concurrency and restart, independently of dashboard reads', async () => {
  const f = fixture();
  let restarted: TelegramNotifications | undefined;
  try {
    win(f.store);
    win(f.store);
    collectNotices(f.store);
    readNotices(
      f.store,
      noticeInbox(f.store).map((n) => n.id),
    );
    await f.pair();
    await f.t.activate(f.t.publicInfo().confirmation || '');
    await Promise.all([f.t.tick(), f.t.tick()]);
    const sends = f.calls.filter((c) => c.method === 'sendMessage');
    assert.equal(sends.length, 2);
    assert.match(String(sends[1]!.body.text), /회신 필요 2건/);
    assert.ok(!JSON.stringify(sends).includes('private'));
    assert.ok(!JSON.stringify(sends).includes('PRIVATE_COUPON'));
    await f.t.close();
    restarted = f.instance();
    await restarted.tick();
    assert.equal(f.calls.filter((c) => c.method === 'sendMessage').length, 2);
  } finally {
    await restarted?.close();
    await f.cleanup();
  }
});
test('ambiguous delivery is journaled, never retried, and remains visible after restart', async () => {
  const f = fixture();
  let restarted: TelegramNotifications | undefined;
  try {
    win(f.store);
    await f.pair();
    await f.t.activate(f.t.publicInfo().confirmation || '');
    f.setFailure(new Error('network failed containing ' + token));
    await f.t.tick();
    assert.equal(f.t.publicInfo().deliveries[0]!.status, 'unknown');
    assert.ok(!JSON.stringify(f.t.publicInfo()).includes(token));
    await f.t.close();
    restarted = f.instance();
    f.setFailure();
    await restarted.tick();
    assert.equal(f.calls.filter((c) => c.method === 'sendMessage').length, 2);
    assert.equal(noticeInbox(f.store).length, 1);
  } finally {
    await restarted?.close();
    await f.cleanup();
  }
});
test('known rate rejection honors retry_after and stops after three attempts; blocked bot disables sends', async () => {
  const f = fixture();
  try {
    win(f.store);
    await f.pair();
    await f.t.activate(f.t.publicInfo().confirmation || '');
    f.setFailure(new TelegramFailure('telegram_rate_limited', false, 10));
    await f.t.tick();
    await f.t.tick();
    assert.equal(f.t.publicInfo().deliveries[0]!.attempts, 1);
    f.advance(10000);
    await f.t.tick();
    f.advance(10000);
    await f.t.tick();
    assert.equal(f.t.publicInfo().deliveries[0]!.status, 'failed');
    f.advance(10000);
    await f.t.tick();
    assert.equal(f.t.publicInfo().deliveries[0]!.attempts, 3);
    win(f.store);
    f.setFailure(new TelegramFailure('telegram_bot_blocked'));
    await f.t.tick();
    assert.equal(f.t.publicInfo().enabled, false);
  } finally {
    await f.cleanup();
  }
});
test('HTTP transport restricts host, disables redirects and redacts raw errors', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (url, init) => {
      assert.ok(String(url).startsWith('https://api.telegram.org/bot'));
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.method, 'POST');
      throw new Error('secret ' + token);
    }) as typeof fetch;
    await assert.rejects(
      telegramRequest(token, 'getMe', {}),
      (e: Error) => e.message === 'telegram_response_unknown',
    );
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          parameters: { retry_after: 7 },
          description: token,
        }),
        { status: 429 },
      )) as typeof fetch;
    await assert.rejects(
      telegramRequest(token, 'sendMessage', {}),
      (e: TelegramFailure) =>
        e.code === 'telegram_rate_limited' && e.retryAfter === 7 && !e.message.includes(token),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('stale recipient approval and duplicate actions cannot enable a replaced pairing', async () => {
  const f = fixture();
  try {
    await f.pair();
    const approval = f.t.publicInfo().confirmation!;
    await f.pair();
    await assert.rejects(f.t.activate(approval), /target_changed/);
    assert.equal(f.calls.filter((c) => c.method === 'sendMessage').length, 0);
    assert.equal(f.t.publicInfo().enabled, false);
  } finally {
    await f.cleanup();
  }
});

test('interrupted journal restores as unknown and resolved notices are not replayed', async () => {
  const f = fixture();
  let restarted: TelegramNotifications | undefined;
  try {
    const o = win(f.store);
    await f.pair();
    await f.t.activate(f.t.publicInfo().confirmation!);
    await f.t.tick();
    await f.t.close();
    const file = join(f.dir, 'telegram-private.json');
    const state = JSON.parse(readFileSync(file, 'utf8'));
    state.deliveries.at(-1).status = 'sending';
    const { writePrivate } = await import('../src/config.js');
    writePrivate(file, state);
    restarted = f.instance();
    assert.equal(restarted.publicInfo().deliveries[0]!.status, 'unknown');
    assert.equal(restarted.publicInfo().deliveries[0]!.code, 'telegram_interrupted');
    putOutcome(f.store, { ...o, followUp: { ...o.followUp!, state: 'done' } });
    await restarted.tick();
    assert.equal(f.calls.filter((c) => c.method === 'sendMessage').length, 2);
    assert.equal(noticeInbox(f.store)[0]!.active, false);
  } finally {
    await restarted?.close();
    await f.cleanup();
  }
});
