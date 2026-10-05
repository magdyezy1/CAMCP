import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {xCatalogInventoryFixture, catalogInventoryReason} from './fixtures/x-catalog-selection-inventory-data.mjs';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';

async function fixture(locale = 'en', options = {}) {
  const native = xCatalogInventoryFixture({writable: true, ...options}),
    ui = accountWorkflowFixture(locale);
  ui.context.platforms.push({
    id: 'x',
    gateway: 'x_ads_native_action',
    connections: [{id: 'x', enabled: true, accounts: ['acct1']}],
  });
  const form = ui.node('#catalog-import');
  form.elements.target.value = '1';
  form.elements.catalog_id.value = '9001';
  form.elements.allow_upsert.value = 'true';
  form.elements.file.files = [{size: native.csv.length, text: async () => native.csv.toString()}];
  ui.respond(async args => {
    if (args.action === 'catalog_preview') return catalogIngestion(args);
    const result = await native.service.call('amcp_workspace', args, native.actor);
    if (!result.success)
      throw Object.assign(new Error(result.error.message), {requestId: '12345678-1234-4123-8123-123456789abc'});
    return result.data;
  });
  await ui.run('renderCommerce()');
  await ui.bindings.get('#catalog-import')(form);
  return {...ui, native, form};
}
const noEffects = f => {
  assert.equal(f.native.writes(), 0);
  assert.equal(f.native.store.documents(f.native.actor.tenantId, 'write_review').length, 0);
  assert.equal(f.native.store.documents(f.native.actor.tenantId, 'x_catalog_removal_preview').length, 0);
};

test('English and Arabic inspection supports bounded local paging/search and exact unselected native fields without provider rereads', async () => {
  for (const locale of ['en', 'ar']) {
    const f = await fixture(locale);
    try {
      assert.match(f.node('#catalog-preview').innerHTML, /id="inspect-catalog-inventory"/);
      assert.match(
        f.node('#catalog-preview').innerHTML,
        /aria-describedby="catalog-inspection-limits catalog-inspection-feedback"/,
      );
      assert.equal(f.native.calls.length, 0);
      await f.bindings.get('#inspect-catalog-inventory')();
      const request = f.calls.at(-1),
        html = f.node('#catalog-comparison').innerHTML;
      assert.equal(request.inspect_other_listed_products, true);
      assert.equal(request.absent_source_policy, 'retain');
      assert.match(
        html,
        locale === 'ar'
          ? /منتجات X الأخرى المدرجة|خارج المجموعة المقدمة/
          : /Other listed X products|outside this supplied selection/,
      );
      assert.match(f.node('#catalog-inventory-view').innerHTML, /999999999999\.000001 SAR/);
      assert.match(f.node('#catalog-inventory-view').innerHTML, /000020\.000000 SAR/);
      assert.match(f.node('#catalog-inventory-view').innerHTML, /900719925474099312345/);
      assert.match(f.node('#catalog-inventory-view').innerHTML, /Literal &lt;img/);
      assert.doesNotMatch(html, /<img src=x|UNSELECTED-PRIVATE/);
      assert.equal(f.native.calls.length, 10);
      await f.bindings.get('#catalog-inventory-next')();
      assert.match(f.node('#catalog-inventory-view').innerHTML, /sku-53/);
      await f.bindings.get('#catalog-inventory-previous')();
      assert.match(f.node('#catalog-inventory-view').innerHTML, /sku-3/);
      f.node('#catalog-inventory-search').value = 'sku-123';
      await f.bindings.get('#catalog-inventory-find')();
      const found = f.node('#catalog-inventory-view').innerHTML;
      assert.match(found, /sku-123/);
      assert.doesNotMatch(found, /sku-3<\/code>/);
      await f.bindings.get('#catalog-inventory-clear')();
      assert.equal(f.node('#catalog-inventory-search').focused, true);
      f.node('#catalog-inventory-search').value = locale === 'ar' ? 'منتج ضمن مجموعة' : 'Grouped product';
      await f.bindings.get('#catalog-inventory-find')();
      assert.match(f.node('#catalog-inventory-view').innerHTML, /sku-3<\/code>/);
      assert.doesNotMatch(f.node('#catalog-inventory-view').innerHTML, /sku-4<\/code>/);
      f.node('#catalog-inventory-search').value = 'not-returned-by-X';
      await f.node('#catalog-inventory-search').events.get('keydown')({key: 'Enter', preventDefault() {}});
      assert.match(
        f.node('#catalog-inventory-view').innerHTML,
        locale === 'ar' ? /لا يثبت ذلك غيابها/ : /does not establish whole-store absence/,
      );
      assert.equal(f.native.calls.length, 10);
      assert.equal(f.native.store.documents(f.native.actor.tenantId, 'campaign_run').length, 0);
      noEffects(f);
    } finally {
      f.native.store.close();
    }
  }
});

