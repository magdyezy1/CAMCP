import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MirrorError, errorRemedy, errorResult} from '../dist/src/errors.js';

// r25-hotfix item 2, error 16 of the live checks of 2026-11-15: UPSTREAM_RESPONSE_INVALID told the caller to check access,
// scopes, tier and payload, but when AMCP's pinned schema for a route does not match what the provider answered, nothing
// in the request is the caller's to change. The remedy for that refusal (the one src/delegated-native.ts raises, which
// names its route's vendor method) now says what happened, where the mismatch is named, and what to do. Every other
// UPSTREAM_RESPONSE_INVALID keeps the remedy it had.
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
const schemaError = {
  instancePath: '/data/type',
  schemaPath: '#/properties/type/enum',
  keyword: 'enum',
  params: {allowedValues: ['MANAGED', 'SELF_SERVE']},
  message: 'must be equal to one of the allowed values',
};
const mismatches = [
  [
    'a published schema that the answer does not satisfy',
    new MirrorError(
      'UPSTREAM_RESPONSE_INVALID',
      'Vendor response does not satisfy its published JSON schema.',
      {errors: [schemaError], vendor_method: 'Get Ad Account'},
      502,
    ),
  ],
  [
    'a status the pinned contract does not document',
    new MirrorError(
      'UPSTREAM_RESPONSE_INVALID',
      'Vendor returned an undocumented successful status for this route.',
      {status: 202, vendor_method: 'Get Ad Account'},
      502,
    ),
  ],
];
// The remedy these shared refusals had, which other raisers of the code keep.
const oldRemedy =
  'Inspect the native error and request ID. Check account access, granted scopes, app access tier and payload against the named endpoint; HTTP status alone does not identify the cause.';

for (const [label, error] of mismatches)
  test('UPSTREAM_RESPONSE_INVALID for ' + label + ' says what happened, where it is named and what to do', () => {
    const remedy = errorRemedy(error);
    assert.notEqual(remedy.action, oldRemedy);
    // What happened.
    assert.match(remedy.action, /did not match AMCP’s pinned contract for this route/);
    // Where the mismatch is named.
    assert.match(remedy.action, /the details name the mismatch/);
    // That nothing the caller sends changes it, and what to do.
    assert.match(remedy.action, /A different request will not help/);
    assert.match(remedy.action, /Report these details to support/);
    // Never advice to correct access, scopes, tier or payload.
    assert.doesNotMatch(remedy.action, /account access|granted scopes|access tier|payload/i);
    // A write that reached the provider is never sent again.
    assert.match(remedy.action, /If this was a write, it may have been applied/);
    assert.match(remedy.action, /do not send it again/);
    // The shape of the remedy is as it was.
    assert.deepEqual(
      [remedy.category, remedy.owner, remedy.mutation_retry_safe],
      ['provider', 'provider_or_account_admin', false],
    );
    // What an MCP caller receives.
    const sent = errorResult(error, 'request-1', 1).error;
    assert.equal(sent.remedy.action, remedy.action);
    assert.equal(sent.next_action, remedy.action);
    assert.equal(sent.category, 'provider');
  });

test('every other UPSTREAM_RESPONSE_INVALID keeps its remedy', () => {
  const other = [
    new MirrorError('UPSTREAM_RESPONSE_INVALID', 'Synthetic.'),
    new MirrorError('UPSTREAM_RESPONSE_INVALID', 'Synthetic.', {errors: [schemaError]}),
    new MirrorError('UPSTREAM_RESPONSE_INVALID', 'Synthetic.', {vendor_method: 7}),
    new MirrorError('UPSTREAM_RESPONSE_INVALID', 'Synthetic.', {vendor_method: ''}),
    new MirrorError('UPSTREAM_RESPONSE_INVALID', 'Synthetic.', {status: 204}, 502),
  ];
  for (const error of other) assert.equal(errorRemedy(error).action, oldRemedy, JSON.stringify(error.details));
  // The same details on another code are that code's.
  assert.equal(
    errorRemedy(new MirrorError('UPSTREAM_ERROR', 'Synthetic.', {vendor_method: 'Get Ad Account'})).action,
    oldRemedy,
  );
});

test('the remedy has its Arabic string, and is not left as the English text', () => {
  const action = errorRemedy(mismatches[0][1]).action;
  assert.match(catalog[action] ?? '', /[؀-ۿ]/, 'Arabic for: ' + action);
  assert.notEqual(catalog[action], action);
  assert.equal(catalog[action], catalog[errorRemedy(mismatches[1][1]).action], 'one string serves both refusals');
});
