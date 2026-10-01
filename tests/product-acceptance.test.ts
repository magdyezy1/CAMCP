import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {Compiler} from '../src/compiler.js';
import {assertMetaCatalogProduct} from '../src/meta-catalog-products.js';
import {portfolioPage} from '../src/portfolio.js';
import {catalogIngestion} from '../src/catalog-ingestion.js';
import {reportPack} from '../src/report-packs.js';
import {reportScenarios} from '../src/report-scenarios.js';
import {ReportCollectionBudget} from '../src/report-collection-budget.js';
import type {Actor, JsonObject} from '../src/types.js';
const actor: Actor = {tenantId: 'product-acceptance', userId: 'owner', role: 'admin'};
test('portfolio pages use exact bound keyset continuation and reject duplicates, changed scope and wrong parents', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64'));
  try {
    store.putConnection(
      actor,
      {
        id: 'google',
        tenantId: actor.tenantId,
        gateway: 'google_ads_native_action',
        accounts: ['123', '456'],
        enabled: true,
        label: 'Synthetic',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    let duplicate = false,
      calls = 0;
    const call = async (_g: string, args: JsonObject) => {
      calls++;
      const next = args.payload.query.includes('campaign.id > 2');
      return {
        success: true,
        data: {
          data: {
            results: (duplicate ? ['1', '1'] : next ? ['3'] : ['1', '2', '3']).map(id => ({
              campaign: {id, name: 'Campaign ' + id, status: 'PAUSED'},
              customer: {currencyCode: 'USD', timeZone: 'UTC'},
              campaignBudget: {amountMicros: '10000000'},
            })),
          },
        },
      };
    };
    const args = {
      gateway: 'google_ads_native_action',
      account_id: '123',
      connection_id: 'google',
      requirements: {entity: 'campaign'},
      limit: 2,
    };
    const first = await portfolioPage(store, call, actor, args);
    assert.deepEqual(
      first.rows.map(r => r.id),
      ['1', '2'],
    );
    assert.equal(first.has_more, true);
    const second = await portfolioPage(store, call, actor, {...args, cursor: first.next_cursor});
    assert.deepEqual(
      second.rows.map(r => r.id),
      ['3'],
    );
    assert.equal(second.has_more, false);
    await assert.rejects(
      () => portfolioPage(store, call, actor, {...args, account_id: '456', cursor: first.next_cursor}),
      {code: 'INVALID_CURSOR'},
    );
    assert.equal(calls, 2);
    duplicate = true;
    await assert.rejects(() => portfolioPage(store, call, actor, args), {code: 'PORTFOLIO_INVALID_RESPONSE'});
    await assert.rejects(() => portfolioPage(store, call, actor, {...args, requirements: {entity: 'ad'}}));
  } finally {
    store.close();
  }
});
test('catalog imports compile to the qualified single-product contract with exact cents and explicit upsert', () => {
  const product = {
    retailer_id: 'sku-1',
    name: 'Product one',
    price: '19.99',
    currency: 'USD',
    image_url: 'https://example.com/image.jpg',
    url: 'https://example.com/item',
  };
  const input = {
    gateway: 'meta_native_action',
    catalog_id: '555',
    account_id: '123',
    connection_id: 'meta',
    allow_upsert: false,
    products: [product],
  };
  const out = catalogIngestion(input),
    step = out.plan.steps[0]!;
  assert.equal(step.arguments.payload.price, 1999);
  assert.equal(step.arguments.payload.allow_upsert, false);
  assert.equal(out.destructive_deletions, 0);
  const native = new Compiler(new Registry()).compile(
    'meta_native_action',
    {...step.arguments, account_id: '123'},
    {mode: 'strict', flags: {}},
  );
  assertMetaCatalogProduct(native);
  assert.ok(native.path.endsWith('/555/products'));
  for (const products of [
    [product, product],
    [{...product, price: '1.001'}],
    [{...product, image_url: 'http://example.com/img'}],
    [{...product, access_token: 'private'}],
  ])
    assert.throws(() => catalogIngestion({...input, products}));
  assert.equal(
    catalogIngestion({...input, products: [{...product, price: '0.01'}], allow_upsert: true}).plan.steps[0]!.arguments
      .payload.price,
    1,
  );
});
test('client report packs preserve separate summaries and scenarios retain provenance without execution instructions', () => {
  const report = {
    id: 'snapshot',
    config: {name: 'Client report', date_range: {since: '2026-09-01', until: '2026-09-07'}, grain: 'weekly'},
    state: 'partial',
    completed_at: Date.now(),
    rows: [{id: 1}, {id: 2}],
    summary: [
      {currency: 'USD', metrics: {spend: 20}},
      {currency: 'SAR', metrics: {spend: 30}},
    ],
    sources: [],
  };
  const pack = reportPack(report);
  assert.equal(pack.summary.length, 2);
  assert.equal(pack.row_count, 2);
  assert.equal(pack.state, 'partial');
  assert.equal(pack.network_requests, 0);
  assert.ok(pack.source_hash);
  assert.throws(() => reportPack({...report, state: 'running'}));
  const scenario = reportScenarios(
    {
      id: 'evidence',
      source_hash: 'original',
      captured_at: Date.now(),
      totals: {spend: '100', conversions: '10'},
      semantics: {currency: 'USD', complete: true},
    },
    {budgets: ['50', '200'], efficiency_low: 0.8, efficiency_high: 1.2},
  );
  assert.equal(scenario.scenarios[0]!.modeled_conversions_low, 4);
  assert.equal(scenario.scenarios[1]!.modeled_conversions_high, 24);
  assert.equal(scenario.advertising_writes, 0);
  assert.equal(scenario.source_hash, 'original');
  assert.throws(
    () =>
      reportScenarios(
        {totals: {spend: null, conversions: 10}},
        {budgets: ['10'], efficiency_low: 1, efficiency_high: 2},
      ),
    {code: 'SCENARIO_EVIDENCE_REQUIRED'},
  );
});
test('collection yields between saved periods without refunding whole-job counters', () => {
  let now = 0,
    state: JsonObject = {};
  const budget = new ReportCollectionBudget(
    undefined,
    'definition',
    v => {
      state = v;
    },
    undefined,
    () => now,
  );
  budget.nextPeriod();
  budget.request(30000);
  budget.rows('period-1', 2);
  now = 20001;
  assert.throws(() => budget.nextPeriod(), {code: 'REPORT_COLLECTION_YIELD'});
  budget.close();
  assert.equal(state.rows, 2);
  assert.equal(state.requests, 1);
  const resumed = new ReportCollectionBudget(
    state,
    'definition',
    v => {
      state = v;
    },
    undefined,
    () => now,
  );
  resumed.nextPeriod();
  assert.equal(state.elapsed_ms, 20001);
  resumed.close();
});
