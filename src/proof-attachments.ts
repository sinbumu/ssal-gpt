import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ServiceError } from './auth.js';
import { settings, type InboxItem, type ProofAttachment } from './autonomy.js';
import { addAttachment } from './attachments.js';
import { canonicalUrl, type Job, type Store } from './store.js';

const names = { follow: '팔로우', like: '좋아요', comment: '댓글' };
const patterns = {
  follow: /팔로[우잉워]|구독|follow/i,
  like: /좋아요|\blike\b/i,
  comment: /댓글|comment/i,
};

// Page/model text can request proof, but only a verified prerequisite supplies it.
// We never create, edit or combine evidence images, or search arbitrary local files.
async function proposal(
  store: Store,
  job: Job,
  q: InboxItem,
): Promise<ProofAttachment | undefined> {
  if (q.kind !== 'file' || !job.taskFormStarted || !job.autonomy || job.uncertain) return;
  if (!/캡[처쳐]|인증\s*(?:샷|사진)|스크린샷|screenshot/i.test(q.label)) return;
  const kinds = (Object.keys(patterns) as (keyof typeof patterns)[]).filter((kind) =>
    patterns[kind].test(q.label),
  );
  if (kinds.length !== 1) return;
  const kind = kinds[0]!;
  const forms =
    job.tasks?.filter(
      (t) =>
        t.kind === 'form' &&
        t.state !== 'verified' &&
        canonicalUrl(t.url) === canonicalUrl(job.currentUrl || job.startUrl) &&
        new URL(t.url).origin === job.autonomy!.origin,
    ) || [];
  if (forms.length !== 1) return;
  const handles = [...q.label.matchAll(/@([a-z0-9_.]+)/gi)].map((m) => m[1]!.toLowerCase());
  const matches = job.tasks!.filter(
    (t) =>
      forms[0]!.dependsOn.includes(t.id) &&
      t.kind === kind &&
      t.state === 'verified' &&
      t.proof?.actor === 'browser' &&
      t.approval?.actor &&
      t.approval.subject &&
      t.proof.screenshot &&
      canonicalUrl(t.proof.url) === canonicalUrl(t.url) &&
      handles.every((h) => h === t.approval!.subject!.toLowerCase()),
  );
  if (matches.length !== 1) return;
  const task = matches[0]!,
    proof = task.proof!,
    screenshot = proof.screenshot!;
  if (!/^[a-f0-9-]{36}\.png$/.test(screenshot)) return;
  const owner = store.db
    .prepare('SELECT job_id FROM evidence_assets WHERE name=?')
    .get(screenshot) as { job_id: string } | undefined;
  if (owner?.job_id !== job.id) return;
  try {
    const path = join(store.dir, 'evidence', screenshot),
      stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5 * 1024 * 1024) return;
    const bytes = await readFile(path);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return;
    return {
      taskId: task.id,
      screenshot,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      name: `${kind}-proof-${screenshot}`,
      size: bytes.length,
      observedAt: proof.at,
      sourceUrl: proof.url,
      kind: names[kind],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
export async function prepareProofAttachments(store: Store, job: Job) {
  let count = 0;
  for (const q of job.autonomy?.inbox?.items || []) {
    delete q.proofAttachment;
    const proof = await proposal(store, job, q);
    if (proof) {
      q.proofAttachment = proof;
      count++;
    }
  }
  return count;
}
export const ProofAttachmentSchema = z
  .object({
    jobId: z.string().uuid(),
    inboxId: z.string().uuid(),
    questionId: z.string().max(100),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    allowUpload: z.literal(true),
    allowPicker: z.boolean().default(false),
  })
  .strict();
const granting = new Map<string, Promise<{ id: string; name: string; size: number }>>();
export async function approveProofAttachment(
  store: Store,
  input: z.infer<typeof ProofAttachmentSchema>,
) {
  const key = `proofGrant:${createHash('sha256')
    .update(JSON.stringify([input.jobId, input.inboxId, input.questionId, input.sha256]))
    .digest('hex')}`;
  const running = granting.get(key);
  if (running) return running;
  const pending = grant(store, input, key);
  granting.set(key, pending);
  try {
    return await pending;
  } finally {
    granting.delete(key);
  }
}
async function grant(store: Store, input: z.infer<typeof ProofAttachmentSchema>, key: string) {
  const check = () => {
    const job = store.job(input.jobId),
      box = job?.autonomy?.inbox;
    const q = box?.items.find((q) => q.id === input.questionId);
    if (
      !job ||
      job.status !== 'needs_user' ||
      job.uncertain ||
      box?.id !== input.inboxId ||
      !q?.proofAttachment ||
      Date.now() - box.createdAt > 86400000 ||
      (!job.autonomy!.synthetic && settings(store).revision !== job.autonomy!.revision)
    )
      throw new ServiceError('attachment_question_unavailable');
    if (q.picker && !input.allowPicker) throw new ServiceError('picker_recipient_not_authorized');
    return { job, q };
  };
  const { job, q } = check(),
    proof = await proposal(store, job, q);
  if (
    !proof ||
    proof.sha256 !== input.sha256 ||
    JSON.stringify(proof) !== JSON.stringify(q.proofAttachment)
  )
    throw new ServiceError('attachment_proof_changed');
  const prior = store.settings<{ id: string; name: string; size: number } | null>(key, null);
  // Repeated dashboard requests return the same single-use grant, never reset it.
  if (prior) return prior;
  const bytes = await readFile(join(store.dir, 'evidence', proof.screenshot));
  if (createHash('sha256').update(bytes).digest('hex') !== proof.sha256)
    throw new ServiceError('attachment_proof_changed');
  check();
  const asset = await addAttachment(store, store.dir, {
    jobId: job.id,
    questionId: q.id,
    name: proof.name,
    base64: bytes.toString('base64'),
    allowUpload: true,
    allowPicker: input.allowPicker,
  });
  store.setSettings(key, asset);
  return asset;
}
