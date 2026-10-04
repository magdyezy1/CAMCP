import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import fs from 'node:fs';
import {
  metaCatalogProductSnapshots,
  metaCatalogProductVerification,
  metaCatalogProductObserved,
} from '../dist/src/meta-catalog-products.js';
import {normalize, differing, verificationContractVersion} from '../dist/src/verification-reads.js';
import {metaPrefix} from '../dist/src/meta-version.js';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';

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
      const reply = (data, responseOptions) =>
        Response.json(options.read?.({path, query}, structuredClone(data)) ?? data, responseOptions);
      if (method === 'GET') {
        if (path === '/v26.0/act_123') return reply({id: 'act_123', business: {id: '900'}});
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
          return reply({data: hit ? [query.fields === 'id' ? {id: p.id} : shown(p)] : []});
        }
        m = /^\/v26\.0\/(\d+)$/.exec(path);
        if (m && catalogs.has(m[1])) return reply(catalogs.get(m[1]));
        return reply({error: {message: 'Unsupported get request.', code: 100, error_subcode: 33}}, {status: 400});
      }
      writes++;
      const raw = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
      const b = {};
      for (const [k, v] of Object.entries(raw))
        b[k] =
          k === 'additional_image_urls'
            ? JSON.parse(v)
            : ['price', 'sale_price', 'inventory'].includes(k)
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
          ...Object.fromEntries(Object.entries(b).filter(([key]) => !options.ignoreFields?.includes(key))),
          id,
          ...(options.stalePrice && before ? {price: before.price} : {}),
        });
      return Response.json(options.receipt?.({id}) ?? {id});
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
  return {store, service, calls, products, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1200));
  return r;
};
const refused = (r, code) => assert.equal(r.error?.code, code, JSON.stringify(r).slice(0, 700));

const advancedShoe = {
  ...shoe,
  description: 'Exact plain description',
  short_description: 'Exact short description',
  brand: 'Original brand',
  category: 'Original category',
  fb_product_category: '123',
  product_type: 'Shoes > Trail',
  color: 'Black',
  size: '42',
  material: 'Cotton',
  pattern: 'Solid',
  gtin: '0123456789012',
  manufacturer_part_number: 'PART-01',
  retailer_product_group_id: 'PARENT-SKU',
  custom_label_0: 'Summer',
  custom_label_1: 'Original label 1',
  custom_label_2: 'Original label 2',
  custom_label_3: 'Original label 3',
  custom_label_4: 'Original label 4',
  condition: 'new',
  age_group: 'adult',
  gender: 'unisex',
  visibility: 'published',
  mobile_link: 'https://shop.example.test/mobile/shoe',
  additional_image_urls: ['https://cdn.example.test/side.jpg', 'https://cdn.example.test/back.jpg'],
  inventory: 4,
  sale_price: 42000,
  sale_price_start_date: '2026-10-05T00:00:00Z',
  sale_price_end_date: '2026-10-06T00:00:00Z',
};
const compiledProduct = payload => ({
  gateway,
  accountId: '123',
  action: 'meta_product_catalog_id_products_create',
  method: 'POST',
  path: metaPrefix + '555/products',
  query: {},
  headers: {},
  body: payload,
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  evidence: 'Synthetic exact product',
  warnings: [],
});

