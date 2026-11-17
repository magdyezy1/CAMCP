// Package r12-xpreview, review round (S3-1). An entry of amcp_ad_previews whose preview read failed lost what only the preview
// read had added: for X, the Tweet and the promoted Tweets the caller had named, so the mapping the caller needed was gone on
// exactly the path where it was needed (a 429 or a 5xx of the preview read). A row can now carry `fields` (AdPreviewRow in
// src/provider-adapter.ts, which names no provider), and the shared tool puts them in the entry whether its preview was read or
// refused. These tests hold both halves: an X entry keeps its identity when the read fails, and no other platform's entry, read or
// refused, gains a field or loses one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {AdPreviews} from '../dist/src/ad-previews.js';
import {Store} from '../dist/src/store.js';

const actor = {tenantId: 'synthetic-row-fields', userId: 'owner', role: 'admin'},
  login = 'aaaaaaaa-1111-4111-8111-000000000001',
  key = Buffer.alloc(32, 93).toString('base64'),
  tweet = n => '19000000000000' + String(n).padStart(5, '0');

function fixture(t, platform) {
  const store = new Store(':memory:', key);
  t.after(() => store.close());
  store.putConnection(
    actor,
    {
      id: login,
      tenantId: actor.tenantId,
      gateway: platform + '_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['ads_read', 'r_ads'],
    },
    {accessToken: 'synthetic'},
  );
  return store;
}
/** The native answer of a read the preview of each platform makes (the shapes of the platforms' documented responses). */
const refusal = {
  success: false,
  error: {code: 'UPSTREAM_ERROR', message: 'Synthetic refusal.', details: {http_status: 502}},
};
const answers = {
  meta: (input, failing) =>
    input.action === 'meta_ad_list'
      ? {data: [{id: '1', name: 'A', account_id: '100', effective_status: 'ACTIVE'}]}
      : failing
        ? refusal
        : {data: [{body: '<iframe src="https://www.facebook.com/ads/preview/1"></iframe>'}]},
  tiktok: (input, failing) =>
    input.action === 'tiktok_ad_list'
      ? {
          code: 0,
          data: {
            list: [{ad_id: '1', ad_name: 'A', advertiser_id: '100', operation_status: 'ENABLE'}],
            page_info: {page: 1, page_size: input.query.page_size, total_number: 1, total_page: 1},
          },
        }
      : failing
        ? refusal
        : {code: 0, data: {preview_link: 'https://ads.tiktok.com/preview/1'}},
  snapchat: (input, failing) => {
    if (input.action === 'snapchat_ad_list')
      return {
        request_status: 'SUCCESS',
        ads: [{sub_request_status: 'SUCCESS', ad: {id: 'a1', creative_id: 'c1', name: 'A', status: 'ACTIVE'}}],
      };
    if (input.action === 'snapchat_creative_list')
      return {
        request_status: 'SUCCESS',
        creatives: [{id: 'c1', name: 'C'}]
          .filter(creative => input.result_ids.includes(creative.id))
          .map(creative => ({sub_request_status: 'SUCCESS', creative})),
      };
    return failing
      ? refusal
      : {
          creative_id: 'c1',
          expires_at: '2999-01-01T00:00:00Z',
          creative_preview_link:
            'https://adsapi.snapchat.com/media/creative_preview?creative_id=c1&expires_at=' +
            Date.parse('2999-01-01T00:00:00Z') +
            '&signature=synthetic',
        };
  },
  linkedin: (input, failing) =>
    input.action === 'linkedin_rest_ad_previews_get'
      ? failing
        ? refusal
        : {elements: [{preview: '<iframe src="https://www.linkedin.com/ads/preview/1"></iframe>'}]}
      : {elements: [{id: 'urn:li:sponsoredCreative:1', name: 'C', intendedStatus: 'ACTIVE'}]},
};
/** One call of the tool for a platform, its preview read answering or refusing; the entries it returned. */
async function entries(t, platform, failing) {
  const previews = new AdPreviews(
    async (_tool, input) => {
      const native = input.operation ? input.arguments : input,
        body = answers[platform](native, failing);
      return body.success === false ? body : {success: true, data: {data: body}};
    },
    fixture(t, platform),
  );
  return (await previews.handle({platform, account_id: '100', connection_id: login}, actor)).previews;
}

test('an X entry keeps its Tweet and the promoted Tweets that share it when its preview read is refused', async t => {
  const store = fixture(t, 'x_ads'),
    promoted = id => ({
      id,
      tweet_id: tweet(1),
      line_item_id: 'li1',
      entity_status: 'ACTIVE',
      approval_status: 'ACCEPTED',
      deleted: false,
    });
  for (const failing of [false, true]) {
    const previews = new AdPreviews(async (_tool, input) => {
      if (input.action === 'x_accounts_account_id_promoted_tweets_get')
        return {success: true, data: {data: {next_cursor: null, data: [promoted('pt1'), promoted('pt2')]}}};
      return failing
        ? refusal
        : {
            success: true,
            data: {
              data: {
                data: [
                  {
                    tweet_id: tweet(1),
                    preview:
                      "<iframe class='tweet-preview' src='https://ton.twimg.com/ads-manager/tweet-preview/index.html?data=x'>",
                  },
                ],
              },
            },
          };
    }, store);
    const out = (await previews.handle({platform: 'x_ads', account_id: '100', connection_id: login}, actor)).previews;
    assert.equal(out.length, 1);
    // Read or refused, the entry says which Tweet it is and which promoted Tweets of the call share it.
    assert.deepEqual(
      [out[0].ad_id, out[0].tweet_id, out[0].promoted_tweet_ids],
      [tweet(1), tweet(1), ['pt1', 'pt2']],
      failing ? 'refused' : 'read',
    );
    assert.equal(out[0].links.length, failing ? 0 : 1);
    assert.equal(out[0].error !== undefined, failing);
  }
});

test('no other platform’s entry gains or loses a field, whether its preview was read or refused', async t => {
  // What each platform's entry holds. A refused read gives every platform the same four fields, and Snapchat's row also names its ad.
  const refused = platform =>
    ['ad_id', 'error', 'links', 'name', ...(platform === 'snapchat' ? ['source_ad_id'] : [])].sort();
  const read = {
    meta: ['ad_format', 'ad_id', 'links', 'name'],
    tiktok: ['ad_id', 'expires', 'links', 'name'],
    snapchat: ['ad_id', 'expires', 'expires_at', 'links', 'name', 'source_ad_id'],
    linkedin: ['ad_id', 'expires', 'expires_at', 'link', 'links', 'name', 'placements'],
  };
  for (const platform of Object.keys(read)) {
    const [ok] = await entries(t, platform, false),
      [bad] = await entries(t, platform, true);
    assert.deepEqual(Object.keys(ok).sort(), read[platform], platform + ' read');
    assert.deepEqual(Object.keys(bad).sort(), refused(platform), platform + ' refused');
    for (const entry of [ok, bad])
      for (const field of ['fields', 'tweet_id', 'promoted_tweet_ids'])
        assert.equal(entry[field], undefined, platform + ' has no ' + field);
  }
});
