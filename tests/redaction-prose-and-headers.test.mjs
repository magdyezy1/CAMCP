import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {redact} from '../dist/src/security.js';
import {reportSourceError} from '../dist/src/report-errors.js';
import {NativeTransport} from '../dist/src/transport.js';
import {Store} from '../dist/src/store.js';
import {redactAtHead} from './helpers/redaction-at-head.mjs';

/**
 * DR2-02 (differential review, wave 5 round 2): the report card, the MCP error envelope and the audit row hide the same
 * text. The delimiter rule of redact() left prose and header forms readable (`access_token=abc` in a sentence,
 * `Authorization: Basic ...`, `Cookie: sid=...`), and the card alone hid some of them with private rules in
 * report-errors.ts, so a failure showed `token=[REDACTED]` on the card and the token itself in details.upstream and in the
 * audit trail. Synthetic values only.
 */
const SECRET = 'SYNTHETICVALUE0123456789';
// A Meta access token is `EAA` and sixty or more letters and digits. It is built here, so no file holds a whole one.
const META = 'EAA' + 'SYNTHETICVALUE'.repeat(5);
const tiktok = {platform: 'tiktok', account_id: '1', connection_id: 'c'};

// ---- The three surfaces, each through the code a failure really takes ----
// The website card (Copy details): what reportSourceError shows as the provider's message.
const card = text =>
  reportSourceError(
    new MirrorError(
      'PLATFORM_ERROR',
      'The platform refused the request.',
      {http_status: 400, upstream: {message: text}},
      400,
    ),
    tiktok,
  ).provider.message;
// The MCP error envelope: a provider's JSON error body read by the transport, then errorResult().
const connection = {
  id: 'c',
  tenantId: 't',
  gateway: 'tiktok_native_action',
  accounts: ['123'],
  label: 'synthetic',
  enabled: true,
  scopes: [],
};
const plan = {
  gateway: 'tiktok_native_action',
  action: 'tiktok_campaign_get',
  method: 'GET',
  path: '/v1.3/campaign/get/',
  query: {},
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  accountId: '123',
  evidence: 'TEST',
  warnings: [],
};
async function envelope(text) {
  const transport = new NativeTransport(
    async () =>
      new Response(JSON.stringify({message: text}), {status: 400, headers: {'content-type': 'application/json'}}),
    async () => {},
  );
  const error = await transport
    .request(plan, connection, {accessToken: 'TEST_CREDENTIAL_NOT_REAL'})
    .then(() => assert.fail('expected a refusal'))
    .catch(e => e);
  assert.ok(error instanceof MirrorError, String(error));
  return errorResult(error, 'request-1', 1).error.details.upstream.message;
}
// The audit row: appendAudit redacts the event before it is chained and stored.
const store = new Store(':memory:', Buffer.alloc(32, 71).toString('base64'));
after(() => store.close());
function audit(text) {
  store.appendAudit('tenant', 'request', {event: 'provider_error', message: text});
  return JSON.parse(store.recentAudit('tenant', 1)[0].event).message;
}
const surfaces = async text => ({card: card(text), envelope: await envelope(text), audit: audit(text)});

// ---- The review's examples, and the card's own cases ----
// [text, parts of it that must stay readable]. Every SYNTHETICVALUE in a text is a credential.
const hidden = {
  'a credential name and a value in a sentence (the review)': [
    `request failed access_token=${SECRET} please retry`,
    ['request failed', 'please retry'],
  ],
  'a Basic Authorization header (the review)': [`Authorization: Basic ${SECRET}`, ['Authorization:']],
  'a Cookie header with a second pair (the review)': [`Cookie: sid=${SECRET}; token=${SECRET}2`, ['Cookie:']],
  'a Meta token after token= in a provider message (the review)': [
    `Invalid token=${META} supplied`,
    ['Invalid token=', 'supplied'],
  ],
  'a bare token (the card)': [`refused: token=${SECRET} for user`, ['refused:', 'for user']],
  'a bare signature (the card)': [`bad signature=${SECRET}, retry`, ['bad signature=', ', retry']],
  'a bare sig and secret': [`sig=${SECRET} and secret=${SECRET}2 failed`, ['sig=', 'secret=', 'failed']],
  'a bare oauth_token': [`oauth_token=${SECRET} is not valid`, ['is not valid']],
  'a Meta token on its own': [`The token ${META} has expired`, ['The token', 'has expired']],
  'a password with a colon': [`password: ${SECRET} was rejected for the user`, ['was rejected for the user']],
  'a hyphenated name with a colon': [`developer-token: ${SECRET}, check the app`, [', check the app']],
  'a name the pair rule only had with a delimiter': [
    `consumer_secret=${SECRET} and apikey=${SECRET}2 refused`,
    ['refused'],
  ],
  'a client secret and a cookie in prose': [`client-secret=${SECRET} cookie=${SECRET}2 expired`, ['expired']],
  'Proxy-Authorization': [`Proxy-Authorization: Basic ${SECRET}`, ['Proxy-Authorization:']],
  'Set-Cookie with attributes': [`Set-Cookie: session=${SECRET}; Path=/; HttpOnly`, ['Set-Cookie:']],
  'a lower-case header in a sentence': [
    `The proxy sent authorization: Token ${SECRET}`,
    ['The proxy sent authorization:'],
  ],
  'a header with no space after the colon': [`Cookie:sid=${SECRET}`, ['Cookie:']],
  'a header with a space before the colon': [`Cookie : sid=${SECRET}`, ['Cookie :']],
};

