import test from 'node:test';
import assert from 'node:assert/strict';
import { savedNaverContinuation } from '../src/naver-progress.js';
import { hash } from '../src/autonomy.js';
import type { Job } from '../src/store.js';
const url = 'https://form.naver.com/response/synthetic';
function fixture() {
  const j = {
    uncertain: true,
    currentUrl: url,
    intent: {
      kind: 'submission',
      at: 1,
      url,
      controlLabel: '다음',
      beforeText: '설문 진행 상태\n이름\n다음',
    },
    history: [{ action: 'form_batch' }],
  } as Job;
  const intentHash = hash(j.intent);
  j.receiptCapture = {
    intentHash,
    settled: true,
    requests: 0,
    diagnostics: {
      observedPosts: 0,
      matchedRequests: 0,
      responses: 0,
      rejected: {},
      popups: 0,
      navigations: 0,
      pageClosed: false,
    },
  };
  j.receiptObservations = [
    {
      intentHash,
      url,
      text: '설문 진행 상태\n2/2\n휴대폰 번호\n이전\n제출',
      observedAt: 2,
      screenshot: 'fixture.png',
    } as any,
  ];
  return j;
}
test('only proven first Naver Next without any POST permits a lost draft to restart', () => {
  assert.equal(savedNaverContinuation(fixture())?.progress.current, 2);
  for (const change of [
    (j: Job) => {
      j.intent!.controlLabel = '제출';
    },
    (j: Job) => {
      j.receiptCapture!.settled = false;
    },
    (j: Job) => {
      j.receiptCapture!.diagnostics!.observedPosts = 1;
    },
    (j: Job) => {
      j.receiptCapture!.diagnostics!.rejected.payload_mismatch = 1;
    },
    (j: Job) => {
      delete j.receiptCapture!.diagnostics;
    },
    (j: Job) => {
      j.receiptCapture!.intentHash = 'stale';
    },
    (j: Job) => {
      j.currentUrl = url + 'other';
    },
    (j: Job) => {
      j.receiptObservations![0]!.text = '설문 진행 상태\n3/3\n이전\n제출';
    },
    (j: Job) => {
      j.receiptObservations![0]!.observedAt = 0;
    },
    (j: Job) => {
      j.history.push({ action: 'form_batch', reason: '', url });
    },
    (j: Job) => {
      j.uncertain = false;
    },
  ]) {
    const j = fixture();
    change(j);
    assert.equal(savedNaverContinuation(j), undefined);
  }
});
