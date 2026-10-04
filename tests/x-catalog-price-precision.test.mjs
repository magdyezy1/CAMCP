import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogPrice, priceView} from '../dist/src/x-catalogs.js';
import {setup, product} from './x-catalog-fixture.mjs';
import {lower, upper, action, catalog, exactCatalogProduct} from './fixtures/x-catalog-price-data.mjs';
const checked = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('X exact money projections distinguish supported prices and normalize equivalent decimal text', () => {
  assert.notDeepEqual(priceView(lower), priceView(upper));
  assert.equal(priceView(lower).amount, '999999999999.000001');
  assert.deepEqual(priceView('00250.000000 SAR'), {amount: '250', currency: 'SAR'});
  assert.deepEqual(priceView('0.100000 SAR'), {amount: '0.1', currency: 'SAR'});
});

test('a one-millionth product price change is not mistaken for a no-op', async () => {
  const f = setup();
  try {
    f.items[9001][0] = product(1, {price: lower});
    const r = checked(await f.prepare(action, {products: [exactCatalogProduct(upper)]}, {product_catalog_id: '9001'}));
    assert.equal(r.data.creative_impact.before.price.amount, '999999999999.000001');
    assert.equal(r.data.creative_impact.after.price.amount, '999999999999.000002');
    assert.equal(f.calls.filter(c => c.method === 'PUT').length, 0);
  } finally {
    f.store.close();
  }
});

test('a genuinely lower sale price at the accepted boundary passes exact comparison', async () => {
  const f = setup();
  try {
    checked(
      await f.prepare(
        action,
        {products: [exactCatalogProduct(upper, {id: 'sku-new', sale_price: lower})]},
        {product_catalog_id: '9001'},
      ),
    );
    assert.equal(f.calls.filter(c => c.method === 'PUT').length, 0);
  } finally {
    f.store.close();
  }
});

test('a one-millionth price change after review withholds the unsent mutation', async () => {
  const f = setup();
  try {
    f.items[9001][0] = product(1, {price: lower});
    const p = checked(
      await f.prepare(
        action,
        {products: [exactCatalogProduct(lower, {title: 'Updated product'})]},
        {product_catalog_id: '9001'},
      ),
    );
    f.items[9001][0].price = upper;
    const executed = await f.execute(p);
    assert.equal(executed.success, false);
    assert.equal(executed.error.code, 'STATE_CHANGED');
    assert.equal(f.calls.filter(c => c.method === 'PUT').length, 0);
    assert.equal(f.items[9001][0].title, 'Product 1');
  } finally {
    f.store.close();
  }
});

test('rounded native price read-back remains unverified and the accepted write cannot be replayed', async () => {
  const f = setup();
  try {
    const p = checked(
      await f.prepare(action, {products: [exactCatalogProduct(lower, {id: 'sku-new'})]}, {product_catalog_id: '9001'}),
    );
    checked(await f.execute(p));
    assert.equal(f.items[9001].find(r => r.id === 'sku-new').price, '999999999999.00 SAR');
    const verified = checked(await f.verify(p));
    assert.notEqual(verified.data.status, 'verified');
    assert.ok(verified.data.checks[0].changed_fields.includes('/product/price/amount'));
    assert.equal(verified.data.automatic_retry_of_mutation, false);
    await f.execute(p);
    assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
  } finally {
    f.store.close();
  }
});

test('bounded decimal projection preserves adjacent amounts, zero and missing or unsupported source values', () => {
  const values = Array.from({length: 128}, (_, i) => `999999999999.${String(i).padStart(6, '0')} SAR`);
  assert.equal(new Set(values.map(v => JSON.stringify(priceView(v)))).size, values.length);
  assert.equal(catalogPrice('999999999999.999999 SAR').units, 999999999999999999n);
  assert.deepEqual(priceView('000000000000.000000 SAR'), {amount: '0', currency: 'SAR'});
  assert.equal(priceView(undefined), null);
  assert.equal(priceView(null), null);
  for (const v of [
    '1e3 SAR',
    '-1 SAR',
    '1.0000001 SAR',
    '1000000000000 SAR',
    '1 sar',
    ' 1 SAR',
    '1 SAR ',
    1,
    ['1 SAR'],
  ]) {
    assert.equal(catalogPrice(v), undefined);
    assert.deepEqual(priceView(v), {raw: String(v)});
  }
  assert.doesNotThrow(() => JSON.stringify(values.map(priceView)));
});

