import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';
import {MirrorError} from '../dist/src/errors.js';
import {setup} from './x-catalog-fixture.mjs';
import {actor, ok, metaWorld, metaInput, metaShoe, runPlan} from './fixtures/meta-catalog-world.mjs';

/**
 * COM-02 B, the non-destructive alternative: Meta has no product delete contract, and a discontinued product had no
 * reviewed way out of ads but editing the source file by hand. A retirement now sends the supplied product with
 * availability "discontinued" or "out of stock" through the same reviewed upsert: the product, its history and its sets
 * stay, nothing is deleted, and retiring a product the catalog does not have (it would be created) is blocked.
 */
// The retirement rides in requirements (the tools/list schema stays within its budget).
const retire = (extra = {}) => ({
  requirements: {retire_retailer_ids: ['SKU-1'], retire_availability: 'discontinued', ...extra},
});
const existing = [
  {
    retailer_id: 'SKU-1',
    name: 'Trail shoe',
    price: 49900,
    currency: 'SAR',
    image_url: 'https://cdn.example.test/shoe.jpg',
    availability: 'in stock',
  },
];

test('Meta: a retirement sends the product with its retirement availability, reviews and reads it back, and deletes nothing', async t => {
  const f = metaWorld(existing);
  t.after(() => f.store.close());
  const call = args => f.service.call('amcp_workspace', args, actor);
  const source = [metaShoe({availability: 'in stock'}), metaShoe({retailer_id: 'SKU-2', name: 'Missing shoe'})];
  const preview = ok(await call({action: 'catalog_preview', ...metaInput(source), ...retire()}));
  assert.equal(preview.plan.steps[0].arguments.payload.availability, 'discontinued');
  assert.equal(preview.items[0].retire_availability, 'discontinued');
  assert.equal(preview.items[1].retire_availability, undefined, 'only the selected product is retired');
  assert.match(preview.plan.brief, /Retires 1 existing products as "discontinued"; nothing is deleted\./);
  // The supplied rows stay as supplied: the source hash covers them, not the retirement.
  assert.equal(preview.source_hash, catalogIngestion(metaInput(source)).source_hash);
  const compared = ok(
    await call({
      action: 'catalog_compare',
      ...metaInput(source),
      ...retire({retire_retailer_ids: ['SKU-1', 'SKU-2']}),
    }),
  );
  assert.deepEqual(compared.items[0].changes, [{field: 'availability', before: 'in stock', after: 'discontinued'}]);
  assert.deepEqual(compared.items[0].serving_notes, ['availability_limits_serving']);
  assert.equal(compared.items[1].state, 'new');
  assert.equal(compared.items[1].blocked, true, 'retiring a missing product would create it');
  assert.equal(compared.items[1].blocked_reason, 'retire_absent');
  assert.deepEqual(compared.review_retailer_ids, ['SKU-1']);
  const plan = ok(await call({action: 'catalog_plan', ...metaInput([source[0]]), ...retire()}));
  const done = await runPlan(f.service, actor, plan.id);
  assert.equal(done.state, 'complete', JSON.stringify(done.steps).slice(0, 600));
  assert.equal(f.products.get('SKU-1').availability, 'discontinued');
  assert.equal(f.products.get('SKU-1').name, 'Trail shoe', 'the product and its other values stay');
  assert.ok(f.calls.every(c => c.method !== 'DELETE'));
  const again = ok(await call({action: 'catalog_compare', ...metaInput([source[0]]), ...retire()}));
  assert.equal(again.items[0].state, 'matching');
});

