import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * Meta lookalike audiences (Lookalike Audiences guide, checked 2026-09-26): a LOOKALIKE custom audience from an
 * owned seed in the same ad account. Only audiences an account list names as this account's become owned. Meta
 * reads back the seed as origin IDs with type/ratio/country; location_spec is not echoed.
 */
const META = '88888888-8888-4888-8888-888888888888',
  gateway = 'meta_native_action',
  account = '123';
const actor = {tenantId: 'meta-lookalikes', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 66).toString('base64');
const body = (spec = {}, extra = {}) => ({
  name: 'Buyers 1% SA',
  subtype: 'LOOKALIKE',
  origin_audience_id: '8001',
  lookalike_spec: {ratio: 0.01, country: 'SA', ...spec},
  ...extra,
});
function fixture({readRatio} = {}) {
  const store = new Store(':memory:', key),
    connection = {
      id: META,
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: ['ads_management'],
    };
  store.putConnection(owner, connection, {accessToken: 'synthetic'});
  const audiences = new Map(
    Object.entries({
      8001: {
        id: '8001',
        account_id: account,
        name: 'Buyers',
        subtype: 'CUSTOM',
        operation_status: {code: 200, description: 'Normal'},
      },
      8002: {id: '8002', account_id: '999', name: 'Shared buyers', subtype: 'CUSTOM', operation_status: {code: 200}},
      8003: {
        id: '8003',
        account_id: account,
        name: 'Flagged',
        subtype: 'WEBSITE',
        operation_status: {code: 471, description: 'Flagged'},
      },
    }),
  );
  const requests = [],
    writes = [];
  let next = 9001,
    mode = '';
  const pick = (row, fields) =>
    Object.fromEntries(
      fields
        .split(',')
        .filter(f => row[f] !== undefined)
        .map(f => [f, row[f]]),
    );
  const transport = new NativeTransport(async (raw, init = {}) => {
    const url = new URL(String(raw)),
      path = url.pathname,
      method = init.method ?? 'GET',
      fields = url.searchParams.get('fields') ?? '';
    requests.push(method + ' ' + path);
    let m;
    if (method === 'GET' && path === '/v25.0/act_123')
      return Response.json({id: 'act_123', account_status: 1, currency: 'USD'});
    if (method === 'GET' && path === '/v25.0/act_123/customaudiences')
      return Response.json({
        data: [...audiences.values()].map(a => pick(a, fields || 'id')),
        paging: {cursors: {before: 'b', after: 'a'}},
      });
    if (method === 'GET' && (m = /^\/v25\.0\/(\d+)$/.exec(path))) {
      const a = audiences.get(m[1]);
      return a
        ? Response.json(pick(a, fields))
        : Response.json({error: {message: 'Unsupported get request.', code: 100}}, {status: 400});
    }
    if (method === 'POST' && path === '/v25.0/act_123/customaudiences') {
      writes.push(path);
      const b = Object.fromEntries(new URLSearchParams(String(init.body))),
        spec = JSON.parse(b.lookalike_spec),
        id = String(next++);
      // Meta reads the seed back as origin objects and keeps type/ratio/country, but not location_spec.
      audiences.set(id, {
        id,
        account_id: account,
        name: b.name,
        subtype: 'LOOKALIKE',
        lookalike_spec: {
          ...(spec.type ? {type: spec.type} : {}),
          ...(spec.ratio !== undefined ? {ratio: readRatio ?? spec.ratio} : {}),
          ...(spec.starting_ratio !== undefined ? {starting_ratio: spec.starting_ratio} : {}),
          ...(spec.country ? {country: spec.country} : {}),
          origin: [{id: b.origin_audience_id, name: 'Buyers', type: 'custom_audience'}],
        },
      });
      if (mode === 'lost') throw new Error('Synthetic accepted response lost');
      if (mode === 'error')
        return Response.json(
          {error: {message: 'Seed audience restricted', code: 100, error_subcode: 1713232}},
          {status: 400},
        );
      return Response.json(mode === 'empty_receipt' ? {} : {id});
    }
    throw new Error('Unexpected Meta request ' + method + ' ' + path);
  });
  const start = () =>
    new MirrorService(new Registry(), store, transport, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    });
  let service = start();
  const call = (tool, input) => service.call(tool, input, actor);
  const prepare = payload =>
    call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: META,
      arguments: {action: 'meta_custom_audience_create', account_id: account, payload},
    });
  const execute = id => call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  const discover = () =>
    call(gateway, {
      action: 'meta_ad_account_id_customaudiences_get',
      connection_id: META,
      account_id: account,
      params: {fields: 'id,name,account_id,subtype'},
    });
  return {
    store,
    requests,
    writes,
    call,
    prepare,
    execute,
    verify,
    discover,
    mode: v => {
      mode = v;
    },
    restart: () => {
      service = start();
    },
  };
}

