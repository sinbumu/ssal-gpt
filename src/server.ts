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
import { jobNotice } from './job-notice.js';
import { demoPage } from './demo.js';
import {
  SettingsSchema,
  createAutonomy,
  settings,
  memories,
  saveAnswer,
  syntheticSettings,
  validateAnswer,
  verificationQuestion,
  otherTextCondition,
  textDraftEligible,
  consentQuestion,
} from './autonomy.js';
import { autonomyDemo, acceptDemo } from './autonomy-demo.js';
import {
  AttachmentSchema,
  addAttachment,
  DriveSelectionSchema,
  addDriveSelection,
} from './attachments.js';
import { inspectForm } from './forms.js';
import { searchUrl } from './evidence.js';
import {
  OutcomeSchema,
  saveOutcome,
  publicOutcomes,
  outcomes,
  outcomeAlerts,
  queueResultCheck,
} from './outcomes.js';
import {
  Scheduler,
  ScheduleSchema,
  OperationsSchema,
  operations,
  schedules,
  saveSchedule,
  usage,
  meteredModel,
  dayKey,
} from './operations.js';
import { verifyReceipt } from './receipt.js';
import { journeyTasks, journeyPage, acceptJourney } from './journey-demo.js';
import {
  approveTask,
  buildTasks,
  PermissionSchema,
  taskPermission,
  instagramBrowser,
} from './tasks.js';
import { SelectionSchema, SELECTION_PRESETS, selection, evaluateCandidate } from './selection.js';
import { preparationReasons } from './workflow.js';
import { connectionSummary, checkConnections, saveConnection } from './connections.js';
import {
  entryLifecycle,
  manageEntry,
  retryEntry,
  reportManualCompletion,
} from './entry-lifecycle.js';
import {
  report,
  reportCsv,
  QualitySchema,
  recordQuality,
  ActivitySchema,
  recordActivity,
} from './reporting.js';

