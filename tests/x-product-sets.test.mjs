import test from 'node:test';
import assert from 'node:assert/strict';
import {actionContracts} from '../dist/src/action-contracts.js';
import {registry, setup, product} from './x-catalog-fixture.mjs';

/**
 * Product sets of X catalogs, opened by the owner on 2026-09-29, from X's "Catalog Management" overview and reference
 * (docs.x.com, read 2026-09-29): MANUAL sets of up to 50 product keys, FILTERED sets of up to 30 filters; "Updating
 * FILTERED product sets is not supported"; deletion is "a permanent deletion".
 */
const actions = {
  create: 'x_product_catalogs_product_catalog_id_product_sets_post',
  update: 'x_product_catalogs_product_catalog_id_product_sets_product_set_id_put',
  remove: 'x_product_catalogs_product_catalog_id_product_sets_product_set_id_delete',
};
const catalog = {product_catalog_id: '9001'};
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1200));
  return r;
};
const refused = (r, code) => assert.equal(r.error?.code, code, JSON.stringify(r).slice(0, 800));

test('a filtered set is created as JSON and read back, prices compared as amounts', async () => {
  const x = setup();
  try {
    const p = ok(
      await x.prepare(
        actions.create,
        {
          name: 'Under 50',
          type: 'FILTERED',
          filters: [
            {attribute: 'price', operator: 'LESS_THAN', value: '50 SAR'},
            {attribute: 'custom_label_0', operator: 'MATCH', value: 'summer'},
          ],
        },
        catalog,
      ),
    );
    assert.match(p.data.creative_impact.effect, /processing_status/);
    assert.equal(p.data.creative_impact.warning, undefined);
    ok(await x.execute(p));
    const sent = x.calls.find(c => c.method === 'POST');
    assert.match(sent.type, /application\/json/);
    assert.equal(sent.body.filters[0].value, '50 SAR');
    assert.equal(ok(await x.verify(p)).data.status, 'verified');
  } finally {
    x.store.close();
  }
});

test('a manual set names products by key; the review shows them, unknown keys are refused', async () => {
  const x = setup();
  try {
    const p = ok(
      await x.prepare(actions.create, {name: 'Two', type: 'MANUAL', product_keys: ['5000002', '5000003']}, catalog),
    );
    assert.deepEqual(
      p.data.creative_impact.creating.products.map(r => r.title),
      ['Product 2', 'Product 3'],
    );
    ok(await x.execute(p));
    assert.equal(ok(await x.verify(p)).data.status, 'verified');
    refused(
      await x.prepare(actions.create, {name: 'Ghost', type: 'MANUAL', product_keys: ['5000999']}, catalog),
      'STATE_TARGET_MISMATCH',
    );
  } finally {
    x.store.close();
  }
});

test('keys beyond the first 1,000 products are not guessed', async () => {
  const x = setup({products: 1200});
  try {
    const far = product(1100).product_key,
      r = await x.prepare(actions.create, {name: 'Far', type: 'MANUAL', product_keys: [far]}, catalog);
    refused(r, 'CATALOG_SCAN_LIMIT');
    assert.match(r.error.remedy.action, /FILTERED product set/);
    ok(
      await x.prepare(actions.create, {name: 'Near', type: 'MANUAL', product_keys: [product(40).product_key]}, catalog),
    );
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
});

test('a manual set is updated with a warning that ad use cannot be checked; filtered sets are not updated', async () => {
  const x = setup();
  try {
    const p = ok(
      await x.prepare(
        actions.update,
        {name: 'Picks', product_keys: ['5000001', '5000002']},
        {...catalog, product_set_id: '7001'},
      ),
    );
    assert.match(p.data.creative_impact.warning, /cannot tell whether an ad uses this set/);
    assert.equal(p.data.creative_impact.may_affect_serving, true);
    ok(await x.execute(p));
    assert.equal(ok(await x.verify(p)).data.status, 'verified');
    assert.deepEqual(x.sets[9001].get('7001').product_ids, ['sku-1', 'sku-2']);
    refused(
      await x.prepare(actions.update, {name: 'Renamed'}, {...catalog, product_set_id: '7002'}),
      'INVALID_X_PRODUCT_SET',
    );
    refused(
      await x.prepare(actions.update, {product_keys: ['5000001', '5000002']}, {...catalog, product_set_id: '7001'}),
      'INVALID_X_PRODUCT_SET',
    );
  } finally {
    x.store.close();
  }
});

test('a set is deleted with the same warning and read back gone; unknown sets and other catalogs are refused', async () => {
  const x = setup();
  try {
    const p = ok(await x.prepare(actions.remove, undefined, {...catalog, product_set_id: '7002'}));
    assert.equal(p.data.creative_impact.deleting.name, 'Premium');
    assert.match(p.data.creative_impact.warning, /check X Ads Manager first/);
    ok(await x.execute(p));
    assert.equal(ok(await x.verify(p)).data.status, 'verified');
    refused(await x.prepare(actions.remove, undefined, {...catalog, product_set_id: '7999'}), 'STATE_NOT_FOUND');
    refused(
      await x.prepare(actions.remove, undefined, {product_catalog_id: '9009', product_set_id: '7001'}),
      'STATE_TARGET_MISMATCH',
    );
  } finally {
    x.store.close();
  }
});

test('shapes are refused before any request', async () => {
  const x = setup();
  try {
    const filter = {attribute: 'price', operator: 'GREATER_THAN', value: '10.00 SAR'};
    for (const payload of [
      {name: 'X', type: 'FILTERED', filters: Array(31).fill(filter)},
      {name: 'X', type: 'FILTERED', filters: [{...filter, attribute: 'brand'}]},
      {name: 'X', type: 'FILTERED', filters: [{...filter, operator: 'BETWEEN'}]},
      {name: 'X', type: 'FILTERED', filters: [{...filter, value: '10 riyals'}]},
      {name: 'X', type: 'FILTERED', filters: [{attribute: 'inventory', operator: 'LESS_THAN', value: 'few'}]},
      {name: 'X', type: 'FILTERED', filters: [filter], product_keys: ['5000001']},
      {name: 'X', type: 'MANUAL', product_keys: Array.from({length: 51}, (_, i) => String(5000001 + i))},
      {name: 'X', type: 'MANUAL', product_keys: ['5000001', '5000001']},
      {name: 'X', type: 'MANUAL', filters: [filter]},
      {name: 'X', type: 'SMART', product_keys: ['5000001']},
    ])
      assert.equal(
        (await x.prepare(actions.create, payload, catalog)).success,
        false,
        JSON.stringify(payload).slice(0, 120),
      );
    const r = await x.prepare(actions.update, {filters: [filter]}, {...catalog, product_set_id: '7002'});
    assert.match(r.error.message, /does not support updating FILTERED/);
    assert.equal(x.calls.length, 0);
    assert.deepEqual(
      actionContracts(registry)
        .filter(r => r.family === 'x_product_sets')
        .map(r => r.action)
        .sort(),
      Object.values(actions).sort(),
    );
  } finally {
    x.store.close();
  }
});
