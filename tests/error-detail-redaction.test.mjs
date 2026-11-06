import test from 'node:test';
import assert from 'node:assert/strict';
import {MirrorError, errorResult, nestedError} from '../dist/src/errors.js';
import {redact, redactUrlSecrets} from '../dist/src/security.js';
import {reportSourceError} from '../dist/src/report-errors.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * F-L1-04 and the L9 note on the report error text filter: the upstream detail that reaches the website card, the
 * copied diagnostic and the MCP envelope is never a token or a signed URL. Synthetic values only.
 */
const SECRET = 'SYNTHETICVALUE0123456789';
const url = query => 'https://objects.example/file.bin?' + query;
// Forms the shared redaction must hide wherever they appear in a string, with the part of the text that must survive.
const delimited = {
  'X-Amz-Signature': [
    url(`X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=${SECRET}&X-Amz-Expires=60`),
    'X-Amz-Expires=60',
  ],
  'X-Amz-Security-Token': [url(`X-Amz-Security-Token=${SECRET}&X-Amz-Expires=60`), 'X-Amz-Expires=60'],
  'X-Amz-Credential': [url(`X-Amz-Credential=${SECRET}%2F20260101&n=1`), 'n=1'],
  'x-signature (TikTok CDN)': [url(`x-expires=1893456000&x-signature=${SECRET}`), 'x-expires=1893456000'],
  'X-Goog-Signature': [url(`X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=${SECRET}`), 'X-Goog-Algorithm'],
  'X-Goog-Credential': [url(`X-Goog-Credential=${SECRET}&n=1`), 'n=1'],
  'Policy and Key-Pair-Id': [url(`Policy=${SECRET}&Signature=${SECRET}&Key-Pair-Id=${SECRET}&n=1`), 'n=1'],
  'a semicolon-delimited query': [url(`x=1;signature=${SECRET};y=2`), 'x=1'],
  'a semicolon-delimited X-Amz-Signature': [url(`x=1;X-Amz-Signature=${SECRET}`), 'x=1'],
  'a percent-encoded underscore': [url(`access%5Ftoken=${SECRET}&n=1`), 'n=1'],
  'percent-encoded hyphens': [url(`X%2DAmz%2DSignature=${SECRET}&n=1`), 'n=1'],
  'lower-case percent escapes': [url(`refresh%5ftoken=${SECRET}&n=1`), 'n=1'],
  'a percent-encoded letter': [url(`%74oken=${SECRET}&n=1`), 'n=1'],
  'a fragment': [`https://objects.example/a#x-amz-signature=${SECRET}&state=1`, 'state=1'],
  'a JSON-quoted api_key': [`{"api_key":"${SECRET}","name":"Summer"}`, '"name":"Summer"'],
  'a JSON-quoted access_token with spaces': [`{"access_token" : "${SECRET}", "n": 1}`, '"n": 1'],
  'a JSON-quoted client_secret with an escape': [`{"client_secret":"${SECRET}\\"tail","n":1}`, '"n":1'],
};
// Forms only the report diagnostics' prose filter can recognise (no delimiter in front of the name).
const prose = {
  'a bare token': [`refused: token=${SECRET} for user`, 'for user'],
  'a bare signature': [`bad signature=${SECRET}, retry`, 'retry'],
};
const sentence = form => 'Platform returned HTTP 400 for ' + form + ' with the request';
const leaked = value => JSON.stringify(value).includes(SECRET);
const tiktok = {platform: 'tiktok', account_id: '1', connection_id: 'c'};

test('every signed-URL and credential form is redacted in a string, and the text around it survives', () => {
  for (const [label, [form, kept]] of Object.entries(delimited)) {
    const out = redact(sentence(form));
    assert.ok(!out.includes(SECRET), label + ': ' + out);
    assert.ok(out.includes('[REDACTED]'), label);
    assert.ok(out.includes(kept), label + ' keeps ' + kept + ': ' + out);
    assert.equal(redact(out), out, label + ' is idempotent');
  }
});

test('ordinary text and data that only look like these forms are left alone', () => {
  for (const text of [
    'Invalid metric campaign_name for campaign 12',
    'see https://example.test/page?name=Summer&n=1#top',
    '{"name":"Summer","budget":100,"policy":{"id":7}}',
    'The ad policy review needs a key frame; policy_id=7 and keyword=shoes',
    'Unexpected token } in JSON at position 4',
    'status=active;mode=test',
  ])
    assert.equal(redact(text), text);
});

// A secret inside the value of another parameter, or after a fragment: the redaction reads each `name=` head, so a
// plain pair never hides the pair nested in its value. Each has its own marker for the text that must survive.
const nested = {
  'a secret nested in a return URL': [
    `https://a.example/p?next=https://b.example/q?access_token=${SECRET}1&z=1`,
    'z=1',
    `${SECRET}1`,
  ],
  'a secret nested in free text': [`see ?next=x?token=${SECRET}2 end`, ' end', `${SECRET}2`],
  'a secret behind a plain pair': [`https://a.example/p?u=1?client_secret=${SECRET}3`, 'u=1', `${SECRET}3`],
  'a secret nested twice': [`https://a.example/p?a=1?b=2?refresh_token=${SECRET}4&z=1`, 'z=1', `${SECRET}4`],
  'an encoded signature nested in a return URL': [
    `https://a.example/p?return=x?X%2DAmz%2DSignature=${SECRET}5&z=1`,
    'z=1',
    `${SECRET}5`,
  ],
  'a secret in the fragment after a plain pair': [
    `https://a.example/p?a=b#access_token=${SECRET}6`,
    'a=b',
    `${SECRET}6`,
  ],
  'a password after a fragment pair': [`?q=1#x=2&password=${SECRET}7`, 'q=1', `${SECRET}7`],
};

