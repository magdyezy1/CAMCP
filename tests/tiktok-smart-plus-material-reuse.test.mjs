import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {pushFixture, ad, post, video} from './fixtures/tiktok-smart-plus-push.mjs';

/**
 * Keeping a creative of an Upgraded Smart+ ad by its ad_material_id (package r25-m4b-smartpush, matrix A16). "Update an Upgraded
 * Smart+ Ad" (read 2026-11-21): creative_list is a full replacement, and "for each creative, you can pass either creative_info (if you
 * want the system to generate a new material ID) or ad_material_id (if you want to retain the existing material ID)"; "Using
 * ad_material_id to update Upgraded Smart+ Ads is currently an allowlist-only feature", and "When both creative_info and
 * ad_material_id are specified, creative_info will be ignored". "Create an Upgraded Smart+ Ad" has no such field: ad_material_id is
 * in its answer only. So a create refuses it, and an update takes it, for a creative the ad holds now, and leaves the allowlist to
 * TikTok: an advertiser that is not on it is refused with code 40118, which is a definitive refusal that changes nothing.
 * The synthetic advertiser is tests/fixtures/tiktok-smart-plus-push.mjs (ad 5110 holds videos v-1 and v-2 as materials m0 and m1).
 */
async function withFixture(body) {
  const f = pushFixture();
  try {
    return await body(f);
  } finally {
    f.store.close();
  }
}
const update = 'tiktok_smart_plus_ad_update';
const edit = (f, payload, extra) => f.prepare(payload, update, extra);
const edited = (f, payload, extra) => f.prepared(payload, update, extra);
const paths = p => p.data.state_reads.map(r => r.path);
const keep = id => ({ad_material_id: id});

test('a create has no ad_material_id: the page lists it in the answer only, and the refusal says so', async () =>
  withFixture(async f => {
    const r = await f.prepare(ad([{ad_material_id: 'm0'}]));
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.equal(r.error.details.field, 'creative_list[0].ad_material_id');
    assert.match(r.error.message, /create request has no ad_material_id/);
    assert.equal(f.requests.length, 0);
  }));

test('an update keeps a creative by its ad_material_id beside a new one: the new one is read, the kept one is not, and the review names the allowlist', async () =>
  withFixture(async f => {
    f.behaviour.allowlisted = true;
    const creative_list = [keep('m0'), video('v-3', 'img-5')];
    const p = await edited(f, {smart_plus_ad_id: '5110', creative_list});
    // The kept creative is the ad's own: its identity and library are not read again; the new video's are.
    assert.deepEqual(paths(p), [
      '/v1.3/smart_plus/ad/get/',
      '/v1.3/identity/info/',
      '/v1.3/file/video/ad/search/',
      '/v1.3/file/image/ad/search/',
    ]);
    const queried = f.queries.filter(q => q.path === '/v1.3/file/video/ad/search/');
    assert.deepEqual(JSON.parse(new URLSearchParams(queried[0].search).get('filtering')).video_ids, ['v-3']);
    const impact = p.data.creative_impact;
    assert.deepEqual(impact.changes.creative_list, {
      kept: ['video:v-1'],
      added: ['video:v-3'],
      removed: ['video:v-2'],
      changed: [],
      retained: ['m0'],
    });
    assert.match(impact.allowlist, /ad_material_id/);
    assert.match(impact.allowlist, /allowlist/);
    assert.match(impact.allowlist, /40118/);
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.deepEqual(f.writes, [{advertiser_id: '123', smart_plus_ad_id: '5110', creative_list}]);
    // The creative TikTok kept has its material ID and its content, and the read-back is the list that was sent.
    assert.equal(f.ads[5110].creative_list[0].ad_material_id, 'm0');
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v.data.checks));
  }));

test('an ad of posts keeps a post by its ad_material_id too, and keeping every creative removes nothing, so an enabled ad needs no acknowledgement', async () =>
  withFixture(async f => {
    f.behaviour.allowlisted = true;
    const pull = await edited(f, {smart_plus_ad_id: '5100', creative_list: [keep('m0'), post('9003')]});
    assert.deepEqual(pull.data.creative_impact.changes.creative_list, {
      kept: ['9001'],
      added: ['9003'],
      removed: ['9002'],
      retained: ['m0'],
    });
    assert.equal((await f.execute(pull.data.review_id)).success, true);
    assert.equal((await f.verify(pull.data.review_id)).data.status, 'verified');
    // Every creative of an enabled Push ad, kept: nothing is removed.
    const all = await edited(f, {smart_plus_ad_id: '5112', creative_list: [keep('m0'), keep('m1')]});
    assert.deepEqual(all.data.creative_impact.changes.creative_list.removed, []);
    assert.equal(all.data.creative_impact.may_affect_serving, true);
    assert.equal((await f.execute(all.data.review_id)).success, true);
    assert.equal((await f.verify(all.data.review_id)).data.status, 'verified');
  }));