test('the review examples read the same on the card, in the MCP envelope and in the audit row, and hide the credential', async () => {
  for (const [label, [text, kept]] of Object.entries(hidden)) {
    const shown = await surfaces(text);
    for (const [surface, out] of Object.entries(shown)) {
      assert.ok(!out.includes('SYNTHETICVALUE'), `${label}: ${surface} shows the credential: ${out}`);
      assert.ok(out.includes('[REDACTED]'), `${label}: ${surface} hides nothing: ${out}`);
      for (const part of kept) assert.ok(out.includes(part), `${label}: ${surface} lost "${part}": ${out}`);
    }
    assert.deepEqual(shown, {card: shown.card, envelope: shown.card, audit: shown.card}, label + ' differs by surface');
    assert.equal(shown.card, redact(text), label + ': the card is not what redact() gives');
    assert.equal(redact(shown.card), shown.card, label + ' is not idempotent');
  }
});

test('the card keeps the text it has always shown for its own prose cases', () => {
  // The forms the card hid before: a name and its value become [REDACTED]; a bare token= keeps its name.
  const exact = {
    [`request failed access_token=${SECRET} please retry`]: 'request failed [REDACTED] please retry',
    [`password: ${SECRET} was rejected`]: '[REDACTED] was rejected',
    [`api_key=${SECRET}`]: '[REDACTED]',
    [`refused: token=${SECRET} for user`]: 'refused: token=[REDACTED] for user',
    [`bad signature=${SECRET}, retry`]: 'bad signature=[REDACTED], retry',
    [`oauth_token=${SECRET}`]: 'oauth_token=[REDACTED]',
    [`secret=${SECRET}&n=1`]: 'secret=[REDACTED]&n=1',
    [`Invalid token=${META} supplied`]: 'Invalid token=[REDACTED] supplied',
    [`The token ${META}`]: 'The token [REDACTED]',
  };
  for (const [text, expected] of Object.entries(exact)) {
    assert.equal(card(text), expected, text);
    assert.equal(redact(text), expected, text);
  }
});

test('header forms hide their value to the end of the line, and only that line', () => {
  const headers = [
    'Authorization',
    'authorization',
    'Proxy-Authorization',
    'Cookie',
    'COOKIE',
    'Set-Cookie',
    'set-cookie',
  ];
  for (const name of headers)
    for (const eol of ['\n', '\r\n']) {
      const text = `HTTP/1.1 401 Unauthorized${eol}${name}: Basic ${SECRET}; more ${SECRET}2${eol}X-Request-Id: req-1${eol}`;
      assert.equal(
        redact(text),
        `HTTP/1.1 401 Unauthorized${eol}${name}: [REDACTED]${eol}X-Request-Id: req-1${eol}`,
        JSON.stringify(name + eol),
      );
    }
  // The spacing the sender used is kept, and a value that is already hidden is left as it is.
  assert.equal(redact('Cookie:   a=b'), 'Cookie:   [REDACTED]');
  assert.equal(redact('Cookie:\ta=b'), 'Cookie:\t[REDACTED]');
  assert.equal(redact('Authorization: [REDACTED]'), 'Authorization: [REDACTED]');
  // In JSON and in objects the existing rules already hid the value; the header rule does not disturb them.
  assert.equal(redact('{"Authorization":"Basic x","n":1}'), '{"Authorization":"[REDACTED]","n":1}');
  assert.deepEqual(redact({headers: {Cookie: 'sid=1'}, notes: [`Cookie: sid=${SECRET}`]}), {
    headers: {Cookie: '[REDACTED]'},
    notes: ['Cookie: [REDACTED]'],
  });
});

