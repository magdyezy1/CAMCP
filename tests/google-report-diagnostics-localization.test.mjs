import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {inspectReportingFailures, inspectGoogleCaptureRemedies, localeProblems} from '../tools/check-locales.mjs';
import {MirrorError, errorResult} from '../dist/src/errors.js';

const source = readFileSync('src/google-reporting.ts', 'utf8');
const messages = inspectReportingFailures(source, 'src/google-reporting.ts');
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
const remedies = inspectGoogleCaptureRemedies(readFileSync('src/errors.ts', 'utf8'), 'src/errors.ts');

test('Google recovery selection excludes dynamic remedies, native details and unrelated error families', () => {
  const sample = `
    function familyRemedy(code) {
      if (/_LIMIT$/.test(code)) return r('request', 'Owned limit hint.');
      if (/REPORT/.test(code)) return r('report', upstream.message);
      if (/_MISMATCH$/.test(code)) return r('state', 'Owned identity hint.');
      if (/OTHER/.test(code)) return r('other', 'Unrelated hint.');
    }
    export function errorRemedy(e) {
      if (e.code === 'REPORT_SHAPE_CHANGED') return {action: 'Owned shape hint.', details: 'Native details.'};
      if (e.code === 'OTHER') return {action: 'Unrelated hint.'};
    }
    export function errorResult(e) {
      const remediation = {REAUTHORIZATION_REQUIRED: 'Owned login hint.', NATIVE_CODE: 'Native hint.'};
    }
    function unrelated() { if (/REPORT/.test(code)) return r('report', 'Unrelated function.'); }
  `;
  assert.deepEqual(
    [...inspectGoogleCaptureRemedies(sample, 'src/errors.ts')],
    ['Owned limit hint.', 'Owned identity hint.', 'Owned shape hint.', 'Owned login hint.'],
  );
  assert.equal(inspectGoogleCaptureRemedies(sample, 'src/provider-errors.ts').size, 0);
  const retry =
    "export const providerDataAction = 'Owned provider-data hint.'; " +
    "function familyRemedy(code){if(/REPORT/.test(code))return r('report','Generic report hint.');}";
  assert.deepEqual([...inspectGoogleCaptureRemedies(retry, 'src/errors.ts')], ['Owned provider-data hint.']);
  assert.deepEqual(
    [
      ...inspectGoogleCaptureRemedies(
        retry.replace("'Owned provider-data hint.'", 'upstream.message'),
        'src/errors.ts',
      ),
    ],
    ['Generic report hint.'],
  );
});

test('selected Google refusal copy excludes native fragments, fallback expressions, error codes and unrelated collectors', () => {
  const sample = [
    "bad('Owned refusal.', 'REPORT_ACCOUNT_MISMATCH');",
    "incomplete('Owned completion failure.');",
    "bad(upstream.message ?? 'Native fallback.', upstream.code ?? 'REPORT_FAILED');",
    "bad('Account ' + nativeId, 'REPORT_SHAPE_CHANGED');",
    "bad(ready ? 'Conditional fallback.' : upstream.message);",
    'incomplete(`Native ${nativeId}`);',
    "throw new MirrorError('NATIVE_CODE', 'Other diagnostic.');",
    "result('Other authored field.');",
  ].join('\n');
  assert.deepEqual(
    [...inspectReportingFailures(sample, 'src/google-reporting.ts')],
    ['Owned refusal.', 'Owned completion failure.'],
  );
  assert.deepEqual(
    [...inspectReportingFailures(sample, 'src\\google-reporting.ts')],
    ['Owned refusal.', 'Owned completion failure.'],
  );
  for (const file of ['src/meta-reporting.ts', 'src/unrelated-google-reporting.ts', 'tests/google-reporting.ts'])
    assert.equal(inspectReportingFailures(sample, file).size, 0);
});

test('every selected Google collector refusal has authored Arabic and no native fallback is newly required', () => {
  // RPT-07 added the Performance Max campaign and ad-network/day grain refusals.
  assert.equal(messages.size, 32);
  assert.deepEqual(localeProblems(catalog, messages), []);
  assert.equal(messages.has('Google report read failed.'), false);
  assert.equal(messages.has('REPORT_SHAPE_CHANGED'), false);
  assert.equal(messages.has('REPORT_INCOMPLETE'), false);
  for (const message of messages) {
    assert.notEqual(catalog[message], message);
    assert.match(catalog[message], /[\u0600-\u06ff]/);
  }
});

