import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Auth, ServiceError, safeMessage } from './auth.js';
import { Browser, validateUrl } from './browser.js';
import { openExternalBrowser } from './external-browser.js';
import { Model } from './model.js';
import { Store, deadlineState, scoreCandidate, type Job } from './store.js';
import { Runner } from './runner.js';
import { demoPage } from './demo.js';
import {
  SettingsSchema,
  createAutonomy,
  settings,
  memories,
  saveAnswer,
  syntheticSettings,
  validateAnswer,
} from './autonomy.js';
import { autonomyDemo, acceptDemo } from './autonomy-demo.js';
import { inspectForm } from './forms.js';
import { searchUrl } from './evidence.js';
import { verifyReceipt } from './receipt.js';

const ProviderSchema = z.object({
  kind: z.enum(['chatgpt', 'api']),
  accountId: z.string().optional(),
  model: z.string().min(1).max(150),
});
const JobSchema = z.object({
  kind: z.enum(['discover', 'apply', 'demo', 'autonomy_demo']),
  autonomy: z.boolean().default(false),
  demoInbox: z.boolean().default(false),
  provider: ProviderSchema,
  goal: z.string().min(1).max(2000),
  eventId: z.string().optional(),
  candidateLimit: z.number().int().min(1).max(10).default(5),
  maxSteps: z.number().int().min(5).max(300).default(40),
  routeConfirmed: z.boolean().optional(),
  layout: z.enum(['normal', 'shift']).optional(),
  discoverySource: z.enum(['culture', 'google', 'naver', 'custom']).default('culture'),
  sourceUrl: z.string().url().optional(),
  userContext: z.string().max(6000).optional(),
});
async function body(request: IncomingMessage, limit = 64_000) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new ServiceError('request_too_large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function send(
  response: ServerResponse,
  status: number,
  value: unknown,
  type = 'application/json; charset=utf-8',
) {
  response.writeHead(status, { 'Content-Type': type });
  response.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}

