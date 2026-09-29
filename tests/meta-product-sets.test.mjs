import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Product sets of Meta catalogs, opened by the owner on 2026-09-29. Meta's "Product Catalog Product Sets" reference (read
 * 2026-09-29): POST /{product_catalog_id}/product_sets takes name (required), filter ("a JSON-encoded rule", at most
 * 500 KiB; empty selects every item), retailer_id, metadata and publish_to_shops, answers {id}; error 10803 "Product
 * set with the same filters already exists"; "If the filter rules you set result in an empty product set, ads tied to
 * this product set will not deliver." The node's update and delete (allow_live_product_set_deletion) are in Meta's
 * Business SDK 26.0.2.
 */
const gateway = 'meta_native_action',
  registry = new Registry(),
  actor = {tenantId: 'meta-product-sets', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const shoes = {category: {i_contains: 'shoe'}},
  bags = {or: [{product_type: {contains: 'bag'}}, {brand: {is_any: ['Acme', 'Zenith']}}]};
function fixture(options = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 44).toString('base64'));
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
      scopes: options.scopes ?? ['ads_management', 'catalog_management'],
    },
    {accessToken: 'synthetic'},
  );
  const catalogs = new Map([
    ['555', {id: '555', name: 'Riyadh shop', vertical: 'commerce', product_count: 40, business: {id: '900'}}],
    ['556', {id: '556', name: 'Partner shop', vertical: 'commerce', product_count: 9, business: {id: '901'}}],
  ]);
  const sets = new Map([
    [
      '7001',
      {id: '7001', name: 'Shoes', filter: JSON.stringify(shoes), product_catalog: {id: '555'}, product_count: 12},
    ],
    ['7002', {id: '7002', name: 'Bags', filter: JSON.stringify(bags), product_catalog: {id: '555'}, product_count: 5}],
  ]);
  const adsets = options.adsets ?? [
    {id: '221', name: 'Shoes DPA', status: 'ACTIVE', promoted_object: {product_set_id: '7001'}},
  ];
  const creatives = options.creatives ?? [];
  const calls = [];
  let writes = 0;
  const gone = () =>
    Response.json(
      {error: {message: 'Unsupported get request.', type: 'GraphMethodException', code: 100, error_subcode: 33}},
      {status: 400},
    );
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method,
        query = Object.fromEntries(u.searchParams);
      calls.push({method, path, query});
      if (method === 'GET') {
        if (path === '/v26.0/act_123') return Response.json({id: 'act_123', business: {id: '900'}});
        if (path === '/v26.0/act_123/adsets') return Response.json({data: adsets});
        if (path === '/v26.0/act_123/adcreatives') return Response.json({data: creatives});
        let m = /^\/v26\.0\/(\d+)\/product_sets$/.exec(path);
        if (m) return Response.json({data: [...sets.values()].filter(s => s.product_catalog.id === m[1])});
        m = /^\/v26\.0\/(\d+)\/products$/.exec(path);
        if (m) {
          if (/badfield/.test(query.filter))
            return Response.json(
              {error: {message: 'Invalid parameter', code: 100, error_user_msg: 'Unknown field badfield in filter.'}},
              {status: 400},
            );
          const none = /nomatch/.test(query.filter);
          return Response.json({data: none ? [] : [{id: '1'}]});
        }
        m = /^\/v26\.0\/(\d+)$/.exec(path);
        if (m && catalogs.has(m[1])) return Response.json(catalogs.get(m[1]));
        if (m && sets.has(m[1])) return Response.json(sets.get(m[1]));
        return gone();
      }
      writes++;
      const raw = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
      let m = /^\/v26\.0\/(\d+)\/product_sets$/.exec(path);
      if (method === 'POST' && m) {
        const id = String(7100 + writes);
        if (!options.ignore)
          sets.set(id, {id, name: raw.name, filter: raw.filter ?? '{}', product_catalog: {id: m[1]}, product_count: 7});
        return Response.json({id});
      }
      m = /^\/v26\.0\/(\d+)$/.exec(path);
      if (method === 'POST' && m && sets.has(m[1])) {
        const s = sets.get(m[1]);
        if (raw.name !== undefined) s.name = raw.name;
        if (raw.filter !== undefined) s.filter = raw.filter;
        return Response.json({success: true});
      }
      if (method === 'DELETE' && m && sets.has(m[1])) {
        sets.delete(m[1]);
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
    prepare('meta_product_catalog_id_product_sets_create', {product_catalog_id: catalog}, payload);
  const update = (set, payload) => prepare('meta_product_set_id_update', {product_set_id: set}, payload);
  const remove = (set, extra) => prepare('meta_product_set_id_delete', {product_set_id: set, ...extra});
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, sets, catalogs, create, update, remove, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1200));
  return r;
};
const refused = (r, code) => assert.equal(r.error?.code, code, JSON.stringify(r).slice(0, 700));

test('a product set is created in a catalog of the account business, with what it selects, and read back', async () => {
  const f = fixture();
  try {
    const p = ok(await f.create({name: 'Running', filter: {category: {starts_with: 'Shoes > Running'}}}));
    const impact = p.data.creative_impact;
    assert.equal(impact.scope, 'product_set');
    assert.equal(impact.catalog.name, 'Riyadh shop');
    assert.match(impact.selects, /at least one/);
    assert.match(impact.effect, /ads show it only once/);
    ok(await f.execute(p));
    assert.equal(f.writes(), 1);
    const created = f.sets.get('7101');
    assert.deepEqual(JSON.parse(created.filter), {category: {starts_with: 'Shoes > Running'}});
    const v = ok(await f.verify(p));
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 900));
  } finally {
    f.store.close();
  }
});

