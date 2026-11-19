import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {NativeTransport} from '../dist/src/transport.js';
import {MirrorService} from '../dist/src/service.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {withoutParkedProviders} from './helpers/parked-providers.mjs';

/**
 * Round 2.5 field fix, package r25-field-callshape (2026-11-19). amcp_write takes `gateway` at its top level and the
 * account inside `arguments`; a plan step of amcp_campaign takes the gateway, the connection and the account beside
 * `arguments`. An agent that wrote one tool's shape to the other was refused, three times in one session, by a sentence
 * that named neither the fault nor the fix. Item 1: a gateway written inside `arguments` is read as the gateway, with a
 * deprecation warning. Every value here is synthetic, and nothing is sent to any provider.
 */
const actor = {tenantId: 'synthetic-call-shape', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'},
  META = 'meta_native_action',
  GOOGLE = 'google_ads_native_action',
  CONNECTION = '33333333-3333-4333-8333-333333333333';
const registry = new Registry();

/** One synthetic Meta login and account whose state read is a canned answer; a write is never answered. */
function harness(t, policy = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true}) {
  const store = new Store(':memory:', Buffer.alloc(32, 61).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    admin,
    {
      id: CONNECTION,
      tenantId: actor.tenantId,
      gateway: META,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic login',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  const requests = [];
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(async (url, init = {}) => {
      requests.push(init.method ?? 'GET');
      if ((init.method ?? 'GET') === 'GET')
        return new Response(JSON.stringify({id: 'act_123', currency: 'USD', account_status: 1}));
      throw new Error('A write is never sent in the call-shape tests');
    }),
    undefined,
    policy,
  );
  return {
    store,
    service,
    requests: () => requests.length,
    writes: () => requests.filter(method => method !== 'GET').length,
    write: (input, who = actor) => service.call('amcp_write', input, who),
    review: id => store.document(actor.tenantId, 'write_review', id),
  };
}
/** The native input of a paused Meta campaign create: what `arguments` holds, with the account inside it. */
const native = () => ({
  action: 'meta_campaign_create',
  account_id: '123',
  payload: {
    name: 'Synthetic draft',
    status: 'PAUSED',
    objective: 'OUTCOME_TRAFFIC',
    special_ad_categories: [],
    is_adset_budget_sharing_enabled: false,
  },
});
const warningsOf = result => result.meta?.argument_warnings ?? [];
const lifted = result => warningsOf(result).filter(w => w.code === 'GATEWAY_PLACEMENT_DEPRECATED');

// ---- Item 1: amcp_write accepts arguments.gateway ----

test('a gateway written inside arguments is read as the gateway: the call prepares as the canonical one does, with a warning', async t => {
  const f = harness(t),
    canonical = await f.write({action: 'prepare', gateway: META, arguments: native()}),
    inner = await f.write({action: 'prepare', arguments: {gateway: META, ...native()}});
  assert.equal(canonical.success, true, JSON.stringify(canonical.error));
  assert.equal(inner.success, true, JSON.stringify(inner.error));
  assert.equal(inner.data.executed, false);
  assert.equal(f.writes(), 0);
  // Prepared as the canonical call: the same frozen request, the same state and the same fingerprint.
  assert.deepEqual(inner.data.request, canonical.data.request);
  assert.equal(inner.data.state_hash, canonical.data.state_hash);
  assert.equal(inner.data.fingerprint, canonical.data.fingerprint);
  // The review keeps the canonical shape: the gateway at the top level, and none inside arguments.
  const kept = f.review(inner.data.review_id).prepare_input;
  assert.equal(kept.gateway, META);
  assert.equal(Object.hasOwn(kept.arguments, 'gateway'), false);
  assert.deepEqual(kept, f.review(canonical.data.review_id).prepare_input);
  // The caller is told, in meta.argument_warnings, where the gateway belongs; the canonical call is told nothing.
  const [warning, ...rest] = lifted(inner);
  assert.equal(rest.length, 0);
  assert.equal(warning.field, 'arguments.gateway');
  assert.match(warning.message, /top level/);
  assert.deepEqual(lifted(canonical), []);
});

test('every later call that starts from the review names the gateway at the top level, as the canonical call does', async t => {
  const f = harness(t),
    prepared = await f.write({action: 'prepare', arguments: {gateway: META, ...native()}});
  assert.equal(prepared.success, true, JSON.stringify(prepared.error));
  // The review lapsed: the call that prepares it again is the stored prepare input, in the canonical shape.
  const review = f.review(prepared.data.review_id);
  f.store.putDocument(actor.tenantId, 'write_review', prepared.data.review_id, {...review, expires_at: 0});
  const expired = await f.write({
    action: 'execute',
    review_id: prepared.data.review_id,
    idempotency_key: prepared.data.idempotency_key,
    confirmed: true,
  });
  assertRefused(expired, 'REVIEW_EXPIRED', {writes: f.writes});
  const again = expired.error.details.next_call.arguments;
  assert.equal(again.action, 'prepare');
  assert.equal(again.gateway, META);
  assert.equal(Object.hasOwn(again.arguments, 'gateway'), false);
  // And that call prepares without any warning.
  const second = await f.write(again);
  assert.equal(second.success, true, JSON.stringify(second.error));
  assert.deepEqual(lifted(second), []);
});

test('inspect reads it the same way', async t => {
  const f = harness(t),
    inspected = await f.write({action: 'inspect', arguments: {gateway: META, ...native()}});
  assert.equal(inspected.success, true, JSON.stringify(inspected.error));
  assert.equal(inspected.data.review_contract_supported, true);
  assert.equal(lifted(inspected).length, 1);
  assert.equal(f.requests(), 0, 'inspect reads no state');
});

test('a gateway at the top level is never moved: a different one inside arguments stays where it is and is refused as before', async t => {
  const f = harness(t);
  for (const inner of [GOOGLE, META]) {
    const refused = await f.write({action: 'prepare', gateway: META, arguments: {gateway: inner, ...native()}});
    // The native action itself refuses a gateway argument it does not take, exactly as it did before this package.
    assertRefused(refused, 'UNSUPPORTED_PARAMETER', {writes: f.writes});
    assert.deepEqual(refused.error.details, {parameter: 'gateway'});
    assert.deepEqual(lifted(refused), [], 'nothing was moved, so nothing is reported');
  }
  assert.equal(f.requests(), 0, 'nothing was read');
  assert.equal(f.store.documents(actor.tenantId, 'write_review').length, 0, 'no review was saved');
});

test('a gateway the registry does not know is not moved: the call is refused as before', async t => {
  const f = harness(t);
  for (const inner of ['not_a_gateway', 7, null, '', {name: GOOGLE}]) {
    const refused = await f.write({action: 'prepare', arguments: {gateway: inner, ...native()}});
    assertRefused(refused, 'INVALID_ARGUMENT', {message: /prepare requires gateway and arguments/, writes: f.writes});
    assert.deepEqual(lifted(refused), []);
  }
  assert.equal(f.requests(), 0);
});

test('only prepare and inspect read it: a gateway inside arguments of another action is left alone', async t => {
  const f = harness(t);
  // execute takes no arguments: it is refused for them, as before, with nothing moved or reported.
  const refused = await f.write({action: 'execute', review_id: 'no-such-review', arguments: {gateway: META}});
  assertRefused(refused, 'INVALID_ARGUMENT', {message: /Remove arguments: execute takes review_id/, writes: f.writes});
  assert.deepEqual(lifted(refused), []);
  assert.equal(f.requests(), 0);
});

test('a provider this deployment does not offer is refused as it is at the top level, before anything is read', async t => {
  withoutParkedProviders(t);
  const f = harness(t),
    parked = 'amazon_native_action',
    top = await f.write({action: 'prepare', gateway: parked, arguments: native()}),
    inner = await f.write({action: 'prepare', arguments: {gateway: parked, ...native()}});
  assertRefused(top, 'GATEWAY_NOT_OFFERED');
  assertRefused(inner, 'GATEWAY_NOT_OFFERED');
  assert.deepEqual(inner.error.details, top.error.details);
  assert.equal(f.requests(), 0);
});

test('a read-only deployment names the canonical inspect call, with the gateway at the top level', async t => {
  const f = harness(t, {allowWrites: false}),
    refused = await f.write({action: 'prepare', arguments: {gateway: META, ...native()}});
  assertRefused(refused, 'LIVE_WRITES_DISABLED');
  const next = refused.error.details.next_call;
  assert.equal(next.tool, 'amcp_write');
  assert.equal(next.arguments.action, 'inspect');
  assert.equal(next.arguments.gateway, META);
  assert.equal(Object.hasOwn(next.arguments.arguments, 'gateway'), false);
  // That call, as named, is the canonical one, and inspect is open to a read-only deployment.
  const inspected = await f.write(next.arguments);
  assert.equal(inspected.success, true, JSON.stringify(inspected.error));
  assert.deepEqual(lifted(inspected), []);
});

/** One synthetic Google Ads login whose reads are canned: enough to prepare a list of negative keywords in parts of 25. */
function googleHarness(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 62).toString('base64')),
    campaign = 'customers/123/campaigns/9';
  t.after(() => store.close());
  store.putConnection(
    admin,
    {
      id: 'synthetic-google',
      tenantId: actor.tenantId,
      gateway: GOOGLE,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Google login',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(async (url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')),
        query = String(body.query ?? '') + ' ';
      if (!new URL(String(url)).pathname.endsWith('googleAds:search')) throw new Error('A write is never sent here');
      if (/ FROM customer /.test(query))
        return Response.json({results: [{customer: {id: '123', currencyCode: 'USD', timeZone: 'UTC'}}]});
      if (/ FROM campaign /.test(query))
        return Response.json({
          results: [
            {
              campaign: {
                resourceName: campaign,
                name: 'Search',
                status: 'PAUSED',
                advertisingChannelType: 'SEARCH',
                campaignBudget: 'customers/123/campaignBudgets/1',
              },
            },
          ],
        });
      return Response.json({results: []});
    }),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  );
  const negatives = count =>
    Array.from({length: count}, (_, i) => ({
      create: {campaign, negative: true, keyword: {text: 'synthetic term ' + i, matchType: 'PHRASE'}},
    }));
  const nativeInput = count => ({
    action: 'google_ads_v23_campaign_criterion_mutate_campaign_criteria',
    account_id: '123',
    payload: {operations: negatives(count)},
  });
  return {store, nativeInput, write: input => service.call('amcp_write', input, actor)};
}

