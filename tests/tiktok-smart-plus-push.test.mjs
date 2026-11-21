import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {pushFixture, ad, post} from './fixtures/tiktok-smart-plus-push.mjs';

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
