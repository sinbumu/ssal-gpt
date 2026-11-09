import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Job } from '../src/store.js';
import { evaluateCandidate, assessBurden, nextDiscoveryAfterSkip } from '../src/selection.js';
import { recordActivity, recordQuality, report, reportCsv } from '../src/reporting.js';
import { syntheticSettings } from '../src/autonomy.js';
import { prepareDiscoveredEntry } from '../src/workflow.js';
import { taskPermission, approveTask } from '../src/tasks.js';

test('eligibility evidence, preferences, runtime burden and bounded alternative selection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-value-')),
    store = new Store(dir);
  try {
    store.setSettings('autonomy', syntheticSettings);
    const parent = {
      id: randomUUID(),
      kind: 'discover',
      status: 'completed',
      prepareOne: { revision: syntheticSettings.revision, expires: Date.now() + 100000 },
      provider: { kind: 'api', model: 'fixture' },
    } as Job;
    store.saveJob(parent);
    const make = (title: string) =>
      store.record(
        {
          title,
          organizer: 'fixture',
          entryUrl: `https://form.naver.com/response/${title}`,
          deadline: '2099-01-01T00:00:00Z',
          prize: '커피',
          winners: 100,
          requirements: ['퀴즈'],
          blockers: [],
          evidenceQuote: '누구나',
          evidenceKind: 'text',
          effortMinutes: 2,
          eligibility: [{ key: '거주지역', acceptedValues: ['서울'], quote: '서울 거주자만' }],
        },
        'https://example.org/official',
        parent.id,
        'fixture.png',
        {
          sourceEvidence: [
            {
              id: 's',
              url: `https://form.naver.com/response/${title}`,
              text: '서울 거주자만',
              title: 'source',
              screenshot: 'fixture.png',
              observedAt: Date.now(),
            },
          ],
        },
      ).event;
    const first = make('first'),
      second = make('second');
    assert.equal(evaluateCandidate(store, first).state, 'review');
    store.setSettings('selectionPolicy', { facts: [{ key: '거주지역', value: '부산' }] });
    assert.equal(evaluateCandidate(store, first).state, 'excluded');
    store.setSettings('selectionPolicy', {
      facts: [{ key: '거주지역', value: '서울' }],
      maxQuestions: 1,
    });
    assert.equal(
      evaluateCandidate(store, { ...first, startsAt: '2098-01-01T00:00:00Z' }).state,
      'excluded',
    );
    const id = prepareDiscoveredEntry(store, parent)!;
    const child = store.job(id)!;
    assert.throws(() => assessBurden(store, child, Date.now(), ['q1', 'q2']), /candidate_burden/);
    child.status = 'stopped';
    store.saveJob(child);
    const next = nextDiscoveryAfterSkip(store, child)!;
    const nextId = prepareDiscoveredEntry(store, next)!;
    assert.ok(nextId && nextId !== id);
    assert.notEqual(store.job(nextId)!.eventId, child.eventId);
    assert.ok(store.submission(first.id));
    assert.ok(store.submission(second.id));
    child.transmitted = true;
    assert.equal(nextDiscoveryAfterSkip(store, child), undefined);
    child.transmitted = false;
    child.uncertain = true;
    assert.equal(nextDiscoveryAfterSkip(store, child), undefined);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('platform permission, exact action scope and user approval remain independent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-permission-')),
    store = new Store(dir);
  try {
    const task = {
      id: 't',
      kind: 'comment' as const,
      url: 'https://example.org/post/1',
      instruction: '댓글',
      quote: '댓글',
      dependsOn: [],
      state: 'review' as const,
    };
    const job = { id: randomUUID(), kind: 'apply', status: 'needs_user', tasks: [task] } as Job;
    store.saveJob(job);
    assert.equal(taskPermission(store, task), false);
    assert.throws(
      () => approveTask(store, job, { taskId: 't', mode: 'approve', text: 'approved text' }),
      /not_permitted/,
    );
    store.setSettings('taskPermissions', [
      {
        taskUrl: task.url,
        kinds: ['comment'],
        sourceUrl: 'https://example.org/permissions',
        evidence: '서비스 운영자가 이 테스트 게시물에 자동 댓글 작성을 허용함',
        basis: 'operator_authorization',
        expires: Date.now() + 10000,
      },
    ]);
    assert.equal(taskPermission(store, task), true);
    assert.equal(taskPermission(store, { ...task, url: 'https://example.org/post/2' }), false);
    assert.equal(taskPermission(store, { ...task, kind: 'follow' }), false);
    assert.equal(
      taskPermission(store, { ...task, url: 'https://www.instagram.com/p/example/' }),
      false,
    );
    assert.equal(
      taskPermission(store, { ...task, url: 'https://example.org/demo/test' }, true),
      false,
    );
    approveTask(store, job, { taskId: 't', mode: 'approve', text: 'approved text' });
    assert.equal(store.job(job.id)!.tasks![0]!.approval!.text, 'approved text');
    store.setSettings('taskPermissions', []);
    assert.equal(taskPermission(store, task), false);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('report distinguishes waiting, active dashboard intervals, missing prices, invalid entries and realized rewards', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-report-')),
    store = new Store(dir);
  try {
    const id = randomUUID();
    const event = store.record(
      {
        title: '=FORMULA',
        organizer: 'fixture',
        entryUrl: 'https://example.org/form',
        deadline: '2099-01-01T00:00:00Z',
        prize: '커피',
        winners: 1,
        requirements: ['설문'],
        blockers: [],
        evidenceQuote: '공식',
        evidenceKind: 'text',
        effortMinutes: 2,
      },
      'https://example.org/event',
      'discovery',
      'fixture.png',
    ).event;
    const job = {
      id,
      kind: 'apply',
      eventId: event.id,
      status: 'needs_user',
      createdAt: new Date().toISOString(),
      autonomy: { metrics: { waitingMs: 500000 } },
    } as Job;
    store.saveJob(job);
    const sessionId = randomUUID();
    const ping = (sequence: number, now: number, active = true) =>
      recordActivity(store, { jobId: id, sessionId, sequence, active }, now);
    ping(1, 1000);
    ping(2, 6000);
    ping(2, 9000);
    ping(3, 11000, false);
    ping(4, 16000);
    ping(5, 21000);
    ping(6, 60000);
    assert.equal(store.settings<any>(`humanTime:${id}`, {}).ms, 10000);
    recordQuality(store, { eventId: event.id, status: 'invalid', reason: '공식 자격 확인 실패' });
    store.db
      .prepare('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?)')
      .run('u', '2026-11-09', id, 100, 10, null, 'reported', 1);
    const value = report(store);
    assert.equal(value.rows[0]!.humanMs, 10000);
    assert.equal(value.rows[0]!.waitingMs, 500000);
    assert.equal(value.rows[0]!.estimatedUsd, null);
    assert.equal(value.rows[0]!.unpricedCalls, 1);
    assert.equal(value.rows[0]!.invalid, 1);
    assert.equal(value.rows[0]!.lost, 0);
    assert.equal(value.rows[0]!.realizedKrw, 0);
    assert.match(reportCsv(value), /'=FORMULA/);
    assert.equal(report(store, { source: 'other.org' }).rows.length, 0);
    assert.equal(store.job(id)!.status, 'needs_user');
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
