import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {redact} from '../dist/src/security.js';
import {reportSourceError} from '../dist/src/report-errors.js';
import {NativeTransport} from '../dist/src/transport.js';
import {Store} from '../dist/src/store.js';
import {redactAtHead} from './helpers/redaction-at-head.mjs';
import {redactAt6c80be71} from './helpers/redaction-at-6c80be71.mjs';

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
  'id_token and oauth_signature (Ruling 10 B)': [
    `id_token=${SECRET} and oauth_signature: ${SECRET}2 failed`,
    ['and', 'failed'],
  ],
  'Proxy-Authorization': [`Proxy-Authorization: Basic ${SECRET}`, ['Proxy-Authorization:']],
  'Set-Cookie with attributes': [`Set-Cookie: session=${SECRET}; Path=/; HttpOnly`, ['Set-Cookie:']],
  'a lower-case header in a sentence': [
    `The proxy sent authorization: Token ${SECRET}`,
    ['The proxy sent authorization:'],
  ],
  'a header with no space after the colon': [`Cookie:sid=${SECRET}`, ['Cookie:']],
  'a header with a space before the colon': [`Cookie : sid=${SECRET}`, ['Cookie :']],
  // P2C-01: bee1db0e hid both, and the header rule of DR2-02 showed them again.
  'a Bearer token folded onto the next line of a header (P2C-01)': [
    `Authorization: Bearer\n${SECRET}`,
    ['Authorization:'],
  ],
  'a JSON secret whose value holds a header word (P2C-01)': [
    `{"cookie":"sid=${SECRET}; Authorization: x","n":1}`,
    ['{"cookie":"', '"n":1}'],
  ],
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

// ---- P2A-01 (differential review, wave 5 round 2 part 2a): a credential name glued to `?`, `&`, `#` or `;` ----
// DR2-02 deleted the card's own rule (`\b(?:13 names)\s*[=:]\s*value`) and relied on redact(). The pair pass reads `name=value`
// with no white space, and the sentence rule left every `=` form after those four delimiters to the pair pass, so
// `&access_token = x` showed its value: 288 of the 3,003 shapes the review enumerated. The old card hid every one.
const oldCardNames = [
  'access_token',
  'access-token',
  'accesstoken',
  'refresh_token',
  'refresh-token',
  'developer_token',
  'developer-token',
  'client_secret',
  'client-secret',
  'password',
  'api_key',
  'api-key',
  'apikey',
];
const delimiters = ['?', '&', '#', ';'];
// The six spacings of `=`: a space before, after, both, and a tab before, a tab after, a line break after.
const spacings = [' =', '= ', ' = ', '\t=', '=\t', '=\n'];
// The sixth puts the value on the next line. A header earlier on the same line hides to the end of its line, the credential
// name that ends it included, and leaves such a value readable: the one class the differential below shows against the old
// card (166 of 222,169 credentials when `=\n` pieces follow a header on their line; stated in the sec-followup report).
// So the differential draws the first five on the line of the text before them, and the sixth only at the start of a line.
const sameLine = spacings.slice(0, 5);
const prefixes = ['', 'bad query', 'Invalid request: '];

test('a credential name glued to ?, &, # or ; with white space around the = is hidden, as the card hid it before DR2-02 (P2A-01)', async () => {
  let shapes = 0;
  for (const prefix of prefixes)
    for (const name of oldCardNames)
      for (const lead of delimiters)
        for (const spacing of spacings) {
          const text = `${prefix}${lead}${name}${spacing}${SECRET} rejected`;
          shapes++;
          const out = redact(text);
          assert.ok(!out.includes('SYNTHETICVALUE'), `${JSON.stringify(text)} shows the credential: ${out}`);
          assert.ok(
            out.startsWith(prefix) && out.endsWith(' rejected'),
            `${JSON.stringify(text)} lost its text: ${out}`,
          );
          // The text the card showed before DR2-02, shape for shape.
          assert.equal(out, oldCard(text), JSON.stringify(text));
          assert.equal(card(text), out, JSON.stringify(text));
          assert.equal(redact(out), out, 'idempotent: ' + JSON.stringify(text));
          // The envelope and the audit row never hid these shapes either: every surface, for one prefix.
          if (prefix === 'Invalid request: ') {
            const shown = await surfaces(text);
            assert.deepEqual(shown, {card: out, envelope: out, audit: out}, JSON.stringify(text));
          }
        }
  assert.equal(shapes, 13 * 4 * 6 * 3);
});

