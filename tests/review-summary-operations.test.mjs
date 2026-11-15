import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {reviewSummary} from '../dist/src/review-summary.js';
import {providerHooks} from '../dist/src/provider-hooks.js';
import {compileMicrosoft} from '../dist/src/microsoft-native.js';
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
    'Create 2 campaigns in account 123; DailyBudget 10.00 in account currency (10 account currency); DailyBudget 12.00 in account currency (12 account currency).',
  ],
  [
    'AddAdGroups',
    {CampaignId: '100', AdGroups: [{Name: 'G', Status: 'Paused'}]},
    ['ad group', 1],
    'Create 1 ad group in account 123.',
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
    'Create 2 keywords in account 123.',
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

test('a Microsoft Advertising Update and Delete read exactly as they did, and a create the request does not claim stays an update', () => {
  // The same route and body shapes as the Adds: the method is what tells them apart, and nothing else about them changes.
  const update = reviewSummary(microsoftPlan('UpdateCampaigns', {Campaigns: [{Id: '1', Status: 'Active'}]}), []);
  assert.deepEqual([update.operation, update.entity, update.count], ['update', 'Campaigns', 1]);
  assert.equal(update.text, 'Update 1 Campaigns in account 123.');
  const remove = reviewSummary(microsoftPlan('DeleteCampaigns', {CampaignIds: ['1', '2']}), []);
  assert.deepEqual([remove.operation, remove.entity, remove.count], ['delete', 'Campaigns', 1]);
  assert.equal(remove.text, 'Delete 1 Campaigns in account 123.');
  const add = microsoftPlan('AddAdGroups', {CampaignId: '100', AdGroups: [{Name: 'G', Status: 'Paused'}]});
  // The answer is the family's, who claims the request by its method and its path as well as its name: the same name on a
  // path of no Microsoft route is read from the path as it always was.
  assert.equal(reviewSummary({...add, path: '/CampaignManagement/v13/AdGroups/Other'}, []).operation, 'update');
  // A request that names another method is no create here either; and a body that lists no rows is counted as one.
  assert.equal(reviewSummary({...add, headers: {'X-HTTP-Method-Override': 'PUT'}}, []).operation, 'update');
  for (const body of [{}, {AdGroups: 'none'}, {AdGroups: []}, null])
    assert.equal(reviewSummary({...add, body}, []).count, 1, JSON.stringify(body));
});
