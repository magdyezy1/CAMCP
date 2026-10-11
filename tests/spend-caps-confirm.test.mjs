import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy, checkSpendPolicy} from '../dist/src/spend-policy.js';

/**
 * Owner decision (2026-09-28): a spending cap asks the user instead of refusing. `enforcement: 'confirm'` is the
 * default; prepare names the exceeded caps and execute needs cap_override_confirmed=true. `block` keeps a hard cap.
 */
const TIKTOK = '13131313-1313-4131-8131-131313131313',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'spend-caps', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 71).toString('base64');

function fixture() {
  const store = new Store(':memory:', key);
  store.putConnection(
    owner,
    {
      id: TIKTOK,
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const groups = new Map([
      [
        '700',
        {
          adgroup_id: '700',
          campaign_id: '70',
          advertiser_id: account,
          adgroup_name: 'Lifetime A',
          budget_mode: 'BUDGET_MODE_TOTAL',
          budget: 1000,
          scheduled_budget: 0,
          campaign_automation_type: 'MANUAL',
          operation_status: 'DISABLE',
        },
      ],
    ]),
    writes = [];
  let n = 0;
  const transport = new NativeTransport(async (raw, init = {}) => {
    const url = new URL(String(raw)),
      path = url.pathname,
      method = init.method ?? 'GET';
    if (method === 'GET' && path === '/open_api/v1.3/adgroup/get/') {
      const ids = JSON.parse(url.searchParams.get('filtering')).adgroup_ids,
        list = ids.filter(id => groups.has(id)).map(id => groups.get(id));
      return Response.json({
        code: 0,
        message: 'OK',
        request_id: 'r' + ++n,
        data: {list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}},
      });
    }
    if (method === 'POST' && path === '/open_api/v1.3/adgroup/budget/update/') {
      writes.push(JSON.parse(init.body));
      for (const r of JSON.parse(init.body).budget)
        groups.set(r.adgroup_id, {...groups.get(r.adgroup_id), budget: r.budget});
      return Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data: {}});
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
  });
  const call = input => service.call('amcp_write', input, actor);
  const prepare = budget =>
    call({
      action: 'prepare',
      gateway,
      connection_id: TIKTOK,
      arguments: {
        action: 'tiktok_adgroup_budget_update',
        account_id: account,
        payload: {budget: [{adgroup_id: '700', budget}]},
      },
    });
  const execute = (id, extra = {}) =>
    call({action: 'execute', review_id: id, confirmed: true, spend_change_confirmed: true, ...extra});
  const policy = p => saveSpendPolicy(store, owner, {gateway, account_id: account, confirmed: true, policy: p});
  return {store, writes, prepare, execute, policy};
}

test('a budget above the cap is prepared with a warning and runs once the user confirms', async () => {
  const f = fixture();
  try {
    f.policy({max_budget_native: 950});
    const r = await f.prepare(1200);
    assert.equal(r.success, true, JSON.stringify(r.error));
    const policy = r.data.spend_policy;
    assert.equal(policy.enforcement, 'confirm');
    assert.equal(policy.cap_override_required, true);
    assert.equal(policy.exceeded[0].rule, 'POLICY_BUDGET_LIMIT');
    assert.match(policy.exceeded_summary, /1200 is above the cap of 950/);
    const req = r.data.execute_requirements;
    assert.equal(req.cap_override_confirmed, true);
    assert.match(req.reasons.find(x => x.flag === 'cap_override_confirmed').reason, /not refused; the user decides/);
    // Without the acknowledgement nothing is sent, and the refusal says how to go on.
    const refused = await f.execute(r.data.review_id);
    assert.equal(refused.error.code, 'CAP_CONFIRMATION_REQUIRED');
    assert.equal(refused.error.category, 'confirmation');
    assert.match(refused.error.remedy.action, /cap_override_confirmed=true/);
    assert.equal(f.writes.length, 0);
    const done = await f.execute(r.data.review_id, {cap_override_confirmed: true});
    assert.equal(done.success, true, JSON.stringify(done.error));
    assert.equal(f.writes.length, 1);
    const audit = f.store.audit(actor.tenantId, 1000).map(row => JSON.parse(row.event));
    const override = audit.find(e => e.event === 'spend_cap_exceeded_with_confirmation');
    assert.equal(override.exceeded[0].rule, 'POLICY_BUDGET_LIMIT');
  } finally {
    f.store.close();
  }
});

test('a percentage cap asks too, and a change within every cap asks nothing extra', async () => {
  const f = fixture();
  try {
    f.policy({max_budget_increase_percent: 10});
    const over = await f.prepare(1200);
    assert.match(over.data.spend_policy.exceeded_summary, /raising 1000 to 1200 is more than the 10% increase cap/);
    const within = await f.prepare(1050);
    assert.equal(within.data.spend_policy.exceeded, undefined);
    assert.equal(within.data.execute_requirements.cap_override_confirmed, false);
    assert.equal((await f.execute(within.data.review_id)).success, true);
  } finally {
    f.store.close();
  }
});