test('every observable accepted catalog field is backed by the pinned v26 SDK and included in exact verification', () => {
  const evidence = JSON.parse(
      fs.readFileSync(new URL('./fixtures/meta-catalog-product-fields-sdk-v26.json', import.meta.url)),
    ),
    plan = compiledProduct(advancedShoe),
    proof = metaCatalogProductVerification(plan, {data: {id: '8001'}})[0],
    observed = {product: {present: true, id: '8001', ...advancedShoe}, price_matches: true, sale_price_matches: true};
  assert.equal(evidence.sdk_tag, '26.0.2');
  assert.equal(Object.keys(evidence.fields).length, 35);
  assert.deepEqual(Object.keys(advancedShoe).sort(), Object.keys(evidence.fields).sort());
  assert.equal(evidence.sources.productitem.sha256, '05dd94ae995f2003f15bb3436effb4871ca6bb2c9eb5f669f173a6d005de6625');
  assert.equal(
    evidence.sources.productcatalog.sha256,
    '6bed556f4ffee852db5f1888330a47ede9af3bc60f42e5265e0de208f07672fd',
  );
  assert.equal(verificationContractVersion(plan), 'meta-catalog-product-fields-v2');
  for (const field of Object.keys(evidence.fields).filter(field => !['price', 'sale_price'].includes(field))) {
    assert.deepEqual(proof.expected.product[field], advancedShoe[field], field);
    const missing = structuredClone(observed);
    delete missing.product[field];
    const projected = metaCatalogProductObserved(proof.read, missing);
    assert.ok(
      differing(normalize(proof.expected), normalize(projected)).some(path => path.endsWith('/' + field)),
      field,
    );
  }
  for (const field of ['price_matches', 'sale_price_matches']) {
    const missing = {...observed, [field]: false};
    assert.ok(
      differing(normalize(proof.expected), normalize(metaCatalogProductObserved(proof.read, missing))).includes(
        '/' + field,
      ),
    );
  }
  assert.throws(
    () =>
      metaCatalogProductVerification(compiledProduct({...shoe, unknown_legacy_field: 'value'}), {data: {id: '8001'}}),
    {code: 'VERIFICATION_UNSUPPORTED'},
  );
});

