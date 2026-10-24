import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {AssetDiscovery} from '../dist/server/asset-discovery.js';

// ARC-01 phase B, the server discovery configurations: these pin the reads of the provider discovery steps that no other
// suite reached with a successful answer (TikTok, Snapchat, X, Meta's Pages, Instagram accounts and account edges)
// through the website's public discovery entry point, so the move of each step from AssetDiscovery.discover
// (server/asset-discovery.ts) into its provider's website login module (src/<provider>-login.ts) is held to the same
// requests, assets and refusals. This file imports nothing the move added, so it runs on the build before the move too
// (the call-replay proof recorded it on both).

const master = Buffer.alloc(32, 41).toString('base64'),
  owner = {tenantId: 'discovery-steps', userId: 'owner', role: 'admin'};
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});

/** A discovery over one stored login whose provider answers by path; every request is recorded. */
function fixture(connection, credentials, answer) {
  const store = new Store(':memory:', master),
    sent = [];
  store.putConnection(owner, {tenantId: owner.tenantId, enabled: false, isDefault: true, ...connection}, credentials);
  const discovery = new AssetDiscovery(store, async (url, init) => {
    const u = new URL(String(url));
    sent.push({method: init?.method ?? 'GET', url: u.origin + u.pathname + u.search});
    return answer(u, init) ?? json({}, 404);
  });
  return {store, discovery, sent, connection: store.listConnections(owner.tenantId)[0]};
}
const view = group => ({
  kind: group.kind,
  complete: group.complete,
  assets: group.assets.map(a => [a.id, a.name, a.parentId ?? null, a.currency ?? null, a.status ?? null]),
  codes: (group.diagnostics ?? []).map(d => d.code),
});

test('TikTok discovery: the advertisers its app reaches, and one page of a selected advertiser’s pixels or identities', async () => {
  const {store, discovery, sent, connection} = fixture(
    {id: 'tt-steps', gateway: 'tiktok_native_action', accounts: ['7001'], label: 'TikTok login', scopes: []},
    {accessToken: 'synthetic-access', clientId: 'app-1', clientSecret: 'app-secret'},
    u => {
      if (u.pathname.endsWith('/oauth2/advertiser/get/'))
        return json({code: 0, data: {list: [{advertiser_id: '7001', advertiser_name: 'Advertiser One'}]}});
      if (u.pathname.endsWith('/pixel/list/'))
        return json({
          code: 0,
          data: {pixels: [{pixel_id: 'px-1', pixel_name: 'Pixel One', status: 'ACTIVE'}], page_info: {total_page: 1}},
        });
      if (u.pathname.endsWith('/identity/get/'))
        return json({
          code: 0,
          data: {identity_list: [{identity_id: 'id-1', display_name: 'Identity'}], page_info: {total_page: 2}},
        });
    },
  );
  try {
    const found = await discovery.sync(connection, ['ad_accounts', 'pixels', 'identities']);
    assert.deepEqual(found.groups.map(view), [
      {kind: 'ad_accounts', complete: true, assets: [['7001', 'Advertiser One', null, null, null]], codes: []},
      {kind: 'pixels', complete: true, assets: [['px-1', 'Pixel One', '7001', null, 'ACTIVE']], codes: []},
      // An identity list that needs another page is refused for its kind, never truncated.
      {kind: 'identities', complete: false, assets: [], codes: ['ASSET_SYNC_LIMIT']},
    ]);
    assert.deepEqual(
      sent.map(s => s.method + ' ' + s.url.replace(/secret=[^&]+/, 'secret=<app>')),
      [
        'GET https://business-api.tiktok.com/open_api/v1.3/oauth2/advertiser/get/?app_id=app-1&secret=<app>',
        'GET https://business-api.tiktok.com/open_api/v1.3/pixel/list/?advertiser_id=7001&page=1&page_size=100',
        'GET https://business-api.tiktok.com/open_api/v1.3/identity/get/?advertiser_id=7001&page=1&page_size=100',
      ],
    );
  } finally {
    store.close();
  }
});

