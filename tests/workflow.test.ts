import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, type Job } from '../src/store.js';
import { syntheticSettings } from '../src/autonomy.js';
import {
  prepareDiscoveredEntry,
  nextWorkflowJob,
  reuseUnenteredCandidates,
} from '../src/workflow.js';
import { buildTasks } from '../src/tasks.js';

test('a skipped candidate starts a separate metered discovery with inherited switch and expiry bounds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-switch-search-')),
    store = new Store(dir);
  try {
    store.setSettings('autonomy', syntheticSettings);
    store.setSettings('selectionPolicy', { maxSwitches: 1 });
    const parent = {
      id: 'parent',
      kind: 'discover',
      status: 'completed',
      goal: '새 공개 이벤트',
      startUrl: 'https://example.org/events',
      maxSteps: 40,
      candidateLimit: 1,
      provider: { kind: 'api', model: 'fixture' },
      prepareOne: {
        revision: syntheticSettings.revision,
        expires: Date.now() + 10000,
        childId: 'child',
      },
    } as Job;
    const child = {
      id: 'child',
      parentId: parent.id,
      status: 'stopped',
      switchReason: '사전 점수 미확인',
    } as Job;
    store.saveJob(parent);
    store.saveJob(child);
    child.uncertain = true;
    assert.equal(nextWorkflowJob(store, child), undefined);
    child.uncertain = false;
    const next = store.job(nextWorkflowJob(store, child)!)!;
    assert.equal(next.kind, 'discover');
    assert.equal(next.parentId, parent.id);
    assert.equal(next.maxSteps, 40);
    assert.equal(next.steps, 0);
    assert.equal(next.prepareOne?.switches, 1);
    assert.equal(next.prepareOne?.expires, parent.prepareOne?.expires);
    assert.equal(
      nextWorkflowJob(store, child),
      undefined,
      'same skipped job cannot schedule twice',
    );
    next.prepareOne!.childId = 'later';
    store.saveJob(next);
    assert.equal(
      nextWorkflowJob(store, { ...child, id: 'later', parentId: next.id }),
      undefined,
      'switch cap survives nested discovery',
    );
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opted-in discovery chooses one observed eligible form and claims it atomically; changed policy blocks chaining', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-chain-'));
  const store = new Store(dir);
  try {
    store.setSettings('autonomy', syntheticSettings);
    const parent = {
      id: 'discovery',
      kind: 'discover',
      status: 'completed',
      provider: { kind: 'api', model: 'fixture' },
      prepareOne: { revision: syntheticSettings.revision, expires: Date.now() + 10000 },
    } as Job;
    store.saveJob(parent);
    const candidate = {
      title: '가상 이벤트',
      organizer: 'fixture',
      entryUrl: 'https://form.naver.com/response/fixture',
      deadline: '2099-01-01T00:00:00Z',
      prize: '커피',
      winners: 10,
      requirements: ['퀴즈'],
      blockers: [],
      evidenceQuote: '공식 안내',
      evidenceKind: 'text' as const,
      effortMinutes: 3,
    };
    store.record(candidate, 'https://example.org/official', parent.id, 'x.png', {
      sourceEvidence: [
        {
          id: 's',
          url: candidate.entryUrl,
          title: '폼',
          text: '정답 안내',
          screenshot: 'x.png',
          observedAt: Date.now(),
        },
      ],
      entryChannel: '네이버',
    });
    const child = prepareDiscoveredEntry(store, parent)!;
    assert.ok(child);
    assert.equal(store.job(child)!.parentId, parent.id);
    assert.equal(store.job(child)!.autonomy!.entryChannel, '네이버');
    assert.equal(store.job(child)!.autonomy!.evidence!.length, 1);
    assert.equal(prepareDiscoveredEntry(store, parent), undefined);
    assert.equal(store.jobs().filter((j) => j.kind === 'apply').length, 1);
    const changed = {
      ...parent,
      id: 'second',
      prepareOne: { revision: 'old-policy', expires: Date.now() + 10000 },
    };
    store.saveJob(changed);
    assert.equal(prepareDiscoveredEntry(store, changed), undefined);
    const noForm = {
      ...parent,
      id: 'third',
      prepareOne: { revision: syntheticSettings.revision, expires: Date.now() + 10000 },
    };
    store.saveJob(noForm);
    store.record(
      {
        ...candidate,
        title: '댓글 필수',
        entryUrl: 'https://form.naver.com/response/other',
        requirements: ['SNS 댓글'],
      },
      'https://example.org',
      noForm.id,
      'x.png',
    );
    assert.equal(prepareDiscoveredEntry(store, noForm), undefined);
    const moaUrl = 'https://answer.moaform.com/answers/fixture';
    store.record(
      { ...candidate, title: '모아폼 공개 퀴즈', entryUrl: moaUrl },
      'https://example.org/official',
      noForm.id,
      'x.png',
      {
        sourceEvidence: [
          {
            id: 'moa',
            url: moaUrl,
            title: '관측한 폼',
            text: '퀴즈',
            screenshot: 'x.png',
            observedAt: Date.now(),
          },
        ],
      },
    );
    const moaChild = prepareDiscoveredEntry(store, noForm);
    assert.ok(moaChild);
    assert.equal(store.job(moaChild)!.startUrl, moaUrl);
    const mixedParent = {
      ...parent,
      id: 'mixed',
      prepareOne: { revision: syntheticSettings.revision, expires: Date.now() + 10000 },
    };
    store.saveJob(mixedParent);
    const social = 'https://example.org/post/1',
      form = 'https://form.naver.com/response/mixed';
    const tasks = [
      {
        id: 'like',
        kind: 'like' as const,
        url: social,
        instruction: '좋아요',
        quote: '좋아요 후 설문',
        dependsOn: [],
      },
      {
        id: 'form',
        kind: 'form' as const,
        url: form,
        instruction: '설문',
        quote: '좋아요 후 설문',
        dependsOn: ['like'],
      },
    ];
    const mixed = store.record(
      {
        ...candidate,
        title: 'SNS와 폼 혼합',
        entryUrl: form,
        requirements: ['좋아요 후 설문'],
        tasks,
      },
      social,
      mixedParent.id,
      'x.png',
      {
        sourceEvidence: [social, form].map((url, i) => ({
          id: String(i),
          url,
          title: '공식 조건',
          text: '좋아요 후 설문',
          screenshot: 'x.png',
          observedAt: Date.now(),
        })),
      },
    ).event;
    assert.throws(() => buildTasks({ ...mixed, tasks: [tasks[1]!] }), /required_task_missing/);
    assert.equal(prepareDiscoveredEntry(store, mixedParent), undefined);
    store.setSettings('taskPermissions', [
      {
        taskUrl: social,
        kinds: ['like'],
        sourceUrl: 'https://example.org/permission',
        evidence: 'Fixture operator explicitly permits this exact synthetic route',
        basis: 'operator_authorization',
        expires: Date.now() + 10000,
      },
    ]);
    const mixedId = prepareDiscoveredEntry(store, mixedParent)!;
    assert.ok(mixedId);
    assert.deepEqual(
      store.job(mixedId)!.tasks!.map((t) => t.kind),
      ['like', 'form'],
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only observed eligible unentered candidates from the same goal become read-only recheck links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-candidate-recheck-')),
    store = new Store(dir);
  try {
    store.setSettings('autonomy', syntheticSettings);
    const prior = {
      id: 'prior',
      kind: 'discover',
      status: 'completed',
      goal: '같은 무료 이벤트',
      createdAt: new Date().toISOString(),
      history: [],
    } as unknown as Job;
    store.saveJob(prior);
    const make = (id: string, changes: object = {}) =>
      store.record(
        {
          title: id,
          organizer: '가상',
          entryUrl: 'https://form.naver.com/response/' + id,
          deadline: '2099-01-01T00:00:00Z',
          prize: '커피',
          winners: 3,
          requirements: ['설문'],
          blockers: [],
          evidenceQuote: '공개 설문',
          evidenceKind: 'text',
          effortMinutes: 2,
          ...changes,
        },
        'https://example.org/event',
        prior.id,
        'fixture.png',
        {
          sourceEvidence: [
            {
              id: 's',
              url: 'https://form.naver.com/response/' + id,
              title: '원문',
              text: '공개 설문',
              screenshot: 'fixture.png',
              observedAt: Date.now(),
            },
          ],
        },
      ).event;
    const eligible = make('ready'),
      entered = make('entered'),
      blocked = make('blocked', { blockers: ['자격 미확인'] });
    store.claimSubmission(entered.id, 'existing');
    const j = {
      ...prior,
      id: 'new',
      status: 'queued',
      startUrl: 'https://example.org/list',
      history: [],
      prepareOne: { revision: syntheticSettings.revision, expires: Date.now() + 10000 },
    } as Job;
    reuseUnenteredCandidates(store, j);
    assert.deepEqual(
      j.discovery!.frontier.map((f) => f.url),
      [eligible.entryUrl],
    );
    assert.equal(j.discovery!.reusedCandidates![0]!.fromJob, prior.id);
    assert.equal(store.submission(eligible.id), undefined);
    assert.equal(store.submission(blocked.id), undefined);
    assert.equal(store.jobs().filter((j) => j.kind === 'apply').length, 0);
    reuseUnenteredCandidates(store, j);
    assert.equal(j.discovery!.frontier.length, 1);
    const different = { ...j, id: 'other', goal: '다른 요청', history: [], discovery: undefined };
    reuseUnenteredCandidates(store, different);
    assert.equal(different.discovery!.frontier.length, 0);
    const expired = {
      ...j,
      id: 'expired',
      history: [],
      discovery: undefined,
      prepareOne: { ...j.prepareOne!, expires: Date.now() - 1 },
    };
    reuseUnenteredCandidates(store, expired);
    assert.equal(expired.discovery!.frontier.length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
