import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {catalogServer} from './fixtures/catalog-server.mjs';

/**
 * COM-03 Phase 3 on the Commerce page. Before, the website refused a CSV of more than 50 products ("Import at most 50
 * products in each reviewed plan"), so a larger store had to be split by hand into unrelated plans. A CSV of 51–500
 * products is now validated by AMCP part by part and saved as one plan group of unapproved plans of at most 50, in
 * English and Arabic; the website confirms the group against the source it sent before offering to save it, and every
 * saved part says which part of which import it is.
 */
const plain = value => JSON.parse(JSON.stringify(value));
const canonical = (count, row = i => `SKU-${i},Product ${i},${i}.50,SAR,https://cdn.example.test/${i}.jpg`) =>
  ['retailer_id,name,price,currency,image_url', ...Array.from({length: count}, (_, i) => row(i + 1))].join('\n');
const supplier = count =>
  [
    'SKU,Title,Price,Image,Link,Stock,State,Maker,About,Private',
    ...Array.from(
      {length: count},
      (_, i) =>
        `X-${i + 1},Item ${i + 1},${i + 1}.25,https://shop.example.test/i/${i + 1}.jpg,https://shop.example.test/p/${i + 1},in stock,new,Brand,Plain text ${i + 1},PRIVATE-${i + 1}`,
    ),
  ].join('\n');
const xColumns = {
  retailer_id: 'SKU',
  name: 'Title',
  price: 'Price',
  image_url: 'Image',
  url: 'Link',
  availability: 'Stock',
  condition: 'State',
  brand: 'Maker',
  description: 'About',
};
async function page(t, locale, csv, {gateway = 'meta_native_action', respond} = {}) {
  const ui = accountWorkflowFixture(locale),
    server = catalogServer({tenant: 'catalog-groups-ui-' + locale});
  t.after(() => server.close());
  ui.context.platforms.push(
    {id: 'x', gateway: 'x_ads_native_action', connections: [{id: 'x', enabled: true, accounts: ['acct1']}]},
    {
      id: 'snapchat',
      gateway: 'snapchat_native_action',
      connections: [{id: 'snap', enabled: true, accounts: ['snap-account-1']}],
    },
  );
  const form = ui.node('#catalog-import');
  form.elements.target.value = {meta_native_action: '0', x_ads_native_action: '1', snapchat_native_action: '2'}[
    gateway
  ];
  form.elements.catalog_id.value = gateway === 'snapchat_native_action' ? 'snap-catalog-1' : '9001';
  form.elements.allow_upsert.value = gateway === 'x_ads_native_action' ? 'true' : 'false';
  form.elements.file.files = [{size: Buffer.byteLength(csv), text: async () => csv}];
  ui.respond(respond ? args => respond(args, server) : server.respond);
  await ui.run('renderCommerce()');
  return {ui, server, form, runs: () => server.store.documents(server.actor.tenantId, 'campaign_run')};
}

