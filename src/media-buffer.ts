import {MirrorError} from './errors.js';
export interface MediaSink {
  write(bytes: Uint8Array): void;
  finish(): Buffer;
}
/** Drain to encrypted chunks when a staging reservation is supplied. Never retain the network chunk list. */
export async function readMediaBody(response: Response, limit: number, sink?: MediaSink): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new MirrorError('MEDIA_TOO_LARGE', 'The media response exceeds its byte limit.');
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
        if (size > limit) throw new MirrorError('MEDIA_TOO_LARGE', 'The media response exceeds its byte limit.');
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
