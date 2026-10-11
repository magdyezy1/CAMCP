import test from 'node:test';
import assert from 'node:assert/strict';
import {conversionActivityFixture} from './fixtures/google-conversion-activity-data.mjs';

// MSR-02: Google Ads conversion goals as a read-only Measurement task. The synthetic transport serves only selected
// account GAQL searches; it has no event, mutation or other-customer route.
function fixture(t, options = {}) {
  const f = conversionActivityFixture(t, options);
  return {
    ...f,
    goals: (input = {}, as = f.actor) =>
      f.service.call(
        'amcp_workspace',
        {
          action: 'measurement_google_goals',
          gateway: 'google_ads_native_action',
          connection_id: f.business.connection_id,
          account_id: f.business.account_id,
          ...input,
        },
        as,
      ),
  };
}
const documents = f =>
  f.store.db
    .prepare("SELECT COUNT(*) AS n FROM documents WHERE tenant_id=? AND kind <> 'service_timings'")
    .get(f.actor.tenantId).n;

test('MSR-02 Google Ads goals perform one bounded read-only inspection with value settings and activity', async t => {
  const f = fixture(t),
    before = documents(f),
    out = await f.goals();
  assert.equal(out.success, true, JSON.stringify(out));
  const d = out.data;
  assert.equal(d.record_kind, 'measurement_google_goals');
  assert.equal(d.complete, true);
  assert.equal(d.provider_mutations, 0);
  assert.equal(d.snapshot_saved, false);
  assert.deepEqual(d.scope, {
    gateway: 'google_ads_native_action',
    connection_id: f.business.connection_id,
    account_id: f.business.account_id,
    currency: 'USD',
    currency_source: 'observed',
  });
  assert.deepEqual(d.checks, {
    event_delivery: 'unverified',
    deduplication: 'unverified',
    consent: 'unverified',
    attribution: 'unverified',
  });
  assert.equal(d.dependency_statuses.account_default_conversion_goals, 'ready');
  assert.equal(d.dependency_statuses.primary_conversion_actions, 'ready');
  assert.equal(d.dependency_statuses.conversion_value_configuration, 'ready');
  assert.equal(d.dependency_statuses.reported_conversion_activity, 'ready');
  assert.equal(d.primary_actions.length, 1);
  assert.deepEqual(d.primary_actions[0].activity, {
    last_conversion_date: '2026-10-01',
    last_tag_received_time: '2026-10-02 13:14:15',
  });
  assert.equal(d.value_settings_selected, true);
  assert.equal(d.activity_selected, true);
  // Every request is a selected-account search; the count is bounded and reported.
  assert.ok(f.data.requests.length > 0 && f.data.requests.length <= 64);
  assert.equal(d.network_requests, f.data.requests.length);
  for (const r of f.data.requests)
    assert.match(r.path, new RegExp('/customers/' + f.business.account_id + '/googleAds:search$'));
  assert.equal(documents(f), before, 'nothing is saved');
  assert.equal(out.meta.workflow.website_path.startsWith('/measurement?google_goals=1&connection_id='), true);
  assert.match(out.meta.workflow.website_path, new RegExp('&account_id=' + f.business.account_id + '$'));
});

test('MSR-02 a declared currency that differs is labelled incomplete, never ready', async t => {
  const f = fixture(t),
    out = await f.goals({requirements: {currency: 'EUR'}});
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.data.complete, false);
  assert.equal(out.data.error.code, 'GOOGLE_GOAL_INSPECTION_INVALID');
  assert.equal(out.data.scope.currency_source, 'declared');
  assert.equal(out.data.goals, undefined);
  assert.equal(out.data.primary_actions, undefined);
  assert.equal(out.data.dependency_statuses.account_default_conversion_goals, 'unknown');
  assert.match(out.data.meaning, /could not be completely inspected/);
});

test('MSR-02 manager and shared-conversion customers are refused instead of guessed', async t => {
  for (const [customer, reason] of [
    [{manager: true}, 'manager_account'],
    [{conversionTrackingSetting: {googleAdsConversionCustomer: 'customers/999'}}, 'shared_conversion_customer'],
  ]) {
    const f = fixture(t, {data: {customer}}),
      out = await f.goals();
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.complete, false);
    assert.equal(out.data.reason, reason);
    assert.equal(out.data.goals, undefined);
    assert.equal(f.data.requests.length, 1, 'no other customer or collection is read');
  }
});

test('MSR-02 credential rotation, access withdrawal or a write pause mid-read refuses the response', async t => {
  const changes = [
    [
      'credential rotation',
      ({store, admin, connection}) =>
        store.putConnection(admin, connection, {accessToken: 'synthetic-rotated', developerToken: 'synthetic'}),
    ],
    [
      'account withdrawal',
      ({store, admin, connection}) =>
        store.putConnection(
          admin,
          {...connection, accounts: ['999'], writeAccounts: []},
          {
            accessToken: 'synthetic',
            developerToken: 'synthetic',
          },
        ),
    ],
    [
      'write pause',
      ({store, actor}) =>
        store.putDocument(actor.tenantId, 'write_pause', 'workspace', {
          paused: true,
          reason: 'synthetic',
          paused_at: 1,
        }),
    ],
  ];
  for (const [name, change] of changes) {
    let reads = 0;
    const f = fixture(t, {
        afterResponse: ctx => {
          if (++reads === 2) change(ctx);
        },
      }),
      out = await f.goals();
    assert.equal(out.success, false, name + ': ' + JSON.stringify(out));
    assert.equal(out.data, undefined, name);
    // The write pause is not a login change: only the measurement fence (MSR-02) can refuse it.
    if (name === 'write pause') assert.equal(out.error.code, 'STATE_CHANGED');
    assert.ok(f.data.requests.length <= 3, name + ': the next read stops');
  }
});

test('MSR-02 refusals happen before any provider request', async t => {
  const cases = [
    [{gateway: 'ga4_native_action'}, 'MEASUREMENT_GOALS_UNQUALIFIED'],
    [{requirements: {currency: 'usd'}}, 'INVALID_ARGUMENT'],
    [{requirements: {include_activity: false}}, 'INVALID_ARGUMENT'],
    [{account_id: 'not-a-customer'}, 'INVALID_ARGUMENT'],
  ];
  for (const [input, code] of cases) {
    const f = fixture(t),
      out = await f.goals(input);
    assert.equal(out.success, false, JSON.stringify(input));
    assert.equal(out.error.code, code, JSON.stringify(out.error));
    assert.equal(f.data.requests.length, 0);
  }
  const f = fixture(t),
    out = await f.goals({account_id: '9999999999'});
  assert.equal(out.success, false);
  assert.equal(out.error.code, 'CONNECTION_REQUIRED');
  assert.equal(f.data.requests.length, 0, 'an account not granted to the login is never read');
});