export async function createApp(options: {
  dir: string;
  port: number;
  headless?: boolean;
  webDir?: string;
  externalOpen?: (url: string) => Promise<void>;
}) {
  const store = new Store(options.dir);
  const auth = new Auth(options.dir);
  const csrf = randomBytes(32).toString('base64url');
  let origin = '';
  let browser: Browser;
  let runner: Runner;
  let manualNavigation = false;
  const model = new Model(auth);
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (!response.headersSent)
        send(response, error instanceof ServiceError ? error.status : 400, {
          error: safeMessage(error),
        });
      else response.end();
    });
  });
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.headers.host !== new URL(origin).host) throw new ServiceError('invalid_host', 403);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    const url = new URL(request.url || '/', origin);
    const method = request.method || 'GET';
    const isDemo = url.pathname.startsWith('/demo/');
    if (isDemo) response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader(
      'Content-Security-Policy',
      isDemo
        ? "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"
        : "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    if (url.pathname === '/auth/callback' && method === 'GET') {
      try {
        await auth.callback(url.searchParams);
      } catch (error) {
        auth.lastResult = safeMessage(error);
      }
      response.writeHead(303, { Location: '/?connected=1' });
      response.end();
      return;
    }
    if (request.headers.origin && request.headers.origin !== origin)
      throw new ServiceError('cross_origin_blocked', 403);
    if (isDemo) {
      if (url.pathname === '/demo/autonomy') {
        const run = z.string().uuid().parse(url.searchParams.get('run'));
        if (method === 'POST') {
          if (!acceptDemo(store, run, new URLSearchParams(await body(request))))
            return send(
              response,
              400,
              '<p>입력 검증 실패. 제출은 접수되지 않았습니다.</p>',
              'text/html; charset=utf-8',
            );
          response.writeHead(303, { Location: `/demo/autonomy?run=${run}` });
          response.end();
          return;
        }
        if (method === 'GET')
          return send(response, 200, autonomyDemo(store, run), 'text/html; charset=utf-8');
      }
      if (url.pathname === '/demo/submit' && method === 'POST') {
        const params = new URLSearchParams(await body(request));
        const run = url.searchParams.get('run') || 'sample';
        if (
          params.get('answer') !== 'coffee' ||
          !params.get('required') ||
          (params.get('comment') || '').trim().length < 5 ||
          params.has('marketing')
        ) {
          return send(
            response,
            400,
            '<p>퀴즈·5자 이상 응원·필수 동의를 확인하세요. 선택 홍보 동의는 체크하지 마세요.</p><a href="/demo/event?run=' +
              encodeURIComponent(run) +
              '">다시 보기</a>',
            'text/html; charset=utf-8',
          );
        }
        store.submitDemo(run);
        response.writeHead(303, { Location: `/demo/event?run=${encodeURIComponent(run)}` });
        response.end();
        return;
      }
      if (method === 'GET' && url.pathname === '/demo/event')
        return send(response, 200, demoPage(url, store), 'text/html; charset=utf-8');
      throw new ServiceError('not_found', 404);
    }
    if (url.pathname.startsWith('/api/') && method !== 'GET') {
      if (
        request.headers['x-ssal-token'] !== csrf ||
        !String(request.headers['content-type']).startsWith('application/json')
      )
        throw new ServiceError('invalid_request_token', 403);
    }
    let data: any = {};
    if (method === 'POST') {
      try {
        data = JSON.parse(await body(request));
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        throw new ServiceError('invalid_json');
      }
    }
    if (method === 'GET' && url.pathname === '/api/state') {
      return send(response, 200, {
        csrf,
        auth: auth.publicInfo(),
        jobs: store.jobs().map((job) => ({
          ...job,
          sourceEvidence: undefined,
          receiptObservations: undefined,
          autonomy: job.autonomy
            ? {
                ...job.autonomy,
                profile: undefined,
                evidence: undefined,
                overrides: undefined,
                reused: undefined,
                privateAnswers: undefined,
                plan: undefined,
              }
            : undefined,
        })),
        autonomy: {
          policy: settings(store).policy,
          revision: settings(store).revision,
          savedAnswers: memories(store).map((a) => ({
            id: a.id,
            question: a.question,
            origin: a.origin,
            at: a.at,
          })),
        },
        events: store.events().map((event) => {
          const ranked = scoreCandidate(event);
          return {
            ...event,
            score: ranked.score,
            scoreReasons: ranked.reasons,
            deadlineState: deadlineState(event),
            submissionState: store.submission(event.id)?.state,
            sourceEvidence: undefined,
          };
        }),
        completedEntries: store.completedEntries(),
        busy: runner.isBusy(),
        browser: browser.info(),
        activeId: runner.activeId,
        selection: store.settings('selection', null),
      });
    }
    if (method === 'GET' && url.pathname === '/api/autonomy')
      return send(response, 200, settings(store));
    if (method === 'POST' && url.pathname === '/api/autonomy') {
      if (runner.isBusy()) throw new ServiceError('pause_before_changing_delegation');
      const input = SettingsSchema.parse(data);
      store.setSettings('autonomy', { ...input, revision: randomUUID() });
      return send(response, 200, { ok: true });
    }
    if (method === 'POST' && url.pathname === '/api/answers/delete') {
      if (runner.isBusy()) throw new ServiceError('pause_before_changing_delegation');
      const id = z.string().parse(data.id);
      store.setSettings(
        'answers',
        memories(store).filter((a) => a.id !== id),
      );
      return send(response, 200, { ok: true });
    }
    if (method === 'POST' && url.pathname === '/api/auth/begin') {
      if (runner.isBusy()) throw new ServiceError('pause_before_changing_connections');
      return send(response, 200, {
        url: auth.begin(
          `${origin}/auth/callback`,
          typeof data.accountId === 'string' ? data.accountId : undefined,
        ),
      });
    }
    if (method === 'POST' && url.pathname === '/api/auth/api-key') {
      if (runner.isBusy()) throw new ServiceError('pause_before_changing_connections');
      auth.setApiKey(z.string().max(1000).parse(data.key));
      return send(response, 200, { ok: true });
    }
    if (method === 'POST' && url.pathname === '/api/auth/disconnect') {
      if (runner.isBusy()) throw new ServiceError('pause_before_changing_connections');
      if (data.kind === 'api') {
        auth.removeApiKey();
        return send(response, 200, { revoked: true });
      }
      return send(response, 200, await auth.signOut(z.string().parse(data.accountId)));
    }
    if (method === 'POST' && url.pathname === '/api/models') {
      const choice = ProviderSchema.parse({ ...data, model: data.model || 'catalog' });
      return send(response, 200, { models: await model.models(choice) });
    }
    if (method === 'POST' && url.pathname === '/api/selection') {
      const choice = ProviderSchema.parse(data);
      store.setSettings('selection', choice);
      return send(response, 200, { ok: true });
    }
    if (method === 'POST' && url.pathname === '/api/browser/open') {
      if (runner.isBusy() || manualNavigation)
        throw new ServiceError('pause_before_manual_control');
      manualNavigation = true;
      try {
        browser.setManual(true);
        browser.ownerJobId = undefined;
        await browser.navigate(z.string().url().parse(data.url));
        await browser.page?.bringToFront();
        return send(response, 200, { ok: true });
      } finally {
        manualNavigation = false;
      }
    }
    if (method === 'POST' && url.pathname === '/api/browser/settings') {
      if (runner.isBusy() || manualNavigation)
        throw new ServiceError('pause_before_changing_browser');
      const engine = z.enum(['chromium', 'chrome']).parse(data.engine);
      manualNavigation = true;
      try {
        browser.setManual(true);
        await browser.setEngine(engine);
        store.setSettings('browser', { engine });
        return send(response, 200, { ok: true, browser: browser.info() });
      } finally {
        manualNavigation = false;
      }
    }
    if (method === 'POST' && url.pathname === '/api/browser/close') {
      if (runner.isBusy() || manualNavigation)
        throw new ServiceError('pause_before_manual_control');
      manualNavigation = true;
      try {
        await browser.close();
        return send(response, 200, { ok: true });
      } finally {
        manualNavigation = false;
      }
    }
    if (method === 'POST' && url.pathname === '/api/browser/check') {
      if (runner.isBusy() || manualNavigation)
        throw new ServiceError('pause_before_manual_control');
      return send(response, 200, await browser.connectionStatus());
    }
    if (method === 'POST' && url.pathname === '/api/browser/external') {
      const url = await validateUrl(z.string().url().parse(data.url));
      await (options.externalOpen || openExternalBrowser)(url.toString());
      return send(response, 200, { ok: true, mode: 'manual', sharedSession: false });
    }
    const reviewMatch = url.pathname.match(/^\/api\/events\/([a-f0-9-]+)\/review$/);
    if (method === 'POST' && reviewMatch) {
      const id = reviewMatch[1]!;
      const review = z
        .object({
          entryUrl: z.string().url(),
          deadlineDate: z.string().date().nullable(),
          blockers: z.array(z.string().max(300)).max(20),
          note: z.string().min(5).max(2000),
        })
        .parse(data);
      if (!store.event(id)) throw new ServiceError('event_not_found', 404);
      await validateUrl(review.entryUrl);
      if (runner.isBusy() || store.submission(id))
        throw new ServiceError('cannot_review_started_event');
      const { note, ...patch } = review;
      return send(response, 200, { event: store.reviewEvent(id, patch, note) });
    }
    if (method === 'POST' && url.pathname === '/api/jobs') {
      if (runner.isBusy() || manualNavigation) throw new ServiceError('browser_busy', 409);
      const input = JobSchema.parse(data);
      await auth.bearer(input.provider);
      if (runner.isBusy() || manualNavigation) throw new ServiceError('browser_busy', 409);
      const event =
        input.kind === 'apply' && input.eventId ? store.event(input.eventId) : undefined;
      if (input.kind === 'apply' && (!event || !input.routeConfirmed))
        throw new ServiceError('event_and_route_confirmation_required');
      if (event && (deadlineState(event) !== 'available' || event.blockers.length))
        throw new ServiceError('event_not_eligible');
      const id = randomUUID();
      const now = new Date().toISOString();
      const startUrl =
        input.kind === 'autonomy_demo'
          ? `${origin}/demo/autonomy?run=${id}`
          : input.kind === 'demo'
            ? `${origin}/demo/event?run=${id}&layout=${input.layout || 'normal'}`
            : event?.entryUrl ||
              (input.discoverySource === 'culture'
                ? 'https://www.culture.go.kr/portal/bbs/B0000101/list.do?menuNo=200031'
                : input.discoverySource === 'custom'
                  ? z.string().url().parse(input.sourceUrl)
                  : searchUrl(
                      `${new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })} ${input.goal}`,
                      input.discoverySource === 'google' ? 'google' : 'naver',
                    ));
      const job: Job = {
        id,
        kind: input.kind,
        goal: input.goal,
        provider: input.provider,
        browserEngine: browser.engine,
        startUrl,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        eventId: event?.id,
        candidateLimit: input.candidateLimit,
        maxSteps: input.maxSteps,
        steps: 0,
        inputTokens: 0,
        outputTokens: 0,
        note: '준비 중',
        uncertain: false,
        allowedOrigins: [new URL(startUrl).origin],
        approvedTexts: [],
        history: [],
        userContext: input.userContext,
        searchEngine: input.discoverySource === 'google' ? 'google' : 'naver',
      };
      if (input.kind === 'autonomy_demo') {
        job.autonomy = createAutonomy(syntheticSettings, origin, true);
        store.setSettings(`synthetic:${id}`, {
          page: 1,
          layout: input.layout || 'normal',
          inbox: input.demoInbox,
          posts: 0,
        });
      } else if (input.autonomy) {
        if (input.kind !== 'apply' || !settings(store).policy.enabled)
          throw new ServiceError('delegation_not_enabled');
        job.autonomy = createAutonomy(settings(store), new URL(startUrl).origin);
        job.autonomy.evidence = event?.sourceEvidence || [];
        job.autonomy.entryChannel = event?.entryChannel;
      }
      if (event && !store.claimSubmission(event.id, id))
        throw new ServiceError('event_already_started_or_submitted');
      store.saveJob(job);
      store.setSettings('selection', input.provider);
      runner.start(id);
      return send(response, 201, { id });
    }
    const match = url.pathname.match(
      /^\/api\/jobs\/([a-f0-9-]+)\/(pause|stop|resume|approve|notes|reconcile|verify-result|context|inbox|delegation)$/,
    );
    if (match) {
      const id = match[1]!;
      const action = match[2]!;
      const job = store.job(id);
      if (!job) throw new ServiceError('job_not_found', 404);
      if (action === 'notes' && method === 'GET')
        return send(response, 200, { notes: store.notes(id) });
      if (method !== 'POST') throw new ServiceError('method_not_allowed', 405);
      if (action === 'verify-result') {
        if (runner.isBusy() || manualNavigation || !job.uncertain)
          throw new ServiceError('result_verification_unavailable');
        manualNavigation = true;
        try {
          const verified = await verifyReceipt(
            store,
            browser,
            model,
            job,
            AbortSignal.timeout(120_000),
            true,
          );
          return send(response, 200, { verified });
        } finally {
          manualNavigation = false;
        }
      }
      if (
        ['resume', 'approve', 'inbox'].includes(action) &&
        (job.browserEngine || 'chromium') !== browser.engine
      )
        throw new ServiceError('job_browser_profile_mismatch');
      if (action === 'inbox') {
        if (
          runner.isBusy() ||
          manualNavigation ||
          !job.autonomy?.inbox ||
          job.status !== 'needs_user'
        )
          throw new ServiceError('inbox_not_available');
        const state = job.autonomy,
          inbox = state.inbox!;
        if (data.inboxId !== inbox.id || Date.now() - inbox.createdAt > 24 * 60 * 60_000)
          throw new ServiceError('inbox_expired');
        if (browser.ownerJobId !== job.id || !browser.page)
          throw new ServiceError('autonomy_live_page_required');
        if (inbox.final) {
          if (data.confirm !== true) throw new ServiceError('final_confirmation_required');
          state.finalApproval = inbox.fingerprint;
        } else {
          if ((await inspectForm(browser.page)).view.fingerprint !== inbox.fingerprint)
            throw new ServiceError('inbox_page_changed');
          const answers = z
            .record(z.string(), z.array(z.string().max(2000)).max(30))
            .parse(data.answers);
          const validated = inbox.items.map((q) => ({
            q,
            answer: validateAnswer(q, answers[q.id] || []),
          }));
          if (validated.some((v) => !v.answer)) throw new ServiceError('invalid_inbox_answer');
          for (const { q, answer } of validated) {
            state.overrides[q.signature] = answer!;
            if (q.kind === 'text')
              state.privateAnswers = [...new Set([...(state.privateAnswers || []), ...answer!])];
            if (data.remember === true && !state.synthetic)
              saveAnswer(store, {
                signature: q.signature,
                question: q.label,
                kind: q.kind,
                category: q.category,
                answer: answer!,
                origin: state.origin,
              });
          }
        }
        state.metrics.waitingMs = (state.metrics.waitingMs || 0) + Date.now() - inbox.createdAt;
        delete state.inbox;
        job.status = 'paused';
        store.saveJob(job);
        runner.start(id);
        return send(response, 200, { ok: true });
      }
      if (action === 'delegation') {
        if (
          runner.isBusy() ||
          !job.autonomy ||
          job.autonomy.synthetic ||
          job.uncertain ||
          ['completed', 'stopped'].includes(job.status)
        )
          throw new ServiceError('cannot_update_job_delegation');
        job.autonomy = createAutonomy(settings(store), job.autonomy.origin);
        job.status = 'paused';
        store.saveJob(job);
        return send(response, 200, { ok: true });
      }
      if (action === 'pause' || action === 'stop') await runner.pause(id, action === 'stop');
      else if (action === 'resume') {
        if (manualNavigation) throw new ServiceError('browser_busy', 409);
        if (job.status === 'approval') throw new ServiceError('review_pending_action_first');
        if (job.autonomy?.inbox && data.useCurrentPage !== true)
          throw new ServiceError('answer_inbox_first');
        if (runner.isBusy()) throw new ServiceError('browser_busy', 409);
        if (data.useCurrentPage === true) {
          const current = browser.page?.url();
          if (!current || !job.allowedOrigins.includes(new URL(current).origin))
            throw new ServiceError('current_page_outside_job_scope');
          // Explicit manual handoff: keep a live POST-backed form instead of reloading its URL.
          browser.ownerJobId = id;
          browser.invalidate();
          job.currentUrl = current;
          if (job.autonomy) {
            delete job.autonomy.inbox;
            delete job.autonomy.plan;
            delete job.autonomy.finalApproval;
          }
          store.saveJob(job);
        }
        if (data.extraSteps === 20) {
          job.maxSteps = Math.min(300, job.maxSteps + 20);
          store.saveJob(job);
        }
        runner.start(id);
      } else if (action === 'approve') {
        if (manualNavigation) throw new ServiceError('browser_busy', 409);
        runner.approve(id, z.string().parse(data.approvalId));
      } else if (action === 'context') {
        if (runner.isBusy() || ['completed', 'stopped'].includes(job.status))
          throw new ServiceError('pause_before_updating_context');
        const text = z.string().min(1).max(2000).parse(data.text);
        const combined = [job.userContext, text].filter(Boolean).join('\n');
        if (combined.length > 12000) throw new ServiceError('user_context_limit');
        job.userContext = combined;
        delete job.approval;
        job.status = job.uncertain ? 'submission_unknown' : 'paused';
        job.note = '사용자 답변을 추가했습니다. 새 화면에서 재개할 수 있습니다.';
        store.saveJob(job);
        store.note(id, '사용자가 작업 답변을 추가했습니다.');
      } else if (action === 'reconcile') {
        if (runner.isBusy() || !job.uncertain || data.confirmed !== true)
          throw new ServiceError('manual_reconciliation_required');
        job.uncertain = false;
        job.status = 'paused';
        job.note =
          '사용자가 현재 상태와 미제출을 직접 확인했습니다. 새 화면에서 재개할 수 있습니다.';
        delete job.approval;
        store.saveJob(job);
        store.note(id, job.note);
        if (job.eventId) store.markSubmission(job.eventId, 'user_confirmed_not_submitted');
      }
      return send(response, 200, { ok: true });
    }
    if (method === 'GET' && /^\/evidence\/[a-f0-9-]+\.png$/.test(url.pathname)) {
      const name = url.pathname.split('/').pop()!;
      return send(response, 200, await readFile(join(options.dir, 'evidence', name)), 'image/png');
    }
    const files: Record<string, [string, string]> = {
      '/': ['index.html', 'text/html; charset=utf-8'],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
      '/style.css': ['style.css', 'text/css; charset=utf-8'],
    };
    const file = files[url.pathname];
    if (method === 'GET' && file)
      return send(
        response,
        200,
        await readFile(join(options.webDir || join(import.meta.dirname, '../web'), file[0])),
        file[1],
      );
    throw new ServiceError('not_found', 404);
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  origin = `http://127.0.0.1:${address.port}`;
  const engine = z
    .enum(['chromium', 'chrome'])
    .parse(store.settings('browser', { engine: 'chromium' }).engine);
  browser = new Browser(options.dir, origin, options.headless, engine);
  runner = new Runner(store, browser, model, origin);
  return {
    origin,
    server,
    store,
    auth,
    browser,
    runner,
    async close() {
      if (runner.activeId) await runner.pause(runner.activeId);
      await browser.close();
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
      store.close();
    },
  };
}
