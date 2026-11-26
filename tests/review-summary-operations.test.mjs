import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {reviewSummary} from '../dist/src/review-summary.js';
import {providerHooks} from '../dist/src/provider-hooks.js';
import {compileMicrosoft} from '../dist/src/microsoft-native.js';
import {reviewedWriteRoutes} from './helpers/ledger-write-plans.mjs';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * Round 2.5, package r25-m0-review, T3: the review summary is what the person approving reads, so it must name the
 * real operation. In White Friday a TikTok campaign create read "Update 1 campaign ... operation_status STATUS_ENABLE
 * -> DISABLE": the verb was inferred from a REST path shape (the path ends in its collection), which an RPC route
 * (/v1.3/campaign/create/, the verb is the last segment) never has, and the "from" status was the advertiser's, the
 * first status in the account read. Every case below is synthetic: no client name, account or review ID.
 */
const plan = (gateway, action, method, path, body = {}, accountId = '123') => ({
  gateway,
  action,
  method,
  path,
  query: {},
  body,
  headers: {},
  readOnly: false,
  destructive: method === 'DELETE',
  requiresConfirmation: true,
  accountId,
  evidence: '',
  warnings: [],
});
const tiktok = (action, path, body) => plan('tiktok_native_action', action, 'POST', path, body);
// What a TikTok create reads first: the advertiser, whose own status is not the new object's.
const advertiser = {
  advertiser_id: '123',
  name: 'Synthetic account',
  currency: 'USD',
  timezone: 'UTC',
  status: 'STATUS_ENABLE',
  role: 'ROLE_ADVERTISER',
};
const advertiserRead = [{data: {list: [advertiser]}}];
const live = {operation_status: 'ENABLE'};

// The route styles of a TikTok create, each with the entity the review names for it.
const tiktokCreates = [
  ['campaign', 'tiktok_campaign_create', '/v1.3/campaign/create/', 'campaign'],
  ['ad group', 'tiktok_adgroup_create', '/v1.3/adgroup/create/', 'ad group'],
  ['ad', 'tiktok_ad_create', '/v1.3/ad/create/', 'ad'],
  ['identity', 'tiktok_identity_create', '/v1.3/identity/create/', 'identity'],
  ['pixel', 'tiktok_pixel_create', '/v1.3/pixel/create/', 'pixel'],
  ['Smart+ campaign', 'tiktok_smart_plus_campaign_create', '/v1.3/smart_plus/campaign/create/', 'campaign'],
  ['Smart+ ad group', 'tiktok_smart_plus_adgroup_create', '/v1.3/smart_plus/adgroup/create/', 'ad group'],
  ['Smart+ ad', 'tiktok_smart_plus_ad_create', '/v1.3/smart_plus/ad/create/', 'ad'],
  ['custom audience', 'tiktok_dmp_custom_audience_create', '/v1.3/dmp/custom_audience/create/', 'custom audience'],
  ['custom conversion', 'tiktok_custom_conversion_create', '/v1.3/custom_conversion/create/', 'custom conversion'],
];

test('the White Friday campaign create reads as a create, with no "from" status borrowed from the advertiser', () => {
  const s = reviewSummary(
    tiktok('tiktok_campaign_create', '/v1.3/campaign/create/', {
      advertiser_id: '123',
      campaign_name: 'Synthetic launch',
      objective_type: 'TRAFFIC',
      budget_mode: 'BUDGET_MODE_INFINITE',
      operation_status: 'DISABLE',
    }),
    advertiserRead,
  );
  assert.equal(s.operation, 'create');
  assert.equal(s.entity, 'campaign');
  // r25-approval-fields (B6): the line names the object a create makes, and lists what it sets that a person reads first (money, status, dates).
  assert.equal(
    s.text,
    'Create 1 campaign in account Synthetic account (123): new campaign "Synthetic launch": operation_status DISABLE.',
  );
  assert.deepEqual(s.status, [{field: '/operation_status', to: 'DISABLE'}]);
  // The exact request stays the authority.
  assert.equal(s.authority, 'The exact native request below is what is sent; this line only summarizes it.');
});

test('each TikTok create route style reads "Create 1 …" and no create names a current status', () => {
  for (const [label, action, path, entity] of tiktokCreates) {
    // A hostile before-state: every record the review reads carries a serving status (the advertiser, the parent).
    const state = [...advertiserRead, {data: {list: [{campaign_id: '9', operation_status: 'ENABLE'}]}}];
    const s = reviewSummary(tiktok(action, path, {advertiser_id: '123', ...live}), state);
    assert.deepEqual([s.operation, s.entity, s.count], ['create', entity, 1], label);
    assert.equal(
      s.text,
      'Create 1 ' + entity + ' in account Synthetic account (123): new ' + entity + ': operation_status ENABLE.',
      label,
    );
    assert.deepEqual(s.status, [{field: '/operation_status', to: 'ENABLE'}], label);
    assert.ok(
      s.status.every(entry => !('from' in entry)),
      label + ' must not carry a "from" status: ' + JSON.stringify(s.status),
    );
    assert.doesNotMatch(s.text, / → /, label);
  }
});

test('a create route that carries its verb in a hyphenated or a custom-method segment reads as a create too', () => {
  // Criteo: POST …/accounts/{id}/create-brand-account; Tag Manager: POST …/workspaces/{id}:create_version.
  const brand = reviewSummary(
    plan(
      'criteo_native_action',
      'CREATE_PRIVATE_MARKET_DEMAND_BRAND_ACCOUNT',
      'POST',
      '/2026-07/retail-media/account-management/accounts/123/create-brand-account',
      {name: 'Synthetic brand'},
    ),
    [],
  );
  assert.deepEqual([brand.operation, brand.entity, brand.count], ['create', 'brand account', 1]);
  assert.equal(brand.text, 'Create 1 brand account in account 123: new brand account "Synthetic brand".');
  const version = reviewSummary(
    plan(
      'gtm_native_action',
      'CREATE_CONTAINER_VERSION',
      'POST',
      '/tagmanager/v2/accounts/123/containers/456/workspaces/789:create_version',
      {name: 'Synthetic version'},
    ),
    [],
  );
  assert.deepEqual([version.operation, version.entity, version.count], ['create', 'version', 1]);
  assert.equal(version.text, 'Create 1 version in account 123: new version "Synthetic version".');
});