test('enforcement block keeps a hard cap', async () => {
  const f = fixture();
  try {
    f.policy({max_budget_native: 950, enforcement: 'block'});
    const r = await f.prepare(1200);
    assert.equal(r.error.code, 'POLICY_BUDGET_LIMIT');
    assert.equal(f.writes.length, 0);
    assert.throws(() => f.policy({max_budget_native: 950, enforcement: 'strict'}), {code: 'INVALID_POLICY'});
  } finally {
    f.store.close();
  }
});

test('the bid cap compares bid fields and money objects under a bid', () => {
  const store = new Store(':memory:', key);
  try {
    for (const [gw, id] of [
      ['google_ads_native_action', '1234567890'],
      ['linkedin_native_action', '507404993'],
    ])
      store.putConnection(
        owner,
        {
          id: gw,
          tenantId: actor.tenantId,
          gateway: gw,
          accounts: [id],
          writeAccounts: [id],
          enabled: true,
          label: gw,
          scopes: [],
        },
        {accessToken: 'synthetic'},
      );
    const plan = (gw, id, body) => ({
      gateway: gw,
      action: 'fixture',
      method: 'POST',
      path: '/fixture',
      query: {},
      headers: {},
      body,
      accountId: id,
      readOnly: false,
      destructive: false,
      requiresConfirmation: true,
      evidence: 'fixture',
      warnings: [],
    });
    saveSpendPolicy(store, owner, {
      gateway: 'google_ads_native_action',
      account_id: '1234567890',
      confirmed: true,
      policy: {max_bid_native: 2000000},
    });
    const google = checkSpendPolicy(
      store,
      actor,
      plan('google_ads_native_action', '1234567890', {
        operations: [{create: {cpcBidMicros: '5000000', status: 'PAUSED'}}],
      }),
      [],
    );
    assert.equal(google.exceeded[0].rule, 'POLICY_BID_LIMIT');
    assert.match(google.exceeded_summary, /bid 5000000 is above the bid cap of 2000000/);
    saveSpendPolicy(store, owner, {
      gateway: 'linkedin_native_action',
      account_id: '507404993',
      confirmed: true,
      policy: {max_bid_currency: 5, enforcement: 'block'},
    });
    assert.throws(
      () =>
        checkSpendPolicy(
          store,
          actor,
          plan('linkedin_native_action', '507404993', {unitCost: {amount: '7.50', currencyCode: 'USD'}}),
          [],
        ),
      {code: 'POLICY_BID_LIMIT'},
    );
    assert.doesNotThrow(() =>
      checkSpendPolicy(
        store,
        actor,
        plan('linkedin_native_action', '507404993', {unitCost: {amount: '4.00', currencyCode: 'USD'}}),
        [],
      ),
    );
  } finally {
    store.close();
  }
});

test('caps can be stated in account currency where the platform unit is documented', () => {
  const f = fixture();
  try {
    f.store.putConnection(
      owner,
      {
        id: 'google',
        tenantId: actor.tenantId,
        gateway: 'google_ads_native_action',
        accounts: ['1234567890'],
        writeAccounts: [],
        enabled: true,
        label: 'Google',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    const saved = saveSpendPolicy(f.store, owner, {
      gateway: 'google_ads_native_action',
      account_id: '1234567890',
      confirmed: true,
      policy: {max_budget_currency: 50.5},
    });
    assert.equal(saved.max_budget_native, 50500000);
    assert.equal(saved.native_unit.unit, 'micros');
    // TikTok's unit is not documented in AMCP, so its caps stay native.
    assert.throws(
      () => f.policy({max_budget_currency: 50}),
      e => e.code === 'INVALID_POLICY' && /max_budget_native/.test(e.message),
    );
    const workspace = saveSpendPolicy(f.store, owner, {
      scope: 'workspace',
      confirmed: true,
      policy: {per_gateway: {google_ads_native_action: {max_budget_currency: 100}}, max_budget_increase_percent: 50},
    });
    assert.equal(workspace.per_gateway.google_ads_native_action.max_budget_native, 100000000);
    // WRT-07: a currency cap that names no currency would compare a KWD and a JPY account with the same number. It
    // still applies, and the owner is told; naming the currency clears the warning.
    assert.deepEqual(
      workspace.warnings.map(w => [w.code, w.gateways]),
      [['POLICY_CURRENCY_UNSET', ['google_ads_native_action']]],
    );
    const bound = saveSpendPolicy(f.store, owner, {
      scope: 'workspace',
      confirmed: true,
      expected_revision: workspace.revision,
      policy: {
        per_gateway: {google_ads_native_action: {max_budget_currency: 100, currency: 'USD'}},
        max_budget_increase_percent: 50,
      },
    });
    assert.equal(bound.per_gateway.google_ads_native_action.currency, 'USD');
    assert.equal(bound.warnings, undefined);
    assert.throws(
      () => saveSpendPolicy(f.store, owner, {scope: 'workspace', confirmed: true, policy: {max_budget_currency: 100}}),
      {code: 'INVALID_POLICY'},
    );
    const legacy = saveSpendPolicy(f.store, owner, {
      scope: 'workspace',
      confirmed: true,
      policy: {max_budget_native: 500},
    });
    assert.match(legacy.warnings[0].message, /one native amount to every platform/);
  } finally {
    f.store.close();
  }
});
