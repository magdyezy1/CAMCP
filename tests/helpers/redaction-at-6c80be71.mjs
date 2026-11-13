// The redaction of src/security.ts as it was at 6c80be71, the head package sec-followup was cut at, frozen as the reference of
// the differential tests of package sec-followup-2 (P2B-01): the fix of P2A-01 must never show what this redaction hid.
// A copy of that code on purpose, so it cannot move with the code under test. Do not edit it. The oracle of bee1db0e (the
// head before DR2-02) is `redaction-at-head.mjs`; this one already has the sentence rules, the longer name list and the pair
// pass that reads a secret head inside a hidden run, and not the alternative P2A-01 added for `&name = value`.
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
const secretKeyNames =
  'authorization|authorization[-_]?code|gtm_auth|access[-_]?token|refresh[-_]?token|client[-_]?secret|consumer[-_]?secret|token[-_]?secret|developer[-_]?token|secret|oauth[-_]?token|oauth[-_]?token[-_]?secret|password|api[-_]?key|cookie|set-cookie|id[-_]?token|oauth[-_]?signature';
const secretKey = new RegExp('^(?:' + secretKeyNames + ')$', 'i'),
  jsonSecrets = new RegExp('("(?:' + secretKeyNames + ')"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"', 'gi');
const isSecretName = name => secretParameters.has(name) || secretKey.test(name);
function parameterName(raw) {
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}
const pairPass = stop => {
  const heads = new RegExp('([?&#;])([^=&;#?\\s]{1,100})=', 'g'),
    value = new RegExp('[^' + stop + '\\s]+', 'y'),
    joinedValue = new RegExp('[^' + stop + ';\\s]+', 'y');
  return (text, exempt) => {
    let out = '',
      copied = 0,
      hidden = 0;
    heads.lastIndex = 0;
    for (let head = heads.exec(text); head; head = heads.exec(text)) {
      const name = parameterName(head[2]);
      if (!isSecretName(name) || exempt.has(name)) continue;
      const run = head[1] === ';' ? joinedValue : value;
      run.lastIndex = Math.max(heads.lastIndex, hidden);
      if (!run.test(text)) continue;
      if (heads.lastIndex > hidden) out += text.slice(copied, heads.lastIndex) + '[REDACTED]';
      copied = hidden = run.lastIndex;
    }
    return copied ? out + text.slice(copied) : text;
  };
};
const textPairs = pairPass('&'),
  noExemption = new Set();
const credentialHeaders = /\b((?:proxy-)?authorization|(?:set-)?cookie)([ \t]*:[ \t]*)[^\s][^\r\n]*/gi,
  bareParameters = /\b(oauth[_-]?token|token|secret|signature|sig)=[^\s,;&]+/gi,
  sentenceSecrets = new RegExp(
    '(?:(?<![?&#;])\\b(?:' +
      secretKeyNames +
      ')\\s*=|\\b(?:' +
      secretKeyNames +
      ')\\s*:)\\s*(?!\\[REDACTED\\](?![^\\s,;&]))[^\\s,;]+',
    'gi',
  ),
  metaTokens = /\bEAA[A-Za-z0-9]{60,}/g;
const redactedText = text =>
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
/** redact() at 6c80be71. */
export function redactAt6c80be71(value) {
  if (Array.isArray(value)) return value.map(redactAt6c80be71);
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
              : redactAt6c80be71(v),
      ]),
    );
  if (typeof value === 'string') return redactedText(value);
  return value;
}
