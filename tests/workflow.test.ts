import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, type Job } from '../src/store.js';
import { syntheticSettings } from '../src/autonomy.js';
import { prepareDiscoveredEntry } from '../src/workflow.js';
import { buildTasks } from '../src/tasks.js';

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
