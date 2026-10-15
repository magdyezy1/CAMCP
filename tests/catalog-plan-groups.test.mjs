import test from 'node:test';
import assert from 'node:assert/strict';
import {actor, ok, metaWorld} from './fixtures/meta-catalog-world.mjs';
import {xCatalogComparisonFixture} from './fixtures/x-catalog-comparison.mjs';

/**
 * COM-03 Phase 3: one source of more than 50 products. Before, catalog_plan took 1–50 products and a larger store had
 * to be split by hand into unrelated plans. requirements.chunked saves 51–500 source products as consecutive unapproved
 * plans of at most 50 that share one lineage group; every part is validated first, so a refusal saves nothing, and the
 * same request after a failure saves only the missing parts. Each product still has its own native review.
 */
const scope = {gateway: 'meta_native_action', account_id: '123', connection_id: 'm', catalog_id: '555'},
  header = 'retailer_id,name,price,currency,image_url';
const csv = (count, row = i => `SKU-${i},Product ${i},${i}.50,SAR,https://cdn.example.test/${i}.jpg`) =>
  [header, ...Array.from({length: count}, (_, i) => row(i + 1))].join('\n');
function world(t) {
  const f = metaWorld();
  t.after(() => f.store.close());
  const plan = (text, requirements = {}, extra = {}) =>
    f.service.call(
      'amcp_workspace',
      {
        action: 'catalog_plan',
        ...scope,
        allow_upsert: true,
        name: 'Spring store import',
        requirements: {source: {kind: 'csv', text, columns: 'canonical'}, chunked: true, ...requirements},
        ...extra,
      },
      actor,
    );
  return {...f, plan, runs: () => f.store.documents(actor.tenantId, 'campaign_run')};
}

test('120 source products become three unapproved plans of at most 50 in one lineage group, and a replay saves nothing new', async t => {
  const f = world(t),
    text = csv(120);
  const group = ok(await f.plan(text));
  assert.equal(group.record_kind, 'catalog_plan_group');
  assert.equal(group.parts, 3);
  assert.equal(group.item_count, 120);
  assert.match(group.lineage_group_id, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    group.plans.map(p => [p.part, p.item_count]),
    [
      [1, 50],
      [2, 50],
      [3, 20],
    ],
  );
  const runs = group.plans.map(p => f.store.document(actor.tenantId, 'campaign_run', p.id));
  for (const [i, run] of runs.entries()) {
    assert.equal(run.state, 'draft');
    assert.equal(run.name, 'Spring store import (part ' + (i + 1) + ' of 3)');
    const lineage = run.catalog_lineage;
    assert.deepEqual(lineage.lineage_group, {
      id: group.lineage_group_id,
      part: i + 1,
      parts: 3,
      group_source_hash: group.group_source_hash,
      group_products: 120,
    });
    assert.equal(lineage.source_kind, 'csv');
    assert.equal(lineage.source_rows, 120);
    assert.equal(lineage.source_hash, group.plans[i].source_hash);
  }
  // The parts keep the source order, one native step per product.
  assert.deepEqual(
    runs.flatMap(run => run.steps.map(s => s.arguments.payload.retailer_id)),
    Array.from({length: 120}, (_, i) => 'SKU-' + (i + 1)),
  );
  assert.equal(f.calls.length, 0, 'saving the group sends nothing to Meta');
  const replay = ok(await f.plan(text));
  assert.deepEqual(
    replay.plans.map(p => p.id),
    group.plans.map(p => p.id),
  );
  assert.equal(f.runs().length, 3, 'the same request saves no further plan');
});

