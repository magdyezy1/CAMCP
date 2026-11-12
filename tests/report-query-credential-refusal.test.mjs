import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {ReportingService} from '../dist/src/reporting.js';
import {assertReportingConfigCredentials, redactReportingConfig} from '../dist/src/report-query-access.js';
import * as security from '../dist/src/security.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {redactAtHead} from './helpers/redaction-at-head.mjs';

/**
 * Ruling 10 (A): the credential refusal of saved reporting queries and settings refuses credential-shaped content, not
 * ordinary campaign or report text. redact() hides the prose forms `Cookie: x` and `password: x` (DR2-02), which is right
 * for display, storage, the card, the MCP envelope, job errors and the audit trail, but a refusal built on
 * `redact(x) !== x` would also refuse a report called `Password: reset funnel`. Synthetic values only.
 */
const SECRET = 'SYNTHETICVALUE0123456789';
const META = 'EAA' + 'SYNTHETICVALUE'.repeat(5);
const queryRefusal = /^Store credentials in Connections, not reporting queries\.$/;
const settingsRefusal = /^Store credentials in Connections, not reporting settings\.$/;

// Ordinary text a campaign, a report or a note may carry; the first six are the false positives of DR2-02's blast radius.
const prose = [
  'Cookie: Spring sale',
  'Password: reset funnel',
  'Black Friday secret: early access',
  'Authorization: pending',
  'Winners: Basic plan',
  'the signature of the ad',
  'Spring sale',
  'Authorization: Basic plan',
  'Proxy-Authorization: none',
  'Set-Cookie: policy review',
  'Token expired for the Q3 report',
  'Unexpected token } in JSON at position 4',
  'Bearer of good news',
  'Secret: the launch is on Friday',
  'EAA is a prefix, and EAAshort is not a token',
];
// Credential-shaped forms: a pair of the credential list, a URL secret, an Authorization scheme and token, a cookie pair,
// a Bearer token, a JSON key of the list, a Meta token.
const credentialShaped = {
  'Authorization: Bearer': `Authorization: Bearer ${SECRET}`,
  'Authorization: Basic': `Authorization: Basic ${SECRET}`,
  'Authorization: another scheme': `Authorization: Digest ${SECRET}`,
  'Proxy-Authorization': `Proxy-Authorization: Basic ${SECRET}`,
  'a lower-case header': `authorization: bearer ${SECRET}`,
  'Cookie with a pair': `Cookie: sid=${SECRET}`,
  'Cookie with two pairs': `Cookie: a=1; sid=${SECRET}`,
  'Set-Cookie': `Set-Cookie: session=${SECRET}; Path=/; HttpOnly`,
  'a bare access_token': `access_token=${SECRET}`,
  'a short access_token': 'access_token=x',
  'a hyphenated name': `client-secret=${SECRET}`,
  'an id_token pair (Ruling 10 B)': `id_token=${SECRET}`,
  'an oauth_signature pair (Ruling 10 B)': `oauth_signature:${SECRET}`,
  'an id_token JSON key (Ruling 10 B)': `{"id_token":"${SECRET}"}`,
  'a pair after a delimiter': `see ?x=1&client-secret=${SECRET}`,
  'a URL secret': `https://objects.example/f.bin?X-Amz-Signature=${SECRET}&n=1`,
  'a signed fragment': `https://objects.example/f#access_token=${SECRET}`,
  'a JSON key of the list': `{"api_key":"${SECRET}","n":1}`,
  'a colon pair': `api_key:${SECRET}`,
  'a bare token pair': `token=${SECRET}`,
  'a bare sig pair': 'sig=hot',
  'cookie is in the list, so the pair is refused': 'cookie=oatmeal',
  'a standalone Bearer token': `Bearer ${SECRET}`,
  'a Meta token': META,
  'a Meta token in a sentence': `The token ${META} expired`,
};
// A value that is already hidden is not a credential: a redacted projection can be saved back.
const alreadyHidden = [
  'access_token=[REDACTED]',
  'Authorization: Bearer [REDACTED]',
  'Proxy-Authorization: Basic [REDACTED]',
  'Cookie: [REDACTED]',
  'Set-Cookie: [REDACTED]',
  '{"api_key":"[REDACTED]","n":1}',
  'see ?x=1&client-secret=[REDACTED]&n=2',
  'Bearer [REDACTED]',
  'https://objects.example/f.bin?X-Amz-Signature=[REDACTED]&n=1',
];

