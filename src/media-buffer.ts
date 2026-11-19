import {MirrorError} from './errors.js';
export interface MediaSink {
  write(bytes: Uint8Array): void;
  finish(): Buffer;
}
/** A size in mebibytes, rounded up to a tenth, so a file one byte over a limit never reads as equal to it. */
const mebibytes = (bytes: number) => +(Math.ceil((bytes * 10) / 1048576) / 10).toFixed(1) + ' MiB';
/** The length a response declares, when it declares a whole number of bytes (an absent or malformed header declares none). */
export function declaredLength(response: Response): number | undefined {
  const value = response.headers.get('content-length')?.trim();
  return value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : undefined;
}
/**
 * A file over the media limit, said so with both numbers (lead decision 2026-11-19, r25-media-drive-large): its size when
 * AMCP knows it (a declared length, a Drive file's metadata, a website upload's declared size), else only that it passed
 * the maximum. The same numbers are in the details, exactly, as size_bytes and maximum_bytes.
 */
export function mediaTooLarge(maximum: number, size?: number): MirrorError {
  return size === undefined
    ? new MirrorError(
        'MEDIA_TOO_LARGE',
        'This file is too large: it is over {maximum}, the most AMCP imports.',
        {maximum_bytes: maximum},
        400,
        false,
        {maximum: mebibytes(maximum)},
      )
    : new MirrorError(
        'MEDIA_TOO_LARGE',
        'This file is too large: {size}. AMCP imports files of at most {maximum}.',
        {size_bytes: size, maximum_bytes: maximum},
        400,
        false,
        {size: mebibytes(size), maximum: mebibytes(maximum)},
      );
}
/** Drain to encrypted chunks when a staging reservation is supplied. Never retain the network chunk list. */
export async function readMediaBody(response: Response, limit: number, sink?: MediaSink): Promise<Buffer> {
  const declared = declaredLength(response);
  if (declared !== undefined && declared > limit) {
    await response.body?.cancel();
    throw mediaTooLarge(limit, declared);
  }
  const reader = response.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader)
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) throw mediaTooLarge(limit);
        if (sink) sink.write(value);
        else chunks.push(value);
      }
    return sink ? sink.finish() : Buffer.concat(chunks);
  } catch (e) {
    try {
      await reader?.cancel();
    } catch {}
    throw e;
  } finally {
    reader?.releaseLock();
  }
}
