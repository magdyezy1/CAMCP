import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {xCatalogComparisonFixture} from './fixtures/x-catalog-comparison.mjs';
import {actor as metaActor, ok, metaWorld, metaInput, metaShoe} from './fixtures/meta-catalog-world.mjs';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';
import {storeCatalogLineageBinding} from '../dist/src/catalog-lineage.js';

/**
 * COM-03 Phase 2: plan lineage. Before, catalog_plan recorded no catalog-source hash, comparison or mapping, so a saved
 * plan could not show which source read, comparison or mapping produced it. Every catalog plan now carries
 * `catalog_lineage` on its campaign_run: its source kind and hashes, the mapping profile version, and the comparison
 * its products come from when that comparison is verifiably the same person's, scope and products. Only catalog_plan
 * can set it; the native steps, reviews and approvals are unchanged.
 */
const sha = text => createHash('sha256').update(text).digest('hex');
function xWorld(t) {
  const f = xCatalogComparisonFixture({writable: true});
  t.after(() => f.store.close());
  const runs = () => f.store.documents(f.actor.tenantId, 'campaign_run');
  return {...f, runs};
}

test('a plan saved from a comparison records its source and that comparison, and the steps stay those of the source', async t => {
  const f = xWorld(t);
  const compared = ok(await f.call(f.input));
  assert.match(compared.lineage_token, /^v1\./, 'the comparison returns a sealed lineage reference');
  const products = f.input.products.filter(p => compared.review_retailer_ids.includes(p.retailer_id));
  assert.deepEqual(
    products.map(p => p.retailer_id),
    ['sku-4', 'sku-1'],
  );
  const plan = ok(
    await f.call({
      ...f.input,
      action: 'catalog_plan',
      products,
      requirements: {comparison_token: compared.lineage_token},
    }),
  );
  assert.deepEqual(plan.lineage, {
    lineage_version: 'catalog-plan-lineage-v1',
    source_kind: 'supplied_products',
    source_hash: plan.source_hash,
    catalog_source_hash: null,
    source_rows: 2,
    selected_rows: null,
    columns: null,
    mapping_profile: null,
    mapping_profile_version: null,
    comparison_hash: compared.comparison_hash,
    compared_at: compared.captured_at,
  });
  const run = f.store.document(f.actor.tenantId, 'campaign_run', plan.id);
  assert.deepEqual(run.catalog_lineage, plan.lineage);
  const view = ok(await f.service.call('amcp_campaign', {action: 'get', id: plan.id}, f.actor));
  assert.deepEqual(view.catalog_lineage, plan.lineage, 'the plan shows where its products came from');
  // Lineage changes no native request: the steps are exactly the projection of the saved products.
  const expected = catalogIngestion({...f.input, action: 'catalog_plan', products}).plan.steps;
  assert.deepEqual(
    run.steps.map(s => s.arguments),
    expected.map(s => s.arguments),
  );
  assert.equal(f.store.documents(f.actor.tenantId, 'catalog_lineage_binding').length, 0, 'the binding is released');
  assert.equal(f.writes(), 0);
});

test('a plan from a mapped CSV source records the CSV hash, the mapping version, the selection and the comparison', async t => {
  const f = xWorld(t);
  const scope = {gateway: f.input.gateway, account_id: f.input.account_id, connection_id: 'x', catalog_id: '9001'};
  const header = 'SKU,Title,Price,Image,Link,Stock,State,Maker,About,Private';
  const rows = f.input.products.map(p =>
    [
      p.retailer_id,
      p.name,
      p.price,
      p.image_url,
      p.url,
      p.availability,
      p.condition,
      p.brand,
      p.description,
      'PRIVATE-' + p.retailer_id,
    ].join(','),
  );
  const text = [header, ...rows].join('\n');
  const mapping = ok(
    await f.service.call(
      'amcp_workspace',
      {
        action: 'save_catalog_mapping',
        ...scope,
        requirements: {
          columns: {
            retailer_id: 'SKU',
            name: 'Title',
            price: 'Price',
            image_url: 'Image',
            url: 'Link',
            availability: 'Stock',
            condition: 'State',
            brand: 'Maker',
            description: 'About',
          },
          fixed_currency: 'SAR',
          image_mode: 'single',
        },
      },
      f.actor,
    ),
  );
  const source = {kind: 'csv', text, columns: 'profile', profile_version: 1};
  const compared = ok(await f.call({...scope, action: 'catalog_compare', allow_upsert: true, requirements: {source}}));
  assert.equal(compared.source.catalog_source_hash, sha(text));
  assert.deepEqual(compared.review_retailer_ids, ['sku-4', 'sku-1']);
  const plan = ok(
    await f.call({
      ...scope,
      action: 'catalog_plan',
      allow_upsert: true,
      requirements: {source, select_retailer_ids: ['sku-1'], comparison_token: compared.lineage_token},
    }),
  );
  assert.equal(plan.item_count, 1);
  assert.deepEqual(plan.lineage, {
    lineage_version: 'catalog-plan-lineage-v1',
    source_kind: 'csv',
    source_hash: plan.source_hash,
    catalog_source_hash: sha(text),
    source_rows: 4,
    selected_rows: 1,
    columns: 'profile',
    mapping_profile: {profile_id: mapping.profile.profile_id, version: 1, profile_hash: mapping.profile.profile_hash},
    mapping_profile_version: 1,
    comparison_hash: compared.comparison_hash,
    compared_at: compared.captured_at,
  });
  const run = f.store.document(f.actor.tenantId, 'campaign_run', plan.id);
  assert.doesNotMatch(JSON.stringify(run), /PRIVATE-/, 'unmapped columns never reach the plan');
  assert.equal(run.steps.length, 1);
  assert.equal(run.steps[0].arguments.payload.products[0].id, 'sku-1');
});

