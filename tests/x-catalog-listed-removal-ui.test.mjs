import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {xCatalogComparisonFixture, xProductSource} from './fixtures/x-catalog-comparison.mjs';
import {product} from './x-catalog-fixture.mjs';

/**
 * COM-02 B on the Commerce page. Before, the "Other listed X products" of an inspection were read-only, so a
 * discontinued SKU still listed in X could not be selected for removal. Now an individual listed product can be
 * selected explicitly (none is preselected), previewed against the listing that was inspected, and saved only with its
 * count typed back. Grouped products offer no selection.
 */
const plain = value => JSON.parse(JSON.stringify(value));
async function page(locale) {
  const native = xCatalogComparisonFixture({writable: true, tenant: 'synthetic-x-listed-ui-' + locale});
  native.items[9001].push(product(4, {item_group_id: 'group-4'}));
  const ui = accountWorkflowFixture(locale);
  ui.context.platforms.push({
    id: 'x',
    gateway: 'x_ads_native_action',
    connections: [{id: 'x', enabled: true, accounts: ['acct1']}],
  });
  const form = ui.node('#catalog-import');
  form.elements.target.value = '1';
  form.elements.catalog_id.value = '9001';
  form.elements.allow_upsert.value = 'true';
  const source = [xProductSource(product(1)), xProductSource(product(2))],
    encode = v => '"' + v.replaceAll('"', '""') + '"',
    csv = Object.keys(source[0]).join(',') + '\n' + source.map(p => Object.values(p).map(encode).join(',')).join('\n');
  form.elements.file.files = [{size: Buffer.byteLength(csv), text: async () => csv}];
  ui.respond(async args => {
    const result = await native.service.call('amcp_workspace', args, native.actor);
    if (!result.success) throw Object.assign(Error(result.error.message), {code: result.error.code});
    return result.data;
  });
  await ui.run('renderCommerce()');
  await ui.bindings.get('#catalog-import')(form);
  await ui.bindings.get('#inspect-catalog-inventory')();
  return {ui, native};
}

test('an individual listed product is selected explicitly, previewed against its inspection and saved with a typed count in English and Arabic', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const {ui, native} = await page(locale);
    try {
      const view = ui.node('#catalog-inventory-view').innerHTML;
      assert.match(view, /id="catalog-listed-remove-5000003"/, 'the individual listed product can be selected');
      assert.doesNotMatch(view, /id="catalog-listed-remove-5000003" checked/, 'nothing is preselected');
      assert.doesNotMatch(view, /id="catalog-listed-remove-5000004"/, 'a grouped product offers no selection');
      assert.doesNotMatch(view, /catalog-listed-remove-500000[12]/, 'supplied products are not in this list');
      await assert.rejects(ui.bindings.get('#preview-listed-removal')(), /Select at least one|حدد منتجًا فرديًا/);
      const box = ui.node('#catalog-listed-remove-5000003');
      box.checked = true;
      box.events.get('change')();
      const before = ui.calls.length;
      await ui.bindings.get('#preview-listed-removal')();
      const request = plain(ui.calls[before]);
      assert.equal(request.action, 'preview_catalog_removal');
      assert.equal(request.requirements.selection_source, 'listed_inventory');
      assert.deepEqual(request.requirements.product_keys, ['5000003']);
      assert.match(request.requirements.listed_inventory_hash, /^[a-f0-9]{64}$/);
      assert.equal(request.products, undefined, 'no supplied source rows are invented');
      const preview = ui.node('#catalog-listed-removal-preview').innerHTML;
      assert.match(preview, /5000003/);
      assert.match(
        preview,
        locale === 'ar'
          ? /لأنك حددتها، لا لأن مصدرك يفتقدها/
          : /because you selected them, not because your source lacks them/,
      );
      ui.node('#catalog-listed-removal-count').value = '2';
      await assert.rejects(ui.bindings.get('#save-listed-removal')(), /Type the number|اكتب عدد/);
      assert.equal(native.store.documents(native.actor.tenantId, 'campaign_run').length, 0);
      ui.node('#catalog-listed-removal-count').value = '1';
      await ui.bindings.get('#save-listed-removal')();
      const saved = plain(ui.calls.at(-1));
      assert.equal(saved.action, 'create_catalog_removal');
      assert.equal(saved.confirmed_count, 1);
      const plans = native.store.documents(native.actor.tenantId, 'campaign_run');
      assert.equal(plans.length, 1);
      assert.deepEqual(ui.visits, ['/campaigns?id=' + plans[0].id]);
      assert.equal(native.writes(), 0, 'saving deletes nothing');
      transcripts.push(ui.calls.map(c => c.action));
    } finally {
      native.store.close();
    }
  }
  assert.deepEqual(transcripts[0], transcripts[1]);
});

test('changing the selection clears its preview, and a preview that differs from the inspection is refused', async () => {
  const {ui, native} = await page('en');
  try {
    const box = ui.node('#catalog-listed-remove-5000003');
    box.checked = true;
    box.events.get('change')();
    await ui.bindings.get('#preview-listed-removal')();
    assert.match(ui.node('#catalog-listed-removal-preview').innerHTML, /5000003/);
    box.checked = false;
    box.events.get('change')();
    assert.equal(ui.node('#catalog-listed-removal-preview').innerHTML, '', 'a changed selection clears the preview');
    const inventory = (
      await native.call({
        ...native.input,
        products: [xProductSource(product(1)), xProductSource(product(2))],
        inspect_other_listed_products: true,
        absent_source_policy: 'retain',
      })
    ).data.listed_inventory;
    const proposed = (
      await native.service.call(
        'amcp_workspace',
        {
          action: 'preview_catalog_removal',
          gateway: 'x_ads_native_action',
          account_id: 'acct1',
          connection_id: 'x',
          catalog_id: '9001',
          requirements: {
            selection_source: 'listed_inventory',
            product_keys: ['5000003'],
            listed_inventory_hash: inventory.material_hash,
          },
        },
        native.actor,
      )
    ).data;
    const request = {gateway: 'x_ads_native_action', account_id: 'acct1', connection_id: 'x', catalog_id: '9001'};
    ui.context.args = [proposed, request, inventory, ['5000003']];
    assert.match(ui.run('catalogListedRemovalMarkup(...args)'), /save-listed-removal/);
    for (const mutate of [
      o => (o.listed_inventory_hash = 'a'.repeat(64)),
      o => (o.targets[0].product_id = '5000002'),
      o => (o.targets[0].before.price = '1.00 SAR'),
      o => (o.selection_source = undefined),
      o => (o.source_hash = 'b'.repeat(64)),
      o => (o.provider_mutations = 1),
    ]) {
      const out = plain(proposed);
      mutate(out);
      ui.context.args = [out, request, inventory, ['5000003']];
      assert.throws(() => ui.run('catalogListedRemovalMarkup(...args)'), /preview changed/, mutate.toString());
    }
  } finally {
    native.store.close();
  }
});