test('a canonical CSV of 120 products previews and saves three unapproved plans in one group, in English and Arabic', async t => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const {ui, form, runs} = await page(t, locale, canonical(120));
    await ui.bindings.get('#catalog-import')(form);
    assert.deepEqual(
      ui.calls.map(c => c.action),
      ['catalog_preview'],
    );
    const sent = ui.calls[0];
    assert.equal(sent.products, undefined, 'the whole CSV is the group source; no product list is sent');
    assert.deepEqual(sent.requirements, {
      source: {kind: 'csv', text: canonical(120), columns: 'canonical'},
      chunked: true,
    });
    const html = ui.node('#catalog-preview').innerHTML;
    assert.match(html, locale === 'ar' ? /أجزاء مجموعة الخطط/ : /120 products in 3 plans of at most 50/);
    for (const id of ['SKU-1', 'SKU-50', 'SKU-51', 'SKU-100', 'SKU-101', 'SKU-120']) assert.match(html, new RegExp(id));
    assert.match(html, /id="create-catalog-plan-group"/);
    assert.doesNotMatch(html, /id="compare-catalog-products"|id="create-catalog-plan"/);
    assert.match(html, /scope="col"/);
    assert.match(html, /tabindex="0"/);
    assert.equal(ui.node('#catalog-plan-group-heading').focused, true);
    assert.equal(runs().length, 0, 'the preview saved nothing');
    await ui.bindings.get('#create-catalog-plan-group')();
    assert.deepEqual(
      ui.calls.map(c => c.action),
      ['catalog_preview', 'catalog_plan'],
    );
    assert.deepEqual(ui.calls[1].requirements, sent.requirements);
    const saved = runs();
    assert.equal(saved.length, 3);
    assert.ok(saved.every(run => run.state === 'draft' && run.catalog_lineage.lineage_group.parts === 3));
    const done = ui.node('#catalog-preview').innerHTML;
    assert.equal((done.match(/href="\/campaigns\?id=/g) ?? []).length, 3);
    assert.match(done, locale === 'ar' ? /الجزء 1 من 3/ : /Part 1 of 3: 50 products/);
    assert.equal(ui.node('#catalog-plan-group-saved-heading').focused, true);
    assert.equal(ui.visits.length, 0);
    transcripts.push(ui.calls);
  }
  assert.deepEqual(transcripts[0], transcripts[1], 'both languages send the same requests');
});

test('a mapped X export of 80 products saves its mapping, sends only the selected columns and saves two plans', async t => {
  const {ui, form, runs} = await page(t, 'en', supplier(80), {gateway: 'x_ads_native_action'});
  form.elements.column_mode.value = 'mapped';
  form.elements.fixed_currency.value = 'SAR';
  await ui.bindings.get('#catalog-load-columns')();
  for (const [field, column] of Object.entries(xColumns)) ui.node('#catalog-map-' + field).value = column;
  await ui.bindings.get('#catalog-import')(form);
  assert.deepEqual(
    ui.calls.map(c => c.action),
    ['catalog_mapping', 'save_catalog_mapping', 'catalog_preview'],
  );
  const preview = ui.calls[2];
  assert.equal(preview.requirements.chunked, true);
  assert.equal(preview.requirements.source.columns, 'profile');
  assert.equal(preview.requirements.source.profile_version, 1);
  assert.doesNotMatch(JSON.stringify(ui.calls), /PRIVATE-|Private/, 'unselected columns never leave the browser');
  assert.match(ui.node('#catalog-preview').innerHTML, /80 products in 2 plans of at most 50/);
  await ui.bindings.get('#create-catalog-plan-group')();
  const saved = runs();
  assert.equal(saved.length, 2);
  assert.deepEqual(
    saved.map(run => run.steps.length).sort((a, b) => b - a),
    [50, 30],
  );
  for (const run of saved) {
    assert.equal(run.catalog_lineage.mapping_profile_version, 1);
    assert.equal(run.catalog_lineage.columns, 'profile');
    assert.ok(run.steps.every(s => s.arguments.action === 'x_product_catalogs_product_catalog_id_products_put'));
  }
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE-/);
});

test('a CSV of at most 50 products keeps the single-plan preview, and Snapchat refuses more than 50 before any request', async t => {
  const single = await page(t, 'en', canonical(50));
  await single.ui.bindings.get('#catalog-import')(single.form);
  assert.equal(single.ui.calls[0].products.length, 50);
  assert.equal(single.ui.calls[0].requirements, undefined);
  assert.match(single.ui.node('#catalog-preview').innerHTML, /id="compare-catalog-products"/);
  for (const locale of ['en', 'ar']) {
    const snap = await page(t, locale, canonical(60), {gateway: 'snapchat_native_action'});
    await assert.rejects(
      () => snap.ui.bindings.get('#catalog-import')(snap.form),
      locale === 'ar' ? /قارن 50 منتجًا من Snapchat/ : /Compare at most 50 Snapchat products at a time/,
    );
    assert.equal(snap.ui.calls.length, 0);
  }
  const tooMany = await page(t, 'en', canonical(501));
  await assert.rejects(() => tooMany.ui.bindings.get('#catalog-import')(tooMany.form), /192 KiB and 500 products/);
  assert.equal(tooMany.ui.calls.length, 0);
});

