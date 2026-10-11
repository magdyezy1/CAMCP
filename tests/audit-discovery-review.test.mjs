import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {AssetDiscovery} from '../dist/server/asset-discovery.js';
import {PlatformOAuth} from '../dist/server/platform-oauth.js';
import {WebStore} from '../dist/server/web-store.js';
import {reauthorizeGoogleConnection, googleAdsScope} from '../dist/server/google-reauthorization.js';
import {normalizeSnapshot, reviewStateHash} from '../dist/src/review-state.js';
import {compileEntityRead} from '../dist/src/workflows.js';
import {assertRefused} from './helpers/assert-refused.mjs';
const key = Buffer.alloc(32, 65).toString('base64'),
  actor = {tenantId: 'local', userId: 'owner', role: 'admin'};
const setup = gateway => {
  const store = new Store(':memory:', key),
    c = {
      id: 'login',
      tenantId: 'local',
      gateway,
      accounts: [],
      enabled: false,
      label: 'Synthetic',
      scopes: [],
      userAgent: 'server:amcp-test:0.1.0 (local fixtures)',
    };
  store.putConnection(actor, c, {accessToken: 'synthetic'});
  return {store, c};
};

for (const platform of ['reddit', 'dv360'])
  test(
    platform + ' onboarding discovers parent-scoped accounts, paginates and retains unrelated successes',
    async () => {
      const {store, c} = setup(platform === 'reddit' ? 'reddit_native_action' : 'dv360_native_action'),
        reddit = platform === 'reddit',
        requests = [];
      try {
        const discovery = new AssetDiscovery(store, async url => {
          const u = new URL(String(url));
          requests.push(u.href);
          if (u.pathname === '/api/v3/me/businesses')
            return Response.json({data: [{id: 'business-1'}, {id: 'business-2'}]});
          if (u.pathname === '/v4/partners') return Response.json({partners: [{partnerId: '1'}, {partnerId: '2'}]});
          if (u.pathname.includes('business-2') || u.searchParams.get('partnerId') === '2')
            return Response.json({error: {message: 'Synthetic denial'}}, {status: 403});
          const second = u.searchParams.has(reddit ? 'after' : 'pageToken');
          if (reddit)
            return Response.json({
              data: [
                {
                  id: second ? 'a2_second' : 'a2_first',
                  name: 'Account ' + Number(second),
                  business_id: 'business-1',
                  currency: 'USD',
                },
              ],
              pagination: second
                ? {}
                : {next_url: 'https://ads-api.reddit.com/api/v3/businesses/business-1/ad_accounts?after=next'},
            });
          assert.equal(u.searchParams.get('partnerId'), '1');
          return Response.json({
            advertisers: [
              {
                advertiserId: second ? '102' : '101',
                partnerId: '1',
                displayName: 'Advertiser',
                entityStatus: 'ENTITY_STATUS_PAUSED',
                generalConfig: {currencyCode: 'USD', timeZone: 'UTC'},
              },
            ],
            ...(second ? {} : {nextPageToken: 'next'}),
          });
        });
        const group = (await discovery.sync(c)).groups[0];
        assert.equal(group.complete, false);
        assert.equal(group.assets.length, 2);
        assert.equal(group.diagnostics.length, 1);
        assert.equal(requests.length, 4);
        assert.deepEqual(store.listConnections('local')[0].accounts, [], 'Discovery never grants selection');
      } finally {
        store.close();
      }
    },
  );
