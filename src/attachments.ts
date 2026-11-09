import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { privateDirectory } from './config.js';
import { ServiceError } from './auth.js';
import type { Store } from './store.js';

export const AttachmentSchema = z.object({
  jobId: z.string().uuid(),
  questionId: z.string().max(100),
  name: z.string().min(1).max(180),
  base64: z.string().max(7000000),
  allowUpload: z.literal(true),
  allowPicker: z.boolean().default(false),
});
type Asset = {
  id: string;
  jobId: string;
  signature: string;
  questionId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  origin: string;
  attemptedAt?: number;
  allowPicker?: boolean;
};
export async function addAttachment(
  store: Store,
  dir: string,
  input: z.infer<typeof AttachmentSchema>,
) {
  const job = store.job(input.jobId),
    box = job?.autonomy?.inbox;
  const q = box?.items.find((q) => q.id === input.questionId && q.kind === 'file');
  if (!job || job.status !== 'needs_user' || job.uncertain || !q)
    throw new ServiceError('attachment_question_unavailable');
  if (q.picker && !input.allowPicker) throw new ServiceError('picker_recipient_not_authorized');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)) throw new ServiceError('invalid_attachment');
  const buffer = Buffer.from(input.base64, 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024)
    throw new ServiceError('attachment_size_limit');
  const mimeType = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'image/png'
    : buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
      ? 'image/jpeg'
      : buffer.subarray(0, 5).toString() === '%PDF-'
        ? 'application/pdf'
        : undefined;
  if (!mimeType || !/\.(png|jpe?g|pdf)$/i.test(input.name) || /[\x00-\x1f/\\]/.test(input.name))
    throw new ServiceError('attachment_type_not_supported');
  const extension =
    mimeType === 'image/png' ? /\.png$/i : mimeType === 'image/jpeg' ? /\.jpe?g$/i : /\.pdf$/i;
  if (!extension.test(input.name)) throw new ServiceError('attachment_extension_mismatch');
  const id = randomUUID();
  const asset: Asset = {
    id,
    jobId: job.id,
    signature: q.signature,
    questionId: q.id,
    name: input.name,
    mimeType,
    size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    origin: job.autonomy!.origin,
    allowPicker: q.picker && input.allowPicker,
  };
  await writeFile(join(privateDirectory(join(dir, 'attachments')), id), buffer, {
    mode: 0o600,
    flag: 'wx',
  });
  store.setSettings(`attachment:${id}`, asset);
  job.autonomy!.privateAnswers = [
    ...new Set([...(job.autonomy!.privateAnswers || []), asset.name]),
  ];
  store.saveJob(job);
  return { id: `asset:${id}`, name: asset.name, size: asset.size };
}
export async function loadAttachment(
  store: Store,
  dir: string,
  jobId: string,
  questionId: string,
  reference: string,
) {
  if (reference.startsWith('drive:'))
    return loadDriveSelection(store, jobId, questionId, reference);
  const id = reference.replace(/^asset:/, '');
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new ServiceError('invalid_attachment_reference');
  const asset = store.settings<Asset | null>(`attachment:${id}`, null);
  const job = store.job(jobId);
  if (
    !asset ||
    !job?.autonomy ||
    asset.jobId !== jobId ||
    asset.questionId !== questionId ||
    asset.origin !== job.autonomy.origin
  )
    throw new ServiceError('attachment_outside_grant');
  const buffer = await readFile(join(dir, 'attachments', id));
  if (createHash('sha256').update(buffer).digest('hex') !== asset.sha256)
    throw new ServiceError('attachment_changed');
  return {
    name: asset.name,
    mimeType: asset.mimeType,
    buffer,
    allowPicker: asset.allowPicker,
    fromDrive: false,
    beforeUpload() {
      const current = store.settings<Asset | null>(`attachment:${id}`, null);
      if (!current || current.attemptedAt)
        throw new ServiceError('attachment_upload_state_unknown');
      store.setSettings(`attachment:${id}`, { ...current, attemptedAt: Date.now() });
    },
  };
}

export const DriveSelectionSchema = z
  .object({
    jobId: z.string().uuid(),
    questionId: z.string().max(100),
    name: z.string().trim().min(1).max(180),
    allowPicker: z.literal(true),
  })
  .strict();
type DriveSelection = z.infer<typeof DriveSelectionSchema> & {
  id: string;
  origin: string;
  attemptedAt?: number;
};
export function addDriveSelection(store: Store, input: z.infer<typeof DriveSelectionSchema>) {
  const job = store.job(input.jobId);
  const q = job?.autonomy?.inbox?.items.find(
    (q) => q.id === input.questionId && q.kind === 'file' && q.picker,
  );
  if (!job || job.status !== 'needs_user' || job.uncertain || !q)
    throw new ServiceError('attachment_question_unavailable');
  const id = randomUUID();
  store.setSettings(`driveSelection:${id}`, { ...input, id, origin: job.autonomy!.origin });
  job.autonomy!.privateAnswers = [
    ...new Set([...(job.autonomy!.privateAnswers || []), input.name]),
  ];
  store.saveJob(job);
  return { id: `drive:${id}`, name: input.name };
}
function loadDriveSelection(store: Store, jobId: string, questionId: string, ref: string) {
  const id = ref.slice(6),
    file = store.settings<DriveSelection | null>(`driveSelection:${id}`, null),
    job = store.job(jobId);
  if (
    !file ||
    file.jobId !== jobId ||
    file.questionId !== questionId ||
    file.origin !== job?.autonomy?.origin ||
    !file.allowPicker
  )
    throw new ServiceError('attachment_outside_grant');
  return {
    name: file.name,
    mimeType: '',
    buffer: Buffer.alloc(0),
    fromDrive: true,
    allowPicker: true,
    beforeUpload() {
      const latest = store.settings<DriveSelection | null>(`driveSelection:${id}`, null);
      if (!latest || latest.attemptedAt) throw new ServiceError('attachment_upload_state_unknown');
      store.setSettings(`driveSelection:${id}`, { ...latest, attemptedAt: Date.now() });
    },
  };
}