test('a group preview or saved group that does not match the source is refused, and nothing is offered or shown', async t => {
  for (const tamper of [
    out => (out.item_count = 119),
    out => (out.parts = 2),
    out => out.plans.pop(),
    out => (out.plans[1].item_count = 51),
    out => (out.source.columns = 'profile'),
    out => (out.destructive_deletions = 1),
    out => (out.record_kind = 'catalog_preview'),
  ]) {
    const {ui, form, runs} = await page(t, 'en', canonical(120), {
      respond: async (args, server) => {
        const out = await server.respond(args);
        tamper(out);
        return out;
      },
    });
    await assert.rejects(() => ui.bindings.get('#catalog-import')(form), /plan group could not be confirmed/);
    assert.equal(ui.node('#catalog-preview').innerHTML, '');
    assert.equal(ui.bindings.has('#create-catalog-plan-group'), false);
    assert.equal(runs().length, 0);
  }
  const {ui, form} = await page(t, 'en', canonical(120), {
    respond: async (args, server) => {
      const out = await server.respond(args);
      if (args.action === 'catalog_plan') out.lineage_group_id = 'other';
      return out;
    },
  });
  await ui.bindings.get('#catalog-import')(form);
  await assert.rejects(
    () => ui.bindings.get('#create-catalog-plan-group')(),
    /saved plan group could not be confirmed. Open Campaigns/,
  );
});

test('a pending group preview or save cannot cross an edited form, route, identity or detached view', async t => {
  for (const phase of ['preview', 'save'])
    for (const reason of ['edit', 'route', 'identity', 'detach']) {
      const {ui, form, server} = await page(t, 'en', canonical(120));
      if (phase === 'save') await ui.bindings.get('#catalog-import')(form);
      let release;
      ui.respond(
        args =>
          new Promise(resolve => {
            release = () => resolve(server.respond(args));
          }),
      );
      const pending =
        phase === 'save' ? ui.bindings.get('#create-catalog-plan-group')() : ui.bindings.get('#catalog-import')(form);
      await new Promise(resolve => setImmediate(resolve));
      if (reason === 'edit') form.events.get('input')();
      if (reason === 'route') ui.context.navigationGeneration++;
      if (reason === 'identity') ui.context.identityGeneration++;
      if (reason === 'detach') ui.node('#catalog-preview').isConnected = false;
      const before = ui.node('#catalog-preview').innerHTML;
      release();
      await pending;
      assert.equal(ui.node('#catalog-preview').innerHTML, before, phase + ':' + reason);
      assert.equal(ui.visits.length, 0);
    }
});

test('a saved part says which part of which product import it is, in English and Arabic, and shows its lineage', async t => {
  const server = catalogServer({tenant: 'catalog-groups-journal'});
  t.after(() => server.close());
  const group = await server.respond({
    action: 'catalog_plan',
    gateway: 'meta_native_action',
    account_id: '001',
    connection_id: 'meta-login',
    catalog_id: '9001',
    allow_upsert: false,
    name: 'Store import',
    requirements: {source: {kind: 'csv', text: canonical(120), columns: 'canonical'}, chunked: true},
  });
  const run = plain(
    (await server.service.call('amcp_campaign', {action: 'get', id: group.plans[1].id, detail: 'full'}, server.actor))
      .data,
  );
  const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  for (const locale of ['en', 'ar']) {
    const context = createContext({
      catalog,
      Intl,
      Date,
      URLSearchParams,
      location: {search: ''},
      document: {addEventListener() {}, querySelector: () => null, querySelectorAll: () => []},
      esc: value =>
        String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;'),
      date: String,
      session: {id: 'operator', workspaceRole: 'operator'},
      navigationGeneration: 1,
      identityGeneration: 1,
    });
    const load = source => new Script(source).runInContext(context);
    load(readFileSync('web/localization.js', 'utf8'));
    load(
      `uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`,
    );
    load(readFileSync('web/workspace.js', 'utf8'));
    load(readFileSync('web/campaign-workflows.js', 'utf8'));
    context.run = run;
    const html = load('campaignJournal(run)');
    assert.match(
      html,
      locale === 'ar'
        ? /هذه الخطة هي الجزء 2 من 3 من استيراد منتجات واحد يضم 120 منتجًا/
        : /This plan is part 2 of 3 of one product import of 120 products/,
    );
    assert.match(html, /catalog_lineage/);
    assert.match(html, new RegExp(group.lineage_group_id));
  }
});
