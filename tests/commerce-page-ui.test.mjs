import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {catalogComparisonInput} from './fixtures/catalog-comparison-data.mjs';
import {xCatalogComparisonFixture} from './fixtures/x-catalog-comparison.mjs';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';

/**
 * COM-01 on the Commerce page. Each test names the defect it guards against:
 * A. the Meta comparison said "All supplied fields have matching evidence" and named no destination-only values;
 * B. the website handoff matched only Meta targets, so an accessible X scope read "no longer available";
 * C. "Save all" gave no sign that some supplied products already match;
 * E. the page opened with two parked WooCommerce panels before the reviewed import, and never said why Snapchat
 *    is absent.
 */
const withX = f =>
  f.context.platforms.push({
    id: 'x',
    gateway: 'x_ads_native_action',
    connections: [{id: 'x', enabled: true, accounts: ['acct1']}],
  });

test('E: with only a Meta connection the reviewed import is the first section and parked store panels are collapsed (regression: WooCommerce first)', async () => {
  for (const locale of ['en', 'ar']) {
    const f = accountWorkflowFixture(locale);
    f.context.session.workspaceRole = 'owner';
    await f.run('renderCommerce()');
    const html = f.node('content').innerHTML;
    assert.match(html, /^<section class="panel workspace-form"><h2>[^<]+<\/h2>/);
    assert.ok(html.indexOf('id="catalog-import"') < html.indexOf('id="woo-source"'), 'the import comes first');
    const details = /<details class="panel" id="commerce-store-sources"><summary>([^<]+)<\/summary>/.exec(html);
    assert.ok(details, 'parked store sources sit in one collapsed disclosure');
    assert.equal(details[1], locale === 'ar' ? 'ربط مصدر متجر (للمسؤولين)' : 'Connect a store source (administrators)');
    assert.ok(html.indexOf('id="commerce-store-sources"') < html.indexOf('id="woo-connections"'));
    assert.ok(html.indexOf('id="commerce-store-sources"') < html.indexOf('id="woo-inventory"'));
    // COM-02 D: Snapchat products are now compared read-only, so the note says so instead of only "managed through feeds".
    assert.match(
      html,
      locale === 'ar'
        ? /يدعم استيراد المنتجات Meta وX\. أما كتالوجات Snapchat فلا تتغير إلا عبر الخلاصات؛ ويقارن AMCP منتجاتها للقراءة فقط\./
        : /Product imports support Meta and X\. Snapchat catalogs change only through feeds; AMCP compares their products read-only\./,
    );
    assert.doesNotMatch(html, /id="catalog-no-destination"/, 'a Meta account is connected');
    // The empty-source note comes before the disabled form it explains.
    const notice = html.indexOf(
      locale === 'ar' ? 'لم يُضبط مصدر WooCommerce مؤهل' : 'No qualified WooCommerce source is configured',
    );
    assert.ok(notice > html.indexOf('id="commerce-store-sources"') && notice < html.indexOf('id="woo-source"'));
    assert.equal(f.calls.length, 0);
  }
});

test('E: a configured store keeps its panels open after the import; no destination says how to add one', async () => {
  const f = accountWorkflowFixture();
  f.context.commerceSources = [{label: 'Store', store_origin: 'https://store.example.test', connection_id: 'wc'}];
  await f.run('renderCommerce()');
  const html = f.node('content').innerHTML;
  assert.doesNotMatch(html, /id="commerce-store-sources"/);
  assert.ok(html.indexOf('id="catalog-import"') < html.indexOf('id="woo-source"'));
  const none = accountWorkflowFixture('ar');
  none.context.platforms = none.context.platforms.filter(p => !['meta', 'x'].includes(p.id));
  await none.run('renderCommerce()');
  const empty = none.node('content').innerHTML;
  assert.match(empty, /id="catalog-no-destination"/);
  assert.match(empty, /اربط حساب إعلانات Meta أو X لاستيراد المنتجات\./);
  assert.match(empty, /href="\/connections"/);
});

