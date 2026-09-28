import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

/** Token endpoint bodies are secret-bearing and never belong in diagnostics. */
export async function readOAuthTokenBody(response: Response): Promise<JsonObject> {
  const reader = response.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader)
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 1024 * 1024) throw Error();
        chunks.push(part.value);
      }
    const data = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error();
    return data;
  } catch {
    if (reader) await reader.cancel().catch(() => {});
    throw new MirrorError(
      'TOKEN_REFRESH_FAILED',
      'Token service returned an invalid or oversized response.',
      {http_status: response.status},
      502,
    );
  } finally {
    reader?.releaseLock();
  }
}

// RFC 6750 section 2.1. Tokens are opaque; validation must never trim or rewrite them.
export const usableBearerToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9._~+/-]+=*$/.test(value);
export const usableRefreshToken = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim() && !/[^\x20-\x7e]/.test(value);
export function tokenExpiresAt(value: unknown, fallback?: number): number {
  const supplied = value === undefined ? fallback : value;
  const seconds =
    typeof supplied === 'number'
      ? supplied
      : typeof supplied === 'string' && /^[0-9]+$/.test(supplied)
        ? Number(supplied)
        : NaN;
  const expiresAt = Date.now() + seconds * 1000;
  if (
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt > 8640000000000000
  )
    throw new MirrorError('TOKEN_REFRESH_FAILED', 'Token service returned an invalid access-token lifetime.', {}, 502);
  return expiresAt;
}
