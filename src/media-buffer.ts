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
/**
 * How long a download may go without a byte before AMCP gives up on it (r25-media-drive-large, lead decision 2026-11-19):
 * under the 45 seconds a media lease lasts without progress, so a stalled download ends before its lease does.
 */
export const MEDIA_IDLE_MS = 30000;
/**
 * The most a whole download may take (MEDIA-SIZE-AND-COMPRESSOR-DESIGN 5.3): the media limit read at 2 MiB a second, never
 * under the 45 seconds it was and never over 15 minutes. A large file that keeps arriving is not cut at 45 seconds, and a
 * download that has stopped is given up on sooner, by the idle time.
 */
export const mediaDeadlineMs = (limit: number) =>
  Math.min(15 * 60000, Math.max(45000, Math.ceil(limit / (2 * 1048576)) * 1000));
/** The two bounds of a download; each defaults to the one above. */
export interface MediaDownloadLimits {
  idleMs?: number;
  overallMs?: number;
}
/**
 * The next chunk of a body, or a refusal: the download is given up on when no byte arrives for `idleMs`, when `signal` (the
 * overall bound) fires, or when the read itself fails. The stream is cancelled without waiting for its source to answer,
 * which a source that has stopped may never do.
 */
export function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number = MEDIA_IDLE_MS,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const tooLong = () =>
        new MirrorError('MEDIA_DOWNLOAD_FAILED', 'The download took too long, so AMCP gave up on it.', {}, 502),
      onAbort = () => failed(tooLong()),
      timer = setTimeout(
        () =>
          failed(
            new MirrorError(
              'MEDIA_DOWNLOAD_FAILED',
              'The download stopped sending data, so AMCP gave up on it.',
              {idle_ms: idleMs},
              502,
            ),
          ),
        idleMs,
      ),
      cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      },
      failed = (error: MirrorError) => {
        cleanup();
        reader.cancel().catch(() => {});
        reject(error);
      };
    timer.unref();
    if (signal?.aborted) return failed(tooLong());
    signal?.addEventListener('abort', onAbort, {once: true});
    reader.read().then(
      result => {
        cleanup();
        resolve(result);
      },
      () => {
        cleanup();
        reject(
          new MirrorError('MEDIA_DOWNLOAD_FAILED', 'The download stopped before the whole file arrived.', {}, 502),
        );
      },
    );
  });
}
/**
 * What a download ends in when its sink says the operation lost its place in the shared media budget (MEDIA_ADMISSION_LOST:
 * a place lapses after 45 seconds in which no byte was written, as when Drive was slow to answer its confirmation page and
 * then its file; lead review S4-1, 2026-11-20). That refusal tells a person to inspect any submitted upload, and a download
 * submits nothing: it is a download that stopped, and says so, with the next step of one (prepare it again). Any other error
 * of the sink is its own and passes through.
 */
function downloadStopped(e: unknown): unknown {
  return e instanceof MirrorError && e.code === 'MEDIA_ADMISSION_LOST'
    ? new MirrorError(
        'MEDIA_DOWNLOAD_FAILED',
        'The download was too slow to start, so its reservation in the shared byte budget lapsed and AMCP stopped it. Nothing was saved. Prepare it again.',
        {},
        502,
      )
    : e;
}
/**
 * Drain to encrypted chunks when a staging reservation is supplied. Never retain the network chunk list. The body is read
 * within `options`: an idle time, and the overall bound as an abort signal (see readChunk).
 */
export async function readMediaBody(
  response: Response,
  limit: number,
  sink?: MediaSink,
  options: {idleMs?: number; signal?: AbortSignal} = {},
): Promise<Buffer> {
  const declared = declaredLength(response);
  if (declared !== undefined && declared > limit) {
    response.body?.cancel().catch(() => {});
    throw mediaTooLarge(limit, declared);
  }
  const reader = response.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader)
      for (;;) {
        const {done, value} = await readChunk(reader, options.idleMs, options.signal);
        if (done) break;
        size += value.length;
        if (size > limit) throw mediaTooLarge(limit);
        if (sink) sink.write(value);
        else chunks.push(value);
      }
    return sink ? sink.finish() : Buffer.concat(chunks);
  } catch (e) {
    // Dropped, not waited for: this is the first cancel of the stream when the read ends on the limit or on the sink, and a
    // source that never answers it must not hold the download (lead review S3-1, 2026-11-20).
    reader?.cancel().catch(() => {});
    throw downloadStopped(e);
  } finally {
    try {
      reader?.releaseLock();
    } catch {}
  }
}
