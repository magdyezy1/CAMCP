import test from 'node:test';
import assert from 'node:assert/strict';
import {MirrorService} from '../dist/src/service.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {NativeTransport} from '../dist/src/transport.js';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';
import {catalogDestinations, comparisonItemV2, comparisonSummary} from '../dist/src/catalog-destinations.js';
import {metaCatalogProductImpact, metaCatalogUnsentFields} from '../dist/src/meta-catalog-products.js';
import {workflowOutcome} from '../dist/src/workflow-outcomes.js';
import {compactPlan} from '../dist/src/campaign-view.js';
import {errorResult, MirrorError} from '../dist/src/errors.js';
import {catalogComparisonData, catalogComparisonInput} from './fixtures/catalog-comparison-data.mjs';
import {setup, product} from './x-catalog-fixture.mjs';

/**
 * COM-01: active Meta/X commerce correctness. Each test names the defect it guards against:
 * A. a Meta comparison hid attributes the destination holds and the source never sends;
 * B. a comparison's website handoff named no gateway, so an X comparison reopened as "no longer available";
 * C. an unchanged X product in a saved plan became a failed step and left the plan in attention;
 * D. Meta refused exact prices with trailing zeros ("12.500 KWD") and gave no reason for real sub-hundredth prices.
 */
const actor = {tenantId: 'commerce-parity', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1800));
  return r.data;
};

function metaComparison(mutate) {
  const store = new Store(':memory:', Buffer.alloc(32, 52).toString('base64')),
    input = structuredClone(catalogComparisonInput),
    data = catalogComparisonData(input);
  mutate?.(data);
  store.putConnection(
    owner,
    {
      id: 'catalog-login',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      enabled: true,
      accounts: ['123'],
      writeAccounts: [],
      scopes: ['ads_read'],
      label: 'Synthetic read-only catalog',
    },
    {accessToken: 'synthetic'},
  );
  const transport = new NativeTransport(
    async (raw, init) => {
      assert.equal(init.method, 'GET', 'comparison must never mutate a provider');
      return Response.json(data.response(raw));
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    200,
  );
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: false,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  return {store, input, call: args => service.call('amcp_workspace', args, actor)};
}

// Owner decision P9 (2026-10-11, docs/DECISIONS.md): a populated Meta attribute the source does not send puts a product
// that otherwise matches in the review set as unknown; the attributes are still named (COM-01 A's unsent_fields).
test('A (P9): a Meta product whose only differences are destination-only sale price, staging visibility and zero inventory enters the review set as unknown (regression: it stayed matching, out of the review set)', async t => {
  const f = metaComparison(data =>
    Object.assign(data.products.get('003'), {sale_price: 'SAR50.00', visibility: 'staging', inventory: 0}),
  );
  t.after(() => f.store.close());
  const out = ok(await f.call(f.input));
  const destinationOnly = out.items[2];
  assert.equal(destinationOnly.state, 'unknown', 'Meta does not say whether an upsert keeps or clears them');
  assert.equal(destinationOnly.blocked, false);
  assert.deepEqual(destinationOnly.changes, []);
  assert.deepEqual(destinationOnly.unknown_fields, [], 'every supplied field matches');
  assert.deepEqual(destinationOnly.unsent_fields, ['visibility', 'inventory', 'sale_price']);
  assert.deepEqual(destinationOnly.serving_notes, ['staging_visibility']);
  assert.deepEqual(out.review_retailer_ids, ['001', '002', '003', '004'], 'it enters the review set');
  assert.equal(out.summary.with_destination_only_values, 1);
  assert.equal(out.summary.matching, 0);
  assert.equal(out.summary.unknown, 2);
  assert.equal(out.summary.needs_review, 4);
  assert.match(out.meaning, /holds values for attributes the source does not send \(unsent_fields\) is unknown too/);
  assert.deepEqual(out.items[0].unsent_fields, [], 'a new product has no destination values');
  assert.deepEqual(out.items[1].unsent_fields, [], 'only fields the source does not send are named');
  // Field names only: the destination values themselves are not repeated in the note.
  assert.doesNotMatch(JSON.stringify(destinationOnly.unsent_fields), /SAR50|staging/);
  // Without destination-only values the same product still matches and stays out of the review set.
  const plainMatch = metaComparison();
  t.after(() => plainMatch.store.close());
  const unchanged = ok(await plainMatch.call(plainMatch.input));
  assert.equal(unchanged.items[2].state, 'matching');
  assert.deepEqual(unchanged.review_retailer_ids, ['001', '002', '004']);
});

test('P9: Meta reviews destination-only values as unknown; X and Snapchat keep them as notes on a matching product', () => {
  assert.equal(catalogDestinations.meta_native_action.destinationOnlyValues, 'review');
  assert.equal(catalogDestinations.x_ads_native_action.destinationOnlyValues, 'note');
  assert.equal(catalogDestinations.snapchat_native_action.destinationOnlyValues, 'note');
  const item = {retailer_id: '003', state: 'matching', changes: [], unknown_fields: [], unsent_fields: ['inventory']},
    supplied = {retailer_id: '003'};
  assert.equal(comparisonItemV2(item, supplied, catalogDestinations.meta_native_action).state, 'unknown');
  assert.equal(comparisonItemV2(item, supplied, catalogDestinations.x_ads_native_action).state, 'matching');
  assert.equal(
    comparisonItemV2({...item, unsent_fields: []}, supplied, catalogDestinations.meta_native_action).state,
    'matching',
  );
  // A changed or blocked product keeps its own state; only a match becomes unknown.
  assert.equal(
    comparisonItemV2({...item, state: 'changed'}, supplied, catalogDestinations.meta_native_action).state,
    'changed',
  );
  const {summary, review_retailer_ids} = comparisonSummary([
    comparisonItemV2(item, supplied, catalogDestinations.meta_native_action),
  ]);
  assert.deepEqual(review_retailer_ids, ['003']);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.with_destination_only_values, 1);
});