test('a create on a REST collection and a Google Ads create operation keep reading as creates', () => {
  const state = [
    {adaccounts: [{adaccount: {id: '123', name: 'Synthetic account', currency: 'USD', status: 'ACTIVE'}}]},
  ];
  const squad = reviewSummary(
    plan(
      'snapchat_native_action',
      'snapchat_campaigns_campaign_id_adsquads_create',
      'POST',
      '/v1/campaigns/c1/adsquads',
      {
        adsquads: [{name: 'Synthetic squad', status: 'PAUSED'}],
      },
    ),
    state,
  );
  assert.equal(
    squad.text,
    'Create 1 ad squad in account Synthetic account (123): new ad squad "Synthetic squad": status PAUSED.',
  );
  assert.deepEqual(squad.status, [{field: '/adsquads/0/status', to: 'PAUSED'}]);
  const campaign = reviewSummary(
    plan('meta_native_action', 'meta_campaign_create', 'POST', '/v26.0/act_123/campaigns', {
      name: 'Synthetic campaign',
      status: 'PAUSED',
    }),
    [{id: 'act_123', account_status: 1, currency: 'USD', status: 'ACTIVE'}],
  );
  assert.equal(campaign.text, 'Create 1 campaign in account 123: new campaign "Synthetic campaign": status PAUSED.');
  assert.deepEqual(campaign.status, [{field: '/status', to: 'PAUSED'}]);
  const google = reviewSummary(
    plan(
      'google_ads_native_action',
      'google_ads_v23_campaign_mutate_campaigns',
      'POST',
      '/v23/customers/123/campaigns:mutate',
      {
        operations: [{create: {name: 'Synthetic campaign', status: 'PAUSED'}}],
      },
    ),
    [{results: [{customer: {id: '123', descriptiveName: 'Synthetic account', currencyCode: 'USD'}}]}],
  );
  assert.deepEqual([google.operation, google.entity, google.count], ['create', 'campaign', 1]);
  assert.equal(
    google.text,
    'Create 1 campaign in account Synthetic account (123): new campaign "Synthetic campaign": status PAUSED.',
  );
});

test('a TikTok ad create names the status of its own creative record, not the ad group or the advertiser', () => {
  const s = reviewSummary(
    tiktok('tiktok_ad_create', '/v1.3/ad/create/', {
      advertiser_id: '123',
      adgroup_id: '201',
      creatives: [{ad_name: 'Synthetic ad', operation_status: 'DISABLE'}],
    }),
    [...advertiserRead, {data: {list: [{adgroup_id: '201', operation_status: 'ENABLE'}]}}],
  );
  assert.equal(s.text, 'Create 1 ad in account Synthetic account (123): new ad: creatives.0.operation_status DISABLE.');
  assert.deepEqual(s.status, [{field: '/creatives/0/operation_status', to: 'DISABLE'}]);
});

// S3-2 (the lead's review of this package): a request that creates several entities read "Create 1 ...", which was true of
// no one of them. A TikTok ad create makes one ad for each of its creatives; Snapchat's record lists and LinkedIn's
// BATCH_CREATE make one entity for each element. The count is each provider's fact, read where the provider says it.
test('a TikTok ad create names how many ads it makes, one for each creative, and a Smart+ ad is one ad', () => {
  const three = reviewSummary(
    tiktok('tiktok_ad_create', '/v1.3/ad/create/', {
      advertiser_id: '123',
      adgroup_id: '201',
      creatives: [
        {ad_name: 'Synthetic ad 1', operation_status: 'DISABLE'},
        {ad_name: 'Synthetic ad 2', operation_status: 'DISABLE'},
        {ad_name: 'Synthetic ad 3', operation_status: 'DISABLE'},
      ],
    }),
    advertiserRead,
  );
  assert.deepEqual([three.operation, three.entity, three.count], ['create', 'ad', 3]);
  assert.equal(
    three.text,
    'Create 3 ads in account Synthetic account (123): new ad: creatives.0.operation_status DISABLE, creatives.1.operation_status DISABLE, creatives.2.operation_status DISABLE.',
  );
  // One creative, no list, an empty list and a list that is not one are each a single ad, as before.
  for (const creatives of [[{ad_name: 'Synthetic ad'}], [], 'none', undefined])
    assert.equal(
      reviewSummary(tiktok('tiktok_ad_create', '/v1.3/ad/create/', {advertiser_id: '123', creatives}), advertiserRead)
        .count,
      1,
      JSON.stringify(creatives),
    );
  // A Smart+ ad holds its creatives in one ad: its creative_list is not a count of ads.
  const smart = reviewSummary(
    tiktok('tiktok_smart_plus_ad_create', '/v1.3/smart_plus/ad/create/', {
      advertiser_id: '123',
      adgroup_id: '201',
      creative_list: [{creative_info: {}}, {creative_info: {}}, {creative_info: {}}],
    }),
    advertiserRead,
  );
  assert.deepEqual([smart.operation, smart.entity, smart.count], ['create', 'ad', 1]);
});

test('a Snapchat record list and a LinkedIn BATCH_CREATE name how many entities they create', () => {
  const feeds = sample('snapchat_catalog_product_feed_create', {
    body: {product_feeds: [{name: 'Synthetic feed 1'}, {name: 'Synthetic feed 2'}]},
  });
  const two = reviewSummary(feeds, []);
  assert.deepEqual([two.operation, two.entity, two.count], ['create', 'product_feeds', 2]);
  assert.equal(
    two.text,
    'Create 2 product_feeds in account 123: new product_feeds "Synthetic feed 1"; new product_feeds "Synthetic feed 2".',
  );
  assert.equal(reviewSummary({...feeds, body: {product_feeds: [{name: 'Synthetic feed'}]}}, []).count, 1);
  assert.equal(reviewSummary({...feeds, body: {}}, []).count, 1);
  // The known collections kept their counts.
  const squads = reviewSummary(
    plan(
      'snapchat_native_action',
      'snapchat_campaigns_campaign_id_adsquads_create',
      'POST',
      '/v1/campaigns/c1/adsquads',
      {
        adsquads: [{name: 'a'}, {name: 'b'}, {name: 'c'}],
      },
    ),
    [],
  );
  assert.deepEqual([squads.operation, squads.entity, squads.count], ['create', 'ad squad', 3]);
  // LinkedIn lists the elements of a BATCH_CREATE; a plain CREATE is one.
  const rules = sample('linkedin_rest_dmp_segments_segment_id_engagement_rules_post', {
    headers: {'X-RestLi-Method': 'BATCH_CREATE'},
    body: {elements: [{rule: 1}, {rule: 2}, {rule: 3}]},
  });
  const batch = reviewSummary(rules, []);
  assert.deepEqual([batch.operation, batch.entity, batch.count], ['create', 'engagementRules', 3]);
  assert.equal(batch.text, 'Create 3 engagementRules in account 123.');
  assert.equal(reviewSummary({...rules, headers: {'X-RestLi-Method': 'CREATE'}, body: {rule: 1}}, []).count, 1);
  assert.equal(reviewSummary({...rules, headers: {}, body: {elements: [{rule: 1}, {rule: 2}]}}, []).count, 1);
});

