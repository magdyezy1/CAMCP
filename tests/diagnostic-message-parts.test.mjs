import test from 'node:test';
import assert from 'node:assert/strict';
import {MirrorError, errorResult, preciseMessage} from '../dist/src/errors.js';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';

test('authored diagnostic base can be translated independently while exact native field suffix and envelope stay unchanged', () => {
  const original = new MirrorError('INVALID_PARAMETER', 'Query parameter is outside vendor bounds.', {
    parameter: '9007199254740993_NATIVE_FIELD',
    fields: ['originalField', 'native_enum'],
    errors: [{field: 'payload/native', reason: 'UNKNOWN_NATIVE_ENUM'}],
  });
  const result = errorResult(original, 'original-request-reference', 1),
    retained = JSON.stringify(result);
  assert.equal(result.error.message, preciseMessage(original));
  assert.deepEqual(result.meta.message_parts, {
    base: original.message,
    suffix: '9007199254740993_NATIVE_FIELD; originalField, native_enum; payload/native (UNKNOWN_NATIVE_ENUM).',
  });
  for (const locale of ['en', 'ar']) {
    const f = accountWorkflowFixture(locale);
    f.context.response = result;
    f.context.error = f.run('requestError(response)');
    const display = f.run('errorMessage(error)');
    assert.ok(
      display.includes(
        locale === 'ar' ? f.context.catalog[original.message].replace(/\.?$/, '') : result.error.message,
      ),
    );
    assert.ok(display.includes(result.meta.message_parts.suffix));
    assert.ok(display.includes('original-request-reference'));
    assert.equal(f.context.error.message, result.error.message);
    assert.equal(f.context.error.details, result.error.details);
    assert.equal(JSON.stringify(result), retained);
  }
});
test('provider bodies, native error codes and unchanged diagnostic messages do not acquire a translated split', () => {
  for (const error of [
    new MirrorError('PROVIDER_ACCESS_DENIED', 'Native message.', {parameter: 'native'}),
    new MirrorError('CUSTOM', 'Native message.', {upstream: {message: 'native'}, parameter: 'native'}),
    new MirrorError('CUSTOM', 'Native message.', {response: {message: 'native'}, parameter: 'native'}),
    new MirrorError('INVALID_PARAMETER', 'No extra field.'),
    new MirrorError('INVALID_PARAMETER', 'The original parameter native is invalid.', {parameter: 'native'}),
  ])
    assert.equal(errorResult(error, 'ref', 0).meta.message_parts, undefined);
});
test('unbound or forged display metadata cannot replace an original diagnostic and raw suffix stays data', () => {
  for (const parts of [
    {base: 'Unknown gateway.', suffix: 'altered'},
    {base: 'Unknown gateway.', suffix: 123},
    {base: ['Unknown gateway.'], suffix: 'native'},
  ]) {
    const f = accountWorkflowFixture('ar');
    f.context.response = {error: {code: 'CUSTOM', message: 'ORIGINAL-NATIVE-TEXT'}, meta: {message_parts: parts}};
    f.context.error = f.run('requestError(response)');
    assert.equal(f.context.error.messageParts, undefined);
    assert.ok(f.run('errorMessage(error)').includes('ORIGINAL-NATIVE-TEXT'));
  }
  const result = errorResult(
    new MirrorError('INVALID_PARAMETER', 'Unknown gateway.', {field: '<script>native instruction</script>'}),
    'ref',
    0,
  );
  const f = accountWorkflowFixture('ar');
  f.context.response = result;
  f.context.error = f.run('requestError(response)');
  assert.ok(f.run('errorMessage(error)').includes('<script>native instruction</script>'));
  assert.ok(f.run('esc(errorMessage(error))').includes('&lt;script&gt;native instruction&lt;/script&gt;'));
});
