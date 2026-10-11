// CMP-07: a reviewed Performance Max build. Google requires a non-retail asset group and the links to its minimum
// assets in the same mutate request, which the all-or-nothing build provides. A synthetic customer answers every read
// and the one mutate; nothing reaches Google. A build with a missing or excess minimum is refused before any request,
// an existing asset of the wrong type is refused after the review reads it, and the campaign stays PAUSED.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {pmaxAssetRequirements} from '../dist/src/google-pmax-build.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const google = 'google_ads_native_action',
  actor = {tenantId: 'pmax', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
const camel = k => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const snakeKeys = v =>
  Array.isArray(v)
    ? v.map(snakeKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k.replace(/[A-Z]/g, c => '_' + c.toLowerCase()), snakeKeys(x)]),
        )
      : v;
const resultKey = {
  campaign_budget_operation: 'campaignBudgetResult',
  campaign_operation: 'campaignResult',
  campaign_criterion_operation: 'campaignCriterionResult',
  asset_operation: 'assetResult',
  asset_group_operation: 'assetGroupResult',
  asset_group_asset_operation: 'assetGroupAssetResult',
  asset_group_signal_operation: 'assetGroupSignalResult',
};
const collection = {
  campaign_budget_operation: 'campaignBudgets',
  campaign_operation: 'campaigns',
  campaign_criterion_operation: 'campaignCriteria',
  asset_operation: 'assets',
  asset_group_operation: 'assetGroups',
  asset_group_asset_operation: 'assetGroupAssets',
  asset_group_signal_operation: 'assetGroupSignals',
};
/** Existing account assets: two images, a logo and a text asset that is not an image. */
const existing = {
  'customers/123/assets/501': 'IMAGE',
  'customers/123/assets/502': 'IMAGE',
  'customers/123/assets/503': 'IMAGE',
  'customers/123/assets/504': 'TEXT',
};
function setup() {
  const store = new Store(':memory:', Buffer.alloc(32, 59).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'g',
      tenantId: actor.tenantId,
      gateway: google,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const created = new Map(),
    mutates = [],
    queries = [];
  let next = 100;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (url, init) => {
        const body = snakeKeys(JSON.parse(String(init?.body))),
          path = new URL(String(url)).pathname;
        if (path.endsWith('googleAds:search')) {
          const q = String(body.query);
          queries.push(q);
          if (/ FROM customer /.test(q + ' '))
            return Response.json({results: [{customer: {id: '123', currencyCode: 'USD', timeZone: 'UTC'}}]});
          const from = / FROM ([a-z_]+)/.exec(q)[1],
            names = [...q.matchAll(/'(customers\/[^']+)'/g)].map(m => m[1]);
          if (from === 'asset' && !names.some(n => created.has(n)))
            return Response.json({
              results: names.filter(n => existing[n]).map(n => ({asset: {resourceName: n, type: existing[n]}})),
            });
          return Response.json({
            results: names
              .filter(n => created.has(n))
              .map(n => ({
                [camel(from)]: {
                  ...created.get(n),
                  ...(from === 'asset_group' ? {primaryStatus: 'PAUSED', adStrength: 'PENDING'} : {}),
                },
              })),
          });
        }
        assert.ok(path.endsWith('/googleAds:mutate'), path);
        mutates.push(body);
        const names = new Map(),
          real = v =>
            typeof v === 'string' && names.has(v)
              ? names.get(v)
              : Array.isArray(v)
                ? v.map(real)
                : v && typeof v === 'object'
                  ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, real(x)]))
                  : v;
        return Response.json({
          mutateOperationResponses: body.mutate_operations.map(op => {
            const key = Object.keys(op)[0],
              {resource_name: temp, ...record} = op[key].create,
              kind = collection[key],
              id = String(next++),
              resolved = real(record),
              name =
                key === 'asset_group_asset_operation'
                  ? `customers/123/assetGroupAssets/${resolved.asset_group.split('/').at(-1)}~${resolved.asset.split('/').at(-1)}~${resolved.field_type}`
                  : key === 'asset_group_signal_operation'
                    ? `customers/123/assetGroupSignals/${resolved.asset_group.split('/').at(-1)}~${id}`
                    : key === 'campaign_criterion_operation'
                      ? `customers/123/campaignCriteria/${resolved.campaign.split('/').at(-1)}~${id}`
                      : `customers/123/${kind}/${id}`;
            if (temp) names.set(temp, name);
            created.set(name, {resourceName: name, ...resolved});
            return {[resultKey[key]]: {resourceName: name}};
          }),
        });
      },
      undefined,
      undefined,
      undefined,
      10000,
    ),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = (tool, input) => service.call(tool, input, actor);
  const prepare = operations =>
    call('amcp_write', {
      action: 'prepare',
      gateway: google,
      arguments: {
        action: 'google_ads_v23_google_ads_mutate',
        account_id: '123',
        payload: {mutate_operations: operations},
      },
    });
  const execute = review =>
    call('amcp_write', {
      action: 'execute',
      review_id: review.data.review_id,
      confirmed: true,
      spend_change_confirmed: true,
    });
  return {store, created, mutates, queries, call, prepare, execute};
}
const text = (n, value) => ({
  asset_operation: {create: {resource_name: 'customers/123/assets/-' + n, text_asset: {text: value}}},
});
const link = (asset, field_type, group = 'customers/123/assetGroups/-20') => ({
  asset_group_asset_operation: {create: {asset_group: group, asset, field_type}},
});
function pmax({
  headlines = ['Acme', 'Acme widgets', 'Buy Acme'],
  longHeadlines = ['Widgets for every workshop'],
  descriptions = ['Widgets for all.', 'Fast delivery.'],
  images = ['customers/123/assets/501'],
  squares = ['customers/123/assets/502'],
  logos = ['customers/123/assets/503'],
  campaign = {},
  group = {},
} = {}) {
  const texts = [
    ...headlines.map(t => ['HEADLINE', t]),
    ...longHeadlines.map(t => ['LONG_HEADLINE', t]),
    ...descriptions.map(t => ['DESCRIPTION', t]),
    ['BUSINESS_NAME', 'Acme'],
  ];
  return [
    {
      campaign_budget_operation: {
        create: {
          resource_name: 'customers/123/campaignBudgets/-1',
          name: 'PMax budget',
          amount_micros: '50000000',
          delivery_method: 'STANDARD',
          explicitly_shared: false,
        },
      },
    },
    {
      campaign_operation: {
        create: {
          resource_name: 'customers/123/campaigns/-2',
          name: 'PMax',
          status: 'PAUSED',
          advertising_channel_type: 'PERFORMANCE_MAX',
          campaign_budget: 'customers/123/campaignBudgets/-1',
          maximize_conversions: {},
          brand_guidelines_enabled: false,
          contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
          ...campaign,
        },
      },
    },
    {
      campaign_criterion_operation: {
        create: {campaign: 'customers/123/campaigns/-2', location: {geo_target_constant: 'geoTargetConstants/2682'}},
      },
    },
    ...texts.map(([, t], i) => text(100 + i, t)),
    {
      asset_group_operation: {
        create: {
          resource_name: 'customers/123/assetGroups/-20',
          name: 'All products',
          campaign: 'customers/123/campaigns/-2',
          final_urls: ['https://example.test/'],
          status: 'ENABLED',
          ...group,
        },
      },
    },
    ...texts.map(([type], i) => link('customers/123/assets/-' + (100 + i), type)),
    ...images.map(a => link(a, 'MARKETING_IMAGE')),
    ...squares.map(a => link(a, 'SQUARE_MARKETING_IMAGE')),
    ...logos.map(a => link(a, 'LOGO')),
    {
      asset_group_signal_operation: {
        create: {asset_group: 'customers/123/assetGroups/-20', search_theme: {text: 'workshop widgets'}},
      },
    },
  ];
}