test('every ledger route that ends in the verb create reads as a create, whatever the first record read says', () => {
  const registry = new Registry(),
    routes = actionContracts(registry).filter(r => {
      // A captured action says whether it only reads; a provider's own contract rows (Criteo's, Tag Manager's) do not, and
      // DV360's captured actions carry no flag at all (read_only is null), which is not a read: a route is a write unless
      // its capture says that it only reads (R2.5 S4-4: the sweep used to skip every DV360 route).
      const route = registry.action(r.gateway, r.action);
      return (
        r.method &&
        r.path &&
        (route ? route.read_only !== true : r.method !== 'GET') &&
        // The oracle is the provider's own route template: its last segment is the verb create, as a segment of its
        // own, as the head of a hyphenated one, or as a custom method (:create_version).
        /(?:^|\/)create(?:-[^/]+)?\/?$|:create_[^/:]+$/.test(r.path.split('?')[0])
      );
    });
  // The count keeps this from passing vacuously should the ledger lose them.
  assert.ok(routes.length >= 60, 'routes ending in create: ' + routes.length);
  assert.ok(routes.some(r => r.gateway === 'tiktok_native_action' && r.path === '/v1.3/campaign/create/'));
  for (const r of routes) {
    const path = r.path.split('?')[0].replace(/\{[^}]+\}/g, '123');
    const s = reviewSummary(plan(r.gateway, r.action, r.method, path, {operation_status: 'DISABLE'}), advertiserRead);
    assert.equal(s.operation, 'create', r.gateway + ' ' + r.action + ' ' + path);
    assert.match(s.text, /^Create 1 /, r.action);
    assert.notEqual(s.entity, 'create', r.action + ' is named by what it creates, not by its verb');
    for (const entry of s.status ?? []) assert.equal(entry.from, undefined, r.action + ' must not borrow a status');
  }
});

test('an update keeps its "Update … from → to" wording, and the same words under an RPC route', () => {
  const campaign = [
    {data: {list: [{campaign_id: '101', campaign_name: 'Synthetic launch', operation_status: 'ENABLE'}]}},
  ];
  const rename = reviewSummary(
    tiktok('tiktok_campaign_update', '/v1.3/campaign/update/', {
      advertiser_id: '123',
      campaign_id: '101',
      campaign_name: 'Renamed',
    }),
    campaign,
  );
  assert.deepEqual([rename.operation, rename.entity, rename.count], ['update', 'campaign', 1]);
  // r25-approval-fields (B6): the line names the object, its id and its old name from the review's own read of it.
  assert.equal(
    rename.text,
    'Update 1 campaign in account 123: campaign "Synthetic launch" (101): campaign_name Synthetic launch → Renamed.',
  );
  const pause = reviewSummary(
    tiktok('tiktok_campaign_status_update', '/v1.3/campaign/status/update/', {
      advertiser_id: '123',
      campaign_ids: ['101'],
      operation_status: 'DISABLE',
    }),
    campaign,
  );
  assert.equal(pause.operation, 'update');
  assert.equal(
    pause.text,
    'Update 1 campaign in account 123: campaign "Synthetic launch" (101): operation_status ENABLE → DISABLE.',
  );
  assert.deepEqual(pause.status, [{field: '/operation_status', from: 'ENABLE', to: 'DISABLE'}]);
  // A REST update keeps its words too: the node POST names its current status.
  const meta = reviewSummary(
    plan('meta_native_action', 'meta_campaign_id_update', 'POST', '/v26.0/111', {status: 'PAUSED'}),
    [{id: '111', name: 'Spring', status: 'ACTIVE'}],
  );
  assert.equal(meta.operation, 'update');
  assert.match(meta.text, /^Update 1 .+ in account 123: campaign "Spring" \(111\): status ACTIVE → PAUSED\.$/);
  assert.deepEqual(meta.status, [{field: '/status', from: 'ACTIVE', to: 'PAUSED'}]);
});

// S3-1 (the lead's review of this package): the "from" of a status change is the current status of the entity written, never
// the account's or a parent's. The first record of the review's reads that has a status was taken for it, and the account is
// the first read of most reviews, so a write that is not read as a create (a route that no declaration covers, or an update
// whose target is read after the account) borrowed the account's status: the PAUSED of an ad account shown as the "from" of a
// catalog feed. A write of the account itself keeps its own.
test('the "from" of an update is the status of its target, never the status of the account read before it', () => {
  const account = {
      adaccounts: [{adaccount: {id: '123', name: 'Synthetic account', currency: 'USD', status: 'PAUSED'}}],
    },
    campaign = {campaigns: [{campaign: {id: '456', name: 'Synthetic campaign', status: 'PAUSED'}}]};
  const update = plan(
    'snapchat_native_action',
    'snapchat_adaccounts_ad_account_id_campaigns_update',
    'PUT',
    '/v1/adaccounts/123/campaigns',
    {campaigns: [{id: '456', name: 'Synthetic campaign', status: 'ACTIVE'}]},
  );
  // The account is read first and is ACTIVE below: the old rule named its status, which equals the new one, so no "from" was
  // shown at all for a campaign that is in fact being activated.
  const s = reviewSummary(update, [
    {adaccounts: [{adaccount: {...account.adaccounts[0].adaccount, status: 'ACTIVE'}}]},
    campaign,
  ]);
  assert.equal(s.operation, 'update');
  assert.deepEqual(s.status, [{field: '/campaigns/0/status', from: 'PAUSED', to: 'ACTIVE'}]);
  // With the target read first it was never wrong, and it still reads the same.
  assert.deepEqual(reviewSummary(update, [campaign, account]).status, s.status);
  // When the account is the only record with a status there is no target to name: no "from" is better than a wrong one.
  assert.deepEqual(reviewSummary(update, [account]).status, [{field: '/campaigns/0/status', to: 'ACTIVE'}]);
});

test('a write of the account itself keeps the status it had, and a parent read is no target either', () => {
  const settings = plan(
    'linkedin_native_action',
    'linkedin_rest_ad_accounts_ad_account_id_post',
    'POST',
    '/rest/adAccounts/123',
    {patch: {$set: {status: 'PAUSED'}}},
  );
  const own = reviewSummary(settings, [{id: 123, name: 'Synthetic account', currency: 'USD', status: 'ACTIVE'}]);
  assert.deepEqual(own.status, [{field: '/patch/$set/status', from: 'ACTIVE', to: 'PAUSED'}]);
  // An edit of a campaign below that account reads the account first; its "from" is the campaign's.
  const campaign = plan(
    'linkedin_native_action',
    'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post',
    'POST',
    '/rest/adAccounts/123/adCampaigns/456',
    {patch: {$set: {status: 'PAUSED'}}},
  );
  const edit = reviewSummary(campaign, [
    {id: 123, name: 'Synthetic account', currency: 'USD', status: 'PAUSED'},
    {id: 456, name: 'Synthetic campaign', status: 'ACTIVE'},
  ]);
  assert.deepEqual(edit.status, [{field: '/patch/$set/status', from: 'ACTIVE', to: 'PAUSED'}]);
  // A provider whose account record names its status in another field is unaffected; a Meta node edit keeps its status.
  const meta = reviewSummary(
    plan('meta_native_action', 'meta_campaign_id_update', 'POST', '/v26.0/111', {status: 'PAUSED'}),
    [
      {id: 'act_123', account_status: 1, currency: 'USD'},
      {id: '111', name: 'Spring', status: 'ACTIVE'},
    ],
  );
  assert.deepEqual(meta.status, [{field: '/status', from: 'ACTIVE', to: 'PAUSED'}]);
});

