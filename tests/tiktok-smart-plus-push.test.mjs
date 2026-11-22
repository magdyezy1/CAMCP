import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {
  pushFixture,
  gateway,
  TIKTOK,
  ad,
  post,
  video,
  carousel,
  bc,
  texts,
} from './fixtures/tiktok-smart-plus-push.mjs';

/**
 * Upgraded Smart+ Spark Ads: up to 50 creatives, Spark Ads Push (an uploaded video with its cover, or carousel images with music,
 * published as a post of the identity), ad texts, the dark-post choice, and the edits of a Push ad (package r25-m4b-smartpush; API for
 * Business v1.3 "Create an Upgraded Smart+ Ad", "Update an Upgraded Smart+ Ad" and "Upgraded Smart+ ad creative combinations by
 * identity and ad type", read 2026-11-21). The synthetic advertiser is tests/fixtures/tiktok-smart-plus-push.mjs.
 */
async function withFixture(body) {
  const f = pushFixture();
  try {
    return await body(f);
  } finally {
    f.store.close();
  }
}
const posts = (count, from = 9600) => Array.from({length: count}, (_, i) => post(String(from + i)));

test('a Spark Ad from 50 existing posts is reviewed, created once and verified (A1: "Size range: 1-50")', async () =>
  withFixture(async f => {
    const p = await f.prepared(ad(posts(50)));
    const x = await f.execute(p.data.review_id);
    assert.equal(x.success, true, JSON.stringify(x.error ?? x).slice(0, 600));
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].creative_list.length, 50);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
  }));

test('a read-back that gives a TikTok account identity the Business Center "0" (the page\'s own example) is the ad that was sent', async () =>
  withFixture(async f => {
    // "Create an Upgraded Smart+ Ad" returns identity_authorized_bc_id "0" for a TT_USER creative, and AMCP sent none.
    const p = await f.prepared(ad([post('9001'), post('9002', 'CAROUSEL_ADS')]));
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal(f.ads[5601].creative_list[0].creative_info.identity_authorized_bc_id, '0');
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v.data.checks));
  }));

test('51 existing posts are refused before any request, and the refusal names the limit of 50', async () =>
  withFixture(async f => {
    const r = await f.prepare(ad(posts(51)));
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.equal(r.error.details.field, 'creative_list');
    assert.match(r.error.message, /1-50/);
    assert.equal(f.requests.length, 0);
  }));

test('the posts of one identity are read 20 at a time, the most "Get info about TikTok posts" takes (item_ids: Max size 20)', async () =>
  withFixture(async f => {
    const p = await f.prepared(ad(posts(50)));
    const reads = f.queries.filter(q => q.path === '/v1.3/identity/video/info/');
    assert.deepEqual(
      reads.map(q => JSON.parse(new URLSearchParams(q.search).get('item_ids')).length),
      [20, 20, 10],
    );
    // Every post is checked against the identity: one that is not among its posts is still refused, whichever chunk it is in.
    const stray = await f.prepare(ad([...posts(30), post('9999')]));
    assert.equal(stray.error?.code, 'STATE_TARGET_MISMATCH', JSON.stringify(stray.error ?? stray.data).slice(0, 300));
    assert.ok(p.data.review_id);
    assert.equal(f.writes.length, 0);
  }));

// ---------------------------------------------------------------------------------------------------------------------------
// The shape of a Push creative, its ad texts and the dark-post choice: checked before any request (inspect makes none).
// ---------------------------------------------------------------------------------------------------------------------------
const inspect = (f, payload, action) =>
  f.call('amcp_write', {action: 'inspect', gateway, connection_id: TIKTOK, arguments: f.args(payload, action)});
const without = (creative, ...keys) => {
  const ci = {...creative.creative_info};
  for (const k of keys) delete ci[k];
  return {creative_info: ci};
};
const videos = (count, from = 1) =>
  Array.from({length: count}, (_, i) => video('v-' + (from + i), 'img-' + (from + i)));

test('Push creatives that satisfy the page are accepted by the contract: a video with its cover, carousel images with music, both, under either identity', async () =>
  withFixture(async f => {
    const cases = {
      'a video with its cover and two ad texts': ad([video('v-1', 'img-1')], {
        ad_text_list: texts('Spring sale', 'Free delivery'),
      }),
      'a carousel of two images with its music': ad([carousel(['img-2', 'img-3'], 'mus-1')], {
        ad_text_list: texts('Swipe'),
      }),
      'videos and carousels together (the appendix allows the combination)': ad([video('v-1'), carousel()], {
        ad_text_list: texts('A', 'B', 'C', 'D', 'E'),
      }),
      'the Business Center identity of the reference ad': ad([video('v-1', 'img-1', bc)], {
        ad_text_list: texts('Spring sale'),
      }),
      'a carousel of 35 images': ad([carousel(Array.from({length: 35}, (_, i) => 'img-' + (i + 1)))], {
        ad_text_list: texts('Swipe'),
      }),
      'ads only stated': ad([video('v-1')], {ad_text_list: texts('A')}, {dark_post_status: 'ON'}),
      'the post also on the profile, stated': ad([video('v-1')], {ad_text_list: texts('A')}, {dark_post_status: 'OFF'}),
      'a carousel named by the caller': ad([carousel(['img-2', 'img-3'], 'mus-1', {material_name: 'Spring set'})], {
        ad_text_list: texts('A'),
      }),
      'the same video with two covers': ad([video('v-1', 'img-1'), video('v-1', 'img-2')], {ad_text_list: texts('A')}),
      '50 uploaded videos': ad(videos(50), {ad_text_list: texts('A')}),
    };
    for (const [name, payload] of Object.entries(cases)) {
      const r = await inspect(f, payload);
      assert.equal(
        r.data?.review_contract_supported,
        true,
        name + ': ' + JSON.stringify(r.data?.error ?? r).slice(0, 500),
      );
    }
    assert.equal(f.requests.length, 0);
  }));

