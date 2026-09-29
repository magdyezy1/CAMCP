import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Snapchat product catalogs, opened by the owner on 2026-09-29. Snapchat's "Dynamic Product Ads" reference (read
 * 2026-09-29): organization catalogs (at most 200), name 1-375 characters, vertical, event_sources; an update "expects
 * the entire object"; DELETE /v1/catalogs/{catalog_id}; Organization Admin required.
 */
const gateway = 'snapchat_native_action',
  registry = new Registry(),
  account = 'acct1',
  actor = {tenantId: 'snap-catalogs', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 67).toString('base64'));
  store.putConnection(
    owner,
    {
      id: '66666666-6666-4666-8666-666666666666',
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic Snap',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const catalogs = new Map([
    [
      'cat-1',
      {
        id: 'cat-1',
        name: 'Shop',
        organization_id: 'org-1',
        vertical: 'COMMERCE',
        default_product_set_id: 'ps-d1',
        event_sources: [
          {id: 'px-1', type: 'PIXEL'},
          {id: 'px-2', type: 'PIXEL'},
        ],
      },
    ],
    [
      'cat-empty',
      {id: 'cat-empty', name: 'Empty', organization_id: 'org-1', vertical: 'COMMERCE', default_product_set_id: 'ps-d2'},
    ],
  ]);
  const feeds = {'cat-1': [{id: 'feed-1', catalog_id: 'cat-1', name: 'Feed'}], 'cat-empty': []};
  const sets = {'cat-1': [{id: 'ps-d1'}, {id: 'ps-7'}], 'cat-empty': [{id: 'ps-d2'}]};
  const calls = [];
  let writes = 0;
  const ok = (key, row, rows) =>
    Response.json({request_status: 'SUCCESS', [key]: rows.map(x => ({sub_request_status: 'SUCCESS', [row]: x}))});
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method;
      calls.push({method, path});
      if (method === 'GET') {
        if (path === '/v1/adaccounts/' + account)
          return ok('adaccounts', 'adaccount', [{id: account, organization_id: 'org-1'}]);
        if (path === '/v1/adaccounts/' + account + '/pixels')
          return ok('pixels', 'pixel', [{id: 'px-1'}, {id: 'px-2'}, {id: 'px-3'}]);
        if (path === '/v1/organizations/org-1/catalogs') return ok('catalogs', 'catalog', [...catalogs.values()]);
        let m = /^\/v1\/catalogs\/([\w-]+)\/product_feeds$/.exec(path);
        if (m) return ok('product_feeds', 'product_feed', feeds[m[1]] ?? []);
        m = /^\/v1\/catalogs\/([\w-]+)\/product_sets$/.exec(path);
        if (m) return ok('product_sets', 'product_set', sets[m[1]] ?? []);
        m = /^\/v1\/catalogs\/([\w-]+)$/.exec(path);
        if (m && catalogs.has(m[1])) return ok('catalogs', 'catalog', [catalogs.get(m[1])]);
        if (m) return Response.json({request_status: 'ERROR'}, {status: 404});
        throw Error('Unexpected read ' + path);
      }
      writes++;
      const b = init.body ? JSON.parse(String(init.body)) : {};
      if (path === '/v1/organizations/org-1/catalogs' && method === 'POST') {
        const c = {...b.catalogs[0], id: 'cat-new', default_product_set_id: 'ps-dn'};
        catalogs.set(c.id, c);
        return ok('catalogs', 'catalog', [c]);
      }
      if (path === '/v1/organizations/org-1/catalogs' && method === 'PUT') {
        const c = {...catalogs.get(b.catalogs[0].id), ...b.catalogs[0]};
        catalogs.set(c.id, c);
        return ok('catalogs', 'catalog', [c]);
      }
      const m = /^\/v1\/catalogs\/([\w-]+)$/.exec(path);
      if (m && method === 'DELETE') {
        catalogs.delete(m[1]);
        return Response.json({request_status: 'SUCCESS', catalogs: []});
      }
      throw Error('Unexpected write ' + method + ' ' + path);
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
  const prepare = (action, params, payload) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, account_id: account, params, ...(payload ? {payload} : {})}},
      actor,
    );
  const create = (catalog, org = 'org-1') =>
    prepare(
      'snapchat_organizations_organization_id_catalogs_create',
      {organization_id: org},
      {catalogs: [{organization_id: org, ...catalog}]},
    );
  const update = catalog =>
    prepare(
      'snapchat_organizations_organization_id_catalogs_update',
      {organization_id: 'org-1'},
      {catalogs: [{organization_id: 'org-1', ...catalog}]},
    );
  const remove = id => prepare('snapchat_catalogs_catalog_id_delete', {catalog_id: id});
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, catalogs, create, update, remove, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1200));
  return r;
};
const refused = (r, code) => assert.equal(r.error?.code, code, JSON.stringify(r).slice(0, 700));