test('the filter grammar, shop publishing and collection metadata are refused before any request', async () => {
  const cases = [
    ['no name', {filter: shoes}],
    ['shop publishing', {name: 'X', publish_to_shops: [{shop_id: '1'}]}],
    ['collection metadata', {name: 'X', metadata: {description: 'x'}}],
    ['unknown operator', {name: 'X', filter: {brand: {like: 'A'}}}],
    ['starts_with outside category', {name: 'X', filter: {brand: {starts_with: 'A'}}}],
    ['two operators', {name: 'X', filter: {brand: {eq: 'A', neq: 'B'}}}],
    ['two fields in one rule', {name: 'X', filter: {brand: {eq: 'A'}, color: {eq: 'red'}}}],
    ['empty list', {name: 'X', filter: {brand: {is_any: []}}}],
    ['text for a number', {name: 'X', filter: {price: {lt: 'cheap'}}}],
    ['not JSON', {name: 'X', filter: '{brand:'}],
    ['empty inner rule', {name: 'X', filter: {and: [{}]}}],
    ['too deep', {name: 'X', filter: {and: [{and: [{and: [{and: [{and: [{and: [{and: [shoes]}]}]}]}]}]}]}}],
  ];
  for (const [label, payload] of cases) {
    const f = fixture();
    try {
      const r = await f.create(payload);
      assert.equal(r.success, false, label);
      assert.equal(f.calls.length, 0, label + ': ' + JSON.stringify(f.calls));
    } finally {
      f.store.close();
    }
  }
});

test("Meta's own reading of the filter, the catalog's business, names and filters already used", async () => {
  const f = fixture();
  try {
    const r = await f.create({name: 'X', filter: {badfield: {eq: 'x'}}});
    refused(r, 'INVALID_META_PRODUCT_SET');
    assert.match(r.error.message, /Unknown field badfield/);
    refused(await f.create({name: 'Other', filter: shoes}, '556'), 'STATE_TARGET_MISMATCH');
    refused(await f.create({name: 'shoes', filter: {color: {eq: 'red'}}}), 'CONFIGURATION_EXISTS');
    refused(await f.create({name: 'Shoes two', filter: shoes}), 'CONFIGURATION_EXISTS');
    const empty = ok(await f.create({name: 'Nothing yet', filter: {brand: {eq: 'nomatch'}}}));
    assert.match(empty.data.creative_impact.warning, /do not deliver/);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a change shows the ad sets that deliver from the set, and never empties a set they use', async () => {
  const f = fixture();
  try {
    const empty = await f.update('7001', {filter: {brand: {eq: 'nomatch'}}});
    refused(empty, 'PRODUCT_SET_EMPTY');
    assert.match(empty.error.remedy.action, /Nothing was submitted.*pause those ad sets/);
    const p = ok(await f.update('7001', {name: 'Shoes and boots', filter: {category: {i_contains: 'boot'}}}));
    const impact = p.data.creative_impact;
    assert.equal(impact.may_affect_serving, true);
    assert.deepEqual(
      impact.used_by.ad_sets.map(a => a.id),
      ['221'],
    );
    assert.match(impact.note, /other ad accounts that share the catalog/);
    // A feed run between prepare and execute changes the counts; the review does not keep them, so it still executes.
    f.catalogs.get('555').product_count = 41;
    f.sets.get('7001').product_count = 13;
    ok(await f.execute(p));
    const v = ok(await f.verify(p));
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 900));
    refused(await f.update('7002', {name: 'Bags'}), 'INVALID_META_PRODUCT_SET');
    refused(await f.update('9999', {name: 'Gone'}), 'STATE_NOT_FOUND');
  } finally {
    f.store.close();
  }
});

test('a set in use is not deleted; an unused one is, and reads back as gone', async () => {
  const f = fixture({creatives: [{id: '8801', status: 'ACTIVE', product_set_id: '7002'}]});
  try {
    const used = await f.remove('7001');
    refused(used, 'PRODUCT_SET_IN_USE');
    assert.deepEqual(used.error.details?.ad_sets ?? used.error.ad_sets, ['221']);
    refused(await f.remove('7002'), 'PRODUCT_SET_IN_USE');
    const live = await f.remove('7002', {allow_live_product_set_deletion: true});
    assert.equal(live.success, false);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    const p = ok(await g.remove('7002'));
    assert.match(p.data.creative_impact.effect, /no ad set or creative of the selected account uses it/);
    ok(await g.execute(p));
    assert.equal(g.sets.has('7002'), false);
    const v = ok(await g.verify(p));
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 900));
  } finally {
    g.store.close();
  }
});

test('writes need catalog_management and ads_management; the ledger lists the three writes', async () => {
  const f = fixture({scopes: ['ads_management']});
  try {
    const r = await f.create({name: 'X', filter: shoes});
    refused(r, 'INSUFFICIENT_SCOPE');
    assert.match(r.error.message, /catalog_management/);
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
  const rows = actionContracts(registry).filter(r => r.family === 'meta_product_sets');
  assert.deepEqual(rows.map(r => r.action).sort(), [
    'meta_product_catalog_id_product_sets_create',
    'meta_product_set_id_delete',
    'meta_product_set_id_update',
  ]);
});
