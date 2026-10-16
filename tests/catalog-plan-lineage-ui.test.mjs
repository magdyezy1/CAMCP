import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {xCatalogComparisonFixture} from './fixtures/x-catalog-comparison.mjs';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';

/**
 * COM-03 plan lineage on the Commerce page. Before, a plan saved after a comparison kept no trace of it, so a saved plan
 * could not show which comparison its products came from. Every save after a comparison now names that comparison
 * (its sealed reference), and the saved plan's lineage records it; "Save all" names it only while AMCP still accepts
 * the reference, so an old comparison never blocks saving the whole source.
 */
async function page(t) {
  const native = xCatalogComparisonFixture({writable: true, tenant: 'catalog-lineage-ui'});
  t.after(() => native.store.close());
  const ui = accountWorkflowFixture('en');
  ui.context.platforms.push({
    id: 'x',
    gateway: 'x_ads_native_action',
    connections: [{id: 'x', enabled: true, accounts: ['acct1']}],
  });
  const form = ui.node('#catalog-import');
  form.elements.target.value = '1';
  form.elements.catalog_id.value = '9001';
  form.elements.allow_upsert.value = 'true';
  const encode = v => '"' + v.replaceAll('"', '""') + '"',
    source = native.input.products,
    csv = Object.keys(source[0]).join(',') + '\n' + source.map(p => Object.values(p).map(encode).join(',')).join('\n');
  form.elements.file.files = [{size: Buffer.byteLength(csv), text: async () => csv}];
  const comparisons = [];
  ui.respond(async args => {
    if (args.action === 'catalog_preview') return catalogIngestion(args);
    const result = await native.service.call('amcp_workspace', args, native.actor);
    assert.equal(result.success, true, JSON.stringify(result).slice(0, 800));
    if (args.action === 'catalog_compare') comparisons.push(result.data);
    return result.data;
  });
  await ui.run('renderCommerce()');
  await ui.bindings.get('#catalog-import')(form);
  const runs = () => native.store.documents(native.actor.tenantId, 'campaign_run');
  return {ui, native, comparisons, runs};
}

test('"Save all" after a comparison names it in the plan lineage, and saves without it once AMCP no longer accepts it', async t => {
  const {ui, comparisons, runs} = await page(t);
  await ui.bindings.get('#create-catalog-plan')();
  assert.equal(ui.calls.at(-1).requirements, undefined, 'without a comparison the plan names none');
  assert.equal(runs()[0].catalog_lineage.comparison_hash, null);
  await ui.bindings.get('#compare-catalog-products')();
  await ui.bindings.get('#create-catalog-plan')();
  assert.match(ui.calls.at(-1).requirements.comparison_token, /^v1\./);
  const named = runs().find(run => run.catalog_lineage.comparison_hash !== null);
  assert.equal(named.catalog_lineage.comparison_hash, comparisons[0].comparison_hash);
  assert.equal(named.steps.length, 4, 'all supplied products are saved');
  // Fourteen minutes later the reference is about to lapse: "Save all" saves the whole source without naming it.
  ui.run('Date.now = (now => () => now + 840000)(Date.now())');
  await ui.bindings.get('#create-catalog-plan')();
  assert.equal(ui.calls.at(-1).requirements, undefined);
  assert.equal(runs().filter(run => run.catalog_lineage.comparison_hash === null).length, 2);
});

test('"Save only products needing review" names the comparison its review set came from', async t => {
  const {ui, comparisons, runs} = await page(t);
  await ui.bindings.get('#compare-catalog-products')();
  await ui.bindings.get('#save-catalog-changes')();
  const request = ui.calls.at(-1);
  assert.deepEqual(
    request.products.map(p => p.retailer_id),
    [...comparisons[0].review_retailer_ids],
  );
  assert.match(request.requirements.comparison_token, /^v1\./);
  const [run] = runs();
  assert.equal(run.catalog_lineage.comparison_hash, comparisons[0].comparison_hash);
  assert.equal(run.catalog_lineage.source_kind, 'supplied_products');
});
