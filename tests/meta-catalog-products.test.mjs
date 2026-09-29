import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Products of Meta catalogs, opened by the owner on 2026-09-29. Meta's "Product Catalog Products" reference (read
 * 2026-09-29): POST /{product_catalog_id}/products takes retailer_id, name, price (hundredths: "100" for 1), currency and
 * image_url (required), answers {id}; allow_upsert "Default value: true. If the retailer_id of the item already exists
 * in the catalog, setting this flag to true allows the request to update the item". Filter fields price_amount and
 * sale_price_amount are "multiplied by 100, for all currencies".
 */
const gateway = 'meta_native_action',
  registry = new Registry(),
  actor = {tenantId: 'meta-catalog-products', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const shoe = {
  retailer_id: 'SKU-1',
  name: 'Trail shoe',
  price: 49900,
  currency: 'SAR',
  image_url: 'https://cdn.example.test/shoe.jpg',
  url: 'https://shop.example.test/shoe',
  availability: 'in stock',
};
function fixture(options = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 46).toString('base64'));
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
    ['555', {id: '555', name: 'Riyadh shop', vertical: 'commerce', product_count: 40, business: {id: '900'}}],
    ['556', {id: '556', name: 'Partner shop', vertical: 'commerce', product_count: 9, business: {id: '901'}}],
  ]);
  // Products by retailer_id, with the price in hundredths as Meta keeps it; reads show it formatted.
  const products = new Map(
    (options.existing ?? []).map(p => [p.retailer_id, {id: '9' + p.retailer_id.replace(/\D/g, ''), ...p}]),
  );
  const shown = p => ({
    ...p,
    price: (p.price / 100).toFixed(2) + ' ' + p.currency,
    ...(p.sale_price !== undefined ? {sale_price: (p.sale_price / 100).toFixed(2) + ' ' + p.currency} : {}),
  });
  const calls = [];
  let writes = 0;
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method,
        query = Object.fromEntries(u.searchParams);
      calls.push({method, path, query});
      if (method === 'GET') {
        if (path === '/v26.0/act_123') return Response.json({id: 'act_123', business: {id: '900'}});
        let m = /^\/v26\.0\/(\d+)\/products$/.exec(path);
        if (m) {
          const f = JSON.parse(query.filter),
            rules = f.and ?? [f],
            retailer = rules.find(r => r.retailer_id)?.retailer_id.eq,
            p = products.get(retailer);
          const within = (field, value) => {
            const lo = rules.find(r => r[field]?.gte !== undefined)?.[field].gte,
              hi = rules.find(r => r[field]?.lte !== undefined)?.[field].lte;
            return lo === undefined || (value >= lo && value <= hi);
          };
          const hit = p && within('price_amount', p.price) && within('sale_price_amount', p.sale_price);
          return Response.json({data: hit ? [query.fields === 'id' ? {id: p.id} : shown(p)] : []});
        }
        m = /^\/v26\.0\/(\d+)$/.exec(path);
        if (m && catalogs.has(m[1])) return Response.json(catalogs.get(m[1]));
        return Response.json(
          {error: {message: 'Unsupported get request.', code: 100, error_subcode: 33}},
          {status: 400},
        );
      }
      writes++;
      const raw = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
      const b = {};
      for (const [k, v] of Object.entries(raw))
        b[k] = ['price', 'sale_price', 'inventory'].includes(k)
          ? Number(v)
          : v === 'true'
            ? true
            : v === 'false'
              ? false
              : v;
      const before = products.get(b.retailer_id),
        id = before?.id ?? String(8000 + writes);
      if (!options.ignore)
        products.set(b.retailer_id, {
          ...(before ?? {}),
          ...b,
          id,
          ...(options.stalePrice && before ? {price: before.price} : {}),
        });
      return Response.json({id});
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
  const prepare = (payload, catalog = '555') =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action: 'meta_product_catalog_id_products_create',
          account_id: '123',
          params: {product_catalog_id: catalog},
          payload,
        },
      },
      actor,
    );
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, products, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1200));
  return r;
};
const refused = (r, code) => assert.equal(r.error?.code, code, JSON.stringify(r).slice(0, 700));

