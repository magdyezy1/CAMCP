import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {standardCreates, standardBodies} from './helpers/tiktok-standard-creates.mjs';
import {advertiserWorld} from './helpers/tiktok-advertiser-noise.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * Round 2.5, package r25-m1-diff (T2): "provider check unavailable" next to STATE_CHANGED. In the White Friday report an
 * agent read provider_check_available:false in an inspect, then met STATE_CHANGED, took the flag for a way past the
 * check, and tried to pass provider_check to execute. The two are different checks. provider_check asks the provider to
 * validate a request without applying it, where the provider has such a route (none for TikTok); AMCP's own check reads
 * the provider's state again at execute and refuses a changed state, and no flag skips it. The review now says why a
 * provider check is unavailable, and the words next to a STATE_CHANGED do not read as contradictory.
 */
const owner = {tenantId: 'provider-check-reason', userId: 'owner', role: 'admin'},
  google = {
    action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
    account_id: '123',
    payload: {operations: [{create: {name: 'Budget', amount_micros: '1000000', delivery_method: 'STANDARD'}}]},
  },
  meta = {
    action: 'meta_campaign_create',
    account_id: '123',
    payload: {
      name: 'Draft',
      status: 'PAUSED',
      objective: 'OUTCOME_TRAFFIC',
      special_ad_categories: [],
      is_adset_budget_sharing_enabled: false,
    },
  };

/** What the reason must say, whatever its wording: no qualified route, not AMCP's own check, which no flag skips. */
const reasonMeaning = [
  /validate-only/,
  /provider_check/,
  /AMCP’s (?:own )?state check/,
  /STATE_CHANGED/,
  /no flag skips/i,
];

test('inspect says why a provider check is unavailable, and that it is not the check STATE_CHANGED comes from', async () => {
  const world = advertiserWorld(),
    f = standardCreates(world, {tenant: 'check-reason-tiktok'});
  try {
    const inspected = await f.write({
      action: 'inspect',
      arguments: {
        action: standardBodies(world.id).campaign.action,
        account_id: world.id,
        payload: standardBodies(world.id).campaign.payload,
      },
    });
    assert.equal(inspected.success, true, JSON.stringify(inspected).slice(0, 800));
    assert.equal(inspected.data.provider_check_available, false);
    const reason = inspected.data.provider_check_reason;
    assert.equal(typeof reason, 'string', 'a reason comes with the false');
    for (const part of reasonMeaning) assert.match(reason, part);
    // The shared module names no provider: what the reason says holds for every provider without a qualified route.
    assert.doesNotMatch(reason, /TikTok/i);
    assert.equal(f.sent.length, 0, 'inspect sends nothing');
  } finally {
    f.close();
  }
});

test('an available provider check carries no reason', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 93).toString('base64')),
    service = new MirrorService(new Registry(), store, undefined, undefined, {allowWrites: true, maxBudgetChange: 0});
  try {
    for (const [gateway, args] of [
      ['google_ads_native_action', google],
      ['meta_native_action', meta],
    ]) {
      const inspected = await service.call('amcp_write', {action: 'inspect', gateway, arguments: args}, owner);
      assert.equal(inspected.success, true, JSON.stringify(inspected).slice(0, 600));
      assert.equal(inspected.data.provider_check_available, true, gateway);
      assert.equal(Object.hasOwn(inspected.data, 'provider_check_reason'), false, gateway + ' has no reason to give');
    }
  } finally {
    store.close();
  }
});

test('the words of the two checks agree: a provider check that is unavailable and a state that changed are both true at once', async () => {
  const world = advertiserWorld(),
    f = standardCreates(world, {tenant: 'check-reason-agree'});
  try {
    const inspected = await f.write({
      action: 'inspect',
      arguments: {
        action: standardBodies(world.id).campaign.action,
        account_id: world.id,
        payload: standardBodies(world.id).campaign.payload,
      },
    });
    const prepared = await f.prepare('campaign');
    assert.equal(prepared.success, true, JSON.stringify(prepared.error));
    world.currency = 'EUR';
    const refused = await f.execute(prepared.data);
    assertRefused(refused, 'STATE_CHANGED', {writes: () => f.sent.length});
    // Together: no provider check is available, and execute still refuses a changed state; neither says a flag skips it.
    assert.equal(inspected.data.provider_check_available, false);
    assert.match(inspected.data.provider_check_reason, /no flag skips/i);
    assert.match(refused.error.remedy.action, /No flag skips this check/);
    assert.match(refused.error.next_action, /No flag skips this check/);
  } finally {
    f.close();
  }
});

test('provider_check reaches only prepare: execute says so, and says that it does not skip the state check', async () => {
  const world = advertiserWorld(),
    f = standardCreates(world, {tenant: 'check-reason-execute'});
  try {
    const prepared = await f.prepare('campaign');
    assert.equal(prepared.success, true, JSON.stringify(prepared.error));
    for (const provider_check of [true, false]) {
      const refused = await f.execute(prepared.data, {provider_check});
      assertRefused(refused, 'INVALID_ARGUMENT', {writes: () => f.sent.length});
      assert.equal(refused.error.details.field, 'provider_check');
      assert.match(refused.error.message, /argument of prepare only/);
      assert.match(refused.error.message, /validate a request without applying it/);
      assert.match(refused.error.message, /state check/);
      assert.match(refused.error.message, /no flag skips/i);
    }
    // At prepare, a request with no qualified provider check is refused as it was, naming where one exists.
    const asked = await f.write({
      action: 'prepare',
      provider_check: true,
      arguments: {
        action: standardBodies(world.id).campaign.action,
        account_id: world.id,
        payload: standardBodies(world.id).campaign.payload,
      },
    });
    assertRefused(asked, 'INVALID_ARGUMENT', {message: /^provider_check is available for Google Ads mutate requests/});
    // A value that is no boolean, at prepare, keeps the sentence it always had.
    const bad = await f.write({
      action: 'prepare',
      provider_check: 'yes',
      arguments: {
        action: standardBodies(world.id).campaign.action,
        account_id: world.id,
        payload: standardBodies(world.id).campaign.payload,
      },
    });
    assertRefused(bad, 'INVALID_ARGUMENT', {message: /^provider_check is a boolean that prepare takes\.$/});
    // The review is not spoiled: it still executes once the call is right.
    const done = await f.execute(prepared.data);
    assert.equal(done.success, true, JSON.stringify(done.error));
    assert.equal(f.sent.length, 1);
  } finally {
    f.close();
  }
});

test('a plain STATE_CHANGED does not mention provider_check at all', () => {
  const e = new MirrorError('STATE_CHANGED', 'Changed.', {
    expected_state_hash: 'a',
    actual_state_hash: 'b',
    changed_fields: ['$[0]["x"]'],
  });
  const {error} = errorResult(e, 'request', 1);
  for (const text of [error.remedy.action, error.next_action]) assert.doesNotMatch(text, /provider_check/);
});
