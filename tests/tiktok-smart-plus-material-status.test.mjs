import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';

/**
 * Pausing and enabling creatives inside an Upgraded Smart+ ad (API for Business v1.3, checked 2026-09-26). Only the
 * explicitly selected creatives the ad read returns can be addressed, never carousels and other creatives together.
 */
const TIKTOK = '26262626-2626-4262-8262-262626262626',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'tiktok-smart-plus-material-status', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 83).toString('base64');
const material = (id, item, format = 'SINGLE_VIDEO', status = 'ENABLE') => ({
  ad_material_id: id,
  smart_plus_creative_id: 'c' + id,
  material_operation_status: status,
  creative_info: {ad_format: format, tiktok_item_id: item, identity_type: 'TT_USER', identity_id: 'tt-1'},
});
function fixture({receipt, readBack} = {}) {
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
  const ads = {
    5200: {
      smart_plus_ad_id: '5200',
      adgroup_id: '300',
      ad_name: 'Live spark',
      operation_status: 'ENABLE',
      creative_list: [
        material('m1', '9001'),
        material('m2', '9003'),
        material('m3', '9002', 'CAROUSEL_ADS'),
        material('m4', '9004', 'SINGLE_VIDEO', 'DISABLE'),
      ],
    },
    5201: {
      smart_plus_ad_id: '5201',
      adgroup_id: '300',
      ad_name: 'Paused spark',
      operation_status: 'DISABLE',
      creative_list: [material('p1', '9001'), material('p2', '9003', 'SINGLE_VIDEO', 'DISABLE')],
    },
    5203: {
      smart_plus_ad_id: '5203',
      adgroup_id: '300',
      ad_name: 'Terminated',
      operation_status: 'FROZEN',
      creative_list: [material('f1', '9001')],
    },
  };
  const requests = [],
    writes = [];
  let n = 0,
    mode = '';
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const u = new URL(String(raw)),
      path = u.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET';
    requests.push(method + ' ' + path);
    if (method === 'GET' && path === '/v1.3/smart_plus/ad/get/') {
      const ids = JSON.parse(u.searchParams.get('filtering')).smart_plus_ad_ids,
        rows = ids
          .filter(id => ads[id])
          .map(id => (readBack ? readBack(structuredClone(ads[id])) : structuredClone(ads[id])));
      return ok({list: rows, page_info: {page: 1, page_size: 100, total_number: rows.length, total_page: 1}});
    }
    if (method === 'POST' && path === '/v1.3/smart_plus/ad/material_status/update/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      for (const m of ads[b.smart_plus_ad_id].creative_list)
        if (b.ad_material_ids.includes(m.ad_material_id)) m.material_operation_status = b.operation_status;
      if (mode === 'lost') throw new Error('Synthetic accepted response lost');
      if (mode === 'error')
        return Response.json({code: 40002, message: 'Creative cannot be enabled', request_id: 'r' + ++n, data: {}});
      return ok(
        receipt
          ? receipt(b)
          : {
              ad_material_ids: b.ad_material_ids,
              operation_status: b.operation_status,
              smart_plus_ad_id: b.smart_plus_ad_id,
            },
      );
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const start = () =>
    new MirrorService(new Registry(), store, transport, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    });
  let service = start();
  const call = (tool, input) => service.call(tool, input, actor);
  const args = payload => ({action: 'tiktok_smart_plus_ad_material_status_update', account_id: account, payload});
  const prepare = payload =>
    call('amcp_write', {action: 'prepare', gateway, connection_id: TIKTOK, arguments: args(payload)});
  const execute = (id, extra = {}) =>
    call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true, ...extra});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  return {
    store,
    ads,
    requests,
    writes,
    call,
    args,
    prepare,
    execute,
    verify,
    mode: v => {
      mode = v;
    },
    restart: () => {
      service = start();
    },
  };
}