test('dropping a creative of an enabled ad by leaving its material out still needs creative_edit_confirmed', async () =>
  withFixture(async f => {
    f.behaviour.allowlisted = true;
    const dropping = {smart_plus_ad_id: '5112', creative_list: [keep('m0')]};
    const refused = await edit(f, dropping);
    assertRefused(refused, 'CREATIVE_EDIT_CONFIRMATION_REQUIRED', {writes: () => f.writes.length});
    assert.deepEqual(refused.error.details.removed, ['video:v-2']);
    const p = await edited(f, dropping, {creative_edit_confirmed: true});
    assert.equal((await f.execute(p.data.review_id, {creative_edit_confirmed: true})).success, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
  }));

test('an advertiser that is not on the allowlist is refused by TikTok with 40118: nothing changes, the review is never sent again, and the answer says what to ask TikTok', async () =>
  withFixture(async f => {
    const p = await edited(f, {smart_plus_ad_id: '5110', creative_list: [keep('m0'), keep('m1')]});
    // The review says so before anything is sent.
    assert.match(p.data.creative_impact.allowlist, /40118/);
    const x = await f.execute(p.data.review_id);
    assertRefused(x, 'PROVIDER_ACCESS_DENIED');
    assert.equal(x.error.details.provider_code, 40118);
    assert.match(x.error.details.allowlist, /ask TikTok to allowlist this advertiser/);
    // The remedy follows the sentence the refusal carries (r25-field3-merge, review S3-1): it sends the reader to details.allowlist, which names the creative kept
    // by its ad_material_id, and does not tell them to change a Search type.
    assert.match(x.error.remedy.action, /details\.allowlist/);
    assert.doesNotMatch(x.error.remedy.action, /Search/);
    assert.equal(f.ads[5110].creative_list.length, 2);
    assert.equal(f.writes.length, 1);
    // A definitive refusal retires the review: the same one is not sent again.
    const again = await f.execute(p.data.review_id);
    assert.equal(again.error?.code, 'WRITE_REJECTED');
    assert.equal(f.writes.length, 1);
    // Another refusal of TikTok's (code 40002) carries no sentence about an allowlist: it names none.
    f.behaviour.mode = 'error';
    const other = await edited(f, {smart_plus_ad_id: '5110', ad_name: 'Another name'});
    const refused = await f.execute(other.data.review_id);
    assertRefused(refused, 'PLATFORM_ERROR');
    assert.equal(refused.error.details.provider_code, 40002);
    assert.equal(refused.error.details.allowlist, undefined);
  }));

test('ad_material_id is refused before any write when it is not one the ad holds, is repeated, comes with creative_info, or is no ID', async () =>
  withFixture(async f => {
    f.behaviour.allowlisted = true;
    const cases = [
      [
        'a material the ad does not hold',
        {smart_plus_ad_id: '5110', creative_list: [keep('m9')]},
        'INVALID_TIKTOK_SMART_PLUS_AD',
        'creative_list[0].ad_material_id',
        /holds no creative with ad_material_id m9/,
      ],
      [
        'the same material twice',
        {smart_plus_ad_id: '5110', creative_list: [keep('m0'), keep('m0')]},
        'INVALID_TIKTOK_SMART_PLUS_AD',
        'creative_list[1].ad_material_id',
        /more than once/,
      ],
      [
        'both a material and a creative',
        {smart_plus_ad_id: '5110', creative_list: [{ad_material_id: 'm0', ...video('v-1', 'img-1')}]},
        'INVALID_TIKTOK_SMART_PLUS_AD',
        'creative_list[0].ad_material_id',
        /creative_info will be ignored|ignores creative_info/,
      ],
      [
        'a material that is no ID',
        {smart_plus_ad_id: '5110', creative_list: [{ad_material_id: ''}]},
        'INVALID_TIKTOK_SMART_PLUS_AD',
        'creative_list[0].ad_material_id',
        /ad_material_id must be/,
      ],
      [
        'a kept creative sent again by its content',
        {smart_plus_ad_id: '5110', creative_list: [keep('m0'), video('v-1', 'img-1')]},
        'INVALID_TIKTOK_SMART_PLUS_AD',
        'creative_list',
        /appears twice/,
      ],
    ];
    for (const [name, payload, code, field, message] of cases) {
      const r = await edit(f, payload);
      assert.equal(r.error?.code, code, name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300));
      assert.equal(r.error.details.field, field, name);
      assert.match(r.error.message, message, name);
    }
    assert.equal(f.writes.length, 0);
  }));

test('the shape of a material and its place in the list are checked before any request', async () =>
  withFixture(async f => {
    const cases = {
      'an object where a creative is': [
        {smart_plus_ad_id: '5110', creative_list: [{ad_material_id: 'm0', extra: 1}]},
        'creative_list[0]',
      ],
      'a material that is a number': [
        {smart_plus_ad_id: '5110', creative_list: [{ad_material_id: 7}]},
        'creative_list[0].ad_material_id',
      ],
      'fifty-one creatives': [
        {smart_plus_ad_id: '5110', creative_list: Array.from({length: 51}, (_, i) => keep('m' + i))},
        'creative_list',
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
