import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {createRuntime} from '../dist/server/runtime.js';
import {loadConfig} from '../dist/server/config.js';
import {adGroup, campaign, googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * R2.5 M3, L2-12 (lead's decision on Q2, 2026-11-17): Google's validate-only check runs at prepare without being asked. Before, it ran
 * only for `provider_check: true`, which no White Friday agent sent; it would have caught the Demand Gen, Shopping and Performance Max
 * refusals before a review was spent. The deployment's policy turns it on (`ExecutionPolicy.providerCheckByDefault`, set by the
 * production runtime and by no environment flag), the provider declares it (`validation.byDefault`: Google Ads only), `provider_check:
 * false` opts out, and an explicit `true` behaves as it always did. A default check that cannot run (a rate limit, an outage, a lost
 * reply) does not refuse the prepare: the review is prepared with `provider_check: {status: 'not_run', default: true, reason}`. A
 * rejection blocks execute as before; the check adds information and never removes a gate. Synthetic customer 123 throughout.
 */
const action = 'campaign_budget_mutate_campaign_budgets',
  budgets = (n, name = 'DNU budget') =>
    Array.from({length: n}, (_, i) => ({
      create: {name: name + ' ' + i, amountMicros: '1000000', deliveryMethod: 'STANDARD'},
    })),
  on = {providerCheckByDefault: true};
const events = x => x.store.audit('google-world', 1000).map(row => JSON.parse(row.event).event);

test('with the policy default on, a Google prepare without provider_check sends one validate-only request and marks it as the default', async () => {
  const x = googleWorld({policy: on});
  try {
    const review = await x.prepare(action, budgets(1));
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
    assert.equal(x.validations(), 1, 'one validate-only request');
    assert.equal(x.writes(), 0, 'nothing is applied');
    const sent = x.log.find(r => r.kind === 'validation');
    assert.equal(sent.body.validate_only, true);
    assert.equal(sent.path, '/v25/customers/123/campaignBudgets:mutate');
    const check = review.data.provider_check;
    assert.equal(check.status, 'provider_validated');
    assert.equal(check.default, true, 'a check nobody asked for says so');
    assert.match(check.meaning, /does not prove execute will succeed/);
    // It is audited before it is sent, as an explicit check is.
    assert.ok(events(x).includes('provider_validation_started'));
    assert.ok(events(x).includes('provider_validated'));
    // The review still executes, with the spend acknowledgement a budget needs.
    const done = await x.execute(review);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 600));
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
});

test('provider_check:false opts out, and a re-prepare of the expired review keeps the opt-out; an explicit true is kept as asked', async () => {
  const x = googleWorld({policy: on});
  try {
    const optedOut = await x.prepare(action, budgets(1), {provider_check: false});
    assert.equal(optedOut.success, true, JSON.stringify(optedOut).slice(0, 600));
    assert.equal(x.validations(), 0, 'none sent');
    assert.equal(Object.hasOwn(optedOut.data, 'provider_check'), false);
    const stored = x.store.document('google-world', 'write_review', optedOut.data.review_id);
    assert.equal(stored.prepare_input.provider_check, false, 'the opt-out is part of what prepares the review again');
    x.store.putDocument('google-world', 'write_review', optedOut.data.review_id, {
      ...stored,
      expires_at: Date.now() - 1,
    });
    const expired = await x.execute(optedOut);
    assert.equal(expired.error.code, 'REVIEW_EXPIRED');
    const again = expired.error.details.next_call;
    assert.equal(again.arguments.provider_check, false);
    const reprepared = await x.call(again.tool, again.arguments);
    assert.equal(reprepared.success, true, JSON.stringify(reprepared).slice(0, 600));
    assert.equal(x.validations(), 0, 'the re-prepare is not validated either');
    // An explicit true is recorded as asked and is no default.
    const asked = await x.prepare(action, budgets(1, 'DNU asked'), {provider_check: true});
    assert.equal(x.validations(), 1);
    assert.equal(asked.data.provider_check.status, 'provider_validated');
    assert.equal(
      Object.hasOwn(asked.data.provider_check, 'default'),
      false,
      'an asked check is not marked as a default',
    );
    assert.equal(
      x.store.document('google-world', 'write_review', asked.data.review_id).prepare_input.provider_check,
      true,
    );
    // A call that said nothing records nothing: its re-prepare takes the default again.
    const silent = await x.prepare(action, budgets(1, 'DNU silent'));
    assert.equal(
      Object.hasOwn(
        x.store.document('google-world', 'write_review', silent.data.review_id).prepare_input,
        'provider_check',
      ),
      false,
    );
  } finally {
    x.store.close();
  }
});

