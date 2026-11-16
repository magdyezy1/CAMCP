import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {reviewStateHash, reviewVolatile, changedStateFields} from '../dist/src/review-state.js';

/**
 * R2.5 M1 (package r25-m1-hash, L3-14): Meta has no TikTok-style hash of a whole account row, because its state reads ask
 * for named fields only (`fields=`), and its families turn counters into whether there are any. This test keeps it so.
 * The names are the lane's: Meta's meters, counters and delivery diagnostics, which no edit changes and which move on
 * their own (`amount_spent`, `balance`, `spend`, `insights`, `delivery_info`, `learning_stage_info`, `issues_info`,
 * `ad_review_feedback`, `approximate_count_*`, `product_count`).
 *   1. Meta's review table names every one of them: a state that carries one still hashes the same as it moves.
 *   2. No Meta source asks Graph for one of them in a field list, except where a family reads it to decide something and
 *      keeps only what it decided in its review state; each such read is named below with where its value goes, so a new
 *      one fails until someone says so.
 */
const lane = [
  'amount_spent',
  'balance',
  'spend',
  'insights',
  'delivery_info',
  'learning_stage_info',
  'issues_info',
  'ad_review_feedback',
  'approximate_count_*',
  'product_count',
];
const meta = reviewVolatile('meta_native_action');
const sample = name => (name.endsWith('*') ? name.slice(0, -1) + 'lower_bound' : name);

test('Meta’s table names every field of the lane’s list, and a state that carries one hashes the same as it moves', () => {
  for (const name of lane) assert.ok(meta.includes(name), name + ' is in the Meta table');
  for (const name of lane) {
    const a = {id: '1', name: 'A', [sample(name)]: 1},
      b = {id: '1', name: 'A', [sample(name)]: 99999};
    assert.equal(reviewStateHash(a, meta), reviewStateHash(b, meta), name);
    assert.deepEqual(changedStateFields(a, b, meta), [], name);
    // A neighbour that is configuration is not excused by them.
    const neighbour = 'my_' + sample(name);
    assert.notEqual(
      reviewStateHash({id: '1', [neighbour]: 1}, meta),
      reviewStateHash({id: '1', [neighbour]: 2}, meta),
      neighbour,
    );
  }
});

// Every Graph field list written in a Meta module: a string of comma-separated names, a name with a nested selection
// `{...}` counting as its own (`business{id}` is `business`).
const fieldList = /^[a-z0-9_]+(?:\{[a-z0-9_,{}.]*\})?(?:,[a-z0-9_]+(?:\{[a-z0-9_,{}.]*\})?)+$/;
const volatileName = name => lane.some(v => (v.endsWith('*') ? name.startsWith(v.slice(0, -1)) : name === v));
function selections() {
  const found = [];
  for (const file of fs
    .readdirSync(new URL('../src/', import.meta.url))
    .filter(f => /^meta-.*\.ts$/.test(f))
    .sort()) {
    const text = fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');
    for (const m of text.matchAll(/'([a-z0-9_{},.]+)'/g)) {
      if (!fieldList.test(m[1])) continue;
      const names = m[1]
        .replace(/\{[^}]*\}/g, '')
        .split(',')
        .filter(volatileName);
      if (names.length) found.push('src/' + file + ': ' + [...new Set(names)].sort().join(', '));
    }
  }
  return [...new Set(found)].sort();
}

test('lint (L3-14): no Meta field list asks for a meter or a counter, except the reads that decide something from it', () => {
  assert.deepEqual(selections(), [
    // The audience's size and delivery state decide whether a list can be used yet; the review state of a customer list
    // leaves the size out (src/meta-customer-lists.ts: "left out of the review state"), and verification reports it.
    'src/meta-customer-lists.ts: approximate_count_lower_bound, approximate_count_upper_bound',
    // A catalog's product count becomes whether it has any (`has_products`), feeds change it all the time.
    'src/meta-product-catalogs.ts: product_count',
    // The same for a product feed.
    'src/meta-product-feeds.ts: product_count',
    // An activation gate: a go-live reads the ad's review feedback to refuse an ad Meta has not approved. It is a check
    // of the moment, not the state of a reviewed write.
    'src/meta-recipe-activation.ts: ad_review_feedback',
  ]);
});
