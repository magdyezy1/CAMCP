import test from 'node:test';
import assert from 'node:assert/strict';
import {MirrorService} from '../dist/src/service.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertMetaCatalogScope} from '../dist/src/meta-catalogs.js';
import {metaCatalogProductImpact} from '../dist/src/meta-catalog-products.js';
import {catalogComparisonData, catalogComparisonInput} from './fixtures/catalog-comparison-data.mjs';

const actor = {tenantId: 'catalog-comparison', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  input = () => structuredClone(catalogComparisonInput);
function fixture(options = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 51).toString('base64')),
    data = catalogComparisonData(options.input),
    calls = [],
    connection = {
      id: 'catalog-login',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      enabled: true,
      accounts: ['123'],
      writeAccounts: [],
      scopes: options.scopes ?? ['ads_read'],
      label: 'Synthetic read-only catalog',
    };
  store.putConnection(owner, connection, {accessToken: 'synthetic'});
  const transport = new NativeTransport(
    async (raw, init) => {
      const u = new URL(String(raw));
      calls.push({method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams)});
      assert.equal(init.method, 'GET', 'comparison must never mutate a provider');
      const early = options.reply?.(calls.length);
      if (early) return early;
      const result = data.response(raw);
      return Response.json(options.read?.({u, result, calls, data, store, connection}) ?? result);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    200,
  );
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: false,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  return {
    store,
    data,
    calls,
    connection,
    service,
    call: (args = input(), as = actor) => service.call('amcp_workspace', args, as),
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1800));
  return r.data;
};

test('catalog comparison uses scoped native price evidence and returns new, changed, matching and unknown source products without creating reviews', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  const original = input(),
    out = ok(await f.call(original, {...actor, role: 'reader'}));
  assert.deepEqual(
    out.items.map(i => i.state),
    ['new', 'changed', 'matching', 'unknown'],
  );
  assert.deepEqual(out.summary, {
    new: 1,
    changed: 1,
    matching: 1,
    unknown: 1,
    blocked: 0,
    needs_review: 3,
    with_destination_only_values: 0,
  });
  assert.deepEqual(out.review_retailer_ids, ['001', '002', '004']);
  assert.equal(out.items[1].product_id, '9007199254740993');
  assert.deepEqual(
    out.items[1].changes.map(c => c.field),
    ['name', 'price'],
  );
  assert.deepEqual(out.items[3].unknown_fields, ['image_url']);
  assert.equal(out.items[2].price_matches, true, 'zero must stay known');
  assert.equal(out.complete, true);
  assert.equal(out.provider_mutations, 0);
  assert.equal(out.destructive_deletions, 0);
  assert.equal(out.scope.catalog_id, '555');
  assert.equal(out.scope.account_id, '123');
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE-NATIVE-MARKER|accessToken|synthetic-changed/);
  assert.equal(f.store.documents(actor.tenantId, 'campaign_run').length, 0);
  assert.equal(f.store.documents(actor.tenantId, 'write_review').length, 0);
  assert.deepEqual(original, input(), 'source input stays unchanged');
  assert.ok(f.calls.some(c => c.query.fields === 'id' && /price_amount/.test(c.query.filter)));
  assert.equal(out.network_requests, f.calls.length);
});

test('create-only comparisons show existing products as blocked and retain only new products for review', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  const out = ok(await f.call({...input(), allow_upsert: false}));
  assert.equal(out.summary.blocked, 3);
  assert.deepEqual(
    out.items.map(i => i.blocked),
    [false, true, true, true],
  );
  assert.deepEqual(out.review_retailer_ids, ['001']);
  assert.equal(out.summary.needs_review, 1);
});