test('the pinned asset requirements are the reviewed fixture, field by field', () => {
  const fixture = JSON.parse(readFileSync('tests/fixtures/google-pmax-asset-requirements.json', 'utf8'));
  assert.deepEqual(pmaxAssetRequirements.fields, fixture.fields);
  assert.deepEqual(pmaxAssetRequirements.combined, fixture.combined);
  assert.equal(pmaxAssetRequirements.source, fixture.source);
});

test('a whole Performance Max build is one review, one request and one read-back; the campaign stays PAUSED', async t => {
  const x = setup();
  t.after(() => x.store.close());
  const review = await x.prepare(pmax());
  assert.equal(review.success, true, JSON.stringify(review).slice(0, 1500));
  assert.equal(x.mutates.length, 0);
  const impact = JSON.stringify(review.data);
  assert.match(impact, /"all_or_nothing":true/);
  assert.match(impact, /"asset_groups":\[\{"name":"All products"/);
  assert.match(impact, /"HEADLINE":3/);
  assert.ok(
    x.queries.some(q => q.startsWith('SELECT asset.resource_name, asset.type FROM asset WHERE')),
    'the existing images and logo are read before sending',
  );
  assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
  const done = await x.execute(review);
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 1500));
  assert.equal(x.mutates.length, 1, 'one request');
  const sent = x.mutates[0].mutate_operations;
  assert.equal(sent.find(o => o.campaign_operation).campaign_operation.create.status, 'PAUSED');
  assert.equal(sent.filter(o => o.asset_group_asset_operation).length, 10);
  const verified = await x.call('amcp_campaign', {action: 'verify', review_id: review.data.review_id});
  assert.equal(verified.success, true, JSON.stringify(verified).slice(0, 1500));
  assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data).slice(0, 2000));
  assert.equal(verified.data.checks.length, sent.length);
  assert.ok(
    x.queries.some(q => /asset_group\.primary_status, asset_group\.ad_strength FROM asset_group WHERE/.test(q)),
    'the asset group is read back with Google’s status and ad strength',
  );
});