const ProviderSchema = z.object({
  kind: z.enum(['chatgpt', 'api']),
  accountId: z.string().optional(),
  model: z.string().min(1).max(150),
});
const JobSchema = z.object({
  kind: z.enum(['discover', 'apply', 'demo', 'autonomy_demo']),
  autonomy: z.boolean().default(false),
  prepareOne: z.boolean().default(false),
  demoInbox: z.boolean().default(false),
  demoExtended: z.boolean().default(false),
  demoJourney: z.boolean().default(false),
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
  let scheduler: Scheduler;
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
      const journey = url.pathname.match(/^\/demo\/journey\/(social|form)$/);
      if (journey) {
        const run = z.string().uuid().parse(url.searchParams.get('run')),
          job = store.job(run);
        if (!job?.autonomy?.synthetic) throw new ServiceError('synthetic_job_required');
        if (method === 'POST') {
          if (!acceptJourney(store, job, journey[1]!, new URLSearchParams(await body(request))))
            return send(response, 400, '합성 접수 검증 실패', 'text/plain; charset=utf-8');
          response.writeHead(303, { Location: url.pathname + url.search });
          response.end();
          return;
        }
        return send(
          response,
          200,
          journeyPage(store, run, journey[1]!),
          'text/html; charset=utf-8',
        );
      }
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
        data = JSON.parse(
          await body(request, url.pathname === '/api/attachments' ? 7100000 : 64000),
        );
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
          notice: jobNotice(job),
          tasks: job.tasks?.map((task) => ({
            ...task,
            permitted: taskPermission(store, task, job.autonomy?.synthetic),
            route: /(^|\.)instagram\.com$/.test(new URL(task.url).hostname)
              ? 'instagram_browser'
              : 'registered_permission',
          })),
          sourceEvidence: undefined,
          receiptObservations: undefined,
          receiptDialogs: undefined,
          receiptResponses: undefined,
          receiptCapture: undefined,
          receiptAiAttempts: undefined,
          autonomy: job.autonomy
            ? {
                ...job.autonomy,
                profile: undefined,
                evidence: undefined,
                overrides: undefined,
                reused: undefined,
                privateAnswers: undefined,
                plan: undefined,
                inbox: job.autonomy.inbox
                  ? {
                      ...job.autonomy.inbox,
                      items: job.autonomy.inbox.items.map((q) => ({
                        ...q,
                        draftEligible: textDraftEligible(q),
                        condition: otherTextCondition(q, job.autonomy!.inbox!.items),
                      })),
                    }
                  : undefined,
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
            assessment: evaluateCandidate(store, event),
            preparationReasons: preparationReasons(store, event),
            submissionState: store.submission(event.id)?.state,
            lifecycle: entryLifecycle(store, event),
            sourceEvidence: undefined,
          };
        }),
        completedEntries: store.completedEntries(),
        outcomes: publicOutcomes(store),
        outcomeAlerts: outcomeAlerts(store, dayKey()),
        operations: operations(store),
        schedules: schedules(store),
        selectionPolicy: selection(store),
        selectionPresets: SELECTION_PRESETS,
        connections: connectionSummary(store, browser.profileKey()),
        sourceExclusions: store
          .jobs()
          .flatMap((j) =>
            (j.discovery?.rejected || []).map((r) => ({ ...r, jobId: j.id, at: j.updatedAt })),
          )
          .slice(0, 200),
        instagramBrowser: { ...instagramBrowser(store), platformPermission: 'not_verified' },
        taskPermissions: store.settings('taskPermissions', []),
        usage: usage(store),
        busy: runner.isBusy(),
        browser: browser.info(),
        activeId: runner.activeId,
        selection: store.settings('selection', null),
      });
    }
    if (method === 'POST' && url.pathname === '/api/attachments') {
      return send(
        response,
        200,
        await addAttachment(store, options.dir, AttachmentSchema.parse(data)),
      );
    }
    if (method === 'POST' && url.pathname === '/api/drive-selection')
      return send(response, 200, addDriveSelection(store, DriveSelectionSchema.parse(data)));
    if (method === 'GET' && ['/api/report', '/api/report.csv'].includes(url.pathname)) {
      const filters = z
        .object({
          from: z.string().date().optional(),
          to: z.string().date().optional(),
          source: z.string().max(200).optional(),
          type: z.string().max(30).optional(),
        })
        .parse(Object.fromEntries(url.searchParams));
      const value = report(store, filters);
      return url.pathname.endsWith('.csv')
        ? send(response, 200, reportCsv(value), 'text/csv; charset=utf-8')
        : send(response, 200, value);
    }
    if (method === 'POST' && url.pathname === '/api/selection-policy') {
      if (runner.isBusy()) throw new ServiceError('pause_before_changing_delegation');
      const parsed = SelectionSchema.parse(data);
      if (parsed.prizeMode === 'only' && !parsed.preferredPrizes.length)
        throw new ServiceError('preferred_prizes_required');
      store.setSettings('selectionPolicy', parsed);
      return send(response, 200, { ok: true });
    }
    if (method === 'POST' && url.pathname === '/api/quality') {
      recordQuality(store, QualitySchema.parse(data));
      return send(response, 200, { ok: true });
    }
    if (method === 'POST' && url.pathname === '/api/activity') {
      recordActivity(store, ActivitySchema.parse(data));
      return send(response, 200, { ok: true });
    }
    if (method === 'POST' && url.pathname === '/api/instagram-browser') {
      const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(data);
      if (runner.isBusy()) throw new ServiceError('pause_before_changing_delegation');
      store.setSettings('instagramBrowser', { enabled, revision: randomUUID() });
      return send(response, 200, { ok: true });
    }
    if (method === 'POST' && url.pathname === '/api/task-permission') {
      const input = PermissionSchema.parse(data);
      await validateUrl(input.sourceUrl, origin);
      await validateUrl(input.taskUrl, origin);
      if (input.expires > Date.now() + 30 * 24 * 60 * 60_000)
        throw new ServiceError('permission_expiry_too_long');
      const existing = store.settings<z.infer<typeof PermissionSchema>[]>('taskPermissions', []);
      store.setSettings('taskPermissions', [
        ...existing.filter((p) => p.taskUrl !== input.taskUrl),
        input,
      ]);
      return send(response, 200, { ok: true });
    }
    if (method === 'POST' && url.pathname === '/api/task-permission/revoke') {
      const taskUrl = z.string().url().parse(data.taskUrl);
      store.setSettings(
        'taskPermissions',
        store
          .settings<z.infer<typeof PermissionSchema>[]>('taskPermissions', [])
          .filter((p) => p.taskUrl !== taskUrl),
      );
      return send(response, 200, { ok: true });
    }
    if (method === 'POST' && url.pathname === '/api/outcomes') {
      const input = OutcomeSchema.parse(data);
      await validateUrl(input.sourceUrl, origin);
      if (runner.activeId && store.job(runner.activeId)?.eventId === input.eventId)
        throw new ServiceError('pause_before_updating_outcome');
      saveOutcome(store, input);
      return send(response, 200, { ok: true });
    }
    if (method === 'POST' && url.pathname === '/api/outcomes/check') {
      const id = z.string().uuid().parse(data.eventId),
        provider = ProviderSchema.parse(data.provider);
      const jobId = queueResultCheck(store, id, provider, browser.engine);
      if (!runner.isBusy() && !manualNavigation) runner.start(jobId);
      return send(response, 200, { id: jobId });
    }
    if (method === 'POST' && url.pathname === '/api/outcomes/code') {
      const id = z.string().uuid().parse(data.eventId);
      return send(response, 200, {
        code: outcomes(store).find((o) => o.eventId === id)?.reward?.code || '',
      });
    }
    if (method === 'POST' && url.pathname === '/api/operations') {
      store.setSettings('operations', OperationsSchema.parse(data));
      return send(response, 200, { ok: true });
    }
    if (method === 'POST' && url.pathname === '/api/schedules') {
      const input = ScheduleSchema.parse(data);
      await validateUrl(input.sourceUrl, origin);
      if (input.prepareOne && !settings(store).policy.enabled)
        throw new ServiceError('delegation_not_enabled');
      return send(response, 200, saveSchedule(store, input));
    }
    if (method === 'POST' && url.pathname === '/api/schedules/delete') {
      const id = z.string().uuid().parse(data.id);
      store.setSettings(
        'schedules',
        schedules(store).filter((s) => s.id !== id),
      );
      return send(response, 200, { ok: true });
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
    if (
      method === 'POST' &&
      ['/api/browser/connect-list', '/api/browser/connect-tab'].includes(url.pathname)
    ) {
      if (runner.isBusy() || manualNavigation)
        throw new ServiceError('pause_before_changing_browser');
      manualNavigation = true;
      store.setSettings('operations', { ...operations(store), queueEnabled: false });
      try {
        if (url.pathname.endsWith('connect-list'))
          return send(response, 200, {
            tabs: await browser.listConnection(z.string().url().parse(data.endpoint)),
          });
        await browser.connectTab(z.string().uuid().parse(data.tabId));
        return send(response, 200, { ok: true });
      } finally {
        manualNavigation = false;
      }
    }
    if (method === 'POST' && url.pathname === '/api/browser/open') {
      if (runner.isBusy() || manualNavigation)
        throw new ServiceError('pause_before_manual_control');
      store.setSettings('operations', { ...operations(store), queueEnabled: false });
      manualNavigation = true;
      try {
        await browser.selectJob('__manual__');
        browser.setManual(true);
        browser.setReadOnlyMode(false);
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
    if (method === 'POST' && url.pathname === '/api/connections/check') {
      if (runner.isBusy() || manualNavigation)
        throw new ServiceError('pause_before_manual_control');
      const { ids } = z
        .object({ ids: z.array(z.string().max(300)).min(1).max(10) })
        .strict()
        .parse(data);
      if (browser.engine === 'connected')
        throw new ServiceError('connected_browser_extra_tab_not_granted');
      manualNavigation = true;
      store.setSettings('operations', { ...operations(store), queueEnabled: false });
      try {
        return send(response, 200, { results: await checkConnections(store, browser, ids) });
      } finally {
        manualNavigation = false;
      }
    }
    if (method === 'POST' && url.pathname === '/api/browser/check') {
      if (runner.isBusy() || manualNavigation)
        throw new ServiceError('pause_before_manual_control');
      const result = await browser.connectionStatus();
      saveConnection(store, browser.profileKey(), result, browser.page?.url());
      return send(response, 200, result);
    }
    if (method === 'POST' && url.pathname === '/api/browser/external') {
      const url = await validateUrl(z.string().url().parse(data.url));
      await (options.externalOpen || openExternalBrowser)(url.toString());
      return send(response, 200, { ok: true, mode: 'manual', sharedSession: false });
    }
    const lifecycleMatch = url.pathname.match(
      /^\/api\/events\/([a-f0-9-]+)\/(manage|retry|manual-complete)$/,
    );
    if (method === 'POST' && lifecycleMatch) {
      if (runner.isBusy() || manualNavigation)
        throw new ServiceError('pause_before_organizing_job');
      const event = store.event(lifecycleMatch[1]!);
      if (!event) throw new ServiceError('event_not_found', 404);
      const action = lifecycleMatch[2];
      if (action === 'retry') {
        const input = z
          .object({ provider: ProviderSchema, context: z.string().trim().max(2000).optional() })
          .strict()
          .parse(data);
        await auth.bearer(input.provider);
        if (runner.isBusy() || manualNavigation) throw new ServiceError('browser_busy', 409);
        const job = retryEntry(
          store,
          store.event(event.id)!,
          input.provider,
          browser.engine,
          input.context,
        );
        runner.start(job.id);
        return send(response, 201, { id: job.id });
      }
      if (action === 'manage') {
        const input = z
          .object({
            mode: z.enum(['active', 'dropped', 'manual']),
            note: z.string().trim().max(1000).optional(),
            confirmedNoParticipation: z.boolean().optional(),
          })
          .strict()
          .parse(data);
        manageEntry(store, event, input.mode, input.note, input.confirmedNoParticipation);
      } else {
        const input = z
          .object({ confirmed: z.literal(true), evidence: z.string().trim().min(10).max(2000) })
          .strict()
          .parse(data);
        reportManualCompletion(store, event, input.evidence);
      }
      return send(response, 200, { ok: true });
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
      if (input.prepareOne && (input.kind !== 'discover' || !settings(store).policy.enabled))
        throw new ServiceError('delegation_not_enabled');
      await auth.bearer(input.provider);
      if (manualNavigation || (runner.isBusy() && !operations(store).queueEnabled))
        throw new ServiceError('browser_busy', 409);
      const event =
        input.kind === 'apply' && input.eventId ? store.event(input.eventId) : undefined;
      if (input.kind === 'apply' && (!event || !input.routeConfirmed))
        throw new ServiceError('event_and_route_confirmation_required');
      if (event && (deadlineState(event) !== 'available' || event.blockers.length))
        throw new ServiceError('event_not_eligible');
      if (event?.management?.mode && event.management.mode !== 'active')
        throw new ServiceError('entry_management_blocks_automation');
      if (event?.management?.manualAt && !event.management.manualNotEnteredAt)
        throw new ServiceError('manual_participation_check_required');
      if (event && evaluateCandidate(store, event).state !== 'eligible')
        throw new ServiceError('event_qualification_review_required');
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
        prepareOne: input.prepareOne
          ? { revision: settings(store).revision, expires: Date.now() + 24 * 60 * 60_000 }
          : undefined,
      };
      if (input.kind === 'autonomy_demo') {
        job.autonomy = createAutonomy(syntheticSettings, origin, true);
        if (input.demoJourney) {
          job.tasks = journeyTasks(origin, id);
          job.startUrl = job.tasks[0]!.url;
          job.autonomy.policy.preferenceRule = '경품은 커피, 차, 쿠폰 순서로 선호한다.';
          job.autonomy.policy.finalSubmit = 'review';
          job.autonomy.organizer = '쌀-GPT 합성 테스트';
        }
        if (input.demoExtended) {
          job.autonomy.policy.consent.mode = 'adaptive';
          job.autonomy.organizer = '쌀-GPT 합성 테스트';
        }
        store.setSettings(`synthetic:${id}`, {
          page: 1,
          layout: input.layout || 'normal',
          inbox: input.demoInbox,
          extended: input.demoExtended,
          posts: 0,
        });
      } else if (input.autonomy) {
        if (input.kind !== 'apply' || !settings(store).policy.enabled)
          throw new ServiceError('delegation_not_enabled');
        job.autonomy = createAutonomy(settings(store), new URL(startUrl).origin);
        job.autonomy.organizer = event?.organizer;
        job.autonomy.evidence = event?.sourceEvidence || [];
        job.autonomy.entryChannel = event?.entryChannel;
      }
      if (event?.tasks?.length) job.tasks = buildTasks(event);
      if (event && !store.claimSubmission(event.id, id))
        throw new ServiceError('event_already_started_or_submitted');
      store.saveJob(job);
      store.setSettings('selection', input.provider);
      if (!runner.isBusy()) runner.start(id);
      return send(response, 201, { id });
    }
    const match = url.pathname.match(
      /^\/api\/jobs\/([a-f0-9-]+)\/(pause|stop|resume|approve|notes|reconcile|verify-result|context|inbox|prepare-drafts|restore-form|review-consent|delegation|retry-research|archive|unarchive|hold-note|task)$/,
    );
    if (match) {
      const id = match[1]!;
      const action = match[2]!;
      const job = store.job(id);
      if (!job) throw new ServiceError('job_not_found', 404);
      if (action === 'notes' && method === 'GET')
        return send(response, 200, { notes: store.notes(id) });
      if (method !== 'POST') throw new ServiceError('method_not_allowed', 405);
      const managed = store.event(job.eventId || job.retryEventId || '');
      if (
        managed?.management?.manualAt &&
        !managed.management.manualNotEnteredAt &&
        !['archive', 'unarchive', 'hold-note', 'verify-result'].includes(action)
      )
        throw new ServiceError('manual_participation_check_required');
      if (
        managed?.management?.mode &&
        managed.management.mode !== 'active' &&
        !['archive', 'unarchive', 'hold-note', 'verify-result'].includes(action)
      )
        throw new ServiceError('entry_management_blocks_automation');
      if (
        job.eventId &&
        store.submission(job.eventId)?.job_id !== job.id &&
        !['archive', 'unarchive', 'hold-note'].includes(action)
      )
        throw new ServiceError('entry_owned_by_another_job');
      if (action === 'task') {
        if (runner.isBusy() || manualNavigation) throw new ServiceError('browser_busy', 409);
        if ((job.browserEngine || 'chromium') !== browser.engine)
          throw new ServiceError('job_browser_profile_mismatch');
        const items = z
          .array(
            z.object({
              taskId: z.string().max(80),
              mode: z.enum(['approve', 'manual']),
              text: z.string().max(2000).optional(),
              evidence: z.string().max(2000).optional(),
            }),
          )
          .min(1)
          .max(20)
          .parse(data.items);
        store.db.exec('BEGIN IMMEDIATE');
        try {
          for (const input of items) approveTask(store, job, input);
          store.db.exec('COMMIT');
        } catch (error) {
          store.db.exec('ROLLBACK');
          throw error;
        }
        runner.start(id);
        return send(response, 200, { ok: true });
      }
      if (
        job.archivedAt &&
        !['archive', 'unarchive', 'hold-note', 'verify-result'].includes(action)
      )
        throw new ServiceError('restore_archived_job_first');
      if (['archive', 'unarchive', 'hold-note'].includes(action)) {
        if (runner.isBusy() || ['running', 'queued'].includes(job.status))
          throw new ServiceError('pause_before_organizing_job');
        if (action === 'archive') job.archivedAt = new Date().toISOString();
        else if (action === 'unarchive') delete job.archivedAt;
        else job.holdNote = z.string().trim().min(1).max(1500).parse(data.text);
        store.saveJob(job);
        store.note(
          id,
          action === 'archive'
            ? '진행 목록에서 보관했습니다. 접수 상태와 중복 잠금은 유지합니다.'
            : action === 'unarchive'
              ? '진행 목록으로 복원했습니다. 자동으로 재개하지 않습니다.'
              : '보류 사유를 기록했습니다. 접수 상태는 변경하지 않습니다.',
        );
        return send(response, 200, { ok: true });
      }
      if (action === 'verify-result') {
        if (runner.isBusy() || manualNavigation || !job.uncertain)
          throw new ServiceError('result_verification_unavailable');
        manualNavigation = true;
        try {
          const verified = await verifyReceipt(
            store,
            browser,
            meteredModel(store, model, job),
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
        ['resume', 'approve', 'inbox', 'retry-research'].includes(action) &&
        (job.browserEngine || 'chromium') !== browser.engine
      )
        throw new ServiceError('job_browser_profile_mismatch');
      if (action === 'prepare-drafts') {
        if (manualNavigation) throw new ServiceError('browser_busy', 409);
        if (data.inboxId !== job.autonomy?.inbox?.id) throw new ServiceError('inbox_expired');
        runner.prepareDrafts(id);
        return send(response, 200, { ok: true });
      }
      if (action === 'restore-form') {
        const a = job.autonomy;
        if (
          runner.isBusy() ||
          manualNavigation ||
          data.confirmedNotSubmitted !== true ||
          !a?.inbox ||
          a.inbox.final ||
          job.status !== 'needs_user' ||
          job.archivedAt ||
          job.uncertain ||
          job.transmitted ||
          job.intent ||
          a.metrics.fields ||
          a.metrics.batches ||
          job.history.some((h) => h.action === 'form_batch') ||
          (!a.synthetic && settings(store).revision !== a.revision) ||
          (job.browserEngine || 'chromium') !== browser.engine
        )
          throw new ServiceError('untouched_form_restore_unavailable');
        const url = job.currentUrl || job.startUrl;
        if (new URL(url).origin !== a.origin) throw new ServiceError('form_origin_outside_grant');
        manualNavigation = true;
        try {
          let page = browser.jobPage(id);
          if (!page || page.isClosed() || page.url() === 'about:blank') {
            await browser.selectJob(id);
            browser.setManual(false);
            browser.setReadOnlyMode(true);
            await browser.navigate(url);
            page = browser.page!;
          }
          if ((await inspectForm(page)).view.fingerprint !== a.inbox.fingerprint)
            throw new ServiceError('inbox_page_changed');
          browser.ownerJobId = id;
          store.note(
            id,
            '직접 미제출 확인 후, 입력 전 폼을 읽기 전용으로 복원했습니다. 기존 확인함을 유지합니다.',
          );
          return send(response, 200, { ok: true });
        } finally {
          browser.setManual(true);
          manualNavigation = false;
        }
      }
      if (action === 'review-consent') {
        const a = job.autonomy;
        if (
          runner.isBusy() ||
          manualNavigation ||
          !a ||
          job.status !== 'stopped' ||
          job.archivedAt ||
          !job.note.startsWith('동의 정책에 따라') ||
          job.uncertain ||
          job.transmitted ||
          job.intent ||
          a.metrics.fields ||
          a.metrics.batches ||
          (!a.synthetic && settings(store).revision !== a.revision) ||
          (job.browserEngine || 'chromium') !== browser.engine
        )
          throw new ServiceError('consent_review_unavailable');
        const url = job.currentUrl || job.startUrl;
        if (new URL(url).origin !== a.origin) throw new ServiceError('form_origin_outside_grant');
        manualNavigation = true;
        try {
          let page = browser.jobPage(id);
          if (!page || page.isClosed() || page.url() === 'about:blank') {
            await browser.selectJob(id);
            browser.setManual(false);
            browser.setReadOnlyMode(true);
            await browser.navigate(url);
            page = browser.page!;
          }
          const { view } = await inspectForm(page);
          const items = view.questions
            .filter(
              (q) =>
                consentQuestion(q) &&
                a.consents?.some(
                  (c) =>
                    c.signature === q.signature && c.actor === 'user' && c.decision === 'decline',
                ) &&
                a.overrides[q.signature]?.length === 0,
            )
            .map((q) => ({
              ...q,
              category: 'consent' as const,
              reason: '지난 미선택은 거부로 처리됐습니다. 동의 또는 거부를 직접 선택하세요.',
            }));
          if (!items.length) throw new ServiceError('consent_review_unavailable');
          for (const q of items) {
            delete a.overrides[q.signature];
            if (a.reused) delete a.reused[q.signature];
          }
          a.inbox = {
            id: randomUUID(),
            fingerprint: view.fingerprint,
            items,
            createdAt: Date.now(),
          };
          delete a.finalApproval;
          delete a.plan;
          delete job.stopReason;
          job.status = 'needs_user';
          job.note = '다른 답변은 보존했습니다. 확인함에서 동의 선택만 다시 검토해 주세요.';
          browser.ownerJobId = id;
          if (job.eventId) store.markSubmission(job.eventId, 'in_progress');
          store.saveJob(job);
          store.note(
            id,
            '사용자가 동의 선택 재검토를 요청했습니다. 동의·제출을 자동 승인하지 않았습니다.',
          );
          return send(response, 200, { ok: true });
        } finally {
          browser.setManual(true);
          manualNavigation = false;
        }
      }
      if (action === 'retry-research') {
        const state = job.autonomy;
        const questions =
          state?.inbox?.items.filter(
            (q) =>
              q.category === 'knowledge' &&
              !verificationQuestion(q) &&
              !/이름|연락처|이메일|동의|약관|경험|회원|직업|생년/.test(q.label),
          ) || [];
        if (
          runner.isBusy() ||
          manualNavigation ||
          job.uncertain ||
          job.status !== 'needs_user' ||
          !state ||
          state.inbox?.final ||
          !questions.length ||
          (state.researchRetries || 0) >= 2
        )
          throw new ServiceError('research_retry_unavailable');
        state.researchRetries = (state.researchRetries || 0) + 1;
        state.researched = state.researched?.filter(
          (s) => !questions.some((q) => q.signature === s),
        );
        delete state.inbox;
        delete state.plan;
        delete state.finalApproval;
        job.status = 'paused';
        store.saveJob(job);
        runner.start(id);
        return send(response, 200, { ok: true });
      }
      if (action === 'inbox') {
        if (
          (runner.isBusy() && (!operations(store).queueEnabled || runner.activeId === id)) ||
          manualNavigation ||
          !job.autonomy?.inbox ||
          job.status !== 'needs_user'
        )
          throw new ServiceError('inbox_not_available');
        const state = job.autonomy,
          inbox = state.inbox!;
        if (data.inboxId !== inbox.id || Date.now() - inbox.createdAt > 24 * 60 * 60_000)
          throw new ServiceError('inbox_expired');
        manualNavigation = true;
        try {
          const page = browser.jobPage(job.id);
          if (!page) throw new ServiceError('autonomy_live_page_required');
          if (inbox.final) {
            if (data.confirm !== true) throw new ServiceError('final_confirmation_required');
            state.finalApproval = inbox.fingerprint;
          } else {
            if ((await inspectForm(page)).view.fingerprint !== inbox.fingerprint)
              throw new ServiceError('inbox_page_changed');
            const answers = z
              .record(z.string(), z.array(z.string().max(2000)).max(30))
              .parse(data.answers);
            const declines = new Set(
              z
                .array(z.string())
                .max(80)
                .parse(data.explicitDeclines || []),
            );
            for (const q of inbox.items) {
              if (q.category !== 'consent' || q.kind !== 'checkbox' || q.options.length !== 1)
                continue;
              if (!answers[q.id]?.length && !declines.has(q.id))
                throw new ServiceError('consent_decision_required');
              if (answers[q.id]?.length && declines.has(q.id))
                throw new ServiceError('invalid_consent_decision');
            }
            const validated = inbox.items.map((q) => {
              const condition = otherTextCondition(q, inbox.items);
              const parent = condition && answers[condition.questionId];
              return {
                q,
                answer: validateAnswer(
                  q,
                  condition && parent && !parent.includes(condition.optionId)
                    ? ['']
                    : answers[q.id] || [],
                ),
              };
            });
            if (validated.some((v) => !v.answer)) throw new ServiceError('invalid_inbox_answer');
            for (const { q, answer } of validated) {
              state.overrides[q.kind === 'file' ? q.id : q.signature] = answer!;
              if (q.kind === 'text')
                state.privateAnswers = [...new Set([...(state.privateAnswers || []), ...answer!])];
              if (
                data.remember === true &&
                !state.synthetic &&
                q.kind !== 'file' &&
                !verificationQuestion(q)
              )
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
          job.status = runner.isBusy() ? 'queued' : 'paused';
          job.note = runner.isBusy()
            ? '답변을 저장했습니다. 현재 작업이 끝나면 보존한 탭에서 재개합니다.'
            : '답변을 저장하고 재개합니다.';
          store.saveJob(job);
          if (!runner.isBusy()) runner.start(id);
          return send(response, 200, { ok: true });
        } finally {
          manualNavigation = false;
        }
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
        const priorConsents = job.autonomy.consents;
        job.autonomy = createAutonomy(settings(store), job.autonomy.origin);
        job.autonomy.consents = priorConsents;
        job.autonomy.organizer = store.event(job.eventId || '')?.organizer;
        job.status = 'paused';
        store.saveJob(job);
        return send(response, 200, { ok: true });
      }
      if (action === 'pause' || action === 'stop') {
        store.setSettings('operations', { ...operations(store), queueEnabled: false });
        await runner.pause(id, action === 'stop');
      } else if (action === 'resume') {
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
  scheduler = new Scheduler(store, runner, () => manualNavigation);
  scheduler.start();
  return {
    origin,
    server,
    store,
    auth,
    browser,
    runner,
    scheduler,
    async close() {
      scheduler.stop();
      if (runner.activeId) await runner.pause(runner.activeId);
      await browser.close();
      await browser.disconnectPending();
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
      store.close();
    },
  };
}
