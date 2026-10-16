import test from 'node:test';
import assert from 'node:assert/strict';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {xCatalogComparisonFixture, xProductSource} from './fixtures/x-catalog-comparison.mjs';
import {product} from './x-catalog-fixture.mjs';

/**
 * COM-02 B (P9 as the decision record names it: explicit removal of listed X products only with explicit intent). Before,
 * removal accepted only retailer IDs of the supplied source, so a discontinued SKU that still appears in the listed X
 * inventory could not be removed without inventing a source row. A listed product is now removable only after explicit
 * selection by native key from an inspection, bound to that listing, with a typed count; grouped, unknown and unlisted
 * products are refused, the owner's allow_deletion:false refuses, and unselected products stay untouched.
 */
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1500));
  return r.data;
};
const refused = (r, code) => {
  assert.equal(r.success, false, JSON.stringify(r).slice(0, 600));
  assert.equal(r.error.code, code, JSON.stringify(r.error));
  return r.error;
};
/** Supplied source: sku-1 and sku-2. The catalog also lists sku-3, the discontinued product the source no longer has. */
function world(t, options = {}) {
  const f = xCatalogComparisonFixture({writable: true, tenant: 'synthetic-x-listed-removal', ...options});
  t.after(() => f.store.close());
  const scope = {gateway: 'x_ads_native_action', account_id: 'acct1', connection_id: 'x', catalog_id: '9001'},
    source = [xProductSource(product(1)), xProductSource(product(2))],
    call = (args, as = f.actor) => f.service.call('amcp_workspace', args, as);
  const inspect = async () =>
    ok(
      await call({
        action: 'catalog_compare',
        ...scope,
        allow_upsert: true,
        products: source,
        inspect_other_listed_products: true,
        absent_source_policy: 'retain',
      }),
    ).listed_inventory;
  // The listed selection rides in requirements (the tools/list schema stays within its budget).
  const preview = (keys, hash, extra = {}, requirements = {}) =>
    call({
      action: 'preview_catalog_removal',
      ...scope,
      requirements: {
        selection_source: 'listed_inventory',
        product_keys: keys,
        listed_inventory_hash: hash,
        ...requirements,
      },
      ...extra,
    });
  const save = (p, extra = {}) =>
    call({
      action: 'create_catalog_removal',
      preview_id: p.preview_id,
      preview_hash: p.preview_hash,
      confirmed: true,
      ...extra,
    });
  return {...f, scope, source, call, inspect, preview, save};
}
async function run(f, id) {
  const campaign = args => f.service.call('amcp_campaign', args, f.actor);
  let next = ok(await campaign({action: 'prepare_next', id}));
  const results = [];
  while (next.review) {
    const done = await campaign({
      action: 'execute_next',
      id,
      review_id: next.review.review_id,
      idempotency_key: next.review.idempotency_key,
      confirmed: true,
    });
    results.push(done);
    if (!done.success || done.data.state === 'complete') break;
    next = ok(await campaign({action: 'prepare_next', id}));
  }
  return results;
}

test('a listed product outside the source is removed only after explicit selection, its listing hash and a typed count; unselected products stay', async t => {
  const f = world(t);
  const inventory = await f.inspect();
  const listed = inventory.items.find(p => p.retailer_id === 'sku-3');
  assert.equal(listed.product_id, '5000003');
  assert.equal(inventory.source_absence_established, false, 'absence never selects anything');
  const proposed = ok(await f.preview(['5000003'], inventory.material_hash));
  assert.equal(proposed.selection_source, 'listed_inventory');
  assert.equal(proposed.listed_inventory_hash, inventory.material_hash);
  assert.equal(proposed.confirmation, 'confirmed_count');
  assert.equal(proposed.source_hash, null);
  assert.deepEqual(
    proposed.targets.map(t => [t.retailer_id, t.product_id]),
    [['sku-3', '5000003']],
  );
  assert.equal(proposed.provider_mutations, 0);
  assert.equal(f.writes(), 0);
  // The typed count is required, and must be the number of selected products.
  refused(await f.save(proposed), 'CONFIRMATION_REQUIRED');
  refused(await f.save(proposed, {confirmed_count: 2}), 'CONFIRMATION_REQUIRED');
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
  const saved = ok(await f.save(proposed, {confirmed_count: 1}));
  assert.equal(saved.destructive_deletions, 0);
  assert.equal(f.writes(), 0, 'saving deletes nothing');
  const plan = f.store.document(f.actor.tenantId, 'campaign_run', saved.id);
  assert.deepEqual(plan.steps[0].arguments.payload, {product_keys: ['5000003']});
  assert.match(plan.brief, /chosen by its native key, not because a source lacks it/);
  assert.equal(plan.catalog_removal.selection_source, 'listed_inventory');
  const results = await run(f, saved.id);
  assert.ok(
    results.every(r => r.success),
    JSON.stringify(results).slice(0, 800),
  );
  assert.deepEqual(
    f.calls.filter(c => c.method === 'DELETE').map(c => c.body),
    [{product_keys: ['5000003']}],
  );
  assert.deepEqual(
    f.items[9001].map(p => p.id),
    ['sku-1', 'sku-2'],
    'only the selected product was deleted; the supplied products stay',
  );
});