test('device, hour and country mapping diagnostics have narrow source ownership and authored Arabic without collecting other refusals', () => {
  const owned = inspectReportingFailures(
    readFileSync('src/decision-reporting.ts', 'utf8'),
    'src/decision-reporting.ts',
  );
  assert.deepEqual(
    [...owned],
    [
      'Native device requires an unmodified field pointer.',
      'Native hour requires an unmodified field pointer.',
      'Native geographic dimensions require unmodified field pointers.',
      'Native device must retain a documented Google device value.',
      'Native hour must retain an explicit integer from 0 through 23.',
      'Native country criterion IDs must retain exact nonnegative int64 strings.',
      'Native location type must retain a documented Google geographic value.',
      'Native geographic resources must retain the exact selected customer.',
      'Native geographic dimensions disagree with their original resource identity.',
    ],
  );
  assert.deepEqual(localeProblems(catalog, owned), []);
  const sample =
    "nativeDeviceMappingFailure('Owned device refusal.'); bad('Other refusal.'); incomplete('Other collection.'); nativeDeviceMappingFailure(native.message ?? 'Fallback.');";
  assert.deepEqual([...inspectReportingFailures(sample, 'src/decision-reporting.ts')], ['Owned device refusal.']);
  assert.equal(inspectReportingFailures(sample, 'src/other-decision-reporting.ts').size, 0);
});

function fixture(locale) {
  const context = createContext({catalog, document: {addEventListener() {}}, Intl, Date});
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  const app = readFileSync('web/app.js', 'utf8'),
    start = app.indexOf('function requestError('),
    end = app.indexOf("const content = $('#content')", start);
  assert.ok(start >= 0 && end > start);
  run(app.slice(start, end));
  return {context, run};
}

test('all nine owned Google failure codes display authored recovery hints and preserve structured retry semantics', () => {
  const codes = [
    'REPORT_ACCOUNT_MISMATCH',
    'REPORT_CURRENCY_MISMATCH',
    'REPORT_TIMEZONE_MISMATCH',
    'REPORT_SHAPE_CHANGED',
    'REPORT_DATE_MISMATCH',
    'REPORT_DUPLICATE_ROWS',
    'REAUTHORIZATION_REQUIRED',
    'REPORT_INCOMPLETE',
    'REPORT_COLLECTION_LIMIT',
  ];
  assert.equal(remedies.size, 5);
  assert.deepEqual(localeProblems(catalog, remedies), []);
  const actual = new Set();
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    for (const code of codes) {
      const message = [...messages][0],
        response = errorResult(new MirrorError(code, message, {account_id: '00123'}), 'synthetic-reference-0001', 0);
      actual.add(response.error.next_action);
      const original = JSON.stringify(response);
      assert.equal(response.error.remedy.mutation_retry_safe, false);
      f.context.response = response;
      const text = f.run('errorMessage(requestError(response))');
      assert.ok(text.includes(locale === 'ar' ? catalog[response.error.next_action] : response.error.next_action));
      assert.ok(text.includes('synthetic-reference-0001'));
      assert.equal(JSON.stringify(response), original);
    }
  }
  assert.deepEqual([...actual].sort(), [...remedies].sort());
});

test('real website error formatting localizes owned copy while retaining original API message, code, reference and native details', () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    for (const message of messages) {
      const details = Object.freeze({
        account_id: '00123',
        currency: 'SAR',
        spend: '9007199254.740993',
        keyword_match_type: 'UNKNOWN',
      });
      const response = Object.freeze({
        success: false,
        error: Object.freeze({code: 'REPORT_SHAPE_CHANGED', message, details, next_action: 'Native retry hint 00123'}),
        meta: Object.freeze({requestId: 'synthetic-request-0001'}),
      });
      f.context.response = response;
      const error = f.run('requestError(response)');
      f.context.error = error;
      assert.equal(error.message, message);
      assert.equal(error.code, 'REPORT_SHAPE_CHANGED');
      assert.equal(error.details, details);
      assert.equal(error.requestId, 'synthetic-request-0001');
      assert.equal(
        f.run('errorMessage(error)'),
        [
          locale === 'ar' ? catalog[message] : message,
          'Native retry hint 00123',
          (locale === 'ar' ? catalog['Reference: {id}'] : 'Reference: {id}').replace('{id}', 'synthetic-request-0001'),
        ].join(' '),
      );
      assert.equal(error.message, message);
      assert.equal(response.error.details.spend, '9007199254.740993');
    }
  }
});

test('unknown provider diagnostics and near-matching owned text stay literal and superseded requests stay silent', () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    for (const message of [
      'Google did not return an exact native ad ID. Provider says 00123 <img>',
      'Native provider_CODE_0001: SAR 9007199254.740993',
      'Google report read failed.',
    ]) {
      f.context.response = {error: {code: 'UPSTREAM_ERROR', message, details: {upstream: {message}}}};
      assert.equal(f.run('errorMessage(requestError(response))'), message);
      assert.equal(f.context.response.error.message, message);
    }
    assert.equal(f.run('errorMessage(supersededRequest())'), '');
  }
});
