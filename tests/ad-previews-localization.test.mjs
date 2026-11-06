// F-L3-10: every sentence the previews tool answers or refuses with, and which the Preview your ads page shows through
// uiText(), has Arabic in a catalog chunk that page loads. The sentences are collected from the tool's own answers
// (the shared notice, each platform's expiry and note, the Google Ads and X explanations, the platforms without a
// preview route) and from its refusals, so the test does not depend on where a sentence is written.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AdPreviews} from '../dist/src/ad-previews.js';
import {Store} from '../dist/src/store.js';
import {loaderFiles, chunksWith} from '../tools/locale-chunks.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

const actor = {tenantId: 'synthetic-preview-localization', userId: 'owner', role: 'admin'},
  login = 'aaaaaaaa-1111-4111-8111-000000000001';
const key = Buffer.alloc(32, 91).toString('base64'),
  catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
const chunks = chunksWith('ad-previews.js', loaderFiles().dependencies);
const loaded = new Set(
  [...chunks].flatMap(name => Object.keys(JSON.parse(readFileSync('web/locales/ar/' + name + '.json', 'utf8')))),
);

function storeFixture(t, gateway) {
  const store = new Store(':memory:', key);
  t.after(() => store.close());
  store.putConnection(
    actor,
    {
      id: login,
      tenantId: actor.tenantId,
      gateway,
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['ads_read', 'r_ads'],
    },
    {accessToken: 'synthetic'},
  );
  return store;
}
/** The answers a provider gives for the reads one platform's previews make; `later` is the preview expiry. */
const answers = {
  meta: input =>
    input.action === 'meta_ad_list'
      ? {data: [{id: '1', name: 'A', account_id: '100', effective_status: 'ACTIVE'}]}
      : {data: [{body: '<iframe src="https://www.facebook.com/ads/preview/1"></iframe>'}]},
  tiktok: input =>
    input.action === 'tiktok_ad_list'
      ? {
          code: 0,
          data: {
            list: [{ad_id: '1', ad_name: 'A', advertiser_id: '100', operation_status: 'ENABLE'}],
            page_info: {page: 1, page_size: 5, total_number: 1, total_page: 1},
          },
        }
      : {code: 0, data: {preview_link: 'https://ads.tiktok.com/preview/1'}},
  snapchat: input => {
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
    // An expired link: the page shows the note that Snapchat returned no usable link.
    return {creative_id: 'c1', expires_at: '2000-01-01T00:00:00Z', creative_preview_link: 'https://invalid.example/'};
  },
  linkedin: input =>
    input.action === 'linkedin_rest_ad_previews_get'
      ? {elements: [{preview: '<iframe src="https://www.linkedin.com/ads/preview/1"></iframe>'}, {preview: 'x'}]}
      : {elements: [{id: 'urn:li:sponsoredCreative:1', name: 'C', intendedStatus: 'ACTIVE'}]},
  reddit: () => ({
    data: [{id: 'a1', name: 'Ad', configured_status: 'ACTIVE', preview_url: 'https://www.reddit.com/p/1'}],
  }),
};
function run(t, platform, extra = {}) {
  const gateway = platform + '_native_action',
    store = storeFixture(t, gateway),
    previews = new AdPreviews(async (_tool, input) => {
      const body = answers[platform](input.operation ? input.arguments : input);
      return {success: true, data: {data: body}};
    }, store);
  return previews.handle({platform, account_id: '100', connection_id: login, ...extra}, actor);
}
/** The sentences of an answer that the page translates with uiText(). */
function sentences(out) {
  const found = new Set();
  const add = value => typeof value === 'string' && value && found.add(value);
  for (const key of ['meaning', 'not_found_reason', 'selection_note', 'explanation', 'next_step']) add(out[key]);
  for (const preview of out.previews ?? []) for (const key of ['expires', 'note']) add(preview[key]);
  return found;
}
const missing = texts => [...texts].filter(text => !Object.hasOwn(catalog, text) || !loaded.has(text)).sort();

test('every notice the tool answers with, on every platform, has Arabic in the chunks the page loads', async t => {
  const texts = new Set();
  for (const platform of ['meta', 'tiktok', 'snapchat', 'linkedin', 'reddit'])
    for (const text of sentences(await run(t, platform))) texts.add(text);
  // A named Snapchat creative the account does not list, and an unknown Reddit preview expiry.
  for (const text of sentences(await run(t, 'snapchat', {ad_ids: ['unlisted']}))) texts.add(text);
  // Platforms with no read: Google Ads names the reviewed write (with and without ad IDs), X says it is unqualified.
  const store = new Store(':memory:', key);
  t.after(() => store.close());
  for (const platform of ['google_ads', 'x_ads', 'microsoft_ads', 'dv360', 'criteo', 'apple_ads'])
    for (const ad_ids of [undefined, ['987654321']]) {
      const previews = new AdPreviews(async () => assert.fail('no read is made'), store);
      for (const text of sentences(
        await previews.handle({platform, account_id: '1', ...(ad_ids ? {ad_ids} : {})}, actor),
      ))
        texts.add(text);
    }
  // What the platforms say is covered once per sentence; the notices below are the ones the page showed in English.
  for (const text of [
    'Preview links open for anyone who has them and expire; share them only with people who may see these ads. AMCP does not store them.',
    'TikTok keeps an ad preview link for 30 days.',
    'This ad has no live preview link: Reddit disables it when preview_expiry is empty or past. Setting a new preview_expiry is a reviewed ad change.',
    'Replace ASSET_GROUP_ID with a Performance Max asset group ID, or pass adGroupAds resource names (customers/…/adGroupAds/…~…) of video ads in ad_ids.',
  ])
    assert.ok(texts.has(text), 'the answers carry: ' + text);
  assert.deepEqual(missing(texts), []);
});

test('every refusal sentence of the tool has Arabic in the chunks the page loads', async t => {
  const store = storeFixture(t, 'meta_native_action'),
    previews = new AdPreviews(async () => assert.fail('a refused request makes no read'), store),
    base = {platform: 'meta', account_id: '100', connection_id: login},
    texts = new Set();
  for (const [input, code] of [
    [{...base, extra: 1}, 'INVALID_ARGUMENT'],
    [{...base, action: 'unknown'}, 'INVALID_ARGUMENT'],
    [{...base, account_id: ' '}, 'INVALID_ARGUMENT'],
    [{...base, connection_id: 7}, 'INVALID_ARGUMENT'],
    [{...base, ad_ids: []}, 'INVALID_ARGUMENT'],
    [{...base, limit: 11}, 'INVALID_ARGUMENT'],
    [{...base, statuses: ['gone']}, 'INVALID_ARGUMENT'],
    [{...base, campaign_ids: []}, 'INVALID_ARGUMENT'],
    [{...base, ad_format: 'BILLBOARD'}, 'INVALID_ARGUMENT'],
    [{...base, platform: 'nowhere'}, 'INVALID_ARGUMENT'],
    [{...base, cursor: 'x'}, 'INVALID_CURSOR'],
    [{...base, platform: 'linkedin', campaign_ids: ['abc']}, 'INVALID_ARGUMENT'],
  ]) {
    const error = await previews.handle(input, actor).then(
      () => assert.fail('refused: ' + JSON.stringify(input)),
      e => e,
    );
    assertRefused(error, code);
    texts.add(error.message);
  }
  assert.deepEqual(missing(texts), []);
});