test('ordinary prose is left alone, on every surface', async () => {
  for (const text of [
    'Unexpected token } in JSON at position 4',
    'the signature of the ad does not match the creative',
    'token expired',
    'Invalid signature',
    'The password is too short',
    'Missing authorization header',
    'Authorization header is required for this call',
    'Set the cookie policy before you continue',
    'sig is not a valid parameter name',
    'secret key not set',
    'Rate limit exceeded; retry in 3 s',
    'Campaign Summer sale is paused: budget reached',
    'Invalid value for key: budget',
    'status=active;mode=test',
    'see https://example.test/page?name=Summer&n=1#top',
    'EAA is a prefix and EAAshort is not a token',
    'a'.repeat(200),
  ]) {
    assert.equal(redact(text), text, text);
    const shown = await surfaces(text);
    assert.deepEqual(shown, {card: text, envelope: text, audit: text}, text);
  }
});

test('the card is redact(): the same text over generated provider messages, cut at its limit', () => {
  let seed = 20261112;
  const next = n => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return Math.floor(seed / 65536) % n;
  };
  const pieces = [
    ' ',
    ' ',
    ' ',
    '\n',
    '\r\n',
    ', ',
    '; ',
    'request failed ',
    'Platform said: ',
    'the signature of the ad ',
    'token expired ',
    'Unexpected token } ',
    'n=1&m=2 ',
    `access_token=${SECRET}`,
    `access-token: ${SECRET}`,
    `refresh_token=${SECRET}`,
    `client-secret=${SECRET}`,
    `consumer_secret=${SECRET}`,
    `token_secret: ${SECRET}`,
    `developer_token=${SECRET}`,
    `oauth_token=${SECRET}`,
    `oauth_token_secret=${SECRET}`,
    `api_key: ${SECRET}`,
    `apikey=${SECRET}`,
    `password=${SECRET}`,
    `password: ${SECRET}`,
    `token=${SECRET}`,
    `secret=${SECRET}`,
    `signature=${SECRET}`,
    `sig=${SECRET}`,
    `Authorization: Basic ${SECRET}`,
    `Proxy-Authorization: ${SECRET}`,
    `Cookie: a=${SECRET}; b=${SECRET}`,
    `Set-Cookie: a=${SECRET}`,
    META,
    `Bearer ${SECRET}`,
    `?token=${SECRET}&n=1`,
    `&secret=${SECRET}`,
    `#sig=${SECRET}`,
    `;signature=${SECRET}`,
    `https://objects.example/f?x=1&access_token=${SECRET}&n=2`,
    `{"api_key":"${SECRET}","n":1}`,
    'x'.repeat(300),
  ];
  for (let i = 0; i < 6000; i++) {
    const text = Array.from({length: 1 + next(9)}, () => pieces[next(pieces.length)]).join('');
    const expected = redact(text).slice(0, 1200);
    assert.equal(card(text), expected, JSON.stringify(text));
    assert.equal(redact(redact(text)), redact(text), 'idempotent: ' + JSON.stringify(text));
  }
});