test('B: an X comparison handoff preselects its X account and catalog; old Meta links are unchanged; a mismatched gateway selects nothing (regression: Meta-only handoff)', async () => {
  const open = async (search, locale = 'en') => {
    const f = accountWorkflowFixture(locale);
    withX(f);
    f.context.location.search = search;
    await f.run('renderCommerce()');
    assert.equal(f.calls.length, 0, 'a handoff never starts a read');
    return {
      target: f.node('catalog-import:target').value,
      catalog: f.node('catalog-import:catalog_id').value,
      notice: f.node('#catalog-preview').innerHTML,
    };
  };
  const x = await open(
    '?catalog_comparison=1&gateway=x_ads_native_action&connection_id=x&account_id=acct1&catalog_id=9001',
  );
  assert.equal(x.target, '1', 'the X account option');
  assert.equal(x.catalog, '9001');
  assert.match(x.notice, /The original account and catalog are selected/);
  assert.doesNotMatch(x.notice, /no longer available/);
  const meta = await open('?catalog_comparison=1&connection_id=meta-login&account_id=001&catalog_id=555');
  assert.deepEqual([meta.target, meta.catalog], ['0', '555'], 'a link without a gateway is a Meta comparison');
  const explicitMeta = await open(
    '?catalog_comparison=1&gateway=meta_native_action&connection_id=meta-login&account_id=001&catalog_id=555',
  );
  assert.equal(explicitMeta.target, '0');
  for (const search of [
    // The gateway names X but the account and login are Meta's.
    '?catalog_comparison=1&gateway=x_ads_native_action&connection_id=meta-login&account_id=001&catalog_id=555',
    // The account is X's but the link says Meta (or nothing, which means Meta).
    '?catalog_comparison=1&gateway=meta_native_action&connection_id=x&account_id=acct1&catalog_id=9001',
    '?catalog_comparison=1&connection_id=x&account_id=acct1&catalog_id=9001',
    // Unknown or repeated gateways and an X catalog ID beyond X's 25 digits.
    '?catalog_comparison=1&gateway=snapchat_native_action&connection_id=x&account_id=acct1&catalog_id=9001',
    '?catalog_comparison=1&gateway=x_ads_native_action&gateway=x_ads_native_action&connection_id=x&account_id=acct1&catalog_id=9001',
    '?catalog_comparison=1&gateway=x_ads_native_action&connection_id=x&account_id=acct1&catalog_id=' + '9'.repeat(26),
  ]) {
    const refused = await open(search, 'ar');
    assert.equal(refused.target, '', search);
    assert.equal(refused.catalog, '0001', 'the catalog field keeps its prior value: ' + search);
    assert.match(refused.notice, /\p{Script=Arabic}/u);
  }
});

async function metaComparison(locale, mutate) {
  const f = accountWorkflowFixture(locale),
    products = structuredClone(catalogComparisonInput.products);
  const source =
    'retailer_id,name,price,currency,image_url\n' +
    products.map(p => [p.retailer_id, p.name, p.price, p.currency, p.image_url].join(',')).join('\n');
  f.node('catalog-import:file').files = [{size: source.length, text: async () => source}];
  f.node('catalog-import:allow_upsert').value = 'true';
  const preview = {
    source_hash: 'full-source-hash',
    meaning: 'Preview',
    items: products.map(p => ({retailer_id: p.retailer_id, price_minor_units: Math.round(Number(p.price) * 100)})),
  };
  const evidence = {
    record_kind: 'catalog_comparison',
    complete: true,
    source_hash: preview.source_hash,
    scope: {gateway: 'meta_native_action', account_id: '001', connection_id: 'meta-login', catalog_id: '0001'},
    captured_at: 1,
    item_count: 4,
    summary: {
      new: 1,
      changed: 1,
      matching: 1,
      unknown: 1,
      blocked: 0,
      needs_review: 3,
      with_destination_only_values: 1,
    },
    review_retailer_ids: ['001', '002', '004'],
    items: products.map((p, i) => ({
      retailer_id: p.retailer_id,
      product_id: i ? String(9007199254740993n + BigInt(i)) : null,
      state: ['new', 'changed', 'matching', 'unknown'][i],
      blocked: false,
      price_matches: i ? true : null,
      before: i ? {present: true, id: String(9007199254740993n + BigInt(i)), price: 'SAR' + p.price} : {present: false},
      changes: i === 1 ? [{field: 'name', before: 'Previous', after: p.name}] : [],
      unknown_fields: i === 3 ? ['image_url'] : [],
      // Owner decision P9: destination-only values put an otherwise matching Meta product in review as unknown, so the
      // note sits on the changed product here and the matching one still counts as matching for "Save all".
      unsent_fields: i === 1 ? ['visibility', 'inventory', 'sale_price'] : [],
    })),
  };
  mutate?.(evidence);
  f.respond(args => (args.action === 'catalog_compare' ? evidence : preview));
  await f.run('renderCommerce()');
  await f.bindings.get('#catalog-import')(f.node('#catalog-import'));
  return {...f, evidence};
}

test('A and C: a Meta comparison notes destination-only values in both languages and Save all counts matching products (regression: silent destination values)', async () => {
  for (const locale of ['en', 'ar']) {
    const f = await metaComparison(locale);
    await f.bindings.get('#compare-catalog-products')();
    const html = f.node('#catalog-comparison').innerHTML;
    assert.match(
      html,
      locale === 'ar'
        ? /سمات أصلية أخرى لها قيم: visibility, inventory, sale_price\. لا تثبت Meta أن التحديث يحافظ على السمات غير المرسلة\./
        : /Other native attributes have values: visibility, inventory, sale_price\. Meta does not establish whether an update preserves omitted attributes\./,
    );
    assert.equal(html.match(/Other native attributes|سمات أصلية أخرى/g).length, 1, 'only the product holding them');
    assert.equal(
      f.node('#create-catalog-plan').textContent,
      locale === 'ar'
        ? 'حفظ جميع المنتجات المرسلة وعددها 4 (1 مطابقة بالفعل)'
        : 'Save all 4 supplied products (1 already match)',
    );
    assert.match(
      f.node('#create-catalog-plan-note').textContent,
      locale === 'ar'
        ? /تُراجَع منتجات Meta المطابقة بالفعل/
        : /Meta products that already match are reviewed and sent again/,
    );
  }
});