test('a secret nested in the value of a plain parameter, or after a fragment, is redacted (security regression)', () => {
  for (const [label, [form, kept, secret]] of Object.entries(nested)) {
    const out = redact(sentence(form));
    assert.ok(!out.includes(secret), label + ' in redact: ' + out);
    assert.ok(out.includes(kept), label + ' keeps ' + kept + ': ' + out);
    assert.equal(redact(out), out, label + ' is idempotent');
    const diagnostic = reportSourceError(
      new MirrorError(
        'PLATFORM_ERROR',
        sentence(form),
        {http_status: 400, upstream: {message: form, error: {message: form}}},
        400,
      ),
      tiktok,
    );
    assert.ok(!JSON.stringify(diagnostic).includes(secret), label + ' in the diagnostic');
    if (form.startsWith('https://')) {
      const link = redactUrlSecrets({link: form, nested: [{paging: {next: form}}]}).value;
      assert.ok(!JSON.stringify(link).includes(secret), label + ' in a native result URL');
      assert.ok(JSON.stringify(link).includes(kept), label + ' keeps ' + kept + ' in a native result URL');
    }
  }
});

test('a signed link still keeps only its own signature when its other parameters nest further pairs', () => {
  const link = `https://preview.example/c?next=https://b.example/q?access_token=${SECRET}1&signature=${SECRET}2&sig=${SECRET}3&id=1`,
    kept = redactUrlSecrets({creative_preview_link: link}, new Set(['creative_preview_link'])).value
      .creative_preview_link;
  assert.ok(!kept.includes(`${SECRET}1`), kept);
  assert.ok(kept.includes(`signature=${SECRET}2`) && kept.includes(`sig=${SECRET}3`) && kept.includes('id=1'), kept);
});