test('X: a retirement is the non-destructive alternative to removal: one reviewed update, no deletion', async t => {
  const world = setup({tenant: 'catalog-retirement-x'});
  t.after(() => world.store.close());
  const input = {
    gateway: 'x_ads_native_action',
    account_id: 'acct1',
    connection_id: 'x',
    catalog_id: '9001',
    allow_upsert: true,
    products: [
      {
        retailer_id: 'sku-1',
        name: 'Product 1',
        price: '20',
        currency: 'SAR',
        image_url: 'https://shop.example.test/i/1.jpg',
        url: 'https://shop.example.test/p/1',
        availability: 'in stock',
        condition: 'new',
        brand: 'Brand',
        description: 'Synthetic product 1',
      },
    ],
    requirements: {retire_retailer_ids: ['sku-1'], retire_availability: 'out of stock'},
  };
  const call = args => world.service.call('amcp_workspace', args, world.actor);
  const compared = ok(await call({action: 'catalog_compare', ...input}));
  assert.deepEqual(compared.items[0].changes, [{field: 'availability', before: 'in stock', after: 'out of stock'}]);
  const plan = ok(await call({action: 'catalog_plan', ...input}));
  const done = await runPlan(world.service, world.actor, plan.id);
  assert.equal(done.state, 'complete', JSON.stringify(done.steps).slice(0, 600));
  assert.equal(world.items[9001][0].availability, 'out of stock');
  assert.equal(world.calls.filter(c => c.method === 'DELETE').length, 0);
  assert.equal(world.items[9001].length, 3, 'every product stays');
});

test('a retirement needs a qualified availability, supplied retailer IDs and explicit updates, and only on import actions', async t => {
  const refused = (input, pattern) => {
    let error;
    try {
      catalogIngestion(input);
    } catch (e) {
      error = e;
    }
    assert.ok(error instanceof MirrorError, JSON.stringify(input).slice(0, 200));
    assert.equal(error.code, 'INVALID_CATALOG_RETIREMENT');
    assert.match(error.message, pattern);
  };
  const base = metaInput([metaShoe()]);
  refused({...base, ...retire({retire_availability: 'mark_as_sold'})}, /out of stock" or "discontinued/);
  refused({...base, requirements: {retire_availability: 'discontinued'}}, /1–50 distinct retailer IDs/);
  refused({...base, ...retire({retire_retailer_ids: ['SKU-9']})}, /1–50 distinct retailer IDs/);
  refused({...base, ...retire({retire_retailer_ids: ['SKU-1', 'SKU-1']})}, /1–50 distinct retailer IDs/);
  refused({...base, allow_upsert: false, ...retire()}, /explicitly allow updates/);
  const f = metaWorld(existing);
  t.after(() => f.store.close());
  const misplaced = await f.service.call(
    'amcp_workspace',
    {action: 'preview_catalog_removal', ...metaInput([metaShoe()]), retailer_ids: ['SKU-1'], ...retire()},
    actor,
  );
  // A removal preview does not read a retirement: the unread requirements are named before anything is read.
  assert.equal(misplaced.success, false);
  assert.equal(misplaced.error.code, 'INVALID_ARGUMENT');
  assert.deepEqual(misplaced.error.details.fields, ['retire_retailer_ids', 'retire_availability']);
  assert.equal(f.writes(), 0);
  assert.equal(f.calls.length, 0);
});

