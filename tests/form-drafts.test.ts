import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Job } from '../src/store.js';
import { createAutonomy, syntheticSettings } from '../src/autonomy.js';
import { prepareFormDrafts } from '../src/form-drafts.js';
import { meteredModel } from '../src/operations.js';
import type { ModelClient } from '../src/model.js';

test('draft completion is bounded to one inbox/call, rejects unrelated IDs and preserves policy/answers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-draft-boundary-')),
    store = new Store(dir);
  try {
    for (const mode of ['valid', 'bad-id', 'invented', 'limit']) {
      const a = createAutonomy(syntheticSettings, 'https://example.invalid', true);
      a.inbox = {
        id: randomUUID(),
        fingerprint: 'same-form',
        createdAt: Date.now(),
        items: [
          {
            id: 'q1',
            signature: 'improve',
            label: '개선의견',
            kind: 'text',
            multiple: false,
            required: false,
            options: [],
            category: 'evaluation',
            reason: 'answer_required',
          },
          {
            id: 'consent',
            signature: 'consent',
            label: '개인정보 동의',
            kind: 'checkbox',
            multiple: true,
            required: true,
            options: [{ id: 'yes', label: '동의' }],
            category: 'consent',
            reason: 'user review',
          },
        ],
      };
      const j = {
        id: randomUUID(),
        kind: 'apply',
        status: 'needs_user',
        provider: { kind: 'api', model: 'synthetic' },
        autonomy: a,
        steps: 0,
        maxSteps: mode === 'limit' ? 0 : 40,
        inputTokens: 0,
        outputTokens: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        history: [],
      } as unknown as Job;
      store.saveJob(j);
      const before = JSON.stringify({
        policy: a.policy,
        overrides: a.overrides,
        consent: a.inbox.items[1],
      });
      let calls = 0;
      const model = {
        async decide(_p: unknown, _i: string, ctx: any) {
          calls++;
          return {
            inputTokens: 10,
            outputTokens: 5,
            step: {
              action: 'form_plan',
              observationId: ctx.observationId,
              reason: 'draft',
              answers: [
                {
                  questionId: mode === 'bad-id' ? 'consent' : 'q1',
                  source: 'recommendation',
                  category: 'evaluation',
                  answer: [
                    mode === 'invented'
                      ? '직접 사용했는데 불편했습니다.'
                      : '자주 찾는 정보를 한눈에 볼 수 있으면 좋겠습니다.',
                  ],
                  reason: 'proposal',
                },
              ],
            },
          };
        },
      } as ModelClient;
      const metered = meteredModel(store, model, j);
      await prepareFormDrafts(
        store,
        metered,
        j,
        Buffer.from('fixture'),
        new AbortController().signal,
      );
      await prepareFormDrafts(
        store,
        metered,
        j,
        Buffer.from('fixture'),
        new AbortController().signal,
      );
      assert.equal(calls, mode === 'limit' ? 0 : 1);
      assert.equal(a.inbox.items[0]!.recommended?.length, mode === 'valid' ? 1 : undefined);
      assert.equal(
        JSON.stringify({ policy: a.policy, overrides: a.overrides, consent: a.inbox.items[1] }),
        before,
      );
      assert.equal(j.uncertain, undefined);
      assert.equal(j.intent, undefined);
      assert.equal(j.maxSteps, mode === 'limit' ? 0 : 40);
      assert.equal(j.inputTokens, mode === 'limit' ? 0 : 10);
      assert.equal(
        store.db.prepare('select count(*) n from usage where job_id=?').get(j.id)!.n,
        mode === 'limit' ? 0 : 1,
      );
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