test('a group preview validates every part and saves nothing, and the save that follows is the same group', async t => {
  const f = world(t),
    text = csv(120);
  const preview = (requirements = {}, as = actor) =>
    f.service.call(
      'amcp_workspace',
      {
        action: 'catalog_preview',
        ...scope,
        allow_upsert: true,
        name: 'Spring store import',
        requirements: {source: {kind: 'csv', text, columns: 'canonical'}, chunked: true, ...requirements},
      },
      as,
    );
  // A reader may preview a group: nothing is saved and nothing reaches Meta.
  const out = ok(await preview({}, {...actor, role: 'reader'}));
  assert.equal(out.record_kind, 'catalog_plan_group_preview');
  assert.equal(out.parts, 3);
  assert.equal(out.item_count, 120);
  assert.deepEqual(
    out.plans.map(p => [p.part, p.item_count, p.first_retailer_id, p.last_retailer_id]),
    [
      [1, 50, 'SKU-1', 'SKU-50'],
      [2, 50, 'SKU-51', 'SKU-100'],
      [3, 20, 'SKU-101', 'SKU-120'],
    ],
  );
  assert.equal(out.source.source_kind, 'csv');
  assert.equal(out.destructive_deletions, 0);
  assert.equal(f.runs().length, 0, 'a preview saves no plan');
  assert.equal(f.store.documents(actor.tenantId, 'catalog_lineage_binding').length, 0);
  assert.equal(f.calls.length, 0);
  // A refused product is refused at preview, before anything could be saved.
  const refused = await f.service.call(
    'amcp_workspace',
    {
      action: 'catalog_preview',
      ...scope,
      allow_upsert: true,
      requirements: {
        source: {
          kind: 'csv',
          text: csv(80, i => `SKU-${i},Product ${i},${i === 70 ? 'free' : '1'},SAR,https://cdn.example.test/${i}.jpg`),
          columns: 'canonical',
        },
        chunked: true,
      },
    },
    actor,
  );
  assert.equal(refused.success, false);
  assert.match(refused.error.message, /decimal price/);
  // Saving the previewed source creates exactly the previewed parts, under the same group.
  const group = ok(await f.plan(text));
  assert.equal(group.lineage_group_id, out.lineage_group_id);
  assert.deepEqual(
    group.plans.map(p => [p.part, p.item_count, p.source_hash]),
    out.plans.map(p => [p.part, p.item_count, p.source_hash]),
  );
});

test('a group is refused before any part is saved: an invalid product, a repeated ID, too few or too many products', async t => {
  const f = world(t);
  for (const [text, extra, pattern] of [
    [
      csv(120, i =>
        i === 117
          ? `SKU-${i},Product,not-a-price,SAR,https://cdn.example.test/x.jpg`
          : `SKU-${i},Product ${i},1,SAR,https://cdn.example.test/${i}.jpg`,
      ),
      {},
      /decimal price/,
    ],
    [csv(60, i => `SKU-${i % 55},Product ${i},1,SAR,https://cdn.example.test/${i}.jpg`), {}, /must be unique/],
    [csv(50), {}, /51–500 source products/],
    [csv(80), {chunked: false}, /Set chunked to true/],
    [csv(80), {comparison_token: 'v1.x'}, /saved from its whole source/],
    [csv(80), {retire_retailer_ids: ['SKU-1'], retire_availability: 'discontinued'}, /Retire at most 50 products/],
  ]) {
    const refused = await f.plan(text, extra);
    assert.equal(refused.success, false, String(pattern));
    assert.match(refused.error.message, pattern);
  }
  assert.equal(f.runs().length, 0, 'no refused group saved a part');
  // Supplied products stay at 1–50 per call; only a source groups more.
  const supplied = await f.service.call(
    'amcp_workspace',
    {
      action: 'catalog_plan',
      ...scope,
      allow_upsert: true,
      products: [
        {retailer_id: '1', name: 'A', price: '1', currency: 'SAR', image_url: 'https://cdn.example.test/a.jpg'},
      ],
      requirements: {chunked: true},
    },
    actor,
  );
  assert.match(supplied.error.message, /51–500 source products/);
  const reader = await f.service.call(
    'amcp_workspace',
    {
      action: 'catalog_plan',
      ...scope,
      allow_upsert: true,
      requirements: {source: {kind: 'csv', text: csv(80), columns: 'canonical'}, chunked: true},
    },
    {...actor, role: 'reader'},
  );
  assert.equal(reader.error.code, 'FORBIDDEN');
});