test('a LinkedIn partial update, a POST to a member, stays an update and keeps its current status', () => {
  const s = reviewSummary(
    plan(
      'linkedin_native_action',
      'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post',
      'POST',
      '/rest/adAccounts/123/adCampaigns/456',
      {patch: {$set: {status: 'ACTIVE'}}},
    ),
    [{id: 456, name: 'Synthetic campaign', status: 'PAUSED'}],
  );
  assert.equal(s.operation, 'update');
  assert.deepEqual(s.status, [{field: '/patch/$set/status', from: 'PAUSED', to: 'ACTIVE'}]);
});

test('a delete keeps its words, on a REST route and on an RPC route that ends in the verb delete', () => {
  const rest = reviewSummary(plan('meta_native_action', 'meta_campaign_id_delete', 'DELETE', '/v26.0/111'), [
    {id: '111', name: 'Spring', status: 'ACTIVE'},
  ]);
  assert.equal(rest.operation, 'delete');
  assert.match(rest.text, /^Delete 1 /);
  const rpc = reviewSummary(
    tiktok('tiktok_blockedword_delete', '/v1.3/blockedword/delete/', {advertiser_id: '123', blockedword_ids: ['1']}),
    advertiserRead,
  );
  assert.equal(rpc.operation, 'delete');
  assert.match(rpc.text, /^Delete 1 /);
});

// T3b: the same defect on a REST collection the path shape does not recognize. The old rule knew 14 collection names;
// a campaign of LinkedIn (…/adAccounts/1/adCampaigns) is none of them, so its create read "Update 1 adCampaigns … status
// ACTIVE → DRAFT": the ACTIVE is the account's, the first status in the account read.
test('a LinkedIn campaign create reads as a create and borrows no status from the account it is created in', () => {
  const account = [{id: 123, name: 'Synthetic account', currency: 'USD', status: 'ACTIVE'}];
  for (const [action, path, entity] of [
    ['linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post', '/rest/adAccounts/123/adCampaigns', 'adCampaigns'],
    [
      'linkedin_rest_ad_accounts_ad_account_id_ad_campaign_groups_post',
      '/rest/adAccounts/123/adCampaignGroups',
      'adCampaignGroups',
    ],
  ]) {
    const s = reviewSummary(
      plan('linkedin_native_action', action, 'POST', path, {name: 'Synthetic', status: 'DRAFT'}),
      account,
    );
    assert.deepEqual([s.operation, s.entity, s.count], ['create', entity, 1], path);
    assert.equal(
      s.text,
      'Create 1 ' + entity + ' in account Synthetic account (123): new ' + entity + ' "Synthetic": status DRAFT.',
      path,
    );
    assert.deepEqual(s.status, [{field: '/status', to: 'DRAFT'}], path);
  }
});

test('a create directly under the account of X and Snapchat reads as a create, and a member route of the same family does not', () => {
  const x = reviewSummary(
    plan(
      'x_ads_native_action',
      'x_accounts_account_id_promoted_tweets_post',
      'POST',
      '/12/accounts/123/promoted_tweets',
      {
        line_item_id: 'a1',
        tweet_ids: ['t1'],
      },
    ),
    [{data: {id: '123', name: 'Synthetic account', currency: 'USD'}}],
  );
  assert.deepEqual([x.operation, x.entity], ['create', 'promoted_tweets']);
  const snap = reviewSummary(
    plan(
      'snapchat_native_action',
      'snapchat_adaccounts_ad_account_id_media_create',
      'POST',
      '/v1/adaccounts/123/media',
      {
        media: [{name: 'Synthetic media', type: 'VIDEO'}],
      },
    ),
    [{adaccounts: [{adaccount: {id: '123', name: 'Synthetic account', currency: 'USD', status: 'ACTIVE'}}]}],
  );
  assert.deepEqual([snap.operation, snap.entity], ['create', 'media']);
  // The account itself, a member of a collection and a collection's own update stay updates.
  for (const [gateway, action, method, path] of [
    ['linkedin_native_action', 'linkedin_rest_ad_accounts_ad_account_id_post', 'POST', '/rest/adAccounts/123'],
    ['x_ads_native_action', 'x_accounts_account_id_campaigns_campaign_id_put', 'PUT', '/12/accounts/123/campaigns/c9'],
    ['snapchat_native_action', 'snapchat_adaccounts_ad_account_id_pixels_update', 'PUT', '/v1/adaccounts/123/pixels'],
  ])
    assert.equal(reviewSummary(plan(gateway, action, method, path, {status: 'PAUSED'}), []).operation, 'update', path);
});

// S4-4 (the lead's review of this package): this sweep's expected value was the code's own rule (the action name's create
// or post token), which proves nothing for LinkedIn and X, whose names carry only the HTTP method. Whether a reviewed route
// reads as a create is now swept against an oracle of its own, DV360's routes included, in
// tests/review-summary-ledger.test.mjs. What stays here is the safety property of every route under an account, reviewed or
// not, DV360's included (its captures carry no read_only flag, which is not a read): it never takes the account's status.
test('a ledger POST to a collection directly under its provider’s account path borrows no status from the account', () => {
  const registry = new Registry(),
    found = new Map();
  for (const r of actionContracts(registry)) {
    const route = registry.action(r.gateway, r.action),
      accountPath = providerHooks(r.gateway)?.writes?.accountPath;
    if (!r.method || !r.path || !accountPath || (route ? route.read_only === true : r.method === 'GET')) continue;
    const template = r.path.split('?')[0],
      path = template.replace(/\{[^}]+\}/g, '123'),
      account = accountPath.exec(path)?.[0],
      last = template.split('/').filter(Boolean).at(-1);
    if (r.method !== 'POST' || !account || path.slice(account.length).split('/').filter(Boolean).length !== 1) continue;
    if (/^\{/.test(last) || /^create(?:-|$)/.test(last)) continue;
    // What a review reads of the account: its currency marks it, as every provider's account read carries one.
    const s = reviewSummary(plan(r.gateway, r.action, r.method, path, {status: 'PAUSED'}), [
      {id: 123, name: 'Synthetic account', currency: 'USD', status: 'ACTIVE'},
    ]);
    assert.equal(s.status?.[0]?.from, undefined, r.action + ' must not borrow the account’s status');
    found.set(r.gateway, (found.get(r.gateway) ?? 0) + 1);
  }
  // The sweep reaches LinkedIn’s, X’s, Snapchat’s and DV360’s collections under their accounts.
  assert.ok(found.get('linkedin_native_action') >= 2, JSON.stringify([...found]));
  assert.ok(found.get('x_ads_native_action') >= 15, JSON.stringify([...found]));
  assert.ok(found.get('snapchat_native_action') >= 15, JSON.stringify([...found]));
  assert.ok(found.get('dv360_native_action') >= 4, JSON.stringify([...found]));
});