test('explicit Meta variation group intent compares exact current group values and retains unknown omitted evidence', async t => {
  for (const state of ['matching', 'changed', 'unknown']) {
    const f = fixture();
    t.after(() => f.store.close());
    const original = input(),
      product = {...original.products[2], retailer_product_group_id: 'GROUP-001'};
    original.products = [product];
    if (state !== 'unknown')
      f.data.products.get('003').retailer_product_group_id = state === 'matching' ? 'GROUP-001' : 'OLD-GROUP';
    const out = ok(await f.call(original));
    assert.equal(out.items[0].state, state);
    if (state === 'changed')
      assert.deepEqual(out.items[0].changes, [
        {field: 'retailer_product_group_id', before: 'OLD-GROUP', after: 'GROUP-001'},
      ]);
    if (state === 'unknown') assert.deepEqual(out.items[0].unknown_fields, ['retailer_product_group_id']);
    assert.equal(out.provider_mutations, 0);
    assert.equal(f.store.documents(actor.tenantId, 'write_review').length, 0);
    assert.equal(original.products[0].retailer_product_group_id, 'GROUP-001');
  }
});

test('catalog read refusals describe the actual read permission without requesting catalog write privileges', () => {
  assert.throws(
    () => assertMetaCatalogScope({scopes: []}, false, 'Catalog comparison'),
    error => {
      assert.equal(error.code, 'INSUFFICIENT_SCOPE');
      assert.deepEqual(error.details.required_any, ['ads_read', 'ads_management']);
      assert.doesNotMatch(error.message, /catalog_management|AMCP_META_SCOPES|app review/);
      return true;
    },
  );
});

test('native product review displays exact hundredths throughout the safe integer range', () => {
  for (const cents of [0, 1, 100, 1234, 9007199254740893, Number.MAX_SAFE_INTEGER]) {
    const n = BigInt(cents),
      expected = (n / 100n).toString() + (n % 100n ? '.' + (n % 100n).toString().padStart(2, '0') : '') + ' SAR',
      impact = metaCatalogProductImpact(
        {
          gateway: 'meta_native_action',
          accountId: '123',
          action: 'meta_product_catalog_id_products_create',
          method: 'POST',
          path: '/v26.0/555/products',
          query: {},
          headers: {},
          body: {...input().products[0], price: cents, sale_price: cents},
          readOnly: false,
        },
        [{product: {present: false}, catalog: {id: '555'}}],
      );
    assert.equal(impact.creating.price, expected);
    assert.equal(impact.creating.sale_price, expected);
  }
});

test('invalid imports and missing read/account authority are refused before provider egress', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  for (const patch of [
    {catalog_id: '0'},
    {catalog_id: 555},
    {products: []},
    {allow_upsert: 'true'},
    {account_id: '999'},
    {connection_id: 'foreign'},
    {products: [{...input().products[0], name: ' leading'}]},
  ]) {
    assert.equal((await f.call({...input(), ...patch})).success, false, JSON.stringify(patch));
    assert.equal(f.calls.length, 0);
  }
  f.store.putConnection(owner, {...f.connection, scopes: []}, {accessToken: 'synthetic'});
  assert.equal((await f.call()).error.code, 'INSUFFICIENT_SCOPE');
  assert.equal(f.calls.length, 0);
});

test('foreign, malformed, duplicate, partial and numeric native evidence cannot establish a catalog comparison', async () => {
  for (const mutate of [
    ({u, result}) => {
      if (u.pathname.endsWith('/act_123')) result.id = 'act_999';
    },
    ({u, result}) => {
      if (u.pathname === '/v26.0/555') result.business.id = '901';
    },
    ({u, result}) => {
      if (u.pathname === '/v26.0/555') result.id = 555;
    },
    ({u, result}) => {
      if (u.pathname.endsWith('/products')) result.paging = {next: 'https://private.example.test'};
    },
    ({u, result}) => {
      if (u.pathname.endsWith('/products') && result.data[0]) result.data[0].id = 9007199254740992;
    },
    ({u, result}) => {
      if (u.pathname.endsWith('/products') && result.data[0] && u.searchParams.get('fields') !== 'id')
        result.data[0].retailer_id = 'FOREIGN';
    },
    ({u, result}) => {
      if (u.pathname.endsWith('/products') && result.data[0] && u.searchParams.get('fields') !== 'id')
        result.data.push(structuredClone(result.data[0]));
    },
    ({u, result}) => {
      if (u.pathname.endsWith('/products') && result.data[0] && u.searchParams.get('fields') !== 'id')
        result.data[0].name = {};
    },
    ({u, result}) => {
      if (u.searchParams.get('fields') === 'id' && result.data[0]) result.data[0].id = '123456';
    },
  ]) {
    const f = fixture({
      read: ctx => {
        mutate(ctx);
        return ctx.result;
      },
    });
    try {
      const r = await f.call();
      assert.equal(r.success, false);
      assert.equal(r.data, undefined);
    } finally {
      f.store.close();
    }
  }
});

