import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {tiktokAudienceState} from '../dist/src/tiktok-lookalikes.js';

/**
 * TikTok lookalike audiences (API for Business v1.3, checked 2026-09-26): create a lookalike from a seed audience
 * this advertiser owns. Audience details confirm name, type and ownership; the documented example returns
 * lookalike_spec as null, so the spec is reported unobservable. Customer files, refresh, update and deletion stay blocked.
 */
const TIKTOK = '77777777-7777-4777-8777-777777777777',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'tiktok-lookalikes', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 65).toString('base64');
const spec = (extra = {}) => ({
  source_audience_id: '5001',
  include_source: false,
  mobile_os: 'ALL',
  placements: ['TikTok'],
  location_ids: ['SA', 'AE'],
  audience_size: 'BALANCED',
  ...extra,
});
const payload = (extra = {}, specExtra = {}) => ({
  custom_audience_name: 'Buyers lookalike',
  lookalike_spec: spec(specExtra),
  ...extra,
});
function fixture({readName} = {}) {
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
  const audiences = new Map(
    Object.entries({
      5001: {
        audience_id: '5001',
        name: 'Buyers',
        type: 'Customer File Audience',
        is_creator: true,
        owner_id: account,
        is_valid: true,
      },
      5002: {
        audience_id: '5002',
        name: 'Shared buyers',
        type: 'Customer File Audience',
        is_creator: false,
        owner_id: '999',
        is_valid: true,
        shared: true,
      },
      5003: {
        audience_id: '5003',
        name: 'Old lookalike',
        type: 'Lookalike Audience',
        is_creator: true,
        owner_id: account,
        is_valid: true,
      },
      5004: {
        audience_id: '5004',
        name: 'Processing',
        type: 'Website Audience',
        is_creator: true,
        owner_id: account,
        is_valid: false,
      },
      5005: {
        audience_id: '5005',
        name: 'Tiny',
        type: 'Engagement Audience',
        is_creator: true,
        owner_id: account,
        is_valid: true,
        cover_num: 60,
      },
    }),
  );
  const requests = [],
    writes = [];
  let n = 0,
    next = 6000,
    mode = '';
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const url = new URL(String(raw)),
      path = url.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET';
    requests.push(method + ' ' + path);
    if (method === 'GET' && path === '/v1.3/advertiser/info/')
      return ok({list: [{advertiser_id: account, name: 'Synthetic advertiser'}]});
    if (method === 'GET' && path === '/v1.3/dmp/custom_audience/get/') {
      const ids = JSON.parse(url.searchParams.get('custom_audience_ids'));
      // Coverage and history change daily without any edit.
      return ok({
        list: ids
          .filter(id => audiences.has(id))
          .map(id => {
            const a = audiences.get(id);
            return {
              audience_details: {
                cover_num: a.cover_num ?? 5000 + n,
                is_expiring: false,
                msg: null,
                ...a,
                ...(readName && a.type === 'Lookalike Audience' && Number(id) >= 6000 ? {name: readName} : {}),
                lookalike_spec: null,
              },
              audience_history: [{action: 'create', opt_time: '2026-09-26 10:00:0' + (n % 10)}],
            };
          }),
      });
    }
    if (method === 'POST' && path === '/v1.3/dmp/custom_audience/lookalike/create/') {
      writes.push(path);
      const b = JSON.parse(init.body),
        id = String(next++);
      audiences.set(id, {
        audience_id: id,
        name: b.custom_audience_name,
        type: 'Lookalike Audience',
        is_creator: true,
        owner_id: account,
        is_valid: false,
      });
      if (mode === 'lost') throw new Error('Synthetic accepted response lost');
      return mode === 'write_error'
        ? Response.json({code: 40002, message: 'Synthetic rejection', request_id: 'r' + ++n, data: {}})
        : ok(mode === 'empty_receipt' ? {} : {custom_audience_id: id});
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
  const prepare = body =>
    call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: TIKTOK,
      arguments: {action: 'tiktok_dmp_custom_audience_lookalike_create', account_id: account, payload: body},
    });
  const execute = id => call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  return {
    store,
    requests,
    writes,
    call,
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

test('lookalike creation is a reviewed TikTok family; refresh, update and customer files stay blocked', async () => {
  const f = fixture();
  try {
    const inspected = await f.call('amcp_write', {
      action: 'inspect',
      gateway,
      connection_id: TIKTOK,
      arguments: {action: 'tiktok_dmp_custom_audience_lookalike_create', account_id: account, payload: payload()},
    });
    assert.equal(inspected.data.review_contract_supported, true, JSON.stringify(inspected));
    const status = Object.fromEntries(
      (
        await f.call('amcp_workspace', {action: 'contracts', gateway, search: 'custom_audience', limit: 100})
      ).data.actions.map(r => [r.action, r.status]),
    );
    assert.equal(status.tiktok_dmp_custom_audience_lookalike_create, 'reviewed_write_family');
    assert.equal(status.tiktok_dmp_custom_audience_lookalike_update, 'blocked_write');
    assert.equal(status.tiktok_dmp_custom_audience_file_upload, 'blocked_write');
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('documented lookalike rules are enforced before any provider request', async () => {
  const f = fixture();
  try {
    const cases = {
      'missing name': payload({custom_audience_name: undefined}),
      'name over 128': payload({custom_audience_name: 'x'.repeat(129)}),
      'deprecated sub type': payload({audience_sub_type: 'NORMAL'}),
      'customer file field': payload({calculate_type: 'EMAIL_SHA256'}),
      'missing spec': payload({lookalike_spec: undefined}),
      'non-numeric seed': payload({}, {source_audience_id: 'seed'}),
      'missing include_source': payload({}, {include_source: undefined}),
      'v1.2 include flag': payload({}, {include_source: undefined, is_contain_source: 1}),
      'v1.2 system': payload({}, {mobile_os: undefined, system: 'ALL'}),
      'bad os': payload({}, {mobile_os: 'WINDOWS'}),
      'empty placements': payload({}, {placements: []}),
      'ambiguous placement': payload({}, {placements: ['TopBuzz & BuzzVideo']}),
      'unsupported location': payload({}, {location_ids: ['BR']}),
      'duplicate location': payload({}, {location_ids: ['SA', 'SA']}),
      'bad size': payload({}, {audience_size: 'HUGE'}),
    };
    for (const [name, body] of Object.entries(cases)) {
      const r = await f.prepare(body);
      assert.equal(
        r.error?.code,
        'INVALID_TIKTOK_LOOKALIKE',
        name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300),
      );
    }
    assert.equal(f.requests.length, 0, 'validation happens before any read or write');
  } finally {
    f.store.close();
  }
});

test('a lookalike from an owned seed reads the seed twice, creates once and verifies name, type and ownership', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(payload());
    assert.equal(p.success, true, JSON.stringify(p));
    assert.deepEqual(
      p.data.state_reads.map(r => r.path),
      ['/v1.3/advertiser/info/', '/v1.3/dmp/custom_audience/get/'],
    );
    assert.deepEqual(p.data.creative_impact.seed, {
      audience_id: '5001',
      type: 'Customer File Audience',
      cover_at_least_100: true,
    });
    const done = await f.execute(p.data.review_id);
    assert.equal(done.success, true, 'changing coverage and history are not state changes: ' + JSON.stringify(done));
    assert.equal(f.requests.filter(r => r === 'GET /v1.3/dmp/custom_audience/get/').length, 2);
    const verified = await f.verify(p.data.review_id);
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified));
    assert.deepEqual(verified.data.checks[0].checked_fields, ['audience_id', 'name', 'type', 'is_creator']);
    assert.deepEqual(verified.data.checks[0].unobservable_fields, ['lookalike_spec']);
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.deepEqual(f.writes, ['/v1.3/dmp/custom_audience/lookalike/create/']);
  } finally {
    f.store.close();
  }
});

