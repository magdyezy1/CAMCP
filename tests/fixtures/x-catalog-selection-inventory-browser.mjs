import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {catalogInventoryReason} from './x-catalog-selection-inventory-data.mjs';

/** Only owned loopback and in-memory GET evidence; every inspection keeps all source products unselected. */
export async function exerciseXCatalogInventory({page, site, workflow, locale, output, id, result, before, checks}) {
  const form = page.locator('#catalog-import'),
    initial = site.catalogInventory.artifactCounts(),
    fault = workflow !== 'x-catalog-inventory',
    stale = workflow.endsWith('-stale');
  site.catalogInventory.setFault(fault);
  await form.locator('[name=target]').selectOption('0');
  await form.locator('[name=catalog_id]').fill('9001');
  await form.locator('[name=allow_upsert]').selectOption('true');
  await form.locator('[name=name]').fill('Synthetic listed catalog source');
  await form
    .locator('[name=file]')
    .setInputFiles({name: 'synthetic-selected-products.csv', mimeType: 'text/csv', buffer: site.csv});
  const preview = async () => {
    await form.locator('button[type=submit]').click();
    await page.locator('#inspect-catalog-inventory').waitFor();
  };
  await preview();
  assert.equal(site.counts().nativeReads, before.nativeReads);
  const original = await form.evaluate(el =>
      Object.fromEntries([...el.elements].filter(f => f.name && f.type !== 'file').map(f => [f.name, f.value])),
    ),
    feedback = page.locator('#catalog-inspection-feedback'),
    button = page.locator('#inspect-catalog-inventory'),
    responseFor = () =>
      page.waitForResponse(
        r =>
          new URL(r.url()).pathname === '/api/workspace/workspace' &&
          r.request().postDataJSON()?.action === 'catalog_compare',
      ),
    assertFailed = body => {
      assert.equal(body.success, false);
      assert.equal(body.error.code, 'CATALOG_COMPARISON_CHANGED');
      assert.equal(body.error.message, catalogInventoryReason);
      assert.ok(body.meta.requestId);
    },
    catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
  assert.ok((await button.getAttribute('aria-describedby')).split(/\s+/).includes('catalog-inspection-limits'));
  if (stale) {
    let release, ready, timer;
    const held = new Promise(resolve => (release = resolve)),
      responseReady = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Error('Owned catalog response was not ready')), 15000);
        ready = body => {
          clearTimeout(timer);
          resolve(body);
        };
      }),
      pattern = site.origin + '/api/workspace/workspace';
    await page.route(pattern, async intercepted => {
      const input = intercepted.request().postDataJSON();
      if (input?.action !== 'catalog_compare' || input.inspect_other_listed_products !== true)
        return intercepted.continue();
      const response = await intercepted.fetch();
      ready(await response.json());
      await held;
      await intercepted.fulfill({response});
    });
    try {
      await button.click();
      const body = await responseReady;
      assertFailed(body);
      assert.equal(site.counts().nativeReads - before.nativeReads, 10);
      assert.deepEqual(site.catalogInventory.artifactCounts(), initial);
      await form.locator('[name=name]').fill('Changed source selection');
      release();
      await page.waitForFunction(() => !document.querySelector('#catalog-preview #inspect-catalog-inventory'));
      await page.waitForTimeout(250);
      assert.equal(await form.locator('[name=name]').inputValue(), 'Changed source selection');
      assert.equal(await page.locator('#catalog-inspection-feedback').count(), 0);
      assert.equal(await page.locator('#catalog-inventory-heading').count(), 0);
      assert.equal(await page.locator('#toast').isVisible(), false);
      assert.equal(site.counts().nativeReads - before.nativeReads, 10);
      assert.deepEqual(site.catalogInventory.artifactCounts(), initial);
      result.catalog_inventory_stale = {
        delayed_original_failure: true,
        changed_source_preserved: true,
        obsolete_error_silent: true,
        failed_native_reads: 10,
        automatic_retries: 0,
      };
      await form.locator('[name=name]').fill(original.name);
    } finally {
      clearTimeout(timer);
      release();
      await page.unroute(pattern);
    }
    await preview();
  } else if (fault) {
    const pending = responseFor();
    await button.click();
    const response = await pending,
      body = await response.json();
    assertFailed(body);
    await page.waitForFunction(() => !document.querySelector('#inspect-catalog-inventory').disabled);
    assert.equal(await feedback.isVisible(), true);
    assert.equal(await feedback.getAttribute('role'), 'alert');
    assert.equal(await feedback.getAttribute('aria-atomic'), 'true');
    const message = await feedback.innerText();
    assert.ok(message.includes(locale === 'ar' ? catalog[catalogInventoryReason] : catalogInventoryReason));
    assert.ok(message.includes(body.meta.requestId));
    assert.equal(await page.locator('#catalog-inventory-heading').count(), 0);
    assert.equal(await page.locator('#toast').isVisible(), false);
    assert.equal(site.counts().nativeReads - before.nativeReads, 10);
    assert.deepEqual(site.catalogInventory.artifactCounts(), initial);
    await page.waitForTimeout(6600);
    assert.equal(await feedback.isVisible(), true);
    assert.equal(await feedback.innerText(), message);
    assert.equal(site.counts().nativeReads - before.nativeReads, 10);
    await feedback.screenshot({path: path.join(output, id + '-diagnostic.png')});
    result.catalog_inventory_failure = {
      persistent_localized_message: true,
      original_request_reference: true,
      failed_native_reads: 10,
      automatic_retries: 0,
    };
  }
  site.catalogInventory.setFault(false);
  const pending = responseFor();
  await page.locator('#inspect-catalog-inventory').click();
  const response = await pending,
    body = await response.json();
  assert.equal(body.success, true, JSON.stringify(body).slice(0, 1200));
  const request = response.request().postDataJSON(),
    inventory = body.data.listed_inventory;
  assert.equal(request.inspect_other_listed_products, true);
  assert.equal(request.absent_source_policy, 'retain');
  assert.deepEqual(request.products, site.catalogInventory.products);
  assert.equal(inventory.listed_product_count, 123);
  assert.equal(inventory.supplied_listed_count, 2);
  assert.equal(inventory.outside_selection_count, 121);
  assert.equal(inventory.source_absence_established, false);
  assert.equal(inventory.variant_inventory_complete, false);
  assert.equal(inventory.absent_source_policy, 'retain');
  assert.deepEqual(inventory.outside_selection_group_counts, {individual: 119, grouped: 1, unknown: 1});
  assert.equal(inventory.items.find(p => p.retailer_id === 'sku-5').price, '999999999999.000001 SAR');
  assert.equal(inventory.items.find(p => p.retailer_id === 'sku-5').product_id, '900719925474099312345');
  assert.doesNotMatch(
    JSON.stringify(body),
    /UNSELECTED-PRIVATE|synthetic-token|consumerSecret|tokenSecret|accessToken/,
  );
  await page.locator('#catalog-inventory-heading').waitFor();
  assert.equal(await feedback.isVisible(), false);
  assert.equal(await page.locator('#catalog-inventory-view tbody tr').count(), 50);
  // COM-02 B: each individual listed product on the page can be selected for an explicit removal; the grouped and
  // unknown-group products cannot, and nothing is selected for the person.
  const selectable = inventory.items.slice(0, 50).filter(p => p.group_status === 'individual').length;
  assert.ok(selectable > 0 && selectable < 50, 'The first page holds individual and grouped products');
  assert.equal(await page.locator('#catalog-inventory-view input[type=checkbox]').count(), selectable);
  assert.equal(await page.locator('#catalog-inventory-view input[type=checkbox]:checked').count(), 0);
  assert.equal(await page.locator('#catalog-comparison input:checked').count(), 0);
  assert.equal(await page.evaluate(() => typeof window.catalogUnsafe), 'undefined');
  const loaded = site.counts().nativeReads;
  assert.equal(loaded - before.nativeReads, fault ? 20 : 10);
  await page.screenshot({path: path.join(output, id + '-listed.png'), fullPage: true});
  await page.locator('#catalog-inventory-next').click();
  assert.ok((await page.locator('#catalog-inventory-view table').innerText()).includes('sku-53'));
  await page.locator('#catalog-inventory-previous').click();
  await page.locator('#catalog-inventory-search').fill('sku-123');
  await page.locator('#catalog-inventory-find').click();
  assert.equal(await page.locator('#catalog-inventory-view tbody tr').count(), 1);
  assert.ok((await page.locator('#catalog-inventory-view table').innerText()).includes('sku-123'));
  await page.locator('#catalog-inventory-clear').click();
  await page.locator('#catalog-inventory-search').fill(locale === 'ar' ? 'منتج ضمن مجموعة' : 'Grouped product');
  await page.locator('#catalog-inventory-search').press('Enter');
  assert.equal(await page.locator('#catalog-inventory-view tbody tr').count(), 1);
  assert.ok((await page.locator('#catalog-inventory-view table').innerText()).includes('sku-3'));
  await page.locator('#catalog-inventory-search').fill('no-such-listed-product');
  await page.locator('#catalog-inventory-find').click();
  assert.equal(await page.locator('#catalog-inventory-view table').count(), 0);
  const noMatch = 'No other listed products match this view. This does not establish whole-store absence.';
  assert.ok(
    (await page.locator('#catalog-inventory-view').innerText()).includes(locale === 'ar' ? catalog[noMatch] : noMatch),
  );
  await page.locator('#catalog-inventory-clear').click();
  assert.equal(await page.locator('#catalog-inventory-view tbody tr').count(), 50);
  assert.equal(site.counts().nativeReads, loaded);
  assert.deepEqual(site.catalogInventory.artifactCounts(), initial);
  assert.deepEqual(
    await form.evaluate(el =>
      Object.fromEntries([...el.elements].filter(f => f.name && f.type !== 'file').map(f => [f.name, f.value])),
    ),
    original,
  );
  await checks.tables(page, result);
  await checks.productLabels(page, '#catalog-inventory-view table', result);
  result.catalog_inventory = {
    listed_products: 123,
    supplied_products: 2,
    other_listed_products: 121,
    original_observations: inventory.items.length,
    lossless_native_prices: true,
    lossless_native_identifiers: true,
    local_page_search_actions: 8,
    local_actions_native_reads: 0,
    retained_absent_source_policy: true,
    full_source_absence: false,
    complete_variant_inventory: false,
    local_drafts: 0,
    provider_mutations: 0,
    network_reads: loaded - before.nativeReads,
  };
}
