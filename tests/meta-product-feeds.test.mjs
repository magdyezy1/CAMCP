import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';

/**
 * Scheduled product feeds of Meta catalogs, opened by the owner on 2026-09-29. Meta's references (read 2026-09-29):
 * "Product Catalog Product Feeds" (create: name, schedule, update_schedule, deletion_enabled "When true, this will
 * remove products from a catalog that are no longer present in a feed ... Once enabled, we do not allow this field to be
 * disabled", default true), "Product Feed" (update; delete: "Deleting a product feed effectively disables all ads
 * using products that come from this feed") and "Product Feed Schedule".
 */
const gateway = 'meta_native_action',
  registry = new Registry(),
  actor = {tenantId: 'meta-product-feeds', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const daily = {interval: 'DAILY', url: 'https://shop.example.test/feed.csv', hour: 22};
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 47).toString('base64'));
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
      scopes: ['ads_management', 'catalog_management'],
    },
    {accessToken: 'synthetic'},
  );
  const catalogs = new Map([
    ['555', {id: '555', name: 'Riyadh shop', vertical: 'commerce', business: {id: '900'}}],
    ['556', {id: '556', name: 'Partner shop', vertical: 'commerce', business: {id: '901'}}],
  ]);
  const feeds = new Map([
    [
      '6001',
      {
        id: '6001',
        catalog: '555',
        name: 'Daily',
        schedule: {id: '77', interval: 'DAILY', url: daily.url, hour: '22', minute: 0, interval_count: 1},
        deletion_enabled: true,
        product_count: 40,
      },
    ],
    ['6002', {id: '6002', catalog: '555', name: 'Empty', schedule: null, deletion_enabled: false, product_count: 0}],
    ['6100', {id: '6100', catalog: '556', name: 'Partner', schedule: null, deletion_enabled: true, product_count: 3}],
  ]);
  const shown = f => {
    const {catalog: _c, ...rest} = f;
    return rest;
  };
  const calls = [];
  let writes = 0;
  const gone = () =>
    Response.json({error: {message: 'Unsupported get request.', code: 100, error_subcode: 33}}, {status: 400});
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method;
      calls.push({method, path, query: Object.fromEntries(u.searchParams)});
      if (method === 'GET') {
        if (path === '/v26.0/act_123') return Response.json({id: 'act_123', business: {id: '900'}});
        if (path === '/v26.0/900/owned_product_catalogs') return Response.json({data: [{id: '555'}]});
        let m = /^\/v26\.0\/(\d+)\/product_feeds$/.exec(path);
        if (m) return Response.json({data: [...feeds.values()].filter(f => f.catalog === m[1]).map(shown)});
        m = /^\/v26\.0\/(\d+)$/.exec(path);
        if (m && catalogs.has(m[1])) return Response.json(catalogs.get(m[1]));
        if (m && feeds.has(m[1])) return Response.json(shown(feeds.get(m[1])));
        return gone();
      }
      writes++;
      const raw = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
      const b = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => {
          try {
            return [k, JSON.parse(v)];
          } catch {
            return [k, v];
          }
        }),
      );
      let m = /^\/v26\.0\/(\d+)\/product_feeds$/.exec(path);
      if (method === 'POST' && m) {
        const id = String(6200 + writes);
        feeds.set(id, {id, catalog: m[1], product_count: 0, ...b});
        return Response.json({id});
      }
      m = /^\/v26\.0\/(\d+)$/.exec(path);
      if (method === 'POST' && m && feeds.has(m[1])) {
        Object.assign(feeds.get(m[1]), b);
        return Response.json({success: true});
      }
      if (method === 'DELETE' && m && feeds.has(m[1])) {
        feeds.delete(m[1]);
        return Response.json({success: true});
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
      {action: 'prepare', gateway, arguments: {action, account_id: '123', params, ...(payload ? {payload} : {})}},
      actor,
    );
  const create = (payload, catalog = '555') =>
    prepare('meta_product_catalog_id_product_feeds_create', {product_catalog_id: catalog}, payload);
  const update = (feed, payload) => prepare('meta_product_feed_id_update', {product_feed_id: feed}, payload);
  const remove = feed => prepare('meta_product_feed_id_delete', {product_feed_id: feed});
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  const policy = p =>
    saveSpendPolicy(store, owner, {gateway, account_id: '123', connection_id: 'm', confirmed: true, policy: p});
  return {store, calls, feeds, create, update, remove, execute, verify, policy, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1200));
  return r;
};
const refused = (r, code) => assert.equal(r.error?.code, code, JSON.stringify(r).slice(0, 700));

