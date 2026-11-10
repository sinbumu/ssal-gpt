import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginReadTrace, readDecision } from '../src/read-trace.js';
import type { Observation } from '../src/browser.js';
import type { Job, Store } from '../src/store.js';

test('read trace replays exact refusal and removes private input and image payload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssal-trace-'));
  mkdirSync(join(dir, 'evidence'));
  try {
    const job = { id: 'job' } as Job;
    const store = { dir, saveJob: () => {} } as unknown as Store;
    const observation = {
      id: 'obs',
      screenshot: 'obs.png',
      url: 'https://example.org/',
      text: 'secret-name',
      image: Buffer.from('secret-image'),
      elements: [
        { ref: 'e1', label: '다음', value: 'private-field' },
        { ref: 'e2', label: '다음', mediaNavigation: 'next' },
      ],
    } as Observation;
    const step = {
      action: 'click' as const,
      observationId: 'obs',
      ref: 'e1',
      reason: 'x',
      text: 'private-model-text',
    };
    const trace = beginReadTrace(store, job, 'comment_draft', observation, ['secret-name']);
    trace.proposed(step);
    trace.finish('rejected', readDecision(observation, step, []));
    const path = join(dir, 'evidence', 'obs.read.json');
    const raw = readFileSync(path, 'utf8');
    for (const secret of ['secret-name', 'private-field', 'private-model-text', 'secret-image'])
      assert.ok(!raw.includes(secret));
    const saved = JSON.parse(raw);
    assert.equal(saved.reason, 'not_read_control');
    assert.equal(readDecision(saved.observation, saved.choice, []), saved.reason);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(job.readTraces?.length, 1);
    assert.equal(readDecision(observation, { ...step, ref: 'e2' }, []), 'allowed');
    assert.equal(
      readDecision(observation, { ...step, ref: undefined, x: 100, y: 200 }, []),
      'missing_ref',
    );
    assert.equal(readDecision(observation, { ...step, ref: 'e9' }, []), 'unknown_ref');
    assert.equal(
      readDecision(observation, { ...step, observationId: 'old' }, []),
      'wrong_observation',
    );
    assert.equal(
      readDecision(
        observation,
        { ...step, action: 'navigate', url: 'https://example.org/new' },
        [],
      ),
      'unobserved_url',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