test('A: the Meta review of an upsert warns which current values it does not send; a create and a complete source do not', () => {
  const request = body => ({
    gateway: 'meta_native_action',
    accountId: '123',
    action: 'meta_product_catalog_id_products_create',
    method: 'POST',
    path: '/v26.0/555/products',
    query: {},
    headers: {},
    body,
    readOnly: false,
  });
  const sent = {
      retailer_id: '003',
      name: 'Matching shoe',
      price: 0,
      currency: 'SAR',
      image_url: 'https://example.test/match.png',
      allow_upsert: true,
    },
    existing = {
      present: true,
      id: '9007199254740994',
      ...sent,
      allow_upsert: undefined,
      sale_price: 'SAR50.00',
      visibility: 'staging',
      inventory: 0,
      brand: '',
      additional_image_urls: [],
      description: null,
    };
  const impact = metaCatalogProductImpact(request(sent), [{product: existing, catalog: {id: '555'}}]);
  assert.deepEqual(impact.unsent_fields, ['visibility', 'inventory', 'sale_price']);
  assert.ok(
    impact.warnings.includes(
      'Not sent, with a value today: visibility, inventory, sale_price. Meta does not say whether an upsert keeps or clears them.',
    ),
  );
  const created = metaCatalogProductImpact(request(sent), [{product: {present: false}, catalog: {id: '555'}}]);
  assert.equal(created.unsent_fields, undefined);
  assert.equal(created.warnings, undefined);
  assert.deepEqual(
    metaCatalogUnsentFields({...sent, sale_price: 5000, visibility: 'staging', inventory: 0}, existing),
    [],
  );
});

