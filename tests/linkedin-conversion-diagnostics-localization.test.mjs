import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parsers} from 'prettier/plugins/babel';
import {inspectMeasurementFailures, inspectSharedRecoveryHints, localeProblems} from '../tools/check-locales.mjs';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
const file = 'src/linkedin-conversion-evidence.ts',
  source = readFileSync(file, 'utf8'),
  catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  labels = [
    'Registration method',
    'Reported ownership',
    "This view requests LinkedIn's default owned-rule selection. Shared rules are not requested. Missing method or ownership fields stay unknown.",
    'Search name, ID, type, method or ownership.',
  ];
test('LinkedIn conversion failure selector owns only exact source helpers and literal diagnostic positions', () => {
  const sample =
    "bad('Owned scope.','INSUFFICIENT_SCOPE');invalid('Owned evidence.');bad(native.message??'Unselected fallback.','NATIVE_CODE');invalid(native.error.message);new MirrorError('NATIVE_CODE','Unselected native reason.');const data={conversionMethod:'CONVERSIONS_API',ownershipType:'OWNED',message:'Unselected field.'};";
  for (const name of [file, file.replaceAll('/', '\\')])
    assert.deepEqual([...inspectMeasurementFailures(sample, name)], ['Owned scope.', 'Owned evidence.']);
  for (const name of [
    'src/linkedin-evidence.ts',
    'tests/linkedin-conversion-evidence.ts',
    'src/other-linkedin-conversion-evidence.ts',
  ])
    assert.equal(inspectMeasurementFailures(sample, name).size, 0);
  const hints = inspectSharedRecoveryHints(readFileSync('src/errors.ts', 'utf8'), 'src/errors.ts'),
    inventoryHint = errorResult(new MirrorError('PORTFOLIO_INVALID_RESPONSE', 'Fixture'), 'ref', 0).error.next_action;
  assert.equal(hints.size, 149);
  assert.ok(hints.has(inventoryHint));
  assert.equal([...hints].filter(hint => hint !== inventoryHint).length, 148);
});
test('all 25 LinkedIn authored conversion failures and four metadata/search labels have Arabic coverage', () => {
  const failures = inspectMeasurementFailures(source, file);
  assert.equal(failures.size, 25);
  const required = new Set([...failures, ...labels]);
  assert.equal(required.size, 29);
  assert.deepEqual(localeProblems(catalog, required), []);
  for (const label of required) {
    assert.match(catalog[label], /[\u0600-\u06ff]/);
    assert.notEqual(catalog[label], label);
  }
  for (const native of ['OWNED', 'SHARED', 'CONVERSIONS_API', 'conversionMethod', 'ownershipType', 'r_ads', 'rw_ads'])
    assert.equal(Object.hasOwn(catalog, native), false);
});
test('all authored conversion diagnostics format bilingually without altering codes, details, references or retry authority', () => {
  const values = [],
    walk = node => {
      if (!node || typeof node !== 'object') return;
      if (
        node.type === 'CallExpression' &&
        ['bad', 'invalid'].includes(node.callee?.name) &&
        node.arguments[0]?.type === 'StringLiteral'
      )
        values.push({
          message: node.arguments[0].value,
          code: node.callee.name === 'invalid' ? 'MEASUREMENT_EVIDENCE_INVALID' : node.arguments[1].value,
        });
      for (const [key, value] of Object.entries(node))
        if (!['loc', 'extra', 'comments', 'tokens'].includes(key))
          for (const child of Array.isArray(value) ? value : [value]) walk(child);
    };
  walk(parsers['babel-ts'].parse(source));
  assert.equal(new Set(values.map(v => v.message)).size, 25);
  for (const locale of ['en', 'ar']) {
    const f = accountWorkflowFixture(locale);
    for (const {message, code} of values) {
      const response = errorResult(
          new MirrorError(code, message, {
            account_id: '100',
            conversion_id: '9007199254740993',
            native_ownership: 'FUTURE_<img>',
          }),
          'synthetic-conversion-diagnostic-reference',
          0,
        ),
        original = JSON.stringify(response);
      assert.equal(response.error.remedy.mutation_retry_safe, false);
      f.context.response = response;
      const error = f.run('requestError(response)');
      assert.equal(error.message, message);
      assert.equal(error.code, code);
      assert.equal(error.details, response.error.details);
      f.context.error = error;
      const display = f.run('errorMessage(error)');
      assert.ok(display.includes(locale === 'ar' ? catalog[message] : message));
      assert.ok(display.includes('synthetic-conversion-diagnostic-reference'));
      assert.equal(Object.hasOwn(catalog, response.error.next_action), true);
      assert.ok(display.includes(locale === 'ar' ? catalog[response.error.next_action] : response.error.next_action));
      assert.equal(JSON.stringify(response), original);
    }
  }
});
