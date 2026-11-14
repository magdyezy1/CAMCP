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
 * The URL parameters whose values are credentials or signatures: redact() and redactUrlSecrets() share them, together
 * with the key names below (isSecretName). After `password` (a credential in a query, as it is under an object key)
 * come the signed-URL parameters of the object
 * stores and CDNs that providers link to (AWS, Google Cloud, TikTok's CDN and CloudFront), which carry the same secrets
 * as `signature`.
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
  'password',
  'x-signature',
  'x-amz-signature',
  'x-amz-security-token',
  'x-amz-credential',
  'x-goog-signature',
  'x-goog-credential',
  'policy',
  'key-pair-id',
]);
/**
 * The names whose values redact() hides under an object key, and so also inside JSON text: `{"api_key":"..."}` in a
 * provider's message hides the same value as the object does.
 */
const secretKeyNames =
  'authorization|authorization[-_]?code|gtm_auth|access[-_]?token|refresh[-_]?token|client[-_]?secret|consumer[-_]?secret|token[-_]?secret|developer[-_]?token|secret|oauth[-_]?token|oauth[-_]?token[-_]?secret|password|api[-_]?key|cookie|set-cookie|id[-_]?token|oauth[-_]?signature';
const secretKey = new RegExp('^(?:' + secretKeyNames + ')$', 'i'),
  jsonSecrets = new RegExp('("(?:' + secretKeyNames + ')"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"', 'gi');
/**
 * One predicate for every form (DR2-01): a name is a credential when it is a signed-URL or token parameter
 * (`secretParameters`) or one of the names redact() hides under an object key (`secretKey`). A `?apikey=` pair in free
 * text and a URL string in a native read result so hide what `{"apikey": ...}` does, spelling for spelling. `name` is as
 * parameterName() gives it: percent-decoded and lower-cased.
 */
const isSecretName = (name: string): boolean => secretParameters.has(name) || secretKey.test(name);
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
 * A pass over the `name=` heads of a text: a delimiter (`?`, `&`, `#` or `;`), a name of at most 100 characters that
 * holds none of those or white space, and `=`. The head of a secret name hides its value, to `stop` or white space
 * (a head that `;` starts stops at `;` too, so the next pair of a `;`-joined query survives). The head of any other name
 * consumes the head only, so the scan goes on inside its value and finds a secret pair nested there
 * (`?next=https://b.example/q?access_token=...`, `?a=b#access_token=...`); a scan of whole pairs would lose it, and the
 * redaction before it never did. Names are matched whole, case-insensitively and after percent-decoding, and a name in
 * `exempt` keeps its value. A secret head inside a value that is already hidden is read too: its own value may run on
 * past where the earlier one ended (a `;` ends the value of a head that `;` starts, not of one that `#` starts), and
 * the hidden run grows to it, so no pair hides less for what stands before it and a wider list of names never shows
 * what a narrower one hid. The scan is linear: a head costs at most 100 characters to read, every position is a
 * head's start at most once, and a value is read from where the hidden run before it ended, never again.
 */
const pairPass = (stop: string) => {
  const heads = new RegExp('([?&#;])([^=&;#?\\s]{1,100})=', 'g'),
    value = new RegExp('[^' + stop + '\\s]+', 'y'),
    joinedValue = new RegExp('[^' + stop + ';\\s]+', 'y');
  return (text: string, exempt: ReadonlySet<string>): string => {
    let out = '',
      copied = 0,
      hidden = 0;
    heads.lastIndex = 0;
    for (let head = heads.exec(text); head; head = heads.exec(text)) {
      const name = parameterName(head[2]!);
      if (!isSecretName(name) || exempt.has(name)) continue;
      const run = head[1] === ';' ? joinedValue : value;
      run.lastIndex = Math.max(heads.lastIndex, hidden);
      if (!run.test(text)) continue;
      // A head inside the hidden run (its `=` at or before the run's end) adds only what its value reaches beyond it:
      // one [REDACTED] stands for the whole run, and redacting the result again changes nothing.
      if (heads.lastIndex > hidden) out += text.slice(copied, heads.lastIndex) + '[REDACTED]';
      copied = hidden = run.lastIndex;
    }
    return copied ? out + text.slice(copied) : text;
  };
};
// Free text: a value runs to `&` or white space, so a secret that holds `#` or `;` is still hidden whole. A URL's
// value ends at `#` as well, where its fragment begins.
const textPairs = pairPass('&'),
  urlPairs = pairPass('&#'),
  noExemption: ReadonlySet<string> = new Set();
