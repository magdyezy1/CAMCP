import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {catalogDestinations, catalogSourceFields} from '../dist/src/catalog-destinations.js';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';

/**
 * COM-03: the catalog destination contract (src/catalog-destinations.ts) is the one statement of what each destination
 * takes and how it accepts product changes, and every consumer must agree with it. Before, X was a copy of the Meta
 * path with its own field lists in the server and in the website, so a parity fix had to be made in each copy and the
 * copies drifted (sale prices, unsent fields, handoffs). This holds each destination's projection to its declared item
 * identity, source fields, upsert intent, removal intent and per-item steps, and the website to the same contract, so a
 * destination added or changed in one place cannot silently disagree with another.
 */
const scope = {
  meta_native_action: {account_id: '123', connection_id: 'm', catalog_id: '555'},
  x_ads_native_action: {account_id: 'acct1', connection_id: 'x', catalog_id: '9001'},
  snapchat_native_action: {account_id: 'snap-account-1', connection_id: 's', catalog_id: 'snap-catalog-1'},
};
const values = {
  retailer_id: 'SKU-1',
  name: 'Trail shoe',
  price: '12.50',
  currency: 'SAR',
  image_url: 'https://cdn.example.test/1.jpg',
  url: 'https://shop.example.test/p/1',
  availability: 'in stock',
  condition: 'new',
  brand: 'Brand',
  description: 'Plain text description',
  retailer_product_group_id: 'GROUP-1',
  sale_price: '10.00',
  sale_price_start_date: '2026-11-01T00:00:00+03:00',
  sale_price_end_date: '2026-11-08T00:00:00+03:00',
};
const productOf = (fields, extra = {}) => ({...Object.fromEntries(fields.map(k => [k, values[k]])), ...extra});
const preview = (d, products, extra = {}) =>
  catalogIngestion({
    action: 'catalog_preview',
    gateway: d.gateway,
    ...scope[d.gateway],
    products,
    ...(d.upsert === 'none' ? {} : {allow_upsert: true}),
    ...extra,
  });

test('every destination projection follows its contract: source fields, identity, upsert and removal intent, per-item steps', () => {
  for (const d of Object.values(catalogDestinations)) {
    const required = d.sourceFields.required,
      all = catalogSourceFields(d),
      two = [productOf(required), productOf(required, {retailer_id: 'SKU-2'})];
    // Source fields: every required field is required, every optional field is accepted, and nothing else.
    for (const field of required) {
      const {[field]: _omitted, ...missing} = productOf(required);
      assert.throws(() => preview(d, [missing]), Error, d.gateway + ' requires ' + field);
    }
    const full = preview(d, [productOf(all)]);
    assert.equal(full.item_count, 1, d.gateway + ' accepts every declared optional field');
    assert.throws(() => preview(d, [productOf(required, {colour: 'Red'})]), Error, d.gateway + ' refuses other fields');
    // Item identity: the source retailer_id names each product, once.
    assert.throws(() => preview(d, [productOf(required), productOf(required)]), /unique/, d.gateway);
    // Upsert intent.
    if (d.upsert === 'explicit_choice') {
      assert.throws(() => preview(d, two, {allow_upsert: undefined}), /Explicitly choose/, d.gateway);
      assert.equal(preview(d, two, {allow_upsert: false}).item_count, 2);
    }
    if (d.upsert === 'required') assert.throws(() => preview(d, two, {allow_upsert: false}), /upsert/, d.gateway);
    const out = preview(d, two);
    assert.deepEqual(
      out.items.map(i => i.retailer_id),
      ['SKU-1', 'SKU-2'],
    );
    assert.equal(out.destructive_deletions, 0, d.gateway + ' never deletes on import');
    // How changes reach the destination: one reviewed native write per product, or feeds only (nothing to save).
    if (d.writes === 'reviewed_steps') {
      assert.equal(out.plan.steps.length, 2, d.gateway);
      for (const [i, step] of out.plan.steps.entries()) {
        assert.equal(step.gateway, d.gateway);
        assert.equal(step.kind, 'write');
        assert.deepEqual(step.depends_on, []);
        assert.doesNotMatch(step.arguments.action, /delete/i, d.gateway + ' imports never delete');
        const payload = step.arguments.payload,
          id = d.gateway === 'x_ads_native_action' ? payload.products[0].id : payload.retailer_id;
        assert.equal(id, two[i].retailer_id, d.gateway + ' one step per product, in source order');
      }
    } else {
      assert.equal(d.writes, 'feed_only');
      assert.equal(out.plan, null, d.gateway + ' saves nothing');
      assert.equal(out.writes, 'feed_only');
    }
    // Removal intent: a retirement of supplied products where the contract has one, refused where it has none.
    const retire = {requirements: {retire_retailer_ids: ['SKU-1'], retire_availability: 'discontinued'}};
    if (d.removal === 'none') assert.throws(() => preview(d, two, retire), Error, d.gateway + ' retires nothing');
    else {
      const retired = preview(d, two, retire);
      assert.equal(retired.items[0].retire_availability, 'discontinued');
      assert.equal(retired.destructive_deletions, 0, d.gateway + ' retires without deleting');
    }
    assert.equal(d.itemSchemaVersion, 'catalog-comparison-item-v2');
  }
});

test('the website offers each destination exactly the contract: its fields, identity, upsert, removal and feed rules', () => {
  const context = createContext({uiText: (s, vars = {}) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k]), URL});
  new Script(readFileSync('web/account-workflows.js', 'utf8')).runInContext(context);
  const run = (fn, ...args) => {
    context.args = args;
    return new Script(`${fn}(...args)`).runInContext(context);
  };
  for (const d of Object.values(catalogDestinations)) {
    const web = run('catalogWebDestination', d.gateway);
    assert.deepEqual(
      [...run('catalogSourceFields', d.gateway)].sort(),
      catalogSourceFields(d).sort(),
      d.gateway + ' source fields',
    );
    assert.equal(web.productId.source, d.identity.pattern.source, d.gateway + ' native product identity');
    assert.equal(web.upsertRequired, d.upsert === 'required', d.gateway + ' upsert intent');
    assert.equal(web.feedOnly, d.writes === 'feed_only', d.gateway + ' feed-only changes');
    assert.equal(web.destinationOnly, d.destinationOnlyValues, d.gateway + ' destination-only values (P9)');
    assert.equal(web.retire, d.removal !== 'none', d.gateway + ' retirement');
    assert.equal(web.removal, d.removal === 'retire_and_selected_deletion', d.gateway + ' explicit deletion');
    // A mapping needs a column for exactly the contract's required fields (a currency may be one fixed code).
    const headers = catalogSourceFields(d),
      table = {headers, rows: [Object.fromEntries(headers.map(h => [h, values[h]]))]},
      required = d.sourceFields.required.filter(k => k !== 'currency'),
      settings = columns => ({gateway: d.gateway, columns, fixed_currency: 'SAR', image_mode: 'single'}),
      columns = Object.fromEntries(required.map(k => [k, k]));
    assert.match(run('selectedCatalogSource', table, settings(columns)).text, /SKU-1/);
    for (const field of required)
      assert.throws(
        () => run('selectedCatalogSource', table, settings({...columns, [field]: ''})),
        /Select a source column/,
        d.gateway + ' mapping requires ' + field,
      );
  }
});