test('the shape of a Push creative: every rule of the pages is a refusal with its own field, before any request', async () =>
  withFixture(async f => {
    const withTexts = (list, config = {}) => ad(list, {ad_text_list: texts('A')}, config);
    const v = video('v-1', 'img-1'),
      c = carousel(['img-2', 'img-3'], 'mus-1'),
      ci = 'creative_list[0].creative_info.';
    const cases = {
      'a video without its cover': [withTexts([without(v, 'image_info')]), ci + 'image_info'],
      'a video with two covers': [
        withTexts([{creative_info: {...v.creative_info, image_info: [{web_uri: 'img-1'}, {web_uri: 'img-2'}]}}]),
        ci + 'image_info',
      ],
      'a cover that names no image': [
        withTexts([{creative_info: {...v.creative_info, image_info: [{web_uri: ''}]}}]),
        ci + 'image_info',
      ],
      'a cover with a key of its own': [
        withTexts([{creative_info: {...v.creative_info, image_info: [{web_uri: 'img-1', height: 1}]}}]),
        ci + 'image_info',
      ],
      'a video that names no video': [
        withTexts([{creative_info: {...v.creative_info, video_info: {video_id: ''}}}]),
        ci + 'video_info',
      ],
      'a video with a key of its own (a thumbnail mode is for Search campaigns)': [
        withTexts([{creative_info: {...v.creative_info, video_info: {video_id: 'v-1', thumbnail_mode: 'MANUAL'}}}]),
        ci + 'video_info',
      ],
      'a carousel without music': [withTexts([without(c, 'music_info')]), ci + 'music_info'],
      'a carousel with music that names none': [
        withTexts([{creative_info: {...c.creative_info, music_info: {music_id: ''}}}]),
        ci + 'music_info',
      ],
      'a carousel without images': [withTexts([without(c, 'image_info')]), ci + 'image_info'],
      'a carousel of 36 images': [
        withTexts([carousel(Array.from({length: 36}, (_, i) => 'img-' + (i + 1)))]),
        ci + 'image_info',
      ],
      'music on a video': [
        withTexts([{creative_info: {...v.creative_info, music_info: {music_id: 'mus-1'}}}]),
        ci + 'music_info',
      ],
      'a carousel name on a video': [
        withTexts([{creative_info: {...v.creative_info, material_name: 'x'}}]),
        ci + 'material_name',
      ],
      'a carousel name over 255 characters': [
        withTexts([{creative_info: {...c.creative_info, material_name: 'x'.repeat(256)}}]),
        ci + 'material_name',
      ],
      'a post and a video in one creative': [
        ad([{creative_info: {...v.creative_info, tiktok_item_id: '9001'}}]),
        ci + 'video_info',
      ],
      'a post and images in one creative': [
        ad([{creative_info: {...post('9001').creative_info, image_info: [{web_uri: 'img-1'}]}}]),
        ci + 'image_info',
      ],
      'a post and music in one creative': [
        ad([{creative_info: {...post('9001').creative_info, music_info: {music_id: 'mus-1'}}}]),
        ci + 'music_info',
      ],
      'a single video that is images and music': [
        withTexts([{creative_info: {...c.creative_info, ad_format: 'SINGLE_VIDEO'}}]),
        ci + 'ad_format',
      ],
      'a carousel that is a video': [
        withTexts([{creative_info: {...v.creative_info, ad_format: 'CAROUSEL_ADS'}}]),
        ci + 'ad_format',
      ],
      'an authorization-code identity cannot push': [
        withTexts([{creative_info: {...v.creative_info, identity_type: 'AUTH_CODE', identity_id: 'ac-1'}}]),
        ci + 'identity_type',
      ],
      'a custom identity': [
        withTexts([{creative_info: {...v.creative_info, identity_type: 'CUSTOMIZED_USER'}}]),
        ci + 'identity_type',
      ],
      'a Business Center identity without its Business Center': [
        withTexts([without({creative_info: {...v.creative_info, ...bc}}, 'identity_authorized_bc_id')]),
        ci + 'identity_authorized_bc_id',
      ],
      'the same creative twice': [withTexts([v, v]), 'creative_list[1].creative_info.video_info'],
      'posts and uploads in one list (the appendix has no such combination)': [
        ad([post('9001'), v], {ad_text_list: texts('A')}),
        'creative_list',
      ],
      '51 uploaded videos': [withTexts(videos(51)), 'creative_list'],
      'no ad texts': [ad([v]), 'ad_text_list'],
      'an empty list of ad texts': [ad([v], {ad_text_list: []}), 'ad_text_list'],
      'six ad texts': [ad([v], {ad_text_list: texts('1', '2', '3', '4', '5', '6')}), 'ad_text_list'],
      'a blank ad text': [ad([v], {ad_text_list: texts('  ')}), 'ad_text_list'],
      'an ad text that is no text': [ad([v], {ad_text_list: [{ad_text: 5}]}), 'ad_text_list'],
      'an ad text entry with a key of its own': [
        ad([v], {ad_text_list: [{ad_text: 'A', language: 'ar'}]}),
        'ad_text_list',
      ],
      'ad texts that are no list': [ad([v], {ad_text_list: 'Sale'}), 'ad_text_list'],
      'a dark-post status that is neither ON nor OFF': [
        withTexts([v], {dark_post_status: 'MAYBE'}),
        'ad_configuration.dark_post_status',
      ],
    };
    for (const [name, [payload, field]] of Object.entries(cases)) {
      const r = await f.prepare(payload);
      assert.equal(
        r.error?.code,
        'INVALID_TIKTOK_SMART_PLUS_AD',
        name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 400),
      );
      assert.equal(r.error.details?.field, field, name);
    }
    assert.equal(f.requests.length, 0);
  }));

test('what a post-based ad refuses stays refused: ad texts, the profile post and the Push keys on a post', async () =>
  withFixture(async f => {
    const cases = {
      'ad texts on an ad of posts (it uses the post text)': [
        ad([post('9001')], {ad_text_list: texts('Sale')}),
        'ad_text_list',
      ],
      'an empty ad text list on an ad of posts': [ad([post('9001')], {ad_text_list: []}), 'ad_text_list'],
      'the post also on the profile, for an ad of posts (dark_post_status is for Push)': [
        ad([post('9001')], {}, {dark_post_status: 'OFF'}),
        'ad_configuration.dark_post_status',
      ],
    };
    for (const [name, [payload, field]] of Object.entries(cases)) {
      const r = await f.prepare(payload);
      assert.equal(
        r.error?.code,
        'INVALID_TIKTOK_SMART_PLUS_AD',
        name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 400),
      );
      assert.equal(r.error.details?.field, field, name);
    }
    assert.match(
      (await f.prepare(ad([post('9001')], {ad_text_list: texts('Sale')}))).error.message,
      /Spark Ads from existing posts use the post text/,
    );
    // ads only, stated, is what a read of any ad carries and stays accepted for posts
    const on = await inspect(f, ad([post('9001')], {}, {dark_post_status: 'ON'}));
    assert.equal(on.data.review_contract_supported, true);
    assert.equal(f.requests.length, 0);
  }));

test('a Push ad that breaks several rules is refused once, with every rule listed (the shape of r25-field-tiktok, #6)', async () =>
  withFixture(async f => {
    const v = video('v-1', 'img-1');
    const r = await f.prepare(
      ad([without(v, 'image_info'), {creative_info: {...v.creative_info, identity_type: 'AUTH_CODE'}}], {
        ad_text_list: [],
      }),
    );
    assert.equal(r.error?.code, 'INVALID_TIKTOK_SMART_PLUS_AD');
    assert.deepEqual(
      r.error.details.violations.map(x => x.field),
      ['creative_list[0].creative_info.image_info', 'creative_list[1].creative_info.identity_type', 'ad_text_list'],
    );
    assert.equal(f.requests.length, 0);
  }));