test('grouped, unknown and unlisted products are refused; a listed selection takes native keys only', async t => {
  const f = world(t);
  f.items[9001][2].item_group_id = 'group-3';
  let inventory = await f.inspect();
  refused(await f.preview(['5000003'], inventory.material_hash), 'CATALOG_REMOVAL_UNVERIFIED');
  f.items[9001][2].item_group_id = 7; // unrecognized group status
  inventory = await f.inspect();
  refused(await f.preview(['5000003'], inventory.material_hash), 'CATALOG_REMOVAL_UNVERIFIED');
  delete f.items[9001][2].item_group_id;
  inventory = await f.inspect();
  refused(await f.preview(['5000099'], inventory.material_hash), 'CATALOG_REMOVAL_UNVERIFIED');
  // The listed read itself names why each key is blocked.
  const read = ok(
    await f.call({
      action: 'catalog_compare',
      ...f.scope,
      requirements: {selection_source: 'listed_inventory', product_keys: ['5000099']},
    }),
  );
  assert.equal(read.record_kind, 'x_catalog_listed_selection');
  assert.deepEqual(
    read.items.map(i => [i.product_id, i.blocked, i.blocked_reason]),
    [['5000099', true, 'not_listed']],
  );
  assert.equal(read.source_absence_established, false);
  for (const extra of [{products: f.source}, {retailer_ids: ['sku-3']}, {allow_upsert: true}])
    assert.match(
      refused(await f.preview(['5000003'], inventory.material_hash, extra), 'INVALID_ARGUMENT').message,
      /A listed selection takes native product keys, not supplied products or retailer IDs/,
      JSON.stringify(extra),
    );
  for (const [requirements, code, message] of [
    [{product_keys: ['5000003', '5000003']}, 'INVALID_ARGUMENT', /distinct listed native product keys/],
    [{product_keys: ['sku-3']}, 'INVALID_ARGUMENT', /distinct listed native product keys/],
    [{retire_retailer_ids: ['sku-3']}, 'INVALID_ARGUMENT', /does not read these requirements: retire_retailer_ids/],
    [{listed_inventory_hash: 'not-a-hash'}, 'INVALID_CATALOG_REMOVAL', /select from that listing/],
  ])
    assert.match(
      refused(await f.preview(['5000003'], inventory.material_hash, {}, requirements), code).message,
      message,
      JSON.stringify(requirements),
    );
  // Top-level selection arguments are not arguments of amcp_workspace (refused by the tool schema).
  assert.match(
    refused(
      await f.call({
        action: 'preview_catalog_removal',
        ...f.scope,
        selection_source: 'listed_inventory',
        product_keys: ['5000003'],
      }),
      'INVALID_ARGUMENT',
    ).message,
    /Unsupported arguments: selection_source, product_keys/,
  );
  assert.equal(f.writes(), 0);
  assert.equal(f.store.documents(f.actor.tenantId, 'x_catalog_removal_preview').length, 0);
});

test('a listing that changed after its inspection refuses the preview; the save rechecks the selected products', async t => {
  const f = world(t);
  const inventory = await f.inspect();
  f.items[9001][0].title = 'Renamed after the inspection';
  refused(await f.preview(['5000003'], inventory.material_hash), 'CATALOG_REMOVAL_CHANGED');
  const fresh = await f.inspect(),
    proposed = ok(await f.preview(['5000003'], fresh.material_hash));
  f.items[9001][2].title = 'Selected product changed before the save';
  refused(await f.save(proposed, {confirmed_count: 1}), 'CATALOG_REMOVAL_CHANGED');
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
  assert.equal(f.writes(), 0);
});

test("the owner's allow_deletion:false refuses the listed removal step before anything is deleted", async t => {
  const f = world(t);
  const inventory = await f.inspect(),
    saved = ok(await f.save(ok(await f.preview(['5000003'], inventory.material_hash)), {confirmed_count: 1}));
  saveSpendPolicy(
    f.store,
    {...f.actor, role: 'admin'},
    {
      gateway: 'x_ads_native_action',
      account_id: 'acct1',
      confirmed: true,
      policy: {allow_deletion: false},
    },
  );
  const campaign = args => f.service.call('amcp_campaign', args, f.actor);
  // The review is refused at prepare: the step fails with the owner's policy and nothing is sent.
  const next = ok(await campaign({action: 'prepare_next', id: saved.id}));
  assert.equal(next.review, undefined);
  assert.equal(next.current.status, 'failed');
  assert.equal(next.current.error.code, 'POLICY_DELETION_FORBIDDEN');
  assert.equal(next.current.submission, 'not_submitted');
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 0);
  assert.ok(f.items[9001].some(p => p.id === 'sku-3'));
});