test('a missing or excess minimum, or an over-long text, is refused before any request', async t => {
  const x = setup();
  t.after(() => x.store.close());
  for (const [options, check] of [
    [{headlines: ['Acme', 'Buy Acme']}, d => d.outside_range.some(r => r.field_type === 'HEADLINE' && r.found === 2)],
    [{logos: []}, d => d.outside_range.some(r => r.field_type === 'LOGO' && r.found === 0)],
    [{descriptions: ['Only one.']}, d => d.outside_range.some(r => r.field_type === 'DESCRIPTION')],
    [{longHeadlines: []}, d => d.outside_range.some(r => r.field_type === 'LONG_HEADLINE')],
    [
      {images: Array.from({length: 21}, (_, i) => 'customers/123/assets/' + (600 + i))},
      d => d.outside_range.some(r => r.field_type === 'MARKETING_IMAGE' && r.found === 21),
    ],
    [{headlines: ['Acme', 'Acme widgets', 'A headline far longer than thirty characters']}, d => d.max_length === 30],
  ]) {
    const r = await x.prepare(pmax(options));
    assertRefused(r, 'PMAX_ASSET_MINIMUMS');
    assert.ok(check(r.error.details), JSON.stringify(r.error.details));
  }
  assert.equal(x.queries.length, 0, 'no reads');
  assert.equal(x.mutates.length, 0, 'no request');
});

test('an existing asset of another type, or one the account does not return, is refused after the review reads it', async t => {
  const x = setup();
  t.after(() => x.store.close());
  const wrong = await x.prepare(pmax({images: ['customers/123/assets/504']}));
  assertRefused(wrong, 'PMAX_ASSET_TYPE_MISMATCH');
  assert.equal(wrong.error.details.asset, 'customers/123/assets/504');
  assert.equal(wrong.error.details.actual_type, 'TEXT');
  // An asset the account does not return fails the exact state read itself.
  assertRefused(await x.prepare(pmax({images: ['customers/123/assets/999']})), 'STATE_TARGET_MISMATCH');
  assert.equal(x.mutates.length, 0);
});

test('builds outside the Performance Max contract are refused before any request, naming the operation', async t => {
  const x = setup();
  t.after(() => x.store.close());
  const base = pmax();
  const cases = [
    [pmax({campaign: {brand_guidelines_enabled: true}}), /brand_guidelines_enabled: false/],
    [
      pmax({campaign: {advertising_channel_type: 'SEARCH', manual_cpc: {}, maximize_conversions: undefined}}),
      /PERFORMANCE_MAX/,
    ],
    [pmax({group: {final_urls: ['http://example.test/']}}), /final_urls/],
    [pmax({group: {campaign: 'customers/123/campaigns/77'}}), /Performance Max campaign the same build creates/],
    [
      [...base, link('customers/123/assets/501', 'MARKETING_IMAGE', 'customers/123/assetGroups/55')],
      /name an asset group the same build creates/,
    ],
    [
      [...base, {asset_operation: {create: {resource_name: 'customers/123/assets/-90', image_asset: {data: 'AA=='}}}}],
      /text assets only/,
    ],
    [[...base, link('customers/123/assets/501', 'AD_IMAGE')], /field types/],
    [[...base, link('customers/123/assets/501', 'MARKETING_IMAGE')], /linked twice/],
  ];
  for (const [operations, message] of cases) {
    const r = await x.prepare(operations);
    assertRefused(r, 'INVALID_GOOGLE_BUILD');
    assert.match(r.error.message, message, JSON.stringify(r.error).slice(0, 600));
  }
  assert.equal(x.queries.length, 0, 'no reads');
  assert.equal(x.mutates.length, 0);
});

test('an owner policy that forbids activation refuses the enabled asset group; a paused one passes', async t => {
  const x = setup();
  t.after(() => x.store.close());
  saveSpendPolicy(x.store, admin, {
    confirmed: true,
    gateway: google,
    account_id: '123',
    policy: {enforcement: 'block', allow_activation: false, allow_deletion: false},
  });
  const review = await x.prepare(pmax());
  const refused = review.success ? await x.execute(review) : review;
  assertRefused(refused, 'POLICY_ACTIVATION_FORBIDDEN');
  assert.equal(x.mutates.length, 0);
  const paused = await x.prepare(pmax({group: {status: 'PAUSED'}}));
  assert.equal(paused.success, true, JSON.stringify(paused).slice(0, 800));
});
