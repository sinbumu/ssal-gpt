import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Auth, ServiceError, safeMessage } from './auth.js';
import { Browser } from './browser.js';
import { Model } from './model.js';
import { Store, type Job } from './store.js';
import { Runner } from './runner.js';
import { demoPage } from './demo.js';

const ProviderSchema = z.object({
  kind: z.enum(['chatgpt', 'api']),
  accountId: z.string().optional(),
  model: z.string().min(1).max(150),
});
const JobSchema = z.object({
  kind: z.enum(['discover', 'apply', 'demo']),
  provider: ProviderSchema,
  goal: z.string().min(1).max(2000),
  eventId: z.string().optional(),
  candidateLimit: z.number().int().min(1).max(10).default(5),
  maxSteps: z.number().int().min(5).max(100).default(40),
  routeConfirmed: z.boolean().optional(),
  layout: z.enum(['normal', 'shift']).optional(),
  discoverySource: z.enum(['culture', 'google', 'custom']).default('culture'),
  sourceUrl: z.string().url().optional(),
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
        jobs: store.jobs(),
        events: store.events(),
        busy: runner.isBusy(),
        activeId: runner.activeId,
        selection: store.settings('selection', null),
      });
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
        await browser.navigate(z.string().url().parse(data.url));
        await browser.page?.bringToFront();
        return send(response, 200, { ok: true });
      } finally {
        manualNavigation = false;
      }
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
      if (
        event &&
        (!event.deadline || Date.parse(event.deadline) <= Date.now() || event.blockers.length)
      )
        throw new ServiceError('event_not_eligible');
      const id = randomUUID();
      const now = new Date().toISOString();
      const startUrl =
        input.kind === 'demo'
          ? `${origin}/demo/event?run=${id}&layout=${input.layout || 'normal'}`
          : event?.entryUrl ||
            (input.discoverySource === 'culture'
              ? 'https://www.culture.go.kr/portal/bbs/B0000101/list.do?menuNo=200031'
              : input.discoverySource === 'custom'
                ? z.string().url().parse(input.sourceUrl)
                : `https://www.google.com/search?q=${encodeURIComponent(`${new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })} ${input.goal}`)}`);
      const job: Job = {
        id,
        kind: input.kind,
        goal: input.goal,
        provider: input.provider,
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
      };
      if (event && !store.claimSubmission(event.id, id))
        throw new ServiceError('event_already_started_or_submitted');
      store.saveJob(job);
      store.setSettings('selection', input.provider);
      runner.start(id);
      return send(response, 201, { id });
    }
    const match = url.pathname.match(
      /^\/api\/jobs\/([a-f0-9-]+)\/(pause|stop|resume|approve|notes|reconcile)$/,
    );
    if (match) {
      const id = match[1]!;
      const action = match[2]!;
      const job = store.job(id);
      if (!job) throw new ServiceError('job_not_found', 404);
      if (action === 'notes' && method === 'GET')
        return send(response, 200, { notes: store.notes(id) });
      if (method !== 'POST') throw new ServiceError('method_not_allowed', 405);
      if (action === 'pause' || action === 'stop') await runner.pause(id, action === 'stop');
      else if (action === 'resume') {
        if (manualNavigation) throw new ServiceError('browser_busy', 409);
        if (job.status === 'approval') throw new ServiceError('review_pending_action_first');
        if (data.extraSteps === 20) {
          job.maxSteps = Math.min(120, job.maxSteps + 20);
          store.saveJob(job);
        }
        runner.start(id);
      } else if (action === 'approve') {
        if (manualNavigation) throw new ServiceError('browser_busy', 409);
        runner.approve(id, z.string().parse(data.approvalId));
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
  browser = new Browser(options.dir, origin, options.headless);
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
