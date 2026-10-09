import {createHash, createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual} from 'node:crypto';
import {MirrorError} from './errors.js';
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** A 32-byte key for one purpose, derived from MIRROR_MASTER_KEY with HKDF-SHA256 so it never reuses the key itself. */
export function purposeKey(base64MasterKey: string, purpose: string): Buffer {
  const key = Buffer.from(base64MasterKey, 'base64');
  if (key.length !== 32)
    throw new MirrorError('CONFIG_ERROR', 'MIRROR_MASTER_KEY must encode exactly 32 random bytes.');
  return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), purpose, 32));
}
// Encode boundaries, not delimiters: tenant and connection identifiers may contain '/'.
export const scopeKey = (...parts: string[]) => JSON.stringify(parts);
export function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + stable(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export function redact(value: unknown): any {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /^(?:shareable[-_]?preview[-_]?url|youtube[-_]?(?:tv[-_]?)?preview[-_]?url)$/i.test(k)
          ? '[PRIVATE_PREVIEW_URL]'
          : /^image[-_]?data$/i.test(k)
            ? '[BINARY_REDACTED]'
            : /^(authorization|authorization[-_]?code|gtm_auth|access[-_]?token|refresh[-_]?token|client[-_]?secret|consumer[-_]?secret|token[-_]?secret|developer[-_]?token|secret|oauth[-_]?token|oauth[-_]?token[-_]?secret|password|api[-_]?key|cookie|set-cookie)$/i.test(
                  k,
                )
              ? '[REDACTED]'
              : redact(v),
      ]),
    );
  if (typeof value === 'string')
    return value
      .replace(/Bearer\s+[\w.+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(
        /([?&](?:access_token|refresh_token|client_secret|secret|oauth_token|token|api_key|key|sig|signature|gtm_auth)=)[^&\s]+/gi,
        '$1[REDACTED]',
      );
  return value;
}
export function guardInput(value: unknown, path = '$', depth = 0): void {
  if (depth > 50) throw new MirrorError('INVALID_ARGUMENT', 'Input exceeds maximum nesting depth.');
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new MirrorError('INVALID_ARGUMENT', 'Non-finite number at ' + path);
  if (Array.isArray(value)) {
    value.forEach((v, i) => guardInput(v, path + '[' + i + ']', depth + 1));
    return;
  }
  if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(k))
        throw new MirrorError('INVALID_ARGUMENT', 'Unsafe property at ' + path);
      if (/(?:^id$|_ids?$|Id$|Ids$)/.test(k)) {
        for (const item of Array.isArray(v) ? v : [v])
          if (typeof item === 'number' && !Number.isSafeInteger(item))
            throw new MirrorError('UNSAFE_NUMERIC_ID', 'Pass large identifiers as strings.', {path: path + '.' + k});
      }
      guardInput(v, path + '.' + k, depth + 1);
    }
}
export class SecretBox {
  private key: Buffer;
  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32)
      throw new MirrorError('CONFIG_ERROR', 'MIRROR_MASTER_KEY must encode exactly 32 random bytes.');
  }
  seal(value: unknown, scope: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(scope));
    const body = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), body].map(x => x.toString('base64')).join('.');
  }
  open<T>(sealed: string, scope: string): T {
    try {
      const [iv, tag, body] = sealed.split('.').map(x => Buffer.from(x, 'base64'));
      if (!iv || iv.length !== 12 || !tag || tag.length !== 16 || !body) throw Error();
      const d = createDecipheriv('aes-256-gcm', this.key, iv, {authTagLength: 16});
      d.setAAD(Buffer.from(scope));
      d.setAuthTag(tag);
      return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString('utf8'));
    } catch {
      throw new MirrorError('SECRET_DECRYPT_FAILED', 'Credential decryption failed for this scope.', {}, 500);
    }
  }
}
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