test('Smart+ creative status is a reviewed TikTok family', async () => {
  const f = fixture();
  try {
    const r = await f.call('amcp_write', {
      action: 'inspect',
      gateway,
      connection_id: TIKTOK,
      arguments: f.args({smart_plus_ad_id: '5200', ad_material_ids: ['m1'], operation_status: 'DISABLE'}),
    });
    assert.equal(r.data.review_contract_supported, true, JSON.stringify(r));
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('only 1-20 distinct creatives with ENABLE or DISABLE are accepted, before any request', async () => {
  const f = fixture();
  try {
    const cases = {
      'no creatives': [{smart_plus_ad_id: '5200', ad_material_ids: [], operation_status: 'DISABLE'}, 'ad_material_ids'],
      '21 creatives': [
        {
          smart_plus_ad_id: '5200',
          ad_material_ids: Array.from({length: 21}, (_, i) => 'm' + i),
          operation_status: 'DISABLE',
        },
        'ad_material_ids',
      ],
      'repeated creative': [
        {smart_plus_ad_id: '5200', ad_material_ids: ['m1', 'm1'], operation_status: 'DISABLE'},
        'ad_material_ids',
      ],
      'delete': [{smart_plus_ad_id: '5200', ad_material_ids: ['m1'], operation_status: 'DELETE'}, 'operation_status'],
      'no ad': [{ad_material_ids: ['m1'], operation_status: 'DISABLE'}, 'smart_plus_ad_id'],
      'extra key': [
        {smart_plus_ad_id: '5200', ad_material_ids: ['m1'], operation_status: 'DISABLE', ad_name: 'x'},
        'ad_name',
      ],
    };
    for (const [name, [payload, field]] of Object.entries(cases)) {
      const r = await f.prepare(payload);
      assert.equal(
        r.error?.code,
        'INVALID_TIKTOK_SMART_PLUS_MATERIAL_STATUS',
        name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300),
      );
      assert.equal(r.error.details?.field, field, name);
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('pausing creatives of an enabled ad shows each change, executes once and verifies each status', async () => {
  const f = fixture();
  try {
    const p = await f.prepare({smart_plus_ad_id: '5200', ad_material_ids: ['m1', 'm2'], operation_status: 'DISABLE'});
    assert.equal(p.success, true, JSON.stringify(p));
    assert.deepEqual(p.data.creative_impact.creatives, [
      {ad_material_id: 'm1', tiktok_item_id: '9001', before: 'ENABLE', after: 'DISABLE'},
      {ad_material_id: 'm2', tiktok_item_id: '9003', before: 'ENABLE', after: 'DISABLE'},
    ]);
    assert.equal(p.data.creative_impact.may_affect_serving, true);
    assert.equal(p.data.creative_impact.ad.enabled_after, 1);
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal(f.writes.length, 1);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.equal(f.writes.length, 1);
    const all = await f.prepare({smart_plus_ad_id: '5200', ad_material_ids: ['m3'], operation_status: 'DISABLE'});
    assert.match(all.data.creative_impact.effect, /No explicitly selected creative of the ad stays on/);
  } finally {
    f.store.close();
  }
});

test('enabling creatives needs spending confirmation and respects an owner policy that forbids activation', async () => {
  const f = fixture();
  try {
    const p = await f.prepare({smart_plus_ad_id: '5201', ad_material_ids: ['p2'], operation_status: 'ENABLE'});
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal(p.data.creative_impact.may_affect_serving, false, 'the ad itself is paused');
    assert.equal((await f.execute(p.data.review_id)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(f.writes.length, 0);
    assert.equal((await f.execute(p.data.review_id, {spend_change_confirmed: true})).success, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    saveSpendPolicy(f.store, owner, {scope: 'workspace', confirmed: true, policy: {allow_activation: false}});
    const q = await f.prepare({smart_plus_ad_id: '5200', ad_material_ids: ['m4'], operation_status: 'ENABLE'});
    const r = q.success ? await f.execute(q.data.review_id, {spend_change_confirmed: true}) : q;
    assert.equal(r.error?.code, 'POLICY_ACTIVATION_FORBIDDEN', JSON.stringify(r.error));
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('creatives the ad does not list, mixed carousels and terminated ads are refused before any write', async () => {
  const f = fixture();
  try {
    for (const [payload, code, message] of [
      [
        {smart_plus_ad_id: '5200', ad_material_ids: ['auto-7'], operation_status: 'DISABLE'},
        'STATE_TARGET_MISMATCH',
        /automatically added creatives are not managed here/,
      ],
      [
        {smart_plus_ad_id: '5200', ad_material_ids: ['m1', 'm3'], operation_status: 'DISABLE'},
        'INVALID_TIKTOK_SMART_PLUS_MATERIAL_STATUS',
        /separate requests/,
      ],
      [
        {smart_plus_ad_id: '5203', ad_material_ids: ['f1'], operation_status: 'DISABLE'},
        'INVALID_TIKTOK_SMART_PLUS_MATERIAL_STATUS',
        /FROZEN/,
      ],
      [{smart_plus_ad_id: '5299', ad_material_ids: ['m1'], operation_status: 'DISABLE'}, 'STATE_TARGET_MISMATCH', /./],
    ]) {
      const r = await f.prepare(payload);
      assert.equal(r.error?.code, code, JSON.stringify(r.error));
      assert.match(r.error.message, message);
    }
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('partial receipts and drifted read-backs are not trusted; rejected or lost changes are never resubmitted', async () => {
  const partial = fixture({
    receipt: b => ({
      ad_material_ids: b.ad_material_ids.slice(1),
      operation_status: b.operation_status,
      smart_plus_ad_id: b.smart_plus_ad_id,
    }),
  });
  try {
    const p = await partial.prepare({
      smart_plus_ad_id: '5200',
      ad_material_ids: ['m1', 'm2'],
      operation_status: 'DISABLE',
    });
    const r = await partial.execute(p.data.review_id);
    assert.notEqual(r.success, true, JSON.stringify(r));
    partial.restart();
    assert.notEqual((await partial.execute(p.data.review_id)).success, true);
    assert.equal(partial.writes.length, 1);
  } finally {
    partial.store.close();
  }
  const d = fixture({
    readBack: a => ({
      ...a,
      creative_list: a.creative_list.map(m =>
        m.ad_material_id === 'm1' ? {...m, material_operation_status: 'ENABLE'} : m,
      ),
    }),
  });
  try {
    const p = await d.prepare({smart_plus_ad_id: '5200', ad_material_ids: ['m1'], operation_status: 'DISABLE'});
    assert.equal((await d.execute(p.data.review_id)).success, true);
    const v = await d.verify(p.data.review_id);
    assert.equal(v.data.status, 'inconclusive', JSON.stringify(v));
    assert.deepEqual(v.data.checks[0].changed_fields, ['/material_statuses/m1']);
  } finally {
    d.store.close();
  }
  for (const [mode, first, again] of [
    // r25-m2-refusal (Q16): TikTok’s refusal here is code 40002 with no data in an HTTP 200 answer, which its return-code table defines as a refusal of the request: the review is rejected and its key retired (WRITE_REJECTED), not uncertain. A lost response stays uncertain.
    ['error', 'PLATFORM_ERROR', 'WRITE_REJECTED'],
    ['lost', 'WRITE_OUTCOME_UNCERTAIN', 'WRITE_OUTCOME_UNCERTAIN'],
  ]) {
    const f = fixture();
    try {
      const p = await f.prepare({smart_plus_ad_id: '5200', ad_material_ids: ['m1'], operation_status: 'DISABLE'});
      f.mode(mode);
      assert.equal((await f.execute(p.data.review_id)).error?.code, first, mode);
      f.mode('');
      f.restart();
      assert.equal((await f.execute(p.data.review_id)).error?.code, again, mode);
      assert.equal(f.writes.length, 1, mode);
    } finally {
      f.store.close();
    }
  }
  const g = fixture();
  try {
    const p = await g.prepare({smart_plus_ad_id: '5200', ad_material_ids: ['m2'], operation_status: 'DISABLE'});
    const results = await Promise.all([g.execute(p.data.review_id), g.execute(p.data.review_id)]);
    assert.ok(results.some(r => r.success));
    assert.equal(g.writes.length, 1);
    g.restart();
    assert.equal((await g.execute(p.data.review_id)).data.replayed, true);
  } finally {
    g.store.close();
  }
});