test('equal, higher, foreign-currency and non-string sale prices are refused before any provider read', async () => {
  const f = setup();
  try {
    for (const sale_price of [upper, '999999999999.000003 SAR', '1 USD', ['1 SAR'], {amount: '1', currency: 'SAR'}]) {
      const r = await f.prepare(action, {products: [exactCatalogProduct(upper, {sale_price})]}, catalog);
      assert.equal(r.success, false);
      assert.equal(r.error.code, 'INVALID_X_CATALOG_PRODUCT');
    }
    for (const price of [['1 SAR'], {amount: '1', currency: 'SAR'}]) {
      const r = await f.prepare(action, {products: [exactCatalogProduct(price)]}, catalog);
      assert.equal(r.success, false);
      assert.equal(r.error.code, 'INVALID_X_CATALOG_PRODUCT');
    }
    assert.equal(f.calls.length, 0);
    const accepted = checked(
      await f.prepare(
        action,
        {products: [exactCatalogProduct('0.000002 SAR', {id: 'sku-new', sale_price: '0.000001 SAR'})]},
        catalog,
      ),
    );
    assert.equal(accepted.data.creative_impact.creating.sale_price.amount, '0.000001');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

/** Simulates an old stored review projection without changing its original native request, account or fingerprint. */
function legacyNumbers(value) {
  if (Array.isArray(value)) return value.map(legacyNumbers);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        k === 'amount' && typeof v === 'string' ? Number(v) : legacyNumbers(v),
      ]),
    );
  return value;
}

test('an unsubmitted legacy numeric review needs a fresh review, without migration or native dispatch', async () => {
  const f = setup();
  try {
    const p = checked(
      await f.prepare(action, {products: [exactCatalogProduct('20 SAR', {title: 'Updated'})]}, catalog),
    );
    const stored = f.store.document(f.actor.tenantId, 'write_review', p.data.review_id);
    f.store.putDocument(f.actor.tenantId, 'write_review', p.data.review_id, {
      ...stored,
      state: legacyNumbers(stored.state),
    });
    const r = await f.execute(p);
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'STATE_CHANGED');
    assert.match(r.error.message, /fresh request/);
    assert.equal(f.writes(), 0);
    assert.equal(f.items[9001][0].title, 'Product 1');
  } finally {
    f.store.close();
  }
});

test('a legacy accepted receipt retains its original key and exact native request for read-only recovery', async () => {
  const f = setup();
  try {
    const p = checked(await f.prepare(action, {products: [exactCatalogProduct(lower, {id: 'sku-new'})]}, catalog));
    const accepted = checked(await f.execute(p));
    const stored = f.store.document(f.actor.tenantId, 'write_review', p.data.review_id);
    f.store.putDocument(f.actor.tenantId, 'write_review', p.data.review_id, {
      ...stored,
      state: legacyNumbers(stored.state),
    });
    const replayed = checked(await f.execute(p));
    assert.equal(replayed.data.replayed, true);
    assert.deepEqual(replayed.data.data, accepted.data.data);
    assert.equal(f.calls.find(c => c.method === 'PUT').body.products[0].price, lower);
    assert.notEqual(checked(await f.verify(p)).data.status, 'verified');
    assert.equal(
      f.store.db
        .prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?')
        .get(f.actor.tenantId, p.data.idempotency_key).state,
      'complete',
    );
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('old false verified caches are retired and two stable rounded read-back rounds identify exact disagreement', async () => {
  const f = setup();
  try {
    const p = checked(
      await f.prepare(action, {products: [exactCatalogProduct(upper, {id: 'sku-new', sale_price: lower})]}, catalog),
    );
    checked(await f.execute(p));
    f.store.putDocument(f.actor.tenantId, 'write_verification', p.data.review_id, {
      status: 'verified',
      checked_at: Date.now(),
      checks: [],
    });
    const previousReads = f.calls.length;
    const first = checked(await f.verify(p)).data;
    assert.equal(first.status, 'inconclusive');
    assert.equal(first.cached, undefined);
    assert.ok(f.calls.length > previousReads);
    assert.equal(first.verification_cache_version, 'x-catalog-identities-v3');
    const second = checked(await f.verify(p)).data;
    assert.equal(second.status, 'mismatch');
    assert.equal(second.retry_read_after_ms, undefined);
    assert.deepEqual(
      second.checks[0].diff.filter(d => d.field.endsWith('/amount')),
      [
        {field: '/product/price/amount', expected: '999999999999.000002', actual: '999999999999'},
        {field: '/product/sale_price/amount', expected: '999999999999.000001', actual: '999999999999'},
      ],
    );
    assert.equal(second.automatic_retry_of_mutation, false);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('current exact verification caches remain efficient and are withheld after account access is removed', async () => {
  const f = setup();
  try {
    const p = checked(
      await f.prepare(action, {products: [exactCatalogProduct('00250.000000 SAR', {id: 'sku-new'})]}, catalog),
    );
    checked(await f.execute(p));
    assert.equal(f.calls.find(c => c.method === 'PUT').body.products[0].price, '00250.000000 SAR');
    assert.equal(checked(await f.verify(p)).data.status, 'verified');
    const previousReads = f.calls.length;
    assert.equal(checked(await f.verify(p)).data.cached, true);
    assert.equal(f.calls.length, previousReads);
    const c = f.store.resolveConnection(f.actor, 'x_ads_native_action', 'acct1', 'x');
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {...c, enabled: false, accounts: [], writeAccounts: []},
      f.store.credentials(f.actor.tenantId, 'x'),
    );
    assert.equal((await f.verify(p)).success, false);
    assert.equal(f.calls.length, previousReads);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