test('A: the website refuses destination-only names it does not know, names the source sent, or counts that disagree; an older server without them still renders', async () => {
  for (const mutate of [
    e => (e.items[1].unsent_fields = ['PRIVATE_UNUSED']),
    e => (e.items[1].unsent_fields = ['name']),
    e => (e.items[1].unsent_fields = ['inventory', 'inventory']),
    e => (e.items[1].unsent_fields = 'inventory'),
    e => (e.items[0].unsent_fields = ['inventory']),
    e => (e.summary.with_destination_only_values = 0),
    // P9: a Meta product holding values the source does not send cannot read as matching.
    e => {
      e.items[2].unsent_fields = ['inventory'];
      e.summary.with_destination_only_values = 2;
    },
  ]) {
    const f = await metaComparison('en', mutate);
    await assert.rejects(f.bindings.get('#compare-catalog-products')(), /changed|Read|again/i, mutate.toString());
    assert.doesNotMatch(f.node('#catalog-comparison').innerHTML, /Other native attributes/);
  }
  const older = await metaComparison('en', e => {
    delete e.summary.with_destination_only_values;
    for (const item of e.items) delete item.unsent_fields;
  });
  await older.bindings.get('#compare-catalog-products')();
  assert.match(older.node('#catalog-comparison').innerHTML, /Compare current catalog products/);
  assert.doesNotMatch(older.node('#catalog-comparison').innerHTML, /Other native attributes/);
});

test('C: after an X comparison Save all counts matching products, and the saved plan records them as unchanged without sending them', async () => {
  for (const locale of ['en', 'ar']) {
    const native = xCatalogComparisonFixture({writable: true, tenant: 'synthetic-x-save-all-' + locale});
    const ui = accountWorkflowFixture(locale);
    withX(ui);
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
    try {
      await ui.run('renderCommerce()');
      await ui.bindings.get('#catalog-import')(form);
      await ui.bindings.get('#compare-catalog-products')();
      // sku-4 is new, sku-1 changed, sku-2 and sku-3 already hold every supplied value.
      assert.equal(
        ui.node('#create-catalog-plan').textContent,
        locale === 'ar'
          ? 'حفظ جميع المنتجات المرسلة وعددها 4 (2 مطابقة بالفعل)'
          : 'Save all 4 supplied products (2 already match)',
      );
      assert.match(
        ui.node('#create-catalog-plan-note').textContent,
        locale === 'ar' ? /دون تغيير، ولا يُرسل لها شيء/ : /recorded as unchanged; nothing is sent for them/,
      );
      await ui.bindings.get('#create-catalog-plan')();
      const [plan] = native.store.documents(native.actor.tenantId, 'campaign_run');
      assert.equal(plan.steps.length, 4, 'Save all still saves every supplied product');
      const campaign = args => native.service.call('amcp_campaign', args, native.actor);
      let next = await campaign({action: 'prepare_next', id: plan.id});
      const reviewed = [];
      while (next.success && next.data.review) {
        reviewed.push(next.data.step_id);
        const done = await campaign({
          action: 'execute_next',
          id: plan.id,
          review_id: next.data.review.review_id,
          idempotency_key: next.data.review.idempotency_key,
          confirmed: true,
        });
        assert.equal(done.success, true, JSON.stringify(done).slice(0, 800));
        if (done.data.state === 'complete') break;
        next = await campaign({action: 'prepare_next', id: plan.id});
      }
      const full = (await campaign({action: 'get', id: plan.id, detail: 'full'})).data;
      assert.deepEqual(reviewed, ['product-1', 'product-2']);
      assert.equal(full.state, 'complete');
      assert.deepEqual(
        full.steps.map(s => s.status),
        ['verified', 'verified', 'skipped_unchanged', 'skipped_unchanged'],
      );
      assert.equal(native.writes(), 2, 'the two matching products were never sent');
    } finally {
      native.store.close();
    }
  }
});

test('the skipped_unchanged plan status reads as settled in both languages', () => {
  const source = readFileSync('web/workspace.js', 'utf8');
  const labels = /const statusLabels = \{[\s\S]*?\n\};/.exec(source)?.[0];
  assert.ok(labels);
  const context = createContext({});
  new Script(labels.replace('const statusLabels', 'globalThis.statusLabels')).runInContext(context);
  assert.equal(context.statusLabels.skipped_unchanged, 'Unchanged, not sent');
  const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  assert.equal(catalog['Unchanged, not sent'], 'دون تغيير، لم يُرسل');
  assert.match(source, /\['verified', 'verified_with_acceptance', 'skipped_unchanged', 'complete'/);
});
