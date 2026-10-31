import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {isProviderModule, providerRegistries, runtimeGraph} from '../tools/architecture-map.mjs';
import {providerById} from '../dist/src/provider-adapters.js';
import {portfolioAdapters} from '../dist/src/portfolio.js';
import {reconcilePortfolio} from '../dist/src/portfolio-reconciliation.js';
import {linkedAdStep, linkedPlanAdIds, linkedPerformanceSupported} from '../dist/src/creative-performance.js';
import {AdPreviews} from '../dist/src/ad-previews.js';

/**
 * ARC-01 (reporting, wave 4c round 6): the reporting package's shared modules (the allocation plan and its outcome,
 * the ad previews, the workbook projections, the portfolio comparison, linked-ad performance, the search overlap and
 * exclusions, the Overview's detail parents and levels, and the Overview itself) take each provider's gateway, budget
 * draft, selectors, parent reads, attribution windows and Sheets destination from the provider registries and the
 * providers' own modules. Each test pins what the shared table answered before it moved.
 */
const gatewayLiteral = /['"]([a-z0-9]+(?:_[a-z0-9]+)*)_native_action['"]/g;
const reportingPackage = {
  'src/portfolio-reconciliation.ts': {literals: 0, imports: 0},
  'src/creative-performance.ts': {literals: 0, imports: 0},
  'src/search-overlap.ts': {literals: 0, imports: 0},
  'src/search-exclusion-plan.ts': {literals: 0, imports: 0},
  'src/ad-previews.ts': {literals: 0, imports: 0},
  'src/workbook-repository.ts': {literals: 0, imports: 0},
};

test('the reporting package’s shared modules name no gateway and import no provider module but through a registry', () => {
  const graph = runtimeGraph(process.cwd());
  for (const [id, expected] of Object.entries(reportingPackage)) {
    assert.equal(isProviderModule(id), false, id);
    const literals = [...fs.readFileSync(id, 'utf8').matchAll(gatewayLiteral)].filter(m => m[1] !== 'amcp').length,
      imports = [...graph.get(id)].filter(to => isProviderModule(to) && !providerRegistries.includes(to)).length;
    assert.deepEqual({literals, imports}, expected, id);
  }
});

test('the portfolio comparison qualifies the portfolio adapters’ gateways, the seven its table listed', async () => {
  const listed = [
    'google_ads_native_action',
    'meta_native_action',
    'linkedin_native_action',
    'snapchat_native_action',
    'tiktok_native_action',
    'x_ads_native_action',
    'microsoft_ads_native_action',
  ];
  assert.deepEqual(
    portfolioAdapters.map(adapter => adapter.gateway),
    listed,
  );
  const refusal = async gateway => {
    try {
      await reconcilePortfolio(undefined, undefined, undefined, {action: 'reconcile_portfolio', gateway, limit: 0});
    } catch (e) {
      return e.code;
    }
    return 'none';
  };
  // A qualified provider passes the provider check and is refused only by the bounds that follow it.
  for (const gateway of listed) assert.equal(await refusal(gateway), 'INVALID_ARGUMENT', gateway);
  for (const gateway of [
    'dv360_native_action',
    'reddit_native_action',
    'apple_ads_native_action',
    'ga4_native_action',
    'amcp_native_action',
    'google_ads',
    undefined,
    1,
  ])
    assert.equal(await refusal(gateway), 'PORTFOLIO_UNQUALIFIED', String(gateway));
});

test('the search overlap and exclusions read under the Google Ads and Search Console adapters’ gateways', () => {
  // src/search-overlap.ts and src/search-exclusion-plan.ts named these two gateways.
  assert.equal(providerById('google').gateway, 'google_ads_native_action');
  assert.equal(providerById('gsc').gateway, 'google_search_console_native_action');
});

test('linked-ad performance joins the steps of the gateways and creation actions its table named', () => {
  const steps = {
    meta_native_action: ['meta_ad_create', 'meta_ad_account_id_ads_create'],
    google_ads_native_action: ['google_ads_v23_ad_group_ad_mutate_ad_group_ads'],
    snapchat_native_action: ['snapchat_ad_create'],
    tiktok_native_action: ['tiktok_ad_create'],
    linkedin_native_action: ['linkedin_rest_ad_accounts_ad_account_id_creatives_post'],
  };
  const actions = Object.values(steps).flat();
  for (const [gateway, own] of Object.entries(steps))
    for (const action of actions) assert.equal(linkedAdStep(gateway, action), own.includes(action), gateway + action);
  for (const gateway of ['x_ads_native_action', 'reddit_native_action', 'microsoft_ads_native_action', undefined])
    for (const action of actions) assert.equal(linkedAdStep(gateway, action), false, String(gateway) + action);
  assert.deepEqual(
    ['meta', 'google_ads', 'snapchat', 'tiktok', 'linkedin', 'google', 'x_ads', 'reddit', 'constructor'].map(
      linkedPerformanceSupported,
    ),
    [true, true, true, true, true, false, false, false, false],
  );
  // A plan's ad steps count only under the asset platform's gateway, connection and account.
  const asset = {platform: 'tiktok', account_id: '7', connection_id: 'c'},
    step = gateway => ({entity_type: 'ad', gateway, connection_id: 'c', account_id: '7', resource_ids: ['42']});
  assert.deepEqual(linkedPlanAdIds(asset, [step('tiktok_native_action')]), ['42']);
  assert.deepEqual(linkedPlanAdIds(asset, [step('meta_native_action'), step('snapchat_native_action')]), []);
  assert.deepEqual(
    linkedPlanAdIds({platform: 'google_ads', account_id: '123-456-7890', connection_id: 'c'}, [
      {
        ...step('google_ads_native_action'),
        account_id: '1234567890',
        resource_ids: ['customers/1234567890/adGroupAds/1~2'],
      },
    ]),
    ['customers/1234567890/adGroupAds/1~2'],
  );
});

test('the ad previews read each platform under the gateway its switch named, and Google’s write is prepared under its own', async () => {
  const responses = {
    meta_ad_list: {data: [{id: '1', name: 'Ad'}]},
    meta_ad_id_previews_get: {data: [{body: '<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=1">'}]},
    tiktok_ad_list: {data: {list: [{ad_id: '1', ad_name: 'Ad'}]}},
    tiktok_ad_preview: {data: {preview_link: 'https://ads.tiktok.com/hc/preview/1'}},
    snapchat_creative_list: {creatives: [{creative: {id: 'c1', name: 'Creative'}}]},
    snapchat_creatives_creative_id_creative_preview_get: {snap_preview_link: 'https://www.snapchat.com/preview/1'},
    linkedin_rest_ad_accounts_ad_account_id_creatives_get: {elements: [{id: 'urn:li:sponsoredCreative:1', name: 'C'}]},
    linkedin_rest_ad_previews_get: {elements: [{preview: '<iframe src="https://www.linkedin.com/embed/1">'}]},
    LIST_ADS: {
      data: [{id: 'a1', name: 'Ad', preview_url: 'https://www.reddit.com/preview/1', preview_expiry: '2999-01-01'}],
    },
  };
  const reads = [],
    previews = new AdPreviews(async (tool, input) => {
      const action = input.action ?? input.arguments?.action;
      reads.push([tool, action]);
      return {success: true, data: {data: responses[action]}};
    }),
    actor = {tenantId: 't', userId: 'u', role: 'reader'};
  const expected = {
    meta: [
      ['meta_native_action', 'meta_ad_list'],
      ['meta_native_action', 'meta_ad_id_previews_get'],
    ],
    tiktok: [
      ['tiktok_native_action', 'tiktok_ad_list'],
      ['tiktok_native_action', 'tiktok_ad_preview'],
    ],
    snapchat: [
      ['snapchat_native_action', 'snapchat_creative_list'],
      ['snapchat_native_action', 'snapchat_creatives_creative_id_creative_preview_get'],
    ],
    linkedin: [
      ['linkedin_native_action', 'linkedin_rest_ad_accounts_ad_account_id_creatives_get'],
      ['linkedin_native_action', 'linkedin_rest_ad_previews_get'],
    ],
    reddit: [['reddit_native_action', 'LIST_ADS']],
  };
  for (const [platform, calls] of Object.entries(expected)) {
    reads.length = 0;
    const result = await previews.handle({platform, account_id: '7'}, actor);
    assert.deepEqual(reads, calls, platform);
    assert.equal(result.previews.length, 1, platform);
    assert.equal(result.previews[0].links.length, 1, platform);
  }
  reads.length = 0;
  const google = await previews.handle({platform: 'google_ads', account_id: '123-456-7890', ad_ids: ['9']}, actor);
  assert.deepEqual(reads, []);
  assert.equal(google.next_call.tool, 'amcp_write');
  assert.equal(google.next_call.arguments.gateway, 'google_ads_native_action');
  assert.deepEqual(google.next_call.arguments.arguments.payload.operation.shareablePreviews, [
    {assetGroup: 'customers/1234567890/assetGroups/9', previewType: 'UI_PREVIEW'},
  ]);
  await assert.rejects(
    previews.handle({platform: 'pinterest', account_id: '7'}, actor),
    e => e.code === 'INVALID_ARGUMENT' && e.message === 'Choose a platform from the schema.',
  );
});
