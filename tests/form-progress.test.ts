import test from 'node:test';
import assert from 'node:assert/strict';
import { continuationCandidate } from '../src/form-progress.js';
import type { Job } from '../src/store.js';
import type { Observation } from '../src/browser.js';
import type { FormView } from '../src/forms.js';

test('counterless continuation requires a new page, unanswered new questions and the exact original form', () => {
  const url = 'https://answer.moaform.com/answers/synthetic';
  const j = {
    uncertain: true,
    intent: {
      url,
      beforeText: '이름\n다음',
      controlLabel: '다음',
      pageMarker: { id: 'one', number: 1 },
    },
    history: [{ action: 'form_batch' }],
  } as Job;
  const o = { url, title: '고정 행사' } as Observation;
  const view = { questions: [{ label: '새 필수 문항' }], buttons: [{ label: '다음' }] } as FormView;
  const marker = { id: 'two', number: 2, back: true };
  assert.equal(continuationCandidate(j, o, view, marker), true);
  assert.equal(continuationCandidate(j, o, view, { ...marker, back: false }), false);
  assert.equal(continuationCandidate(j, o, view, { ...marker, number: 1 }), false);
  assert.equal(continuationCandidate(j, { ...o, url: url + '-different' }, view, marker), false);
  assert.equal(
    continuationCandidate(
      { ...j, intent: { ...j.intent!, controlLabel: '제출' } },
      o,
      view,
      marker,
    ),
    false,
  );
  assert.equal(
    continuationCandidate(j, o, { ...view, questions: [{ label: '이름' }] as any }, marker),
    false,
  );
  const legacy = {
    ...j,
    intent: { url, beforeText: '이름\n다음' },
    autonomy: { evidence: [{ url, title: o.title }] },
  } as Job;
  assert.equal(continuationCandidate(legacy, o, view, marker), true);
  assert.equal(continuationCandidate(legacy, o, view, { ...marker, number: 3 }), false);
  assert.equal(continuationCandidate({ ...legacy, history: [] }, o, view, marker), false);
});
