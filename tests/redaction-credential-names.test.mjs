import test from 'node:test';
import assert from 'node:assert/strict';
import {redact, redactUrlSecrets} from '../dist/src/security.js';
import {redactAtHead, redactUrlSecretsAtHead} from './helpers/redaction-at-head.mjs';

/**
 * DR2-01 (differential review, wave 5 round 2): one list of credential names for every form. redact() hid the names of
 * `secretKeyNames` under an object key and inside JSON text, but a `?name=value` pair in free text and a URL string in a
 * native read result were read against the narrower `secretParameters`, so `?apikey=`, `?client-secret=`,
 * `?developer_token=` and a dozen other spellings stayed readable. Synthetic values only.
 */
const SECRET = 'SYNTHETICVALUE0123456789';

// The credentials the review probed, in every spelling a hyphen, an underscore or none gives. Each is hidden in all
// four forms: a pair in free text, a URL string in a native read result, an object key and JSON text.
const stems = [
  ['access', 'token'],
  ['refresh', 'token'],
  ['client', 'secret'],
  ['consumer', 'secret'],
  ['token', 'secret'],
  ['developer', 'token'],
  ['oauth', 'token'],
  ['api', 'key'],
  ['authorization', 'code'],
  ['oauth', 'token', 'secret'],
];
const credentials = [
  ...new Set([
    ...stems.flatMap(parts => [parts.join('_'), parts.join('-'), parts.join('')]),
    'authorization',
    'gtm_auth',
    'secret',
    'password',
    'cookie',
    'set-cookie',
  ]),
];
// The signed-URL and token parameters `secretParameters` has always held: hidden as pairs and URL parameters, not as
// object keys (`key` and `policy` are ordinary property names in provider data).
const parameterOnly = [
  'token',
  'key',
  'sig',
  'signature',
  'x-signature',
  'x-amz-signature',
  'x-amz-security-token',
  'x-amz-credential',
  'x-goog-signature',
  'x-goog-credential',
  'policy',
  'key-pair-id',
];
// A name as a URL may spell it: as is, upper case, capitalised, with escaped separators and an escaped first letter.
const spellings = name => [
  ...new Set([
    name,
    name.toUpperCase(),
    name[0].toUpperCase() + name.slice(1),
    name.replace(/-/g, '%2D').replace(/_/g, '%5f'),
    '%' + name.charCodeAt(0).toString(16) + name.slice(1),
  ]),
];
const sentence = form => 'Platform returned HTTP 400 for ' + form + ' with the request';
const base = 'https://objects.example/file.bin';
// A pair after each delimiter, with the text after it that must survive.
const pairs = name => [
  ['?', `${base}?${name}=${SECRET}&n=2`, 'n=2'],
  ['&', `${base}?x=1&${name}=${SECRET}&n=2`, 'n=2'],
  ['#', `${base}?x=1#${name}=${SECRET}&n=2`, 'n=2'],
  [';', `${base}?x=1;${name}=${SECRET};n=2`, 'n=2'],
];
const hiddenIn = (text, kept) => !text.includes(SECRET) && text.includes(kept) && text.includes('[REDACTED]');

test('every credential spelling is hidden as a pair after ?, &, # and ;, in free text and in a URL string', () => {
  const failed = new Set();
  for (const name of [...credentials, ...parameterOnly])
    for (const spelled of spellings(name))
      for (const [lead, url, kept] of pairs(spelled)) {
        const free = redact(sentence(url));
        if (!hiddenIn(free, kept)) failed.add(`free text ${lead} ${spelled}: ${free}`);
        else if (redact(free) !== free) failed.add(`free text ${lead} ${spelled} is not idempotent`);
        const result = redactUrlSecrets({link: url, rows: [{paging: {next: url}}]}).value;
        if (!hiddenIn(JSON.stringify(result), kept)) failed.add(`native result ${lead} ${spelled}: ${url}`);
      }
  assert.deepEqual([...failed].slice(0, 12), []);
  assert.equal(failed.size, 0);
});

test('every credential spelling is hidden as an object key and in JSON text, as before', () => {
  for (const name of credentials) {
    for (const spelled of [name, name.toUpperCase()]) {
      assert.deepEqual(redact({[spelled]: SECRET, kept: 1}), {[spelled]: '[REDACTED]', kept: 1}, 'key ' + spelled);
      const text = redact(`{"${spelled}":"${SECRET}","n":1}`);
      assert.ok(!text.includes(SECRET) && text.includes('"n":1'), 'JSON ' + spelled + ': ' + text);
    }
  }
});