test('what the redaction hid before this package it still hides, pair for pair, in text and in URLs', () => {
  // The reference is the redaction as it was: a delimiter, one of the original names, `=`, then a value to the stop
  // character, searched for anywhere in the text (a nested pair included). For strings without `;`, escapes, quotes
  // or the names added since, the new passes must give the very same text.
  const names = 'access_token|refresh_token|client_secret|secret|oauth_token|token|api_key|key|sig|signature|gtm_auth',
    textOld = new RegExp('([?&](?:' + names + ')=)[^&\\s]+', 'gi'),
    urlOld = new RegExp('([?&#](?:' + names + ')=)[^&#\\s]+', 'gi'),
    signedOld = new RegExp('([?&#](?:' + names.replace('|sig|signature', '') + ')=)[^&#\\s]+', 'gi');
  const textReference = text =>
    text.replace(/Bearer\s+[\w.+/=-]+/gi, 'Bearer [REDACTED]').replace(textOld, '$1[REDACTED]');
  const secretNames = names.split('|').flatMap(n => [n, n.toUpperCase(), n[0].toUpperCase() + n.slice(1)]),
    plainNames = ['next', 'name', 'n', 'keyword', 'my_token', 'tokens', 'return', 'u', 'q', 'a', 'b', 'signatures'],
    allNames = [...secretNames, ...plainNames, ...plainNames],
    values = ['', 'v', 'x1', 'SECRETVALUE', 'a/b', 'a:b', '=', 'https://b.example/q'];
  let seed = 20261106;
  const next = n => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return Math.floor(seed / 65536) % n;
  };
  let nestedSecrets = 0;
  const pair = (leads, depth) => {
    const name = allNames[next(allNames.length)];
    if (depth > 0 && secretNames.includes(name)) nestedSecrets++;
    const value = values[next(values.length)] + (depth < 3 && next(3) === 0 ? pair(leads, depth + 1) : '');
    return leads[next(leads.length)] + name + '=' + value;
  };
  for (let i = 0; i < 20000; i++) {
    const free = Array.from(
      {length: 1 + next(4)},
      () => (next(3) ? '' : [' ', 'x', ' end ', 'Bearer abc.def '][next(4)]) + pair('?&', 0),
    );
    const text = free.join('');
    assert.equal(redact(text), textReference(text), JSON.stringify(text));
    const link = 'https://a.example/p' + Array.from({length: 1 + next(4)}, () => pair('?&#', 0)).join(''),
      expected = link.replace(urlOld, '$1[REDACTED]'),
      signed = link.replace(signedOld, '$1[REDACTED]');
    assert.equal(redactUrlSecrets(link).value, /[?#]/.test(link) ? expected : link, JSON.stringify(link));
    assert.equal(
      redactUrlSecrets({creative_preview_link: link}, new Set(['creative_preview_link'])).value.creative_preview_link,
      /[?#]/.test(link) ? signed : link,
      'signed ' + JSON.stringify(link),
    );
  }
  assert.ok(nestedSecrets > 1000, 'the sample held ' + nestedSecrets + ' secret pairs nested in another value');
});

test('object keys and string values redact the same credential names', () => {
  const object = redact({api_key: SECRET, nested: {access_token: SECRET}, note: `{"api_key":"${SECRET}"}`});
  assert.ok(!leaked(object), JSON.stringify(object));
});

test('whole URLs in native results hide the same forms, and a signed link keeps only its own signature', () => {
  for (const [label, [form]] of Object.entries(delimited).filter(([, [form]]) => form.startsWith('https://'))) {
    const out = redactUrlSecrets({link: form, nested: [{paging: {next: form}}]}).value;
    assert.ok(!leaked(out), label);
  }
  // Snapchat's preview link is unusable without sig/signature: only those two survive on an allowed field, and the
  // new signature and credential names are redacted there too.
  const link = `https://preview.example/c?id=1&signature=${SECRET}&sig=${SECRET}&x-amz-signature=${SECRET}&policy=${SECRET}&access_token=${SECRET}`,
    kept = redactUrlSecrets({creative_preview_link: link}, new Set(['creative_preview_link'])).value
      .creative_preview_link;
  assert.ok(kept.includes(`signature=${SECRET}`) && kept.includes(`sig=${SECRET}`));
  assert.ok(!kept.includes(`x-amz-signature=${SECRET}`) && !kept.includes(`policy=${SECRET}`));
  assert.ok(!kept.includes(`access_token=${SECRET}`));
});

test('the report source error never carries these forms in its message, provider detail or request ID', () => {
  for (const [label, [form, kept]] of [...Object.entries(delimited), ...Object.entries(prose)]) {
    const text = sentence(form),
      diagnostic = reportSourceError(
        new MirrorError(
          'PLATFORM_ERROR',
          text,
          {
            http_status: 400,
            request_id: form,
            upstream: {code: form, message: text, error: {message: form, code: form}, errors: [{message: form}]},
          },
          400,
        ),
        tiktok,
      );
    assert.ok(!leaked(diagnostic), label + ': ' + JSON.stringify(diagnostic).slice(0, 300));
    assert.ok(JSON.stringify(diagnostic).includes(kept.replaceAll('"', '\\"')), label + ' keeps ' + kept);
  }
});

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
async function refused(response) {
  const transport = new NativeTransport(
    async () => response(),
    async () => {},
  );
  const error = await transport
    .request(plan, connection, {accessToken: 'TEST_CREDENTIAL_NOT_REAL'})
    .then(() => assert.fail('expected a refusal'))
    .catch(e => e);
  assert.ok(error instanceof MirrorError, String(error));
  return error;
}
const json = (body, status) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

test('a provider body that echoes these forms never reaches the MCP envelope or the website diagnostic', async () => {
  for (const [label, [form]] of Object.entries(delimited)) {
    const text = sentence(form);
    for (const error of [
      // An HTTP error, and TikTok's unsuccessful result inside HTTP 200.
      await refused(() => json({error: {message: text}, message: text, details: [{reason: form}]}, 400)),
      await refused(() => json({code: 40002, message: text, request_id: 'synthetic'}, 200)),
    ]) {
      assert.ok(!leaked(errorResult(error, 'request-1', 1)), label + ' in the MCP envelope');
      assert.ok(!leaked(reportSourceError(error, tiktok)), label + ' in the website diagnostic');
      // A workflow that re-raises the inner failure keeps the same details.
      const inner = nestedError(errorResult(error, 'request-1', 1), {code: 'REPORT_FAILED', message: 'x'});
      assert.ok(!leaked(errorResult(inner, 'request-2', 1)), label + ' after a re-raise');
    }
  }
});

test('redaction stays linear on hostile text', () => {
  for (const hostile of [
    '&'.repeat(300000),
    '?a'.repeat(150000),
    '&a'.repeat(150000) + '=',
    'a'.repeat(300000),
    '"'.repeat(300000),
    '{"api_key":"' + 'x\\'.repeat(150000),
    ';token'.repeat(50000),
    '%'.repeat(300000),
    // Many nested heads: plain pairs inside plain pairs, at the name bound, and a secret that swallows the rest.
    '?a='.repeat(100000),
    ('?' + 'n'.repeat(99) + '=').repeat(3000),
    ('?' + 'n'.repeat(100) + '=').repeat(3000),
    ('?' + 'n'.repeat(101) + '=').repeat(3000),
    '?next=x'.repeat(60000) + '?token=' + 'v'.repeat(100000),
    '?token='.repeat(60000),
    '#a=1;b=2&'.repeat(40000),
    ('?a=' + '%E0'.repeat(30)).repeat(8000),
  ]) {
    const started = performance.now();
    redact(hostile);
    assert.ok(performance.now() - started < 3000, 'redaction took ' + (performance.now() - started) + ' ms');
  }
});
