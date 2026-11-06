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
/**
 * The URL parameters whose values are credentials or signatures: redact() and redactUrlSecrets() share them. The
 * last eight are the signed-URL parameters of the object stores and CDNs that providers link to (AWS, Google Cloud,
 * TikTok's CDN and CloudFront), which carry the same secrets as `signature`.
 */
const secretParameters = new Set([
  'access_token',
  'refresh_token',
  'client_secret',
  'secret',
  'oauth_token',
  'token',
  'api_key',
  'key',
  'sig',
  'signature',
  'gtm_auth',
  'x-signature',
  'x-amz-signature',
  'x-amz-security-token',
  'x-amz-credential',
  'x-goog-signature',
  'x-goog-credential',
  'policy',
  'key-pair-id',
]);
/** The two names a signed link may keep: the link is unusable without them (`signedLinks` in redactUrlSecrets). */
const signatureParameters: ReadonlySet<string> = new Set(['sig', 'signature']);
/** A parameter name as a URL spells it: percent-decoded and lower-cased, so `X%2DAmz%2DSignature` is `x-amz-signature`. */
function parameterName(raw: string): string {
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}
/**
 * A pass that hides the value of every `name=value` pair whose name is a secret parameter and which a delimiter in
 * `leads` starts. `stop` ends a value (besides white space); names are matched whole, case-insensitively and after
 * percent-decoding, and a name in `exempt` keeps its value. Each name is at most 100 characters and holds none of the
 * delimiters, so a pass is linear in the text.
 */
const pairPass = (leads: string, stop: string) => {
  const pairs = new RegExp('([' + leads + '])([^=&;#?\\s]{1,100})=([^' + stop + '\\s]+)', 'g');
  return (text: string, exempt: ReadonlySet<string>) =>
    text.replace(pairs, (pair, lead: string, name: string) => {
      const known = parameterName(name);
      return secretParameters.has(known) && !exempt.has(known) ? lead + name + '=[REDACTED]' : pair;
    });
};
// Free text: a value runs to `&` or white space, so a secret that holds `;` or `#` is still hidden whole. A query
// joined with `;` is read by a second pass, because a value that runs on to the next `;` would hide the pair after it.
// A URL's value ends at `#` as well, where its fragment begins.
const textPairs = pairPass('?&#', '&'),
  textSemicolons = pairPass(';', '&;'),
  urlPairs = pairPass('?&#', '&#'),
  urlSemicolons = pairPass(';', '&#;'),
  noExemption: ReadonlySet<string> = new Set();
/**
 * The names whose values redact() hides under an object key, and so also inside JSON text: `{"api_key":"..."}` in a
 * provider's message hides the same value as the object does.
 */
const secretKeyNames =
  'authorization|authorization[-_]?code|gtm_auth|access[-_]?token|refresh[-_]?token|client[-_]?secret|consumer[-_]?secret|token[-_]?secret|developer[-_]?token|secret|oauth[-_]?token|oauth[-_]?token[-_]?secret|password|api[-_]?key|cookie|set-cookie';
const secretKey = new RegExp('^(?:' + secretKeyNames + ')$', 'i'),
  jsonSecrets = new RegExp('("(?:' + secretKeyNames + ')"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"', 'gi');
/**
 * Native read results keep provider text verbatim, except secrets inside URLs (SEC-04): in every string that is an
 * absolute http(s) URL, the value of each query or fragment parameter that redact() treats as secret becomes
 * [REDACTED]. Other text, such as a campaign named "token=x", is unchanged. Fields named in `signedLinks` hold
 * provider links that are unusable without their signature: there only credentials are redacted, never sig/signature.
 * Returns the redacted copy and how many strings changed.
 */
export function redactUrlSecrets(
  value: unknown,
  signedLinks: ReadonlySet<string> = new Set(),
): {value: unknown; redacted: number} {
  let redacted = 0;
  const walk = (v: unknown, signed: boolean): unknown => {
    if (typeof v === 'string') {
      if (!/^https?:\/\/[^\s]+$/i.test(v) || !/[?#;]/.test(v)) return v;
      const exempt = signed ? signatureParameters : noExemption,
        out = urlSemicolons(urlPairs(v, exempt), exempt);
      if (out !== v) redacted++;
      return out;
    }
    if (Array.isArray(v)) return v.map(item => walk(item, signed));
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, walk(item, signedLinks.has(k))]));
    return v;
  };
  const out = walk(value, false);
  return {value: out, redacted};
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
            : secretKey.test(k)
              ? '[REDACTED]'
              : redact(v),
      ]),
    );
  if (typeof value === 'string')
    return textSemicolons(
      textPairs(
        value.replace(/Bearer\s+[\w.+/=-]+/gi, 'Bearer [REDACTED]').replace(jsonSecrets, '$1"[REDACTED]"'),
        noExemption,
      ),
      noExemption,
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
/** A 32-byte master key from its base64 text; anything else is refused naming the setting. */
function masterKeyBytes(base64Key: string, setting = 'MIRROR_MASTER_KEY'): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new MirrorError('CONFIG_ERROR', setting + ' must encode exactly 32 random bytes.');
  return key;
}
/**
 * The master keys of a deployment (SEC-07 S3): `current` seals, and every key opens. `MIRROR_MASTER_KEY_PREVIOUS`
 * lists the keys a rotation replaced (base64, separated by commas or spaces) until `admin rekey` has re-sealed every
 * value under the current one. A previous key equal to the current one is ignored.
 */