test('login changes and account revocation discard native results and stop the next comparison request', async () => {
  for (const change of [
    f => f.store.putConnection(owner, {...f.connection, accounts: []}, {accessToken: 'synthetic'}),
    f => f.store.putConnection(owner, f.connection, {accessToken: 'synthetic-changed'}),
    f => f.store.putConnection(owner, {...f.connection, scopes: []}, {accessToken: 'synthetic'}),
  ]) {
    const f = fixture({
      read: ctx => {
        if (ctx.calls.length === 1) change(ctx);
        return ctx.result;
      },
    });
    try {
      assert.equal((await f.call()).success, false);
      assert.equal(f.calls.length, 1);
    } finally {
      f.store.close();
    }
  }
});

test('changed product fields, identity and ownership during comparison fail closed instead of mixing observations', async () => {
  for (const change of [
    ({u, result, calls}) => {
      if (
        u.pathname.endsWith('/products') &&
        calls.filter(c => c.query.fields !== 'id' && c.query.filter === u.searchParams.get('filter')).length === 2 &&
        result.data[0]
      )
        result.data[0].name = 'Changed during read';
    },
    ({u, result, calls}) => {
      if (
        u.pathname.endsWith('/products') &&
        calls.filter(c => c.query.fields !== 'id' && c.query.filter === u.searchParams.get('filter')).length === 2 &&
        result.data[0]
      )
        result.data[0].id = '6789';
    },
    ({u, result, calls}) => {
      if (u.pathname === '/v26.0/555' && calls.filter(c => c.path === u.pathname).length === 2)
        result.business.id = '901';
    },
  ]) {
    const f = fixture({
      read: ctx => {
        change(ctx);
        return ctx.result;
      },
    });
    try {
      assert.equal((await f.call()).success, false);
    } finally {
      f.store.close();
    }
  }
});

test('comparison observes the entire bounded 50-row import and refuses oversized provider bodies', async () => {
  const many = input();
  many.products = Array.from({length: 50}, (_, i) => ({...many.products[0], retailer_id: String(i + 100)}));
  const f = fixture({input: many});
  try {
    const out = ok(await f.call(many));
    assert.equal(out.items.length, 50);
    assert.ok(f.calls.length <= 154);
  } finally {
    f.store.close();
  }
  const oversized = fixture({read: ctx => ({...ctx.result, PRIVATE_UNUSED: 'x'.repeat(2 * 1024 * 1024)})});
  try {
    assert.equal((await oversized.call()).error.code, 'CATALOG_COMPARISON_LIMIT');
    assert.equal(oversized.calls.length, 1);
  } finally {
    oversized.store.close();
  }
});

test('read retries count toward comparison attempts and do not create reviews or mutations', async t => {
  const f = fixture({
    reply: n => (n <= 2 ? Response.json({error: {message: 'Synthetic transient'}}, {status: 503}) : undefined),
  });
  t.after(() => f.store.close());
  const out = ok(await f.call());
  assert.equal(out.network_requests, 17);
  assert.equal(f.calls.length, 17);
  assert.equal(f.store.documents(actor.tenantId, 'write_review').length, 0);
  assert.equal(out.provider_mutations, 0);
});

test('the whole-comparison monotonic deadline refuses before egress when exhausted', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  let clock = 0;
  t.mock.method(performance, 'now', () => (clock += 60001));
  const result = await f.call();
  assert.equal(result.error.code, 'CATALOG_COMPARISON_LIMIT');
  assert.equal(result.error.details.dimension, 'elapsed_ms');
  assert.equal(f.calls.length, 0);
});