/**
 * The forms of a credential in a sentence, which have no `?`, `&`, `#` or `;` before the name for the pair pass to find
 * (DR2-02). They are part of redact(), so the report card, the MCP error envelope and the audit row show the same text:
 * - a header line: the value of `Authorization:`, `Proxy-Authorization:`, `Cookie:` and `Set-Cookie:` to the end of the
 *   line (a value of white space only has nothing to hide and does not reach the next line);
 * - `oauth_token=`, `token=`, `secret=`, `signature=` and `sig=` with a value, wherever they stand (`refused: token=abc
 *   for user`);
 * - a credential name of the list above, `=` or `:`, and a value, in a sentence (`request failed access_token=abc
 *   please retry`); a value the pair pass already hid is left, so `?access_token=[REDACTED]&n=1` keeps its `&n=1`, and
 *   a name straight after `?`, `&`, `#` or `;` with `=` and no white space around it is the pair pass's own head (its
 *   empty value stays as it was). With white space around the `=` the pair pass reads no head (`&access_token = x`,
 *   `;client_secret= x`), so the branch of its own below hides it: the report card's old rule did, and DR2-02 lost it
 *   (P2A-01). Its value runs to white space, a comma or a semicolon, but stops before the next credential head (a name of
 *   the list, `=` or `:`, with the `?`, `&` or `#` that starts it), so `#password =  |id_token = x#` keeps `id_token`
 *   for its own rule: a run that swallowed the name left the second value readable, which the redaction before P2A-01
 *   hid (P2B-01). When a credential head follows the `=` at once the value is empty and the branch hides its own head
 *   alone (`?password = &id_token = x` is `?[REDACTED]&[REDACTED]`): left as it was, a second pass would read what the
 *   first one hid as a value and hide more. The first branch (`name=` not after a delimiter, `name:` anywhere) keeps the run
 *   it has had since DR2-02, so that nothing it hid is shown (the redaction of 6c80be71 is the reference of the tests), and
 *   when that run ends in a credential head it hides the value of the head as well: a name and then `=` or `:` after white
 *   space (`client-secret :x?/PASSWORD :y`), or a name and its `=` or `:` with the value after white space. The run had
 *   swallowed that head, so the third credential of such a chain was readable (Ruling 16);
 * - a Meta access token: `EAA` and sixty or more letters and digits, with no closing `\b`, which would make a long run
 *   of letters and digits that ends in `_` read again from each `EAA` inside it.
 * Each scan is linear: a match consumes what it hides, and a failed start costs at most the white space after its name.
 */
const credentialHeaders = /\b((?:proxy-)?authorization|(?:set-)?cookie)([ \t]*:[ \t]*)[^\s][^\r\n]*/gi,
  bareParameters = /\b(oauth[_-]?token|token|secret|signature|sig)=[^\s,;&]+/gi,
  // The next credential head, as the branch of its own below reads it: the lead it may have, a name, `=` or `:`.
  nextCredential = '[?&#;]?\\b(?:' + secretKeyNames + ')\\s*[=:]',
  // The value of the first branch: its run, then the value of the head the run ends in, and so on along a chain (Ruling 16): a
  // name and a separator after any white space, or a name and its separator with the value after white space.
  headValue =
    '(?:(?<=\\b(?:' +
    secretKeyNames +
    '))\\s*[=:]\\s*|(?<=\\b(?:' +
    secretKeyNames +
    ')[=:])\\s+)(?!\\[REDACTED\\](?![^\\s,;&]))[^\\s,;]+',
  runValue = '\\s*(?!\\[REDACTED\\](?![^\\s,;&]))[^\\s,;]+(?:' + headValue + ')*',
  sentenceSecrets = new RegExp(
    '(?:(?<![?&#;])\\b(?:' +
      secretKeyNames +
      ')\\s*=|\\b(?:' +
      secretKeyNames +
      ')\\s*:)' +
      runValue +
      '|(?<=[?&#;])(?:' +
      secretKeyNames +
      ')(?:\\s+=|=\\s)\\s*(?!\\[REDACTED\\](?![^\\s,;&]))(?:(?:(?!' +
      nextCredential +
      ')[^\\s,;])+|(?=' +
      nextCredential +
      '))',
    'gi',
  ),
  metaTokens = /\bEAA[A-Za-z0-9]{60,}/g;
