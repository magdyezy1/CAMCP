import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {Actor} from '../src/types.js';

test('Meta inspect rejects documented legacy campaign fields locally without blocking ordinary objective-based creation', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 41).toString('base64')),
    actor: Actor = {tenantId: 't', userId: 'u', role: 'operator'};
  let egress = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      egress++;
      throw Error('No provider call in inspection');
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const inspect = (extra: Record<string, unknown>) =>
    service.call(
      'amcp_write',
      {
        action: 'inspect',
        gateway: 'meta_native_action',
        arguments: {
          action: 'meta_campaign_create',
          account_id: '123',
          payload: {
            name: 'Synthetic',
            objective: 'OUTCOME_SALES',
            status: 'PAUSED',
            special_ad_categories: [],
            // Required from Graph API v24.0 for a campaign whose budget is on its ad sets (CMP-01).
            is_adset_budget_sharing_enabled: false,
            ...extra,
          },
        },
      },
      actor,
    );
  try {
    for (const field of [
      {smart_promotion_type: 'AUTOMATED_SHOPPING_ADS'},
      {smart_promotion_type: 'SMART_APP_PROMOTION'},
      {existing_customer_budget_percentage: 0},
      {advantage_state: 'ADVANTAGE_PLUS_SALES'},
    ]) {
      const r = await inspect(field);
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(r.data.review_contract_supported, false);
      assert.equal(r.data.error.code, 'INVALID_META_CAMPAIGN');
      assert.deepEqual(r.data.error.details.fields, Object.keys(field));
    }
    const supported = await inspect({});
    assert.equal(supported.data.review_contract_supported, true, JSON.stringify(supported));
    assert.equal(egress, 0);
  } finally {
    store.close();
  }
});

// CMP-01 regression: before the fix a v26 ad-set-budget campaign create without is_adset_budget_sharing_enabled was
// reviewed and sent, and Meta refused it (error 4834011) only after the plan's image upload.
test('a v24+ Meta campaign create without a campaign budget needs an explicit is_adset_budget_sharing_enabled boolean, refused before any request', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 42).toString('base64')),
    actor: Actor = {tenantId: 't', userId: 'u', role: 'operator'};
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: 'c',
      tenantId: 't',
      gateway: 'meta_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  let egress = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      egress++;
      throw Error('No provider call for a refused campaign');
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const base = {name: 'Synthetic', objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: []};
  const call = (action: string, payload: Record<string, unknown>) =>
    service.call(
      'amcp_write',
      {action, gateway: 'meta_native_action', arguments: {action: 'meta_campaign_create', account_id: '123', payload}},
      actor,
    );
  try {
    for (const flag of [undefined, 'false', 0, null]) {
      const payload = flag === undefined ? base : {...base, is_adset_budget_sharing_enabled: flag};
      const inspected = await call('inspect', payload);
      assert.equal(inspected.data.review_contract_supported, false, JSON.stringify(inspected));
      assert.equal(inspected.data.error.code, 'INVALID_META_CAMPAIGN');
      assert.deepEqual(inspected.data.error.details.fields, ['is_adset_budget_sharing_enabled']);
      assert.match(inspected.data.error.details.source, /adset-budget-sharing/);
      assert.match(inspected.data.error.remedy.action, /recover_step/);
      const prepared = await call('prepare', payload);
      assert.equal(prepared.success, false);
      assert.equal(prepared.error.code, 'INVALID_META_CAMPAIGN');
      assert.match(prepared.error.next_action, /is_adset_budget_sharing_enabled/);
    }
    for (const value of [false, true])
      assert.equal(
        (await call('inspect', {...base, is_adset_budget_sharing_enabled: value})).data.review_contract_supported,
        true,
      );
    // A campaign budget (CBO) create is unaffected.
    for (const budget of [{daily_budget: '1000'}, {lifetime_budget: '50000'}])
      assert.equal((await call('inspect', {...base, ...budget})).data.review_contract_supported, true);
    assert.equal(egress, 0);
  } finally {
    store.close();
  }
});