test('a source of at most 50 products stays one plan, more than 50 needs an explicit group, and Snapchat saves none', async t => {
  const f = world(t);
  // Snapchat products change only through feeds: no plan group either.
  f.store.putConnection(
    {...actor, role: 'admin'},
    {
      id: 's',
      tenantId: actor.tenantId,
      gateway: 'snapchat_native_action',
      accounts: ['snap-account-1'],
      writeAccounts: ['snap-account-1'],
      enabled: true,
      label: 'Synthetic Snapchat',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const snapchat = await f.service.call(
    'amcp_workspace',
    {
      action: 'catalog_plan',
      gateway: 'snapchat_native_action',
      account_id: 'snap-account-1',
      connection_id: 's',
      catalog_id: 'snap-catalog-1',
      requirements: {source: {kind: 'csv', text: csv(80), columns: 'canonical'}, chunked: true},
    },
    actor,
  );
  assert.equal(snapchat.error.code, 'CATALOG_FEED_ONLY');
  assert.equal(f.runs().length, 0);
  const single = ok(
    await f.service.call(
      'amcp_workspace',
      {
        action: 'catalog_plan',
        ...scope,
        allow_upsert: true,
        requirements: {source: {kind: 'csv', text: csv(3), columns: 'canonical'}},
      },
      actor,
    ),
  );
  assert.equal(single.item_count, 3);
  assert.equal(Object.hasOwn(single.lineage, 'lineage_group'), false);
  const tooMany = await f.service.call(
    'amcp_workspace',
    {
      action: 'catalog_plan',
      ...scope,
      allow_upsert: true,
      requirements: {source: {kind: 'csv', text: csv(51), columns: 'canonical'}},
    },
    actor,
  );
  assert.match(tooMany.error.message, /1–50 products per reviewed plan/, 'more than 50 needs an explicit group');
});

test('an X source never removes the listed products it lacks: its single plan and its plan group hold only its own upserts', async t => {
  // X has a product delete contract, so this guards the destination contract's rule that absence from a source never
  // selects a removal: removals exist only as explicit selections (preview_catalog_removal).
  const f = xCatalogComparisonFixture({writable: true});
  t.after(() => f.store.close());
  const scope = {gateway: 'x_ads_native_action', account_id: 'acct1', connection_id: 'x', catalog_id: '9001'},
    listed = f.items[9001].map(p => p.id),
    header = 'retailer_id,name,price,currency,image_url,url,availability,condition,brand,description',
    row = i =>
      `new-${i},Product ${i},${i}.25,SAR,https://shop.example.test/i/${i}.jpg,https://shop.example.test/p/${i},in stock,new,Brand,Plain text ${i}`,
    text = n => [header, ...Array.from({length: n}, (_, i) => row(i + 1))].join('\n'),
    plan = requirements =>
      f.service.call('amcp_workspace', {action: 'catalog_plan', ...scope, allow_upsert: true, requirements}, f.actor);
  assert.ok(listed.length > 0, 'the catalog lists products the source lacks');
  ok(await plan({source: {kind: 'csv', text: text(2), columns: 'canonical'}}));
  const group = ok(await plan({source: {kind: 'csv', text: text(60), columns: 'canonical'}, chunked: true}));
  assert.equal(group.parts, 2);
  const steps = f.store.documents(f.actor.tenantId, 'campaign_run').flatMap(run => run.steps);
  assert.equal(steps.length, 62);
  assert.ok(steps.every(s => s.arguments.action === 'x_product_catalogs_product_catalog_id_products_put'));
  const keys = steps.map(s => s.arguments.payload.products[0].id);
  for (const id of listed) assert.equal(keys.includes(id), false, id + ' is not touched');
  assert.equal(f.writes(), 0, 'saving plans sends nothing to X');
});