test('a new feed chooses deletion itself, and the review says when Meta fetches and what deletion does', async () => {
  const f = fixture();
  try {
    const p = ok(await f.create({name: 'Prices', schedule: daily, deletion_enabled: true}));
    const impact = p.data.creative_impact;
    assert.match(impact.fetches, /^DAILY at 22:00 \(America\/Los_Angeles, Meta's default\) from https:\/\/shop/);
    assert.match(impact.deletion, /no longer present in a feed/);
    assert.match(impact.deletion, /does not allow turning it off/);
    ok(await f.execute(p));
    const v = ok(await f.verify(p));
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 900));
    const off = ok(
      await f.create({
        name: 'Hourly prices',
        schedule: {interval: 'HOURLY', url: daily.url, timezone: 'Asia/Riyadh'},
        deletion_enabled: false,
      }),
    );
    assert.match(off.data.creative_impact.deletion, /^Off/);
  } finally {
    f.store.close();
  }
});

test('credentials, other hosts, other feed kinds and missing choices are refused before any request', async () => {
  const cases = [
    ['deletion left to the default', {name: 'X', schedule: daily}],
    ['no schedule', {name: 'X', deletion_enabled: false}],
    ['credentials', {name: 'X', schedule: {...daily, username: 'u', password: 'p'}, deletion_enabled: false}],
    ['http', {name: 'X', schedule: {...daily, url: 'http://shop.example.test/feed.csv'}, deletion_enabled: false}],
    ['user in URL', {name: 'X', schedule: {...daily, url: 'https://u:p@shop.example.test/f'}, deletion_enabled: false}],
    ['interval', {name: 'X', schedule: {...daily, interval: 'YEARLY'}, deletion_enabled: false}],
    ['weekday on a daily schedule', {name: 'X', schedule: {...daily, day_of_week: 'MONDAY'}, deletion_enabled: false}],
    ['hour', {name: 'X', schedule: {...daily, hour: 24}, deletion_enabled: false}],
    ['time zone', {name: 'X', schedule: {...daily, timezone: 'Mars/Base'}, deletion_enabled: false}],
    ['feed rules', {name: 'X', schedule: daily, deletion_enabled: false, rules: ['{}']}],
    ['moving items', {name: 'X', schedule: daily, deletion_enabled: false, migrated_from_feed_id: '6001'}],
    [
      'supplementary',
      {name: 'X', schedule: daily, deletion_enabled: false, ingestion_source_type: 'SUPPLEMENTARY_FEED'},
    ],
    ['hotel feed', {name: 'X', schedule: daily, deletion_enabled: false, feed_type: 'HOTEL'}],
  ];
  for (const [label, payload] of cases) {
    const f = fixture();
    try {
      const r = await f.create(payload);
      assert.equal(r.success, false, label);
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
});

test('feeds of catalogs of the account business only; names are unique in a catalog', async () => {
  const f = fixture();
  try {
    refused(await f.create({name: 'daily', schedule: daily, deletion_enabled: false}), 'CONFIGURATION_EXISTS');
    refused(await f.create({name: 'X', schedule: daily, deletion_enabled: false}, '556'), 'STATE_TARGET_MISMATCH');
    refused(await f.update('6100', {name: 'Mine now'}), 'STATE_TARGET_MISMATCH');
    refused(await f.update('6999', {name: 'Gone'}), 'STATE_NOT_FOUND');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a change reads back; deletion once enabled stays enabled', async () => {
  const f = fixture();
  try {
    refused(await f.update('6001', {deletion_enabled: false}), 'INVALID_META_PRODUCT_FEED');
    refused(await f.update('6001', {name: 'Daily'}), 'INVALID_META_PRODUCT_FEED');
    const p = ok(
      await f.update('6002', {
        name: 'Weekly',
        schedule: {interval: 'WEEKLY', url: daily.url, day_of_week: 'FRIDAY', hour: 6},
      }),
    );
    assert.match(p.data.creative_impact.fetches, /^WEEKLY on FRIDAY at 06:00/);
    ok(await f.execute(p));
    const v = ok(await f.verify(p));
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 900));
  } finally {
    f.store.close();
  }
});

test("deleting a feed quotes Meta's warning about the ads using its products, and reads back as gone", async () => {
  const f = fixture();
  try {
    const live = ok(await f.remove('6001'));
    assert.match(
      live.data.creative_impact.effect,
      /effectively disables all ads using products that come from this feed/,
    );
    assert.match(live.data.creative_impact.effect, /This feed holds products/);
    assert.equal(live.data.creative_impact.may_affect_serving, true);
    const p = ok(await f.remove('6002'));
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    ok(await f.execute(p));
    assert.equal(f.feeds.has('6002'), false);
    const v = ok(await f.verify(p));
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 900));
  } finally {
    f.store.close();
  }
});

