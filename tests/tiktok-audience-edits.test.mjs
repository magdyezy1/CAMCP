import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * TikTok custom audience edits (API for Business v1.3, checked 2026-09-27): renaming, converting to Reach & Frequency,
 * deleting, and applying to ad groups.
 */
const TIKTOK = '36363636-3636-4363-8363-363636363636',
  gateway = 'tiktok_native_action',
  account = '123',
  registry = new Registry();
const actions = {
  update: 'tiktok_dmp_custom_audience_update',
  delete: 'tiktok_dmp_custom_audience_delete',
  apply: 'tiktok_dmp_custom_audience_apply',
};
const actor = {tenantId: 'tiktok-audience-edits', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 96).toString('base64');
const audience = (name, type, extra = {}) => ({
  name,
  audience_type: type,
  is_valid: true,
  is_expiring: false,
  expired_time: '2030-01-01 00:00:00',
  shared: false,
  is_creator: true,
  cover_num: 52000,
  sub_type: 'NORMAL',
  ...extra,
});
function fixture(mode = '') {
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
  const audiences = new Map([
    ['601', audience('Site visitors 30d', 'Website Audience')],
    ['602', audience('Buyers', 'Customer File Audience')],
    ['603', audience('Buyers lookalike', 'Lookalike Audience')],
    ['604', audience('Partner list', 'Customer File Audience', {shared: true, is_creator: false})],
    ['605', audience('Shared out', 'Customer File Audience', {shared: true})],
    ['606', audience('Expiring', 'Engagement Audience', {is_expiring: true})],
    ['607', audience('Used', 'Customer File Audience')],
    ['608', audience('Smart+ exclusion', 'Customer File Audience')],
    ['609', audience('Old list A', 'Customer File Audience')],
    ['610', audience('Old list B', 'Customer File Audience')],
    ['611', audience('Expired', 'Engagement Audience', {is_valid: false, expired_time: '2020-01-01 00:00:00'})],
  ]);
  const adgroups = new Map([
    [
      '301',
      {adgroup_name: 'Prospecting', operation_status: 'ENABLE', audience_ids: ['607'], excluded_audience_ids: []},
    ],
    ['302', {adgroup_name: 'Paused test', operation_status: 'DISABLE', audience_ids: [], excluded_audience_ids: []}],
    [
      '303',
      {adgroup_name: 'Retargeting', operation_status: 'ENABLE', audience_ids: ['601'], excluded_audience_ids: []},
    ],
  ]);
  const smart = [{adgroup_id: '351', targeting_spec: {location_ids: ['6252001'], excluded_audience_ids: ['608']}}];
  let writes = 0,
    n = 0;
  const requests = [];
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const u = new URL(String(raw)),
      path = u.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET',
      q = k => u.searchParams.get(k);
    requests.push(method + ' ' + path + (q('page') ? ' p' + q('page') : ''));
    if (method === 'GET') {
      assert.equal(q('advertiser_id'), account);
      const page = Number(q('page') || 1),
        size = Number(q('page_size') || 20);
      if (path === '/v1.3/dmp/custom_audience/list/') {
        const ids = JSON.parse(q('custom_audience_ids'));
        return ok({
          list: [...audiences]
            .filter(([id]) => ids.includes(id))
            .map(([audience_id, a]) => {
              const {sub_type, ...row} = a;
              return {audience_id, ...row};
            }),
          page_info: {page: 1, page_size: size, total_number: ids.length, total_page: 1},
        });
      }
      if (path === '/v1.3/dmp/custom_audience/get/') {
        const ids = JSON.parse(q('custom_audience_ids'));
        return ok({
          list: [...audiences]
            .filter(([id]) => ids.includes(id))
            .map(([audience_id, a]) => ({
              audience_history: [],
              audience_details: {
                audience_id,
                name: a.name,
                type: a.audience_type,
                audience_sub_type: a.sub_type,
                is_valid: a.is_valid,
                is_creator: a.is_creator,
                shared: a.shared,
              },
            })),
        });
      }
      if (path === '/v1.3/adgroup/get/') {
        const filter = q('filtering') ? JSON.parse(q('filtering')).adgroup_ids : undefined,
          rows = [...adgroups]
            .filter(([id]) => !filter || filter.includes(id))
            .map(([adgroup_id, g]) => ({
              advertiser_id: account,
              adgroup_id,
              ...g,
              secondary_status: 'ADGROUP_STATUS_DELIVERY_OK',
            }));
        return ok({list: rows, page_info: {page, page_size: size, total_number: rows.length, total_page: 1}});
      }
      if (path === '/v1.3/smart_plus/adgroup/get/')
        return ok({list: smart, page_info: {page, page_size: size, total_number: smart.length, total_page: 1}});
      throw new Error('Unexpected TikTok read ' + path);
    }
    const b = JSON.parse(init.body);
    writes++;
    if (mode === 'error')
      return Response.json({code: 40002, message: 'Audience is being processed', request_id: 'r' + ++n, data: {}});
    if (mode === 'ignore') return ok({});
    if (path === '/v1.3/dmp/custom_audience/update/') {
      const a = audiences.get(b.custom_audience_id);
      if (b.audience_sub_type) a.sub_type = b.audience_sub_type;
      else a.name = b.custom_audience_name;
      return ok({});
    }
    if (path === '/v1.3/dmp/custom_audience/delete/') {
      for (const id of b.custom_audience_ids) audiences.delete(id);
      return ok({});
    }
    if (path === '/v1.3/dmp/custom_audience/apply/') {
      for (const id of b.adgroup_ids) {
        const g = adgroups.get(id);
        g.audience_ids = g.audience_ids.filter(x => x !== b.custom_audience_id);
        g.excluded_audience_ids = g.excluded_audience_ids.filter(x => x !== b.custom_audience_id);
        if (b.action_mode === 'Apply')
          (b.usage_mode === 'Include' ? g.audience_ids : g.excluded_audience_ids).push(b.custom_audience_id);
      }
      return ok({});
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const prepare = (action, payload) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        connection_id: TIKTOK,
        arguments: {action, account_id: account, payload: {advertiser_id: account, ...payload}},
      },
      actor,
    );
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
  return {store, audiences, adgroups, requests, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('an audience is renamed and another converted to Reach & Frequency; both verify and a replay sends nothing', async () => {
  const f = fixture();
  try {
    const r = ok(
      await f.prepare(actions.update, {custom_audience_id: '601', custom_audience_name: 'Site visitors 60d'}),
    );
    assert.equal(r.data.creative_impact.operation, 'rename');
    assert.equal(r.data.creative_impact.may_affect_serving, false);
    ok(await f.execute(r));
    assert.equal(f.audiences.get('601').name, 'Site visitors 60d');
    assert.equal(ok(await f.verify(r)).data.status, 'verified');
    assert.equal((await f.execute(r)).data.replayed, true);
    assert.equal(f.writes(), 1);
    const c = ok(await f.prepare(actions.update, {custom_audience_id: '602', audience_sub_type: 'REACH_FREQUENCY'}));
    assert.equal(c.data.creative_impact.operation, 'convert_to_reach_frequency');
    assert.ok(
      f.requests.includes('GET /v1.3/smart_plus/adgroup/get/ p1'),
      'a conversion checks Upgraded Smart+ ad groups too',
    );
    ok(await f.execute(c));
    assert.equal(f.audiences.get('602').sub_type, 'REACH_FREQUENCY');
    assert.equal(ok(await f.verify(c)).data.status, 'verified');
    assert.equal(f.writes(), 2);
  } finally {
    f.store.close();
  }
});

test('unused, unshared audiences are deleted and verify gone; used, shared and shared-in audiences are refused; owner deletion rules apply', async () => {
  const f = fixture();
  try {
    const d = ok(await f.prepare(actions.delete, {custom_audience_ids: ['610', '609']}));
    assert.equal(d.data.creative_impact.deleting.length, 2);
    ok(await f.execute(d));
    assert.equal(f.audiences.has('609') || f.audiences.has('610'), false);
    assert.equal(ok(await f.verify(d)).data.status, 'verified');
    const used = await f.prepare(actions.delete, {custom_audience_ids: ['607', '608']});
    assert.equal(used.error?.code, 'AUDIENCE_IN_USE');
    assert.deepEqual(used.error.details.in_use, {'607': ['301'], '608': ['351']});
    assert.equal((await f.prepare(actions.delete, {custom_audience_ids: ['605']})).error?.code, 'AUDIENCE_SHARED');
    assert.equal(
      (await f.prepare(actions.delete, {custom_audience_ids: ['604']})).error?.code,
      'STATE_TARGET_MISMATCH',
    );
    assert.equal(
      (await f.prepare(actions.delete, {custom_audience_ids: ['602', '699']})).error?.code,
      'STATE_NOT_FOUND',
    );
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    saveSpendPolicy(g.store, owner, {gateway, account_id: account, confirmed: true, policy: {allow_deletion: false}});
    assert.equal(
      (await g.prepare(actions.delete, {custom_audience_ids: ['609']})).error?.code,
      'POLICY_DELETION_FORBIDDEN',
    );
    ok(await g.prepare(actions.update, {custom_audience_id: '609', custom_audience_name: 'Renamed'}));
  } finally {
    g.store.close();
  }
});

test('an audience is included, excluded and disconnected in ad groups and verifies; applying needs spend confirmation', async () => {
  const f = fixture();
  try {
    const inc = ok(
      await f.prepare(actions.apply, {
        custom_audience_id: '602',
        adgroup_ids: ['302', '301'],
        action_mode: 'Apply',
        usage_mode: 'Include',
      }),
    );
    assert.equal(inc.data.creative_impact.operation, 'include');
    assert.deepEqual(inc.data.creative_impact.enabled_adgroups, ['301']);
    assert.equal(inc.data.creative_impact.may_affect_serving, true);
    assert.equal((await f.execute(inc)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(f.writes(), 0);
    ok(await f.execute(inc, {spend_change_confirmed: true}));
    assert.deepEqual(f.adgroups.get('301').audience_ids, ['607', '602']);
    assert.equal(ok(await f.verify(inc)).data.status, 'verified');
    const exc = ok(
      await f.prepare(actions.apply, {
        custom_audience_id: '609',
        adgroup_ids: ['302'],
        action_mode: 'Apply',
        usage_mode: 'Exclude',
      }),
    );
    assert.equal(exc.data.creative_impact.may_affect_serving, false);
    ok(await f.execute(exc, {spend_change_confirmed: true}));
    assert.deepEqual(f.adgroups.get('302').excluded_audience_ids, ['609']);
    assert.equal(ok(await f.verify(exc)).data.status, 'verified');
    const off = ok(
      await f.prepare(actions.apply, {custom_audience_id: '601', adgroup_ids: ['303'], action_mode: 'Disconnect'}),
    );
    ok(await f.execute(off, {spend_change_confirmed: true}));
    assert.deepEqual(f.adgroups.get('303').audience_ids, []);
    assert.equal(ok(await f.verify(off)).data.status, 'verified');
    assert.equal((await f.execute(off, {spend_change_confirmed: true})).data.replayed, true);
    assert.equal(f.writes(), 3);
    // A shared-in audience can be applied; its owner keeps it.
    ok(
      await f.prepare(actions.apply, {
        custom_audience_id: '604',
        adgroup_ids: ['302'],
        action_mode: 'Apply',
        usage_mode: 'Include',
      }),
    );
  } finally {
    f.store.close();
  }
});

test('malformed requests are refused before any request; unknown, expired, unchanged and conflicting ones after reading', async () => {
  const cases = [
    ['another advertiser', actions.delete, {advertiser_id: '999', custom_audience_ids: ['609']}],
    ['a customer file', actions.update, {custom_audience_id: '602', file_paths: ['a.txt'], action: 'APPEND'}],
    [
      'a name and a sub type',
      actions.update,
      {custom_audience_id: '602', custom_audience_name: 'X', audience_sub_type: 'REACH_FREQUENCY'},
    ],
    ['back to NORMAL', actions.update, {custom_audience_id: '602', audience_sub_type: 'NORMAL'}],
    ['129 characters', actions.update, {custom_audience_id: '602', custom_audience_name: 'x'.repeat(129)}],
    ['a trailing space', actions.update, {custom_audience_id: '602', custom_audience_name: 'Buyers '}],
    ['no audiences', actions.delete, {custom_audience_ids: []}],
    ['101 audiences', actions.delete, {custom_audience_ids: Array.from({length: 101}, (_, i) => String(1000 + i))}],
    ['an audience twice', actions.delete, {custom_audience_ids: ['609', '609']}],
    ['apply without usage', actions.apply, {custom_audience_id: '602', adgroup_ids: ['301'], action_mode: 'Apply'}],
    [
      'disconnect with usage',
      actions.apply,
      {custom_audience_id: '602', adgroup_ids: ['301'], action_mode: 'Disconnect', usage_mode: 'Include'},
    ],
    ['an unknown mode', actions.apply, {custom_audience_id: '602', adgroup_ids: ['301'], action_mode: 'Remove'}],
    [
      'a non-numeric ad group',
      actions.apply,
      {custom_audience_id: '602', adgroup_ids: ['ag-1'], action_mode: 'Disconnect'},
    ],
    [
      'two audiences',
      actions.apply,
      {custom_audience_id: ['602', '609'], adgroup_ids: ['301'], action_mode: 'Disconnect'},
    ],
  ];
  for (const [label, action, payload] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare(action, payload);
      assert.ok(
        ['INVALID_TIKTOK_AUDIENCE_EDIT', 'ACCOUNT_SCOPE_MISMATCH'].includes(r.error?.code),
        label + ': ' + JSON.stringify(r).slice(0, 300),
      );
      assert.equal(f.requests.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    const refused = [
      [actions.update, {custom_audience_id: '606', custom_audience_name: 'Renamed'}, 'AUDIENCE_EXPIRING'],
      [actions.update, {custom_audience_id: '611', custom_audience_name: 'Renamed'}, 'AUDIENCE_EXPIRING'],
      [actions.update, {custom_audience_id: '602', custom_audience_name: 'Buyers'}, 'INVALID_TIKTOK_AUDIENCE_EDIT'],
      [
        actions.update,
        {custom_audience_id: '603', audience_sub_type: 'REACH_FREQUENCY'},
        'INVALID_TIKTOK_AUDIENCE_EDIT',
      ],
      [actions.update, {custom_audience_id: '607', audience_sub_type: 'REACH_FREQUENCY'}, 'AUDIENCE_IN_USE'],
      [actions.update, {custom_audience_id: '604', custom_audience_name: 'Renamed'}, 'STATE_TARGET_MISMATCH'],
      [actions.update, {custom_audience_id: '699', custom_audience_name: 'Renamed'}, 'STATE_NOT_FOUND'],
      [
        actions.apply,
        {custom_audience_id: '607', adgroup_ids: ['301'], action_mode: 'Apply', usage_mode: 'Include'},
        'INVALID_TIKTOK_AUDIENCE_EDIT',
      ],
      [
        actions.apply,
        {custom_audience_id: '601', adgroup_ids: ['303'], action_mode: 'Apply', usage_mode: 'Exclude'},
        'INVALID_TIKTOK_AUDIENCE_EDIT',
      ],
      [
        actions.apply,
        {custom_audience_id: '602', adgroup_ids: ['302'], action_mode: 'Disconnect'},
        'INVALID_TIKTOK_AUDIENCE_EDIT',
      ],
      [
        actions.apply,
        {custom_audience_id: '602', adgroup_ids: ['301', '399'], action_mode: 'Apply', usage_mode: 'Include'},
        'STATE_NOT_FOUND',
      ],
      [
        actions.apply,
        {custom_audience_id: '611', adgroup_ids: ['302'], action_mode: 'Apply', usage_mode: 'Include'},
        'AUDIENCE_EXPIRING',
      ],
    ];
    for (const [action, payload, code] of refused) {
      const r = await f.prepare(action, payload);
      assert.equal(r.error?.code, code, JSON.stringify(payload) + ': ' + JSON.stringify(r).slice(0, 300));
    }
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('an error reply is never resubmitted, ignored edits are not verified, and the ledger lists the three writes', async () => {
  const e = fixture('error');
  try {
    const p = ok(await e.prepare(actions.update, {custom_audience_id: '601', custom_audience_name: 'Renamed'}));
    assert.equal((await e.execute(p)).success, false);
    assert.equal((await e.execute(p)).success, false);
    assert.equal(e.writes(), 1);
  } finally {
    e.store.close();
  }
  const g = fixture('ignore');
  try {
    for (const [p, extra] of [
      [ok(await g.prepare(actions.update, {custom_audience_id: '601', custom_audience_name: 'Renamed'})), {}],
      [ok(await g.prepare(actions.delete, {custom_audience_ids: ['609']})), {}],
      [
        ok(
          await g.prepare(actions.apply, {
            custom_audience_id: '602',
            adgroup_ids: ['302'],
            action_mode: 'Apply',
            usage_mode: 'Include',
          }),
        ),
        {spend_change_confirmed: true},
      ],
    ]) {
      ok(await g.execute(p, extra));
      assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
    }
  } finally {
    g.store.close();
  }
  const rows = actionContracts(registry).filter(r => r.gateway === gateway);
  for (const action of Object.values(actions)) {
    const row = rows.find(r => r.action === action);
    assert.equal(row?.status, 'reviewed_write_family', action);
    assert.equal(row.family, 'tiktok_audience_edits', action);
  }
  assert.equal(rows.find(r => r.action === 'tiktok_dmp_custom_audience_lookalike_update')?.status, 'blocked_write');
});