// T3c: a request that names a method other than a create is no create, whatever its path looks like. LinkedIn takes a
// Rest.li method on any POST (restli_method), and the compiler tunnels a method override too: a collection POST that says
// BATCH_PARTIAL_UPDATE updates what it names, so a summary that read "Create" would hide an update (and its status) from
// the person approving it. The exact request shows the header; the summary must not contradict it.
const collectionPost = (action, path, headers = {}, query = {}) => ({
  ...plan('linkedin_native_action', action, 'POST', path, {status: 'ACTIVE'}),
  headers,
  query,
});
const campaigns = ['linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post', '/rest/adAccounts/123/adCampaigns'];
// Creatives are one of the 14 collection names the old rule knew: the same guard applies to it.
const creatives = ['linkedin_rest_ad_accounts_ad_account_id_creatives_post', '/rest/adAccounts/123/creatives'];

test('a collection POST that names an update method reads as an update, and one that names a create still reads as a create', () => {
  for (const [action, path] of [campaigns, creatives]) {
    for (const method of [
      'PARTIAL_UPDATE',
      'BATCH_PARTIAL_UPDATE',
      'UPDATE',
      'BATCH_UPDATE',
      'ACTION',
      'partial_update',
    ]) {
      const s = reviewSummary(collectionPost(action, path, {'X-RestLi-Method': method}), []);
      assert.equal(s.operation, 'update', path + ' ' + method);
      assert.match(s.text, /^Update 1 /, path + ' ' + method);
    }
    for (const headers of [
      {},
      {'X-RestLi-Method': 'CREATE'},
      {'X-RestLi-Method': 'BATCH_CREATE'},
      {'X-HTTP-Method-Override': 'POST'},
    ]) {
      const s = reviewSummary(collectionPost(action, path, headers), []);
      assert.equal(s.operation, 'create', path + ' ' + JSON.stringify(headers));
    }
  }
});

test('a method override, in a header or in the query string a REST server reads, makes a collection POST no create', () => {
  const [action, path] = campaigns;
  for (const headers of [
    {'X-HTTP-Method-Override': 'PUT'},
    {'X-HTTP-Method-Override': 'PATCH'},
    {'X-Method-Override': 'put'},
  ])
    assert.equal(reviewSummary(collectionPost(action, path, headers), []).operation, 'update', JSON.stringify(headers));
  for (const query of [{method: 'PUT'}, {_method: 'PATCH'}, {http_method: 'PUT'}, {method_override: 'PATCH'}])
    assert.equal(reviewSummary(collectionPost(action, path, {}, query), []).operation, 'update', JSON.stringify(query));
  // A query parameter that only has a similar name, or says POST, is not an override.
  for (const query of [{method: 'POST'}, {payment_method: 'card'}, {fields: 'id'}])
    assert.equal(reviewSummary(collectionPost(action, path, {}, query), []).operation, 'create', JSON.stringify(query));
  // The same on the known collections of other providers (S4): a Snapchat ad squad POST that tunnels a PUT.
  const squad = {
    ...plan(
      'snapchat_native_action',
      'snapchat_campaigns_campaign_id_adsquads_create',
      'POST',
      '/v1/campaigns/c1/adsquads',
      {
        adsquads: [{status: 'ACTIVE'}],
      },
    ),
    headers: {'X-HTTP-Method-Override': 'PUT'},
  };
  assert.equal(reviewSummary(squad, []).operation, 'update');
  assert.equal(reviewSummary({...squad, headers: {}}, []).operation, 'create');
});

// S4-1 (the lead's review of this package): the guard belongs to every way a path can read as a create. A POST to a route
// that ends in the verb create, carrying an override, updates what it names too; and a method given as anything but a
// string (the compiler reads every override with String(), so a query value of ['PUT'] tunnels a PUT) is read the same way.
test('a verb route that names another method is no create, and a method that is not a string is read as the compiler reads it', () => {
  const verbPost = (headers = {}, query = {}) => ({
    ...tiktok('tiktok_campaign_create', '/v1.3/campaign/create/', {operation_status: 'DISABLE'}),
    headers,
    query,
  });
  for (const headers of [{'X-HTTP-Method-Override': 'PATCH'}, {'X-HTTP-Method-Override': 'put'}, {'X-Method': 'PUT'}])
    assert.equal(reviewSummary(verbPost(headers), advertiserRead).operation, 'update', JSON.stringify(headers));
  for (const query of [{method: 'PUT'}, {_method: 'PATCH'}, {http_method: 'PUT'}, {method_override: 'PATCH'}])
    assert.equal(reviewSummary(verbPost({}, query), advertiserRead).operation, 'update', JSON.stringify(query));
  // The same route without an override, or with one that says POST, is the create it is.
  for (const [headers, query] of [
    [{}, {}],
    [{'X-HTTP-Method-Override': 'POST'}, {}],
    [{}, {method: 'POST'}],
    [{}, {payment_method: 'card'}],
  ])
    assert.equal(reviewSummary(verbPost(headers, query), advertiserRead).operation, 'create', JSON.stringify(query));
  // The compiler reads a query value with String(): an array of one method is that method.
  const [action, path] = campaigns;
  for (const query of [{method: ['PUT']}, {_method: ['PATCH']}, {http_method: ['PUT', 'PATCH']}]) {
    assert.equal(reviewSummary(collectionPost(action, path, {}, query), []).operation, 'update', JSON.stringify(query));
    assert.equal(reviewSummary(verbPost({}, query), advertiserRead).operation, 'update', JSON.stringify(query));
  }
  assert.equal(reviewSummary(collectionPost(action, path, {}, {method: ['POST']}), []).operation, 'create');
  assert.equal(reviewSummary(collectionPost(action, path, {}, {method: undefined}), []).operation, 'create');
});

