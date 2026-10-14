import test from 'node:test';
import assert from 'node:assert/strict';
import {actor, ok, metaWorld} from './fixtures/meta-catalog-world.mjs';

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
