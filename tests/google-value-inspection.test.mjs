import test from 'node:test';
import assert from 'node:assert/strict';
import {valueInspectionFixture} from './fixtures/google-value-inspection-data.mjs';

const dep = (r, id) => r.data.dependencies.find(d => d.id === id);
const inspected = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data.conversion_goal_inspection;
};

test('both value recipes repeatedly inspect exact current primary defaults without establishing delivery or return', async t => {
  for (const recipe of ['google_search_conversion_value', 'google_search_target_roas']) {
    const f = valueInspectionFixture(t),
      r = await f.call({
        recipe,
        business: {...f.business, ...(recipe.endsWith('conversion_value') ? {target_roas: undefined} : {})},
      }),
      p = inspected(r);
    assert.equal(p.complete, true);
    assert.equal(p.value_settings_selected, true);
    assert.equal(dep(r, 'conversion_value_configuration').status, 'ready');
    assert.deepEqual(p.primary_actions[0].value_settings, {
      default_value: 7.25,
      default_currency_code: 'SAR',
      always_use_default_value: false,
    });
    assert.equal(p.scope.currency, 'USD', 'Conversion currency is preserved rather than replaced by account currency');
    assert.equal(p.summary.primary_value_settings_known, 1);
    assert.equal(p.summary.primary_value_settings_unknown, 0);
    const reads = p.source_references.filter(x => x.resource === 'conversion_action');
    assert.equal(reads.length, 2);
    for (const ref of reads)
      for (const field of ['default_value', 'default_currency_code', 'always_use_default_value'])
        assert.match(ref.request.query, new RegExp('conversion_action.value_settings.' + field));
    for (const id of ['conversion_value_delivery', 'conversion_history_eligibility', 'provider_objective_acceptance'])
      assert.equal(dep(r, id).status, 'unknown');
    assert.equal(r.data.provider_mutations, 0);
    assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
  }
});

test('explicit false and zero are known while optional absent or null settings remain unknown', async t => {
  const complete = {defaultValue: 0, defaultCurrencyCode: 'USD', alwaysUseDefaultValue: false};
  const zero = valueInspectionFixture(t, {settings: () => complete}),
    r = await zero.call();
  assert.equal(dep(r, 'conversion_value_configuration').status, 'ready');
  assert.deepEqual(inspected(r).primary_actions[0].value_settings, {
    default_value: 0,
    default_currency_code: 'USD',
    always_use_default_value: false,
  });
  for (const value of [
    undefined,
    null,
    {},
    ...Object.keys(complete).map(key => Object.fromEntries(Object.entries(complete).filter(([k]) => k !== key))),
    {defaultValue: null, defaultCurrencyCode: 'USD', alwaysUseDefaultValue: true},
  ]) {
    const f = valueInspectionFixture(t, {settings: () => value}),
      out = await f.call(),
      p = inspected(out);
    assert.equal(p.complete, true);
    assert.equal(dep(out, 'primary_conversion_actions').status, 'ready');
    assert.equal(dep(out, 'conversion_value_configuration').status, 'unknown');
    assert.equal(p.summary.primary_value_settings_unknown, 1);
  }
});

test('unqualified value shapes, coercion, bounds and unselected fields never produce a ready configuration', async t => {
  const valid = {defaultValue: 7.25, defaultCurrencyCode: 'USD', alwaysUseDefaultValue: true};
  for (const value of [
    [],
    false,
    'values',
    {...valid, defaultValue: '7.25'},
    {...valid, defaultValue: -1},
    {...valid, defaultValue: 1e12 + 1},
    {...valid, defaultCurrencyCode: 'usd'},
    {...valid, alwaysUseDefaultValue: 'false'},
    {...valid, unselected: 'source'},
    // A resource name belongs to the FROM resource of the row (r25-mf-goals), never to its value settings.
    {...valid, resourceName: 'customers/123/conversionActions/1'},
  ]) {
    const f = valueInspectionFixture(t, {settings: () => value}),
      r = await f.call(),
      p = inspected(r);
    assert.equal(p.complete, false, JSON.stringify(value));
    assert.equal(dep(r, 'conversion_value_configuration').status, 'unknown');
    assert.equal(dep(r, 'primary_conversion_actions').status, 'unknown');
    assert.equal(r.data.provider_mutations, 0);
  }
});