test('a new product is reviewed with its price as people read it, and Meta itself confirms the price after the write', async () => {
  const f = fixture();
  try {
    const p = ok(await f.prepare(shoe));
    const impact = p.data.creative_impact;
    assert.equal(impact.operation, 'create');
    assert.equal(impact.creating.price, '499 SAR');
    assert.equal(impact.catalog.name, 'Riyadh shop');
    ok(await f.execute(p));
    assert.equal(f.products.get('SKU-1').price, 49900);
    const v = ok(await f.verify(p));
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 900));
    // The price check goes through Meta's own numeric filter, not the formatted text.
    assert.ok(f.calls.some(c => /price_amount/.test(c.query.filter ?? '') && /49900/.test(c.query.filter)));
  } finally {
    f.store.close();
  }
});

test('a retailer_id already in the catalog is replaced only when the request says allow_upsert, and the review shows before and after', async () => {
  const existing = [{...shoe, price: 45000, name: 'Trail shoe 2025'}];
  const f = fixture({existing});
  try {
    const silent = await f.prepare(shoe);
    refused(silent, 'CONFIGURATION_EXISTS');
    assert.match(silent.error.message, /allow_upsert: true/);
    refused(await f.prepare({...shoe, allow_upsert: false}), 'CONFIGURATION_EXISTS');
    const p = ok(await f.prepare({...shoe, allow_upsert: true, sale_price: 42000}));
    const impact = p.data.creative_impact;
    assert.equal(impact.operation, 'update');
    assert.equal(impact.before.price, '450.00 SAR');
    assert.equal(impact.after.price, '499 SAR');
    assert.equal(impact.after.sale_price, '420 SAR');
    assert.equal(impact.may_affect_serving, true);
    ok(await f.execute(p));
    const v = ok(await f.verify(p));
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 900));
  } finally {
    f.store.close();
  }
});

test('a price Meta did not keep fails verification, even though the formatted text is not compared', async () => {
  const f = fixture({ignore: true});
  try {
    const p = ok(await f.prepare(shoe));
    ok(await f.execute(p));
    const v = await f.verify(p);
    assert.notEqual(v.data?.status, 'verified', JSON.stringify(v).slice(0, 900));
  } finally {
    f.store.close();
  }
  // Every text field matches; only the price stayed as it was.
  const g = fixture({existing: [{...shoe, price: 45000}], stalePrice: true});
  try {
    const p = ok(await g.prepare({...shoe, allow_upsert: true}));
    ok(await g.execute(p));
    assert.equal(g.products.get('SKU-1').price, 45000);
    const v = await g.verify(p);
    assert.notEqual(v.data?.status, 'verified', JSON.stringify(v).slice(0, 900));
    assert.match(JSON.stringify(v.data), /price_matches/);
  } finally {
    g.store.close();
  }
});

test('product fields are checked before any request; shops, checkout, app links and batches stay out', async () => {
  const cases = [
    ['no price', {...shoe, price: undefined}],
    ['price in units', {...shoe, price: 499.5}],
    ['negative price', {...shoe, price: -1}],
    ['bad currency', {...shoe, currency: 'riyal'}],
    ['http image', {...shoe, image_url: 'http://cdn.example.test/shoe.jpg'}],
    ['unknown availability', {...shoe, availability: 'soon'}],
    ['checkout', {...shoe, checkout_url: 'https://shop.example.test/checkout'}],
    ['shops', {...shoe, quantity_to_sell_on_facebook: 3}],
    ['app link', {...shoe, ios_url: 'shop://shoe'}],
    ['variants', {...shoe, custom_data: {size: 'L'}}],
    ['sale dates without sale price', {...shoe, sale_price_end_date: '2026-12-01T00:00:00Z'}],
    [
      'sale ends before it starts',
      {
        ...shoe,
        sale_price: 1,
        sale_price_start_date: '2026-12-02T00:00:00Z',
        sale_price_end_date: '2026-12-01T00:00:00Z',
      },
    ],
    ['long description', {...shoe, description: 'x'.repeat(5001)}],
    ['upsert as text', {...shoe, allow_upsert: 'true'}],
  ];
  for (const [label, payload] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare(JSON.parse(JSON.stringify(payload)));
      assert.equal(r.success, false, label);
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
});

test("only catalogs of the account's business; the ledger lists the write", async () => {
  const f = fixture();
  try {
    refused(await f.prepare(shoe, '556'), 'STATE_TARGET_MISMATCH');
    refused(await f.prepare(shoe, '557'), 'STATE_NOT_FOUND');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  const rows = actionContracts(registry).filter(r => r.family === 'meta_catalog_products');
  assert.deepEqual(
    rows.map(r => r.action),
    ['meta_product_catalog_id_products_create'],
  );
});