test('the review’s examples of a glued credential read as the old card read them (P2A-01)', () => {
  const exact = {
    'Invalid request: &access_token = EAAB123abc rejected': 'Invalid request: &[REDACTED] rejected',
    'Error at https://api.example/v1?password = hunter2&x=1': 'Error at https://api.example/v1?[REDACTED]',
    'bad query;client_secret = s3cr3t;next': 'bad query;[REDACTED];next',
    'bad query #refresh-token= abc123 end': 'bad query #[REDACTED] end',
    // Not glued to a delimiter: hidden before and after (the shape that made the gap invisible to the first tests).
    'Invalid request: access_token = abc123 rejected': 'Invalid request: [REDACTED] rejected',
    'Invalid OAuth access token. access_token = abc123': 'Invalid OAuth access token. [REDACTED]',
  };
  for (const [text, expected] of Object.entries(exact)) {
    assert.equal(card(text), expected, text);
    assert.equal(redact(text), expected, text);
    assert.equal(oldCard(text), expected, 'the old card, to the character: ' + text);
  }
  // The one shape that tests/error-detail-redaction.test.mjs ("pair for pair") used to leave alone and no longer draws: a
  // credential name, `=`, white space. It reads as a spaced pair whose value is the next token, as the card read it, so the
  // next token is hidden (the empty-valued pair of the pair pass has no white space after its `=`).
  for (const [text, expected] of Object.entries({
    'end &client_secret= &a=1 x': 'end &[REDACTED] x',
    'end &access_token= end &a=1': 'end &[REDACTED] &a=1',
    'end ?password =\t&a=1&b=2 x': 'end ?[REDACTED] x',
    // No white space after the `=`: the pair pass's own head, an empty value, and the next pair kept (DR2-02's guard).
    'end &client_secret=&a=1 x': 'end &client_secret=&a=1 x',
    'end ?OAUTH_TOKEN=&b=': 'end ?OAUTH_TOKEN=&b=',
  })) {
    assert.equal(redact(text), expected, text);
    if (text.includes('= ') || text.includes(' =')) assert.equal(oldCard(text), expected, 'the old card: ' + text);
  }
  // The names the card never knew are hidden in the same shapes (the one list of DR2-01), and a name that only ends in one
  // of them, or an ordinary word after the delimiter, is not a credential.
  assert.equal(redact('bad &cookie = oatmeal now'), 'bad &[REDACTED] now');
  assert.equal(redact('bad ;id_token= abc now'), 'bad ;[REDACTED] now');
  for (const text of [
    'see &passwords = none',
    'see ?name = Summer sale',
    'see #topic = reset funnel',
    'a;b = c',
    'x&y = z',
    'Q&A password policy = strict',
  ])
    assert.equal(redact(text), text, text);
});

