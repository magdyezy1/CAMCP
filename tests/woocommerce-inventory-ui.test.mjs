import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {wooInventoryBrowserFixture, wooInventoryInput} from './fixtures/woocommerce-inventory-data.mjs';
import {offerParkedProviders} from './helpers/parked-providers.mjs';

// WooCommerce is parked (ARC-01, P9): this suite exercises it, so it offers it like a
// deployment whose AMCP_PROVIDERS names it.
offerParkedProviders('woocommerce');

const plain = value => JSON.parse(JSON.stringify(value));
async function fixture(locale = 'en', search = '') {
  const f = accountWorkflowFixture(locale),
    backend = wooInventoryBrowserFixture();
  let evidence;
  try {
    const response = await backend.service.call('amcp_workspace', wooInventoryInput(), backend.actor);
    assert.equal(response.success, true, JSON.stringify(response));
    evidence = plain(response.data);
  } finally {
    backend.close();
  }
  f.context.commerceSources = [
    {
      connection_id: 'woo-login',
      account_id: 'store-1',
      label: 'Original <store>',
      store_origin: 'https://shop.example.test',
    },
  ];
  f.context.location.search = search;
  f.respond(() => plain(evidence));
  await f.run('renderCommerce()');
  return {...f, evidence, form: f.node('#woo-inventory')};
}

test('English and Arabic inventory show exact native rows, local paging/search and full safe evidence without destination actions', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = await fixture(locale);
    assert.equal(f.calls.length, 0);
    assert.match(f.node('content').innerHTML, /aria-describedby="woo-inventory-limits"/);
    await f.bindings.get('#woo-inventory')();
    assert.deepEqual(f.calls, [wooInventoryInput()]);
    const result = f.node('#woo-inventory-result').innerHTML,
      view = f.node('#woo-inventory-view').innerHTML;
    assert.match(result, /9223372036854775807/);
    assert.match(result, /"name":null/);
    assert.match(result, /"selected_price":null/);
    assert.match(view, /999999999999\.000001 SAR/);
    assert.match(view, /&lt;img src=x onerror=&quot;window\.wooInventoryUnsafe=1&quot;&gt;/);
    assert.doesNotMatch(view, /<img/);
    assert.match(view, /scope="col"/);
    assert.match(view, /scope="row"/);
    assert.match(view, /tabindex="0"/);
    assert.match(view, /dir="ltr"/);
    assert.equal((view.match(/<tr>/g) ?? []).length, 51);
    assert.equal(f.node('#woo-inventory-heading').focused, true);
    assert.doesNotMatch(
      result + view,
      /UNUSED-PRIVATE|consumerSecret|synthetickey|syntheticsecret|type="checkbox"|use-woo-products|catalog_plan/,
    );
    assert.match(result, locale === 'ar' ? /نُفّذت|المنتجات الأم المنشورة/ : /collected twice/);
    if (locale === 'ar') assert.doesNotMatch(result, /collected twice/);
    assert.equal(f.node('catalog-import:source_mode').value, 'csv');
    await f.bindings.get('#woo-inventory-next')();
    assert.match(f.node('#woo-inventory-view').innerHTML, /SKU-51/);
    await f.bindings.get('#woo-inventory-next')();
    assert.match(f.node('#woo-inventory-view').innerHTML, /9223372036854775807/);
    assert.match(f.node('#woo-inventory-view').innerHTML, /0008\.34567 SAR/);
    assert.match(f.node('#woo-inventory-view').innerHTML, /private|draft/);
    assert.match(f.node('#woo-inventory-view').innerHTML, /Native &lt;colour&gt;: Blue &amp; white/);
    assert.match(f.node('#woo-inventory-view').innerHTML, locale === 'ar' ? /قيمة أصلية فارغة/ : /Empty native value/);
    f.node('#woo-inventory-search').value = 'SKU-121';
    await f.bindings.get('#woo-inventory-find')();
    assert.equal((f.node('#woo-inventory-view').innerHTML.match(/<tr>/g) ?? []).length, 2);
    assert.match(f.node('#woo-inventory-view').innerHTML, /SKU-121/);
    f.node('#woo-inventory-search').value = '9223372036854775807';
    let prevented = false;
    f.node('#woo-inventory-search').events.get('keydown')({
      key: 'Enter',
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
    assert.equal((f.node('#woo-inventory-view').innerHTML.match(/<tr>/g) ?? []).length, 2);
    f.node('#woo-inventory-search').value = locale === 'ar' ? 'تنويعة أصلية' : 'Native variation';
    await f.bindings.get('#woo-inventory-find')();
    assert.equal((f.node('#woo-inventory-view').innerHTML.match(/<tr>/g) ?? []).length, 4);
    f.node('#woo-inventory-search').value = 'no-such-product';
    await f.bindings.get('#woo-inventory-find')();
    assert.doesNotMatch(f.node('#woo-inventory-view').innerHTML, /<table/);
    assert.match(
      f.node('#woo-inventory-view').innerHTML,
      locale === 'ar' ? /غياب.*المتجر|المنتجات غير المنشورة/ : /whole-store absence/,
    );
    await f.bindings.get('#woo-inventory-clear')();
    assert.equal((f.node('#woo-inventory-view').innerHTML.match(/<tr>/g) ?? []).length, 51);
    assert.equal(f.calls.length, 1, 'Every page, search, clear and keyboard action remains local');
    assert.deepEqual(f.visits, []);
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[0], transcripts[1]);
});

