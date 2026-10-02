import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const account = '123',
  campaign = '9007199254740993',
  group = '9007199254740995',
  ad = '9007199254740997';
const owner = {tenantId: 'google-portfolio', userId: 'reader', role: 'admin'};
const campaignRow = (id = campaign) => ({
  customer: {
    id: account,
    resourceName: 'customers/' + account,
    currencyCode: 'USD',
    timeZone: 'UTC',
    private: 'CANARY-CUSTOMER',
  },
  campaign: {
    id,
    name: 'Exact campaign',
    status: 'PAUSED',
    resourceName: `customers/${account}/campaigns/${id}`,
    campaignBudget: 'customers/123/campaignBudgets/20',
    private: 'CANARY-CAMPAIGN',
  },
  campaignBudget: {
    resourceName: 'customers/123/campaignBudgets/20',
    amountMicros: '9007199254740993',
    private: 'CANARY-BUDGET',
  },
  private: 'CANARY-ROW',
});
function fixture(t) {
  const actor = {...owner, role: 'reader'},
    store = new Store(':memory:', Buffer.alloc(32, 102).toString('base64'));
  t.after(() => store.close());
  const connection = {
    id: 'eeeeeeee-1111-4111-8111-111111111111',
    tenantId: actor.tenantId,
    gateway: 'google_ads_native_action',
    enabled: true,
    label: 'Synthetic Google',
    accounts: [account],
    scopes: ['https://www.googleapis.com/auth/adwords'],
  };
  const credentials = {accessToken: 'synthetic', developerToken: 'synthetic'};
  store.putConnection(owner, connection, credentials);
  const requests = [];
  let edit = (_query, data) => data;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (url, init) => {
        const query = JSON.parse(init.body).query;
        requests.push({url: String(url), method: init.method, query});
        let results;
        if (query.includes(' FROM ad_group_ad '))
          results = [
            {
              customer: {id: account, currencyCode: 'USD', timeZone: 'UTC'},
              campaign: {id: campaign, resourceName: `customers/123/campaigns/${campaign}`},
              adGroup: {id: group, resourceName: `customers/123/adGroups/${group}`},
              adGroupAd: {
                resourceName: `customers/123/adGroupAds/${group}~${ad}`,
                status: 'ENABLED',
                ad: {
                  id: ad,
                  name: 'Exact ad',
                  resourceName: `customers/123/ads/${ad}`,
                  type: 'RESPONSIVE_SEARCH_AD',
                  finalUrls: ['https://example.com/CANARY-URL'],
                  private: 'CANARY-AD',
                },
              },
            },
          ];
        else if (query.includes(' FROM ad_group '))
          results = [
            {
              customer: {id: account, currencyCode: 'USD', timeZone: 'UTC'},
              campaign: {id: campaign, resourceName: `customers/123/campaigns/${campaign}`},
              adGroup: {
                id: group,
                name: 'Exact group',
                status: 'PAUSED',
                resourceName: `customers/123/adGroups/${group}`,
                cpcBidMicros: '9007199254740993',
              },
            },
          ];
        else
          results = query.includes('campaign.id > ')
            ? [campaignRow('9007199254740995')]
            : [campaignRow(), campaignRow('9007199254740994'), campaignRow('9007199254740995')];
        return Response.json(edit(query, {results, private: 'CANARY-ENVELOPE'}));
      },
      async () => {},
    ),
  );
  return {
    store,
    actor,
    connection,
    credentials,
    requests,
    edit: fn => {
      edit = fn;
    },
    call: (requirements = {entity: 'campaign'}, extra = {}) =>
      service.call(
        'amcp_workspace',
        {
          action: 'portfolio',
          gateway: 'google_ads_native_action',
          account_id: account,
          connection_id: connection.id,
          limit: 2,
          requirements,
          ...extra,
        },
        actor,
      ),
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};

test('Google accepts an omitted empty ProtoJSON collection only with the exact requested field mask and no contradictory count', async t => {
  const f = fixture(t);
  const mask = q =>
    q
      .slice(7, q.indexOf(' FROM '))
      .split(', ')
      .map(field => field.replace(/_([a-z])/g, (_, c) => c.toUpperCase()))
      .join(',');
  f.edit((q, _data) => ({fieldMask: mask(q), totalResultsCount: '0'}));
  const empty = ok(await f.call());
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.has_more, false);
  for (const edit of [
    () => ({}),
    () => ({fieldMask: 'campaign.id'}),
    q => ({fieldMask: mask(q), totalResultsCount: '1'}),
    q => ({fieldMask: mask(q), results: null}),
  ]) {
    f.edit(edit);
    assert.equal((await f.call()).success, false);
  }
});

test('Google portfolio keeps exact IDs and micros while projecting selected native metadata and bounded hierarchy reads', async t => {
  const f = fixture(t),
    first = ok(await f.call());
  assert.equal(first.rows[0].id, campaign);
  assert.equal(first.rows[0].budget_micros, '9007199254740993');
  assert.doesNotMatch(JSON.stringify(first), /CANARY/);
  assert.equal(first.rows.length, 2);
  const second = ok(await f.call({entity: 'campaign'}, {cursor: first.next_cursor}));
  assert.equal(second.rows[0].id, '9007199254740995');
  const groups = ok(await f.call({entity: 'ad_group', campaign_id: campaign}));
  assert.equal(groups.rows[0].cpc_bid_micros, '9007199254740993');
  const ads = ok(await f.call({entity: 'ad', campaign_id: campaign, ad_group_id: group}));
  assert.equal(ads.rows[0].id, ad);
  assert.doesNotMatch(JSON.stringify(ads), /CANARY|finalUrls/);
  assert.ok(
    f.requests.every(
      r =>
        r.method === 'POST' &&
        /^https:\/\/googleads.googleapis.com\/v\d+\/customers\/123\/googleAds:search$/.test(r.url) &&
        r.query.includes('customer.id') &&
        !r.query.includes('final_urls'),
    ),
  );
  assert.equal(f.requests.length, 4);
});