/**
 * WRT-02 stage C (owner decision D8): allow_deletion:false also governs deletion through a feed, judged on the feed's
 * current state. Before, only a feed DELETE was destructive, so re-pointing a feed whose deletion is on (its next fetch
 * removes every product the new file lacks) passed a policy that forbids deletion.
 */
test('with allow_deletion:false, feed-driven deletion is refused against the current feed; other feed changes are not', async () => {
  const f = fixture();
  try {
    f.policy({allow_deletion: false, allow_activation: true});
    const other = 'https://shop.example.test/other.csv';
    // 6001 has deletion on: a new URL, interval or interval count deletes what the new file lacks.
    for (const schedule of [
      {...daily, url: other},
      {...daily, interval: 'WEEKLY', day_of_week: 'MONDAY'},
      {...daily, interval_count: 2},
    ])
      refused(await f.update('6001', {schedule}), 'POLICY_DELETION_FORBIDDEN');
    // The same file at another hour, a new name or an update-only schedule removes nothing.
    ok(await f.update('6001', {schedule: {...daily, hour: 6}}));
    ok(await f.update('6001', {name: 'Daily prices'}));
    ok(await f.update('6001', {update_schedule: {...daily, url: other}}));
    // 6002 has deletion off: re-pointing it adds and updates only, but turning deletion on is a deletion rule.
    ok(await f.update('6002', {schedule: {...daily, url: other}}));
    refused(await f.update('6002', {deletion_enabled: true}), 'POLICY_DELETION_FORBIDDEN');
    // A new feed with deletion off is allowed; one with deletion on carries the rule (D8), and a DELETE stays refused.
    ok(await f.create({name: 'Prices', schedule: daily, deletion_enabled: false}));
    refused(await f.create({name: 'Prices', schedule: daily, deletion_enabled: true}), 'POLICY_DELETION_FORBIDDEN');
    refused(await f.remove('6002'), 'POLICY_DELETION_FORBIDDEN');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a feed re-point prepared before the owner forbade deletion is refused at execute from the re-read feed', async () => {
  const f = fixture();
  try {
    const p = ok(await f.update('6001', {schedule: {...daily, url: 'https://shop.example.test/other.csv'}}));
    f.policy({allow_deletion: false, allow_activation: true});
    refused(await f.execute(p), 'POLICY_DELETION_FORBIDDEN');
    assert.equal(f.writes(), 0);
    assert.equal(f.feeds.get('6001').schedule.url, daily.url);
  } finally {
    f.store.close();
  }
});

test('the ledger lists the three feed writes; feed rules and uploads stay blocked', () => {
  const rows = actionContracts(registry);
  assert.deepEqual(
    rows
      .filter(r => r.family === 'meta_product_feeds')
      .map(r => r.action)
      .sort(),
    ['meta_product_catalog_id_product_feeds_create', 'meta_product_feed_id_delete', 'meta_product_feed_id_update'],
  );
  assert.equal(rows.find(r => r.action === 'meta_product_feed_id_rules_create')?.status, 'blocked_write');
});