export interface MasterKeys {
  current: string | undefined;
  previous: readonly string[];
}
/** Anything a caller may pass as a master key: a single key (the earlier signature), or a keyring. */
export type MasterKeyInput = string | undefined | {current: string | undefined; previous?: readonly string[]};
export function masterKeys(input: MasterKeyInput): MasterKeys {
  if (input === undefined || typeof input === 'string') return {current: input || undefined, previous: []};
  const current = input.current || undefined;
  return {current, previous: [...new Set(input.previous ?? [])].filter(k => k && k !== current)};
}
/** Parses MIRROR_MASTER_KEY_PREVIOUS; every listed key must be a 32-byte base64 key. */
export function previousMasterKeys(value: string | undefined): string[] {
  const keys = (value ?? '').split(/[\s,]+/).filter(Boolean);
  for (const key of keys) masterKeyBytes(key, 'MIRROR_MASTER_KEY_PREVIOUS');
  return keys;
}
/** A short public fingerprint naming a master key in reports (never the key, and not usable to derive it). */
export const masterKeyId = (base64Key: string) =>
  purposeKey(base64Key, 'amcp-key-id-v1').subarray(0, 6).toString('hex');
export class SecretBox {
  private key: Buffer;
  /** Keys a rotation replaced: they still open values, never seal (SEC-07 S3). */
  private previous: Buffer[];
  constructor(base64Key: string, previousKeys: readonly string[] = []) {
    this.key = masterKeyBytes(base64Key);
    this.previous = [...new Set(previousKeys)]
      .map(k => masterKeyBytes(k, 'MIRROR_MASTER_KEY_PREVIOUS'))
      .filter(k => !k.equals(this.key));
  }
  /** How many keys open values: the current one first, then each previous one. */
  get keyCount() {
    return 1 + this.previous.length;
  }
  seal(value: unknown, scope: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(scope));
    const body = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), body].map(x => x.toString('base64')).join('.');
  }
  open<T>(sealed: string, scope: string): T {
    return this.openWithKey<T>(sealed, scope).value;
  }
  /** Opens a value with the current key, else with a previous one; `key` is 0 for the current key, else 1, 2, ... */
  openWithKey<T>(sealed: string, scope: string): {value: T; key: number} {
    let parts: Buffer[];
    try {
      parts = sealed.split('.').map(x => Buffer.from(x, 'base64'));
    } catch {
      throw decryptFailed();
    }
    const [iv, tag, body] = parts;
    if (!iv || iv.length !== 12 || !tag || tag.length !== 16 || !body) throw decryptFailed();
    const keys = [this.key, ...this.previous];
    for (let index = 0; index < keys.length; index++)
      try {
        const d = createDecipheriv('aes-256-gcm', keys[index]!, iv, {authTagLength: 16});
        d.setAAD(Buffer.from(scope));
        d.setAuthTag(tag);
        return {value: JSON.parse(Buffer.concat([d.update(body), d.final()]).toString('utf8')), key: index};
      } catch {
        /* The next key, if any. */
      }
    throw decryptFailed();
  }
  /** Raw bytes sealed without JSON or base64 (OPS-01): a format byte (2), the 12-byte IV, the 16-byte tag, then the
   * ciphertext. Callers use a scope distinct from any `seal` scope, so the two formats can never be exchanged. */
  sealBytes(value: Uint8Array, scope: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(scope));
    const body = Buffer.concat([c.update(value), c.final()]);
    return Buffer.concat([Buffer.of(2), iv, c.getAuthTag(), body]);
  }
  openBytes(sealed: Uint8Array, scope: string): Buffer {
    return this.openBytesWithKey(sealed, scope).value;
  }
  openBytesWithKey(sealed: Uint8Array, scope: string): {value: Buffer; key: number} {
    const data = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
    if (data.length < sealedBytesOverhead || data[0] !== 2) throw decryptFailed();
    const keys = [this.key, ...this.previous];
    for (let index = 0; index < keys.length; index++)
      try {
        const d = createDecipheriv('aes-256-gcm', keys[index]!, data.subarray(1, 13), {authTagLength: 16});
        d.setAAD(Buffer.from(scope));
        d.setAuthTag(data.subarray(13, sealedBytesOverhead));
        return {value: Buffer.concat([d.update(data.subarray(sealedBytesOverhead)), d.final()]), key: index};
      } catch {
        /* The next key, if any. */
      }
    throw decryptFailed();
  }
}
const decryptFailed = () =>
  new MirrorError('SECRET_DECRYPT_FAILED', 'Credential decryption failed for this scope.', {}, 500);
/** Bytes `sealBytes` adds to its input: format byte, IV and authentication tag. */
export const sealedBytesOverhead = 29;
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
