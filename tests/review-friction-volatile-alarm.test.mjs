import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {reviewFriction} from '../dist/src/review-friction.js';

/**
 * Round 2.5, package r25-m1-diff (design item 4 of the plan's idea 1, the alarm): when one path explains more than a set
 * share of a provider's prepares, the owner's health view raises an alarm. A field that changes by itself and is compared
 * refuses prepare after prepare (the TikTok advertiser row: 7 STATE_CHANGED in 313 prepares, every one a field that
 * changes by itself), and the owner reads it as a rate. The alarm names the provider and the path, so that it is reported
 * before it is a week of refused writes. It reads the audit as the rest of the friction report does, paths only, and it
 * changes no outcome: the check refuses what it refused.
 */
const key = Buffer.alloc(32, 37).toString('base64'),
  now = Date.UTC(2026, 10, 16, 12),
  t0 = now - 3600000,
  tiktok = 'tiktok_native_action',
  google = 'google_ads_native_action';

let at = t0;
const insert = (store, tenant, request, event) =>
  store.db
    .prepare('INSERT INTO audit(tenant_id,request_id,event,previous_hash,hash,created_at) VALUES(?,?,?,?,?,?)')
    .run(tenant, request, JSON.stringify(event), 'synthetic', 'synthetic-' + Math.random(), at++);
const prepared = (store, tenant, gateway, n) => {
  for (let i = 0; i < n; i++) insert(store, tenant, gateway + '-w' + i, {event: 'write_prepared', request: {gateway}});
};
const mediaPrepared = (store, tenant, platform, n) => {
  for (let i = 0; i < n; i++) insert(store, tenant, platform + '-m' + i, {event: 'media_prepared', plan: {platform}});
};
const refused = (store, tenant, gateway, paths, tool = 'amcp_write') =>
  insert(store, tenant, 'refusal-' + at, {
    tool,
    input: {action: 'execute', review_id: 'r' + at},
    outcome: {
      success: false,
      error: {
        code: 'STATE_CHANGED',
        message: 'Synthetic',
        details: {...(gateway ? {gateway} : {}), changed_fields: paths},
      },
    },
  });

test('a path that explains more than 5 in 100 of a provider’s prepares raises an alarm naming the provider and the path', () => {
  const store = new Store(':memory:', key);
  try {
    prepared(store, 't', tiktok, 30);
    // 4 of 30 prepares: 13.33 in 100, more than the share and at least three refusals.
    for (let i = 0; i < 4; i++) refused(store, 't', tiktok, ['$[0]["data"]["list"][0]["license_url"]']);
    const r = reviewFriction(store, 't', 30, now);
    assert.deepEqual(r.volatile_path_alarms, [
      {
        gateway: tiktok,
        path: '$[0]["data"]["list"][0]["license_url"]',
        refusals: 4,
        prepares: 30,
        per_100_prepares: 13.33,
      },
    ]);
    // The rule the alarm applies is stated, so the owner reads a rate against it.
    assert.deepEqual(r.volatile_path_rule, {per_100_prepares: 5, minimum_refusals: 3, minimum_prepares: 20});
    // The view's other numbers are as they were: the writes' own counts.
    assert.equal(r.counts.STATE_CHANGED, 4);
    assert.equal(r.prepares, 30);
  } finally {
    store.close();
  }
});

