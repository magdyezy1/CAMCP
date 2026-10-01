import test from 'node:test';
import assert from 'node:assert/strict';
import {previewPlaybook, validatePlaybook, expandTemplate} from '../src/client-playbooks.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {Registry} from '../src/catalog.js';
import {NativeTransport} from '../src/transport.js';
import {recipeContext} from '../src/recipe-context.js';
import type {Actor} from '../src/types.js';
test('playbook previews resolve the same template engine and encode UTMs without changing the approved profile', () => {
  const profile = {
    id: 'client',
    revision: 4,
    name: 'Client',
    naming: '{{market}} | {{campaign_name}}',
    variables: {market: 'EG'},
    utm: {utm_campaign: '{{campaign_name}}', utm_medium: 'paid social'},
    templates: {launch: [{id: 'one', arguments: {payload: {name: '{{profile.name}} {{campaign_name}}'}}}]},
  };
  const frozen = JSON.stringify(profile);
  const out = previewPlaybook(profile, {
    variables: {campaign_name: 'A&B / launch'},
    destination_url: 'https://example.com/landing?existing=yes#intro',
    template: 'launch',
  });
  assert.equal(out.naming, 'EG | A&B / launch');
  const url = new URL(out.destination_url);
  assert.equal(url.searchParams.get('utm_campaign'), 'A&B / launch');
  assert.equal(url.searchParams.get('existing'), 'yes');
  assert.equal(url.hash, '#intro');
  assert.equal(out.steps[0].arguments.payload.name, 'Client A&B / launch');
  assert.equal(JSON.stringify(profile), frozen);
  assert.equal(out.network_requests, 0);
  assert.throws(() =>
    previewPlaybook(profile, {variables: {campaign_name: 'x'}, destination_url: 'javascript:alert(1)'}),
  );
  assert.throws(() => expandTemplate('{{missing}}', {}), {code: 'REFERENCE_UNAVAILABLE'});
  assert.throws(() => expandTemplate('{{__proto__.x}}', {}));
});

test('an approved playbook limits recipe choices and campaign steps to its exact connection and account', async () => {
  const actor: Actor = {tenantId: 'playbook-binding', userId: 'owner', role: 'admin'};
  const store = new Store(':memory:', Buffer.alloc(32, 76).toString('base64'));
  let requests = 0;
  try {
    for (const id of ['selected', 'other'])
      store.putConnection(
        actor,
        {
          id,
          tenantId: actor.tenantId,
          gateway: 'meta_native_action',
          accounts: ['100', '200'],
          writeAccounts: ['100', '200'],
          enabled: true,
          label: id,
          scopes: [],
        },
        {accessToken: 'synthetic'},
      );
    store.putDocument(actor.tenantId, 'client_profile', 'profile', {
      name: 'Client',
      approved_by: actor.userId,
      bindings: [{gateway: 'meta_native_action', connection_id: 'selected', account_id: 'act_100'}],
    });
    const choices = recipeContext(store, actor, 'meta_website_traffic', 'profile');
    assert.equal(choices.targets.length, 1);
    assert.equal(choices.targets[0].connection_id, 'selected');
    assert.equal(choices.targets[0].account_id, '100');
    const service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => {
        requests++;
        throw Error('No egress');
      }),
    );
    const step = {
      id: 'campaign',
      kind: 'write',
      gateway: 'meta_native_action',
      connection_id: 'selected',
      account_id: '100',
      arguments: {
        action: 'meta_campaign_create',
        payload: {name: 'Draft', status: 'PAUSED', objective: 'OUTCOME_TRAFFIC', special_ad_categories: []},
      },
    };
    const create = (steps: unknown[]) =>
      service.call(
        'amcp_campaign',
        {
          action: 'create',
          name: 'Bound draft',
          brief: 'Synthetic test',
          profile_id: 'profile',
          steps,
        },
        actor,
      );
    assert.equal((await create([step])).success, true);
    for (const change of [{account_id: '200'}, {connection_id: 'other'}]) {
      const result = await create([{...step, ...change}]);
      assert.equal(result.success, false);
      assert.equal(result.error.code, 'PROFILE_ACCOUNT_MISMATCH');
    }
    assert.equal(requests, 0);
  } finally {
    store.close();
  }
});
test('typed playbooks reject malformed defaults, unknown UTM keys and unusable templates', () => {
  for (const p of [
    {defaults: []},
    {utm: {bad: 'value'}},
    {templates: {empty: []}},
    {defaults: {recipes: {bad: []}}},
    {variables: {secret: 'no'}},
  ])
    assert.throws(() => validatePlaybook(p));
  validatePlaybook({
    name: 'Client',
    defaults: {recipes: {google_search: {daily_budget: '25'}}},
    templates: {valid: [{id: 'campaign'}]},
  });
});
