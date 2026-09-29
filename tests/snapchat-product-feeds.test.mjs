import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Product feeds of Snapchat catalogs, opened by the owner on 2026-09-29. Snapchat's "Dynamic Product Ads" reference
 * (read 2026-09-29): one Product Feed per Catalog; POST /v1/catalogs/{catalog_id}/product_feeds creates it, PUT on the
 * same path updates it, GET and DELETE /v1/product_feeds/{id}; schedule attributes per interval type; credentials in
 * the schedule for password-protected URLs.
 */
const gateway = 'snapchat_native_action',
  registry = new Registry(),
  account = 'acct1',
  actor = {tenantId: 'snap-product-feeds', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const daily = {
  url: 'https://shop.example.test/feed.csv',
  interval_type: 'DAILY',
  hour: 3,
  minute: 0,
  timezone: 'Asia/Riyadh',
};
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 66).toString('base64'));
  store.putConnection(
    owner,
    {
      id: '55555555-5555-4555-8555-555555555555',
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
    ['cat-1', {id: 'cat-1', name: 'Shop', organization_id: 'org-1', vertical: 'COMMERCE'}],
    ['cat-2', {id: 'cat-2', name: 'Outlet', organization_id: 'org-1', vertical: 'COMMERCE'}],
  ]);
  const feeds = new Map([
    [
      'feed-1',
      {
        id: 'feed-1',
        catalog_id: 'cat-1',
        name: 'Shop feed',
        default_currency: 'SAR',
        status: 'ACTIVE',
        schedule: {interval_type: 'HOURLY', minute: 15, interval_count: 1, url: 'https://shop.example.test/hourly.csv'},
      },
    ],
    ['feed-9', {id: 'feed-9', catalog_id: 'cat-9', name: 'Other org', default_currency: 'USD', schedule: null}],
  ]);
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
          return ok('adaccounts', 'adaccount', [{id: account, organization_id: 'org-1', name: 'Snap account'}]);
        if (path === '/v1/organizations/org-1/catalogs') return ok('catalogs', 'catalog', [...catalogs.values()]);
        let m = /^\/v1\/catalogs\/([\w-]+)\/product_feeds$/.exec(path);
        if (m)
          return ok(
            'product_feeds',
            'product_feed',
            [...feeds.values()].filter(f => f.catalog_id === m[1]),
          );
        m = /^\/v1\/product_feeds\/([\w-]+)$/.exec(path);
        if (m && feeds.has(m[1])) return ok('product_feeds', 'product_feed', [feeds.get(m[1])]);
        if (m) return Response.json({request_status: 'ERROR', display_message: 'Not found'}, {status: 404});
        throw Error('Unexpected read ' + path);
      }
      writes++;
      const b = init.body ? JSON.parse(String(init.body)) : {};
      let m = /^\/v1\/catalogs\/([\w-]+)\/product_feeds$/.exec(path);
      if (m && method === 'POST') {
        const f = {...b.product_feeds[0], id: 'feed-new', status: 'ACTIVE'};
        feeds.set(f.id, f);
        return ok('product_feeds', 'product_feed', [f]);
      }
      if (m && method === 'PUT') {
        const f = b.product_feeds[0];
        feeds.set(f.id, {...feeds.get(f.id), ...f});
        return ok('product_feeds', 'product_feed', [feeds.get(f.id)]);
      }
      m = /^\/v1\/product_feeds\/([\w-]+)$/.exec(path);
      if (m && method === 'DELETE') {
        feeds.delete(m[1]);
        return Response.json({request_status: 'SUCCESS', product_feeds: []});
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
  const create = (feed, catalog = 'cat-2') =>
    prepare(
      'snapchat_catalogs_catalog_id_product_feeds_create',
      {catalog_id: catalog},
      {product_feeds: [{catalog_id: catalog, ...feed}]},
    );
  const update = (feed, catalog = 'cat-1') =>
    prepare(
      'snapchat_catalog_product_feed_update',
      {catalog_id: catalog},
      {product_feeds: [{catalog_id: catalog, ...feed}]},
    );
  const remove = id => prepare('snapchat_product_feeds_product_feed_id_delete', {product_feed_id: id});
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, feeds, create, update, remove, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1200));
  return r;
};
const refused = (r, code) => assert.equal(r.error?.code, code, JSON.stringify(r).slice(0, 700));