test('a COMMERCE catalog is created in the ad account organization with its pixels, and read back', async () => {
  const f = fixture();
  try {
    const p = ok(
      await f.create({name: 'Riyadh shop', vertical: 'COMMERCE', event_sources: [{id: 'px-3', type: 'PIXEL'}]}),
    );
    assert.equal(p.data.creative_impact.operation, 'create');
    ok(await f.execute(p));
    const v = ok(await f.verify(p));
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 900));
    refused(
      await f.create({name: 'X', vertical: 'COMMERCE', event_sources: [{id: 'px-99', type: 'PIXEL'}]}),
      'STATE_TARGET_MISMATCH',
    );
    refused(await f.create({name: 'X', vertical: 'COMMERCE'}, 'org-2'), 'STATE_TARGET_MISMATCH');
  } finally {
    f.store.close();
  }
});

test('shapes are refused before any request: batches, other verticals, apps, partial updates', async () => {
  const f = fixture();
  try {
    for (const catalog of [
      {name: 'X', vertical: 'HOTELS'},
      {name: 'X', vertical: 'COMMERCE', event_sources: [{id: 'app-1', type: 'MOBILE_APP'}]},
      {name: '', vertical: 'COMMERCE'},
      {name: 'X', vertical: 'COMMERCE', source: 'FEED'},
    ])
      assert.equal((await f.create(catalog)).success, false, JSON.stringify(catalog));
    assert.equal((await f.update({id: 'cat-1', name: 'Renamed'})).success, false, 'partial update');
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});

test('an update sends the whole catalog and says which event sources it drops', async () => {
  const f = fixture();
  try {
    const p = ok(
      await f.update({id: 'cat-1', name: 'Shop', vertical: 'COMMERCE', event_sources: [{id: 'px-1', type: 'PIXEL'}]}),
    );
    assert.match(p.data.creative_impact.warning, /drops event source\(s\) px-2/);
    ok(await f.execute(p));
    const v = ok(await f.verify(p));
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 900));
  } finally {
    f.store.close();
  }
});

test('only an empty catalog is deleted: no feed, no product set but the default', async () => {
  const f = fixture();
  try {
    const full = await f.remove('cat-1');
    refused(full, 'CATALOG_NOT_EMPTY');
    assert.match(full.error.message, /its product feed and 1 product set/);
    assert.match(full.error.remedy.action, /Nothing was submitted.*each with its own review/);
    refused(await f.remove('cat-other'), 'STATE_TARGET_MISMATCH');
    const p = ok(await f.remove('cat-empty'));
    ok(await f.execute(p));
    const v = ok(await f.verify(p));
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 900));
  } finally {
    f.store.close();
  }
});

test('the ledger lists the catalog writes; catalog roles stay blocked', () => {
  const rows = actionContracts(registry);
  assert.deepEqual(
    rows
      .filter(r => r.family === 'snapchat_catalogs')
      .map(r => r.action)
      .sort(),
    [
      'snapchat_catalog_delete',
      'snapchat_catalogs_catalog_id_delete',
      'snapchat_organizations_organization_id_catalogs_create',
      'snapchat_organizations_organization_id_catalogs_update',
    ],
  );
  assert.equal(rows.find(r => r.action === 'snapchat_catalog_role_create')?.status, 'blocked_write');
});