// ---------------------------------------------------------------------------------------------------------------------------
// A Push ad is reviewed against the advertiser's library and identities, created once, and read back.
// ---------------------------------------------------------------------------------------------------------------------------
const paths = p => p.data.state_reads.map(r => r.path);
const withOn = body => ({...body, ad_configuration: {...body.ad_configuration, dark_post_status: 'ON'}});

test('a Push video ad under the Business Center identity, from the library, with a cover and two ad texts: paused with no flag, created once, verified, replayed', async () =>
  withFixture(async f => {
    const body = ad([video('v-1', 'img-1', bc)], {ad_text_list: texts('Spring sale', 'Free delivery')});
    const p = await f.prepared(body);
    assert.deepEqual(paths(p), [
      '/v1.3/smart_plus/adgroup/get/',
      '/v1.3/smart_plus/ad/get/',
      '/v1.3/identity/info/',
      '/v1.3/file/video/ad/search/',
      '/v1.3/file/image/ad/search/',
      '/v1.3/creative/portfolio/get/',
    ]);
    assert.ok(!p.data.execute_requirements.spend_change_confirmed, 'a paused create needs no spend flag (Q14)');
    const impact = p.data.creative_impact;
    assert.equal(impact.may_affect_serving, false);
    assert.deepEqual(impact.creatives, [
      {
        kind: 'video',
        video_id: 'v-1',
        cover_image_id: 'img-1',
        ad_format: 'SINGLE_VIDEO',
        identity_type: 'BC_AUTH_TT',
        identity_id: 'bc-1',
        identity_authorized_bc_id: '7000',
      },
    ]);
    assert.deepEqual(impact.ad_texts, ['Spring sale', 'Free delivery']);
    assert.match(
      impact.effect,
      /Creates a paused Upgraded Smart\+ ad from 1 uploaded creative\(s\) \(Spark Ads Push\)/,
    );
    // The owner's O1: ads only by default. The default is sent, not left to TikTok's.
    assert.equal(impact.dark_post.dark_post_status, 'ON');
    assert.match(impact.dark_post.meaning, /Ads only/);
    assert.equal(p.data.request.body.ad_configuration.dark_post_status, 'ON');
    const x = await f.execute(p.data.review_id);
    assert.equal(x.success, true, JSON.stringify(x.error ?? x).slice(0, 600));
    assert.deepEqual(f.writes, [withOn(body)]);
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v.data.checks));
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.equal(f.writes.length, 1);
  }));

test('a Push create whose answer was lost is not created twice: the guard against creating twice holds the same request back while the first is uncertain (the lead’s review, probe P5)', async () =>
  withFixture(async f => {
    f.behaviour.mode = 'lost';
    const body = ad([video('v-1', 'img-1'), carousel()], {ad_text_list: texts('Spring sale')});
    const p = await f.prepared(body);
    const x = await f.execute(p.data.review_id);
    assertRefused(x, 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(f.writes.length, 1);
    // TikTok did create the ad, though the answer was lost: preparing the same request again is held back, naming the earlier review, and sends nothing.
    f.behaviour.mode = '';
    const again = await f.prepare(body);
    assertRefused(again, 'DUPLICATE_OF_UNCERTAIN_WRITE', {writes: () => f.writes.length - 1});
    assert.equal(again.error.details.earlier_review_id, p.data.review_id);
    assert.equal(f.writes.length, 1);
    assert.equal(Object.keys(f.ads).filter(id => f.ads[id].ad_name === 'Push sale').length, 1, 'one ad was created');
  }));

test('a Push carousel ad, and a Push ad of videos and carousels together, are reviewed, created once and verified', async () =>
  withFixture(async f => {
    const carousels = ad([carousel(['img-2', 'img-3', 'img-4'], 'mus-1', {material_name: 'Spring set'})], {
      ad_text_list: texts('Swipe for the spring set'),
    });
    const p = await f.prepared(carousels);
    assert.deepEqual(p.data.creative_impact.creatives, [
      {
        kind: 'carousel',
        image_count: 3,
        image_ids: ['img-2', 'img-3', 'img-4'],
        music_id: 'mus-1',
        material_name: 'Spring set',
        ad_format: 'CAROUSEL_ADS',
        identity_type: 'TT_USER',
        identity_id: 'tt-1',
      },
    ]);
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    const both = ad([video('v-2', 'img-5'), carousel(['img-6', 'img-7'], 'mus-2'), video('v-3', 'img-8')], {
      ad_text_list: texts('A', 'B'),
      ad_name: 'Push mix',
    });
    const q = await f.prepared(both);
    assert.equal((await f.execute(q.data.review_id)).success, true);
    const v = await f.verify(q.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v.data.checks));
    assert.equal(f.writes.length, 2);
  }));

test('ads only is what is sent unless the request states otherwise, and OFF is shown for what it is', async () =>
  withFixture(async f => {
    const off = ad([video('v-1', 'img-1')], {ad_text_list: texts('A')}, {dark_post_status: 'OFF'});
    const p = await f.prepared(off);
    assert.equal(p.data.creative_impact.dark_post.dark_post_status, 'OFF');
    assert.match(p.data.creative_impact.dark_post.meaning, /also appear on the identity’s TikTok profile/);
    assert.match(p.data.creative_impact.effect, /also appear on the identity’s TikTok profile/);
    assert.equal(p.data.request.body.ad_configuration.dark_post_status, 'OFF');
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal(f.writes[0].ad_configuration.dark_post_status, 'OFF');
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    // An ad of posts is sent as it always was: it names no dark_post_status.
    const pull = await f.prepared(ad([post('9001')]));
    assert.equal(pull.data.request.body.ad_configuration.dark_post_status, undefined);
    assert.equal(pull.data.creative_impact.dark_post, undefined);
    assert.equal(pull.data.creative_impact.ad_texts, undefined);
    assert.match(
      pull.data.creative_impact.effect,
      /Creates a paused Upgraded Smart\+ ad from 1 existing TikTok post\(s\)/,
    );
  }));

