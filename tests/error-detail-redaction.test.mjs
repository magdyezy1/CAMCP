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
  ]) {
    const started = performance.now();
    redact(hostile);
    assert.ok(performance.now() - started < 3000, 'redaction took ' + (performance.now() - started) + ' ms');
  }
});