test('discovery rejects cross-parent identities and malicious Reddit pagination before another request', async () => {
  for (const mode of ['parent', 'pagination']) {
    const {store, c} = setup('reddit_native_action');
    let calls = 0;
    try {
      const group = (
        await new AssetDiscovery(store, async () => {
          calls++;
          return calls === 1
            ? Response.json({data: [{id: 'business-1'}]})
            : mode === 'parent'
              ? Response.json({data: [{id: 'a2_bad', business_id: 'other'}]})
              : Response.json({data: [], pagination: {next_url: 'https://evil.invalid/steal?after=x'}});
        }).sync(c)
      ).groups[0];
      assert.equal(group.complete, false);
      assert.equal(group.assets.length, 0);
      assert.equal(calls, 2);
    } finally {
      store.close();
    }
  }
});
test('Reddit authorization requests permanent access and rejects ephemeral tokens', async () => {
  const store = new Store(':memory:', key),
    web = new WebStore(store, {
      origin: 'https://amcp.example',
      masterKey: key,
      adminPassword: 'synthetic-password-for-test',
    }),
    session = await web.signIn('synthetic-password-for-test', '127.0.0.1');
  const oauth = new PlatformOAuth(
    web,
    {AMCP_REDDIT_CLIENT_ID: 'synthetic', AMCP_REDDIT_CLIENT_SECRET: 'synthetic'},
    async () => Response.json({access_token: 'synthetic', expires_in: 3600}),
  );
  try {
    const start = await oauth.start(session, 'reddit');
    assert.equal(new URL(start.url).searchParams.get('duration'), 'permanent');
    await assert.rejects(
      () =>
        oauth.exchange('reddit', {redirectUri: 'https://amcp.example/api/auth/reddit/callback'}, {code: 'synthetic'}),
      e => e.code === 'OFFLINE_ACCESS_REQUIRED',
    );
  } finally {
    store.close();
  }
});
test('unrelated denied Google root does not prevent successful selected-account reauthorization', async () => {
  const {store, c} = setup('google_ads_native_action');
  const old = {accessToken: 'old', refreshToken: 'old-refresh', clientId: 'synthetic', clientSecret: 'synthetic'},
    fresh = {...old, accessToken: 'new', refreshToken: 'new-refresh'};
  store.putConnection(
    actor,
    {...c, enabled: true, accounts: ['100'], writeAccounts: ['100'], scopes: [googleAdsScope]},
    old,
  );
  try {
    await reauthorizeGoogleConnection({
      store,
      actor,
      connectionId: c.id,
      credentials: fresh,
      scopes: [googleAdsScope],
      revision: null,
      allowWrites: true,
      assertActive: () => {},
      fetcher: async url =>
        String(url).endsWith(':listAccessibleCustomers')
          ? Response.json({resourceNames: ['customers/100', 'customers/200']})
          : String(url).includes('/customers/200/')
            ? Response.json({error: {message: 'Unrelated account denied'}}, {status: 403})
            : Response.json({
                results: [
                  {customer: {id: '100', manager: false, status: 'ENABLED', currencyCode: 'USD', timeZone: 'UTC'}},
                ],
              }),
    });
    assert.equal(store.credentials('local', c.id).accessToken, 'new');
    assert.deepEqual(store.listConnections('local')[0].writeAccounts, ['100']);
  } finally {
    store.close();
  }
});
test('review comparison treats GAQL rows by identity while protecting meaningful ordered configuration', () => {
  const read = {
    gateway: 'google_ads_native_action',
    body: {
      query:
        "SELECT campaign.resource_name, campaign.name FROM campaign WHERE campaign.resource_name IN ('customers/1/campaigns/2','customers/1/campaigns/3')",
    },
  };
  const rows = [
    {campaign: {resourceName: 'customers/1/campaigns/2', name: 'First'}},
    {campaign: {resourceName: 'customers/1/campaigns/3', name: 'Second'}},
  ];
  assert.equal(
    reviewStateHash(normalizeSnapshot(read, {results: rows})),
    reviewStateHash(normalizeSnapshot(read, {results: [...rows].reverse()})),
  );
  for (const bad of [[rows[0], rows[0]], [rows[0]], [{campaign: {name: 'Missing identity'}}]])
    assert.throws(
      () => normalizeSnapshot(read, {results: bad}),
      e => assertRefused(e, ['STATE_RESOURCE_INVALID', 'STATE_RESOURCE_MISMATCH']),
    );
  const changed = structuredClone(rows);
  changed[1].campaign.name = 'Meaningful change';
  assert.notEqual(
    reviewStateHash(normalizeSnapshot(read, {results: rows})),
    reviewStateHash(normalizeSnapshot(read, {results: changed})),
  );
  assert.notEqual(reviewStateHash({carousel: ['A', 'B']}), reviewStateHash({carousel: ['B', 'A']}));
  assert.equal(reviewStateHash({countries: ['US', 'GB']}), reviewStateHash({countries: ['GB', 'US']}));
  const dv = compileEntityRead('fetch_adsets', {
    platform: 'dv360',
    account_id: '1',
    campaign_id: '2',
    status_filter: 'PAUSED',
  });
  assert.match(JSON.stringify(dv), /campaignId/);
  assert.match(JSON.stringify(dv), /AND/);
});
