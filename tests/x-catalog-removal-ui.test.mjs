import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {xCatalogRemovalFixture} from './fixtures/x-catalog-removal.mjs';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';

async function fixture(t, locale = 'en') {
  const native = xCatalogRemovalFixture(t),
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
  const source = native.input.products,
    quote = v => '"' + v.replaceAll('"', '""') + '"';
  const csv =
    Object.keys(source[0]).join(',') + '\n' + source.map(p => Object.values(p).map(quote).join(',')).join('\n');
  form.elements.file.files = [{size: Buffer.byteLength(csv), text: async () => csv}];
  ui.respond(async args => {
    const result = await native.service.call('amcp_workspace', args, native.actor);
    assert.equal(result.success, true, JSON.stringify(result).slice(0, 1000));
    return result.data;
  });
  await ui.run('renderCommerce()');
  await ui.bindings.get('#catalog-import')(form);
  await ui.bindings.get('#compare-catalog-products')();
  return {...ui, native, form};
}

test('English and Arabic catalog comparisons require explicit unchecked removal selections and save only the displayed unapproved targets', async t => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = await fixture(t, locale),
      html = f.node('#catalog-comparison').innerHTML;
    assert.match(html, /id="preview-catalog-removal"/);
    assert.match(html, /id="catalog-remove-1"/);
    assert.doesNotMatch(html, /type="checkbox"[^>]*\schecked/);
    assert.match(html, locale === 'ar' ? /الإزالات المحددة/ : /removal/);
    f.node('#catalog-remove-1').checked = true;
    f.node('#catalog-remove-2').checked = true;
    await f.bindings.get('#preview-catalog-removal')();
    const preview = f.node('#catalog-removal-preview').innerHTML;
    assert.match(preview, /5000001/);
    assert.match(preview, /5000002/);
    assert.doesNotMatch(preview, /5000003/);
    assert.match(preview, locale === 'ar' ? /دائمة|دائم/ : /permanent/);
    assert.equal(f.node('#catalog-removal-heading').focused, true);
    await f.bindings.get('#save-catalog-removal')();
    const request = f.calls.at(-1);
    assert.equal(request.action, 'create_catalog_removal');
    assert.equal(request.confirmed, true);
    assert.equal(request.products, undefined);
    assert.equal(request.retailer_ids, undefined);
    const run = f.native.store.documents(f.native.actor.tenantId, 'campaign_run')[0];
    assert.equal(run.state, 'draft');
    assert.equal(run.steps.length, 2);
    assert.equal(f.native.store.documents(f.native.actor.tenantId, 'write_review').length, 0);
    assert.equal(f.native.writes(), 0);
    transcripts.push(run.steps.map(s => s.arguments));
  }
  assert.deepEqual(transcripts[0], transcripts[1]);
});

test('removal preview renderer rejects altered scope, selected keys, source and destructive outcomes, and escapes exact provider text', async t => {
  const f = await fixture(t);
  const result = await f.native.preview({retailer_ids: ['sku-1']}),
    comparison = await f.native.call({...f.native.input, action: 'catalog_compare'});
  assert.equal(result.success, true);
  assert.equal(comparison.success, true);
  const preview = catalogIngestion(f.native.input);
  for (const mutate of [
    p => (p.scope.account_id = 'foreign'),
    p => (p.source_hash = 'wrong'),
    p => (p.targets[0].product_id = '5000003'),
    p => (p.targets[0].retailer_id = 'sku-2'),
    p => (p.provider_mutations = 1),
    p => (p.destructive_deletions = 1),
    p => (p.targets[0].before.name = 'Changed after comparison'),
    p => (p.item_count = 2),
  ]) {
    const p = structuredClone(result.data);
    mutate(p);
    f.context.args = [p, f.native.input, comparison.data, ['sku-1'], preview];
    assert.throws(() => f.run('catalogRemovalMarkup(...args)'), /removal preview changed/);
  }
  f.native.items[9001][0].title = '<script>literal provider title</script>';
  const exact = await f.native.preview({retailer_ids: ['sku-1']}),
    latest = await f.native.call({...f.native.input, action: 'catalog_compare'});
  f.context.args = [exact.data, f.native.input, latest.data, ['sku-1'], preview];
  const html = f.run('catalogRemovalMarkup(...args)');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('pending removal previews and saves cannot cross changed selections, forms, scope, route, identity or detached views', async t => {
  for (const phase of ['preview', 'save'])
    for (const reason of ['selection', 'form', 'scope', 'route', 'identity', 'detach']) {
      const f = await fixture(t);
      f.node('#catalog-remove-1').checked = true;
      if (phase === 'save') await f.bindings.get('#preview-catalog-removal')();
      const p = await f.native.preview({retailer_ids: ['sku-1']});
      assert.equal(p.success, true);
      let release;
      f.respond(
        () =>
          new Promise(resolve => {
            release = resolve;
          }),
      );
      const pending = f.bindings.get(phase === 'preview' ? '#preview-catalog-removal' : '#save-catalog-removal')();
      await new Promise(resolve => setImmediate(resolve));
      if (reason === 'selection') {
        f.node('#catalog-remove-1').checked = false;
        f.node('#catalog-remove-1').events.get('change')();
      }
      if (reason === 'form') f.form.events.get('input')();
      if (reason === 'scope') {
        f.form.elements.target.value = '0';
        f.form.elements.target.events.get('change')();
      }
      if (reason === 'route') f.context.navigationGeneration++;
      if (reason === 'identity') f.context.identityGeneration++;
      if (reason === 'detach') f.node('#catalog-preview').isConnected = false;
      const previous = f.node('#catalog-removal-preview').innerHTML;
      release(phase === 'preview' ? p.data : {id: 'original-removal-plan'});
      await pending;
      assert.equal(f.node('#catalog-removal-preview').innerHTML, previous, phase + ':' + reason);
      assert.equal(f.visits.length, 0, phase + ':' + reason);
    }
});