test('inventory rejects wrong scope, mixed memberships, unsupported completeness and malformed page evidence', async t => {
  const mutations = {
    account: out => (out.scope.account_id = 'foreign'),
    login: out => (out.scope.connection_id = 'foreign'),
    origin: out => (out.scope.store_origin = 'https://foreign.example.test'),
    price: out => (out.scope.price_field = 'sale_price'),
    incomplete: out => (out.complete_collected_inventory = false),
    unpublished: out => (out.unpublished_parents_collected = true),
    deletion: out => (out.destructive_deletions = 1),
    saved: out => (out.source_saved = true),
    rows: out => out.item_count--,
    missing: out => out.items.pop(),
    duplicate: out => (out.items[1].product_id = out.items[0].product_id),
    foreign_member: out => (out.items[0].variation_ids[0] = '999'),
    foreign_parent: out => (out.items.at(-1).parent_product_id = '2'),
    parent_name: out => (out.items.at(-1).parent_name = 'Foreign parent'),
    child_name: out => (out.items.at(-1).name = 'Invented child name'),
    child_status: out => (out.items.at(-1).status = 'unknown-new-status'),
    attribute_duplicate: out => out.items.at(-1).attributes.push(out.items.at(-1).attributes[0]),
    null_scan: out => (out.scans[0] = null),
    scan_hash: out => (out.scans[1].source_hash = 'a'.repeat(64)),
    currency: out => (out.currency_evidence[2].value = 'USD'),
    page_total: out => out.scans[0].pages[0].total--,
    page_number: out => (out.scans[0].pages[0].page = 2),
    page_count: out => (out.scans[0].pages[0].count = 99),
    child_page: out => (out.scans[0].pages.at(-1).parent_product_id = '2'),
    requests: out => out.native_requests++,
    meaning: out => (out.meaning = 'Unsupported total store reconciliation claim'),
  };
  for (const [name, mutate] of Object.entries(mutations))
    await t.test(name, async () => {
      const f = await fixture();
      mutate(f.evidence);
      await assert.rejects(() => f.bindings.get('#woo-inventory')(), /scope or completeness changed/);
      assert.equal(f.node('#woo-inventory-result').innerHTML, '');
      assert.equal(f.bindings.has('#woo-inventory-next'), false);
      assert.equal(f.calls.length, 1);
    });
});

test('inventory evidence drops overbroad fields at every projected level', async () => {
  const f = await fixture();
  f.evidence.private = 'UNUSED-PRIVATE';
  f.evidence.scope.token = 'UNUSED-PRIVATE';
  f.evidence.limits.token = 'UNUSED-PRIVATE';
  f.evidence.items[0].description = 'UNUSED-PRIVATE';
  f.evidence.items.at(-1).attributes[0].metadata = 'UNUSED-PRIVATE';
  f.evidence.scans[0].payload = 'UNUSED-PRIVATE';
  f.evidence.scans[0].pages[0].payload = 'UNUSED-PRIVATE';
  f.evidence.currency_evidence[0].payload = 'UNUSED-PRIVATE';
  await f.bindings.get('#woo-inventory')();
  assert.doesNotMatch(f.node('#woo-inventory-result').innerHTML, /UNUSED-PRIVATE/);
});