test('B: a comparison handoff names its gateway so an X comparison reopens its X account and catalog (regression: Meta-only handoff)', () => {
  const path = gateway =>
    workflowOutcome('amcp_workspace', {
      record_kind: 'catalog_comparison',
      complete: true,
      scope: {gateway, connection_id: 'x', account_id: 'acct1', catalog_id: '9001'},
    })?.website_path;
  assert.equal(
    path('x_ads_native_action'),
    '/commerce?catalog_comparison=1&gateway=x_ads_native_action&connection_id=x&account_id=acct1&catalog_id=9001',
  );
  assert.match(path('meta_native_action'), /[?&]gateway=meta_native_action&/);
});

test('C: an unchanged X product in a saved plan is recorded as skipped_unchanged with its read evidence, and the plan completes (regression: failed step, attention)', async t => {
  const x = setup({tenant: actor.tenantId});
  t.after(() => x.store.close());
  const source = (i, extra = {}) => ({
    retailer_id: 'sku-' + i,
    name: 'Product ' + i,
    price: '20',
    currency: 'SAR',
    image_url: 'https://shop.example.test/i/' + i + '.jpg',
    url: 'https://shop.example.test/p/' + i,
    availability: 'in stock',
    condition: 'new',
    brand: 'Brand',
    description: 'Synthetic product ' + i,
    ...extra,
  });
  const campaign = args => x.service.call('amcp_campaign', args, x.actor);
  const plan = ok(
    await x.service.call(
      'amcp_workspace',
      {
        action: 'catalog_plan',
        gateway: 'x_ads_native_action',
        connection_id: 'x',
        account_id: 'acct1',
        catalog_id: '9001',
        allow_upsert: true,
        name: 'Unchanged and changed products',
        // sku-1 already holds every value; sku-2 differs by its name; sku-3 differs only by its price.
        products: [source(1), source(2, {name: 'Product 2 renamed'}), source(3, {price: '20.01'})],
      },
      x.actor,
    ),
  );
  // The direct prepare still refuses the no-op, and its refusal carries the read evidence.
  const direct = await x.prepare(
    'x_product_catalogs_product_catalog_id_products_put',
    {
      products: [
        {
          id: 'sku-1',
          title: 'Product 1',
          price: '20 SAR',
          image_link: 'https://shop.example.test/i/1.jpg',
          link: 'https://shop.example.test/p/1',
          availability: 'in stock',
          condition: 'new',
          brand: 'Brand',
          description: 'Synthetic product 1',
        },
      ],
    },
    {product_catalog_id: '9001'},
  );
  assert.equal(direct.error.code, 'INVALID_X_CATALOG_PRODUCT');
  assert.equal(direct.error.details.already_current, true);
  assert.equal(direct.error.details.no_op_evidence.product_id, 'sku-1');
  let next = ok(await campaign({action: 'prepare_next', id: plan.id}));
  assert.equal(next.step_id, 'product-2', 'the unchanged step is passed, not failed');
  const reviewed = [];
  while (next.review) {
    reviewed.push(next.step_id);
    const done = ok(
      await campaign({
        action: 'execute_next',
        id: plan.id,
        review_id: next.review.review_id,
        idempotency_key: next.review.idempotency_key,
        confirmed: true,
      }),
    );
    if (done.state === 'complete') break;
    next = ok(await campaign({action: 'prepare_next', id: plan.id}));
  }
  assert.deepEqual(reviewed, ['product-2', 'product-3'], 'a real difference, even one cent, is never skipped');
  const full = ok(await campaign({action: 'get', id: plan.id, detail: 'full'}));
  assert.equal(full.state, 'complete');
  assert.deepEqual(
    full.steps.map(s => s.status),
    ['skipped_unchanged', 'verified', 'verified'],
  );
  const skipped = full.steps[0];
  assert.equal(skipped.submission, 'not_submitted');
  assert.equal(skipped.error, undefined);
  assert.equal(skipped.review_id, undefined, 'no review or key was created for it');
  assert.equal(skipped.result.already_current, true);
  assert.equal(skipped.result.evidence.product_catalog_id, '9001');
  assert.deepEqual(skipped.result.evidence.compared_fields, [
    'availability',
    'brand',
    'condition',
    'description',
    'id',
    'image_link',
    'link',
    'price',
    'title',
  ]);
  assert.match(skipped.result.evidence.observed_hash, /^[0-9a-f]{64}$/);
  assert.equal(
    x.calls.filter(c => c.method === 'PUT').length,
    2,
    'only the two changed products were sent; the unchanged one never was',
  );
  assert.equal(x.items[9001][0].title, 'Product 1');
});