test('the request amcp_write inspect compiles for a LinkedIn collection POST with a Rest.li update method reads as an update', async t => {
  const store = new Store(':memory:', Buffer.alloc(32, 5).toString('base64')),
    operator = {tenantId: 'synthetic-summary', userId: 'op', role: 'operator'};
  t.after(() => store.close());
  store.putConnection(
    {...operator, role: 'admin'},
    {
      id: 'c',
      tenantId: operator.tenantId,
      gateway: 'linkedin_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw new Error('inspect sends nothing');
    }),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  );
  const summarize = async restli => {
    const result = await service.call(
      'amcp_write',
      {
        action: 'inspect',
        gateway: 'linkedin_native_action',
        arguments: {
          account_id: '123',
          action: campaigns[0],
          ...(restli ? {restli_method: restli} : {}),
          payload: {entities: {456: {patch: {$set: {status: 'ACTIVE'}}}}},
        },
      },
      operator,
    );
    assert.equal(result.success, true, JSON.stringify(result.error));
    return {request: result.data.request, summary: reviewSummary(result.data.request, [])};
  };
  const batch = await summarize('BATCH_PARTIAL_UPDATE');
  assert.equal(batch.request.headers['X-RestLi-Method'], 'BATCH_PARTIAL_UPDATE');
  assert.equal(batch.summary.operation, 'update');
  assert.equal((await summarize('PARTIAL_UPDATE')).summary.operation, 'update');
  // Without a method of its own the same collection POST is a create, and so is one that names CREATE.
  assert.equal((await summarize(undefined)).summary.operation, 'create');
  assert.equal((await summarize('CREATE')).summary.operation, 'create');
});

// A path that ends in the word create is a create only when it is a POST, as every such route of the ledger is: an object
// whose ID is the word create, written by a PUT or a PATCH, is an update of it (and the review could not read it first).
test('a PUT or PATCH to a path that ends in create is an update, and a POST to it is the create it says', () => {
  for (const method of ['PUT', 'PATCH']) {
    const s = reviewSummary(
      plan(
        'x_ads_native_action',
        'x_accounts_account_id_campaigns_campaign_id_put',
        method,
        '/12/accounts/123/campaigns/create',
        {
          entity_status: 'ACTIVE',
        },
      ),
      [{data: {id: 'create', name: 'Synthetic', entity_status: 'PAUSED'}}],
    );
    assert.equal(s.operation, 'update', method);
    assert.deepEqual(s.status, [{field: '/entity_status', from: 'PAUSED', to: 'ACTIVE'}], method);
  }
  assert.equal(
    reviewSummary(
      tiktok('tiktok_campaign_create', '/v1.3/campaign/create/', {operation_status: 'DISABLE'}),
      advertiserRead,
    ).operation,
    'create',
  );
});

// S2-1 (the lead's review of this package): Microsoft Advertising's Add, Update and Delete share one route and differ by
// method, so no path rule told them apart: every Add of the launch recipe read "Update 1 Campaigns", for one campaign or
// twenty. The reviewed family of these writes matches them by method and path and declares what each does, as the review's
// own planning already tells a create from an edit; the summary asks it before it reads the path.
const microsoftPlan = (action, payload) => compileMicrosoft({action, account_id: '123', campaign_id: '100', payload});
const searchCampaign = {CampaignType: 'Search', BudgetType: 'DailyBudgetStandard', Status: 'Paused'};
const responsiveAd = {
  Type: 'ResponsiveSearch',
  Headlines: [{Text: 'Synthetic headline'}],
  Descriptions: [{Text: 'Synthetic description'}],
  FinalUrls: ['https://example.com'],
};
const addsOfTheRecipe = [
  [
    'AddCampaigns',
    {
      Campaigns: [
        {Name: 'A', DailyBudget: 10, ...searchCampaign},
        {Name: 'B', DailyBudget: 12, ...searchCampaign},
      ],
    },
    ['campaign', 2],
    'Create 2 campaigns in account 123: new campaign "A": DailyBudget 10.00 in account currency (10 account currency), Status Paused; new campaign "B": DailyBudget 12.00 in account currency (12 account currency), Status Paused.',
  ],
  [
    'AddAdGroups',
    {CampaignId: '100', AdGroups: [{Name: 'G', Status: 'Paused'}]},
    ['ad group', 1],
    'Create 1 ad group in account 123: new ad group "G" in campaign 100: Status Paused.',
  ],
  [
    'AddAds',
    {AdGroupId: '200', Ads: [responsiveAd, responsiveAd, responsiveAd]},
    ['ad', 3],
    'Create 3 ads in account 123.',
  ],
  [
    'AddKeywords',
    {
      AdGroupId: '200',
      Keywords: [
        {Text: 'a', MatchType: 'Exact', Status: 'Paused'},
        {Text: 'b', MatchType: 'Exact', Status: 'Paused'},
      ],
    },
    ['keyword', 2],
    'Create 2 keywords in account 123: new keyword in ad group 200: Status Paused.',
  ],
  [
    'AddCampaignCriterions',
    {
      CriterionType: 'Targets',
      CampaignCriterions: [{CampaignId: '100', Criterion: {Type: 'LocationCriterion', LocationId: '190'}}],
    },
    ['campaign criterion', 1],
    'Create 1 campaign criterion in account 123.',
  ],
];

test('a Microsoft Advertising Add reads as a create of every row it lists, with its money as before', () => {
  for (const [action, payload, [entity, count], text] of addsOfTheRecipe) {
    const s = reviewSummary(microsoftPlan(action, payload), []);
    assert.deepEqual([s.operation, s.entity, s.count], ['create', entity, count], action);
    assert.equal(s.text, text, action);
  }
});

