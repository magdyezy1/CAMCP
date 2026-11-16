import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {recurringStatePaths} from '../dist/src/review-friction.js';
import {standardCreates} from './helpers/tiktok-standard-creates.mjs';
import {advertiserWorld} from './helpers/tiktok-advertiser-noise.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * Round 2.5, package r25-m1-diff (L5-04, design item 3 of the plan's idea 1): `recurring_paths`. When the paths a
 * STATE_CHANGED names also changed in the workspace's recent STATE_CHANGED refusals of the same provider, the refusal
 * lists them, so that an agent that sees one path refuse prepare after prepare knows a field that changes by itself is
 * probably being compared, and reports it (the remedy says so). The data is the review-friction data, the audit of
 * refusals the owner's health view already reads; it adds no provider request, and the check itself is unchanged.
 */
const gateway = 'tiktok_native_action';
const currencyPath = '$[0]["data"]["list"][0]["currency"]';
const namePath = '$[0]["data"]["list"][0]["name"]';
const day = 86400000;

/** One audit row of a refused amcp_write call, as the service writes it for a refusal (src/service.ts). */
const refusal = (provider, paths, review = 'earlier-review') => ({
  tool: 'amcp_write',
  input: {action: 'execute', review_id: review},
  outcome: {
    success: false,
    error: {
      code: 'STATE_CHANGED',
      message: 'Synthetic',
      details: {...(provider ? {gateway: provider} : {}), changed_fields: paths},
    },
  },
});
const insert = (store, tenant, event, at = Date.now()) =>
  store.db
    .prepare('INSERT INTO audit(tenant_id,request_id,event,previous_hash,hash,created_at) VALUES(?,?,?,?,?,?)')
    .run(tenant, 'request-' + Math.random(), JSON.stringify(event), 'synthetic', 'synthetic-' + Math.random(), at);

/** A prepared campaign create, and a function that changes the advertiser and executes it: the refusal. */
async function refusedOnce(f, world, field, value) {
  const prepared = await f.prepare('campaign');
  assert.equal(prepared.success, true, JSON.stringify(prepared.error));
  world[field] = value;
  const refused = await f.execute(prepared.data);
  assertRefused(refused, 'STATE_CHANGED', {writes: () => f.sent.length});
  return {review: prepared.data, refused};
}

test('a refusal names the provider whose state changed, and says nothing recurs when no earlier refusal named its paths', async () => {
  const world = advertiserWorld(),
    f = standardCreates(world, {tenant: 'recurring-first'});
  try {
    const {refused} = await refusedOnce(f, world, 'currency', 'EUR');
    assert.equal(refused.error.details.gateway, gateway);
    assert.deepEqual(refused.error.details.changed_fields, [currencyPath]);
    assert.deepEqual(refused.error.details.recurring_paths, []);
  } finally {
    f.close();
  }
});

test('a path that changed in an earlier refusal of the same provider is named as recurring, from the second prepare on', async () => {
  const world = advertiserWorld(),
    f = standardCreates(world, {tenant: 'recurring-second'});
  try {
    const first = await refusedOnce(f, world, 'currency', 'EUR');
    assert.deepEqual(first.refused.error.details.recurring_paths, []);
    // Prepared again over the state as it is now, and changed again: the same path refuses once more.
    const second = await refusedOnce(f, world, 'currency', 'GBP');
    assert.deepEqual(second.refused.error.details.changed_fields, [currencyPath]);
    assert.deepEqual(second.refused.error.details.recurring_paths, [currencyPath]);
    // A path no earlier refusal named is not recurring, however much the two share.
    const third = await refusedOnce(f, world, 'name', 'Renamed Advertiser');
    assert.deepEqual(third.refused.error.details.changed_fields, [namePath]);
    assert.deepEqual(third.refused.error.details.recurring_paths, []);
    assert.equal(f.sent.length, 0, 'every one of them was refused unsent');
  } finally {
    f.close();
  }
});