const actor = {tenantId: 'credential-refusal', userId: 'member', role: 'operator'};
function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 83).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: 'meta',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  store.putDocument(actor.tenantId, 'workbook', 'book', {spreadsheet_id: 'SHEET', created_by: actor.userId});
  const reporting = new ReportingService(store),
    config = {
      platform: 'meta',
      connection_id: 'meta',
      account_id: '100',
      date_range: {since: '2026-09-01', until: '2026-09-07'},
    };
  // The settings path (src/reporting.ts): the name and the other changes of a saved query.
  const settings = name =>
    reporting.handle(
      'create_reporting_query',
      {workbook_binding_id: 'book', name, query_config: config, dry_run: true},
      actor,
    );
  return {store, reporting, config, settings};
}
// The query path (src/report-query-access.ts): the text sits in the configuration of the query.
const queryWith = (config, text) => ({...config, note: text});
const encodedWith = text => ({
  gateway: 'linkedin_native_action',
  arguments: {
    action: 'linkedin_rest_targeting_audience_insights_post',
    account_id: '100',
    connection_id: 'login',
    query: {action: 'audienceInsights'},
    payload: JSON.stringify({request: {note: text}}),
  },
});

test('ordinary campaign and report text is accepted by the query check, the encoded-body check and the settings check', t => {
  const f = fixture(t);
  for (const text of prose) {
    assert.doesNotThrow(() => assertReportingConfigCredentials(queryWith(f.config, text)), 'query: ' + text);
    assert.doesNotThrow(() => assertReportingConfigCredentials(encodedWith(text)), 'encoded body: ' + text);
    assert.equal(f.settings(text).dry_run, true, 'settings: ' + text);
    // And in any other string of the configuration, and in an array.
    assert.doesNotThrow(() =>
      assertReportingConfigCredentials({...f.config, labels: [text], nested: {description: text}}),
    );
  }
});

test('credential-shaped content is refused with the same messages, in every string of the configuration', t => {
  const f = fixture(t);
  for (const [label, text] of Object.entries(credentialShaped)) {
    assert.throws(
      () => assertReportingConfigCredentials(queryWith(f.config, text)),
      e => assertRefused(e, 'INVALID_ARGUMENT', {message: queryRefusal}),
      'query: ' + label,
    );
    assert.throws(
      () => assertReportingConfigCredentials(encodedWith(text)),
      e => assertRefused(e, 'INVALID_ARGUMENT', {message: queryRefusal}),
      'encoded body: ' + label,
    );
    assert.throws(
      () => f.settings(text),
      e => assertRefused(e, 'INVALID_ARGUMENT', {message: settingsRefusal}),
      'settings: ' + label,
    );
    assert.throws(
      () => assertReportingConfigCredentials({...f.config, labels: ['x', text], nested: {deep: [{description: text}]}}),
      e => assertRefused(e, 'INVALID_ARGUMENT', {message: queryRefusal}),
      'nested: ' + label,
    );
  }
});

test('a value that is already hidden, and a key of the credential list with a hidden value, can be saved back', t => {
  const f = fixture(t);
  for (const text of alreadyHidden) {
    assert.doesNotThrow(() => assertReportingConfigCredentials(queryWith(f.config, text)), text);
    assert.equal(f.settings(text).dry_run, true, 'settings: ' + text);
  }
  // Object keys are judged as redact() judges them: a listed key whose value is not [REDACTED] is refused.
  assert.doesNotThrow(() => assertReportingConfigCredentials({...f.config, oauth_token: '[REDACTED]'}));
  assert.throws(
    () => assertReportingConfigCredentials({...f.config, oauth_token: SECRET}),
    e => assertRefused(e, 'INVALID_ARGUMENT', {message: queryRefusal}),
  );
  assert.throws(
    () => assertReportingConfigCredentials({...f.config, api_key: SECRET}),
    e => assertRefused(e, 'INVALID_ARGUMENT', {message: queryRefusal}),
  );
  // Ruling 10 (B): the keys id_token and oauth_signature are listed too; `code` is not.
  assert.doesNotThrow(() => assertReportingConfigCredentials({...f.config, id_token: '[REDACTED]'}));
  for (const key of ['id_token', 'oauth_signature'])
    assert.throws(
      () => assertReportingConfigCredentials({...f.config, [key]: SECRET}),
      e => assertRefused(e, 'INVALID_ARGUMENT', {message: queryRefusal}),
      key,
    );
  assert.doesNotThrow(() => assertReportingConfigCredentials({...f.config, code: 'INVALID_ARGUMENT', note: 'code=7'}));
});

