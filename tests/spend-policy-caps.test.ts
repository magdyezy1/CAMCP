import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {assertWriteShape} from '../src/write-review.js';
import {saveSpendPolicy, checkSpendPolicy} from '../src/spend-policy.js';
import type {Actor, CompiledRequest, JsonObject} from '../src/types.js';

const key = Buffer.alloc(32, 70).toString('base64'),
  actor: Actor = {tenantId: 'cap-policy', userId: 'owner', role: 'admin'};
const linkedin = 'linkedin_native_action',
  snapchat = 'snapchat_native_action';
const native = (gateway: string, body: JsonObject | JsonObject[]): CompiledRequest => ({
  gateway,
  accountId: '123',
  action:
    gateway === snapchat
      ? 'snapchat_campaign_update'
      : 'linkedin_rest_ad_accounts_ad_account_id_ad_campaign_groups_campaign_group_id_post',
  method: gateway === snapchat ? 'PATCH' : 'POST',
  path: gateway === snapchat ? '/v1/adaccounts/123/campaigns/111' : '/rest/adAccounts/123/adCampaignGroups/111',
  headers: gateway === linkedin ? {'X-RestLi-Method': 'PARTIAL_UPDATE'} : {},
  query: {},
  body,
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  evidence: 'synthetic native budget cap',
  warnings: [],
});
const baseline = [
  {
    dailyBudget: {amount: '100', currencyCode: 'USD'},
    totalBudget: {amount: '100', currencyCode: 'USD'},
    daily_budget_micro: '100000000',
    lifetime_spend_cap_micro: '100000000',
  },
];
const setup = (policy: JsonObject) => {
  const s = new Store(':memory:', key);
  saveSpendPolicy(s, actor, {scope: 'workspace', confirmed: true, policy});
  return s;
};
const clearing: [string, string, JsonObject | JsonObject[]][] = [
  ['REST.li delete budget', linkedin, {patch: {$delete: ['totalBudget']}}],
  ['REST.li nested delete amount', linkedin, {patch: {totalBudget: {$delete: ['amount']}}}],
  ['REST.li null budget', linkedin, {patch: {$set: {totalBudget: null}}}],
  ['REST.li null amount', linkedin, {patch: {$set: {totalBudget: {amount: null}}}}],
  ['REST.li empty money record', linkedin, {patch: {$set: {totalBudget: {}}}}],
  ['REST.li false budget', linkedin, {patch: {$set: {totalBudget: false}}}],
  ['JSON Patch remove budget', snapchat, [{op: 'remove', path: '/daily_budget_micro'}]],
  ['JSON Patch remove lifetime cap', snapchat, [{op: 'remove', path: '/lifetime_spend_cap_micro'}]],
  ['JSON Patch null lifetime cap', snapchat, [{op: 'replace', path: '/lifetime_spend_cap_micro', value: null}]],
  ['JSON Patch false lifetime cap', snapchat, [{op: 'replace', path: '/lifetime_spend_cap_micro', value: false}]],
];
test('every numeric owner policy rejects unquantified budget clearing', () => {
  for (const [label, gateway, body] of clearing)
    for (const policy of [
      {enforcement: 'block', max_budget_native: 200000000},
      {enforcement: 'block', max_budget_increase_percent: 10},
      {enforcement: 'block', max_daily_increase_native: 10000000},
    ]) {
      const s = setup(policy);
      try {
        const plan = native(gateway, body);
        assertWriteShape(plan);
        assert.throws(() => checkSpendPolicy(s, actor, plan, baseline), {code: 'POLICY_AMOUNT_UNSUPPORTED'}, label);
      } finally {
        s.close();
      }
    }
});
test('Snapchat lifetime spend caps enforce native microcurrency maxima, percentages and cumulative amounts', () => {
  const s = setup({
    enforcement: 'block',
    max_budget_native: 200000000,
    max_budget_increase_percent: 10,
    max_daily_increase_native: 10000000,
  });
  try {
    const change = (value: string) => native(snapchat, [{op: 'replace', path: '/lifetime_spend_cap_micro', value}]);
    assert.throws(() => checkSpendPolicy(s, actor, change('999000000'), baseline), {code: 'POLICY_BUDGET_LIMIT'});
    assert.throws(() => checkSpendPolicy(s, actor, change('111000000'), baseline), {code: 'POLICY_INCREASE_LIMIT'});
    assert.equal(
      checkSpendPolicy(s, actor, change('110000000'), baseline, 'one').requested_increase_decimal,
      '10000000',
    );
    assert.throws(() => checkSpendPolicy(s, actor, change('101000000'), baseline, 'two'), {
      code: 'POLICY_DAILY_INCREASE_LIMIT',
    });
  } finally {
    s.close();
  }
});
test('JSON Patch tests are assertions, not spending changes, even next to a real mutation', () => {
  const s = setup({
    enforcement: 'block',
    max_budget_native: 200000000,
    max_budget_increase_percent: 10,
    max_daily_increase_native: 10000000,
  });
  try {
    const assertion = {op: 'test', path: '/daily_budget_micro', value: '900000000'};
    assert.equal(checkSpendPolicy(s, actor, native(snapchat, [assertion]), baseline).requested_increase_decimal, '0');
    assert.equal(
      checkSpendPolicy(
        s,
        actor,
        native(snapchat, [assertion, {op: 'replace', path: '/lifetime_spend_cap_micro', value: '110000000'}]),
        baseline,
      ).requested_increase_decimal,
      '10000000',
    );
  } finally {
    s.close();
  }
});
test('nonmonetary edits and policies without numeric limits retain their existing behavior', () => {
  const s = setup({enforcement: 'block', max_budget_native: 200000000});
  try {
    for (const body of [
      {patch: {$delete: ['name']}},
      {patch: {$set: {name: null}}},
      {patch: {totalBudget: {$delete: ['name']}}},
    ])
      assert.equal(checkSpendPolicy(s, actor, native(linkedin, body), baseline).requested_increase_decimal, '0');
    assert.equal(
      checkSpendPolicy(s, actor, native(snapchat, [{op: 'remove', path: '/name'}]), baseline)
        .requested_increase_decimal,
      '0',
    );
    saveSpendPolicy(s, actor, {
      scope: 'workspace',
      confirmed: true,
      policy: {allow_activation: false, allow_deletion: false},
    });
    assert.equal(
      checkSpendPolicy(s, actor, native(linkedin, {patch: {$delete: ['totalBudget']}}), baseline)
        .requested_increase_decimal,
      '0',
    );
  } finally {
    s.close();
  }
});
test('Snapchat POST and collection PUT use the same lifetime cap unit mapping', () => {
  const s = setup({enforcement: 'block', max_budget_native: 200000000, max_budget_increase_percent: 10});
  try {
    const create: CompiledRequest = {
      ...native(snapchat, {}),
      action: 'snapchat_campaign_create',
      method: 'POST',
      path: '/v1/adaccounts/123/campaigns',
      body: {
        campaigns: [{name: 'Synthetic', ad_account_id: '123', status: 'PAUSED', lifetime_spend_cap_micro: '150000000'}],
      },
    };
    assertWriteShape(create);
    assert.equal(checkSpendPolicy(s, actor, create, []).requested_increase_decimal, '150000000');
    const update: CompiledRequest = {
      ...create,
      action: 'snapchat_campaign_replace',
      method: 'PUT',
      body: {
        campaigns: [
          {id: '111', name: 'Synthetic', ad_account_id: '123', status: 'PAUSED', lifetime_spend_cap_micro: '110000000'},
        ],
      },
    };
    assertWriteShape(update);
    assert.equal(checkSpendPolicy(s, actor, update, baseline).requested_increase_decimal, '10000000');
  } finally {
    s.close();
  }
});

