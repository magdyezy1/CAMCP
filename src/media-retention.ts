import {AsyncLocalStorage} from 'node:async_hooks';
import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

/** Website file uploads have an absolute deadline, including previews and frozen transfer copies. */
export const WEBSITE_UPLOAD_TTL_MS = 30 * 60 * 1000;
export const MEDIA_CLEANUP_INTERVAL_MS = 15000;
const idleMinutes = Number(process.env.AMCP_MEDIA_UPLOAD_IDLE_MINUTES ?? 10);
/**
 * An unfinished website upload that receives no part for this long is released before its 30-minute deadline, so an
 * abandoned upload stops holding its place (owner decision D23: earlier, never later). 1–30 minutes, default 10.
 */
export const WEBSITE_UPLOAD_IDLE_MS =
  (Number.isInteger(idleMinutes) && idleMinutes >= 1 && idleMinutes <= 30 ? idleMinutes : 10) * 60000;
/** When an unfinished upload is released if nothing more arrives: the idle window, never past its absolute deadline. */
export const websiteUploadIdleRelease = (deadline: number, now = Date.now()) =>
  Math.min(deadline, now + WEBSITE_UPLOAD_IDLE_MS);
const uploadProcessing = new AsyncLocalStorage<number>();
export const expiredWebsiteUpload = () =>
  new MirrorError('MEDIA_SOURCE_NOT_FOUND', 'The upload expired or was removed. Upload the file again.', {}, 404);
export const mediaProcessingDeadline = () => uploadProcessing.getStore();
/** A local processor inherits the nearest original upload deadline; nested steps cannot extend it. */
export async function withWebsiteUploadDeadline<T>(deadline: number | undefined, fn: () => Promise<T>): Promise<T> {
  if (deadline !== undefined && (!Number.isSafeInteger(deadline) || deadline < 0))
    throw new MirrorError(
      'MEDIA_SOURCE_NOT_FOUND',
      'The upload expiry could not be verified. Upload the file again.',
      {},
      404,
    );
  const inherited = mediaProcessingDeadline(),
    nearest = deadline === undefined ? inherited : inherited === undefined ? deadline : Math.min(inherited, deadline);
  if (nearest === undefined) return fn();
  return uploadProcessing.run(nearest, async () => {
    if (nearest <= Date.now()) throw expiredWebsiteUpload();
    const result = await fn();
    if (nearest <= Date.now()) throw expiredWebsiteUpload();
    return result;
  });
}
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