test('a retirement plan saved without a comparison never creates a missing product: its native review refuses it with no write (regression: saved as an upsert that created it)', async t => {
  // Meta: catalog_plan from supplied products names the retirement; the product is not in the catalog.
  const f = metaWorld(existing);
  t.after(() => f.store.close());
  const call = args => f.service.call('amcp_workspace', args, actor),
    missing = metaShoe({retailer_id: 'SKU-2', name: 'Missing shoe'});
  const plan = ok(
    await call({action: 'catalog_plan', ...metaInput([missing]), ...retire({retire_retailer_ids: ['SKU-2']})}),
  );
  assert.deepEqual(f.store.document(actor.tenantId, 'campaign_run', plan.id).catalog_retirement, {
    retailer_ids: ['SKU-2'],
    availability: 'discontinued',
  });
  // The step's own native review refuses it before anything is sent; the plan needs attention.
  const refused = ok(await f.service.call('amcp_campaign', {action: 'prepare_next', id: plan.id}, actor));
  assert.equal(refused.current.error?.code, 'CATALOG_RETIRE_ABSENT', JSON.stringify(refused).slice(0, 400));
  assert.equal(refused.current.error.details.retailer_id, 'SKU-2');
  assert.equal(refused.current.submission, 'not_submitted');
  assert.equal(refused.state, 'attention');
  assert.equal(f.writes(), 0);
  assert.equal(f.products.has('SKU-2'), false, 'nothing was created');
  // The same product imported without a retirement is an ordinary create, which the guard leaves alone.
  const created = ok(await call({action: 'catalog_plan', ...metaInput([missing])}));
  assert.equal(f.store.document(actor.tenantId, 'campaign_run', created.id).catalog_retirement, undefined);
  const review = ok(await f.service.call('amcp_campaign', {action: 'prepare_next', id: created.id}, actor));
  assert.ok(review.review, JSON.stringify(review).slice(0, 400));
  assert.equal(f.writes(), 0);
  // X: retiring a product the catalog does not list is refused the same way.
  const world = setup({tenant: 'catalog-retirement-x-absent'});
  t.after(() => world.store.close());
  const input = {
    gateway: 'x_ads_native_action',
    account_id: 'acct1',
    connection_id: 'x',
    catalog_id: '9001',
    allow_upsert: true,
    products: [
      {
        retailer_id: 'sku-404',
        name: 'Retired product',
        price: '20',
        currency: 'SAR',
        image_url: 'https://shop.example.test/i/404.jpg',
        url: 'https://shop.example.test/p/404',
        availability: 'in stock',
        condition: 'new',
        brand: 'Brand',
        description: 'Synthetic missing product',
      },
    ],
    requirements: {retire_retailer_ids: ['sku-404'], retire_availability: 'out of stock'},
  };
  const xPlan = ok(await world.service.call('amcp_workspace', {action: 'catalog_plan', ...input}, world.actor));
  const listed = world.items[9001].length,
    xRefused = ok(await world.service.call('amcp_campaign', {action: 'prepare_next', id: xPlan.id}, world.actor));
  assert.equal(xRefused.current.error?.code, 'CATALOG_RETIRE_ABSENT', JSON.stringify(xRefused).slice(0, 400));
  assert.equal(xRefused.current.submission, 'not_submitted');
  assert.equal(world.calls.filter(c => c.method !== 'GET').length, 0);
  assert.equal(world.items[9001].length, listed, 'nothing was created');
});

test('a retirement plan cannot be continued: a new plan would not check that the product exists, and would create it (r25-planmodel, item 4 of the audit of 2026-11-25)', async t => {
  // Meta: catalog_plan from supplied products names the retirement; the product is not in the catalog.
  const f = metaWorld(existing);
  t.after(() => f.store.close());
  const call = args => f.service.call('amcp_workspace', args, actor),
    campaign = args => f.service.call('amcp_campaign', args, actor),
    missing = metaShoe({retailer_id: 'SKU-2', name: 'Missing shoe'});
  const plan = ok(
    await call({action: 'catalog_plan', ...metaInput([missing]), ...retire({retire_retailer_ids: ['SKU-2']})}),
  );
  const refused = ok(await campaign({action: 'prepare_next', id: plan.id}));
  assert.equal(refused.current.error?.code, 'CATALOG_RETIRE_ABSENT');
  // The continuation is refused before it holds, retires or makes anything, and says what to do instead.
  const continued = await campaign({action: 'continue_as_new', id: plan.id, confirmed: true});
  assert.equal(continued.success, false, JSON.stringify(continued).slice(0, 300));
  assert.equal(continued.error.code, 'RECOVERY_NOT_SAFE');
  assert.match(continued.error.message, /Prepare a fresh preview/);
  assert.equal(f.store.documents(actor.tenantId, 'campaign_run').length, 1, 'no second plan was made');
  assert.equal(f.store.document(actor.tenantId, 'campaign_run', plan.id).superseded_by, undefined);
  // The plan keeps its check: its step is refused again, nothing is sent, and nothing is created.
  const again = ok(await campaign({action: 'prepare_next', id: plan.id}));
  assert.equal(again.current.error?.code, 'CATALOG_RETIRE_ABSENT');
  assert.equal(f.writes(), 0);
  assert.equal(f.products.has('SKU-2'), false, 'nothing was created');
  // A plan that retires nothing is continued as it always was.
  const plain = ok(await call({action: 'catalog_plan', ...metaInput([missing])}));
  assert.ok(ok(await campaign({action: 'prepare_next', id: plain.id})).review);
  const next = ok(await campaign({action: 'continue_as_new', id: plain.id, confirmed: true}));
  assert.notEqual(next.id, plain.id);
});