// S2-2 (the lead's review of this package): every create the review accepts reads as a create. The route styles of the
// ledger are swept in tests/review-summary-ledger.test.mjs; here is one route of each style, from the ledger's own sample
// of it, with what the summary names, and what it must not name. Each answer is the review's own side's: a family's, or its
// provider's for the writes the review accepts, who read the method and the path they claim a request by.
const samples = new Map(reviewedWriteRoutes().map(({row, plan}) => [row.action, plan]));
const sample = (action, overrides = {}) => {
  assert.ok(samples.has(action), action + ' is a reviewed route of the ledger');
  return {...samples.get(action), ...overrides};
};
// [route, [operation, entity, count], one route of a style the summary used to read as an update]
const styles = [
  ['Meta: a POST to an edge of an account', 'meta_ad_account_id_adspixels_create', ['create', 'adspixels', 1]],
  ['Meta: a POST to an edge of a node', 'meta_product_catalog_id_product_sets_create', ['create', 'product_sets', 1]],
  // r25-approval-fields (B6): the rows below that edit an object by its id pinned the id as the entity ("Update 1 123"); the entity is what the object is.
  ['Meta: a POST to a node', 'meta_pixel_id_update', ['update', 'pixel', 1]],
  ['Meta: a POST that deletes', 'meta_value_rule_set_id_delete_rule_set_create', ['delete', 'delete_rule_set', 1]],
  ['LinkedIn: a POST to a collection', 'linkedin_rest_lead_forms_post', ['create', 'leadForms', 1]],
  [
    'LinkedIn: a POST to a collection below an entity',
    'linkedin_rest_dmp_segments_segment_id_engagement_rules_post',
    ['create', 'engagementRules', 1],
  ],
  ['LinkedIn: a POST to an entity', 'linkedin_rest_lead_forms_lead_form_id_post', ['update', 'lead form', 1]],
  ['LinkedIn: a PUT', 'linkedin_rest_campaign_conversions_put', ['update', 'campaignConversions', 1]],
  ['Snapchat: a POST below a catalog', 'snapchat_catalog_product_feed_create', ['create', 'product_feeds', 1]],
  ['Snapchat: a PUT to the same collection', 'snapchat_catalog_product_feed_update', ['update', 'product_feeds', 1]],
  ['Reddit: a POST', 'CREATE_AD_GROUP', ['create', 'ad_groups', 1]],
  ['Reddit: a PATCH', 'UPDATE_AD_GROUP', ['update', 'ad group', 1]],
  ['Tag Manager: a POST to a collection', 'CREATE_TAG', ['create', 'tags', 1]],
  ['Tag Manager: a custom method that creates', 'CREATE_CONTAINER_VERSION', ['create', 'version', 1]],
  ['Tag Manager: a custom method', 'REVERT_TAG', ['update', 'tag', 1]],
  ['Tag Manager: a PUT', 'UPDATE_TAG', ['update', 'tag', 1]],
  ['DV360: a POST to a collection', 'DV360_ADVERTISERS_CHANNELS_SITES_CREATE', ['create', 'sites', 1]],
  ['DV360: a custom method that duplicates', 'DV360_ADVERTISERS_LINE_ITEMS_DUPLICATE', ['create', 'line item', 1]],
  ['DV360: a custom method that edits', 'DV360_ADVERTISERS_CHANNELS_SITES_BULK_EDIT', ['update', 'sites:bulkEdit', 1]],
  ['DV360: a custom method that creates', 'DV360_ADVERTISERS_AD_ASSETS_BULK_CREATE', ['create', 'ad asset', 1]],
  ['Apple Ads: a POST', 'apple_ads_v1_adgroup_create', ['create', 'ad group', 1]],
  ['Apple Ads: a PUT', 'apple_ads_v1_adgroup_update', ['update', 'ad group', 1]],
  ['Google Analytics: a report task', 'ga4_create_report_task', ['create', 'reportTasks', 1]],
  ['Business Profile: a POST', 'CREATE_LOCATION_ADMIN', ['create', 'admins', 1]],
  ['Business Profile: a PATCH', 'PATCH_LOCATION_ADMIN', ['update', 'admin', 1]],
  ['Search Console: a PUT to a site', 'ADD_SITE', ['create', 'site', 1]],
  ['Search Console: a PUT to its sitemap', 'SUBMIT_SITEMAP', ['update', 'sitemap', 1]],
  ['Criteo: a POST', 'CREATE_CAMPAIGNS_BY_ACCOUNT_ID', ['create', 'campaign', 1]],
  ['Criteo: a POST that appends', 'APPEND_AUDIENCE_TARGETS_BY_LINE_ITEM_ID', ['update', 'append', 1]],
  ['Criteo: a report job', 'GENERATE_ASYNC_CAMPAIGNS_REPORT', ['create', 'performance report', 1]],
  ['X: a POST to a card type', 'x_accounts_account_id_cards_poll_post', ['create', 'poll', 1]],
  ['X: a POST to a catalog', 'x_product_catalogs_post', ['create', 'product_catalogs', 1]],
  ['X: a report job', 'x_stats_jobs_accounts_account_id_post', ['create', 'report job', 1]],
  ['X: a PUT', 'x_accounts_account_id_campaigns_campaign_id_put', ['update', 'campaign', 1]],
  ['TikTok: an add', 'tiktok_search_ad_negative_keyword_add', ['create', 'negative keyword', 1]],
  // r25-field3-livefix, item 3: this row pinned the entity "update" (the path's last word), which read "Update 1 update"; the route's family declares its entity.
  ['TikTok: an update', 'tiktok_search_ad_negative_keyword_update', ['update', 'negative keyword', 1]],
];

test('one route of each style of the review’s writes reads as the operation it is', () => {
  for (const [style, action, [operation, entity, count]] of styles) {
    const s = reviewSummary(sample(action), []);
    assert.deepEqual([s.operation, s.entity, s.count], [operation, entity, count], style + ' (' + action + ')');
    assert.match(s.text, new RegExp('^' + operation[0].toUpperCase() + operation.slice(1) + ' ' + count + ' '), style);
  }
  assert.equal(
    reviewSummary(sample('meta_ad_account_id_adspixels_create'), []).text,
    'Create 1 adspixels in account 123.',
  );
});

test('a declared create is no create for a request that names another method, or for a route the review does not accept, or by the name it carries', () => {
  // The guard of every path: a collection POST that says BATCH_PARTIAL_UPDATE updates what it names.
  const lead = sample('linkedin_rest_lead_forms_post');
  assert.equal(reviewSummary(lead, []).operation, 'create');
  assert.equal(reviewSummary({...lead, headers: {'X-RestLi-Method': 'BATCH_PARTIAL_UPDATE'}}, []).operation, 'update');
  const edge = sample('meta_ad_account_id_adspixels_create');
  assert.equal(reviewSummary({...edge, query: {method: ['PUT']}}, []).operation, 'update');
  // A route no family and no entity write of its provider claims is not reviewed, and the provider answers only for what
  // the review accepts: its summary is read from the path, as it was.
  const preview = {...edge, action: 'meta_ad_account_id_adpreviews_create', path: '/v26.0/act_123/adpreviews'};
  assert.equal(reviewSummary(preview, []).operation, 'update');
  // The name a caller gives an action decides nothing: a node POST is an update whatever it is called.
  const node = {...sample('meta_pixel_id_update'), action: 'meta_ad_account_id_adspixels_create'};
  assert.equal(reviewSummary(node, []).operation, 'update');
  // A deletion stays what the method says, whatever a provider declares for its other POSTs.
  assert.equal(reviewSummary({...edge, method: 'DELETE', destructive: true}, []).operation, 'delete');
  // A read, or a request a transport of its own carries, is not summarized by the review's declarations.
  assert.equal(reviewSummary({...edge, readOnly: true}, []).operation, 'update');
  assert.equal(reviewSummary({...edge, specialTransport: 'vendor_media'}, []).operation, 'update');
});

// What a batch of X does its body decides: every item is a Create, an Update or a Delete, and the summary named the route's
// collection for every one of them ("Create 1 campaign"), whatever the batch held and however long it was.
const batchOf = (type, n) =>
  Array.from({length: n}, (_, i) => ({operation_type: type, params: {line_item_id: 'a' + i}}));
