import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';

/**
 * Account-level TikTok brand safety (API for Business v1.3, checked 2026-09-26): the Pangle app block list and the Brand
 * Safety Hub defaults for future Upgraded Smart+ campaigns.
 */
const TIKTOK = '32323232-3232-4323-8323-323232323232',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'tiktok-brand-safety', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 91).toString('base64');
function fixture() {
  const store = new Store(':memory:', key),
    connection = {
      id: TIKTOK,
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    };
  store.putConnection(owner, connection, {accessToken: 'synthetic'});
  let apps = ['com.example.casino', '1234567890'],
    hub = {
      cover_all_ad_objectives: false,
      brand_safety_type: 'STANDARD_INVENTORY',
      category_exclusion_ids: ['201'],
      vertical_sensitivity_id: '1001',
    },
    writes = 0,
    mode = '',
    n = 0;
  const requests = [];
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const u = new URL(String(raw)),
      path = u.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET';
    requests.push(method + ' ' + path);
    if (path === '/v1.3/pangle_block_list/get/')
      return ok({
        app_list: n % 2 ? [...apps].reverse() : [...apps],
        app_package_id: '5000',
        modify_time: new Date(Date.now() + n).toISOString(),
      });
    if (path === '/v1.3/tiktok_inventory_filters/get/') return ok(structuredClone(hub));
    const b = JSON.parse(init.body);
    writes++;
    if (path === '/v1.3/pangle_block_list/update/') {
      const added = (b.add_app_list ?? []).filter(a => b.clear_old_app || !apps.includes(a));
      apps = [...(b.clear_old_app ? [] : apps.filter(a => !(b.delete_app_list ?? []).includes(a))), ...added];
      return ok({success_count: mode === 'short' ? added.length - 1 : added.length});
    }
    if (path === '/v1.3/tiktok_inventory_filters/update/') {
      hub = {
        ...hub,
        cover_all_ad_objectives: b.cover_all_ad_objectives,
        ...(b.brand_safety_type
          ? {
              brand_safety_type: b.brand_safety_type,
              category_exclusion_ids: b.category_exclusion_ids ?? [],
              vertical_sensitivity_id: b.vertical_sensitivity_id ?? '',
            }
          : {}),
      };
      return ok(structuredClone(hub));
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const prepare = (action, payload) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, connection_id: TIKTOK, arguments: {action, account_id: account, payload}},
      actor,
    );
  const pangle = payload => prepare('tiktok_pangle_block_list_update', payload),
    safety = payload => prepare('tiktok_tiktok_inventory_filters_update', payload);
  const execute = (p, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {
    store,
    requests,
    pangle,
    safety,
    execute,
    verify,
    apps: () => apps,
    hub: () => hub,
    setApps: a => {
      apps = a;
    },
    setHub: h => {
      hub = h;
    },
    writes: () => writes,
    mode: m => {
      mode = m;
    },
  };
}