test("a catalog's one feed is created with when Snapchat fetches it, and read back", async () => {
  const f = fixture();
  try {
    const p = ok(await f.create({name: 'Outlet feed', default_currency: 'SAR', schedule: daily}));
    assert.equal(p.data.creative_impact.catalog.name, 'Outlet');
    assert.match(p.data.creative_impact.fetches, /^DAILY at 03:00 \(Asia\/Riyadh\) from https:\/\/shop/);
    ok(await f.execute(p));
    const v = ok(await f.verify(p));
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 900));
    refused(
      await f.create({name: 'Second', default_currency: 'SAR', schedule: daily}, 'cat-1'),
      'CONFIGURATION_EXISTS',
    );
  } finally {
    f.store.close();
  }
});

test('schedules follow the interval table, over HTTPS, without credentials; supplemental feeds stay out', async () => {
  const cases = [
    ['credentials', {...daily, username: 'u', password: 'p'}],
    ['ftp', {...daily, url: 'ftp://shop.example.test/feed.csv'}],
    ['daily without hour', {url: daily.url, interval_type: 'DAILY', minute: 0}],
    ['weekly without weekday', {url: daily.url, interval_type: 'WEEKLY', hour: 6, minute: 0}],
    [
      'monthly with a weekday',
      {url: daily.url, interval_type: 'MONTHLY', day_of_month: 1, hour: 6, minute: 0, day_of_week: 'MONDAY'},
    ],
    ['hourly every 24', {url: daily.url, interval_type: 'HOURLY', minute: 0, interval_count: 24}],
    ['unknown time zone', {...daily, timezone: 'Mars/Base'}],
  ];
  for (const [label, schedule] of cases) {
    const f = fixture();
    try {
      const r = await f.create({name: 'X', default_currency: 'SAR', schedule});
      assert.equal(r.success, false, label);
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    for (const feed of [
      {name: 'X', default_currency: 'SAR', schedule: daily, feed_type: 'SUPPLEMENTAL', parent_feed_id: 'feed-1'},
      {name: 'X', schedule: daily},
      {name: 'X', default_currency: 'SAR'},
    ])
      assert.equal((await f.create(feed)).success, false, JSON.stringify(feed));
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});

test('an update sends the whole feed and reads back; a deletion names what Snapchat does not document', async () => {
  const f = fixture();
  try {
    refused(
      await f.update({
        id: 'feed-1',
        name: 'Shop feed',
        default_currency: 'SAR',
        schedule: {interval_type: 'HOURLY', minute: 15, interval_count: 1, url: 'https://shop.example.test/hourly.csv'},
      }),
      'INVALID_SNAPCHAT_PRODUCT_FEED',
    );
    const p = ok(await f.update({id: 'feed-1', name: 'Shop feed', default_currency: 'SAR', schedule: daily}));
    assert.equal(p.data.creative_impact.before.schedule.interval_type, 'HOURLY');
    ok(await f.execute(p));
    ok(await f.verify(p));
    refused(await f.remove('feed-9'), 'STATE_TARGET_MISMATCH');
    refused(await f.remove('feed-404'), 'STATE_NOT_FOUND');
    const d = ok(await f.remove('feed-1'));
    assert.match(d.data.creative_impact.effect, /reference does not say what becomes of the products/);
    ok(await f.execute(d));
    const v = ok(await f.verify(d));
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 900));
  } finally {
    f.store.close();
  }
});

test('the ledger lists the feed writes under one family; feed uploads and catalog roles stay blocked', () => {
  const rows = actionContracts(registry);
  assert.deepEqual(
    rows
      .filter(r => r.family === 'snapchat_product_feeds')
      .map(r => r.action)
      .sort(),
    [
      'snapchat_catalog_product_feed_create',
      'snapchat_catalog_product_feed_update',
      'snapchat_catalogs_catalog_id_product_feeds_create',
      'snapchat_catalogs_catalog_id_product_feeds_update',
      'snapchat_product_feeds_product_feed_id_delete',
    ],
  );
  for (const action of ['snapchat_product_feeds_product_feed_id_feed_uploads_create', 'snapchat_catalog_role_create'])
    assert.equal(rows.find(r => r.action === action)?.status, 'blocked_write', action);
});
