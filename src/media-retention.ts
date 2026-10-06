import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

/** Website file uploads have an absolute deadline, including previews and frozen transfer copies. */
export const WEBSITE_UPLOAD_TTL_MS = 30 * 60 * 1000;
export const MEDIA_CLEANUP_INTERVAL_MS = 15000;
export function websiteUploadDeadline(record: JsonObject): number | undefined {
  if (record.origin !== 'upload') return undefined;
  if (!Number.isSafeInteger(record.created_at) || record.created_at < 0)
    throw new MirrorError(
      'MEDIA_SOURCE_NOT_FOUND',
      'The upload expiry could not be verified. Upload the file again.',
      {},
      404,
    );
  const deadline = record.created_at + WEBSITE_UPLOAD_TTL_MS;
  if (!Number.isSafeInteger(deadline))
    throw new MirrorError(
      'MEDIA_SOURCE_NOT_FOUND',
      'The upload expiry could not be verified. Upload the file again.',
      {},
      404,
    );
  return deadline;
}
