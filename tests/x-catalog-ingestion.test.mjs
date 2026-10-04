import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';
import {xImportProduct, xImportInput} from './fixtures/x-catalog-import-data.mjs';
import {setup} from './x-catalog-fixture.mjs';

test('X supplier preview preserves exact source fields and composes one existing native reviewed step per SKU', () => {
  const source = xImportInput({
    products: [xImportProduct(), xImportProduct({retailer_id: '002', name: 'Second', price: '999999999999.000002'})],
  });
  const original = structuredClone(source),
    result = catalogIngestion(source);
  assert.equal(result.item_count, 2);
  assert.equal(result.items[0].native_price, '000012.340000 SAR');
  assert.equal(result.items[1].native_price, '999999999999.000002 SAR');
  assert.equal(result.network_requests, 0);
  assert.equal(result.destructive_deletions, 0);
  assert.deepEqual(source, original);
  assert.equal(result.plan.steps.length, 2);
  assert.deepEqual(
    result.plan.steps.map(s => s.depends_on),
    [[], []],
  );
  assert.ok(
    result.plan.steps.every(s => s.gateway === source.gateway && s.connection_id === 'x' && s.account_id === 'acct1'),
  );
  const native = result.plan.steps[0].arguments;
  assert.equal(native.action, 'x_product_catalogs_product_catalog_id_products_put');
  assert.deepEqual(native.params, {product_catalog_id: '9001'});
  assert.deepEqual(native.payload.products[0], {
    id: '001',
    title: 'عرض جديد',
    price: '000012.340000 SAR',
    image_link: source.products[0].image_url,
    link: source.products[0].url,
    availability: 'in stock',
    condition: 'new',
    brand: 'Original brand',
    description: 'Original plain text description',
  });
  assert.equal(native.payload.products.length, 1);
  assert.equal(Object.hasOwn(native.payload.products[0], 'allow_upsert'), false);
  assert.match(result.meaning, /review|receipt|read-back/);
  assert.match(result.destination_limitations.join(' '), /early-access/);
});

test('saved X import steps pass the original native reviews and verification once per supplied SKU', async () => {
  const f = setup();
  try {
    const source = xImportInput({
      products: [xImportProduct(), xImportProduct({retailer_id: '002', name: 'Second', price: '25.000000'})],
    });
    const call = async args => {
      const r = await f.service.call('amcp_campaign', args, f.actor);
      assert.equal(r.success, true, JSON.stringify(r).slice(0, 1200));
      return r.data;
    };
    const saved = await f.service.call('amcp_workspace', {action: 'catalog_plan', ...source}, f.actor);
    assert.equal(saved.success, true, JSON.stringify(saved));
    assert.equal(f.writes(), 0);
    const id = saved.data.id,
      approval = await call({action: 'approve', id});
    assert.equal(f.writes(), 0);
    await call({action: 'approve', id, plan_hash: approval.plan_hash, confirmed: true});
    await call({action: 'run', id});
    const full = await call({action: 'get', id, detail: 'full'});
    assert.equal(
      full.state,
      'complete',
      JSON.stringify(full.steps.map(s => ({status: s.status, error: s.error?.code}))),
    );
    assert.deepEqual(
      full.steps.map(s => s.status),
      ['verified', 'verified'],
    );
    assert.deepEqual(
      f.calls.filter(c => c.method === 'PUT').map(c => c.body.products[0].price),
      ['000012.340000 SAR', '25.000000 SAR'],
    );
    assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 2);
    assert.ok(full.steps.every(s => s.review_id && s.result && s.verification.status === 'verified'));
    await call({action: 'run', id});
    assert.equal(f.writes(), 2);
  } finally {
    f.store.close();
  }
});

test('an X import outside current catalog ownership is refused before any predecessor product write', async () => {
  const f = setup();
  try {
    const source = xImportInput({catalog_id: '9009'});
    const saved = await f.service.call('amcp_workspace', {action: 'catalog_plan', ...source}, f.actor);
    assert.equal(saved.success, true, JSON.stringify(saved));
    const inspected = await f.service.call('amcp_campaign', {action: 'prepare_next', id: saved.data.id}, f.actor);
    assert.ok(
      inspected.success === false || inspected.data.blocked === true || inspected.data.preflight?.status === 'blocked',
      JSON.stringify(inspected).slice(0, 1000),
    );
    assert.equal(f.writes(), 0);
    assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
  } finally {
    f.store.close();
  }
});

