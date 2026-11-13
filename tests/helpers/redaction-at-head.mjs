// The redaction of src/security.ts as it was at bee1db0e, the head of wave 5 round 2, frozen as the reference of the
// differential tests of package sec-hardening (DR2-01, DR2-02): a widened redaction may hide more than this one, never
// less. This is a copy of that code on purpose, so it cannot move with the code under test. Do not edit it.
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
const signatureParameters = new Set(['sig', 'signature']);
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
      copied = 0;
    heads.lastIndex = 0;
    for (let head = heads.exec(text); head; head = heads.exec(text)) {
      const name = parameterName(head[2]);
      if (!secretParameters.has(name) || exempt.has(name)) continue;
      const run = head[1] === ';' ? joinedValue : value;
      run.lastIndex = heads.lastIndex;
      if (!run.test(text)) continue;
      out += text.slice(copied, heads.lastIndex) + '[REDACTED]';
      copied = heads.lastIndex = run.lastIndex;
    }
    return copied ? out + text.slice(copied) : text;
  };
};
const textPairs = pairPass('&'),
  urlPairs = pairPass('&#'),
  noExemption = new Set();
const secretKeyNames =
  'authorization|authorization[-_]?code|gtm_auth|access[-_]?token|refresh[-_]?token|client[-_]?secret|consumer[-_]?secret|token[-_]?secret|developer[-_]?token|secret|oauth[-_]?token|oauth[-_]?token[-_]?secret|password|api[-_]?key|cookie|set-cookie';
const secretKey = new RegExp('^(?:' + secretKeyNames + ')$', 'i'),
  jsonSecrets = new RegExp('("(?:' + secretKeyNames + ')"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"', 'gi');

/** redactUrlSecrets() at the head. */
export function redactUrlSecretsAtHead(value, signedLinks = new Set()) {
  let redacted = 0;
  const walk = (v, signed) => {
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
/** redact() at the head. */
export function redactAtHead(value) {
  if (Array.isArray(value)) return value.map(redactAtHead);
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
              : redactAtHead(v),
      ]),
    );
  if (typeof value === 'string')
    return textPairs(
      value.replace(/Bearer\s+[\w.+/=-]+/gi, 'Bearer [REDACTED]').replace(jsonSecrets, '$1"[REDACTED]"'),
      noExemption,
    );
  return value;
}