test('blocking more Pangle apps only narrows delivery: no spending confirmation, one write, verified, and list order is not a change', async () => {
  const f = fixture();
  try {
    const p = await f.pangle({add_app_list: ['com.example.slots', '987654321']});
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 600));
    assert.equal(p.data.creative_impact.scope, 'pangle_block_list');
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    assert.equal(p.data.creative_impact.apps_after, 4);
    const e = await f.execute(p);
    assert.equal(e.success, true, JSON.stringify(e).slice(0, 600));
    assert.equal(f.writes(), 1);
    const v = await f.verify(p);
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 600));
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('unblocking or clearing Pangle apps needs spending confirmation, and each result verifies', async () => {
  const f = fixture();
  try {
    const d = await f.pangle({delete_app_list: ['1234567890']});
    assert.equal(d.success, true, JSON.stringify(d).slice(0, 500));
    assert.equal(d.data.creative_impact.may_affect_serving, true);
    assert.equal((await f.execute(d)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal((await f.execute(d, {spend_change_confirmed: true})).success, true);
    assert.equal((await f.verify(d)).data.status, 'verified');
    const c = await f.pangle({clear_old_app: true, add_app_list: ['com.example.only']});
    assert.equal(c.success, true, JSON.stringify(c).slice(0, 500));
    assert.equal((await f.execute(c, {spend_change_confirmed: true})).success, true);
    assert.equal((await f.verify(c)).data.status, 'verified');
    assert.deepEqual(f.apps(), ['com.example.only']);
    assert.equal(f.writes(), 2);
  } finally {
    f.store.close();
  }
});

test('absent and already blocked apps are refused after reading the list; malformed updates fail without network requests', async () => {
  const f = fixture();
  try {
    const absent = await f.pangle({delete_app_list: ['com.example.other']});
    assert.equal(absent.error?.code, 'STATE_NOT_FOUND');
    const existing = await f.pangle({add_app_list: ['com.example.casino']});
    assert.equal(existing.error?.code, 'CONFIGURATION_EXISTS');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  for (const [label, payload] of [
    ['not an app', {add_app_list: ['casino games']}],
    ['added and deleted', {add_app_list: ['com.example.a'], delete_app_list: ['com.example.a']}],
    ['clear with deletions', {clear_old_app: true, delete_app_list: ['com.example.casino']}],
    ['nothing to change', {}],
    ['unknown field', {add_app_list: ['com.example.a'], placement: 'PANGLE'}],
    ['string flag', {clear_old_app: 'true', add_app_list: ['com.example.a']}],
  ]) {
    const g = fixture();
    try {
      const r = await g.pangle(payload);
      assert.equal(r.error?.code, 'INVALID_TIKTOK_BRAND_SAFETY', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(g.requests.length, 0, label);
    } finally {
      g.store.close();
    }
  }
});

test('Brand Safety Hub settings are sent together, need confirmation, flag the irreversible all-objectives switch and verify', async () => {
  const f = fixture();
  try {
    const p = await f.safety({
      cover_all_ad_objectives: true,
      brand_safety_type: 'LIMITED_INVENTORY',
      category_exclusion_ids: ['202', '201'],
      vertical_sensitivity_id: '1002',
    });
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 700));
    const impact = p.data.creative_impact;
    assert.equal(impact.scope, 'brand_safety_hub');
    assert.match(impact.irreversible, /cannot be turned back off/);
    assert.deepEqual(impact.after.category_exclusion_ids, ['201', '202']);
    assert.equal((await f.execute(p)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal((await f.execute(p, {spend_change_confirmed: true})).success, true);
    assert.equal((await f.verify(p)).data.status, 'verified');
    const tier = await f.safety({cover_all_ad_objectives: true, brand_safety_type: 'EXPANDED_INVENTORY'});
    assert.equal(tier.success, true, JSON.stringify(tier).slice(0, 500));
    assert.equal(tier.data.creative_impact.irreversible, null);
    assert.equal((await f.execute(tier, {spend_change_confirmed: true})).success, true);
    assert.equal((await f.verify(tier)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('switching back from all objectives, no-op updates and incomplete or invalid settings are refused', async () => {
  const f = fixture();
  try {
    f.setHub({
      cover_all_ad_objectives: true,
      brand_safety_type: 'STANDARD_INVENTORY',
      category_exclusion_ids: ['201'],
      vertical_sensitivity_id: '1001',
    });
    const back = await f.safety({cover_all_ad_objectives: false});
    assert.equal(back.error?.code, 'INVALID_TIKTOK_BRAND_SAFETY');
    assert.match(back.error.message, /cannot turn that back off/);
    const same = await f.safety({
      cover_all_ad_objectives: true,
      brand_safety_type: 'STANDARD_INVENTORY',
      category_exclusion_ids: ['201'],
      vertical_sensitivity_id: '1001',
    });
    assert.equal(same.error?.code, 'INVALID_TIKTOK_BRAND_SAFETY');
    assert.match(same.error.message, /does not change/);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  for (const [label, payload] of [
    [
      'exclusions on expanded',
      {cover_all_ad_objectives: false, brand_safety_type: 'EXPANDED_INVENTORY', category_exclusion_ids: ['201']},
    ],
    [
      'missing vertical',
      {cover_all_ad_objectives: false, brand_safety_type: 'STANDARD_INVENTORY', category_exclusion_ids: []},
    ],
    ['no brand safety tier', {cover_all_ad_objectives: false, brand_safety_type: 'NO_BRAND_SAFETY'}],
    [
      'missing cover flag',
      {brand_safety_type: 'LIMITED_INVENTORY', category_exclusion_ids: [], vertical_sensitivity_id: '1001'},
    ],
    ['settings without tier', {cover_all_ad_objectives: false, category_exclusion_ids: ['201']}],
  ]) {
    const g = fixture();
    try {
      const r = await g.safety(payload);
      assert.equal(r.error?.code, 'INVALID_TIKTOK_BRAND_SAFETY', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(g.requests.length, 0, label);
    } finally {
      g.store.close();
    }
  }
});

test('owner policies: unblocking is a removal and widens delivery; blocking passes', async () => {
  const f = fixture();
  try {
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: account,
      confirmed: true,
      policy: {allow_deletion: false, allow_activation: true},
    });
    assert.equal((await f.pangle({delete_app_list: ['1234567890']})).error?.code, 'POLICY_DELETION_FORBIDDEN');
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: account,
      confirmed: true,
      policy: {allow_deletion: true, allow_activation: false},
    });
    assert.equal(
      (await f.pangle({clear_old_app: true, add_app_list: ['com.example.only']})).error?.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
    assert.equal((await f.pangle({add_app_list: ['com.example.more']})).success, true);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a Pangle receipt that counts fewer added apps stays a failure and is never resubmitted or verified as success', async () => {
  const f = fixture();
  try {
    const p = await f.pangle({add_app_list: ['com.example.slots', '987654321']});
    assert.equal(p.success, true);
    f.mode('short');
    assert.equal((await f.execute(p)).success, false);
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
    assert.equal((await f.verify(p)).error?.code, 'WRITE_PARTIAL_OR_FAILED');
  } finally {
    f.store.close();
  }
});

test('a list changed after review stops execution, and a cover-only update keeps the other settings', async () => {
  const f = fixture();
  try {
    const p = await f.pangle({add_app_list: ['com.example.slots']});
    assert.equal(p.success, true);
    f.setApps([...f.apps(), 'com.example.elsewhere']);
    assert.equal((await f.execute(p)).error?.code, 'STATE_CHANGED');
    assert.equal(f.writes(), 0);
    const c = await f.safety({cover_all_ad_objectives: true});
    assert.equal(c.success, true, JSON.stringify(c).slice(0, 500));
    assert.equal((await f.execute(c, {spend_change_confirmed: true})).success, true);
    assert.equal((await f.verify(c)).data.status, 'verified');
    assert.deepEqual(f.hub(), {
      cover_all_ad_objectives: true,
      brand_safety_type: 'STANDARD_INVENTORY',
      category_exclusion_ids: ['201'],
      vertical_sensitivity_id: '1001',
    });
  } finally {
    f.store.close();
  }
});