test('lookalike creation on the custom audience route is a reviewed Meta family', async () => {
  const f = fixture();
  try {
    for (const action of ['meta_custom_audience_create', 'meta_ad_account_id_customaudiences_create']) {
      const inspected = await f.call('amcp_write', {
        action: 'inspect',
        gateway,
        connection_id: META,
        arguments: {action, account_id: account, payload: body()},
      });
      assert.equal(inspected.data.review_contract_supported, true, action + ' ' + JSON.stringify(inspected));
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('only documented lookalike specs are accepted, before any request', async () => {
  const f = fixture();
  try {
    const cases = {
      'customer file subtype': body({}, {subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY'}),
      'website rule': body({}, {subtype: 'WEBSITE', rule: '{}'}),
      'missing name': body({}, {name: ''}),
      'non-numeric seed': body({}, {origin_audience_id: 'act_8001'}),
      'type and ratio': body({type: 'similarity'}),
      'neither type nor ratio': body({ratio: undefined}),
      'bad type': body({ratio: undefined, type: 'broad'}),
      'ratio too large': body({ratio: 0.21}),
      'ratio not whole percent': body({ratio: 0.015}),
      'starting ratio not below': body({ratio: 0.03, starting_ratio: 0.03}),
      'starting ratio without ratio': body({ratio: undefined, type: 'reach', starting_ratio: 0.01}),
      'country and location': body({location_spec: {geo_locations: {countries: ['SA']}}}),
      'lowercase country': body({country: 'sa'}),
      'country groups': body({country: undefined, location_spec: {geo_locations: {country_groups: ['gcc']}}}),
      'undocumented spec key': body({origin_ids: ['1']}),
      'retention': body({}, {retention_days: 30}),
    };
    for (const [name, payload] of Object.entries(cases)) {
      const r = await f.prepare(payload);
      assert.equal(
        r.error?.code,
        'INVALID_META_LOOKALIKE',
        name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300),
      );
    }
    assert.equal(f.requests.length, 0, 'validation happens before any read or write');
  } finally {
    f.store.close();
  }
});

test('an owned seed is read twice, the lookalike is created once and its seed, ratio and country verify', async () => {
  const f = fixture();
  try {
    assert.equal((await f.prepare(body())).error.code, 'RESOURCE_SCOPE_REQUIRED', 'an unlisted seed is not owned');
    assert.equal((await f.discover()).success, true);
    const p = await f.prepare(body({ratio: 0.05, starting_ratio: 0.01}));
    assert.equal(p.success, true, JSON.stringify(p));
    assert.deepEqual(
      p.data.state_reads.map(r => r.path),
      ['/v25.0/act_123', '/v25.0/8001'],
    );
    assert.deepEqual(p.data.creative_impact.seed, {id: '8001', subtype: 'CUSTOM'});
    const done = await f.execute(p.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done));
    assert.equal(f.requests.filter(r => r === 'GET /v25.0/8001').length, 2);
    const verified = await f.verify(p.data.review_id);
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified));
    assert.equal(verified.data.checks[0].unobservable_fields, undefined);
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.deepEqual(f.writes, ['/v25.0/act_123/customaudiences']);
  } finally {
    f.store.close();
  }
});

test('a location_spec lookalike verifies its seed and reports the unechoed location as unobservable', async () => {
  const f = fixture();
  try {
    await f.discover();
    const p = await f.prepare(
      body({
        country: undefined,
        type: 'similarity',
        ratio: undefined,
        location_spec: {geo_locations: {countries: ['SA', 'AE']}},
      }),
    );
    assert.equal(p.success, true, JSON.stringify(p));
    await f.execute(p.data.review_id);
    const verified = await f.verify(p.data.review_id);
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified));
    assert.deepEqual(verified.data.checks[0].unobservable_fields, ['lookalike_spec.location_spec']);
  } finally {
    f.store.close();
  }
});

test('shared and flagged seeds are refused before any write', async () => {
  const f = fixture();
  try {
    await f.discover();
    assert.equal(
      (await f.prepare(body({}, {origin_audience_id: '8002'}))).error.code,
      'RESOURCE_SCOPE_REQUIRED',
      'a list row naming another account grants no ownership',
    );
    const flagged = await f.prepare(body({}, {origin_audience_id: '8003'}));
    assert.equal(flagged.error.code, 'INVALID_META_LOOKALIKE', JSON.stringify(flagged));
    assert.match(flagged.error.message, /471/);
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('a lookalike that reads back with another ratio stays inconclusive', async () => {
  const f = fixture({readRatio: 0.02});
  try {
    await f.discover();
    const p = await f.prepare(body());
    await f.execute(p.data.review_id);
    const verified = await f.verify(p.data.review_id);
    assert.equal(verified.data.status, 'inconclusive', JSON.stringify(verified));
    assert.deepEqual(verified.data.checks[0].changed_fields, ['/lookalike_spec/ratio']);
  } finally {
    f.store.close();
  }
});

test('rejected, empty or lost lookalike receipts never submit a second audience', async () => {
  for (const mode of ['error', 'empty_receipt', 'lost']) {
    const f = fixture();
    try {
      await f.discover();
      const p = await f.prepare(body());
      assert.equal(p.success, true, mode);
      const [first, again] = {
        error: ['UPSTREAM_ERROR', 'WRITE_OUTCOME_UNCERTAIN'],
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
    await f.discover();
    const p = await f.prepare(body());
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