test('inspecting other listed products keeps an explicitly saved draft limited to the original supplied source products', async t => {
  const f = await fixture();
  t.after(() => f.native.store.close());
  await f.bindings.get('#inspect-catalog-inventory')();
  await f.bindings.get('#create-catalog-plan')();
  const request = f.calls.at(-1);
  assert.equal(request.action, 'catalog_plan');
  assert.deepEqual(request.products, f.native.input.products);
  assert.equal(Object.hasOwn(request, 'inspect_other_listed_products'), false);
  assert.equal(Object.hasOwn(request, 'absent_source_policy'), false);
  const plans = f.native.store.documents(f.native.actor.tenantId, 'campaign_run');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].state, 'draft');
  assert.equal(plans[0].steps.length, 2);
  assert.deepEqual(
    plans[0].steps.map(s => s.arguments.payload.products[0].id),
    ['sku-1', 'sku-2'],
  );
  assert.equal(f.native.calls.length, 10);
  noEffects(f);
});

test('inspection renderer rejects foreign, destructive, incomplete, duplicated and malformed inventory evidence', async t => {
  const f = await fixture();
  t.after(() => f.native.store.close());
  const result = await f.native.call();
  assert.equal(result.success, true);
  const preview = catalogIngestion(f.native.input);
  for (const mutate of [
    o => (o.listed_inventory.scope.account_id = 'foreign'),
    o => (o.listed_inventory.source_hash = 'wrong'),
    o => (o.listed_inventory.source_absence_established = true),
    o => (o.listed_inventory.variant_inventory_complete = true),
    o => (o.listed_inventory.listed_scan_complete = false),
    o => (o.listed_inventory.absent_source_policy = 'delete'),
    o => (o.listed_inventory.supplied_listed_count = 0),
    o => (o.listed_inventory.outside_selection_count = 0),
    o => (o.listed_inventory.items[0].product_id = 5000003),
    o => (o.listed_inventory.items[0].retailer_id = 'sku-1'),
    o => (o.listed_inventory.items[1].retailer_id = o.listed_inventory.items[0].retailer_id),
    o => (o.listed_inventory.items[1].product_id = o.listed_inventory.items[0].product_id),
    o => (o.listed_inventory.items[0].currency = 'USD'),
    o => (o.listed_inventory.items[0].price = 20),
    o => (o.listed_inventory.items[0].accessToken = 'PRIVATE-INJECTED'),
    o => (o.listed_inventory.outside_selection_group_counts.grouped = 0),
    o => o.listed_inventory.captured_at++,
    o => (o.listed_inventory.material_hash = 'bad'),
  ]) {
    const out = JSON.parse(JSON.stringify(result.data));
    mutate(out);
    f.context.args = [out, f.native.input, preview];
    assert.throws(() => f.run('catalogComparisonMarkup(...args)'), /Listed catalog evidence changed/);
  }
  f.context.args = [result.data, {...f.native.input, inspect_other_listed_products: false}, preview];
  assert.throws(() => f.run('catalogComparisonMarkup(...args)'), /Listed catalog evidence changed/);
  noEffects(f);
});

test('the persistent bilingual inspection error clears only on explicit recovery and does not retry or create artifacts', async () => {
  for (const locale of ['en', 'ar']) {
    const f = await fixture(locale, {fault: true});
    try {
      await f.bindings.get('#inspect-catalog-inventory')();
      assert.equal(f.node('#catalog-inspection-feedback').hidden, false);
      const text = f.node('#catalog-inspection-feedback').innerHTML;
      assert.match(text, locale === 'ar' ? /تغيرت مشاهدات الكتالوج/ : /listed catalog observations changed/);
      assert.match(text, /12345678-1234-4123-8123-123456789abc/);
      assert.equal(f.node('#catalog-comparison').innerHTML, '');
      assert.equal(f.native.calls.length, 10);
      assert.equal(f.native.store.documents(f.native.actor.tenantId, 'campaign_run').length, 0);
      f.native.setFault(false);
      await f.bindings.get('#inspect-catalog-inventory')();
      assert.equal(f.node('#catalog-inspection-feedback').hidden, true);
      assert.match(f.node('#catalog-comparison').innerHTML, /catalog-inventory-heading/);
      assert.equal(f.native.calls.length, 20);
      noEffects(f);
    } finally {
      f.native.store.close();
    }
  }
});

test('late successful and refused inventory responses cannot repaint an edited source, destination, route, identity or detached view', async () => {
  for (const failed of [false, true])
    for (const reason of ['edit', 'destination', 'route', 'identity', 'detach']) {
      const f = await fixture();
      try {
        const evidence = await f.native.call();
        assert.equal(evidence.success, true);
        let release;
        f.respond(
          () =>
            new Promise(
              (resolve, reject) =>
                (release = () => (failed ? reject(new Error(catalogInventoryReason)) : resolve(evidence.data))),
            ),
        );
        const pending = f.bindings.get('#inspect-catalog-inventory')();
        await new Promise(resolve => setImmediate(resolve));
        if (reason === 'edit') f.form.events.get('input')();
        if (reason === 'destination') {
          f.form.elements.target.value = '0';
          f.form.events.get('change')();
        }
        if (reason === 'route') f.context.navigationGeneration++;
        if (reason === 'identity') f.context.identityGeneration++;
        if (reason === 'detach') f.form.isConnected = false;
        const before = f.node('#catalog-comparison').innerHTML;
        release();
        await pending;
        assert.equal(f.node('#catalog-comparison').innerHTML, before);
        assert.notEqual(f.node('#catalog-inspection-feedback').hidden, false);
        assert.equal(f.native.store.documents(f.native.actor.tenantId, 'campaign_run').length, 0);
        noEffects(f);
      } finally {
        f.native.store.close();
      }
    }
});
