import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conversionMetadataFixture,
  conversionMetadataRule,
  conversionMetadataId,
  conversionMetadataAmount,
  conversionMetadataRequest,
} from './fixtures/linkedin-conversion-metadata-data.mjs';
const unchangedEffects = f => {
  for (const type of ['decision_report', 'conversion_rules', 'campaign_plan', 'write_review'])
    assert.equal(f.store.documents(f.owner.tenantId, type).length, 0);
};
function inspect(f, response, count) {
  assert.equal(response.success, true, JSON.stringify(response));
  const out = response.data;
  assert.equal(out.record_kind, 'conversion_rules');
  assert.deepEqual(out.collection_request, conversionMetadataRequest);
  assert.equal(out.scope.account_id, f.input.account_id);
  assert.equal(out.scope.connection_id, f.connectionId);
  assert.equal(out.complete, true);
  assert.equal(out.rule_count, count);
  assert.equal(out.rules.length, count);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(
    f.requests.map(r => r.path),
    ['/rest/adAccounts/100', '/rest/conversions', '/rest/adAccounts/100'],
  );
  assert.deepEqual(f.requests[1].query, {
    q: 'account',
    account: 'urn:li:sponsoredAccount:100',
    start: '0',
    count: '100',
  });
  assert.equal(out.account_evidence.currency, 'USD');
  assert.equal(out.account_evidence.checks.length, 2);
  assert.equal(out.source_pages.length, 1);
  assert.match(out.source_hash, /^[a-f0-9]{64}$/);
  for (const check of ['event_delivery', 'deduplication', 'consent', 'historical_attribution'])
    assert.equal(out.checks[check], 'unverified');
  assert.equal(out.checks.campaign_membership, 'not_collected');
  assert.equal(out.advertising_writes, 0);
  assert.equal(out.retained_snapshot, false);
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE-NATIVE-METADATA-|synthetic-conversion-metadata-secret/);
  assert.match(out.meaning, /shared rules were not requested/);
  unchangedEffects(f);
  return out;
}
test('LinkedIn method and ownership metadata keep native precision, query scope and unknown measurement states', async t => {
  const f = conversionMetadataFixture('owned');
  t.after(f.close);
  const input = JSON.stringify(f.input),
    out = inspect(f, await f.call(), 51);
  assert.equal(JSON.stringify(f.input), input);
  assert.equal(out.rules[0].id, conversionMetadataId);
  assert.equal(out.rules[0].conversion_method, 'CONVERSIONS_API');
  assert.equal(out.rules[0].ownership_type, 'OWNED');
  assert.equal(out.rules[0].enabled, false);
  assert.equal(out.rules[0].post_click_days, 30);
  assert.equal(out.rules[0].post_view_days, 7);
  assert.equal(out.rules[0].value.amount, conversionMetadataAmount);
  assert.equal(out.rules[0].value.currency, 'USD');
  assert.equal(out.rules[50].conversion_method, 'INSIGHT_TAG');
});
test('missing native metadata stays null and future or reported shared codes remain exact configuration values', async t => {
  const f = conversionMetadataFixture('unknown');
  t.after(f.close);
  const out = inspect(f, await f.call(), 3);
  assert.equal(out.rules[0].conversion_method, null);
  assert.equal(out.rules[0].ownership_type, null);
  assert.equal(out.rules[1].conversion_method, 'FUTURE_METHOD_<img>');
  assert.equal(out.rules[1].ownership_type, 'FUTURE_OWNERSHIP_<img>');
  assert.equal(out.rules[2].conversion_method, 'INSIGHT_TAG');
  assert.equal(out.rules[2].ownership_type, 'SHARED');
  assert.equal(out.collection_request.shared_rules_requested, false);
  assert.equal(out.checks.event_delivery, 'unverified');
});
test('bounded future metadata and returned whitespace are preserved without normalization or inferred defaults', async t => {
  const f = conversionMetadataFixture();
  t.after(f.close);
  f.setRows([
    conversionMetadataRule(0, {conversionMethod: 'M'.repeat(100), ownershipType: 'O'.repeat(100)}),
    conversionMetadataRule(1, {conversionMethod: ' FUTURE_METHOD ', ownershipType: ' FUTURE_OWNER '}),
    {id: '9007199254740995', account: 'urn:li:sponsoredAccount:100'},
  ]);
  const out = inspect(f, await f.call(), 3);
  assert.equal(out.rules[0].conversion_method, 'M'.repeat(100));
  assert.equal(out.rules[0].ownership_type, 'O'.repeat(100));
  assert.equal(out.rules[1].conversion_method, ' FUTURE_METHOD ');
  assert.equal(out.rules[1].ownership_type, ' FUTURE_OWNER ');
  for (const field of [
    'name',
    'type',
    'enabled',
    'conversion_method',
    'ownership_type',
    'post_click_days',
    'post_view_days',
    'attribution_type',
    'value_type',
    'value',
  ])
    assert.equal(out.rules[2][field], null);
});
for (const field of ['conversionMethod', 'ownershipType'])
  for (const [label, value] of [
    ['number', 0],
    ['boolean', false],
    ['null', null],
    ['object', {}],
    ['array', []],
    ['control', 'NUL\u0000'],
    ['over limit', 'M'.repeat(101)],
    ['empty', ''],
    ['whitespace', '   '],
  ])
    test('LinkedIn refuses ' + field + ' ' + label + ' before exposing partial configuration', async t => {
      const f = conversionMetadataFixture();
      t.after(f.close);
      f.setRows([conversionMetadataRule(), conversionMetadataRule(1, {[field]: value})]);
      const response = await f.call();
      assert.equal(response.success, false);
      assert.equal(response.error.code, 'MEASUREMENT_EVIDENCE_INVALID');
      assert.equal(response.error.message, 'LinkedIn returned an invalid conversion label or setting.');
      assert.equal(response.error.remedy.mutation_retry_safe, false);
      assert.equal(response.data, undefined);
      assert.equal(f.requests.length, 2);
      unchangedEffects(f);
    });
test('reported shared ownership does not authorize a conversion created in a foreign account', async t => {
  const f = conversionMetadataFixture();
  t.after(f.close);
  f.setRows([
    conversionMetadataRule(0, {
      account: 'urn:li:sponsoredAccount:999',
      ownershipType: 'SHARED',
      conversionMethod: 'CONVERSIONS_API',
    }),
  ]);
  const response = await f.call();
  assert.equal(response.success, false);
  assert.equal(response.error.code, 'MEASUREMENT_EVIDENCE_INVALID');
  assert.equal(f.requests.length, 2);
  unchangedEffects(f);
});
test('metadata inspection does not qualify the additional shared-rule collection filter', async t => {
  const f = conversionMetadataFixture();
  t.after(f.close);
  const response = await f.service.call(
    'linkedin_native_action',
    {
      action: 'linkedin_rest_conversions_get',
      connection_id: f.connectionId,
      account_id: '100',
      dry_run: false,
      query: {
        q: 'account',
        account: 'urn:li:sponsoredAccount:100',
        start: 0,
        count: 100,
        conversionOwnershipTypes: 'List(OWNED,SHARED)',
      },
    },
    f.actor,
  );
  assert.equal(response.success, false);
  assert.equal(f.requests.length, 0);
  unchangedEffects(f);
});