test('an upload that the advertiser cannot use is refused before any write: a video or a cover not in its library, a carousel image a carousel cannot use', async () =>
  withFixture(async f => {
    const t = {ad_text_list: texts('A')};
    const cases = [
      [
        'a video of no library of this advertiser',
        ad([video('v-other', 'img-1')], t),
        'STATE_TARGET_MISMATCH',
        /v-other/,
      ],
      [
        'a cover of no library of this advertiser',
        ad([video('v-1', 'img-other')], t),
        'STATE_TARGET_MISMATCH',
        /img-other/,
      ],
      [
        'a carousel image of no library of this advertiser',
        ad([carousel(['img-2', 'img-other'])], t),
        'STATE_TARGET_MISMATCH',
        /img-other/,
      ],
      [
        'an image TikTok marks unusable in a carousel (is_carousel_usable false)',
        ad([carousel(['img-2', 'img-flat'])], t),
        'INVALID_TIKTOK_SMART_PLUS_AD',
        /img-flat/,
      ],
    ];
    for (const [name, payload, code, message] of cases) {
      const r = await f.prepare(payload);
      assert.equal(r.error?.code, code, name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 400));
      assert.match(r.error.message, message, name);
    }
    // A flat image is a fine cover: is_carousel_usable is a rule of carousels.
    assert.equal((await f.prepare(ad([video('v-1', 'img-flat')], t))).success, true);
    assert.equal(f.writes.length, 0);
  }));

test('the identity of a Push must be able to publish: available, not political, in the stated Business Center, and can_push_video; can_pull_video is no rule of a Push', async () =>
  withFixture(async f => {
    const t = {ad_text_list: texts('A')},
      as = identity => ad([video('v-1', 'img-1', identity)], t);
    const cases = [
      ['an account that cannot publish', as({identity_id: 'tt-nopush'}), /can_push_video/],
      ['a private account', as({identity_id: 'tt-private'}), /IS_PRIVATE_ACCOUNT/],
      ['a political account', as({identity_id: 'tt-gov'}), /political party/],
      ['a Business Center identity that cannot publish', as({...bc, identity_id: 'bc-nopush'}), /can_push_video/],
      ['another Business Center', as({...bc, identity_authorized_bc_id: '7999'}), /Business Center 7000/],
    ];
    for (const [name, payload, message] of cases) {
      const r = await f.prepare(payload);
      assert.equal(
        r.error?.code,
        'INVALID_TIKTOK_SMART_PLUS_AD',
        name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 400),
      );
      assert.match(r.error.message, message, name);
    }
    const nopull = await f.prepare(as({identity_id: 'tt-nopull'}));
    assert.equal(nopull.success, true, 'an account whose posts cannot be pulled can still publish an upload');
    // The same account is refused for a post, where can_pull_video is the rule.
    const pulled = await f.prepare(ad([post('9301', 'SINGLE_VIDEO', {identity_id: 'tt-nopull'})]));
    assert.match(pulled.error.message, /can_pull_video/);
    assert.equal(f.writes.length, 0);
  }));

test('a library search that lists a video nobody asked for is not this request’s answer', async () =>
  withFixture(async f => {
    f.behaviour.strayAsset = true;
    const r = await f.prepare(ad([video('v-1', 'img-1')], {ad_text_list: texts('A')}));
    assertRefused(r, 'STATE_TARGET_MISMATCH', {writes: () => f.writes.length});
    assert.match(r.error.message, /listed a library asset that was not asked for/);
  }));

test('the library is read in chunks of 100 IDs, each ID once', async () =>
  withFixture(async f => {
    // Five carousels of 35 images, 175 images of which 60 exist in the library: only the reads are under test, so the images are named
    // from the first 60 and repeated across carousels (two carousels never share all of them).
    const lists = Array.from({length: 5}, (_, c) =>
      carousel(
        Array.from({length: 35}, (_, i) => 'img-' + (((c * 7 + i) % 60) + 1)),
        'mus-' + (c + 1),
      ),
    );
    const p = await f.prepared(ad(lists, {ad_text_list: texts('A')}));
    const searches = f.queries.filter(q => q.path === '/v1.3/file/image/ad/search/');
    const asked = searches.flatMap(q => JSON.parse(new URLSearchParams(q.search).get('filtering')).image_ids);
    assert.equal(new Set(asked).size, asked.length, 'each image is asked for once');
    assert.equal(asked.length, 60);
    assert.ok(searches.length >= 1 && p.success);
    // 150 distinct images take two reads (100 and 50).
    for (let i = 61; i <= 150; i++) f.library.images['img-' + i] = {is_carousel_usable: true};
    const many = Array.from({length: 5}, (_, c) =>
      carousel(
        Array.from({length: 30}, (_, i) => 'img-' + (c * 30 + i + 1)),
        'mus-' + (c + 1),
      ),
    );
    f.queries.length = 0;
    await f.prepared(ad(many, {ad_text_list: texts('A')}));
    const sizes = f.queries
      .filter(q => q.path === '/v1.3/file/image/ad/search/')
      .map(q => JSON.parse(new URLSearchParams(q.search).get('filtering')).image_ids.length);
    assert.deepEqual(sizes, [100, 50]);
  }));

test('the library is read again at execute: a video withdrawn since prepare stops the write, and signed links change nothing', async () =>
  withFixture(async f => {
    const p = await f.prepared(ad([video('v-1', 'img-1')], {ad_text_list: texts('A')}));
    delete f.library.videos['v-1'];
    const x = await f.execute(p.data.review_id);
    assertRefused(x, 'STATE_TARGET_MISMATCH', {writes: () => f.writes.length});
    // Every read signs new links; a library that did not change gives the same state.
    const q = await f.prepared(ad([video('v-2', 'img-2')], {ad_text_list: texts('A')}));
    assert.equal((await f.execute(q.data.review_id)).success, true);
  }));

test('a Push ad in an Instant Form lead ad group takes its form, as an ad of posts does', async () =>
  withFixture(async f => {
    const lead = ad(
      [video('v-1', 'img-1')],
      {
        adgroup_id: '301',
        ad_text_list: texts('A'),
        landing_page_url_list: undefined,
        page_list: [{page_id: '7700149'}],
      },
      {utm_params: undefined},
    );
    const p = await f.prepared(lead);
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
  }));

test('an enabled Push ad needs the spend flag under parents that serve, and none under a paused parent (Q1, Q14), as an ad of posts does', async () =>
  withFixture(async f => {
    const enabled = ad([video('v-1', 'img-1')], {operation_status: 'ENABLE', ad_text_list: texts('A')});
    const paused = await f.prepared(enabled);
    assert.ok(!paused.data.execute_requirements.spend_change_confirmed);
    assert.match(
      paused.data.creative_impact.effect,
      /nothing delivers until its ad group is enabled|nothing delivers until the campaign is enabled/,
    );
    f.groups[300].operation_status = 'ENABLE';
    f.campaigns[80].operation_status = 'ENABLE';
    const serving = await f.prepared(enabled);
    assert.equal(serving.data.execute_requirements.spend_change_confirmed, true);
    assert.match(serving.data.creative_impact.effect, /starts serving at once/);
    const refused = await f.execute(serving.data.review_id);
    assert.ok(refused.error, 'execute without the flag is refused');
    assert.equal(f.writes.length, 0);
  }));

