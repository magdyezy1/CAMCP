// The credential-shaped view of src/security.ts (redactCredentialShapes, Ruling 10: what the refusal of saved reporting queries and
// settings reads, and what a review shows its approver) as it was at 1400f714, the head before P2C-01 reached the view: frozen as
// the reference of the differential test of that change. The change put the JSON rule first and last and gave the cookie rule a
// folded token; what the view refuses must not change, and what it hid must stay hidden. This is a copy of that code on purpose,
// so it cannot move with the code under test. Do not edit it. (The view of a string only: the keys and the structure of an object
// are redact()'s, which `redaction-at-head.mjs` and `redaction-at-6c80be71.mjs` hold.)
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
const authorizationCredentials = /\b((?:proxy-)?authorization[ \t]*:[ \t]*[A-Za-z][\w.~+-]*[ \t]+)\S{8,}/gi,
  cookieCredentials = /\b((?:set-)?cookie[ \t]*:[ \t]*)[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^\r\n]*/gi,
  bearerCredentials = /\bBearer\s+[\w.+/=-]{8,}/gi,
  pairCredentials = new RegExp('\\b((?:' + secretKeyNames + ')[=:]|(?:token|signature|sig)=)[^\\s,;&]+', 'gi'),
  metaTokens = /\bEAA[A-Za-z0-9]{60,}/g;

/** redactCredentialShapes() at 1400f714, for a string: the text the refusal reads and the review shows. */
export function credentialViewAt1400f714(text) {
  return textPairs(
    text
      .replace(authorizationCredentials, '$1[REDACTED]')
      .replace(cookieCredentials, '$1[REDACTED]')
      .replace(bearerCredentials, 'Bearer [REDACTED]')
      .replace(jsonSecrets, '$1"[REDACTED]"'),
    noExemption,
  )
    .replace(pairCredentials, '$1[REDACTED]')
    .replace(metaTokens, '[REDACTED]');
}