test('C: other refusals of an X plan step still fail it; only the family no-op evidence skips a step', async t => {
  const x = setup({tenant: actor.tenantId});
  t.after(() => x.store.close());
  x.items[9001][0] = product(1, {item_group_id: 'grp-1'});
  const plan = ok(
    await x.service.call(
      'amcp_workspace',
      {
        action: 'catalog_plan',
        gateway: 'x_ads_native_action',
        connection_id: 'x',
        account_id: 'acct1',
        catalog_id: '9001',
        allow_upsert: true,
        products: [
          {
            retailer_id: 'sku-1',
            name: 'Product 1',
            price: '20',
            currency: 'SAR',
            image_url: 'https://shop.example.test/i/1.jpg',
            url: 'https://shop.example.test/p/1',
            availability: 'in stock',
            condition: 'new',
            brand: 'Brand',
            description: 'Synthetic product 1',
          },
        ],
      },
      x.actor,
    ),
  );
  const out = await x.service.call('amcp_campaign', {action: 'prepare_next', id: plan.id}, x.actor);
  const full = ok(await x.service.call('amcp_campaign', {action: 'get', id: plan.id, detail: 'full'}, x.actor));
  assert.equal(full.steps[0].status, 'failed', JSON.stringify(out).slice(0, 600));
  assert.equal(full.state, 'attention');
  assert.equal(x.writes(), 0);
});

/** A three-product X catalog plan whose first product already holds every value (COM-01). */
async function skippedPlan(x) {
  const source = (i, extra = {}) => ({
    retailer_id: 'sku-' + i,
    name: 'Product ' + i,
    price: '20',
    currency: 'SAR',
    image_url: 'https://shop.example.test/i/' + i + '.jpg',
    url: 'https://shop.example.test/p/' + i,
    availability: 'in stock',
    condition: 'new',
    brand: 'Brand',
    description: 'Synthetic product ' + i,
    ...extra,
  });
  return ok(
    await x.service.call(
      'amcp_workspace',
      {
        action: 'catalog_plan',
        gateway: 'x_ads_native_action',
        connection_id: 'x',
        account_id: 'acct1',
        catalog_id: '9001',
        allow_upsert: true,
        name: 'Unchanged and changed products',
        products: [source(1), source(2, {name: 'Product 2 renamed'}), source(3, {price: '20.01'})],
      },
      x.actor,
    ),
  );
}

test('C: an approver collaborator runs an approved plan past a skipped_unchanged step (regression: FORBIDDEN after the skip)', async t => {
  // Before: the skip prepared the next step without the plan-approval marker, so an approver (who may approve and
  // run, not edit) was refused at the step after the unchanged one.
  const x = setup({tenant: actor.tenantId});
  t.after(() => x.store.close());
  x.store.db
    .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
    .run(actor.tenantId, 'carol', 'operator', Date.now());
  const carol = {tenantId: actor.tenantId, userId: 'carol', role: 'operator'},
    as = who => args => x.service.call('amcp_campaign', args, who),
    owner = as(x.actor),
    approver = as(carol);
  const plan = await skippedPlan(x);
  ok(await owner({action: 'assign', id: plan.id, user_id: 'carol', role: 'approver'}));
  const summary = ok(await approver({action: 'approve', id: plan.id}));
  ok(await approver(summary.next_call.arguments));
  const ran = ok(await approver({action: 'run', id: plan.id}));
  assert.equal(ran.state, 'complete', JSON.stringify(ran).slice(0, 800));
  const full = ok(await owner({action: 'get', id: plan.id, detail: 'full'}));
  assert.deepEqual(
    full.steps.map(step => step.status),
    ['skipped_unchanged', 'verified', 'verified'],
  );
});

