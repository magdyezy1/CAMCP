import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {reviewSummary} from '../dist/src/review-summary.js';
import {providerHooks} from '../dist/src/provider-hooks.js';

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
  assert.equal(s.text, 'Create 1 campaign in account Synthetic account (123); operation_status DISABLE.');
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
    assert.equal(s.text, 'Create 1 ' + entity + ' in account Synthetic account (123); operation_status ENABLE.', label);
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
  assert.equal(brand.text, 'Create 1 brand account in account 123.');
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
  assert.equal(version.text, 'Create 1 version in account 123.');
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
  assert.equal(squad.text, 'Create 1 ad squad in account Synthetic account (123); status PAUSED.');
  assert.deepEqual(squad.status, [{field: '/adsquads/0/status', to: 'PAUSED'}]);
  const campaign = reviewSummary(
    plan('meta_native_action', 'meta_campaign_create', 'POST', '/v26.0/act_123/campaigns', {
      name: 'Synthetic campaign',
      status: 'PAUSED',
    }),
    [{id: 'act_123', account_status: 1, currency: 'USD', status: 'ACTIVE'}],
  );
  assert.equal(campaign.text, 'Create 1 campaign in account 123; status PAUSED.');
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
  assert.equal(google.text, 'Create 1 campaign in account Synthetic account (123); status PAUSED.');
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
  assert.equal(s.text, 'Create 1 ad in account Synthetic account (123); operation_status DISABLE.');
  assert.deepEqual(s.status, [{field: '/creatives/0/operation_status', to: 'DISABLE'}]);
});

test('every ledger route that ends in the verb create reads as a create, whatever the first record read says', () => {
  const registry = new Registry(),
    routes = actionContracts(registry).filter(r => {
      // A captured action says whether it only reads; a provider's own contract rows (Criteo's, Tag Manager's) do not.
      const route = registry.action(r.gateway, r.action);
      return (
        r.method &&
        r.path &&
        (route ? route.read_only === false : r.method !== 'GET') &&
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
  assert.equal(rename.text, 'Update 1 campaign in account 123.');
  const pause = reviewSummary(
    tiktok('tiktok_campaign_status_update', '/v1.3/campaign/status/update/', {
      advertiser_id: '123',
      campaign_ids: ['101'],
      operation_status: 'DISABLE',
    }),
    campaign,
  );
  assert.equal(pause.operation, 'update');
  assert.equal(pause.text, 'Update 1 campaign in account 123; operation_status ENABLE → DISABLE.');
  assert.deepEqual(pause.status, [{field: '/operation_status', from: 'ENABLE', to: 'DISABLE'}]);
  // A REST update keeps its words too: the node POST names its current status.
  const meta = reviewSummary(
    plan('meta_native_action', 'meta_campaign_id_update', 'POST', '/v26.0/111', {status: 'PAUSED'}),
    [{id: '111', name: 'Spring', status: 'ACTIVE'}],
  );
  assert.equal(meta.operation, 'update');
  assert.match(meta.text, /^Update 1 .+ in account 123; status ACTIVE → PAUSED\.$/);
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
    assert.equal(s.text, 'Create 1 ' + entity + ' in account Synthetic account (123); status DRAFT.', path);
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

test('every ledger POST to a collection directly under its provider’s account path reads as a create when it creates', () => {
  const registry = new Registry(),
    found = new Map();
  for (const r of actionContracts(registry)) {
    const route = registry.action(r.gateway, r.action),
      accountPath = providerHooks(r.gateway)?.writes?.accountPath;
    if (!r.method || !r.path || !accountPath || (route ? route.read_only !== false : r.method === 'GET')) continue;
    // The oracle is the route template: a POST whose last segment is a literal, on the account's own collection.
    const template = r.path.split('?')[0],
      path = template.replace(/\{[^}]+\}/g, '123'),
      account = accountPath.exec(path)?.[0],
      last = template.split('/').filter(Boolean).at(-1);
    if (r.method !== 'POST' || !account || path.slice(account.length).split('/').filter(Boolean).length !== 1) continue;
    if (/^\{/.test(last) || /^create(?:-|$)/.test(last)) continue;
    const creates = /(?:^|_)(?:create|post)(?:_|$)/.test(r.action.toLowerCase());
    const s = reviewSummary(plan(r.gateway, r.action, r.method, path, {status: 'PAUSED'}), [
      {id: 123, status: 'ACTIVE'},
    ]);
    assert.equal(s.operation === 'create', creates, r.gateway + ' ' + r.action + ' ' + path + ' reads ' + s.operation);
    assert.equal(s.status?.[0]?.from, undefined, r.action + ' must not borrow the account’s status');
    if (creates) found.set(r.gateway, (found.get(r.gateway) ?? 0) + 1);
  }
  // LinkedIn’s two campaign collections, and the X and Snapchat collections the path shape did not know.
  assert.ok(found.get('linkedin_native_action') >= 2, JSON.stringify([...found]));
  assert.ok(found.get('x_ads_native_action') >= 15, JSON.stringify([...found]));
  assert.ok(found.get('snapchat_native_action') >= 15, JSON.stringify([...found]));
});