test('a rejection of the default check blocks execute, as an explicit one does, and names the field path', async () => {
  const x = googleWorld({policy: on, validation: 'reject'});
  try {
    const review = await x.prepare(action, budgets(1));
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
    const check = review.data.provider_check;
    assert.equal(check.status, 'provider_rejected');
    assert.equal(check.default, true);
    assert.deepEqual(check.field_paths, ['operations[0].create.location']);
    assertRefused(await x.execute(review), 'PROVIDER_VALIDATION_FAILED', {writes: x.writes});
    // Prepared again once the provider accepts it, the review executes.
    x.state.validation = 'pass';
    const again = await x.prepare(action, budgets(1));
    assert.equal(again.data.provider_check.status, 'provider_validated');
    assert.equal((await x.execute(again)).success, true);
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
});

test('a default check that cannot run prepares the review as not_run; an explicit one that cannot run still raises', async () => {
  for (const [validation, reason, cooling] of [
    ['outage', 'UPSTREAM_UNAVAILABLE', false],
    // A 429 also opens the provider's cooldown for the login (the transport's), so the next call of any kind waits: the review itself
    // is prepared, and the rest of this case cannot be walked until the cooldown ends.
    ['rate_limit', 'PLATFORM_RATE_LIMIT', true],
    ['forbidden', undefined, false],
  ]) {
    const x = googleWorld({policy: on, validation});
    try {
      const review = await x.prepare(action, budgets(1));
      assert.equal(review.success, true, validation + ' ' + JSON.stringify(review).slice(0, 600));
      const check = review.data.provider_check;
      assert.equal(check.status, 'not_run', validation);
      assert.equal(check.default, true);
      assert.match(check.reason, /^[A-Z][A-Z_]+$/, 'the reason is the error code: ' + JSON.stringify(check));
      if (reason) assert.equal(check.reason, reason);
      assert.ok(!('field_paths' in check));
      assert.match(check.meaning, /could not be asked/);
      assert.ok(events(x).includes('provider_validation_started'));
      assert.ok(events(x).includes('provider_validation_not_run'));
      if (cooling) continue;
      // Nothing else changes: the review asks for what it would have asked for without the check, and it executes.
      const without = await x.prepare(action, budgets(1, 'DNU without'), {provider_check: false}),
        {idempotency_key: _a, ...required} = review.data.execute_requirements,
        {idempotency_key: _b, ...expected} = without.data.execute_requirements;
      assert.deepEqual(required, expected, validation);
      const done = await x.execute(review);
      assert.equal(done.success, true, validation + ' ' + JSON.stringify(done).slice(0, 600));
      assert.equal(x.writes(), 1);
      // An explicit true behaves as it always did: the failure is raised and no review is prepared.
      const asked = await x.prepare(action, budgets(1, 'DNU asked'), {provider_check: true});
      assert.equal(asked.success, false, validation);
      assert.ok(asked.error.code !== 'INTERNAL_ERROR', validation);
    } finally {
      x.store.close();
    }
  }
  // A lost reply of the default check, as the transport words it for a write, is the provider not answering.
  const lost = googleWorld({policy: on, validation: 'outage'});
  try {
    const asked = await lost.prepare(action, budgets(1), {provider_check: true});
    assertRefused(asked, 'UPSTREAM_UNAVAILABLE');
    assert.equal(asked.error.details.validation_only, true);
  } finally {
    lost.store.close();
  }
});

test('an authority failure around the default check is not hidden: only the provider’s own answers make it not_run', async () => {
  const x = googleWorld({policy: on});
  try {
    // The account's write grant is withdrawn while the provider is answering the check: AMCP's own access check after the answer
    // refuses, and that is no provider failure, so the prepare is refused and no review is kept.
    x.hooks.beforeValidationReply = () =>
      x.store.putConnection(
        {tenantId: 'google-world', userId: 'operator', role: 'admin'},
        {
          id: 'g',
          tenantId: 'google-world',
          gateway: 'google_ads_native_action',
          accounts: ['123'],
          writeAccounts: [],
          enabled: true,
          label: 'Synthetic',
          scopes: [],
        },
        {accessToken: 'synthetic', developerToken: 'synthetic'},
      );
    const review = await x.prepare(action, budgets(1));
    assertRefused(review, [
      'WRITE_ACCOUNT_FORBIDDEN',
      'FORBIDDEN',
      'ACCOUNT_WRITE_NOT_GRANTED',
      'CONNECTION_AUTHORITY_CHANGED',
    ]);
    assert.equal(x.validations(), 1, 'the check was sent; its answer is what the grant check refused after');
    assert.equal(x.writes(), 0);
    assert.ok(!events(x).includes('provider_validation_not_run'));
  } finally {
    x.store.close();
  }
});

test('Meta gets no default: a Meta prepare sends no validation, and an explicit true still validates', async () => {
  const owner = {tenantId: 'meta-default', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 86).toString('base64'));
  store.putConnection(
    owner,
    {
      id: 'm',
      tenantId: owner.tenantId,
      gateway: 'meta_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  const posts = [];
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (url, init = {}) => {
        const path = new URL(String(url)).pathname,
          method = init.method ?? 'GET';
        if (method === 'POST') {
          posts.push({path, body: String(init.body)});
          return Response.json({success: true});
        }
        return Response.json({id: 'act_123', account_id: '123', currency: 'USD', account_status: 1});
      },
      async () => {},
    ),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true, ...on},
  );
  try {
    const campaign = {
      action: 'meta_campaign_create',
      account_id: '123',
      payload: {
        name: 'DNU draft',
        status: 'PAUSED',
        objective: 'OUTCOME_TRAFFIC',
        special_ad_categories: [],
        is_adset_budget_sharing_enabled: false,
      },
    };
    const prepare = (extra = {}) =>
      service.call(
        'amcp_write',
        {action: 'prepare', gateway: 'meta_native_action', connection_id: 'm', arguments: campaign, ...extra},
        owner,
      );
    const plain = await prepare();
    assert.equal(plain.success, true, JSON.stringify(plain).slice(0, 600));
    assert.equal(posts.length, 0, 'Meta is opt-in: no validation was sent');
    assert.equal(Object.hasOwn(plain.data, 'provider_check'), false);
    const asked = await prepare({provider_check: true});
    assert.equal(asked.success, true, JSON.stringify(asked).slice(0, 600));
    assert.equal(posts.length, 1, 'an explicit true validates, as it always did');
    assert.match(posts[0].body, /validate_only/);
  } finally {
    store.close();
  }
  // The declaration is Google Ads' alone.
  assert.deepEqual(
    registeredProviderHooks.filter(h => h.validation?.byDefault === true).map(h => h.gateway),
    ['google_ads_native_action'],
  );
  assert.ok(registeredProviderHooks.some(h => h.gateway === 'meta_native_action' && h.validation));
});

