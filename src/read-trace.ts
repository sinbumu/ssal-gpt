import { join } from 'node:path';
import type { Observation } from './browser.js';
import type { Step } from './model.js';
import type { Store, Job } from './store.js';
import { writePrivate } from './config.js';
import { redactContext } from './autonomy.js';

export function readDecision(
  o: Pick<Observation, 'id' | 'elements'>,
  step: Step,
  urls: string[],
  search = false,
) {
  if (step.observationId !== o.id) return 'wrong_observation';
  if (step.action === 'navigate')
    return step.url && urls.includes(step.url) ? 'allowed' : 'unobserved_url';
  if (['scroll', 'wait'].includes(step.action) || (search && step.action === 'search'))
    return 'allowed';
  if (step.action !== 'click') return 'unsupported_action';
  if (!step.ref) return 'missing_ref';
  const target = o.elements.find((e) => e.ref === step.ref);
  if (!target) return 'unknown_ref';
  return target.navigationOnly || target.mediaNavigation ? 'allowed' : 'not_read_control';
}

export type ReadTraceSummary = {
  id: string;
  phase: string;
  screenshot: string;
  at: number;
  action?: Step['action'];
  ref?: string;
  coordinate?: boolean;
  status: 'observed' | 'proposed' | 'accepted' | 'rejected' | 'executed' | 'failed';
  reason?: string;
};

// Reproducible read decisions only. Never persist model input text, profile,
// cookies, arbitrary DOM, form values, or raw provider responses here.
export function beginReadTrace(
  store: Store,
  job: Job,
  phase: string,
  o: Observation,
  secrets: string[],
) {
  const clean = <T>(value: T): T => redactContext(value, secrets) as T;
  const summary: ReadTraceSummary = {
    id: o.id,
    phase,
    screenshot: o.screenshot,
    at: Date.now(),
    status: 'observed',
  };
  const { image: _image, instagram: _instagram, ...observation } = o;
  const record: Record<string, unknown> = {
    version: 1,
    jobId: job.id,
    provider: job.provider,
    ...summary,
    observation: clean({
      ...observation,
      elements: observation.elements.map(({ value: _value, ...e }) => e),
    }),
  };
  const save = () => {
    Object.assign(record, summary);
    writePrivate(join(store.dir, 'evidence', `${o.id}.read.json`), record);
    job.readTraces = [...(job.readTraces || []).filter((t) => t.id !== o.id), { ...summary }].slice(
      -30,
    );
    store.saveJob(job);
  };
  save();
  return {
    proposed(step: Step) {
      const ref = step.ref && /^[a-zA-Z0-9_-]{1,80}$/.test(step.ref) ? step.ref : undefined;
      Object.assign(summary, {
        status: 'proposed',
        action: step.action,
        ref,
        coordinate: step.x !== undefined || step.y !== undefined,
      });
      record.choice = clean({
        action: step.action,
        reason: step.reason,
        skipCategory: step.skipCategory,
        draftBasis: step.draftBasis,
        draftRequirementsMet: step.draftRequirementsMet,
        observationId: step.observationId,
        ref,
        x: step.x,
        y: step.y,
        delta: step.delta,
        url: step.url,
        textLength: step.text?.length,
      });
      save();
    },
    finish(status: ReadTraceSummary['status'], reason: string, details?: Record<string, unknown>) {
      summary.status = status;
      summary.reason = /^[a-z_0-9:-]{1,150}$/.test(reason) ? reason : 'unclassified_error';
      record.details = clean(details);
      save();
    },
  };
}