/** The text of redact(): every form above. What display, storage, errors, the MCP envelope and the audit trail show. */
const redactedText = (text: string): string =>
  textPairs(
    text
      .replace(credentialHeaders, '$1$2[REDACTED]')
      .replace(/Bearer\s+[\w.+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(jsonSecrets, '$1"[REDACTED]"'),
    noExemption,
  )
    .replace(bareParameters, '$1=[REDACTED]')
    .replace(sentenceSecrets, '[REDACTED]')
    .replace(metaTokens, '[REDACTED]');
/**
 * What the credential refusal of saved reporting queries and settings reads (Ruling 10). redact() also hides the prose
 * forms, which is right for what is shown, stored, reported and audited, but a query or setting refused because
 * `Password: reset funnel` or `Cookie: Spring sale` would hide something is refused for ordinary campaign and report text.
 * This text hides only credential-shaped content, so a value is refused when it changes: a pair of the credential list
 * (`name=value` or `name:value` with the value straight after the separator, or `token=`, `signature=`, `sig=`), a pair
 * after `?`, `&`, `#` or `;`, a JSON key of the list, an `Authorization:` or `Proxy-Authorization:` scheme word and a
 * token of eight or more characters, a `Cookie:` or `Set-Cookie:` that starts with a `name=value`, a Bearer token of
 * eight or more characters, and a Meta token. The pair pass, JSON text and Meta rule are redact()'s own. A value that is
 * already `[REDACTED]` changes nothing, so a redacted projection can be saved back. Each scan is linear as the ones above.
 */
const authorizationCredentials = /\b((?:proxy-)?authorization[ \t]*:[ \t]*[A-Za-z][\w.~+-]*[ \t]+)\S{8,}/gi,
  cookieCredentials = /\b((?:set-)?cookie[ \t]*:[ \t]*)[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^\r\n]*/gi,
  bearerCredentials = /\bBearer\s+[\w.+/=-]{8,}/gi,
  pairCredentials = new RegExp('\\b((?:' + secretKeyNames + ')[=:]|(?:token|signature|sig)=)[^\\s,;&]+', 'gi');
const credentialText = (text: string): string =>
  textPairs(
    text
      .replace(authorizationCredentials, '$1[REDACTED]')
      .replace(cookieCredentials, '$1[REDACTED]')
      .replace(bearerCredentials, 'Bearer [REDACTED]')
      .replace(jsonSecrets, '$1"[REDACTED]"'),
    noExemption,
  )
    .replace(pairCredentials, '$1[REDACTED]')
    .replace(metaTokens, '[REDACTED]');
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
      const out = urlPairs(v, signed ? signatureParameters : noExemption);
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
/** What a key hides its value as, or undefined when the key hides nothing: the same rules for every caller. */
const keyReplacement = (k: string): string | undefined =>
  /^(?:shareable[-_]?preview[-_]?url|youtube[-_]?(?:tv[-_]?)?preview[-_]?url)$/i.test(k)
    ? '[PRIVATE_PREVIEW_URL]'
    : /^image[-_]?data$/i.test(k)
      ? '[BINARY_REDACTED]'
      : secretKey.test(k)
        ? '[REDACTED]'
        : undefined;
/** A value that a display hid: where it stood and nothing of the value (Ruling 13: no hash of it either). */
export interface HiddenValue {
  path: string;
}
/**
 * The keys and the structure of redact(), with the text form chosen: the rules for keys are the same for every caller.
 * `hid`, when given, is told the path (`$`, then `["key"]` and `[0]` as changedStateFields spells them) of every value
 * that was replaced, so a display can say where it hid something and never what; without it no path is built.
 */
function redactWith(value: unknown, text: (text: string) => string, hid?: (path: string) => void, path = '$'): any {
  if (Array.isArray(value))
    return value.map((item, i) => redactWith(item, text, hid, hid ? path + '[' + i + ']' : path));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        const at = hid ? path + '[' + JSON.stringify(k) + ']' : path,
          replacement = keyReplacement(k);
        if (replacement === undefined) return [k, redactWith(v, text, hid, at)];
        if (hid && v !== replacement) hid(at);
        return [k, replacement];
      }),
    );
  if (typeof value === 'string') {
    const out = text(value);
    if (hid && out !== value) hid(path);
    return out;
  }
  return value;
}
export function redact(value: unknown): any {
  return redactWith(value, redactedText);
}
/**
 * The credential refusal's view of a value (Ruling 10): redact() with only the credential-shaped text forms, so a saved
 * reporting query or setting is refused when `redactCredentialShapes(x)` differs from `x`, and ordinary text is not.
 * Object keys are redact()'s.
 */
export function redactCredentialShapes(value: unknown): any {
  return redactWith(value, credentialText);
}
/**
 * redactCredentialShapes() for a display that a person reads and approves (the request of a review, P2A-02), with where it
 * hid something: the path of each value it replaced, in the order they stand, and nothing else of it. Not a hash either
 * (Ruling 13): when the hidden value is the credential itself, a short secret under a credential key or a field that is
 * only a token, an unsalted sha256 of it lets whoever reads the answer reverse it offline; the path alone tells the reader
 * that something was hidden and where. Ordinary text is shown whole, so a headline that begins with `Cookie:` or
 * `password:` is what the frozen request sends. What is stored (the audit row, job records) keeps redact(). A value that
 * already is its replacement hides nothing and is not listed.
 */
export function redactCredentialShapesWithPaths(value: unknown): {value: any; redacted: HiddenValue[]} {
  const redacted: HiddenValue[] = [];
  const shown = redactWith(value, credentialText, path => redacted.push({path}));
  return {value: shown, redacted};
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