test('changed value settings across complete native collections cannot retain the first ready proof', async t => {
  const f = valueInspectionFixture(t, {
      settings: (_, read) => ({
        defaultValue: read === 1 ? 7.25 : 7.5,
        defaultCurrencyCode: 'USD',
        alwaysUseDefaultValue: true,
      }),
    }),
    r = await f.call(),
    p = inspected(r);
  assert.equal(p.complete, false);
  assert.equal(p.error.code, 'GOOGLE_GOAL_INSPECTION_CHANGED');
  assert.equal(dep(r, 'conversion_value_configuration').status, 'unknown');
  assert.equal(dep(r, 'account_default_conversion_goals').status, 'unknown');
  assert.equal(r.data.provider_mutations, 0);
});

test('reader and disabled-write configuration reads preserve current-key and connection revocation boundaries', async t => {
  const f = valueInspectionFixture(t, {allowWrites: false}),
    reader = {...f.actor, role: 'reader'},
    r = await f.call({}, reader);
  assert.equal(inspected(r).complete, true);
  assert.equal(dep(r, 'conversion_value_configuration').status, 'ready');
  assert.equal(r.data.status, 'blocked');
  assert.ok(r.data.blockers.length > 0);
  assert.equal(r.data.provider_mutations, 0);
  const key = f.store.createKey(f.actor),
    actor = f.store.authenticate(key);
  f.store.revokeKey(key);
  const before = f.data.requests.length;
  assert.equal((await f.call({}, actor)).success, false);
  assert.equal(f.data.requests.length, before);
  const revoked = valueInspectionFixture(t, {
    afterResponse: ({store, admin, connection, valueReads}) => {
      if (valueReads === 1)
        store.putConnection(
          admin,
          {...connection, enabled: false},
          {accessToken: 'synthetic', developerToken: 'synthetic'},
        );
    },
  });
  assert.equal((await revoked.call()).success, false);
  assert.equal(revoked.store.documents(revoked.actor.tenantId, 'campaign_run').length, 0);
});

test('complete primary collections control value readiness beyond the twenty displayed actions', async t => {
  for (const missing of [false, true]) {
    const f = valueInspectionFixture(t, {
      data: {pageSize: 5},
      settings: a =>
        missing && a.resourceName.endsWith('/34')
          ? undefined
          : {defaultValue: 7.25, defaultCurrencyCode: 'USD', alwaysUseDefaultValue: true},
    });
    f.data.actions.splice(
      0,
      f.data.actions.length,
      ...Array.from({length: 25}, (_, i) => f.data.action(String(i + 10), 'PURCHASE', true)),
    );
    const r = await f.call(),
      p = inspected(r);
    assert.equal(p.complete, true);
    assert.equal(p.primary_actions.length, 20);
    assert.equal(p.summary.matching_primary_actions, 25);
    assert.equal(p.display_omissions.primary_actions, 5);
    assert.equal(p.summary.primary_value_settings_unknown, missing ? 1 : 0);
    assert.equal(dep(r, 'conversion_value_configuration').status, missing ? 'unknown' : 'ready');
  }
});

test('unknown primary flags and shared or manager tracking never imply complete value readiness', async t => {
  const unknown = valueInspectionFixture(t);
  unknown.data.actions[1].primaryForGoal = undefined;
  assert.equal(dep(await unknown.call(), 'conversion_value_configuration').status, 'unknown');
  for (const customer of [
    {manager: true},
    {conversionTrackingSetting: {googleAdsConversionCustomer: 'customers/999'}},
    {conversionTrackingSetting: {}},
  ]) {
    const f = valueInspectionFixture(t, {data: {customer}}),
      r = await f.call();
    assert.equal(inspected(r).complete, false);
    assert.equal(dep(r, 'conversion_value_configuration').status, 'unknown');
    assert.ok(!f.data.requests.some(x => x.resource === 'conversion_action'));
  }
});

test('local inspection and conversion-count recipes do not select value settings or change their original contract', async t => {
  const local = valueInspectionFixture(t),
    r = await local.call({live: false});
  assert.equal(r.success, true);
  assert.equal(dep(r, 'conversion_value_configuration').status, 'unknown');
  assert.equal(local.data.requests.length, 0);
  const f = valueInspectionFixture(t),
    out = await f.call({
      recipe: 'google_search_conversions',
      business: {...f.business, target_roas: undefined, conversion_value_policy: undefined},
    }),
    p = inspected(out);
  assert.equal(p.complete, true);
  assert.equal(p.value_settings_selected, undefined);
  assert.equal(dep(out, 'conversion_value_configuration'), undefined);
  assert.ok(f.data.requests.every(r => !r.body.query.includes('value_settings')));
  assert.equal(p.primary_actions[0].value_settings, undefined);
});
