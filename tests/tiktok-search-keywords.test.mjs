import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tiktokSearchKeywordLimit,
  tiktokSearchKeywordRejected,
  tiktokSearchKeywordReviewSet,
  tiktokSearchKeywordSet,
  tiktokSearchMatchTypes,
} from '../dist/src/tiktok-search-keywords.js';

/**
 * R2.5 M4, package r25-m4-search2, round 2 (S2-3 and S3-3, the lead's review of 27528f0e): the two functions of the one shared keyword module.
 * The pair set is package r25-m4-search's `tiktokSearchKeywordSet` (its lead review S3-3), the same name and behaviour, so the merge keeps
 * one: the keywords of a write compared with the keywords stored, `{keyword, match_type}` pairs and nothing else, in one order. The review set
 * is this package's own: the ordered list a review keeps as state, without TikTok's moving review status and with everything else, so a
 * rejection (the `reject_info` TikTok returns only for a REJECTED keyword) between prepare and execute is still a change.
 */
const stored = [
  {keyword: 'trail shoes', match_type: 'PRECISE_WORD', audit_status: 'PASS'},
  {
    keyword: 'shoe sale',
    match_type: 'BROAD_WORD',
    audit_status: 'REJECTED',
    reject_info: [{forbidden_location: 'KEYWORD', reject_reasons: [{reason: 'Synthetic reason'}]}],
  },
  {keyword: 'running shoes', match_type: 'PHRASE_WORD', audit_status: 'AUDITING', keyword_bid_type: 'FOLLOW_ADGROUP'},
];

test('the match types and the bound are the manual Search pages’, shared by the create, the edit and the pack', () => {
  assert.deepEqual(tiktokSearchMatchTypes, ['PRECISE_WORD', 'PHRASE_WORD', 'BROAD_WORD']);
  assert.equal(tiktokSearchKeywordLimit, 1000);
});

test('the pair set keeps the keyword and its match type and nothing else, in one order', () => {
  const pairs = tiktokSearchKeywordSet(stored);
  assert.deepEqual(pairs, [
    {keyword: 'running shoes', match_type: 'PHRASE_WORD'},
    {keyword: 'shoe sale', match_type: 'BROAD_WORD'},
    {keyword: 'trail shoes', match_type: 'PRECISE_WORD'},
  ]);
  // The same keywords listed back in another order, with other statuses and another field, are the same set.
  const turned = [...stored].reverse().map(({audit_status, keyword_bid_type, ...k}) => ({...k, audit_status: 'PASS'}));
  assert.deepEqual(tiktokSearchKeywordSet(turned), pairs);
  // A missing, an extra, a re-cased and a re-typed keyword still differ.
  for (const other of [
    stored.slice(1),
    [...stored, {keyword: 'extra', match_type: 'BROAD_WORD'}],
    [{...stored[0], keyword: 'Trail shoes'}, stored[1], stored[2]],
    [{...stored[0], match_type: 'BROAD_WORD'}, stored[1], stored[2]],
  ])
    assert.notDeepEqual(tiktokSearchKeywordSet(other), pairs);
  // An item that is no record is left as it is: a comparison never guesses.
  assert.deepEqual(tiktokSearchKeywordSet(['text']), ['text']);
});

test('the review set drops only the moving review status and keeps the rest, in one order', () => {
  const review = tiktokSearchKeywordReviewSet(stored);
  assert.deepEqual(review.map(k => k.keyword).sort(), ['running shoes', 'shoe sale', 'trail shoes']);
  assert.ok(
    review.every(k => !Object.hasOwn(k, 'audit_status')),
    'the status moves by itself and is no change',
  );
  const rejected = review.find(k => k.keyword === 'shoe sale');
  assert.deepEqual(rejected.reject_info, stored[1].reject_info, 'a rejection is a change, so reject_info stays');
  assert.equal(
    review.find(k => k.keyword === 'running shoes').keyword_bid_type,
    'FOLLOW_ADGROUP',
    'so does any other field',
  );
  // The order does not matter and the status does not: the same keywords in another order and status give the same state.
  const turned = [...stored].reverse().map(k => (k.audit_status === 'PASS' ? {...k, audit_status: 'AUDITING'} : k));
  assert.deepEqual(tiktokSearchKeywordReviewSet(turned), review);
  // A keyword that gains a reject_info is another state; a keyword that is no longer rejected is too.
  const later = stored.map(k => (k.keyword === 'trail shoes' ? {...k, audit_status: 'REJECTED', reject_info: []} : k));
  assert.notDeepEqual(tiktokSearchKeywordReviewSet(later), review);
});

test('a keyword is rejected when TikTok returns a reject_info with something in it, which it does only for a REJECTED one', () => {
  assert.equal(tiktokSearchKeywordRejected(stored[1]), true);
  // An empty or null reject_info says nothing: a keyword is dropped from a list only when it is known to be rejected, never on a doubt.
  for (const k of [
    stored[0],
    stored[2],
    {keyword: 'a', match_type: 'BROAD_WORD', reject_info: []},
    {keyword: 'a', match_type: 'BROAD_WORD', reject_info: null},
    {keyword: 'a', match_type: 'BROAD_WORD'},
    'text',
    null,
    undefined,
  ])
    assert.equal(tiktokSearchKeywordRejected(k), false);
});