test('the same review refused again is one prepare, so its own paths do not recur', async () => {
  const world = advertiserWorld(),
    f = standardCreates(world, {tenant: 'recurring-same-review'});
  try {
    const {review, refused} = await refusedOnce(f, world, 'currency', 'EUR');
    assert.deepEqual(refused.error.details.recurring_paths, []);
    const again = await f.execute(review);
    assertRefused(again, 'STATE_CHANGED', {writes: () => f.sent.length});
    assert.deepEqual(again.error.details.recurring_paths, []);
  } finally {
    f.close();
  }
});

test('only the same provider’s refusals of this workspace within the window, naming the same paths, count', async () => {
  const world = advertiserWorld(),
    f = standardCreates(world, {tenant: 'recurring-scope'}),
    now = Date.now();
  try {
    // Refusals that must not count: another provider, another workspace, older than the window, another path, and one that
    // names no provider (written before the refusal carried it).
    insert(f.store, f.tenant, refusal('google_ads_native_action', [currencyPath]), now - 1000);
    insert(f.store, 'another-workspace', refusal(gateway, [currencyPath]), now - 1000);
    insert(f.store, f.tenant, refusal(gateway, [currencyPath]), now - 31 * day);
    insert(f.store, f.tenant, refusal(gateway, [namePath]), now - 1000);
    insert(f.store, f.tenant, refusal(undefined, [currencyPath]), now - 1000);
    // Not a refusal of a changed state, and not a refusal at all.
    insert(f.store, f.tenant, {...refusal(gateway, [currencyPath]), outcome: {success: true}}, now - 1000);
    insert(f.store, f.tenant, {event: 'write_prepared', note: '"code":"STATE_CHANGED"'}, now - 1000);
    const none = await refusedOnce(f, world, 'currency', 'EUR');
    assert.deepEqual(none.refused.error.details.recurring_paths, []);
    // The control: the same provider's refusal of this workspace, within the window, naming the same path, counts.
    insert(f.store, f.tenant, refusal(gateway, [currencyPath, namePath]), now - 2 * day);
    const counted = await refusedOnce(f, world, 'currency', 'GBP');
    assert.deepEqual(counted.refused.error.details.recurring_paths, [currencyPath]);
  } finally {
    f.close();
  }
});

test('recurring paths are the refusal’s own, the most often named first, a handful at most, and unknown when the audit cannot be read', () => {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64')),
    now = Date.UTC(2026, 10, 16, 12),
    paths = Array.from({length: 14}, (_, i) => '$[0]["field_' + String(i).padStart(2, '0') + '"]');
  try {
    // field_00 named by three refusals, field_01 and field_02 by two, the rest once; field_99 is not in the refusal.
    insert(store, 't', refusal(gateway, [...paths, '$[0]["field_99"]']), now - 1000);
    insert(store, 't', refusal(gateway, paths.slice(0, 3)), now - 2000);
    insert(store, 't', refusal(gateway, paths.slice(0, 1)), now - 3000);
    const got = recurringStatePaths(store, 't', gateway, paths, {now});
    assert.deepEqual(got, [paths[0], paths[1], paths[2], ...paths.slice(3, 10)]);
    assert.equal(got.length, 10);
    assert.ok(!got.includes('$[0]["field_99"]'));
    // Nothing to compare, and nothing earlier.
    assert.deepEqual(recurringStatePaths(store, 't', gateway, [], {now}), []);
    assert.deepEqual(recurringStatePaths(store, 'empty', gateway, paths, {now}), []);
    // An audit that cannot be read leaves recurrence unknown (the field is left out), never a made-up empty answer.
    const broken = {
      sql() {
        throw new Error('database is busy');
      },
    };
    assert.equal(recurringStatePaths(broken, 't', gateway, paths, {now}), undefined);
  } finally {
    store.close();
  }
});
