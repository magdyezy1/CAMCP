import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {xCatalogComparisonFixture, xProductSource} from './fixtures/x-catalog-comparison.mjs';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';
import {product} from './x-catalog-fixture.mjs';
const plain = value => JSON.parse(JSON.stringify(value));
async function fixture(locale = 'en', options = {}) {
  const native = xCatalogComparisonFixture({writable: true, ...options});
  delete native.items[9001][2].image_link;
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
  const encode = v => '"' + v.replaceAll('"', '""') + '"',
    source = native.input.products;
  const csv =
    Object.keys(source[0]).join(',') + '\n' + source.map(p => Object.values(p).map(encode).join(',')).join('\n');
  form.elements.file.files = [{size: Buffer.byteLength(csv), text: async () => csv}];
  ui.respond(async args => {
    if (args.action === 'catalog_preview') return catalogIngestion(args);
    const result = await native.service.call('amcp_workspace', args, native.actor);
    assert.equal(result.success, true, JSON.stringify(result).slice(0, 1000));
    return result.data;
  });
  await ui.run('renderCommerce()');
  await ui.bindings.get('#catalog-import')(form);
  return {...ui, native, form};
}

test('English and Arabic X comparisons present exact native evidence and save only eligible supplied source rows', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = await fixture(locale);
    try {
      assert.equal(f.native.calls.length, 0);
      assert.match(f.node('#catalog-preview').innerHTML, /id="compare-catalog-products"/);
      await f.bindings.get('#compare-catalog-products')();
      const html = f.node('#catalog-comparison').innerHTML;
      assert.match(html, /5000001/);
      assert.match(html, /20\.00 SAR/);
      assert.match(html, locale === 'ar' ? /أسعار عشرية|المتغيرات/ : /decimal|variants/);
      assert.doesNotMatch(html, /native price filter|مرشح السعر الأصلي/);
      assert.match(html, /scope="col"/);
      assert.match(html, /tabindex="0"/);
      assert.equal(f.node('#catalog-comparison-heading').focused, true);
      assert.equal(f.native.writes(), 0);
      await f.bindings.get('#save-catalog-changes')();
      const request = f.calls.at(-1);
      assert.equal(request.action, 'catalog_plan');
      assert.equal(request.products.length, 3);
      assert.deepEqual(
        request.products.map(p => p.retailer_id),
        ['sku-4', 'sku-1', 'sku-3'],
      );
      assert.equal(request.confirmed, undefined);
      const saved = f.native.store.documents(f.native.actor.tenantId, 'campaign_run');
      assert.equal(saved.length, 1);
      assert.equal(saved[0].state, 'draft');
      assert.equal(saved[0].steps.length, 3);
      assert.equal(f.native.store.documents(f.native.actor.tenantId, 'write_review').length, 0);
      assert.equal(f.native.writes(), 0);
      // COM-03: the plan names the comparison its products come from (a sealed reference that differs per read), and
      // the saved plan's lineage records that comparison.
      assert.match(request.requirements.comparison_token, /^v1\./);
      assert.match(saved[0].catalog_lineage.comparison_hash, /^[a-f0-9]{64}$/);
      assert.equal(saved[0].catalog_lineage.source_kind, 'supplied_products');
      transcripts.push({...request, name: 'same', requirements: {...request.requirements, comparison_token: 'sealed'}});
    } finally {
      f.native.store.close();
    }
  }
  assert.deepEqual(transcripts[0], transcripts[1]);
});

test('X comparison renderer escapes fields, preserves supported decimal neighbors and displays grouped uncertainty without eligible drafts', async () => {
  const f = await fixture();
  try {
    f.native.input.products = [xProductSource(product(1), {price: '999999999999.000002', name: 'Title <unsafe>'})];
    f.native.items[9001][0].price = '999999999999.000001 SAR';
    const result = await f.native.call(),
      preview = catalogIngestion(f.native.input);
    assert.equal(result.success, true, JSON.stringify(result).slice(0, 1000));
    f.context.args = [result.data, f.native.input, preview];
    const html = f.run('catalogComparisonMarkup(...args)');
    assert.match(html, /999999999999\.000001 SAR/);
    assert.match(html, /999999999999\.000002 SAR/);
    assert.match(html, /Title &lt;unsafe&gt;/);
    assert.doesNotMatch(html, /<unsafe>/);
    f.native.items[9001][0].item_group_id = 'group';
    const grouped = await f.native.call();
    assert.equal(grouped.success, true);
    f.context.args[0] = grouped.data;
    const blocked = f.run('catalogComparisonMarkup(...args)');
    assert.match(blocked, /Grouped product/);
    assert.doesNotMatch(blocked, /id="save-catalog-changes"/);
  } finally {
    f.native.store.close();
  }
});

test('X comparison renderer rejects changed scope, source, native prices, identities, policy and eligible selection', async () => {
  const f = await fixture();
  try {
    const result = await f.native.call();
    assert.equal(result.success, true);
    const preview = catalogIngestion(f.native.input);
    for (const mutate of [
      o => (o.scope.account_id = 'other'),
      o => (o.source_hash = 'wrong'),
      o => (o.summary.changed = 9),
      o => (o.items[1].product_id = 5000001),
      o => (o.items[1].before.id = 'foreign'),
      o => (o.items[1].changes[0].after = 'edited'),
      o => (o.items[1].blocked = true),
      o => (o.items[2].price_matches = false),
      o => (o.items[2].before.price = 20),
      o => (o.review_retailer_ids = ['sku-2']),
      o => (o.items[3].unknown_fields = ['foreign']),
    ]) {
      const out = structuredClone(result.data);
      mutate(out);
      f.context.args = [out, f.native.input, preview];
      assert.throws(() => f.run('catalogComparisonMarkup(...args)'), /scope or evidence changed/);
    }
  } finally {
    f.native.store.close();
  }
});

test('pending X comparisons and subset saves cannot cross edited forms, destination, route, identity or detached views', async () => {
  for (const phase of ['compare', 'save'])
    for (const reason of ['edit', 'destination', 'route', 'identity', 'detach']) {
      const f = await fixture();
      try {
        const evidence = await f.native.call();
        assert.equal(evidence.success, true);
        if (phase === 'save') await f.bindings.get('#compare-catalog-products')();
        let release;
        f.respond(
          () =>
            new Promise(resolve => {
              release = resolve;
            }),
        );
        const pending = f.bindings.get(phase === 'compare' ? '#compare-catalog-products' : '#save-catalog-changes')();
        await new Promise(resolve => setImmediate(resolve));
        if (reason === 'edit') f.form.events.get('input')();
        if (reason === 'destination') {
          f.form.elements.target.value = '0';
          f.form.elements.target.events.get('change')();
        }
        if (reason === 'route') f.context.navigationGeneration++;
        if (reason === 'identity') f.context.identityGeneration++;
        if (reason === 'detach') f.node('#catalog-preview').isConnected = false;
        const previous = f.node('#catalog-comparison').innerHTML;
        release(phase === 'compare' ? evidence.data : {id: 'old-X-subset'});
        await pending;
        assert.equal(f.node('#catalog-comparison').innerHTML, previous, phase + ':' + reason);
        assert.equal(f.visits.length, 0, phase + ':' + reason);
      } finally {
        f.native.store.close();
      }
    }
});