test('the read-back compares what was sent: another video, cover, music or ad text is not a verified ad', async () => {
  const sent = ad([video('v-1', 'img-1'), carousel(['img-2', 'img-3'], 'mus-1')], {ad_text_list: texts('A', 'B')});
  // One advertiser per case, run together: a read-back that differs is read until it settles, which takes a few seconds each.
  await Promise.all(
    [
      ['another video', a => (a.creative_list[1].creative_info.video_info.video_id = 'v-9')],
      ['another cover', a => (a.creative_list[1].creative_info.image_info = [{web_uri: 'img-9'}])],
      [
        'another carousel image',
        a => (a.creative_list[0].creative_info.image_info = [{web_uri: 'img-2'}, {web_uri: 'img-9'}]),
      ],
      ['other music', a => (a.creative_list[0].creative_info.music_info = {music_id: 'mus-9'})],
      ['other ad texts', a => (a.ad_text_list = texts('A', 'C'))],
      ['ad texts appended to the old ones', a => a.ad_text_list.push({ad_text: 'C'})],
      ['a post on the profile after all', a => (a.ad_configuration.dark_post_status = 'OFF')],
      ['another carousel name than the one sent', a => (a.creative_list[0].creative_info.material_name = 'Autumn set')],
    ].map(([name, change]) =>
      withFixture(async f => {
        const named = name.includes('carousel name')
          ? ad([carousel(['img-2', 'img-3'], 'mus-1', {material_name: 'Spring set'})], {ad_text_list: texts('A')})
          : sent;
        const p = await f.prepared({...named, ad_name: name});
        assert.equal((await f.execute(p.data.review_id)).success, true, name);
        change(Object.values(f.ads).find(a => a.ad_name === name));
        const v = await f.verify(p.data.review_id);
        assert.notEqual(v.data.status, 'verified', name + ': ' + JSON.stringify(v.data.checks));
      }),
    ),
  );
});
test('a Push read-back may carry a generated post ID, and TikTok’s own order and material names, and still be the ad that was sent', async () =>
  withFixture(async f => {
    f.behaviour.pushItem = true;
    f.behaviour.autoName = true;
    const sent = ad([video('v-1', 'img-1'), video('v-2', 'img-2'), carousel(['img-3', 'img-4'], 'mus-1')], {
      ad_text_list: texts('A', 'B'),
    });
    const p = await f.prepared(sent);
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.ok(
      Object.values(f.ads)
        .at(-1)
        .creative_list.some(c => c.creative_info.tiktok_item_id !== undefined && c.creative_info.video_info),
    );
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v.data.checks));
  }));

// ---------------------------------------------------------------------------------------------------------------------------
// A creator's authorized post (AUTH_CODE) as a Spark Ad from a post (A2): "Get info about an identity" and "Get info about TikTok
// posts" (read 2026-11-21) take it, and the post read carries the authorization it is used under.
// ---------------------------------------------------------------------------------------------------------------------------
const authorized = (item = '9501', extra = {}) =>
  post(item, 'SINGLE_VIDEO', {identity_type: 'AUTH_CODE', identity_id: 'ac-1', ...extra});

test('an authorized creator post is a Spark Ad from a post: its identity and post are read, and it is created and verified', async () =>
  withFixture(async f => {
    const p = await f.prepared(ad([authorized('9501')]));
    assert.deepEqual(paths(p), [
      '/v1.3/smart_plus/adgroup/get/',
      '/v1.3/smart_plus/ad/get/',
      '/v1.3/identity/info/',
      '/v1.3/identity/video/info/',
      '/v1.3/creative/portfolio/get/',
    ]);
    const reads = f.queries.filter(q => q.path === '/v1.3/identity/info/' || q.path === '/v1.3/identity/video/info/');
    assert.equal(new URLSearchParams(reads[0].search).get('identity_type'), 'AUTH_CODE');
    assert.equal(new URLSearchParams(reads[1].search).get('identity_type'), 'AUTH_CODE');
    // available_status and can_pull_video are no fields of an authorization-code identity, which has neither.
    assert.equal(f.identities['AUTH_CODE:ac-1'].available_status, undefined);
    assert.ok(!p.data.execute_requirements.spend_change_confirmed);
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal(f.writes[0].creative_list[0].creative_info.identity_type, 'AUTH_CODE');
    assert.equal(f.writes[0].creative_list[0].creative_info.identity_authorized_bc_id, undefined);
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v.data.checks));
  }));

test('an authorization that is not in effect, a post that is not the creator’s, and a Business Center on an authorization-code identity are refused', async () =>
  withFixture(async f => {
    const expired = await f.prepare(ad([authorized('9502')]));
    assert.equal(
      expired.error?.code,
      'INVALID_TIKTOK_SMART_PLUS_AD',
      JSON.stringify(expired.error ?? expired.data).slice(0, 300),
    );
    assert.match(
      expired.error.message,
      /Post 9502 is not authorized to this advertiser \(authorization status EXPIRED\)/,
    );
    assert.equal(expired.error.details.field, 'creative_list.tiktok_item_id');
    assertRefused(await f.prepare(ad([authorized('9999')])), 'STATE_TARGET_MISMATCH');
    const bcOnCode = await f.prepare(ad([authorized('9501', {identity_authorized_bc_id: '7000'})]));
    assert.equal(bcOnCode.error?.code, 'INVALID_TIKTOK_SMART_PLUS_AD');
    assert.equal(bcOnCode.error.details.field, 'creative_list[0].creative_info.identity_authorized_bc_id');
    assert.equal(f.writes.length, 0);
  }));

