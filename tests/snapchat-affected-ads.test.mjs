import test from 'node:test';
import assert from 'node:assert/strict';
import {snapchatAffectedAds, snapAffectedAdPages} from '../dist/src/snapchat-affected-ads.js';

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
