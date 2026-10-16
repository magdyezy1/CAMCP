import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {xCatalogComparisonFixture} from './fixtures/x-catalog-comparison.mjs';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';

/**
 * COM-02 E on the Commerce page. Before, a supplied X product blocked as a possible hidden variant showed only "Product
 * may be a hidden variant; absence is not established", without saying which catalog records cause it or what to do.
 * Now the comparison names the grouped records and the scheduled feed, and the single comparison validator refuses
 * variant-group evidence that does not fit the items it explains.
 */
const plain = value => JSON.parse(JSON.stringify(value));
async function groupedComparison(t, qualified = false) {
  const previous = process.env.AMCP_X_CATALOG_GROUP_EXPANSION;
  if (qualified) process.env.AMCP_X_CATALOG_GROUP_EXPANSION = 'qualified';
  else delete process.env.AMCP_X_CATALOG_GROUP_EXPANSION;
  t.after(() => {
    if (previous === undefined) delete process.env.AMCP_X_CATALOG_GROUP_EXPANSION;
    else process.env.AMCP_X_CATALOG_GROUP_EXPANSION = previous;
  });
  const native = xCatalogComparisonFixture();
  t.after(() => native.store.close());
  Object.assign(native.items[9001][2], {item_group_id: 'Shoe', item_group_key: '7700001'});
  const request = native.input,
    result = await native.call(request);
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 1000));
  return {out: result.data, request, preview: catalogIngestion(request)};
}

test('E: a possible hidden variant names the grouped records and the scheduled feed in English and Arabic', async t => {
  const {out, request, preview} = await groupedComparison(t);
  assert.equal(out.items[0].blocked_reason, 'hidden_variant');
  for (const [locale, feed] of [
    ['en', /scheduled feed/],
    ['ar', /الموجز المجدول/],
  ]) {
    const ui = accountWorkflowFixture(locale);
    ui.context.args = [out, request, preview];
    const html = ui.run('catalogComparisonMarkup(...args)');
    assert.match(html, feed, locale);
    assert.match(html, /\(1 [^:]+: sku-3\)/, locale + ': the grouped record is named with its count');
    assert.match(html, locale === 'ar' ? /متغيرًا مخفيًا/ : /hidden variant/, locale);
  }
});

test('E: no notice once every group was read in full, and tampered variant-group evidence is refused', async t => {
  const qualified = await groupedComparison(t, true);
  assert.equal(qualified.out.variant_groups.expansion, 'complete');
  const ui = accountWorkflowFixture();
  ui.context.args = [qualified.out, qualified.request, qualified.preview];
  assert.doesNotMatch(ui.run('catalogComparisonMarkup(...args)'), /scheduled feed/);

  const {out, request, preview} = await groupedComparison(t);
  for (const mutate of [
    o => delete o.variant_groups.remedy,
    o => (o.variant_groups.expansion = 'complete'),
    o => (o.variant_groups.expansion = 'not_needed'),
    o => (o.variant_groups.grouped_record_count = 0),
    o => (o.variant_groups.grouped_records[0].product_id = 'sku-3'),
    o => (o.variant_groups.grouped_records = Array(11).fill(o.variant_groups.grouped_records[0])),
    o => (o.variant_groups = 'hidden'),
    // A possible hidden variant always comes with the records and the feed remedy.
    o => Object.assign(o.variant_groups, {expansion: 'complete', remedy: null}),
  ]) {
    const tampered = plain(out);
    mutate(tampered);
    ui.context.args = [tampered, request, preview];
    assert.throws(() => ui.run('catalogComparisonMarkup(...args)'), /scope or evidence changed/, mutate.toString());
  }
  // Variant-group evidence belongs to X only.
  const meta = {...plain(out), scope: {...out.scope, gateway: 'meta_native_action'}};
  ui.context.args = [meta, {...request, gateway: 'meta_native_action'}, preview];
  assert.throws(() => ui.run('catalogComparisonMarkup(...args)'), /scope or evidence changed/);
});
