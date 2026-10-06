import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {wooInventoryInput, wooInventoryChangedReason} from './woocommerce-inventory-data.mjs';

/** A viewer inspects only owned synthetic data. Local controls and read evidence never stage destination changes. */
export async function exerciseWooInventory({page, site, workflow, locale, output, id, result, before, checks}) {
  const form = page.locator('#woo-inventory'),
    initial = site.wooInventory.artifactCounts(),
    fault = workflow !== 'woocommerce-inventory',
    stale = workflow.endsWith('-stale'),
    feedback = page.locator('#woo-inventory-workspace-feedback'),
    button = form.locator('button[type=submit]'),
    responseFor = () =>
      page.waitForResponse(
        r =>
          new URL(r.url()).pathname === '/api/workspace/workspace' &&
          r.request().postDataJSON()?.requirements?.source_kind === 'inventory',
      ),
    catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
  site.wooInventory.setFault(fault);
  await form.locator('[name=target]').selectOption('0');
  await form.locator('[name=price_field]').selectOption('price');
  assert.equal(site.counts().nativeReads, before.nativeReads);
  assert.ok((await form.getAttribute('aria-describedby')).split(/\s+/).includes('woo-inventory-limits'));
  const assertFailed = body => {
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'WOOCOMMERCE_INVENTORY_CHANGED');
    assert.equal(body.error.message, wooInventoryChangedReason);
    assert.ok(body.meta.requestId);
  };
  if (stale) {
    let release, ready, timer;
    const held = new Promise(resolve => (release = resolve)),
      responseReady = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Error('Owned inventory response was not ready')), 15000);
        ready = body => {
          clearTimeout(timer);
          resolve(body);
        };
      }),
      pattern = site.origin + '/api/workspace/workspace';
    await page.route(pattern, async intercepted => {
      if (intercepted.request().postDataJSON()?.requirements?.source_kind !== 'inventory')
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
      assert.equal(site.counts().nativeReads - before.nativeReads, 9);
      await form.locator('[name=price_field]').selectOption('sale_price');
      release();
      await page.waitForFunction(() => !document.querySelector('#woo-inventory button[type=submit]').disabled);
      assert.equal(await form.locator('[name=price_field]').inputValue(), 'sale_price');
      assert.equal(await feedback.isVisible(), false);
      assert.equal(await page.locator('#woo-inventory-heading').count(), 0);
      assert.equal(await page.locator('#toast').isVisible(), false);
      assert.equal(site.counts().nativeReads - before.nativeReads, 9);
      assert.deepEqual(site.wooInventory.artifactCounts(), initial);
      result.woo_inventory_stale = {
        delayed_original_failure: true,
        edited_selection_preserved: true,
        obsolete_error_silent: true,
        failed_native_reads: 9,
        automatic_retries: 0,
      };
    } finally {
      clearTimeout(timer);
      release();
      await page.unroute(pattern);
    }
    await form.locator('[name=price_field]').selectOption('price');
  } else if (fault) {
    const pending = responseFor();
    await button.click();
    const response = await pending,
      body = await response.json();
    assertFailed(body);
    await page.waitForFunction(() => !document.querySelector('#woo-inventory button[type=submit]').disabled);
    assert.equal(await feedback.isVisible(), true);
    assert.equal(await feedback.getAttribute('role'), 'alert');
    assert.equal(await feedback.getAttribute('aria-atomic'), 'true');
    const message = await feedback.innerText();
    assert.ok(message.includes(locale === 'ar' ? catalog[wooInventoryChangedReason] : wooInventoryChangedReason));
    assert.ok(message.includes(body.meta.requestId));
    assert.ok(
      (await button.getAttribute('aria-describedby')).split(/\s+/).includes('woo-inventory-workspace-feedback'),
    );
    assert.equal(await page.locator('#woo-inventory-heading').count(), 0);
    assert.equal(await page.locator('#toast').isVisible(), false);
    await page.waitForTimeout(6600);
    assert.equal(await feedback.isVisible(), true);
    assert.equal(await feedback.innerText(), message);
    assert.equal(site.counts().nativeReads - before.nativeReads, 9);
    assert.deepEqual(site.wooInventory.artifactCounts(), initial);
    await feedback.screenshot({path: path.join(output, id + '-diagnostic.png')});
    result.woo_inventory_failure = {
      persistent_localized_message: true,
      original_request_reference: true,
      failed_native_reads: 9,
      automatic_retries: 0,
    };
  }
  site.wooInventory.setFault(false);
  const pending = responseFor();
  await button.click();
  const response = await pending,
    body = await response.json();
  assert.equal(body.success, true, JSON.stringify(body).slice(0, 1200));
  assert.deepEqual(response.request().postDataJSON(), wooInventoryInput());
  assert.equal(body.data.item_count, 124);
  assert.equal(body.data.product_count, 121);
  assert.equal(body.data.variation_count, 3);
  assert.equal(body.data.native_requests, 9);
  assert.equal(body.data.provider_mutations, 0);
  assert.equal(body.data.source_saved, false);
  assert.equal(body.data.items.find(item => item.product_id === '9223372036854775807').name, null);
  assert.doesNotMatch(JSON.stringify(body), /UNUSED-PRIVATE|consumerSecret|synthetickey|syntheticsecret/);
  await page.locator('#woo-inventory-heading').waitFor();
  assert.equal(await feedback.isVisible(), false);
  assert.equal(await page.locator('#woo-inventory-view tbody tr').count(), 50);
  assert.equal(await page.locator('#woo-inventory-result input[type=checkbox]').count(), 0);
  assert.equal(await page.locator('#catalog-import [name=source_mode]').inputValue(), 'csv');
  assert.equal(await page.evaluate(() => typeof window.wooInventoryUnsafe), 'undefined');
  const summary = page.locator('#woo-inventory-result details summary');
  await summary.click();
  const evidence = JSON.parse(await page.locator('#woo-inventory-result details pre').innerText());
  await summary.click();
  assert.equal(evidence.items.length, 124);
  assert.equal(evidence.scans.length, 2);
  assert.equal(evidence.currency_evidence.length, 3);
  assert.equal(evidence.items.find(item => item.product_id === '5').selected_price, '999999999999.000001');
  assert.equal(evidence.items.find(item => item.product_id === '1002').selected_price, '');
  assert.equal(evidence.items.at(-1).selected_price, null);
  const loaded = site.counts().nativeReads;
  assert.equal(loaded - before.nativeReads, fault ? 18 : 9);
  await page.locator('#woo-inventory-heading').scrollIntoViewIfNeeded();
  await page.screenshot({path: path.join(output, id + '-inventory.png'), fullPage: true});
  await page.screenshot({path: path.join(output, id + '-inventory-viewport.png')});
  const region = page.locator('#woo-inventory-view .native-inventory-scroll');
  assert.ok(await region.evaluate(node => node.scrollHeight > node.clientHeight));
  assert.ok(await region.evaluate(node => node.getBoundingClientRect().height <= 400));
  await region.focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(
    () => document.querySelector('#woo-inventory-view .native-inventory-scroll').scrollTop > 0,
  );
  await region.evaluate(node => {
    node.scrollTop = 0;
  });
  await page.locator('#woo-inventory-next').click();
  assert.ok((await page.locator('#woo-inventory-view table').innerText()).includes('SKU-51'));
  await page.locator('#woo-inventory-next').click();
  assert.equal(await page.locator('#woo-inventory-view tbody tr').count(), 24);
  assert.ok((await page.locator('#woo-inventory-view table').innerText()).includes('9223372036854775807'));
  assert.ok((await page.locator('#woo-inventory-view table').innerText()).includes('0008.34567 SAR'));
  await page.locator('#woo-inventory-search').fill('SKU-121');
  await page.locator('#woo-inventory-find').click();
  assert.equal(await page.locator('#woo-inventory-view tbody tr').count(), 1);
  await page.locator('#woo-inventory-search').fill(locale === 'ar' ? 'تنويعة أصلية' : 'Native variation');
  await page.locator('#woo-inventory-search').press('Enter');
  assert.equal(await page.locator('#woo-inventory-view tbody tr').count(), 3);
  await page.locator('#woo-inventory-search').fill('no-such-product');
  await page.locator('#woo-inventory-find').click();
  assert.equal(await page.locator('#woo-inventory-view table').count(), 0);
  const noMatch =
    'No collected rows match this local view. Unpublished products and whole-store absence are not established.';
  assert.ok(
    (await page.locator('#woo-inventory-view').innerText()).includes(locale === 'ar' ? catalog[noMatch] : noMatch),
  );
  await page.locator('#woo-inventory-clear').click();
  assert.equal(await page.locator('#woo-inventory-view tbody tr').count(), 50);
  assert.equal(site.counts().nativeReads, loaded);
  assert.deepEqual(site.wooInventory.artifactCounts(), initial);
  await checks.tables(page, result);
  result.woo_inventory = {
    published_products: 121,
    reported_variations: 3,
    exact_native_prices: true,
    exact_native_identifiers: true,
    parent_membership_preserved: true,
    all_collected_rows_in_evidence: true,
    local_navigation_native_reads: 0,
    vertical_keyboard_scroll: true,
    absent_source_policy: 'retain',
    point_in_time: false,
    unpublished_parents_collected: false,
    local_drafts: 0,
    provider_mutations: 0,
    native_reads: loaded - before.nativeReads,
  };
}