test('no alarm below the share, below three refusals, or on a provider with too few prepares, and exactly 5 in 100 is not more', () => {
  const store = new Store(':memory:', key);
  try {
    // Google: 60 prepares. A path refused 3 times is exactly 5 in 100: not more than 5. Another, twice: under three.
    prepared(store, 't', google, 60);
    for (let i = 0; i < 3; i++) refused(store, 't', google, ['$[0]["a"]']);
    for (let i = 0; i < 2; i++) refused(store, 't', google, ['$[0]["b"]']);
    // TikTok: 10 prepares only, a path refused 3 times (30 in 100): too few prepares to read a rate from.
    prepared(store, 't', tiktok, 10);
    for (let i = 0; i < 3; i++) refused(store, 't', tiktok, ['$[0]["c"]']);
    // Meta: 25 prepares, a path refused twice (8 in 100): over the share, but only two refusals.
    prepared(store, 't', 'meta_native_action', 25);
    for (let i = 0; i < 2; i++) refused(store, 't', 'meta_native_action', ['$[0]["e"]']);
    // A refusal written before it named its provider belongs to no provider.
    for (let i = 0; i < 5; i++) refused(store, 't', undefined, ['$[0]["d"]']);
    const r = reviewFriction(store, 't', 30, now);
    assert.deepEqual(r.volatile_path_alarms, []);
    // One more refusal of the same path tips it over: 4 of 60 is 6.67 in 100.
    refused(store, 't', google, ['$[0]["a"]']);
    assert.deepEqual(
      reviewFriction(store, 't', 30, now).volatile_path_alarms.map(a => [
        a.gateway,
        a.path,
        a.refusals,
        a.per_100_prepares,
      ]),
      [[google, '$[0]["a"]', 4, 6.67]],
    );
  } finally {
    store.close();
  }
});

test('a provider’s media reviews count as its prepares and its media refusals as its refusals, and each provider is its own', () => {
  const store = new Store(':memory:', key);
  try {
    // 20 write prepares and 20 media prepares of TikTok: 40. Two write refusals and two media refusals name one path: 4 of 40.
    prepared(store, 't', tiktok, 20);
    mediaPrepared(store, 't', 'tiktok', 20);
    for (let i = 0; i < 2; i++) refused(store, 't', tiktok, ['$["data"]["list"][0]["license_url"]'], 'amcp_write');
    for (let i = 0; i < 2; i++) refused(store, 't', tiktok, ['$["data"]["list"][0]["license_url"]'], 'amcp_media');
    // Google has the same path name and no prepares of its own to explain.
    for (let i = 0; i < 4; i++) refused(store, 't', google, ['$["data"]["list"][0]["license_url"]']);
    const r = reviewFriction(store, 't', 30, now);
    assert.deepEqual(
      r.volatile_path_alarms.map(a => [a.gateway, a.refusals, a.prepares, a.per_100_prepares]),
      [[tiktok, 4, 40, 10]],
    );
  } finally {
    store.close();
  }
});

test('the alarms are the worst first, ten at most, scoped to the workspace and its window', () => {
  const store = new Store(':memory:', key);
  try {
    prepared(store, 't', tiktok, 100);
    // Twelve paths, the n-th refused n + 5 times: 6 to 17 in 100. All are alarms; ten are shown, the worst first.
    for (let n = 1; n <= 12; n++)
      for (let i = 0; i < n + 5; i++) refused(store, 't', tiktok, ['$[0]["field_' + String(n).padStart(2, '0') + '"]']);
    // Another workspace and an older window explain nothing here.
    prepared(store, 'other', tiktok, 5);
    for (let i = 0; i < 50; i++) refused(store, 'other', tiktok, ['$[0]["other"]']);
    const r = reviewFriction(store, 't', 30, now);
    assert.equal(r.volatile_path_alarms.length, 10);
    assert.deepEqual(
      r.volatile_path_alarms.map(a => a.refusals),
      [17, 16, 15, 14, 13, 12, 11, 10, 9, 8],
    );
    assert.equal(r.volatile_path_alarms[0].path, '$[0]["field_12"]');
    assert.ok(r.volatile_path_alarms.every(a => a.gateway === tiktok));
    assert.ok(!JSON.stringify(r.volatile_path_alarms).includes('other'));
    // A workspace with no prepares has no alarm and no rate.
    assert.deepEqual(reviewFriction(store, 'empty', 30, now).volatile_path_alarms, []);
  } finally {
    store.close();
  }
});