test('a comparison reference of other products, another catalog or a malformed token is refused and saves nothing', async t => {
  const f = xWorld(t);
  const compared = ok(await f.call(f.input));
  const elsewhere = ok(await f.call({...f.input, catalog_id: '9002'}));
  const changed = f.input.products.map(p => (p.retailer_id === 'sku-1' ? {...p, name: 'Edited after comparing'} : p));
  for (const [products, token, code] of [
    [changed, compared.lineage_token, 'CATALOG_LINEAGE_MISMATCH'],
    [f.input.products, elsewhere.lineage_token, 'CATALOG_LINEAGE_MISMATCH'],
    [f.input.products, 'v1.not.sealed', 'CATALOG_LINEAGE_EXPIRED'],
    [f.input.products, compared.lineage_token + 'x', 'CATALOG_LINEAGE_EXPIRED'],
  ]) {
    const refused = await f.call({
      ...f.input,
      action: 'catalog_plan',
      products,
      requirements: {comparison_token: token},
    });
    assert.equal(refused.success, false);
    assert.equal(refused.error.code, code);
  }
  assert.equal(f.runs().length, 0, 'no refused plan was saved');
  // The same reference with exactly the compared products is accepted.
  const plan = ok(
    await f.call({...f.input, action: 'catalog_plan', requirements: {comparison_token: compared.lineage_token}}),
  );
  assert.equal(plan.lineage.comparison_hash, compared.comparison_hash);
});

test('only catalog_plan can set a lineage: a direct create naming an unknown or mismatched binding is refused', async t => {
  const f = xWorld(t);
  const preview = catalogIngestion({...f.input, action: 'catalog_plan'}).plan;
  const create = extra => f.service.call('amcp_campaign', {...preview, ...extra}, f.actor);
  for (const binding of [
    {kind: 'lineage', id: 'unknown', hash: 'h', save_nonce: 'n'},
    {kind: 'lineage', id: 'unknown', hash: 'h', save_nonce: 'n', lineage: {forged: true}},
  ]) {
    const refused = await create({catalog_binding: binding});
    assert.equal(refused.success, false);
    assert.equal(refused.error.code, 'CATALOG_LINEAGE_UNBOUND');
  }
  // A real binding is accepted for exactly the steps it names; the same binding for other steps is refused.
  const lineage = {lineage_version: 'catalog-plan-lineage-v1', source_kind: 'supplied_products'};
  const other = storeCatalogLineageBinding(f.store, f.actor, preview, lineage);
  const mismatched = await create({catalog_binding: other, steps: preview.steps.slice(0, 1)});
  assert.equal(mismatched.error.code, 'CATALOG_LINEAGE_UNBOUND');
  const bound = ok(await create({catalog_binding: other}));
  assert.deepEqual(f.store.document(f.actor.tenantId, 'campaign_run', bound.id).catalog_lineage, lineage);
  // A plan created without a binding carries none.
  const plain = ok(await create({}));
  assert.equal(Object.hasOwn(f.store.document(f.actor.tenantId, 'campaign_run', plain.id), 'catalog_lineage'), false);
});

test('a Meta plan of supplied products carries its lineage too', async t => {
  const f = metaWorld();
  t.after(() => f.store.close());
  const plan = ok(
    await f.service.call(
      'amcp_workspace',
      {action: 'catalog_plan', ...metaInput([metaShoe(), metaShoe({retailer_id: 'SKU-2'})])},
      metaActor,
    ),
  );
  assert.equal(plan.lineage.source_kind, 'supplied_products');
  assert.equal(plan.lineage.source_hash, plan.source_hash);
  assert.equal(plan.lineage.comparison_hash, null);
  assert.deepEqual(f.store.document(metaActor.tenantId, 'campaign_run', plan.id).catalog_lineage, plan.lineage);
  assert.equal(f.calls.length, 0);
});