test('a rounded accepted X import retains the original receipt and does not repeat its mutation', async () => {
  const f = setup();
  try {
    const source = xImportInput({products: [xImportProduct({price: '999999999999.000001'})]});
    const saved = await f.service.call('amcp_workspace', {action: 'catalog_plan', ...source}, f.actor);
    assert.equal(saved.success, true, JSON.stringify(saved));
    const id = saved.data.id,
      preview = await f.service.call('amcp_campaign', {action: 'approve', id}, f.actor);
    assert.equal(preview.success, true, JSON.stringify(preview));
    const approval = await f.service.call(
      'amcp_campaign',
      {action: 'approve', id, plan_hash: preview.data.plan_hash, confirmed: true},
      f.actor,
    );
    assert.equal(approval.success, true, JSON.stringify(approval));
    await f.service.call('amcp_campaign', {action: 'run', id}, f.actor);
    const full = await f.service.call('amcp_campaign', {action: 'get', id, detail: 'full'}, f.actor),
      step = full.data.steps[0];
    assert.equal(f.writes(), 1);
    assert.equal(step.status, 'mismatch');
    assert.equal(step.verification.status, 'mismatch');
    const originalKey = step.review_id;
    const reconciled = await f.service.call(
      'amcp_campaign',
      {action: 'reconcile_step', id, step_id: step.id, detail: 'full'},
      f.actor,
    );
    assert.equal(reconciled.success, true, JSON.stringify(reconciled));
    assert.equal(reconciled.data.steps[0].review_id, originalKey);
    assert.equal(reconciled.data.steps[0].status, 'mismatch');
    await f.service.call('amcp_campaign', {action: 'run', id}, f.actor);
    assert.equal(f.writes(), 1);
    assert.equal(
      f.store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get(f.actor.tenantId, originalKey)
        .state,
      'complete',
    );
    assert.equal(f.calls.find(c => c.method === 'PUT').body.products[0].price, '999999999999.000001 SAR');
  } finally {
    f.store.close();
  }
});

test('X source validation uses existing native limits and refuses inferred fields, duplicates and create-only claims', () => {
  assert.throws(() => catalogIngestion(xImportInput({allow_upsert: false})), /explicit.*upsert/i);
  for (const field of ['url', 'description', 'availability', 'condition', 'brand']) {
    const product = xImportProduct();
    delete product[field];
    assert.throws(() => catalogIngestion(xImportInput({products: [product]})));
  }
  for (const extra of [
    {name: 'x'.repeat(151)},
    {description: '<p>HTML</p>'},
    {description: 'x'.repeat(5001)},
    {price: '1.0000001'},
    {price: '1000000000000'},
    {currency: 'sar'},
    {availability: '1'},
    {condition: '1'},
    {url: 'http://shop.example.test/a'},
    {image_url: 'https://user:pass@shop.example.test/a'},
    {retailer_id: ' trailing '},
    {item_group_id: 'variant'},
  ])
    assert.throws(
      () => catalogIngestion(xImportInput({products: [xImportProduct(extra)]})),
      JSON.stringify(extra).slice(0, 120),
    );
  assert.throws(() => catalogIngestion(xImportInput({products: [xImportProduct(), xImportProduct()]})), /unique/);
  assert.throws(() => catalogIngestion(xImportInput({catalog_id: '0001'})), /catalog/);
  assert.throws(
    () =>
      catalogIngestion(
        xImportInput({products: Array.from({length: 51}, (_, i) => xImportProduct({retailer_id: String(i)}))}),
      ),
    /50/,
  );
  const multiline = catalogIngestion(xImportInput({products: [xImportProduct({description: 'Original\nplain text'})]}));
  assert.equal(multiline.plan.steps[0].arguments.payload.products[0].description, 'Original\nplain text');
});

test('X previews and draft saving require current selected connection scope and never start provider review', async () => {
  const f = setup();
  try {
    const input = xImportInput();
    const preview = await f.service.call('amcp_workspace', {action: 'catalog_preview', ...input}, f.actor);
    assert.equal(preview.success, true, JSON.stringify(preview));
    const saved = await f.service.call('amcp_workspace', {action: 'catalog_plan', ...input}, f.actor);
    assert.equal(saved.success, true, JSON.stringify(saved));
    assert.equal(saved.data.state, 'draft');
    assert.equal(saved.data.source_hash, preview.data.source_hash);
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
    const scope = f.store.resolveConnection(f.actor, input.gateway, input.account_id, 'x');
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {...scope, enabled: false},
      f.store.credentials(f.actor.tenantId, 'x'),
    );
    const refused = await f.service.call('amcp_workspace', {action: 'catalog_plan', ...input}, f.actor);
    assert.equal(refused.success, false);
    assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 1);
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
