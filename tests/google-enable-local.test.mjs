// R2.5 M3 (r25-m3-trees, G7): Google refuses `shopping_setting.enable_local: false` when a Shopping campaign is created
// (OPERATION_NOT_PERMITTED_FOR_CONTEXT, the owner's live refusal; the Google documentation names the field only as "the option to
// enable ads for products sold in local stores", so the rule is UNVERIFIED beyond Shopping). AMCP refuses it at prepare, with no
// provider request, in a one-service campaign create and in a build, in either spelling of the keys. A synthetic Google answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {account, at, google, shoppingBuild, shoppingCustomer} from './fixtures/google-shopping-build.mjs';

const campaignCreate = (setting, extra = {}) => ({
  name: 'DNU Standard Shopping',
  status: 'PAUSED',
  advertising_channel_type: 'SHOPPING',
  campaign_budget: at('campaignBudgets', '700'),
  manual_cpc: {},
  shopping_setting: setting,
  contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
  ...extra,
});
const camel = v =>
  Array.isArray(v)
    ? v.map(camel)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), camel(x)]),
        )
      : v;
const prepareCampaigns = (x, creates) =>
  x.call('amcp_write', {
    action: 'prepare',
    gateway: google,
    arguments: {
      action: 'google_ads_v23_campaign_mutate_campaigns',
      account_id: account,
      payload: {operations: creates.map(create => ({create}))},
    },
  });
const field = i => 'operations[' + i + '].create.shopping_setting.enable_local';

test('a Shopping campaign create with enable_local false is refused at prepare, in either spelling, naming the operation and the field; nothing is read or sent', async t => {
  const x = shoppingCustomer();
  t.after(() => x.store.close());
  const local = {merchant_id: '555', campaign_priority: 0, enable_local: false};
  for (const [label, create] of [
    ['snake_case', campaignCreate(local)],
    ['camelCase', camel(campaignCreate(local))],
  ]) {
    const r = await prepareCampaigns(x, [create]);
    assertRefused(r, 'INVALID_MUTATION', {writes: x.mutates.length, message: /OPERATION_NOT_PERMITTED_FOR_CONTEXT/});
    assert.match(r.error.message, /omit enable_local, or set it to true/, label);
    assert.equal(r.error.details.operation, 0, label);
    assert.equal(r.error.details.field, field(0), label);
    assert.equal(x.queries.length, 0, label + ': no reads');
  }
  // The operation that holds it is the one named, wherever it is in the request.
  const second = await prepareCampaigns(x, [
    campaignCreate({merchant_id: '555'}),
    campaignCreate(local, {name: 'DNU Second Shopping'}),
  ]);
  assertRefused(second, 'INVALID_MUTATION', {writes: x.mutates.length});
  assert.equal(second.error.details.operation, 1);
  assert.equal(second.error.details.field, field(1));
});

test('enable_local true or omitted, and any other channel, are as before', async t => {
  const x = shoppingCustomer();
  t.after(() => x.store.close());
  // The budget a one-service campaign create reads, which exists.
  const budget = at('campaignBudgets', '700');
  x.created.set(budget, {resource_name: budget, amount_micros: '30000000'});
  for (const setting of [
    {merchant_id: '555', campaign_priority: 0, enable_local: true},
    {merchant_id: '555', campaign_priority: 0},
  ]) {
    const r = await prepareCampaigns(x, [campaignCreate(setting)]);
    assert.equal(r.success, true, JSON.stringify(setting) + ': ' + JSON.stringify(r).slice(0, 600));
  }
  // The rule is Google's for Shopping campaigns; it is unverified for the others, so it is not applied to them.
  const pmax = await prepareCampaigns(x, [
    campaignCreate(
      {merchant_id: '555', enable_local: false},
      {advertising_channel_type: 'PERFORMANCE_MAX', manual_cpc: undefined, maximize_conversion_value: {}},
    ),
  ]);
  assert.equal(pmax.success, true, JSON.stringify(pmax).slice(0, 600));
});

test('a build meets the same refusal through its campaign operation, at mutate_operations[1], with no provider request', async t => {
  const x = shoppingCustomer();
  t.after(() => x.store.close());
  const local = {merchant_id: '555', campaign_priority: 0, enable_local: false};
  for (const [label, operations] of [
    ['snake_case', shoppingBuild({campaign: {shopping_setting: local}})],
    ['camelCase', camel(shoppingBuild({campaign: {shopping_setting: local}}))],
  ]) {
    const r = await x.call('amcp_write', {
      action: 'prepare',
      gateway: google,
      arguments: {
        action: 'google_ads_v23_google_ads_mutate',
        account_id: account,
        payload: label === 'camelCase' ? {mutateOperations: operations} : {mutate_operations: operations},
      },
    });
    assertRefused(r, 'INVALID_MUTATION', {
      writes: x.mutates.length,
      message: /^mutate_operations\[1\]: .*OPERATION_NOT_PERMITTED_FOR_CONTEXT/,
    });
    assert.equal(r.error.details.operation, 1, label);
    assert.equal(x.queries.length, 0, label + ': no reads');
  }
  // With the field omitted, or true, the same build is accepted.
  for (const setting of [
    {merchant_id: '555', campaign_priority: 0},
    {merchant_id: '555', campaign_priority: 0, enable_local: true},
  ]) {
    const ok = await x.prepare(shoppingBuild({campaign: {shopping_setting: setting}}));
    assert.equal(ok.success, true, JSON.stringify(setting) + ': ' + JSON.stringify(ok).slice(0, 600));
  }
});