test('the authorization is read again at execute: a post whose authorization ended since prepare is not sent', async () =>
  withFixture(async f => {
    const p = await f.prepared(ad([authorized('9501')]));
    f.authorized.find(row => row.item_id === '9501').status = 'EXPIRED';
    // The prerequisites are checked again on the state read at execute, before it is compared with the reviewed one.
    const x = await f.execute(p.data.review_id);
    assertRefused(x, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.match(x.error.message, /authorization status EXPIRED/);
  }));

test('a TikTok account identity keeps its own rules for a post: can_pull_video and the availability are still read', async () =>
  withFixture(async f => {
    for (const [identity, message] of [
      ['tt-nopull', /can_pull_video/],
      ['tt-private', /IS_PRIVATE_ACCOUNT/],
    ]) {
      f.own[identity] ??= {};
      f.own[identity][9990] = 'VIDEO';
      const r = await f.prepare(ad([post('9990', 'SINGLE_VIDEO', {identity_id: identity})]));
      assert.equal(r.error?.code, 'INVALID_TIKTOK_SMART_PLUS_AD', identity);
      assert.match(r.error.message, message, identity);
    }
  }));

// ---------------------------------------------------------------------------------------------------------------------------
// The edits of a Push ad (E12): "Update an Upgraded Smart+ Ad" (read 2026-11-21) is incremental, except that creative_list is replaced
// in full; ad_text_list is a list it states no rule for, so a read-back says what TikTok did with it.
// ---------------------------------------------------------------------------------------------------------------------------
const update = 'tiktok_smart_plus_ad_update';
const edit = (f, payload, extra) => f.prepare(payload, update, extra);
const edited = (f, payload, extra) => f.prepared(payload, update, extra);

test('replacing the creatives of a paused Push ad lists kept, added, removed and changed creatives, reads the identity and the library, and verifies', async () =>
  withFixture(async f => {
    // A kept video under another cover is listed as changed (read before the first edit is executed: the ad then still holds v-1 and v-2).
    const q = await edited(f, {
      smart_plus_ad_id: '5110',
      creative_list: [video('v-1', 'img-9'), video('v-2', 'img-4')],
    });
    assert.deepEqual(q.data.creative_impact.changes.creative_list, {
      kept: ['video:v-1', 'video:v-2'],
      added: [],
      removed: [],
      changed: ['video:v-1'],
    });
    const creative_list = [video('v-1', 'img-1'), video('v-3', 'img-5')];
    const p = await edited(f, {smart_plus_ad_id: '5110', creative_list});
    assert.deepEqual(paths(p), [
      '/v1.3/smart_plus/ad/get/',
      '/v1.3/identity/info/',
      '/v1.3/file/video/ad/search/',
      '/v1.3/file/image/ad/search/',
    ]);
    assert.deepEqual(p.data.creative_impact.changes.creative_list, {
      kept: ['video:v-1'],
      added: ['video:v-3'],
      removed: ['video:v-2'],
      changed: [],
    });
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.deepEqual(f.writes, [{advertiser_id: '123', smart_plus_ad_id: '5110', creative_list}]);
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v.data.checks));
  }));

test('the ad texts of a Push ad are edited on their own: the review shows before and after, and the read-back says what TikTok did with the list', async () =>
  withFixture(async f => {
    const p = await edited(f, {smart_plus_ad_id: '5110', ad_text_list: texts('Summer sale')});
    assert.deepEqual(paths(p), ['/v1.3/smart_plus/ad/get/']);
    assert.deepEqual(p.data.creative_impact.changes.ad_text_list, {
      before: ['Free delivery', 'Spring sale'],
      after: ['Summer sale'],
    });
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.deepEqual(f.writes, [{advertiser_id: '123', smart_plus_ad_id: '5110', ad_text_list: texts('Summer sale')}]);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
  }));

test('if TikTok appends the ad texts it is sent instead of replacing them, the edit is not verified', async () =>
  withFixture(async f => {
    f.behaviour.texts = 'append';
    const p = await edited(f, {smart_plus_ad_id: '5110', ad_text_list: texts('Summer sale')});
    assert.equal((await f.execute(p.data.review_id)).success, true);
    const v = await f.verify(p.data.review_id);
    assert.notEqual(v.data.status, 'verified', JSON.stringify(v.data.checks));
    assert.ok(JSON.stringify(v.data.checks).includes('ad_text_list'));
  }));

test('removing creatives from an enabled Push ad needs creative_edit_confirmed at review and execution; adding needs nothing', async () =>
  withFixture(async f => {
    const removing = {smart_plus_ad_id: '5112', creative_list: [video('v-1', 'img-1')]};
    const refused = await edit(f, removing);
    assertRefused(refused, 'CREATIVE_EDIT_CONFIRMATION_REQUIRED', {writes: () => f.writes.length});
    assert.deepEqual(refused.error.details.removed, ['video:v-2']);
    assert.match(refused.error.message, /removes 1 creative\(s\) from enabled ad 5112/);
    const adding = await edit(f, {
      smart_plus_ad_id: '5112',
      creative_list: [video('v-1', 'img-1'), video('v-2', 'img-4'), video('v-3', 'img-5')],
    });
    assert.equal(adding.success, true, 'adding creatives removes nothing');
    const p = await edited(f, removing, {creative_edit_confirmed: true});
    assert.equal(p.data.creative_impact.may_affect_serving, true);
    assert.match(p.data.creative_impact.effect, /removed creatives stop delivering/);
    assert.equal((await f.execute(p.data.review_id)).error?.code, 'CREATIVE_EDIT_CONFIRMATION_REQUIRED');
    assert.equal(f.writes.length, 0);
    assert.equal((await f.execute(p.data.review_id, {creative_edit_confirmed: true})).success, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
  }));

test('a Push ad whose read carries generated post IDs is told by its uploads: kept, added and removed are the videos, not those IDs', async () =>
  withFixture(async f => {
    // "Create an Upgraded Smart+ Ad" shows none, but a read may carry the ID of the post TikTok published for each upload.
    for (const c of f.ads[5110].creative_list) c.creative_info.tiktok_item_id = '77' + c.ad_material_id;
    const p = await edited(f, {
      smart_plus_ad_id: '5110',
      creative_list: [video('v-1', 'img-1'), video('v-3', 'img-5')],
    });
    assert.deepEqual(p.data.creative_impact.changes.creative_list, {
      kept: ['video:v-1'],
      added: ['video:v-3'],
      removed: ['video:v-2'],
      changed: [],
    });
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
  }));

test('what a read of uploads without ad texts says of its kind: no post ID is an ad of uploads, a post ID is an ad of posts, and anything else is only renamed', async () =>
  withFixture(async f => {
    const held = f.ads[5110];
    delete held.ad_text_list;
    const creative_list = [video('v-1', 'img-1')];
    const setItem = item => {
      for (const c of held.creative_list)
        if (item === undefined) delete c.creative_info.tiktok_item_id;
        else c.creative_info.tiktok_item_id = item;
    };
    // Uploads and no post ID, or an empty one: an ad of uploads whose read left the texts out.
    for (const item of [undefined, '', null]) {
      setItem(item);
      const plain = await edit(f, {smart_plus_ad_id: '5110', creative_list});
      assert.equal(
        plain.success,
        true,
        'post ID ' + JSON.stringify(item) + ': ' + JSON.stringify(plain.error ?? plain.data).slice(0, 300),
      );
    }
    // A post ID of a post an account owns, with no ad texts to say otherwise: an ad of posts, whose creatives stay posts.
    setItem('77001');
    const posts = await edit(f, {smart_plus_ad_id: '5110', creative_list});
    assert.equal(
      posts.error?.code,
      'INVALID_TIKTOK_SMART_PLUS_AD',
      JSON.stringify(posts.error ?? posts.data).slice(0, 300),
    );
    assert.match(posts.error.message, /Spark Ads Pull/);
    // A post ID that is neither (a number): neither kind, so only its name is edited.
    setItem(77001);
    const neither = await edit(f, {smart_plus_ad_id: '5110', creative_list});
    assert.equal(
      neither.error?.code,
      'INVALID_TIKTOK_SMART_PLUS_AD',
      JSON.stringify(neither.error ?? neither.data).slice(0, 300),
    );
    assert.match(neither.error.message, /only its name can be edited/);
    assert.equal((await edit(f, {smart_plus_ad_id: '5110', ad_name: 'Renamed'})).success, true);
  }));

test('an edit keeps what kind of ad it edits: posts for a Push ad, uploads or ad texts for an ad of posts, and a profile post for nothing but a Push', async () =>
  withFixture(async f => {
    const cases = [
      [
        'posts for an ad of uploads',
        {smart_plus_ad_id: '5110', creative_list: [post('9001')]},
        'creative_list',
        /Spark Ads Push/,
      ],
      [
        'uploads for an ad of posts',
        {smart_plus_ad_id: '5100', creative_list: [video('v-1', 'img-1')], ad_text_list: texts('A')},
        'creative_list',
        /Spark Ads Pull/,
      ],
      [
        'ad texts for an ad of posts',
        {smart_plus_ad_id: '5100', ad_text_list: texts('A')},
        'ad_text_list',
        /use the post text/,
      ],
      [
        'the post on the profile, for an ad of posts',
        {
          smart_plus_ad_id: '5100',
          ad_configuration: {
            call_to_action_id: '700',
            creative_auto_add_toggle: false,
            creative_auto_enhancement_strategy_list: ['VIDEO_QUALITY'],
            utm_params: [
              {key: 'utm_source', value: 'tiktok'},
              {key: 'utm_campaign', value: '__CAMPAIGN_NAME__'},
            ],
            dark_post_status: 'OFF',
          },
        },
        'ad_configuration.dark_post_status',
        /ON or leave it out/,
      ],
    ];
    for (const [name, payload, field, message] of cases) {
      const r = await edit(f, payload);
      assert.equal(
        r.error?.code,
        'INVALID_TIKTOK_SMART_PLUS_AD',
        name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300),
      );
      assert.equal(r.error.details.field, field, name);
      assert.match(r.error.message, message, name);
    }
    assert.equal(f.writes.length, 0);
  }));