test('one predicate for every form: a name that hides as a key hides as a pair, and the pair names still do', () => {
  // The names that hide as an object key are exactly the credentials above; each of them must hide as a pair too. A
  // name added to one list and not the other would show here.
  for (const name of credentials) {
    assert.deepEqual(redact({[name]: SECRET}), {[name]: '[REDACTED]'}, 'key ' + name);
    assert.ok(!redact('x?' + name + '=' + SECRET).includes(SECRET), 'pair ' + name);
    assert.ok(!redactUrlSecrets(`${base}?${name}=${SECRET}`).value.includes(SECRET), 'URL ' + name);
  }
  for (const name of parameterOnly) {
    assert.ok(!redact('x?' + name + '=' + SECRET).includes(SECRET), 'pair ' + name);
    assert.ok(!redactUrlSecrets(`${base}?${name}=${SECRET}`).value.includes(SECRET), 'URL ' + name);
  }
});

test('a signed link keeps sig and signature and nothing else, whatever the other credentials are called', () => {
  const failed = [];
  for (const name of [...credentials, ...parameterOnly].filter(n => !['sig', 'signature'].includes(n))) {
    for (const spelled of spellings(name)) {
      const link = `https://preview.example/c?id=1&signature=SIGNATURE1&${spelled}=${SECRET}&sig=SIGNATURE2&n=3`,
        kept = redactUrlSecrets({creative_preview_link: link}, new Set(['creative_preview_link'])).value
          .creative_preview_link;
      if (
        kept.includes(SECRET) ||
        !kept.includes('signature=SIGNATURE1') ||
        !kept.includes('sig=SIGNATURE2') ||
        !kept.includes('id=1') ||
        !kept.includes('n=3')
      )
        failed.push(spelled + ': ' + kept);
    }
  }
  assert.deepEqual(failed.slice(0, 8), []);
  // The two names the link needs stay readable, in any case and with escapes, and only on a field that is allowed.
  const own = `https://preview.example/c?SIGNATURE=A1&%73ig=A2&id=1`;
  assert.equal(
    redactUrlSecrets({creative_preview_link: own}, new Set(['creative_preview_link'])).value.creative_preview_link,
    own,
  );
  assert.ok(!redactUrlSecrets({other_link: own}, new Set(['creative_preview_link'])).value.other_link.includes('A1'));
});

test('text that only looks like a URL is untouched in a native read result (SEC-04): a campaign named token=x', () => {
  const data = {
    name: 'token=x',
    campaign: 'apikey=x',
    note: 'cookie=y; authorization=z',
    label: '?apikey=x&client-secret=y',
    headline: 'Authorization: Basic x',
    rows: [{title: 'password: x'}, 'developer_token=x'],
  };
  const out = redactUrlSecrets(structuredClone(data));
  assert.deepEqual(out.value, data);
  assert.equal(out.redacted, 0);
  // A real URL in the same result is read, and counted.
  const mixed = redactUrlSecrets({name: 'token=x', link: `${base}?apikey=${SECRET}&n=1`});
  assert.equal(mixed.value.name, 'token=x');
  assert.equal(mixed.value.link, `${base}?apikey=[REDACTED]&n=1`);
  assert.equal(mixed.redacted, 1);
});

test('a secret pair that holds another secret pair hides both values, as one run, and never less than the head did', () => {
  // `;` ends the value of a `;`-led pair but not of a `#`-led one: the head hid the nested value to its own end, so a
  // newly secret `;consumersecret=` around it must not make the text after the `;` readable again.
  const cases = [
    [';consumersecret=Q1Q#refresh_token=vQ2Q;SIGNATURES=https://b.example/qQ3Q&n=1', ';consumersecret=[REDACTED]&n=1'],
    // The nested pair's `=` ends the outer value: one [REDACTED] for the whole run, and a second pass changes nothing.
    [';consumersecret=Q1Q#refresh_token=;rest', ';consumersecret=[REDACTED]'],
    [';client-secret=a?token=;x=1', ';client-secret=[REDACTED]'],
    ['?token=a#api_key=b&n=1', '?token=[REDACTED]&n=1'],
  ];
  for (const [text, expected] of cases) {
    const now = redact(text);
    assert.equal(now, expected, text);
    assert.equal(redact(now), now, 'idempotent: ' + text);
    for (const marker of ['Q1Q', 'Q2Q', 'Q3Q', 'rest'])
      if (!redactAtHead(text).includes(marker)) assert.ok(!now.includes(marker), marker + ' in ' + now);
  }
});