test('a Google request of 30 operations is two reviews of parts, and each part is validated: two requests', async () => {
  const x = googleWorld({policy: on});
  try {
    const group = await x.prepare(action, budgets(30));
    assert.equal(group.success, true, JSON.stringify(group).slice(0, 600));
    assert.equal(group.data.group, true);
    assert.equal(group.data.parts.length, 2);
    assert.equal(x.validations(), 2, 'one per part of 25');
    assert.equal(x.writes(), 0);
    // The opt-out reaches every part, and so does an explicit true.
    const before = x.validations();
    const optedOut = await x.prepare(action, budgets(30, 'DNU out'), {provider_check: false});
    assert.equal(optedOut.data.parts.length, 2);
    assert.equal(x.validations(), before, 'no part is validated');
    const asked = await x.prepare(action, budgets(30, 'DNU asked'), {provider_check: true});
    assert.equal(asked.data.parts.length, 2);
    assert.equal(x.validations(), before + 2);
  } finally {
    x.store.close();
  }
});

test('a route that has validateOnly is still validated by default: ad group criteria are, though the user-access services are not (S1-1)', async () => {
  const x = googleWorld({
    policy: on,
    world: {
      campaigns: {[campaign(9)]: {status: 'PAUSED', channel: 'SEARCH'}},
      adGroups: {[adGroup(100)]: {status: 'PAUSED', campaign: campaign(9)}},
    },
  });
  try {
    const review = await x.prepare('ad_group_criterion_mutate_ad_group_criteria', [
      {create: {adGroup: adGroup(100), negative: true, keyword: {text: 'free', matchType: 'BROAD'}}},
    ]);
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
    assert.equal(x.validations(), 1);
    assert.equal(x.log.find(r => r.kind === 'validation').path, '/v25/customers/123/adGroupCriteria:mutate');
    assert.equal(review.data.provider_check.status, 'provider_validated');
    assert.equal(review.data.provider_check.default, true);
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
  // The routes that do not have it are walked against the pinned Discovery document in tests/google-validation-routes.test.mjs, and a
  // user-access prepare under this policy in tests/google-user-access.test.ts; the build route (googleAds:mutate) is pinned by the J12
  // test, which counts its one validation.
});

test('with the policy default off, which is the shape of the policy of every test that builds its own, nothing changes', async () => {
  const x = googleWorld();
  try {
    const plain = await x.prepare(action, budgets(1));
    assert.equal(plain.success, true, JSON.stringify(plain).slice(0, 600));
    assert.equal(x.validations(), 0);
    assert.equal(Object.hasOwn(plain.data, 'provider_check'), false);
    const asked = await x.prepare(action, budgets(1, 'DNU asked'), {provider_check: true});
    assert.equal(asked.data.provider_check.status, 'provider_validated');
    assert.equal(Object.hasOwn(asked.data.provider_check, 'default'), false);
    assert.equal(x.validations(), 1);
    const off = await x.prepare(action, budgets(1, 'DNU off'), {provider_check: false});
    assert.equal(off.success, true);
    assert.equal(x.validations(), 1);
  } finally {
    x.store.close();
  }
});

test('the production runtime turns the default on, and no environment flag does', () => {
  // The runtime of server/runtime.ts is the one deployment policy that sets it; a runtime built from an environment that names no flag
  // has it on, and the policy field is not read from any environment variable.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-m3-provider-check-')),
    key = Buffer.alloc(32, 31).toString('base64');
  try {
    for (const [name, flags] of [
      ['no flag', {}],
      ['flags that name it', {AMCP_PROVIDER_CHECK_BY_DEFAULT: 'false', MIRROR_PROVIDER_CHECK_BY_DEFAULT: 'false'}],
    ]) {
      const runtime = createRuntime(
        loadConfig(
          {MIRROR_DB: path.join(directory, name.replaceAll(' ', '-') + '.sqlite'), MIRROR_MASTER_KEY: key, ...flags},
          'stdio',
        ),
        {log: () => {}},
      );
      try {
        assert.equal(runtime.service.policy.providerCheckByDefault, true, name);
      } finally {
        runtime.store.close();
      }
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