test('a carousel’s own name is not lost by an edit: a kept carousel that has a custom name must restate it (TikTok replaces it otherwise)', async () =>
  withFixture(async f => {
    const kept = name => [
      carousel(['img-2', 'img-3'], 'mus-1', name === undefined ? {} : {material_name: name}),
      video('v-1', 'img-1'),
    ];
    const r = await edit(f, {smart_plus_ad_id: '5111', creative_list: kept()});
    assert.equal(r.error?.code, 'INVALID_TIKTOK_SMART_PLUS_AD', JSON.stringify(r.error ?? r.data).slice(0, 300));
    assert.equal(r.error.details.field, 'creative_list[0].creative_info.material_name');
    // The name is TikTok's data: the refusal says that there is one and does not repeat it.
    assert.match(r.error.message, /custom name/);
    assert.doesNotMatch(JSON.stringify(r.error), /Spring set/);
    // Restating it keeps it, and an empty name accepts TikTok's own. A carousel restated under another name is listed as changed.
    for (const [name, renamed] of [
      ['Spring set', false],
      ['Autumn set', true],
      ['', true],
    ]) {
      const p = await edit(f, {smart_plus_ad_id: '5111', creative_list: kept(name)});
      assert.equal(
        p.success,
        true,
        'name ' + JSON.stringify(name) + ': ' + JSON.stringify(p.error ?? p.data).slice(0, 300),
      );
      const list = p.data.creative_impact.changes.creative_list;
      assert.deepEqual(list.changed, renamed ? [list.kept[0]] : [], 'changed, name ' + JSON.stringify(name));
      assert.match(list.kept[0], /^carousel:[0-9a-f]{12}$/);
    }
    // A carousel that is new has no name to lose.
    const added = await edit(f, {
      smart_plus_ad_id: '5111',
      creative_list: [...kept('Spring set'), carousel(['img-5', 'img-6'], 'mus-2')],
    });
    assert.equal(added.success, true);
    // A carousel that holds TikTok's own name ("Image carousel 1") has no one's choice to lose, so it is restated without a name.
    f.ads[5111].creative_list[0].creative_info.material_name = 'Image carousel 1';
    const automatic = await edit(f, {smart_plus_ad_id: '5111', creative_list: kept()});
    assert.equal(automatic.success, true, JSON.stringify(automatic.error ?? automatic.data).slice(0, 300));
    // A name that only begins like TikTok's own is a custom one.
    f.ads[5111].creative_list[0].creative_info.material_name = 'Image carousel (autumn)';
    const lookalike = await edit(f, {smart_plus_ad_id: '5111', creative_list: kept()});
    assert.equal(lookalike.error?.details?.field, 'creative_list[0].creative_info.material_name');
  }));

test('dark_post_status of a Push ad: ON or OFF is restated, OFF is shown for what it is, and a new configuration never silently sets an OFF back to ON', async () =>
  withFixture(async f => {
    const config = extra => ({
      call_to_action_id: '700',
      creative_auto_add_toggle: false,
      creative_auto_enhancement_strategy_list: ['VIDEO_QUALITY'],
      utm_params: [
        {key: 'utm_source', value: 'tiktok'},
        {key: 'utm_campaign', value: '__CAMPAIGN_NAME__'},
      ],
      ...extra,
    });
    // A Push ad that reads ON is put on the profile by saying OFF, and the review says so.
    const off = await edited(f, {smart_plus_ad_id: '5110', ad_configuration: config({dark_post_status: 'OFF'})});
    assert.equal(off.data.creative_impact.dark_post.dark_post_status, 'OFF');
    assert.match(off.data.creative_impact.dark_post.meaning, /also appear on the identity’s TikTok profile/);
    assert.equal((await f.execute(off.data.review_id)).success, true);
    assert.equal(f.writes[0].ad_configuration.dark_post_status, 'OFF');
    assert.equal((await f.verify(off.data.review_id)).data.status, 'verified');
    // An ad that reads OFF keeps it: a configuration that leaves the key out would set it back, so it is refused.
    const dropped = await edit(f, {smart_plus_ad_id: '5113', ad_configuration: config()});
    assert.equal(
      dropped.error?.code,
      'INVALID_TIKTOK_SMART_PLUS_AD',
      JSON.stringify(dropped.error ?? dropped.data).slice(0, 300),
    );
    assert.equal(dropped.error.details.field, 'ad_configuration.dark_post_status');
    assert.match(dropped.error.message, /Restate dark_post_status/);
    assert.equal(
      (await edit(f, {smart_plus_ad_id: '5113', ad_configuration: config({dark_post_status: 'OFF'})})).success,
      true,
    );
    // A patch carries it from the ad.
    const patch = await edit(f, {smart_plus_ad_id: '5113', ad_configuration_patch: {creative_auto_add_toggle: true}});
    assert.equal(patch.error?.details?.field, 'ad_configuration_patch');
    assert.equal(patch.error.details.fix[0].value.dark_post_status, 'OFF');
  }));