// ---- The differential: what the head's redaction hid, the widened one still hides ----
// Inputs of the review's kind: free text and URLs holding pairs after ?, &, #, ; with credential names in every spelling,
// plain names, escaped names, nested pairs, Bearer text and JSON text. Each value carries its own marker, so a value
// that the head hid and the new redaction shows is found whatever the text around it.
const generated = 40000;
const names = [
  ...[
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
    'x-amz-signature',
    'x-signature',
    'x-goog-credential',
    'policy',
    'key-pair-id',
  ],
  ...credentials,
  ...credentials,
  ...['next', 'name', 'n', 'keyword', 'my_token', 'tokens', 'return', 'u', 'q', 'a', 'b', 'signatures', 'policy_id'],
  ...['next', 'name', 'n', 'keyword', 'my_token', 'tokens', 'return', 'u', 'q', 'a', 'b', 'signatures', 'policy_id'],
].flatMap(spellings);
const signedLinks = new Set(['link']);
const modes = {
  text: {was: text => redactAtHead(text), now: text => redact(text)},
  url: {was: text => redactUrlSecretsAtHead(text).value, now: text => redactUrlSecrets(text).value},
  signed: {
    was: text => redactUrlSecretsAtHead({link: text}, signedLinks).value.link,
    now: text => redactUrlSecrets({link: text}, signedLinks).value.link,
  },
};
function differential(mode, count, seed) {
  let serial = 0;
  const next = n => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return Math.floor(seed / 65536) % n;
  };
  const markers = [];
  const pair = depth => {
    const marker = 'Q' + ++serial + 'Q';
    markers.push(marker);
    const value =
      ['', 'v', 'a/b', 'a:b', 'https://b.example/q', 'x%20y', 'a=b'][next(7)] +
      marker +
      (depth < 3 && next(3) === 0 ? pair(depth + 1) : '');
    return '?&#;'[next(4)] + names[next(names.length)] + '=' + value;
  };
  const regressions = [];
  let gained = 0;
  for (let i = 0; i < count; i++) {
    markers.length = 0;
    const pairsText = Array.from({length: 1 + next(4)}, () =>
      mode === 'text' ? ['', ' ', 'x ', ' end ', 'Bearer abc.def ', '{"api_key":"v"} '][next(6)] + pair(0) : pair(0),
    ).join('');
    const text = mode === 'text' ? pairsText : 'https://a.example/p' + pairsText,
      was = modes[mode].was(text),
      now = modes[mode].now(text);
    for (const marker of markers) {
      if (!was.includes(marker) && now.includes(marker)) regressions.push({mode, text, was, now, marker});
      if (was.includes(marker) && !now.includes(marker)) gained++;
    }
    if (i % 4 === 0) assert.equal(modes[mode].now(now), now, mode + ' is idempotent on ' + JSON.stringify(text));
  }
  return {regressions, gained};
}

test('over 100,000 generated inputs the widened redaction never shows a value the head hid, and hides more', () => {
  let gained = 0;
  for (const [mode, seed] of [
    ['text', 20261111],
    ['url', 20261112],
    ['signed', 20261113],
  ]) {
    const result = differential(mode, generated, seed);
    assert.deepEqual(result.regressions.slice(0, 3), [], mode + ' regressions');
    gained += result.gained;
  }
  // The sample holds the new spellings: values only the widened redaction hides.
  assert.ok(gained > 5000, 'the widened redaction hid ' + gained + ' more values than the head');
});
test('the predicate keeps the redaction linear: long names that begin like a credential name', () => {
  for (const hostile of [
    ('?' + 'access-token'.repeat(8) + '=').repeat(3000),
    ('?' + 'authorization'.repeat(7) + '=').repeat(3000),
    ('?' + 'oauth_token_secret'.repeat(5) + 'x=').repeat(3000),
    ('?' + 'a'.repeat(99) + '=').repeat(3000),
    '?apikey='.repeat(60000),
    ';set-cookie='.repeat(40000),
    '&client-secret=' + 'v'.repeat(300000),
    '?x=1&'.repeat(50000) + 'developer_token=' + 'v'.repeat(100000),
  ]) {
    const started = performance.now();
    redact(hostile);
    redactUrlSecrets('https://a.example/p' + hostile);
    assert.ok(performance.now() - started < 3000, 'redaction took ' + (performance.now() - started) + ' ms');
  }
});
