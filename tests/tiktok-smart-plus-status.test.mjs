import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';

/**
 * Upgraded Smart+ operation statuses (API for Business v1.3, checked 2026-09-26): campaign and ad group calls
 * report per-ID successes and errors; ad calls return the updated IDs and one status; FROZEN ads cannot be enabled.
 */
const TIKTOK = '17171717-1717-4171-8171-171717171717',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'tiktok-smart-plus-status', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 74).toString('base64');
const kinds = {
  campaign: ['campaign_ids', 'campaign_id', 'campaign_name'],
  adgroup: ['adgroup_ids', 'adgroup_id', 'adgroup_name'],
  ad: ['smart_plus_ad_ids', 'smart_plus_ad_id', 'ad_name'],
};
function fixture({readDrift} = {}) {
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
  const rows = {
    campaign: new Map([
      [
        '100',
        {
          campaign_id: '100',
          campaign_name: 'Smart+ web',
          operation_status: 'ENABLE',
          secondary_status: 'CAMPAIGN_STATUS_ENABLE',
          budget: 500,
        },
      ],
      [
        '101',
        {
          campaign_id: '101',
          campaign_name: 'Smart+ app',
          operation_status: 'ENABLE',
          secondary_status: 'CAMPAIGN_STATUS_ENABLE',
          budget: 300,
        },
      ],
    ]),
    adgroup: new Map([
      ['200', {adgroup_id: '200', adgroup_name: 'Group A', campaign_id: '100', operation_status: 'DISABLE'}],
      ['201', {adgroup_id: '201', adgroup_name: 'Group B', campaign_id: '100', operation_status: 'DISABLE'}],
    ]),
    ad: new Map([
      ['300', {smart_plus_ad_id: '300', ad_name: 'Ad A', adgroup_id: '200', operation_status: 'ENABLE'}],
      ['301', {smart_plus_ad_id: '301', ad_name: 'Ad B', adgroup_id: '200', operation_status: 'FROZEN'}],
    ]),
  };
  const requests = [],
    writes = [];
  let n = 0,
    mode = '';
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const url = new URL(String(raw)),
      path = url.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET';
    requests.push(method + ' ' + path);
    const get = /^\/v1\.3\/smart_plus\/(campaign|adgroup|ad)\/get\/$/.exec(path),
      set = /^\/v1\.3\/smart_plus\/(campaign|adgroup|ad)\/status\/update\/$/.exec(path);
    if (method === 'GET' && get) {
      const k = get[1],
        wanted = JSON.parse(url.searchParams.get('filtering'))[kinds[k][0]];
      const list = wanted
        .filter(id => rows[k].has(id))
        .map(id => (readDrift ? readDrift(structuredClone(rows[k].get(id))) : structuredClone(rows[k].get(id))));
      return ok({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}});
    }
    if (method === 'POST' && set) {
      const k = set[1],
        b = JSON.parse(init.body),
        list = b[kinds[k][0]];
      writes.push({kind: k, body: b});
      const failed = mode === 'partial' ? list.slice(-1) : [];
      for (const id of list)
        if (!failed.includes(id)) rows[k].set(id, {...rows[k].get(id), operation_status: b.operation_status});
      if (mode === 'lost') throw new Error('Synthetic accepted response lost');
      if (mode === 'error')
        return Response.json({code: 40002, message: 'Synthetic failure', request_id: 'r' + ++n, data: {}});
      if (k === 'ad')
        return ok({smart_plus_ad_ids: list.filter(id => !failed.includes(id)), status: b.operation_status});
      return ok({
        [k + '_list']: list
          .filter(id => !failed.includes(id))
          .map(id => ({[kinds[k][1]]: id, status: b.operation_status})),
        error_list: failed.map(id => ({[kinds[k][1]]: id, error_message: 'Synthetic error'})),
      });
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
  const args = (kind, list, status) => ({
    action: 'tiktok_smart_plus_' + kind + '_status_update',
    account_id: account,
    payload: {[kinds[kind][0]]: list, operation_status: status},
  });
  const prepare = (kind, list, status, payload) =>
    call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: TIKTOK,
      arguments: payload ? {...args(kind, list, status), payload} : args(kind, list, status),
    });
  const execute = (id, extra = {}) =>
    call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true, ...extra});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  return {
    store,
    rows,
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

test('Smart+ pause and enable are a reviewed TikTok family for campaigns, ad groups and ads', async () => {
  const f = fixture();
  try {
    for (const [kind, list] of [
      ['campaign', ['100']],
      ['adgroup', ['200']],
      ['ad', ['300']],
    ]) {
      const r = await f.call('amcp_write', {
        action: 'inspect',
        gateway,
        connection_id: TIKTOK,
        arguments: f.args(kind, list, 'DISABLE'),
      });
      assert.equal(r.data.review_contract_supported, true, kind + ' ' + JSON.stringify(r));
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('only 1–20 unique IDs with ENABLE or DISABLE are accepted, before any request', async () => {
  const f = fixture();
  try {
    const cases = [
      ['no IDs', 'campaign', [], 'DISABLE'],
      ['21 IDs', 'campaign', Array.from({length: 21}, (_, i) => String(1000 + i)), 'DISABLE'],
      ['duplicate', 'adgroup', ['200', '200'], 'DISABLE'],
      ['non-numeric', 'ad', ['ad-1'], 'DISABLE'],
      ['delete', 'campaign', ['100'], 'DELETE'],
      ['unknown status', 'campaign', ['100'], 'PAUSE'],
    ];
    for (const [name, kind, list, status] of cases) {
      const r = await f.prepare(kind, list, status);
      assert.equal(r.error?.code, 'INVALID_TIKTOK_SMART_PLUS_STATUS', name + ' ' + JSON.stringify(r).slice(0, 300));
    }
    for (const [name, payload] of [
      [
        'postback window',
        {campaign_ids: ['100'], operation_status: 'DISABLE', postback_window_mode: 'POSTBACK_WINDOW_MODE1'},
      ],
      ['wrong ID field', {adgroup_ids: ['200'], operation_status: 'DISABLE'}],
    ]) {
      const r = await f.prepare('campaign', [], '', payload);
      assert.equal(r.error?.code, 'INVALID_TIKTOK_SMART_PLUS_STATUS', name + ' ' + JSON.stringify(r).slice(0, 300));
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('pausing campaigns needs no spending confirmation, sends one request and verifies each campaign', async () => {
  const f = fixture();
  try {
    const p = await f.prepare('campaign', ['100', '101'], 'DISABLE');
    assert.equal(p.success, true, JSON.stringify(p));
    assert.deepEqual(
      p.data.state_reads.map(r => r.path),
      ['/v1.3/smart_plus/campaign/get/'],
    );
    assert.deepEqual(
      p.data.creative_impact.changes.map(c => [c.campaign_id, c.before, c.after]),
      [
        ['100', 'ENABLE', 'DISABLE'],
        ['101', 'ENABLE', 'DISABLE'],
      ],
    );
    const done = await f.execute(p.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done));
    assert.equal(f.writes.length, 1);
    const verified = await f.verify(p.data.review_id);
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified));
    assert.equal(verified.data.checks.length, 2);
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('enabling needs spending confirmation and obeys an owner policy that forbids activation', async () => {
  const f = fixture();
  try {
    const p = await f.prepare('adgroup', ['200', '201'], 'ENABLE');
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal((await f.execute(p.data.review_id)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(f.writes.length, 0);
    const done = await f.execute(p.data.review_id, {spend_change_confirmed: true});
    assert.equal(done.success, true, JSON.stringify(done));
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    saveSpendPolicy(g.store, owner, {scope: 'workspace', confirmed: true, policy: {allow_activation: false}});
    const p = await g.prepare('ad', ['300'], 'ENABLE');
    const r = p.success ? await g.execute(p.data.review_id, {spend_change_confirmed: true}) : p;
    assert.equal(r.error?.code, 'POLICY_ACTIVATION_FORBIDDEN', JSON.stringify(r).slice(0, 300));
    assert.equal(g.writes.length, 0);
    const q = await g.prepare('ad', ['300'], 'DISABLE');
    assert.equal(q.success, true, 'pausing is allowed under the same policy');
  } finally {
    g.store.close();
  }
});

test('frozen ads are never enabled, missing entities are refused, and ad receipts verify', async () => {
  const f = fixture();
  try {
    const frozen = await f.prepare('ad', ['300', '301'], 'ENABLE');
    assert.equal(frozen.error?.code, 'INVALID_TIKTOK_SMART_PLUS_STATUS', JSON.stringify(frozen));
    assert.match(frozen.error.message, /FROZEN/);
    const missing = await f.prepare('campaign', ['199'], 'DISABLE');
    assert.equal(missing.error?.code, 'STATE_TARGET_MISMATCH', JSON.stringify(missing));
    const p = await f.prepare('ad', ['300'], 'DISABLE');
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('partial receipts are not successes, drifted read-backs are inconclusive, and nothing is resubmitted', async () => {
  for (const kind of ['campaign', 'ad']) {
    const f = fixture();
    try {
      const list = kind === 'campaign' ? ['100', '101'] : ['300'];
      f.mode('partial');
      const p = await f.prepare(kind, kind === 'ad' ? ['300'] : list, 'DISABLE');
      if (kind === 'ad') {
        f.rows.ad.set('302', {smart_plus_ad_id: '302', ad_name: 'Ad C', adgroup_id: '200', operation_status: 'ENABLE'});
      }
      const q = kind === 'ad' ? await f.prepare('ad', ['300', '302'], 'DISABLE') : p;
      const r = await f.execute(q.data.review_id);
      assert.notEqual(r.data?.success, true, kind + ' ' + JSON.stringify(r).slice(0, 300));
      f.mode('');
      assert.equal((await f.execute(q.data.review_id)).data?.success === true, false);
      assert.equal(f.writes.length, 1, kind);
    } finally {
      f.store.close();
    }
  }
  const d = fixture({readDrift: r => ({...r, operation_status: 'ENABLE'})});
  try {
    const p = await d.prepare('campaign', ['100'], 'DISABLE');
    await d.execute(p.data.review_id);
    const v = await d.verify(p.data.review_id);
    assert.equal(v.data.status, 'inconclusive', JSON.stringify(v));
    assert.deepEqual(v.data.checks[0].changed_fields, ['/operation_status']);
  } finally {
    d.store.close();
  }
});

test('rejected or lost updates are never resubmitted, and claims survive restart and concurrency', async () => {
  for (const [mode, first, again] of [
    // r25-m2-refusal (Q16): TikTok’s refusal here is code 40002 with no data in an HTTP 200 answer, which its return-code table defines as a refusal of the request: the review is rejected and its key retired (WRITE_REJECTED), not uncertain. A lost response stays uncertain.
    ['error', 'PLATFORM_ERROR', 'WRITE_REJECTED'],
    ['lost', 'WRITE_OUTCOME_UNCERTAIN', 'WRITE_OUTCOME_UNCERTAIN'],
  ]) {
    const f = fixture();
    try {
      const p = await f.prepare('campaign', ['100'], 'DISABLE');
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
    const p = await g.prepare('campaign', ['100'], 'DISABLE');
    const results = await Promise.all([g.execute(p.data.review_id), g.execute(p.data.review_id)]);
    assert.ok(results.some(r => r.success));
    assert.equal(g.writes.length, 1);
    g.restart();
    assert.equal((await g.execute(p.data.review_id)).data.replayed, true);
  } finally {
    g.store.close();
  }
});
