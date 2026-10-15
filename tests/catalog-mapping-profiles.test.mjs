import test from 'node:test';
import assert from 'node:assert/strict';
import {actor, ok, metaWorld} from './fixtures/meta-catalog-world.mjs';

/**
 * COM-03 Phase 2: versioned catalog mapping profiles. Before, the supplier-column mapping existed only in one browser
 * session: an MCP client had to re-implement it, a plan could not say which mapping produced it, and nothing stopped
 * the next import from reading the retailer ID from another column (silently changing every product's identity). Now
 * the mapping is a workspace document per destination catalog: saved versions round-trip, the identity column changes
 * only by explicit intent, and a concurrent change is refused instead of overwritten.
 */
const scope = {gateway: 'meta_native_action', account_id: '123', connection_id: 'm', catalog_id: '555'},
  columns = {retailer_id: 'SKU', name: 'Name', price: 'Regular price', image_url: 'Images'},
  mapping = (extra = {}) => ({columns, fixed_currency: 'SAR', image_mode: 'first_list', ...extra});
function world(t) {
  const f = metaWorld();
  t.after(() => f.store.close());
  return {
    ...f,
    save: (requirements, extra = {}, as = actor) =>
      f.service.call('amcp_workspace', {action: 'save_catalog_mapping', ...scope, requirements, ...extra}, as),
    read: (extra = {}, as = actor) =>
      f.service.call('amcp_workspace', {action: 'catalog_mapping', ...scope, ...extra}, as),
  };
}

test('a saved mapping round-trips by version; an unchanged save keeps its version and nothing reaches a provider', async t => {
  const f = world(t);
  const empty = ok(await f.read());
  assert.equal(empty.profile, null);
  assert.deepEqual(empty.required_fields, ['retailer_id', 'name', 'price', 'image_url']);
  assert.ok(empty.accepted_fields.includes('sale_price'));
  const first = ok(await f.save(mapping(), {revision: 0}));
  assert.equal(first.changed, true);
  assert.equal(first.profile.version, 1);
  assert.deepEqual(first.profile.columns, columns);
  assert.equal(first.profile.fixed_currency, 'SAR');
  assert.equal(first.profile.image_mode, 'first_list');
  assert.match(first.profile.profile_hash, /^[a-f0-9]{64}$/);
  const read = ok(await f.read());
  assert.deepEqual(read.profile, first.profile, 'the saved mapping reads back unchanged');
  // The same mapping, its fields in another order, is the same version.
  const reordered = Object.fromEntries(Object.entries(columns).reverse());
  const same = ok(await f.save(mapping({columns: reordered}), {revision: 1}));
  assert.equal(same.changed, false);
  assert.equal(same.profile.version, 1);
  const second = ok(await f.save(mapping({columns: {...columns, description: 'Long description'}}), {revision: 1}));
  assert.equal(second.profile.version, 2);
  assert.deepEqual(
    second.profile.versions.map(v => [v.version, v.retailer_id_column]),
    [
      [1, 'SKU'],
      [2, 'SKU'],
    ],
  );
  assert.equal(f.calls.length, 0, 'mapping profiles make no provider request');
  assert.equal(f.writes(), 0);
  const audit = f.store.db.prepare("SELECT event FROM audit WHERE event LIKE '%catalog_mapping_saved%'").all();
  assert.equal(audit.length, 2, 'each new version is audited once');
  // Another catalog has its own profile.
  const other = ok(
    await f.service.call('amcp_workspace', {action: 'catalog_mapping', ...scope, catalog_id: '556'}, actor),
  );
  assert.equal(other.profile, null);
});

test('the retailer ID column changes only explicitly, and a concurrent change is refused instead of overwritten', async t => {
  const f = world(t);
  ok(await f.save(mapping()));
  const moved = await f.save(mapping({columns: {...columns, retailer_id: 'Barcode'}}));
  assert.equal(moved.success, false);
  assert.equal(moved.error.code, 'CATALOG_MAPPING_IDENTITY');
  assert.deepEqual(moved.error.details, {saved_column: 'SKU', column: 'Barcode'});
  assert.equal(ok(await f.read()).profile.version, 1, 'the refused change saved nothing');
  const replaced = ok(
    await f.save(mapping({columns: {...columns, retailer_id: 'Barcode'}, replace_identity_column: true})),
  );
  assert.equal(replaced.profile.version, 2);
  assert.equal(replaced.profile.columns.retailer_id, 'Barcode');
  const audit = f.store.db.prepare("SELECT event FROM audit WHERE event LIKE '%identity_column_replaced%'").all();
  assert.ok(audit.some(row => row.event.includes('"identity_column_replaced":true')));
  // A save from an older read is refused with the current version.
  const stale = await f.save(mapping({columns: {...columns, retailer_id: 'Barcode', brand: 'Brand'}}), {revision: 1});
  assert.equal(stale.success, false);
  assert.equal(stale.error.code, 'CATALOG_MAPPING_CHANGED');
  assert.equal(stale.error.details.version, 2);
});

test('a mapping is refused for unknown fields, missing required columns, unclear currency or images, readers and other accounts', async t => {
  const f = world(t);
  for (const [requirements, pattern] of [
    [mapping({columns: {...columns, colour: 'Colour'}}), /does not take these product fields/],
    [mapping({columns: {retailer_id: 'SKU', name: 'Name', image_url: 'Images'}}), /every required product field/],
    [mapping({columns: {...columns, name: ' Name'}}), /as its CSV header writes it/],
    [mapping({columns: {...columns, name: 'N'.repeat(201)}}), /as its CSV header writes it/],
    [mapping({fixed_currency: 'sar'}), /currency column or one explicit/],
    [mapping({columns: {...columns, currency: 'Currency'}}), /currency column or one explicit/],
    [mapping({image_mode: 'all'}), /how to read the image column/],
    [{fixed_currency: 'SAR'}, /source column of each mapped product field/],
    [mapping({replace_identity_column: 'yes'}), /true or false/],
  ]) {
    const refused = await f.save(requirements);
    assert.equal(refused.success, false, JSON.stringify(requirements));
    assert.match(refused.error.message, pattern);
  }
  const unknownKey = await f.save({...mapping(), sale: 'Sale'});
  assert.equal(unknownKey.success, false);
  const reader = await f.save(mapping(), {}, {...actor, role: 'reader'});
  assert.equal(reader.success, false);
  assert.equal(reader.error.code, 'FORBIDDEN');
  const foreign = await f.service.call(
    'amcp_workspace',
    {action: 'save_catalog_mapping', ...scope, account_id: '999', requirements: mapping()},
    actor,
  );
  assert.equal(foreign.success, false);
  const badCatalog = await f.service.call(
    'amcp_workspace',
    {action: 'catalog_mapping', ...scope, catalog_id: '../555'},
    actor,
  );
  assert.equal(badCatalog.success, false);
  assert.equal(ok(await f.read()).profile, null, 'no refused save left a profile');
});