test('Google continuation rejects tampering, noncanonical encoding, page-size changes, actor changes and expiry before network', async t => {
  const f = fixture(t),
    first = ok(await f.call()),
    decoded = JSON.parse(Buffer.from(first.next_cursor, 'base64url'));
  const tampered = Buffer.from(JSON.stringify({...decoded, after: '1'})).toString('base64url');
  for (const extra of [{cursor: tampered}, {cursor: first.next_cursor + '='}, {cursor: first.next_cursor, limit: 3}])
    assert.equal((await f.call({entity: 'campaign'}, extra)).success, false, JSON.stringify(extra));
  f.actor.userId = 'another-reader';
  assert.equal((await f.call({entity: 'campaign'}, {cursor: first.next_cursor})).success, false);
  f.actor.userId = owner.userId;
  const original = Date.now;
  try {
    Date.now = () => original() + 300001;
    assert.equal((await f.call({entity: 'campaign'}, {cursor: first.next_cursor})).success, false);
  } finally {
    Date.now = original;
  }
  assert.equal(f.requests.length, 1);
});

test('Google inventory refuses replacement credentials and withdrawn scopes during a response', async t => {
  for (const change of ['credentials', 'scope', 'account']) {
    const f = fixture(t);
    f.edit((_q, data) => {
      f.store.putConnection(
        owner,
        {...f.connection, ...(change === 'scope' ? {scopes: []} : change === 'account' ? {accounts: []} : {})},
        change === 'credentials' ? {...f.credentials, accessToken: 'replacement'} : f.credentials,
      );
      return data;
    });
    assert.equal((await f.call()).success, false, change);
    assert.equal(f.requests.length, 1);
  }
});

test('Google portfolio refuses changed authorization between continuation pages', async t => {
  const f = fixture(t),
    first = ok(await f.call());
  f.store.putConnection(owner, f.connection, {...f.credentials, accessToken: 'replacement'});
  assert.equal((await f.call({entity: 'campaign'}, {cursor: first.next_cursor})).success, false);
  assert.equal(f.requests.length, 1);
});

test('Google inventory validates account, native resource identities and integer money before returning any row', async t => {
  const mutations = [
    r => (r.customer.id = '456'),
    r => (r.campaign.resourceName = 'customers/456/campaigns/' + campaign),
    r => (r.campaign.id = 9007199254740992),
    r => (r.campaignBudget.amountMicros = 9007199254740992),
    r => (r.campaignBudget.amountMicros = '1.5'),
    r => (r.campaignBudget.amountMicros = '9223372036854775808'),
    r => (r.campaignBudget.resourceName = 'customers/123/campaignBudgets/21'),
    r => (r.campaign.status = {bad: true}),
    r => (r.customer.currencyCode = 'not-currency'),
  ];
  for (const mutate of mutations) {
    const f = fixture(t);
    f.edit((_q, data) => {
      mutate(data.results[0]);
      return data;
    });
    assert.equal((await f.call()).success, false, mutate.toString());
    assert.equal(f.requests.length, 1);
  }
});

test('Google scoped children reject foreign parents and malformed leaf resource names', async t => {
  for (const mutate of [
    r => (r.campaign.id = '2'),
    r => (r.adGroup.id = '3'),
    r => (r.adGroupAd.resourceName = `customers/456/adGroupAds/${group}~${ad}`),
    r => (r.adGroupAd.ad.resourceName = 'customers/123/ads/1'),
  ]) {
    const f = fixture(t);
    f.edit((_q, data) => {
      mutate(data.results[0]);
      return data;
    });
    assert.equal((await f.call({entity: 'ad', campaign_id: campaign, ad_group_id: group})).success, false);
    assert.equal(f.requests.length, 1);
  }
});

test('Google inventory rejects unexpected continuation, partial envelopes, duplicate and descending rows', async t => {
  const edits = [
    d => ({...d, nextPageToken: 'unexpected'}),
    d => ({...d, partialFailureError: {message: 'partial'}}),
    d => ({...d, truncated: true}),
    d => ({...d, results: [d.results[0], d.results[0]]}),
    d => ({...d, results: d.results.toReversed()}),
  ];
  for (const edit of edits) {
    const f = fixture(t);
    f.edit((_q, d) => edit(d));
    assert.equal((await f.call()).success, false);
    assert.equal(f.requests.length, 1);
  }
});

test('Google inventory validates numeric inputs before egress and preserves unknown optional fields without inventing defaults', async t => {
  const f = fixture(t);
  for (const requirements of [
    {entity: 'campaign', campaign_id: campaign},
    {entity: 'ad_group', campaign_id: '01'},
    {entity: 'ad', campaign_id: campaign, ad_group_id: '1 OR 1=1'},
  ])
    assert.equal((await f.call(requirements)).success, false);
  assert.equal(f.requests.length, 0);
  f.edit((_q, d) => ({
    results: [{customer: {id: account}, campaign: {id: campaign, resourceName: `customers/123/campaigns/${campaign}`}}],
  }));
  const r = ok(await f.call());
  for (const key of ['status', 'currency', 'timezone', 'budget_micros', 'cpc_bid_micros'])
    assert.equal(r.rows[0][key], null, key);
  assert.equal(r.rows[0].name, campaign);
});