test('current source and inventory failures preserve original structured reasons, remedies and request references', async () => {
  for (const selector of ['#woo-source', '#woo-inventory'])
    for (const locale of ['en', 'ar']) {
      const f = await fixture(locale),
        form = f.node(selector);
      if (selector === '#woo-source') {
        form.elements.product_ids.value = '101';
        form.elements.price_field.value = 'price';
        form.elements.source_kind.value = 'products';
      }
      const failure = f.run(
        "requestError({error:{code:'WOOCOMMERCE_INVENTORY_CHANGED',message:'WooCommerce inventory or currency changed between complete scans. Read it again; no changes are proposed.',remedy:{action:'Inspect the original work for more details.'}},meta:{requestId:'owned-source-reference'}})",
      );
      f.respond(() => {
        throw failure;
      });
      await assert.rejects(
        () => f.bindings.get(selector)(),
        error =>
          error === failure &&
          error.code === 'WOOCOMMERCE_INVENTORY_CHANGED' &&
          error.requestId === 'owned-source-reference',
      );
      f.context.currentFailure = failure;
      assert.match(f.run('errorMessage(currentFailure)'), /owned-source-reference/);
      assert.match(
        f.run('errorMessage(currentFailure)'),
        locale === 'ar' ? /تغيّر مخزون WooCommerce/ : /changed between complete scans/,
      );
      assert.equal(
        f.node(selector === '\u0023woo-source' ? '#woo-source-result' : '#woo-inventory-result').innerHTML,
        '',
      );
      assert.equal(f.calls.length, 1);
    }
});

test('late inventory success and failure stay silent after edits, navigation, identity, detachment and replacement attempts', async t => {
  for (const failure of [false, true])
    for (const reason of ['edit', 'route', 'identity', 'form-detach', 'result-detach', 'new-attempt'])
      await t.test(`${reason}-${failure}`, async () => {
        const f = await fixture();
        let settle;
        f.respond(
          () =>
            new Promise((resolve, reject) => {
              settle = failure ? () => reject(Error('OBSOLETE-PRIVATE-FAILURE')) : () => resolve(f.evidence);
            }),
        );
        const pending = f.bindings.get('#woo-inventory')();
        await new Promise(resolve => setImmediate(resolve));
        if (reason === 'edit') f.form.events.get('input')();
        if (reason === 'route') f.context.navigationGeneration++;
        if (reason === 'identity') f.context.identityGeneration++;
        if (reason === 'form-detach') f.form.isConnected = false;
        if (reason === 'result-detach') f.node('#woo-inventory-result').isConnected = false;
        if (reason === 'new-attempt') {
          f.respond(() => plain(f.evidence));
          await f.bindings.get('#woo-inventory')();
        }
        const retained = f.node('#woo-inventory-result').innerHTML;
        settle();
        await pending;
        assert.equal(f.node('#woo-inventory-result').innerHTML, retained);
        if (reason !== 'new-attempt') assert.equal(retained, '');
        assert.equal(f.calls.length, reason === 'new-attempt' ? 2 : 1);
      });
});

test('exact inventory handoff preselects only the existing store and price and never performs an automatic read', async () => {
  for (const price of ['price', 'regular_price', 'sale_price']) {
    const f = await fixture('en', '?woo_inventory=1&connection_id=woo-login&account_id=store-1&price_field=' + price);
    assert.equal(f.form.elements.target.value, '0');
    assert.equal(f.form.elements.price_field.value, price);
    assert.equal(f.calls.length, 0);
    assert.equal(f.node('#woo-inventory-result').innerHTML, '');
  }
  for (const query of [
    'connection_id=foreign',
    'connection_id=woo-login&connection_id=woo-login',
    'price_field=unknown',
    'price_field=price&product_ids=101',
    'price_field=price&parent_product_id=101',
    'price_field=price&source_kind=variations',
  ]) {
    const f = accountWorkflowFixture();
    f.context.commerceSources = [
      {connection_id: 'woo-login', account_id: 'store-1', store_origin: 'https://shop.example.test', label: 'Store'},
    ];
    f.context.location.search =
      '?woo_inventory=1&account_id=store-1&' +
      query +
      (query.startsWith('connection_id') ? '&price_field=price' : '&connection_id=woo-login');
    f.node('#woo-inventory').elements.target.value = '';
    f.node('#woo-inventory').elements.price_field.value = '';
    await f.run('renderCommerce()');
    assert.equal(f.node('#woo-inventory').elements.target.value, '');
    assert.equal(f.node('#woo-inventory').elements.price_field.value, '');
    assert.equal(f.calls.length, 0);
  }
});

test('no configured store keeps inventory unavailable and malformed local selections make no service call', async () => {
  const f = accountWorkflowFixture();
  await f.run('renderCommerce()');
  assert.match(f.node('content').innerHTML, /type="submit" disabled>.*Inspect inventory without changes/);
  await assert.rejects(() => f.bindings.get('#woo-inventory')(), /configured store/);
  assert.equal(f.calls.length, 0);
});