test('seed review evidence is idempotent and keeps only whether coverage meets the minimum', () => {
  const raw = {
    code: 0,
    data: {
      list: [
        {
          audience_details: {
            audience_id: '5001',
            type: 'Customer File Audience',
            is_creator: true,
            owner_id: '123',
            is_valid: true,
            cover_num: 4321,
            msg: null,
          },
          audience_history: [{action: 'create'}],
        },
      ],
    },
  };
  const once = tiktokAudienceState(raw);
  assert.deepEqual(once, {
    list: [
      {
        audience_details: {
          audience_id: '5001',
          type: 'Customer File Audience',
          is_creator: true,
          owner_id: '123',
          is_valid: true,
          cover_at_least_100: true,
        },
      },
    ],
  });
  assert.deepEqual(tiktokAudienceState({data: once}), once, 'a saved review is projected again at execution');
});

test('shared, lookalike, unprocessed, small or missing seeds are refused before any write', async () => {
  const f = fixture();
  try {
    for (const [seed, code, pattern] of [
      ['5002', 'STATE_TARGET_MISMATCH', /owned by the selected advertiser/],
      ['5003', 'INVALID_TIKTOK_LOOKALIKE', /lookalike audience as a seed/],
      ['5004', 'INVALID_TIKTOK_LOOKALIKE', /48 hours/],
      ['5005', 'INVALID_TIKTOK_LOOKALIKE', /at least 100 people; this one covers fewer/],
      ['5999', 'STATE_TARGET_MISMATCH', /./],
    ]) {
      const r = await f.prepare(payload({}, {source_audience_id: seed}));
      assert.equal(r.error?.code, code, seed + ' ' + JSON.stringify(r));
      assert.match(r.error.message, pattern, seed);
    }
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('a lookalike that reads back with another name stays inconclusive', async () => {
  const f = fixture({readName: 'Renamed elsewhere'});
  try {
    const p = await f.prepare(payload());
    await f.execute(p.data.review_id);
    const verified = await f.verify(p.data.review_id);
    assert.equal(verified.data.status, 'inconclusive', JSON.stringify(verified));
    assert.deepEqual(verified.data.checks[0].changed_fields, ['/name']);
  } finally {
    f.store.close();
  }
});

test('rejected, empty or lost lookalike receipts never submit a second audience', async () => {
  for (const mode of ['write_error', 'empty_receipt', 'lost']) {
    const f = fixture();
    try {
      const p = await f.prepare(payload());
      assert.equal(p.success, true, mode);
      const [first, again] = {
        write_error: ['PLATFORM_ERROR', 'WRITE_OUTCOME_UNCERTAIN'],
        empty_receipt: ['WRITE_PARTIAL_OR_FAILED', 'WRITE_PARTIAL_OR_FAILED'],
        lost: ['WRITE_OUTCOME_UNCERTAIN', 'WRITE_OUTCOME_UNCERTAIN'],
      }[mode];
      f.mode(mode);
      assert.equal((await f.execute(p.data.review_id)).error?.code, first, mode);
      f.mode('');
      assert.equal((await f.execute(p.data.review_id)).error?.code, again, mode);
      assert.equal(f.writes.length, 1, mode);
      assert.notEqual((await f.verify(p.data.review_id)).data?.status, 'verified', mode);
    } finally {
      f.store.close();
    }
  }
});

test('lookalike claims survive concurrent execution and restart', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(payload());
    const results = await Promise.all([f.execute(p.data.review_id), f.execute(p.data.review_id)]);
    assert.ok(results.some(r => r.success));
    assert.equal(f.writes.length, 1);
    f.restart();
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});