test('display and storage keep the full redaction: the prose forms are still hidden where they are shown', () => {
  assert.equal(security.redact('Cookie: Spring sale'), 'Cookie: [REDACTED]');
  assert.equal(security.redact('Password: reset funnel'), '[REDACTED] funnel');
  const shown = redactReportingConfig({platform: 'meta', note: 'Password: reset funnel', other: 'Cookie: Spring sale'});
  assert.deepEqual(shown, {platform: 'meta', note: '[REDACTED] funnel', other: 'Cookie: [REDACTED]'});
});

// ---- The credential-shaped view against the full redaction and the head's ----
const names = [
  'access_token',
  'access-token',
  'api_key',
  'apikey',
  'client-secret',
  'consumer_secret',
  'password',
  'secret',
  'token',
  'sig',
  'signature',
  'oauth_token',
  'authorization',
  'cookie',
  'key',
  'x-amz-signature',
  'next',
  'name',
  'n',
];
const pieces = [
  n => '?' + n + '=' + SECRET,
  n => '&' + n + '=' + SECRET,
  n => '#' + n + '=' + SECRET,
  n => ';' + n + '=' + SECRET,
  n => n + '=' + SECRET,
  n => n + ':' + SECRET,
  n => n + ': ' + SECRET,
  n => n + ' = ' + SECRET,
  n => '?' + n + '=',
  n => '?' + n + '=&b= end',
  n => '{"' + n + '":"' + SECRET + '"}',
  n => '{"' + n + '":"[REDACTED]"}',
  n => n + '=[REDACTED]',
  () => 'Authorization: Bearer ' + SECRET,
  () => 'Authorization: Basic plan',
  () => 'Cookie: sid=' + SECRET,
  () => 'Cookie: Spring sale',
  () => 'Bearer ' + SECRET,
  () => META,
  () => 'the signature of the ad',
  () => 'Password: reset funnel',
  () => 'https://objects.example/f?x=1',
];
test('over 60,000 generated texts the credential-shaped view never refuses what redact() leaves alone, and keeps the head’s refusals', () => {
  let seed = 20261114,
    refused = 0,
    keptFromHead = 0;
  const next = k => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return Math.floor(seed / 65536) % k;
  };
  for (let i = 0; i < 60000; i++) {
    const text = Array.from({length: 1 + next(4)}, () => pieces[next(pieces.length)](names[next(names.length)])).join(
      [' ', '\n', ', ', '; '][next(4)],
    );
    const shape = security.redactCredentialShapes(text) !== text,
      full = security.redact(text) !== text,
      head = redactAtHead(text) !== text;
    // Never a refusal the full redaction would not also make (so ordinary text the full redaction leaves is accepted).
    if (shape) assert.ok(full, 'refused but redact() leaves it: ' + JSON.stringify(text));
    // Never a loosening: what the head's redaction refused is refused. (The one deliberate difference, a Bearer token of
    // under eight characters, is not generated.)
    if (head) assert.ok(shape, 'the head refused it and the credential-shaped view does not: ' + JSON.stringify(text));
    if (shape) refused++;
    if (head && shape) keptFromHead++;
  }
  assert.ok(refused > 20000, 'the sample refused only ' + refused);
  assert.ok(keptFromHead > 10000, 'the sample kept only ' + keptFromHead + ' of the head’s refusals');
});

test('the credential-shaped view stays linear on hostile text', () => {
  for (const hostile of [
    'Authorization:'.repeat(100000),
    'Authorization: a '.repeat(50000),
    'Authorization:' + 'a'.repeat(300000),
    'Proxy-Authorization: Bearer '.repeat(30000),
    'Cookie:'.repeat(100000),
    'Cookie: a'.repeat(60000),
    ('Cookie:' + ' '.repeat(400) + 'x\n').repeat(2000),
    'access_token='.repeat(60000),
    'secret:'.repeat(100000),
    'x-token='.repeat(60000),
    'Bearer '.repeat(100000),
    'EAA'.repeat(100000),
    'EAA' + 'a'.repeat(300000) + '_',
    '?password='.repeat(60000),
  ]) {
    const started = performance.now();
    security.redactCredentialShapes(hostile);
    assert.ok(
      performance.now() - started < 3000,
      'took ' + (performance.now() - started) + ' ms on ' + hostile.slice(0, 24),
    );
  }
});