// ---- P2B-01 (differential review, wave 5 round 2 part 2b): two credentials joined by punctuation ----
// The alternative P2A-01 added took the value of `name = value` after `?`, `&`, `#` or `;` to the next white space, comma or
// semicolon. When a second credential followed it glued by other punctuation (`#password =  |id_token = SECRET#`), the run
// swallowed the second credential's name, so its value was shown, where 6c80be71 hid it through its own rule. The oracle is
// redact() of 6c80be71, frozen: a credential it hid stays hidden.
const joinNames = [
  'access_token',
  'refresh-token',
  'client_secret',
  'password',
  'api_key',
  'secret',
  'cookie',
  'id_token',
  'oauth_token',
];
// Every punctuation character of ASCII, the empty join and a letter. A comma, a semicolon and white space end the first
// value by themselves; they are listed so that the table says so.
const joins = [...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~', '', 'x'];
// The eight forms of the second assignment: glued, spaced `=` three ways, and `:` four ways.
const secondForms = ['=', ' =', ' = ', '=  ', ':', ': ', ' :', ' : '];
const SECOND = 'SECOND0123';

test('a second credential joined to a spaced first assignment by punctuation stays hidden, as at 6c80be71 (P2B-01)', () => {
  let shapes = 0,
    hiddenAtBase = 0;
  const lost = [],
    notIdempotent = [];
  for (const first of joinNames)
    for (const lead of delimiters)
      for (const spacing of spacings)
        for (const join of joins)
          for (const second of joinNames)
            for (const form of secondForms) {
              const text = `${lead}${first}${spacing}a${join}${second}${form}${SECOND} tail`;
              shapes++;
              const out = redact(text);
              if (!redactAt6c80be71(text).includes(SECOND)) {
                hiddenAtBase++;
                if (out.includes(SECOND)) lost.push({text, out, base: redactAt6c80be71(text)});
              }
              if (redact(out) !== out) notIdempotent.push({text, out, again: redact(out)});
            }
  assert.equal(shapes, 9 * 4 * 6 * joins.length * 9 * 8);
  // Most of the shapes are hidden at 6c80be71 (the second credential has its own rule): the guard against a table that
  // stopped drawing the class.
  assert.ok(hiddenAtBase > 200000, 'only ' + hiddenAtBase + ' shapes were hidden at 6c80be71');
  assert.deepEqual(lost.slice(0, 3), [], lost.length + ' shapes show a credential that 6c80be71 hid');
  assert.deepEqual(notIdempotent.slice(0, 3), [], notIdempotent.length + ' shapes are not idempotent');
});

test('the review’s examples of two joined credentials hide both values, and ordinary text stays (P2B-01)', () => {
  // The first value is empty or short and the second credential follows it by punctuation; 6c80be71 hid the second one.
  for (const [text, shown] of Object.entries({
    '#password =  |id_token = SECRETVALUEddqj#': '#[REDACTED][REDACTED]',
    // An empty first value: the credential head that follows it is hidden by its own rule, and the first head with it, so
    // that a second pass finds nothing to hide that the first one left.
    '?consumer_secret = ?client_secret: SECRETVALUE8fr0': '?[REDACTED]?[REDACTED]',
    '?access_token =a<access_token = SECOND0123 tail': '?[REDACTED][REDACTED] tail',
    'Invalid request: &access_token = abc|password = hunter2': 'Invalid request: &[REDACTED][REDACTED]',
    'bad;password = x/api_key: SECOND0123': 'bad;[REDACTED][REDACTED]',
  })) {
    const out = redact(text);
    assert.ok(
      !out.includes('SECRETVALUE') && !out.includes('SECOND0123') && !out.includes('hunter2'),
      `${text} -> ${out}`,
    );
    assert.equal(out, shown, text);
    assert.equal(redact(out), out, 'idempotent: ' + text);
    assert.equal(card(text), out, 'the card: ' + text);
  }
  // A first value that ends at white space, a comma or a semicolon is unchanged; so is text that names no credential.
  assert.equal(redact('see &passwords = none|ids = 4'), 'see &passwords = none|ids = 4');
  assert.equal(redact('see #topic = a|password policy = strict'), 'see #topic = a|password policy = strict');
  assert.equal(
    redact('Invalid request: &access_token = abc, password = hunter2'),
    'Invalid request: &[REDACTED], [REDACTED]',
  );
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

// ---- P2C-01 (differential review, wave 5 round 2 part 2c): the header rule ran first and took the end of the line ----
// DR2-02 added the header rule and put it before the Bearer and the JSON rules. It hides a value to the end of its line, so a Bearer token
// folded onto the next line (`Authorization: Bearer`, then the token) was shown, and a JSON secret whose value holds a header word was shown
// up to that word: the rule took the closing quote, and the JSON rule then found no string to close. bee1db0e had only the Bearer and the
// JSON rules, and hid both. The oracle is redact() of bee1db0e, frozen (`redactAtHead`): a credential it hid stays hidden; the credentials
// that 6c80be71 hid by the sweep (`Cookie: {"password":"x"}`, a header line with its own value) are checked beside it.
const NBSP = String.fromCharCode(0xa0);
const headerWords = [
  'Authorization',
  'authorization',
  'Proxy-Authorization',
  'Cookie',
  'COOKIE',
  'Set-Cookie',
  'set-cookie',
];
// What can stand between `Bearer` and its token, after the white space of the line: every kind of line break, the obsolete fold (a break
// and an indent), blank lines, and white space before the break.
const breaks = ['\n', '\r\n', '\r', '\r\n ', '\r\n\t', '\n\n', '\n  ', ' \n', '\t\r\n', NBSP + '\n'];
const jsonKeys = [
  'api_key',
  'cookie',
  'password',
  'authorization',
  'set-cookie',
  'access_token',
  'secret',
  'client-secret',
];

test('a Bearer token folded onto the next line of a header is hidden, after every header word and every break, as at bee1db0e (P2C-01)', () => {
  let shapes = 0;
  for (const name of headerWords)
    for (const gap of [': ', ':', ' : ', ':\t'])
      for (const before of ['', 'x ', 'Basic ', 'a=b; '])
        for (const trail of ['', ' ', '\t', NBSP])
          for (const brk of breaks) {
            const text = `HTTP/1.1 401${brk}${name}${gap}${before}Bearer${trail}${brk}${SECRET} tail`;
            shapes++;
            const out = redact(text);
            // The guard against a table that stopped drawing the class: bee1db0e hid every one of these tokens.
            assert.ok(!redactAtHead(text).includes(SECRET), `bee1db0e shows ${JSON.stringify(text)}`);
            assert.ok(!out.includes('SYNTHETICVALUE'), `${JSON.stringify(text)} shows the token: ${out}`);
            assert.ok(
              out.includes(`${name}${gap}[REDACTED]`) && out.endsWith(' tail'),
              `${JSON.stringify(text)} lost its text: ${out}`,
            );
            assert.equal(redact(out), out, 'idempotent: ' + JSON.stringify(text));
          }
  assert.equal(shapes, 7 * 4 * 4 * 4 * breaks.length);
});

test('a folded Bearer token reads the same on the card, in the MCP envelope and in the audit row, line breaks kept (P2C-01)', async () => {
  for (const [text, shown] of Object.entries({
    // The review's three shapes, then the two header words the review named.
    [`Authorization: Bearer\n${SECRET}`]: 'Authorization: [REDACTED]\n[REDACTED]',
    [`Authorization: Bearer\r\n ${SECRET}`]: 'Authorization: [REDACTED]\r\n [REDACTED]',
    [`Cookie: Bearer \n${SECRET}`]: 'Cookie: [REDACTED]\n[REDACTED]',
    [`Proxy-Authorization: Bearer\n\n  ${SECRET} and the rest\nNext line`]:
      'Proxy-Authorization: [REDACTED]\n\n  [REDACTED] and the rest\nNext line',
    [`Set-Cookie: sid=1; Path=/; Bearer\t\r\n\t${SECRET}; HttpOnly`]:
      'Set-Cookie: [REDACTED]\r\n\t[REDACTED]; HttpOnly',
    // A chain of Bearer words hides the last token, as bee1db0e's pairing of the words did.
    [`Cookie:Bearer\nBearer Bearer \n${SECRET}`]: 'Cookie:[REDACTED]\n[REDACTED]',
    [`Authorization: Bearer\nBearer ${SECRET}`]: 'Authorization: [REDACTED]\n[REDACTED]',
    // The token may hold a name or a header word after a dot or a dash, and it is hidden to its end.
    [`Authorization: Bearer\n${SECRET}.password.sig`]: 'Authorization: [REDACTED]\n[REDACTED]',
  })) {
    const shownOn = await surfaces(text);
    assert.deepEqual(shownOn, {card: shown, envelope: shown, audit: shown}, JSON.stringify(text));
    assert.equal(redact(text), shown, JSON.stringify(text));
    assert.equal(redact(shown), shown, 'idempotent: ' + JSON.stringify(text));
  }
  // What the next line holds that a Bearer token cannot be: the next header, a credential and its separator, a JSON string, or nothing.
  // The rules after this one read those, as before.
  for (const [text, shown] of Object.entries({
    [`Authorization: Bearer\nCookie: sid=${SECRET}`]: 'Authorization: [REDACTED]\nCookie: [REDACTED]',
    [`Authorization: Bearer\nsecret = ${SECRET}`]: 'Authorization: [REDACTED]\n[REDACTED]',
    [`Authorization: Bearer\nabc-Cookie: ${SECRET}`]: 'Authorization: [REDACTED]\n[REDACTED]Cookie: [REDACTED]',
    // The bare names (`token=`, `signature=`, `sig=`) hide the value that follows them, whatever it starts with.
    [`Authorization: Bearer\ntoken="${SECRET}"`]: 'Authorization: [REDACTED]\ntoken=[REDACTED]',
    [`Cookie: a=b Bearer\nsig='${SECRET}'`]: 'Cookie: [REDACTED]\nsig=[REDACTED]',
    [`Authorization: Bearer\nsignature=(${SECRET})`]: 'Authorization: [REDACTED]\nsignature=[REDACTED]',
    [`Authorization: Bearer\n{"password":"${SECRET}"}`]: 'Authorization: [REDACTED]\n{"password":"[REDACTED]"}',
    'Authorization: Bearer\n': 'Authorization: [REDACTED]\n',
    'Authorization: Bearer': 'Authorization: [REDACTED]',
  })) {
    assert.equal(redact(text), shown, JSON.stringify(text));
    assert.equal(redact(shown), shown, 'idempotent: ' + JSON.stringify(text));
    assert.ok(!redact(text).includes('SYNTHETICVALUE'), JSON.stringify(text));
  }
  // A Bearer token that is not at the end of a header's line is the Bearer rule's, as before.
  assert.equal(redact(`GET /x\nBearer\n${SECRET}\nHost: h`), 'GET /x\nBearer [REDACTED]\nHost: h');
});

// The review's three JSON shapes, each with every JSON key, every header word and both orders: a header word inside the string of a
// secret (the string ends after it, or it holds a value), a header word before the JSON, and a key split from its string by a line.
const jsonShapes = {
  'a header word and its value inside the string': [
    (key, word) => `{"${key}":"sid=${SECRET}; ${word}: x","n":1}`,
    key => `{"${key}":"[REDACTED]","n":1}`,
  ],
  'a header word that ends the string, with no value': [
    (key, word) => `{"${key}":"${SECRET}'${word}: ","x":1}`,
    key => `{"${key}":"[REDACTED]","x":1}`,
  ],
  'a header word with a spaced colon and a value of two parts': [
    (key, word) => `{"${key}" : "${SECRET} ${word} : a=b; c","n":1}`,
    key => `{"${key}" : "[REDACTED]","n":1}`,
  ],
  'a header word and a Bearer value inside the string': [
    (key, word) => `{"${key}":"${word}: Bearer ${SECRET}"}`,
    key => `{"${key}":"[REDACTED]"}`,
  ],
  'a key split from its string by a line, a header word inside the string': [
    (key, word) => `{"${key}":\n"${SECRET} ${word}: x"}`,
    key => `{"${key}":\n"[REDACTED]"}`,
  ],
  'a header word before the JSON (the sweep hid it already)': [
    (key, word) => `${word}: {"${key}":"${SECRET}"}`,
    (key, word) => `${word}: [REDACTED]`,
  ],
  'a header word before a key split from its string by a line': [
    (key, word) => `${word}: {"${key}":\n"${SECRET}"}`,
    (key, word) => `${word}: [REDACTED]\n"[REDACTED]"}`,
  ],
};

test('a JSON secret whose value holds a header word, and one split from its string after a header word, is hidden, as at bee1db0e (P2C-01)', async () => {
  let shapes = 0;
  for (const [label, [make, expected]] of Object.entries(jsonShapes))
    for (const key of jsonKeys)
      for (const word of headerWords) {
        const text = make(key, word);
        const out = redact(text);
        shapes++;
        assert.ok(!redactAtHead(text).includes(SECRET), `${label}: bee1db0e shows ${JSON.stringify(text)}`);
        assert.ok(!out.includes('SYNTHETICVALUE'), `${label}: ${JSON.stringify(text)} shows the credential: ${out}`);
        assert.equal(out, expected(key, word), `${label}: ${JSON.stringify(text)}`);
        assert.equal(redact(out), out, 'idempotent: ' + JSON.stringify(text));
      }
  assert.equal(shapes, Object.keys(jsonShapes).length * jsonKeys.length * headerWords.length);
  // The review's three: the card, the envelope and the audit row read the same.
  for (const text of [
    `{"api_key":"${SECRET}'Cookie: ","x":1}`,
    `{"cookie":"sid=${SECRET}; Authorization: x"}`,
    `Cookie: {"password":\n"${SECRET}"}`,
  ]) {
    const out = redact(text);
    assert.deepEqual(await surfaces(text), {card: out, envelope: out, audit: out}, JSON.stringify(text));
  }
  // A header word in a string that is not a secret's starts the sweep to the end of its line, as it did: the rule cannot tell that the
  // line is JSON. The secret after it is hidden all the same.
  assert.equal(
    redact(`{"note":"call Cookie: x later","api_key":"${SECRET}; Authorization: y","n":1}`),
    '{"note":"call Cookie: [REDACTED]',
    'a header word in an ordinary string still hides to the end of its line, as before',
  );
});

test('a rule that removes a key leaves its string beside a quote that can begin another key: one redact() hides it all, and a second changes nothing (P2C-01)', () => {
  // A string that holds a quote of its own (the JSON is not valid): the JSON rule takes the quote that starts the next key as the
  // end of the string. A rule after it (the header rule, the sentence rule) removes the key of that string and leaves the string
  // beside a quote that can now start a key, which a second redact() hid: the JSON rule runs last as well. The last case is a
  // backslash before a line break, which the JSON rule cannot read as an escape, and which a later rule took away.
  const ideographic = String.fromCharCode(0x3000);
  for (const text of [
    `Authorization: \r{"cookie":\r"sid=${SECRET}; Authorization: x{"cookie":""}`,
    `Cookie:\t${ideographic} {"password":\n"${SECRET}{"cookie":""}`,
    `-{"api_key":"${SECRET} Cookie:\nook\\\rie:  ","x":1}`,
    `Cookie: {"password":\n"${SECRET}{"cookie":"y"}`,
  ]) {
    const once = redact(text);
    assert.ok(!once.includes('SYNTHETICVALUE'), `${JSON.stringify(text)} shows the credential: ${once}`);
    assert.equal(redact(once), once, 'idempotent: ' + JSON.stringify(text));
  }
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

test('over 100,000 generated messages redact() never shows a credential the head, the card or 6c80be71 hid, and hides more', () => {
  let seed = 20261113,
    serial = 0;
  const next = n => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return Math.floor(seed / 65536) % n;
  };
  // A JSON piece that holds a header word in a secret's string says so: 6c80be71's header rule, started by that word, took the closing
  // quote and the rest of the line (and the JSON rule, with the quote gone, ran its string on to the next quote, over the lines that
  // follow), so it hid text no rule of its own reads, the other pieces of the message. The JSON rule now reads the string whole, as
  // bee1db0e's did, and leaves the text after it to the rules that read it. Such a text is held to bee1db0e and the old card, which
  // are the oracles of this change, and not to 6c80be71; every other text is held to all three, and the 400,000 bodies of Ruling 16
  // below hold 6c80be71 for every shape of their generator.
  let sweptByAccident = false;
  const headerInJson = text => ((sweptByAccident = true), text);
  // Each secret piece carries its own markers, so a credential shown whatever the text around it is found.
  const firstValues = ['', 'a', 'bc'];
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
    // P2A-01: a name glued to `?`, `&`, `#` or `;` with white space around the `=` (the lead, the name of the old card and
    // the spacing drawn at random), the same glued to the end of a word, and two credentials in one query (a value ends at
    // the `&` after it). The first version of this test joined its pieces by white space and drew `=` spaced only for
    // `refresh-token`, so it never met a glued lead with a spaced `=`.
    m => `${delimiters[next(4)]}${oldCardNames[next(13)]}${sameLine[next(5)]}${m()}`,
    m => `${delimiters[next(4)]}${oldCardNames[next(13)]}${sameLine[next(5)]}${m()}`,
    m => `bad query${delimiters[next(4)]}${oldCardNames[next(13)]}${sameLine[next(5)]}${m()}`,
    m =>
      `https://api.example/v1?x=1&${oldCardNames[next(13)]}${sameLine[next(5)]}${m()}&${oldCardNames[next(13)]}${sameLine[next(5)]}${m()}`,
    m => `?${oldCardNames[next(13)]}=${m()}&${oldCardNames[next(13)]}${sameLine[next(5)]}${m()}&n=1`,
    m => `#${oldCardNames[next(13)]}${sameLine[next(5)]}${m()}&password${sameLine[next(5)]}${m()}`,
    m => `\n${delimiters[next(4)]}${oldCardNames[next(13)]}=\n${m()}`,
    // P2B-01: two credentials in one run, joined by punctuation (any ASCII punctuation character, nothing, a letter): a
    // spaced first assignment after `?`, `&`, `#` or `;` with an empty, short or secret value, then a second credential of
    // the whole name list, glued or spaced in any of the eight forms. The first version of the fix of P2A-01 ran the first
    // value over the next credential's name; the pieces above join their credentials by white space or by `&` only, so no
    // draw reached it, and no oracle held what 6c80be71 hid. (Chains of three or four are drawn by the generator of Ruling 16
    // below, against 6c80be71 only: against the old card they meet the residual of the pair pass, stated in the reports.)
    m =>
      `${delimiters[next(4)]}${oldCardNames[next(13)]}${sameLine[next(5)]}${firstValues[next(3)]}${joins[next(joins.length)]}${joinNames[next(9)]}${secondForms[next(8)]}${m()}`,
    m =>
      `${delimiters[next(4)]}${oldCardNames[next(13)]}${sameLine[next(5)]}${firstValues[next(3)]}${joins[next(joins.length)]}${joinNames[next(9)]}${secondForms[next(8)]}${m()}`,
    m =>
      `${delimiters[next(4)]}${oldCardNames[next(13)]}${sameLine[next(5)]}${m()}${joins[next(joins.length)]}${joinNames[next(9)]}${secondForms[next(8)]}${m()}`,
    // P2C-01: a line break (of any kind, with an indent, with white space before it) inside a header value, between `Bearer` and its
    // token; a JSON secret whose value holds a header word (with a value or without, a Bearer value, a key split from its string by a
    // line); a header word before the JSON. Every draw before this one put `Bearer` and its token on one line and no header word in a
    // JSON string, so none reached the end-of-line of the header rule and its closing quote; bee1db0e hid all of these.
    m =>
      `${headerWords[next(7)]}${[': ', ':', ' : '][next(3)]}Bearer${['', ' ', '\t'][next(3)]}${breaks[next(breaks.length)]}${m()}`,
    m => `${headerWords[next(7)]}: ${['a=b', 'x', 'Basic y'][next(3)]} Bearer${breaks[next(breaks.length)]}${m()}`,
    m =>
      headerInJson(
        `{"${jsonKeys[next(8)]}":"${m()}; ${headerWords[next(7)]}: ${['x', '', 'a=b', 'Bearer y'][next(4)]}"${['}', ',"n":1}'][next(2)]}\n`,
      ),
    m => headerInJson(`{"${jsonKeys[next(8)]}":"${m()}'${headerWords[next(7)]}: "}\n`),
    m => `${headerWords[next(7)]}: {"${jsonKeys[next(8)]}":${breaks[next(breaks.length)]}"${m()}"}`,
    m => headerInJson(`{"${jsonKeys[next(8)]}":${breaks[next(breaks.length)]}"${m()} ${headerWords[next(7)]}: x"}\n`),
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
    sweptByAccident = false;
    const text = Array.from({length: 1 + next(5)}, () =>
      next(3) ? plain[next(plain.length)] + secretPieces[next(secretPieces.length)](mark) : plain[next(plain.length)],
    ).reduce((all, piece) => all + separators[next(separators.length)] + piece);
    const now = redact(text),
      was = redactAtHead(text),
      wasOnCard = oldCard(text),
      wasAtBase = redactAt6c80be71(text);
    for (const marker of markers) {
      checked++;
      if (
        now.includes(marker) &&
        (!was.includes(marker) || !wasOnCard.includes(marker) || (!sweptByAccident && !wasAtBase.includes(marker)))
      )
        regressions.push({text, now, was, wasOnCard, wasAtBase, marker});
      if (was.includes(marker) && !now.includes(marker)) gainedOnHead++;
      if (wasOnCard.includes(marker) && !now.includes(marker)) gainedOnCard++;
    }
    // Every text, not every third (P2B-01): the first version of the fix redacted twice differently in a rare shape.
    assert.equal(redact(now), now, 'idempotent: ' + JSON.stringify(text));
  }
  assert.deepEqual(
    regressions.slice(0, 3),
    [],
    regressions.length + ' credentials shown that the head or the card hid',
  );
  // The sample is fixed (seeded): it holds about 223,000 credentials, and redact() hides about 167,000 more than the head's
  // redaction and 46,000 more than the card did. Before P2A-01 was closed 24,401 of them were shown that the card hid (every
  // glued lead with a spaced `=`); the first version of this test, which drew no such shape, found none.
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
    // P2A-01: a name after a delimiter, then white space that never reaches an `=`.
    ('&access_token' + ' '.repeat(100)).repeat(3000),
    '&password' + ' '.repeat(300000),
    ('?client-secret' + ' '.repeat(40) + '=').repeat(5000),
    '?access-token ='.repeat(60000),
    ';api_key=\n'.repeat(60000),
    '&oauth_token_secret'.repeat(30000),
    // Ruling 16: a run that ends in a name, or in a name and its separator, then white space that never reaches a value, and a run
    // that chains through many heads.
    ('password:x-password' + ' '.repeat(100)).repeat(3000),
    'password:' + 'x-password'.repeat(30000),
    'password:x-password' + ' '.repeat(300000) + 'y',
    ('password:x-password:' + ' '.repeat(100)).repeat(3000),
    ('token_secret:x-api_key =' + 'y'.repeat(40) + ' ').repeat(5000),
    'password:'.repeat(60000),
    ('access-token:' + 'a,').repeat(60000),
    // P2C-01: a header that ends in Bearer, then a line break and a token, over and over; a chain of Bearer words; a long white space
    // between Bearer and what follows; a token made of header words, names and glued Bearer words; JSON strings that hold header words;
    // a key split from its string by a line after a header word.
    'Authorization: Bearer\n'.repeat(60000),
    'Cookie: Bearer\nTOKEN\n'.repeat(60000),
    'Authorization: Bearer\n' + 'Bearer '.repeat(30000),
    'Authorization: Bearer\n' + 'Bearer\n'.repeat(30000),
    'Authorization: Bearer' + ' '.repeat(300000) + '\n' + ' '.repeat(300000) + 'token',
    'Authorization: Bearer\n' + '\n'.repeat(300000) + 'token',
    ('Cookie: Bearer' + ' '.repeat(100) + '\n').repeat(2000),
    ('Cookie: Bearer' + NBSP.repeat(100) + '\n').repeat(2000),
    'Authorization: Bearer\n' + 'cookie'.repeat(40000),
    'Authorization: Bearer\n' + 'a.password'.repeat(30000),
    'Authorization: Bearer\n' + ('a.password' + ' '.repeat(100)).repeat(2000),
    'Authorization: Bearer\n' + 'xBearer'.repeat(40000),
    'Cookie: ' + 'x'.repeat(300000) + ' Bearer ' + 'y'.repeat(300000),
    '{"api_key":"a Cookie: b"}'.repeat(12000),
    '{"password":"'.repeat(25000),
    ('"password":' + '\n'.repeat(50)).repeat(5000),
    'Cookie: {"password":\n'.repeat(15000),
    '"'.repeat(300000),
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

// ---- Ruling 16 (6): a credential head that the run of the first branch ends in has its value hidden with it ----
// P2B-01 gave the spaced `name = value` after `?`, `&`, `#` or `;` a value that stops before the next credential head, and left the
// first branch (`name=` not after a delimiter, `name:` anywhere) with the run it has had since DR2-02: up to white space, a comma or a
// semicolon, which runs over the name of a credential glued to it by punctuation (`client-secret :X?/PASSWORD :Y`). The head was
// swallowed, and with it the third credential of a chain: Y was shown. 6c80be71 hid that third one only because its first credential
// swallowed the second one's head, so the two builds crossed over, and no oracle drew a chain of three. The bar is none: no body shows
// a credential that 6c80be71 hid. (Stopping the run before the next head, as the second branch does, was tried: it shows a credential
// 6c80be71 hid in 7 bodies of the generator below, because the run also hid the text glued after a head whose value the pair pass had
// already hidden.) The first branch keeps its run and hides the value of the head the run ends in.
const chains = {
  // The three bodies the review's card generator drew that showed a credential 6c80be71 hid (the first two with the names of the
  // old card, the third with the longer list). The value of each credential is told by its marker.
  'four credentials, the third glued to the fourth by `?"`': [
    ' api-key :CREDelgX87hc ?client-secret= CREDelhXkyfh&?a=b&refresh_token :CREDeliX35e2?"PASSWORD = CREDeljX52im#',
    ' [REDACTED] ?[REDACTED]&[REDACTED]',
    ['CREDelgX87hc', 'CREDelhXkyfh', 'CREDeliX35e2', 'CREDeljX52im'],
  ],
  'three credentials, the second glued to the third by `?/`': [
    '&client-secret =CRED31hdX58os&client-secret :CRED31heX8ap4?/PASSWORD :CRED31hfX33zq,',
    '&[REDACTED]&[REDACTED],',
    ['CRED31hdX58os', 'CRED31heX8ap4', 'CRED31hfX33zq'],
  ],
  'three credentials, the second glued to the third by `#&`': [
    '#client-secret= CRED3l5cX5x92&#client-secret :CRED3l5dXib75#&id_token: CRED3l5eXg1gy,',
    '#[REDACTED]#[REDACTED],',
    ['CRED3l5cX5x92', 'CRED3l5dXib75', 'CRED3l5eXg1gy'],
  ],
  // The short forms: a run that ends in a head, or is one, hides the value of that head with it.
  'a colon form followed at once by a spaced assignment': [
    'password: &id_token = SECRETVALUEa',
    '[REDACTED]',
    ['SECRETVALUEa'],
  ],
  'a colon form glued to a spaced assignment by a slash': [
    'password:/id_token = SECRETVALUEb',
    '[REDACTED]',
    ['SECRETVALUEb'],
  ],
  'a glued assignment whose run ends in a colon form': [
    'Invalid: api_key=x|client-secret: SECRETVALUEc ok',
    'Invalid: [REDACTED] ok',
    ['SECRETVALUEc'],
  ],
  'a run that ends in a name and a colon, the value after white space': [
    'token_secret: x-password:  SECRETVALUEd, next',
    '[REDACTED], next',
    ['SECRETVALUEd'],
  ],
};
test('a chain of credentials joined by punctuation hides every value, whichever form the middle one has (Ruling 16)', () => {
  for (const [label, [text, shown, secrets]] of Object.entries(chains)) {
    const out = redact(text);
    for (const secret of secrets) assert.ok(!out.includes(secret), `${label}: ${secret} is shown in ${out}`);
    assert.equal(out, shown, label);
    assert.equal(redact(out), out, 'idempotent: ' + label);
    assert.equal(card(text), out, 'the card: ' + label);
  }
  // Ordinary text that names no credential, and a value that ends at white space, are what they were.
  for (const text of [
    'status: ok|passwords = none',
    'see Q&A: password policy = strict',
    'Invalid request: password: hunter2, retry',
  ]) {
    const out = redact(text);
    if (text.includes('hunter2')) assert.equal(out, 'Invalid request: [REDACTED], retry');
    else assert.equal(out, text);
  }
});

// The review's card generator, copied: one to four parts, each a credential (a delimiter, a name, a separator and a value that has
// its own marker) or filler, joined by white space or punctuation. Seeded, so the same 200,000 bodies are drawn for each list.
function cardGenerator(names) {
  let seed = 0x51f3a9,
    serial = 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0), seed / 2 ** 32),
    pick = list => list[Math.floor(random() * list.length)];
  const leads = ['', ' ', '?', '&', '#', ';', ',', '"', "'", '(', '<', '\n', '\t', '|', '/', ': ', '?a=b&', 'x'],
    forms = ['=', ':', ' = ', ': ', ' =', ' :', '= ', ':', '=', '='],
    filler = ['request failed', 'Invalid', 'refused:', 'see', 'user said', 'https://h.example/p?q=1', 'next=1', ''],
    glue = [' ', ' ', '&', '?', '#', ';', ',', '\n'];
  return function* (count) {
    for (let i = 0; i < count; i++) {
      const secrets = [],
        parts = [];
      for (let n = 1 + Math.floor(random() * 4); n > 0; n--) {
        if (random() < 0.7) {
          const secret = 'CRED' + (serial++).toString(36) + 'X' + Math.floor(random() * 1e6).toString(36);
          secrets.push(secret);
          parts.push(pick(leads) + pick(names) + pick(forms) + secret);
        } else parts.push(pick(filler));
        parts.push(pick(glue));
      }
      yield {text: parts.join(''), secrets};
    }
  };
}
const cardListNames = [...oldCardNames, 'Access_Token', 'PASSWORD'];
const wideListNames = [
  ...cardListNames,
  'secret',
  'oauth_token',
  'token',
  'sig',
  'signature',
  'authorization_code',
  'consumer_secret',
  'token_secret',
  'oauth_token_secret',
  'cookie',
  'set-cookie',
  'id_token',
  'oauth_signature',
  'gtm_auth',
];

test('over 400,000 generated bodies of one to four credentials (700,000 credentials), redact() never shows a credential that 6c80be71 hid, and is idempotent (Ruling 16)', () => {
  for (const [label, names] of [
    ['the names of the old card', cardListNames],
    ['every name of redact()', wideListNames],
  ]) {
    const lost = [],
      notIdempotent = [];
    let checked = 0,
      shownThatTheCardHid = 0;
    for (const {text, secrets} of cardGenerator(names)(200000)) {
      const now = redact(text),
        base = redactAt6c80be71(text),
        card = oldCard(text);
      for (const secret of secrets) {
        checked++;
        if (now.includes(secret) && !base.includes(secret)) lost.push({text, now, base, secret});
      }
      if (secrets.some(secret => now.includes(secret) && !card.includes(secret))) shownThatTheCardHid++;
      if (redact(now) !== now) notIdempotent.push({text, now});
    }
    assert.ok(checked > 300000, label + ': only ' + checked + ' credentials were drawn');
    assert.deepEqual(lost.slice(0, 3), [], `${label}: ${lost.length} credentials are shown that 6c80be71 hid`);
    assert.deepEqual(notIdempotent.slice(0, 3), [], `${label}: ${notIdempotent.length} bodies are not idempotent`);
    // The residual of the pair pass, recorded: a credential after the value run of an earlier `name=value` (the pair pass reads it
    // to white space or `&`, `token=`, `secret=` and `sig=` to white space, a comma, a semicolon or `&`) is shown, as it is at
    // 6c80be71, where the old card, whose sentence rule read the whole text, hid it. 839 and 2,819 bodies before Ruling 16.
    // A ceiling: it may only fall.
    assert.ok(
      shownThatTheCardHid <= (names === cardListNames ? 716 : 641),
      `${label}: ${shownThatTheCardHid} bodies show a credential that the old card hid`,
    );
  }
});