// ---- The differential: what the head's redaction and the card hid, the redaction still hides ----
// The card as it was at bee1db0e: the head's redact(), then its three private rules.
const oldCard = value =>
  String(redactAtHead(String(value)))
    .replace(
      /\b(?:access[_-]?token|refresh[_-]?token|developer[_-]?token|client[_-]?secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi,
      '[REDACTED]',
    )
    .replace(/\b(oauth[_-]?token|token|secret|signature|sig)=[^\s,;&]+/gi, '$1=[REDACTED]')
    .replace(/\bEAA[A-Za-z0-9]{60,}\b/g, '[REDACTED]')
    .slice(0, 1200);

test('over 100,000 generated messages redact() never shows a credential the head or the card hid, and hides more', () => {
  let seed = 20261113,
    serial = 0;
  const next = n => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return Math.floor(seed / 65536) % n;
  };
  // Each secret piece carries its own markers, so a credential shown whatever the text around it is found.
  const secretPieces = [
    m => `access_token=${m()}`,
    m => `access-token=${m()}`,
    m => `access_token: ${m()}`,
    m => `refresh-token = ${m()}`,
    m => `client_secret=${m()}`,
    m => `client-secret: ${m()}`,
    m => `consumer_secret=${m()}`,
    m => `token_secret=${m()}`,
    m => `developer_token=${m()}`,
    m => `oauth_token=${m()}`,
    m => `oauth_token_secret=${m()}`,
    m => `api_key=${m()}`,
    m => `api-key: ${m()}`,
    m => `apikey=${m()}`,
    m => `password=${m()}`,
    m => `password: ${m()}`,
    m => `token=${m()}`,
    m => `secret=${m()}`,
    m => `signature=${m()}`,
    m => `sig=${m()}`,
    m => `x-amz-signature=${m()}`,
    m => `Authorization: Basic ${m()}`,
    m => `Authorization: Bearer ${m()}`,
    m => `Proxy-Authorization: ${m()} ${m()}`,
    m => `Cookie: sid=${m()}; token=${m()}`,
    m => `Set-Cookie: s=${m()}; Path=/`,
    m => `EAA${m()}${'x'.repeat(60)}`,
    m => `EAA${m()}${'y'.repeat(70)}_tail`,
    m => `Bearer ${m()}`,
    m => `?token=${m()}&n=1`,
    m => `&secret=${m()}`,
    m => `#sig=${m()}`,
    m => `;signature=${m()}`,
    m => `?next=https://b.example/q?access_token=${m()}&z=1`,
    m => `https://objects.example/f?x=1&access_token=${m()}&n=2`,
    m => `{"api_key":"${m()}","n":1}`,
    m => `{"authorization":"${m()}"}`,
  ];
  const plain = [
    ' ',
    ' ',
    ' ',
    '\n',
    '\r\n',
    ', ',
    '; ',
    'request failed ',
    'Platform said: ',
    'the signature of the ad ',
    'token expired ',
    'Unexpected token } ',
    'n=1&m=2 ',
    'key=value ',
    'a:b ',
  ];
  // Pieces are told apart by white space or a comma or semicolon, as the words of a message are. A credential glued to the
  // end of another word (`n=2EAA...`, `z=1token_secret=...`) is not a token anyone reads, and the card hid such text only
  // because its sentence rule ran on to the next white space.
  const separators = [' ', ' ', '\n', '\r\n', ', ', '; '];
  let regressions = [],
    gainedOnHead = 0,
    gainedOnCard = 0,
    checked = 0;
  for (let i = 0; i < 100000; i++) {
    const markers = [],
      mark = () => {
        const marker = 'Q' + ++serial + 'Q';
        markers.push(marker);
        return marker;
      };
    const text = Array.from({length: 1 + next(5)}, () =>
      next(3) ? plain[next(plain.length)] + secretPieces[next(secretPieces.length)](mark) : plain[next(plain.length)],
    ).reduce((all, piece) => all + separators[next(separators.length)] + piece);
    const now = redact(text),
      was = redactAtHead(text),
      wasOnCard = oldCard(text);
    for (const marker of markers) {
      checked++;
      if (now.includes(marker) && (!was.includes(marker) || !wasOnCard.includes(marker)))
        regressions.push({text, now, was, wasOnCard, marker});
      if (was.includes(marker) && !now.includes(marker)) gainedOnHead++;
      if (wasOnCard.includes(marker) && !now.includes(marker)) gainedOnCard++;
    }
    if (i % 3 === 0) assert.equal(redact(now), now, 'idempotent: ' + JSON.stringify(text));
  }
  assert.deepEqual(regressions.slice(0, 3), [], 'credentials shown that the head or the card hid');
  // The sample is fixed (seeded): it holds about 210,000 credentials, and redact() hides about 156,000 more than the head's
  // redaction and 48,000 more than the card did.
  assert.ok(checked > 150000, 'only ' + checked + ' credentials were checked');
  assert.ok(gainedOnHead > 100000, 'redact() hid only ' + gainedOnHead + ' more credentials than the head');
  assert.ok(gainedOnCard > 30000, 'redact() hid only ' + gainedOnCard + ' more credentials than the card did');
});

test('the new rules keep redaction linear on hostile text', () => {
  for (const hostile of [
    'Cookie:'.repeat(100000),
    'Cookie: '.repeat(50000),
    'Set-Cookie:'.repeat(60000),
    'proxy-authorization:'.repeat(30000),
    'Authorization:' + ' '.repeat(300000),
    ('authorization' + ' '.repeat(40)).repeat(5000),
    ('Cookie:' + ' '.repeat(400) + '\n').repeat(2000),
    'EAA'.repeat(100000),
    'EAA' + 'a'.repeat(300000) + '_',
    ('EAA' + 'b'.repeat(59) + '_').repeat(8000),
    'password' + ' '.repeat(300000),
    'password:' + ' '.repeat(300000) + ',',
    ('password:' + ' '.repeat(100)).repeat(3000),
    'api_key '.repeat(80000),
    'token='.repeat(100000),
    'secret :'.repeat(80000),
    'oauth_token_secret'.repeat(20000),
    ('access-' + 'token').repeat(30000) + '=',
    'x-token='.repeat(60000),
  ]) {
    const started = performance.now();
    redact(hostile);
    card(hostile);
    assert.ok(
      performance.now() - started < 3000,
      'took ' + (performance.now() - started) + ' ms on ' + hostile.slice(0, 24),
    );
  }
});
