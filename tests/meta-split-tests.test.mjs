import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Meta split tests (Marketing API v25.0 "Ad Study" reference and "Split Testing" guide, checked 2026-09-28).
 */
const gateway = 'meta_native_action',
  registry = new Registry(),
  actions = {create: 'meta_business_id_ad_studies_create', update: 'meta_ad_study_id_update'};
const actor = {tenantId: 'meta-split-tests', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const start = 1893456000,
  end = 1894665600,
  iso = s => new Date(s * 1000).toISOString().replace('.000Z', '+0000');
const study = (o = {}) => ({
  name: 'Placement test',
  description: 'Feed against stories',
  type: 'SPLIT_TEST',
  start_time: start,
  end_time: end,
  cells: [
    {name: 'Feed', treatment_percentage: 50, adsets: ['601']},
    {name: 'Stories', treatment_percentage: 50, adsets: ['602']},
  ],
  ...o,
});
function fixture(o = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 107).toString('base64')),
    calls = [];
  let writes = 0,
    next = 9500;
  store.putConnection(
    owner,
    {
      id: 'm',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: o.scopes ?? ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  const adsets = new Map([
    ['601', {account_id: '123', name: 'Feed placements', status: 'ACTIVE'}],
    ['602', {account_id: '123', name: 'Stories placements', status: 'ACTIVE'}],
    ['603', {account_id: '123', name: 'Busy ad set', status: 'ACTIVE'}],
    ['604', {account_id: '123', name: 'Old ad set', status: 'ARCHIVED'}],
  ]);
  const campaigns = new Map([
    ['701', {account_id: '123', name: 'Prospecting', status: 'ACTIVE'}],
    ['702', {account_id: '123', name: 'Retargeting', status: 'PAUSED'}],
  ]);
  const studies = new Map([
    [
      '9100',
      {
        name: 'Running test',
        type: 'SPLIT_TEST',
        start_time: 1767225600,
        end_time: 4102444800,
        business: '555',
        cells: [{name: 'Only', treatment_percentage: 50, adsets: ['603'], campaigns: []}],
      },
    ],
    [
      '9200',
      {name: 'Lift of another business', type: 'LIFT', start_time: start, end_time: end, business: '777', cells: []},
    ],
    [
      '9300',
      {name: 'Old test', type: 'SPLIT_TEST', start_time: 1577836800, end_time: 1580515200, business: '555', cells: []},
    ],
  ]);
  const pick = (obj, f) =>
    Object.fromEntries(
      String(f)
        .split(',')
        .filter(k => obj[k] !== undefined)
        .map(k => [k, obj[k]]),
    );
  const missing = () =>
    Response.json(
      {
        error: {
          message: 'Unsupported get request. Object with ID does not exist',
          type: 'GraphMethodException',
          code: 100,
          error_subcode: 33,
        },
      },
      {status: 400},
    );
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method,
        f = u.searchParams.get('fields');
      calls.push({path, method});
      if (method === 'GET') {
        if (path === '/v25.0/act_123')
          return Response.json({
            id: 'act_123',
            ...(f.includes('business') ? {business: {id: '555', name: 'Synthetic business'}} : {}),
          });
        if (path === '/v25.0/act_123/adsets')
          return Response.json({
            data: [...adsets].map(([id, a]) => ({id, ...pick(a, f ?? 'name')})),
            paging: {cursors: {before: 'b', after: 'a'}},
          });
        if (path === '/v25.0/act_123/campaigns')
          return Response.json({
            data: [...campaigns].map(([id, c]) => ({id, ...pick(c, f ?? 'name')})),
            paging: {cursors: {before: 'b', after: 'a'}},
          });
        let m = /^\/v25\.0\/(\d+)\/ad_studies$/.exec(path);
        if (m)
          return Response.json({
            data: [...studies]
              .filter(([, s]) => s.cells.some(c => [...c.adsets, ...c.campaigns].includes(m[1])))
              .map(([id, s]) => ({id, type: s.type, start_time: iso(s.start_time), end_time: iso(s.end_time)})),
          });
        m = /^\/v25\.0\/(\d+)\/cells$/.exec(path);
        if (m && studies.has(m[1])) {
          assert.equal(f, 'name,treatment_percentage,adsets.limit(100){id},campaigns.limit(100){id}');
          return Response.json({
            data: studies.get(m[1]).cells.map((c, i) => ({
              id: m[1] + i,
              name: c.name,
              treatment_percentage: c.treatment_percentage,
              ...(c.adsets.length ? {adsets: {data: c.adsets.map(id => ({id}))}} : {}),
              ...(c.campaigns.length ? {campaigns: {data: c.campaigns.map(id => ({id}))}} : {}),
            })),
          });
        }
        m = /^\/v25\.0\/(\d+)$/.exec(path);
        if (m && adsets.has(m[1])) return Response.json({id: m[1], ...pick(adsets.get(m[1]), f)});
        if (m && campaigns.has(m[1])) return Response.json({id: m[1], ...pick(campaigns.get(m[1]), f)});
        if (m && studies.has(m[1])) {
          const s = studies.get(m[1]);
          return Response.json({
            id: m[1],
            name: s.name,
            ...(s.description ? {description: s.description} : {}),
            type: s.type,
            start_time: iso(s.start_time),
            end_time: iso(s.end_time),
            business: {id: s.business, name: 'Business ' + s.business},
            created_by: {id: '42', name: 'Someone'},
          });
        }
        return missing();
      }
      writes++;
      const b = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
      if (o.mode === 'error') return Response.json({error: {message: 'Invalid parameter', code: 100}}, {status: 400});
      if (path === '/v25.0/555/ad_studies') {
        const id = String(next++),
          cells = JSON.parse(b.cells);
        if (o.mode !== 'ignore')
          studies.set(id, {
            name: b.name,
            description: b.description,
            type: b.type,
            start_time: Number(b.start_time),
            end_time: Number(b.end_time),
            business: '555',
            cells: cells.map(c => ({
              name: c.name,
              treatment_percentage: Number(c.treatment_percentage),
              adsets: (c.adsets ?? []).map(String),
              campaigns: (c.campaigns ?? []).map(String),
            })),
          });
        return Response.json({id});
      }
      const m = /^\/v25\.0\/(\d+)$/.exec(path);
      if (m && studies.has(m[1])) {
        const s = studies.get(m[1]);
        if (o.mode !== 'ignore') {
          if (b.name !== undefined) s.name = b.name;
          if (b.description !== undefined) s.description = b.description;
          if (b.end_time !== undefined) s.end_time = Number(b.end_time);
        }
        return Response.json({success: true});
      }
      throw Error('Unexpected ' + method + ' ' + path);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    100,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const discover = async () => {
    ok(
      await service.call(
        gateway,
        {action: 'meta_ad_account_id_adsets_get', account_id: '123', params: {fields: 'id,name,account_id'}},
        actor,
      ),
    );
    ok(
      await service.call(
        gateway,
        {action: 'meta_ad_account_id_campaigns_get', account_id: '123', params: {fields: 'id,name,account_id'}},
        actor,
      ),
    );
  };
  const create = (payload, business = '555') =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action: actions.create, account_id: '123', params: {business_id: business}, payload},
      },
      actor,
    );
  const update = (id, payload) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action: actions.update, account_id: '123', params: {ad_study_id: id}, payload},
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
  return {
    store,
    calls,
    studies,
    discover,
    create,
    update,
    execute,
    verify,
    writes: () => writes,
    last: () => String(next - 1),
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test("ad set and campaign split tests are created on the account's business after spending confirmation and verify; a study is renamed and extended; a replay sends nothing", async () => {
  const f = fixture();
  try {
    await f.discover();
    const p = ok(await f.create(study()));
    assert.equal(p.data.creative_impact.operation, 'create');
    assert.equal(p.data.creative_impact.may_affect_serving, true);
    assert.equal(p.data.creative_impact.business, '555');
    assert.equal((await f.execute(p)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(f.writes(), 0);
    ok(await f.execute(p, {spend_change_confirmed: true}));
    const id = f.last();
    assert.equal(f.studies.get(id).cells.length, 2);
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p, {spend_change_confirmed: true})).data.replayed, true);
    const {description: _, ...campaignTest} = study({
      name: 'Campaign test',
      cells: [
        {name: 'Prospecting', treatment_percentage: 40, campaigns: ['701']},
        {name: 'Retargeting', treatment_percentage: 40, campaigns: ['702']},
      ],
    });
    const c = ok(await f.create(campaignTest));
    ok(await f.execute(c, {spend_change_confirmed: true}));
    assert.equal(ok(await f.verify(c)).data.status, 'verified');
    const u = ok(await f.update(id, {name: 'Placement test v2', end_time: end + 86400}));
    assert.equal(u.data.creative_impact.may_affect_serving, true);
    assert.equal((await f.execute(u)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    ok(await f.execute(u, {spend_change_confirmed: true}));
    assert.equal(ok(await f.verify(u)).data.status, 'verified');
    const d = ok(await f.update(id, {description: 'Feed against stories, extended'}));
    assert.equal(d.data.creative_impact.may_affect_serving, false);
    ok(await f.execute(d));
    assert.equal(ok(await f.verify(d)).data.status, 'verified');
    assert.equal(f.writes(), 4);
  } finally {
    f.store.close();
  }
});

test('malformed studies are refused before any request; other businesses, busy, archived and unlisted objects and unfit updates after reading', async () => {
  const cells2 = (a, b) => [
    {name: 'A', treatment_percentage: 50, ...a},
    {name: 'B', treatment_percentage: 50, ...b},
  ];
  const cases = [
    ['a lift study', study({type: 'LIFT'})],
    ['a creative test', study({type: 'SPLIT_TEST_V2'})],
    ['a test budget', study({creative_test_config: {daily_budget: 15000}})],
    ['viewers', study({viewers: [42]})],
    ['one cell', study({cells: [{name: 'A', treatment_percentage: 50, adsets: ['601']}]})],
    [
      'eleven cells',
      study({
        cells: Array.from({length: 11}, (_, i) => ({
          name: 'C' + i,
          treatment_percentage: 10,
          adsets: [String(600 + i)],
        })),
      }),
    ],
    [
      'a 5% cell',
      study({
        cells: [
          {name: 'A', treatment_percentage: 5, adsets: ['601']},
          {name: 'B', treatment_percentage: 50, adsets: ['602']},
        ],
      }),
    ],
    [
      '110%',
      study({
        cells: [
          {name: 'A', treatment_percentage: 60, adsets: ['601']},
          {name: 'B', treatment_percentage: 50, adsets: ['602']},
        ],
      }),
    ],
    ['mixed levels', study({cells: cells2({adsets: ['601']}, {campaigns: ['701']})})],
    ['both levels in a cell', study({cells: cells2({adsets: ['601'], campaigns: ['701']}, {adsets: ['602']})})],
    ['an empty cell', study({cells: cells2({adsets: []}, {adsets: ['602']})})],
    ['an ad set in two cells', study({cells: cells2({adsets: ['601']}, {adsets: ['601']})})],
    [
      'repeated cell names',
      study({
        cells: [
          {name: 'A', treatment_percentage: 50, adsets: ['601']},
          {name: 'A', treatment_percentage: 50, adsets: ['602']},
        ],
      }),
    ],
    ['a whole ad account', study({cells: cells2({adaccounts: ['123']}, {adsets: ['602']})})],
    ['an end before the start', study({end_time: start - 1})],
    ['a padded name', study({name: ' Placement test'})],
  ];
  for (const [label, payload] of cases) {
    const f = fixture();
    try {
      const r = await f.create(payload);
      assert.equal(r.error?.code, 'INVALID_META_SPLIT_TEST', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  for (const [label, payload] of [
    ['cells in an update', {cells: []}],
    ['start_time in an update', {start_time: start}],
    ['an empty update', {}],
  ]) {
    const f = fixture();
    try {
      assert.equal((await f.update('9100', payload)).error?.code, 'INVALID_META_SPLIT_TEST', label);
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    await f.discover();
    assert.equal((await f.create(study(), '777')).error?.code, 'RESOURCE_SCOPE_REQUIRED');
    assert.match(
      (await f.create(study({cells: cells2({adsets: ['603']}, {adsets: ['602']})}))).error?.message ?? '',
      /already in split test 9100/,
    );
    assert.match(
      (await f.create(study({cells: cells2({adsets: ['604']}, {adsets: ['602']})}))).error?.message ?? '',
      /ARCHIVED/,
    );
    assert.equal(
      (await f.create(study({cells: cells2({adsets: ['699']}, {adsets: ['602']})}))).error?.code,
      'RESOURCE_SCOPE_REQUIRED',
      'an ad set the account never listed',
    );
    assert.equal((await f.update('9200', {name: 'Mine'})).error?.code, 'RESOURCE_SCOPE_REQUIRED');
    assert.match((await f.update('9300', {end_time: end})).error?.message ?? '', /has ended/);
    assert.match((await f.update('9100', {name: 'Running test'})).error?.message ?? '', /already has these values/);
    assert.equal((await f.update('9999', {name: 'Missing'})).error?.code, 'STATE_NOT_FOUND');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  const g = fixture({scopes: ['ads_read']});
  try {
    await g.discover();
    assert.equal((await g.create(study())).error?.code, 'INSUFFICIENT_SCOPE');
  } finally {
    g.store.close();
  }
});

test('an error reply is never resubmitted, ignored writes are not verified, and the ledger lists both rows', async () => {
  const e = fixture({mode: 'error'});
  try {
    await e.discover();
    const p = ok(await e.create(study()));
    assert.equal((await e.execute(p, {spend_change_confirmed: true})).success, false);
    assert.equal((await e.execute(p, {spend_change_confirmed: true})).success, false);
    assert.equal(e.writes(), 1);
  } finally {
    e.store.close();
  }
  const g = fixture({mode: 'ignore'});
  try {
    await g.discover();
    const p = ok(await g.create(study()));
    ok(await g.execute(p, {spend_change_confirmed: true}));
    assert.notEqual(ok(await g.verify(p)).data.status, 'verified', 'the study was never created');
    const u = ok(await g.update('9100', {name: 'Renamed'}));
    ok(await g.execute(u));
    assert.notEqual(ok(await g.verify(u)).data.status, 'verified');
  } finally {
    g.store.close();
  }
  for (const [kind, action] of Object.entries(actions)) {
    const row = actionContracts(registry).find(r => r.gateway === gateway && r.action === action);
    assert.equal(row?.status, 'reviewed_write_family', kind);
    assert.equal(row.family, 'meta_split_tests', kind);
  }
});