test('a batch of X reads as the operation of its items, with their count, and a mixed one as a change', () => {
  const campaigns = 'x_batch_accounts_account_id_campaigns_post',
    targeting = 'x_batch_accounts_account_id_targeting_criteria_post';
  for (const [action, body, expected, text] of [
    [campaigns, batchOf('Create', 3), ['create', 'campaign', 3], 'Create 3 campaigns in account 123.'],
    [campaigns, batchOf('Update', 2), ['update', 'campaign', 2], 'Update 2 campaigns in account 123.'],
    [campaigns, batchOf('Delete', 2), ['delete', 'campaign', 2], 'Delete 2 campaigns in account 123.'],
    ['x_batch_accounts_account_id_line_items_post', batchOf('Create', 1), ['create', 'line item', 1], undefined],
    [
      targeting,
      batchOf('Create', 2),
      ['create', 'targeting criterion', 2],
      'Create 2 targeting criteria in account 123.',
    ],
    [
      targeting,
      batchOf('Delete', 3),
      ['delete', 'targeting criterion', 3],
      'Delete 3 targeting criteria in account 123.',
    ],
    [
      targeting,
      [...batchOf('Create', 1), ...batchOf('Delete', 1)],
      ['change', 'targeting criterion', 2],
      'Change 2 targeting criteria in account 123.',
    ],
  ]) {
    const s = reviewSummary(sample(action, {body}), []);
    assert.deepEqual([s.operation, s.entity, s.count], expected, action + ' ' + JSON.stringify(body).slice(0, 60));
    // The head of the line is what this test pins (the verb, the count, the plural); what follows it, if anything, names the items (r25-approval-fields, B6).
    if (text) assert.ok(s.text.startsWith(text.slice(0, -1)), s.text);
  }
  // A body that lists no operation, or one the family would refuse, is read from the route as before.
  for (const body of [[], {}, null, [{operation_type: 'Replace', params: {}}]])
    assert.equal(reviewSummary(sample(targeting, {body}), []).operation, 'update', JSON.stringify(body));
});

test('a Microsoft Advertising Update and Delete read exactly as they did, and a create the request does not claim stays an update', () => {
  // The same route and body shapes as the Adds: the method is what tells them apart, and nothing else about them changes.
  const update = reviewSummary(microsoftPlan('UpdateCampaigns', {Campaigns: [{Id: '1', Status: 'Active'}]}), []);
  // r25-approval-fields (B6): the entity was the collection as the route spells it ("Update 1 Campaigns"); it is the kind of object.
  assert.deepEqual([update.operation, update.entity, update.count], ['update', 'campaign', 1]);
  assert.equal(update.text, 'Update 1 campaign in account 123: campaign (1): Status Active.');
  // r25-field3-livefix, item 3: these two lines pinned a count of one for a delete that lists two IDs (the defect of "Delete 1 campaign" for four): the
  // route's body lists the collection's IDs (CampaignIds under …/Campaigns), and the summary counts them.
  const remove = reviewSummary(microsoftPlan('DeleteCampaigns', {CampaignIds: ['1', '2']}), []);
  assert.deepEqual([remove.operation, remove.entity, remove.count], ['delete', 'campaign', 2]);
  assert.equal(remove.text, 'Delete 2 campaigns in account 123: campaign (1, 2).');
  assert.equal(reviewSummary(microsoftPlan('DeleteCampaigns', {CampaignIds: ['1']}), []).count, 1);
  const add = microsoftPlan('AddAdGroups', {CampaignId: '100', AdGroups: [{Name: 'G', Status: 'Paused'}]});
  // The answer is the family's, who claims the request by its method and its path as well as its name: the same name on a
  // path of no Microsoft route is read from the path as it always was.
  assert.equal(reviewSummary({...add, path: '/CampaignManagement/v13/AdGroups/Other'}, []).operation, 'update');
  // A request that names another method is no create here either; and a body that lists no rows is counted as one.
  assert.equal(reviewSummary({...add, headers: {'X-HTTP-Method-Override': 'PUT'}}, []).operation, 'update');
  for (const body of [{}, {AdGroups: 'none'}, {AdGroups: []}, null])
    assert.equal(reviewSummary({...add, body}, []).count, 1, JSON.stringify(body));
});

// R2.5 field3, package r25-field3-livefix, item 3 (the live checks LV-29 and LV-31 of 2026-11-21): a status change or a deletion that lists several IDs
// was summarized as one ("Delete 1 campaign" for four campaigns, "Delete 1 delete" for negative keywords). Each route of TikTok that lists the IDs it
// acts on declares its entity and how many it lists, so the summary says them whatever the operation.
const idListRoutes = [
  ['tiktok_campaign_status_update', '/v1.3/campaign/status/update/', 'campaign_ids', 'campaign', 'campaigns'],
  ['tiktok_adgroup_status_update', '/v1.3/adgroup/status/update/', 'adgroup_ids', 'ad group', 'ad groups'],
  ['tiktok_ad_status_update', '/v1.3/ad/status/update/', 'ad_ids', 'ad', 'ads'],
  [
    'tiktok_smart_plus_campaign_status_update',
    '/v1.3/smart_plus/campaign/status/update/',
    'campaign_ids',
    'campaign',
    'campaigns',
  ],
  [
    'tiktok_smart_plus_adgroup_status_update',
    '/v1.3/smart_plus/adgroup/status/update/',
    'adgroup_ids',
    'ad group',
    'ad groups',
  ],
  ['tiktok_smart_plus_ad_status_update', '/v1.3/smart_plus/ad/status/update/', 'smart_plus_ad_ids', 'ad', 'ads'],
];
test('a TikTok status change or deletion that lists several IDs is counted and named by what it acts on', () => {
  for (const [action, path, field, entity, plural] of idListRoutes)
    for (const operation_status of ['DISABLE', 'DELETE']) {
      const s = reviewSummary(
        {
          ...tiktok(action, path, {advertiser_id: '123', [field]: ['1', '2', '3'], operation_status}),
          destructive: operation_status === 'DELETE',
        },
        advertiserRead,
      );
      assert.deepEqual(
        [s.operation, s.entity, s.count],
        [operation_status === 'DELETE' ? 'delete' : 'update', entity, 3],
        action + ' ' + operation_status,
      );
      assert.match(
        s.text,
        new RegExp('^(Delete|Update) 3 ' + plural + ' in account '),
        action + ' ' + operation_status,
      );
      assert.equal(
        reviewSummary(tiktok(action, path, {advertiser_id: '123', [field]: ['1'], operation_status}), advertiserRead)
          .count,
        1,
      );
    }
  // The negative keywords of the three levels name what they delete and update, not the last word of the path.
  const keywords = reviewSummary(
    {
      ...tiktok('tiktok_search_ad_negative_keyword_delete', '/v1.3/search_ad/negative_keyword/delete/', {
        advertiser_id: '123',
        object_type: 'ADGROUP',
        object_id: '301',
        keyword_ids: ['5', '6'],
      }),
      destructive: true,
    },
    advertiserRead,
  );
  assert.deepEqual([keywords.operation, keywords.entity, keywords.count], ['delete', 'negative keyword', 2]);
  assert.match(keywords.text, /^Delete 2 negative keywords in account /);
});