test('all accepted optional fields retain native types and exact ordered images through review and receipt-bound read-back', async () => {
  const f = fixture();
  try {
    const p = ok(await f.prepare(advancedShoe));
    assert.deepEqual(p.data.creative_impact.creating.additional_image_urls, advancedShoe.additional_image_urls);
    assert.equal(p.data.creative_impact.creating.inventory, 4);
    ok(await f.execute(p));
    const verified = ok(await f.verify(p)).data;
    assert.equal(verified.status, 'verified', JSON.stringify(verified));
    assert.equal(verified.verification_cache_version, 'meta-catalog-product-fields-v2');
    const productRead = f.calls.find(call => call.query.fields?.includes('retailer_product_group_id'));
    const fields = productRead.query.fields.split(',');
    assert.equal(fields.length, 36);
    assert.equal(new Set(fields).size, 36);
    assert.ok(
      fields.includes('inventory') &&
        fields.includes('additional_image_urls') &&
        fields.includes('sale_price_start_date'),
    );
    await f.execute(p);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

for (const field of ['retailer_product_group_id', 'custom_label_0', 'sale_price_start_date'])
  test('discarded native catalog field cannot verify or replay a mutation: ' + field, async () => {
    const f = fixture({ignoreFields: [field]});
    try {
      const p = ok(await f.prepare(advancedShoe)),
        accepted = ok(await f.execute(p));
      const result = ok(await f.verify(p));
      assert.notEqual(result.data.status, 'verified');
      assert.ok(result.data.checks.some(check => check.changed_fields?.includes('/product/' + field)));
      assert.equal(f.products.get('SKU-1')[field], undefined);
      const replay = ok(await f.execute(p));
      assert.equal(replay.data.replayed, true);
      assert.deepEqual(replay.data.data, accepted.data.data);
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  });

test('inventory and additional-image native types cannot be coerced, malformed or silently dropped', async () => {
  for (const [field, value] of [
    ['inventory', '4'],
    ['inventory', -1],
    ['inventory', 1.5],
    ['inventory', Number.MAX_SAFE_INTEGER + 1],
    ['additional_image_urls', 'https://cdn.example.test/i.jpg'],
    ['additional_image_urls', ['https://user:pass@cdn.example.test/i.jpg']],
    ['additional_image_urls', Array.from({length: 21}, () => 'https://cdn.example.test/i.jpg')],
    ['custom_label_0', {value: 'Label'}],
    ['sale_price_start_date', 123],
  ]) {
    const f = fixture({
      existing: [advancedShoe],
      read: (p, data) =>
        p.path.endsWith('/products') && p.query.fields !== 'id'
          ? {...data, data: data.data.map(row => ({...row, [field]: value}))}
          : data,
    });
    try {
      const result = await f.prepare({...advancedShoe, allow_upsert: true});
      assert.equal(result.success, false, field + ':' + JSON.stringify(value));
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test('original optional product configuration changes invalidate an unsent review', async () => {
  for (const field of [
    'retailer_product_group_id',
    'custom_label_0',
    'inventory',
    'additional_image_urls',
    'sale_price_start_date',
  ]) {
    const f = fixture({existing: [advancedShoe]});
    try {
      const p = ok(await f.prepare({...advancedShoe, allow_upsert: true}));
      f.products.get('SKU-1')[field] =
        field === 'inventory'
          ? 5
          : field === 'additional_image_urls'
            ? [...advancedShoe.additional_image_urls].reverse()
            : 'Changed';
      assert.equal((await f.execute(p)).success, false, field);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test('retired partial verification cache is replaced by a current read without changing the accepted receipt or key', async () => {
  for (const changed of [false, true]) {
    const f = fixture();
    try {
      const p = ok(await f.prepare(advancedShoe)),
        accepted = ok(await f.execute(p));
      f.store.putDocument(actor.tenantId, 'write_verification', p.data.review_id, {
        status: 'verified',
        checked_at: Date.now(),
        checks: [],
      });
      const receipt = f.store.db
        .prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?')
        .get(actor.tenantId, p.data.review_id);
      if (changed) f.products.get('SKU-1').custom_label_0 = 'Other label';
      const reads = f.calls.length,
        result = ok(await f.verify(p)).data;
      assert.notEqual(result.cached, true);
      assert.ok(f.calls.length > reads);
      assert.equal(result.verification_cache_version, 'meta-catalog-product-fields-v2');
      assert.equal(result.status === 'verified', !changed);
      if (!changed) assert.equal(ok(await f.verify(p)).data.cached, true);
      assert.deepEqual(
        f.store.db
          .prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?')
          .get(actor.tenantId, p.data.review_id),
        receipt,
      );
      assert.deepEqual(ok(await f.execute(p)).data.data, accepted.data.data);
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  }
});

test('pending product plans recheck retired predecessor proof before preparing dependent writes', async () => {
  for (const changed of [false, true]) {
    const f = fixture(),
      call = input => f.service.call('amcp_campaign', input, actor);
    try {
      const steps = ['parent', 'child'].map((id, i) => ({
        id,
        kind: 'write',
        gateway,
        account_id: '123',
        connection_id: 'm',
        arguments: {
          action: 'meta_product_catalog_id_products_create',
          params: {product_catalog_id: '555'},
          payload: {...advancedShoe, retailer_id: i ? 'SKU-2' : 'SKU-1'},
        },
        depends_on: i ? ['parent'] : [],
      }));
      const saved = ok(
        await call({
          action: 'create',
          name: 'Synthetic retained product chain',
          brief: 'Synthetic exact product chain; no external requests.',
          steps,
        }),
      );
      const p = ok(await call({action: 'prepare_next', id: saved.data.id}));
      ok(
        await call({
          action: 'execute_next',
          id: saved.data.id,
          review_id: p.data.review.review_id,
          confirmed: true,
        }),
      );
      const run = f.store.document(actor.tenantId, 'campaign_run', saved.data.id),
        reviewId = run.steps[0].review_id;
      assert.equal(
        run.steps[0].status,
        'verified',
        JSON.stringify({error: run.steps[0].error, verification: run.steps[0].verification}),
      );
      delete run.steps[0].verification.verification_cache_version;
      f.store.putDocument(actor.tenantId, 'campaign_run', run.id, run);
      const proof = f.store.document(actor.tenantId, 'write_verification', reviewId);
      delete proof.verification_cache_version;
      f.store.putDocument(actor.tenantId, 'write_verification', reviewId, proof);
      const receipt = f.store.db
        .prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?')
        .get(actor.tenantId, reviewId);
      if (changed) f.products.get('SKU-1').custom_label_0 = 'Other label';
      const resumed = ok(await call({action: 'prepare_next', id: run.id}));
      const current = f.store.document(actor.tenantId, 'campaign_run', run.id).steps[0];
      assert.equal(current.verification.verification_cache_version, 'meta-catalog-product-fields-v2');
      if (changed) {
        assert.equal(resumed.data.review, undefined);
        assert.notEqual(current.status, 'verified');
      } else {
        assert.equal(current.status, 'verified');
        assert.equal(resumed.data.step_id, 'child');
        assert.ok(resumed.data.review.review_id);
      }
      assert.equal(f.writes(), 1);
      assert.deepEqual(
        f.store.db
          .prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?')
          .get(actor.tenantId, reviewId),
        receipt,
      );
    } finally {
      f.store.close();
    }
  }
});

test('real MCP SDK preserves optional product fields, current complete proof, original receipt replay and revoked access', async t => {
  const f = fixture(),
    key = f.store.createKey(actor),
    currentActor = f.store.authenticate(key),
    server = createMcpServer(f.service, currentActor),
    client = new Client({name: 'Synthetic catalog field evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let calls = 0,
    bytes = 0;
  try {
    const tools = (await client.listTools()).tools,
      validators = new Map(
        ['amcp_write', 'amcp_campaign'].map(name => [
          name,
          new Ajv({strict: false}).compile(tools.find(tool => tool.name === name).inputSchema),
        ]),
      );
    const call = async (name, input) => {
      assert.equal(validators.get(name)(input), true);
      const out = await client.callTool({name, arguments: input});
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(out.structuredContent));
      assert.deepEqual(JSON.parse(out.content[0].text), JSON.parse(JSON.stringify(out.structuredContent)));
      assert.equal(out.isError === true, out.structuredContent.success === false);
      assert.doesNotMatch(JSON.stringify(out.structuredContent), /"accessToken"|"Authorization"|Bearer /);
      return out.structuredContent;
    };
    const prepared = ok(
      await call('amcp_write', {
        action: 'prepare',
        gateway,
        connection_id: 'm',
        arguments: {
          action: 'meta_product_catalog_id_products_create',
          account_id: '123',
          params: {product_catalog_id: '555'},
          payload: advancedShoe,
        },
      }),
    );
    assert.deepEqual(prepared.data.creative_impact.creating.additional_image_urls, advancedShoe.additional_image_urls);
    assert.equal(prepared.data.creative_impact.creating.retailer_product_group_id, 'PARENT-SKU');
    const execute = {
      action: 'execute',
      review_id: prepared.data.review_id,
      idempotency_key: prepared.data.idempotency_key,
      confirmed: true,
    };
    const accepted = ok(await call('amcp_write', execute));
    const proof = ok(await call('amcp_campaign', {action: 'verify', review_id: prepared.data.review_id}));
    assert.equal(proof.data.status, 'verified');
    assert.equal(proof.data.verification_cache_version, 'meta-catalog-product-fields-v2');
    const replay = ok(await call('amcp_write', execute));
    assert.equal(replay.data.replayed, true);
    assert.deepEqual(replay.data.data, accepted.data.data);
    const reads = f.calls.length;
    f.store.revokeKey(key);
    assert.equal((await call('amcp_campaign', {action: 'verify', review_id: prepared.data.review_id})).success, false);
    assert.equal(f.calls.length, reads);
    assert.equal(f.writes(), 1);
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        synthetic_native_reads: f.calls.filter(call => call.method === 'GET').length,
        synthetic_mutations: 1,
        provider_requests: 0,
      }),
    );
  } finally {
    await client.close();
    await server.close();
    f.store.close();
  }
});

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
const catalogEvidenceCases = [
  ['malformed product row', (p, d) => (p.path.endsWith('/products') ? {data: [null]} : d)],
  [
    'unfinished product page',
    (p, d) =>
      p.path.endsWith('/products')
        ? {...d, paging: {next: 'https://graph.facebook.com/v26.0/555/products?after=more'}}
        : d,
  ],
  [
    'foreign retailer',
    (p, d) =>
      p.path.endsWith('/products') ? {data: [{...shoe, id: '91', retailer_id: 'OTHER', price: '499.00 SAR'}]} : d,
  ],
  [
    'array product identity',
    (p, d) => (p.path.endsWith('/products') ? {data: [{...shoe, id: ['91'], price: '499.00 SAR'}]} : d),
  ],
  ['foreign account identity', (p, d) => (p.path.endsWith('/act_123') ? {...d, id: 'act_999'} : d)],
  ['foreign catalog identity', (p, d) => (p.path === '/v26.0/555' ? {...d, id: '999'} : d)],
  ['coerced business identity', (p, d) => (p.path.endsWith('/act_123') ? {...d, business: {id: ['900']}} : d)],
  ['missing product identity', (p, d) => (p.path.endsWith('/products') ? {data: [{...shoe, price: '499.00 SAR'}]} : d)],
  ['coerced account identity', (p, d) => (p.path.endsWith('/act_123') ? {...d, id: ['act_123']} : d)],
  ['coerced catalog identity', (p, d) => (p.path === '/v26.0/555' ? {...d, id: ['555']} : d)],
  ['coerced catalog business', (p, d) => (p.path === '/v26.0/555' ? {...d, business: {id: ['900']}} : d)],
  ['malformed paging', (p, d) => (p.path.endsWith('/products') ? {...d, paging: []} : d)],
  ['unknown paging metadata', (p, d) => (p.path.endsWith('/products') ? {...d, paging: {has_more: true}} : d)],
  ['malformed cursor', (p, d) => (p.path.endsWith('/products') ? {...d, paging: {cursors: {after: ['more']}}} : d)],
  [
    'malformed product fields',
    (p, d) => (p.path.endsWith('/products') ? {data: [{...shoe, id: '91', name: ['Shoe'], price: '499.00 SAR'}]} : d),
  ],
];
for (const [label, read] of catalogEvidenceCases)
  test('catalog evidence declines ' + label + ' before review', async () => {
    const f = fixture({read});
    try {
      const r = await f.prepare({...shoe, allow_upsert: true});
      assert.equal(r.success, false, JSON.stringify(r).slice(0, 900));
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  });
test('catalog evidence cannot verify a retained wrong price using another product filter match', async () => {
  const f = fixture({
    existing: [{...shoe, price: 45000}],
    stalePrice: true,
    read: (p, d) => (p.query.fields === 'id' ? {data: [{id: '999'}]} : d),
  });
  try {
    const p = ok(await f.prepare({...shoe, allow_upsert: true}));
    ok(await f.execute(p));
    const v = await f.verify(p);
    assert.notEqual(v.data?.status, 'verified', JSON.stringify(v).slice(0, 900));
    assert.equal(f.products.get('SKU-1').price, 45000);
    assert.equal(f.writes(), 1);
    await f.execute(p);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
test('catalog evidence refuses identity drift before execution without submitting a write', async () => {
  const options = {},
    f = fixture(options);
  try {
    const p = ok(await f.prepare(shoe));
    options.read = (p, d) => (p.path === '/v26.0/555' ? {...d, id: '999'} : d);
    assert.equal((await f.execute(p)).success, false);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('catalog evidence accepts a complete terminal page with string cursors and verifies both prices for the original product', async () => {
  const f = fixture({
    read: (p, d) => (p.path.endsWith('/products') ? {...d, paging: {cursors: {before: 'first', after: 'last'}}} : d),
  });
  try {
    const p = ok(await f.prepare({...shoe, sale_price: 42000}));
    ok(await f.execute(p));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    await f.execute(p);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('catalog evidence binds sale-price proof to the product in the receipt', async () => {
  const f = fixture({read: (p, d) => (p.query.filter?.includes('sale_price_amount') ? {data: [{id: '999'}]} : d)});
  try {
    const p = ok(await f.prepare({...shoe, sale_price: 42000}));
    ok(await f.execute(p));
    assert.notEqual((await f.verify(p)).data?.status, 'verified');
    await f.execute(p);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

for (const id of [['8001'], 8001, null])
  test(
    'catalog evidence keeps a malformed mutation receipt from becoming a success: ' + JSON.stringify(id),
    async () => {
      const f = fixture({receipt: () => ({id})});
      try {
        const p = ok(await f.prepare(shoe)),
          result = await f.execute(p);
        assert.equal(result.data?.success ?? result.success, false, JSON.stringify(result));
        assert.equal(result.data?.verification, undefined);
        assert.notEqual((await f.verify(p)).data?.status, 'verified');
        await f.execute(p);
        assert.equal(f.writes(), 1);
      } finally {
        f.store.close();
      }
    },
  );

for (const [label, read] of [
  ['account changed after submission', (p, d) => (p.path.endsWith('/act_123') ? {...d, id: 'act_999'} : d)],
  [
    'retailer now resolves another product',
    (p, d) =>
      p.path.endsWith('/products') && p.query.fields !== 'id' ? {...d, data: d.data.map(x => ({...x, id: '999'}))} : d,
  ],
  [
    'price proof has another page',
    (p, d) =>
      p.query.fields === 'id' ? {...d, paging: {next: 'https://graph.facebook.com/v26.0/555/products?after=more'}} : d,
  ],
])
  test('catalog evidence leaves verification incomplete when ' + label, async () => {
    const options = {},
      f = fixture(options);
    try {
      const p = ok(await f.prepare(shoe));
      ok(await f.execute(p));
      options.read = read;
      assert.notEqual((await f.verify(p)).data?.status, 'verified');
      await f.execute(p);
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  });
