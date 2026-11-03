import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script, createContext} from 'node:vm';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {reportSourceError} from '../dist/src/report-errors.js';

const key = 'LinkedIn returned no rows for {from}–{to}. Check that the account delivered in those dates.';
const values = {from: '2026-09-01', to: '2026-09-07'};
const expected =
  'LinkedIn returned no rows for 2026-09-01–2026-09-07. Check that the account delivered in those dates.';
test('a parameterized AMCP error keeps exact English text and its template in both diagnostic envelopes', () => {
  const error = new MirrorError('REPORT_EMPTY_AMBIGUOUS', key, {}, 502, false, values);
  assert.equal(error.message, expected);
  const mcp = errorResult(error, 'synthetic-request', 1).error;
  const report = reportSourceError(error, {platform: 'linkedin', account_id: '100', connection_id: 'login'});
  for (const out of [mcp, report]) {
    assert.equal(out.message, expected);
    assert.deepEqual(out.message_localization, {key, values});
  }
  values.from = 'changed after construction';
  assert.equal(error.message, expected);
  assert.equal(mcp.message_localization.values.from, '2026-09-01');
  values.from = '2026-09-01';
});
test('the Arabic display interpolates authored dates and preserves a provider’s own message', () => {
  const error = new MirrorError('REPORT_EMPTY_AMBIGUOUS', key, {}, 502, false, values);
  const context = createContext({
    document: {addEventListener() {}},
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
    error: reportSourceError(error, {platform: 'linkedin', account_id: '100'}),
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  const run = text => new Script(text).runInContext(context);
  run('uiLocale="ar";uiMessages=new Map(Object.entries(catalog));');
  const displayed = run('uiOwnedError(error).message');
  assert.match(displayed, /[\u0600-\u06ff]/u);
  assert.match(displayed, /2026-09-01/);
  assert.match(displayed, /2026-09-07/);
  assert.doesNotMatch(displayed, /\{from\}|\{to\}/);
  run('error.provider={request_id:"synthetic-request"};');
  assert.equal(run('uiOwnedError(error).message'), displayed);
  run('error.provider={message:"Native {from} $& <text>"};');
  assert.equal(run('uiOwnedError(error).message'), 'Native {from} $& <text>');
  assert.equal(run('uiOwnedError(error).nextAction'), displayed);
});

test('authored split warnings translate from shipped Overview chunks while unknown native text stays literal', () => {
  const context = createContext({document: {addEventListener() {}}});
  for (const file of ['localization', 'report-quality'])
    new Script(readFileSync('web/' + file + '.js', 'utf8')).runInContext(context);
  context.catalog = Object.assign(
    {},
    ...['shell', 'workspace', 'providers', 'report-quality'].map(name =>
      JSON.parse(readFileSync('web/locales/ar/' + name + '.json', 'utf8')),
    ),
  );
  new Script('uiLocale="ar";uiMessages=new Map(Object.entries(catalog));').runInContext(context);
  for (const message of [
    'LinkedIn returned 15,000 rows for one day, its response limit; rows beyond it are missing.',
    'LinkedIn’s split request limit was reached; some periods are missing.',
    'LinkedIn’s 15,000-row limit split this window, so reach is unavailable.',
    'LinkedIn metrics without an additive rule are unavailable after splitting the window.',
    'LinkedIn did not return every entity in every split period; totals for those entities are unknown.',
    'AMCP retained the first 10,000 LinkedIn entities; entities beyond that bound are missing.',
    'This LinkedIn source reports more than 2000 entities, so names, parents and objectives beyond that bound stay unknown.',
  ]) {
    context.message = message;
    assert.match(new Script('uiSourceWarning(message)').runInContext(context), /[\u0600-\u06ff]/u);
  }
  context.message = 'LinkedIn synthetic native warning $& <text> 00123';
  assert.equal(new Script('uiSourceWarning(message)').runInContext(context), context.message);
});
test('legacy errors keep their existing wire shape and substituted native values stay literal', () => {
  const legacy = errorResult(
    new MirrorError('INVALID_ARGUMENT', 'Synthetic legacy message.'),
    'synthetic-request',
    1,
  ).error;
  assert.equal(Object.hasOwn(legacy, 'message_localization'), false);
  const error = new MirrorError('INVALID_ARGUMENT', 'Unknown {field}.', {}, 400, false, {field: '$&_{field}'});
  assert.equal(error.message, 'Unknown $&_{field}.');
});