test('TikTok discovery refuses the advertiser list without the app’s credentials, before any request', async () => {
  const {store, discovery, sent, connection} = fixture(
    {id: 'tt-setup', gateway: 'tiktok_native_action', accounts: [], label: 'TikTok login', scopes: []},
    {accessToken: 'synthetic-access'},
    () => json({code: 0, data: {list: []}}),
  );
  try {
    const found = await discovery.sync(connection, ['ad_accounts', 'pixels']);
    assert.deepEqual(found.groups.map(view), [
      {kind: 'ad_accounts', complete: false, assets: [], codes: ['PROVIDER_SETUP_REQUIRED']},
      // An account edge needs a selected advertiser first.
      {kind: 'pixels', complete: false, assets: [], codes: ['SELECT_ACCOUNT_FIRST']},
    ]);
    assert.deepEqual(sent, []);
  } finally {
    store.close();
  }
});

test('Snapchat discovery: each organization’s ad accounts, public profiles, pixels, apps and catalogs', async () => {
  const records = {
    adaccounts: ['adaccount', {id: 'aa-1', name: 'Snap Account', currency: 'EUR', status: 'ACTIVE'}],
    public_profiles: ['public_profile', {id: 'pp-1', name: 'Profile'}],
    pixels: ['pixel', {id: 'sp-1', name: 'Snap Pixel'}],
    mobile_apps: ['mobile_app', {id: 'app-1', name: 'App'}],
    catalogs: ['catalog', {id: 'cat-1', name: 'Catalog'}],
  };
  const {store, discovery, sent, connection} = fixture(
    {
      id: 'snap-steps',
      gateway: 'snapchat_native_action',
      accounts: [],
      label: 'Snapchat login',
      scopes: ['snapchat-marketing-api'],
    },
    {accessToken: 'synthetic-access'},
    u => {
      if (u.pathname === '/v1/me/organizations') return json({organizations: [{organization: {id: 'org-1'}}]});
      const edge = u.pathname.replace('/v1/organizations/org-1/', '');
      if (records[edge]) return json({[edge]: [{[records[edge][0]]: records[edge][1]}]});
    },
  );
  try {
    const found = await discovery.sync(connection, ['ad_accounts', 'profiles', 'pixels', 'mobile_apps', 'catalogs']);
    assert.deepEqual(found.groups.map(view), [
      {kind: 'ad_accounts', complete: true, assets: [['aa-1', 'Snap Account', 'org-1', 'EUR', 'ACTIVE']], codes: []},
      {kind: 'profiles', complete: true, assets: [['pp-1', 'Profile', 'org-1', null, null]], codes: []},
      {kind: 'pixels', complete: true, assets: [['sp-1', 'Snap Pixel', 'org-1', null, null]], codes: []},
      {kind: 'mobile_apps', complete: true, assets: [['app-1', 'App', 'org-1', null, null]], codes: []},
      {kind: 'catalogs', complete: true, assets: [['cat-1', 'Catalog', 'org-1', null, null]], codes: []},
    ]);
    assert.deepEqual(
      sent.filter(s => !s.url.endsWith('/v1/me/organizations')).map(s => s.url),
      ['adaccounts', 'public_profiles', 'pixels', 'mobile_apps', 'catalogs'].map(
        edge => 'https://adsapi.snapchat.com/v1/organizations/org-1/' + edge,
      ),
    );
  } finally {
    store.close();
  }
});