test('C: continue_as_new carries a skipped_unchanged step instead of adopting its empty result', async t => {
  const x = setup({tenant: actor.tenantId});
  t.after(() => x.store.close());
  const campaign = args => x.service.call('amcp_campaign', args, x.actor);
  const plan = await skippedPlan(x);
  const next = ok(await campaign({action: 'prepare_next', id: plan.id}));
  assert.equal(next.step_id, 'product-2');
  const continued = ok(await campaign({action: 'continue_as_new', id: plan.id, confirmed: true}));
  const successor = ok(await campaign({action: 'get', id: continued.id ?? continued.continued_as, detail: 'full'}));
  const ids = successor.steps.map(step => step.id);
  assert.ok(ids.includes('product-1'), 'the unchanged step is carried and checked again: ' + ids.join(', '));
  assert.ok(
    !JSON.stringify(successor.steps).includes('"adopted_from"') ||
      successor.steps.every(step => !JSON.stringify(step.adopted_from ?? []).includes('product-1')),
    'nothing is adopted from the skipped step',
  );
});

test('C: compact plan views keep skipped_unchanged steps apart from verified ones when they collapse', () => {
  const steps = Array.from({length: 60}, (_, i) => ({
    id: 'product-' + (i + 1),
    kind: 'write',
    status: i % 2 ? 'verified' : 'skipped_unchanged',
    verification: {status: 'verified', checks: [{resource_id: 'x'.repeat(150), status: 'verified'}]},
  }));
  const view = compactPlan({id: 'plan', name: 'Large import', revision: 1, state: 'complete', plan_hash: 'h', steps});
  assert.ok(view.verified_steps, 'the large plan collapses');
  assert.equal(view.verified_steps.length, 30);
  assert.equal(view.skipped_unchanged_steps.length, 30);
  assert.ok(!view.verified_steps.some(id => view.skipped_unchanged_steps.includes(id)));
});

test('D: Meta prices are exact values: 12.500 KWD and 0.10 are accepted exactly; 12.345 KWD is refused with its currency named (regression: text-precision refusal)', () => {
  const preview = (price, currency = 'KWD') =>
    catalogIngestion({
      gateway: 'meta_native_action',
      catalog_id: '555',
      account_id: '123',
      connection_id: 'catalog-login',
      allow_upsert: false,
      products: [{retailer_id: '001', name: 'Dates', price, currency, image_url: 'https://example.test/dates.png'}],
    });
  assert.equal(preview('12.500').items[0].price_minor_units, 1250);
  assert.equal(preview('12.5').items[0].price_minor_units, 1250);
  assert.equal(preview('0.10', 'SAR').items[0].price_minor_units, 10);
  assert.equal(preview('7.000000').items[0].price_minor_units, 700);
  assert.equal(preview('12.500').plan.steps[0].arguments.payload.price, 1250);
  let refusal;
  try {
    preview('12.345');
  } catch (error) {
    refusal = error;
  }
  assert.ok(refusal instanceof MirrorError);
  const wire = errorResult(refusal, 'synthetic-request', 1);
  assert.equal(wire.error.code, 'INVALID_ARGUMENT');
  assert.equal(
    wire.error.message,
    'Meta counts prices in hundredths of the currency, so digits after the second decimal place must be zeros; nothing is rounded. This price cannot be represented exactly: 12.345 KWD.',
  );
  // The fixed sentence is translatable; the exact price and currency stay literal after it.
  assert.deepEqual(wire.meta.message_parts, {
    base: 'Meta counts prices in hundredths of the currency, so digits after the second decimal place must be zeros; nothing is rounded. This price cannot be represented exactly.',
    suffix: '12.345 KWD.',
  });
  for (const price of ['12.3450', '0.001', '-1', '1e3', '12.']) assert.throws(() => preview(price), MirrorError, price);
});