test('a list longer than one native call takes is split into parts whichever way the gateway is written', async t => {
  const f = googleHarness(t),
    canonical = await f.write({action: 'prepare', gateway: GOOGLE, arguments: f.nativeInput(30)}),
    inner = await f.write({action: 'prepare', arguments: {gateway: GOOGLE, ...f.nativeInput(30)}});
  assert.equal(canonical.success, true, JSON.stringify(canonical).slice(0, 500));
  assert.equal(inner.success, true, JSON.stringify(inner).slice(0, 500));
  // One review of two parts, as for the canonical call: the group check read the gateway too.
  assert.equal(inner.data.group, true);
  assert.deepEqual(
    inner.data.parts.map(part => part.records),
    canonical.data.parts.map(part => part.records),
  );
  assert.deepEqual(
    inner.data.parts.map(part => part.records),
    [25, 5],
  );
  assert.equal(lifted(inner).length, 1);
  // The group and each of its parts keep the canonical shape.
  const group = f.store.document(actor.tenantId, 'write_review_group', inner.data.review_id);
  assert.equal(group.prepare_input.gateway, GOOGLE);
  assert.equal(Object.hasOwn(group.prepare_input.arguments, 'gateway'), false);
  for (const part of inner.data.parts) {
    const kept = f.store.document(actor.tenantId, 'write_review', part.review_id).prepare_input;
    assert.equal(kept.gateway, GOOGLE);
    assert.equal(Object.hasOwn(kept.arguments, 'gateway'), false);
  }
});

test('a near-miss action name beside it is reported too, as it is beside a gateway at the top level', async t => {
  const f = harness(t),
    prepared = await f.write({
      action: 'prepare',
      arguments: {gateway: META, ...native(), action: 'campaign_create'},
    });
  assert.equal(prepared.success, true, JSON.stringify(prepared.error));
  const codes = warningsOf(prepared).map(w => [w.code, w.field]);
  assert.deepEqual(
    codes.sort(),
    [
      ['ACTION_ALIAS_DEPRECATED', 'arguments.action'],
      ['GATEWAY_PLACEMENT_DEPRECATED', 'arguments.gateway'],
    ].sort(),
  );
  // Saved under the canonical action name, as for a gateway at the top level.
  const canonical = await f.write({
      action: 'prepare',
      gateway: META,
      arguments: {...native(), action: 'campaign_create'},
    }),
    saved = f.review(prepared.data.review_id).prepare_input.arguments.action;
  assert.equal(canonical.success, true, JSON.stringify(canonical.error));
  assert.equal(saved, f.review(canonical.data.review_id).prepare_input.arguments.action);
  assert.notEqual(saved, 'campaign_create');
});
