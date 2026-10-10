import test from 'node:test';
import assert from 'node:assert/strict';
import {snapchatAffectedAds, snapAffectedAdPages, snapAffectedAdsListed} from '../dist/src/snapchat-affected-ads.js';

/**
 * WRT-05 Stage C: a Snapchat creative edit returned affected_ad_ids: null although ads carry creative_id and the
 * account's ads list is readable. The review now lists them from a bounded read; past 25 pages it says the list is
 * incomplete instead of returning part of it.
 */
const plan = {
  gateway: 'snapchat_native_action',
  accountId: 'acct1',
  action: 'snapchat_creative_update',
  method: 'PATCH',
  path: '/v1/adaccounts/acct1/creatives/cr1',
  query: {},
  body: [],
  headers: {},
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  warnings: [],
};
const page = (ads, next) => ({
  status: 200,
  headers: {},
  data: {
    request_status: 'SUCCESS',
    ads: ads.map(ad => ({sub_request_status: 'SUCCESS', ad})),
    ...(next
      ? {paging: {next_link: 'https://adsapi.snapchat.com/v1/adaccounts/acct1/ads?limit=1000&cursor=' + next}}
      : {}),
  },
});

test('two ads sharing the creative are listed across pages, each read read-only and bound to the account', async () => {
  const reads = [];
  const out = await snapchatAffectedAds(plan, ['cr1'], async request => {
    reads.push(request);
    return reads.length === 1
      ? page([{id: 'a1', name: 'One', status: 'ACTIVE', ad_squad_id: 's1', creative_id: 'cr1'}], 'c2')
      : page([
          {id: 'a2', name: 'Two', status: 'PAUSED', ad_squad_id: 's2', creative_id: 'cr1'},
          {id: 'a3', name: 'Other', status: 'ACTIVE', ad_squad_id: 's2', creative_id: 'cr2'},
        ]);
  });
  assert.deepEqual(out.affected_ad_ids, ['a1', 'a2']);
  assert.equal(out.incomplete, false);
  assert.equal(out.pages_read, 2);
  assert.deepEqual(
    reads.map(r => [r.method, r.path, r.query.cursor ?? null, r.readOnly]),
    [
      ['GET', '/v1/adaccounts/acct1/ads', null, true],
      ['GET', '/v1/adaccounts/acct1/ads', 'c2', true],
    ],
  );
});

test('a widely shared creative names every ad but details at most 100 of them', async () => {
  const out = await snapchatAffectedAds(plan, ['cr1'], async () =>
    page(Array.from({length: 250}, (_, i) => ({id: 'a' + i, name: 'Ad ' + i, status: 'ACTIVE', creative_id: 'cr1'}))),
  );
  assert.equal(out.affected_ad_ids.length, 250);
  assert.equal(out.affected_ads.length, snapAffectedAdsListed);
  assert.deepEqual(
    out.affected_ads.map(a => a.id),
    out.affected_ad_ids.slice(0, snapAffectedAdsListed),
  );
  assert.equal(out.affected_ad_count, 250);
  assert.equal(out.listed_truncated, true);
  assert.equal(out.incomplete, false);
  const few = await snapchatAffectedAds(plan, ['cr1'], async () => page([{id: 'a1', creative_id: 'cr1'}]));
  assert.deepEqual([few.affected_ads.length, few.affected_ad_count, few.listed_truncated], [1, 1, false]);
});

test('an account with more ad pages than the bound gives null and incomplete, never a partial list', async () => {
  let reads = 0;
  const out = await snapchatAffectedAds(plan, ['cr1'], async () => {
    reads++;
    return page([{id: 'a' + reads, creative_id: 'cr1'}], 'next' + reads);
  });
  assert.equal(reads, snapAffectedAdPages);
  assert.deepEqual(
    {ids: out.affected_ad_ids, ads: out.affected_ads, incomplete: out.incomplete, enumeration: out.enumeration},
    {ids: null, ads: null, incomplete: true, enumeration: 'bound_exceeded'},
  );
});

test('a continuation to another account or a malformed page is refused', async () => {
  for (const data of [
    {
      request_status: 'SUCCESS',
      ads: [],
      paging: {next_link: 'https://adsapi.snapchat.com/v1/adaccounts/other/ads?cursor=x'},
    },
    {request_status: 'SUCCESS', ads: [], paging: {next_link: 'https://evil.example/v1/adaccounts/acct1/ads?cursor=x'}},
    {request_status: 'SUCCESS', ads: [{sub_request_status: 'ERROR'}]},
    {request_status: 'ERROR', ads: []},
  ])
    await assert.rejects(
      snapchatAffectedAds(plan, ['cr1'], async () => ({status: 200, headers: {}, data})),
      {code: 'SNAPCHAT_ADS_READ_INVALID'},
    );
});

test('a failed ads read leaves the list unknown and does not refuse the review', async () => {
  const {Store} = await import('../dist/src/store.js');
  const {Registry} = await import('../dist/src/catalog.js');
  const {MirrorService} = await import('../dist/src/service.js');
  const {NativeTransport} = await import('../dist/src/transport.js');
  const store = new Store(':memory:', Buffer.alloc(32, 44).toString('base64')),
    actor = {tenantId: 't', userId: 'u', role: 'admin'},
    connection = {
      id: 'c',
      tenantId: 't',
      gateway: 'snapchat_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      scopes: [],
      enabled: true,
      label: 'Synthetic',
    };
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  store.rememberResource(connection, '123', 'creatives/creative1');
  const row = {id: 'creative1', ad_account_id: '123', type: 'WEB_VIEW', name: 'Before', headline: 'Before'};
  let adsReads = 0;
  const transport = new NativeTransport(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/adaccounts/123/ads') {
      adsReads++;
      return Response.json({request_status: 'ERROR', debug_message: 'Unavailable'}, {status: 400});
    }
    return Response.json({request_status: 'SUCCESS', creatives: [{sub_request_status: 'SUCCESS', creative: row}]});
  });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  try {
    const prepared = await service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway: 'snapchat_native_action',
        arguments: {
          action: 'snapchat_adaccounts_ad_account_id_creatives_update',
          account_id: '123',
          payload: {creatives: [{...row, name: 'After'}]},
        },
      },
      actor,
    );
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 800));
    assert.equal(adsReads, 1);
    const impact = prepared.data.creative_impact;
    assert.deepEqual(
      [impact.affected_ad_ids, impact.incomplete, impact.enumeration, typeof impact.read_error],
      [null, true, 'read_failed', 'string'],
    );
  } finally {
    store.close();
  }
});