test('X discovery: the login’s ad accounts, and a selected account’s promotable users, website tags and app lists', async () => {
  const {store, discovery, sent, connection} = fixture(
    {id: 'x-steps', gateway: 'x_ads_native_action', accounts: ['abc1'], label: 'X login', scopes: []},
    {consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', tokenSecret: 'ts'},
    u => {
      if (u.pathname === '/12/accounts') return json({data: [{id: 'abc1', name: 'X Account'}]});
      if (u.pathname === '/12/accounts/abc1/promotable_users')
        return json({data: [{user_id: '42', screen_name: 'brand'}]});
      if (u.pathname === '/12/accounts/abc1/website_tags') return json({data: [{id: 'tag-1', name: 'Site tag'}]});
      if (u.pathname === '/12/accounts/abc1/app_lists') return json({data: [{id: 'list-1', name: 'Apps'}]});
    },
  );
  try {
    const found = await discovery.sync(connection, ['ad_accounts', 'profiles', 'pixels', 'mobile_apps']);
    assert.deepEqual(found.groups.map(view), [
      {kind: 'ad_accounts', complete: true, assets: [['abc1', 'X Account', null, null, null]], codes: []},
      {kind: 'profiles', complete: true, assets: [['42', 'brand', 'abc1', null, null]], codes: []},
      {kind: 'pixels', complete: true, assets: [['tag-1', 'Site tag', 'abc1', null, null]], codes: []},
      {kind: 'mobile_apps', complete: true, assets: [['list-1', 'Apps', 'abc1', null, null]], codes: []},
    ]);
    assert.deepEqual(
      sent.map(s => s.url),
      [
        'https://ads-api.x.com/12/accounts?count=200',
        'https://ads-api.x.com/12/accounts/abc1/promotable_users?count=200',
        'https://ads-api.x.com/12/accounts/abc1/website_tags?count=200',
        'https://ads-api.x.com/12/accounts/abc1/app_lists?count=200',
      ],
    );
  } finally {
    store.close();
  }
});

test('Meta discovery: Pages and their Instagram accounts, and the selected ad accounts’ edges', async () => {
  const {store, discovery, sent, connection} = fixture(
    {id: 'meta-steps', gateway: 'meta_native_action', accounts: ['123'], label: 'Meta login', scopes: ['ads_read']},
    {accessToken: 'synthetic-access'},
    u => {
      if (u.pathname.endsWith('/me/accounts'))
        return json({
          data: [
            {id: 'page-1', name: 'Page One', instagram_business_account: {id: 'ig-1', username: 'brand'}},
            {id: 'page-2', name: 'Page Two'},
          ],
        });
      const edge = /\/act_123\/([a-z_]+)$/.exec(u.pathname)?.[1];
      if (edge) return json({data: [{id: edge + '-1', name: 'Edge ' + edge}]});
    },
  );
  try {
    const found = await discovery.sync(connection, [
      'pages',
      'instagram',
      'pixels',
      'catalogs',
      'mobile_apps',
      'custom_conversions',
    ]);
    assert.deepEqual(found.groups.map(view), [
      {
        kind: 'pages',
        complete: true,
        assets: [
          ['page-1', 'Page One', null, null, null],
          ['page-2', 'Page Two', null, null, null],
        ],
        codes: [],
      },
      {kind: 'instagram', complete: true, assets: [['ig-1', 'brand', 'page-1', null, null]], codes: []},
      {kind: 'pixels', complete: true, assets: [['adspixels-1', 'Edge adspixels', '123', null, null]], codes: []},
      {
        kind: 'catalogs',
        complete: true,
        assets: [['product_catalogs-1', 'Edge product_catalogs', '123', null, null]],
        codes: [],
      },
      {
        kind: 'mobile_apps',
        complete: true,
        assets: [['advertisable_applications-1', 'Edge advertisable_applications', '123', null, null]],
        codes: [],
      },
      {
        kind: 'custom_conversions',
        complete: true,
        assets: [['customconversions-1', 'Edge customconversions', '123', null, null]],
        codes: [],
      },
    ]);
    // Pages and Instagram read the same listing once each; each edge is read per selected ad account.
    assert.deepEqual(
      sent.map(s => s.url.replace(/\/v\d+\.0\//, '/<version>/')),
      [
        'https://graph.facebook.com/<version>/me/accounts?fields=id%2Cname%2Cinstagram_business_account%7Bid%2Cusername%7D&limit=100',
        'https://graph.facebook.com/<version>/me/accounts?fields=id%2Cname%2Cinstagram_business_account%7Bid%2Cusername%7D&limit=100',
        ...['adspixels', 'product_catalogs', 'advertisable_applications', 'customconversions'].map(
          edge => 'https://graph.facebook.com/<version>/act_123/' + edge + '?fields=id%2Cname&limit=100',
        ),
      ],
    );
  } finally {
    store.close();
  }
});