test('what a Push edit leaves to its own contract stays refused: a custom identity’s upload is only renamed, and an Instant Form Push ad edits its texts and not its creatives', async () =>
  withFixture(async f => {
    const custom = await edit(f, {smart_plus_ad_id: '5120', ad_text_list: texts('B')});
    assert.equal(custom.error?.code, 'INVALID_TIKTOK_SMART_PLUS_AD');
    assert.match(custom.error.message, /only its name can be edited/);
    assert.equal((await edit(f, {smart_plus_ad_id: '5120', ad_name: 'Renamed'})).success, true);
    // Nor are the posts of an ad under a custom identity: that kind of ad is no Pull ad either.
    f.ads[5100].creative_list[0].creative_info.identity_type = 'CUSTOMIZED_USER';
    const posts = await edit(f, {smart_plus_ad_id: '5100', creative_list: [post('9001')]});
    assert.equal(
      posts.error?.code,
      'INVALID_TIKTOK_SMART_PLUS_AD',
      JSON.stringify(posts.error ?? posts.data).slice(0, 300),
    );
    assert.match(posts.error.message, /only its name can be edited/);
    const form = await edit(f, {smart_plus_ad_id: '5121', creative_list: [video('v-2', 'img-2')]});
    assert.equal(form.error?.code, 'INVALID_TIKTOK_SMART_PLUS_AD');
    assert.match(form.error.message, /Instant Form/);
    const texts5121 = await edited(f, {smart_plus_ad_id: '5121', ad_text_list: texts('Another lead sale')});
    assert.equal((await f.execute(texts5121.data.review_id)).success, true);
    assert.equal((await f.verify(texts5121.data.review_id)).data.status, 'verified');
  }));

test('the posts of an ad from an authorized creator post are edited like any ad of posts, and its identity and post are read as AUTH_CODE', async () =>
  withFixture(async f => {
    const p = await edited(f, {smart_plus_ad_id: '5130', creative_list: [authorized('9501')]});
    assert.deepEqual(paths(p), ['/v1.3/smart_plus/ad/get/', '/v1.3/identity/info/', '/v1.3/identity/video/info/']);
    assert.deepEqual(p.data.creative_impact.changes.creative_list, {kept: ['9501'], added: [], removed: []});
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
  }));

// An ad of posts is an ad of posts by what its creatives name (a post and no upload), whatever its read says of ad texts (the lead's review S2-1,
// probe P7): "Upgraded Smart+ ad creative combinations by identity and ad type" says only that a request sends none, and no page says what a
// read of such an ad returns in `ad_text_list`. Before the package nothing about an ad of posts depended on that field.
test('an ad of posts whose read carries an ad text, as the caption of a post might be, is still an ad of posts: its create verifies', async () =>
  withFixture(async f => {
    f.behaviour.captions = true;
    const p = await f.prepared(ad([post('9001'), post('9002', 'CAROUSEL_ADS')]));
    assert.equal((await f.execute(p.data.review_id)).success, true);
    // The read-back does carry the text, and the creatives are still read as the posts that were sent.
    assert.deepEqual(f.ads[5601].creative_list.map(c => c.creative_info.tiktok_item_id).sort(), ['9001', '9002']);
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v.data.checks));
  }));

test('the posts of an existing ad of posts whose read carries an ad text are edited and verified as those of any ad of posts', async () =>
  withFixture(async f => {
    f.behaviour.captions = true;
    const creative_list = [post('9001'), post('9002', 'CAROUSEL_ADS'), post('9003')];
    const p = await edited(f, {smart_plus_ad_id: '5100', creative_list});
    assert.deepEqual(p.data.creative_impact.changes.creative_list, {
      kept: ['9001', '9002'],
      added: ['9003'],
      removed: [],
    });
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.deepEqual(f.writes, [{advertiser_id: '123', smart_plus_ad_id: '5100', creative_list}]);
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v.data.checks));
    // The ad is still an ad of posts: it takes no uploads and no ad texts.
    const uploads = await edit(f, {smart_plus_ad_id: '5100', creative_list: [video('v-1', 'img-1')]});
    assertRefused(uploads, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length - 1});
    assert.match(uploads.error.message, /built from existing posts/);
    const texting = await edit(f, {smart_plus_ad_id: '5100', ad_text_list: texts('A')});
    assertRefused(texting, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length - 1});
    assert.match(texting.error.message, /built from existing posts/);
  }));

test('the shape of an edit that names uploads and ad texts is checked before any request', async () =>
  withFixture(async f => {
    const v = video('v-1', 'img-1');
    const cases = {
      'a Push edit whose video has no cover': [
        {smart_plus_ad_id: '5110', creative_list: [{creative_info: {...v.creative_info, image_info: undefined}}]},
        'creative_list[0].creative_info.image_info',
      ],
      'six ad texts': [{smart_plus_ad_id: '5110', ad_text_list: texts('1', '2', '3', '4', '5', '6')}, 'ad_text_list'],
      'a blank ad text': [{smart_plus_ad_id: '5110', ad_text_list: texts(' ')}, 'ad_text_list'],
      'an empty list of ad texts': [{smart_plus_ad_id: '5110', ad_text_list: []}, 'ad_text_list'],
      'ad texts beside posts': [
        {smart_plus_ad_id: '5100', creative_list: [post('9001')], ad_text_list: texts('A')},
        'ad_text_list',
      ],
      'a material ID beside a creative, which TikTok would ignore (the material ID is the edit’s own: A16)': [
        {smart_plus_ad_id: '5110', creative_list: [{ad_material_id: 'm0', creative_info: v.creative_info}]},
        'creative_list[0].ad_material_id',
      ],
    };
    for (const [name, [payload, field]] of Object.entries(cases)) {
      const r = await edit(f, payload);
      assert.equal(
        r.error?.code,
        'INVALID_TIKTOK_SMART_PLUS_AD',
        name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300),
      );
      assert.equal(r.error.details.field, field, name);
    }
    assert.equal(f.requests.length, 0);
  }));