const registry = new Registry();
function fixture(gateway: string, policy?: JsonObject) {
  const store = new Store(':memory:', key),
    connection = {
      id: 'login',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    };
  store.putConnection(actor, connection, {accessToken: 'fixture'});
  store.rememberResource(connection, '123', gateway === snapchat ? 'campaigns/111' : '111');
  let writes = 0,
    currentCap = '100000000';
  if (policy) saveSpendPolicy(store, actor, {scope: 'workspace', confirmed: true, policy});
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport((async (input, init) => {
      if (init!.method !== 'GET') {
        writes++;
        return gateway === linkedin
          ? new Response(null, {status: 204})
          : new Response(
              JSON.stringify({
                request_status: 'SUCCESS',
                campaigns: [
                  {sub_request_status: 'SUCCESS', campaign: {id: '111', ad_account_id: '123', status: 'PAUSED'}},
                ],
              }),
            );
      }
      const path = new URL(String(input)).pathname,
        id = path.split('/').at(-1)!;
      if (gateway === linkedin)
        return new Response(
          JSON.stringify({id: Number(id), account: 'urn:li:sponsoredAccount:123', status: 'PAUSED', ...baseline[0]}),
        );
      const kind = path.split('/').at(-2)!,
        record = {
          id,
          ...(kind === 'campaigns' ? {ad_account_id: '123'} : {}),
          status: 'PAUSED',
          ...baseline[0],
          lifetime_spend_cap_micro: currentCap,
        };
      return new Response(
        JSON.stringify({
          request_status: 'SUCCESS',
          [kind]: [{sub_request_status: 'SUCCESS', [kind === 'adaccounts' ? 'adaccount' : 'campaign']: record}],
        }),
      );
    }) as typeof fetch),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  );
  const prepare = (body: JsonObject | JsonObject[]) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action:
            gateway === snapchat
              ? 'snapchat_campaign_update'
              : 'linkedin_rest_ad_accounts_ad_account_id_ad_campaign_groups_campaign_group_id_post',
          account_id: '123',
          path_params: gateway === snapchat ? {campaign_id: '111'} : {campaign_group_id: '111'},
          ...(gateway === linkedin ? {restli_method: 'PARTIAL_UPDATE'} : {}),
          payload: body,
        },
      },
      actor,
    );
  const execute = (review: JsonObject) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: review.data.review_id,
        idempotency_key: review.data.idempotency_key,
        confirmed: true,
        spend_change_confirmed: true,
      },
      actor,
    );
  return {
    store,
    prepare,
    execute,
    writes: () => writes,
    changeCap: (value: string) => {
      currentCap = value;
    },
  };
}
test('reviewed prepare and execution both enforce cap-removal policy with no mutation egress', async () => {
  for (const gateway of [linkedin, snapchat])
    for (const phase of ['prepare', 'execute']) {
      const f = fixture(
        gateway,
        phase === 'prepare' ? {enforcement: 'block', max_budget_native: 200000000} : undefined,
      );
      try {
        const r = await f.prepare(
          gateway === linkedin
            ? {patch: {$delete: ['totalBudget']}}
            : [{op: 'remove', path: '/lifetime_spend_cap_micro'}],
        );
        if (phase === 'prepare') assert.equal(r.error?.code, 'POLICY_AMOUNT_UNSUPPORTED', JSON.stringify(r));
        else {
          assert.equal(r.success, true, JSON.stringify(r));
          saveSpendPolicy(f.store, actor, {
            scope: 'workspace',
            confirmed: true,
            policy: {enforcement: 'block', max_daily_increase_native: 10000000},
          });
          const out = await f.execute(r);
          assert.equal(out.error?.code, 'POLICY_AMOUNT_UNSUPPORTED', JSON.stringify(out));
        }
        assert.equal(f.writes(), 0);
      } finally {
        f.store.close();
      }
    }
});
test('reviewed Snapchat finite lifetime cap updates succeed with native baseline units', async () => {
  const f = fixture(snapchat, {
    enforcement: 'block',
    max_budget_native: 200000000,
    max_budget_increase_percent: 10,
    max_daily_increase_native: 10000000,
  });
  try {
    const r = await f.prepare([{op: 'replace', path: '/lifetime_spend_cap_micro', value: '110000000'}]);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.spend_policy.requested_increase_decimal, '10000000');
    const out = await f.execute(r);
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
test('a real Snapchat lifetime-cap change still invalidates the immutable review', async () => {
  const f = fixture(snapchat, {enforcement: 'block', max_budget_native: 200000000, max_budget_increase_percent: 10});
  try {
    const r = await f.prepare([{op: 'replace', path: '/lifetime_spend_cap_micro', value: '110000000'}]);
    assert.equal(r.success, true, JSON.stringify(r));
    f.changeCap('101000000');
    const out = await f.execute(r);
    assert.equal(out.error?.code, 'STATE_CHANGED', JSON.stringify(out));
    assert.equal(f.writes(), 0);
    assert.match(JSON.stringify(out.error.details.changed_fields), /lifetime_spend_cap_micro/);
  } finally {
    f.store.close();
  }
});
