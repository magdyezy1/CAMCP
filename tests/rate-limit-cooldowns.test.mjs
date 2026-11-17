// Package r25-m2-refusal, the lead's review S2-1 (MT3, Round 2.5 M2): the rate_limit that a call and `amcp_workspace check` show must
// read the cooldown AMCP itself refuses on. The transport refuses a request on its own process's cooldown map and on the shared
// store's `provider_cooldowns`, which another process of the deployment, or this one before a restart, can set; and a provider with
// rate keys of its own (X: per access token, origin and endpoint) cools those, which no connection and account can compute. The first
// version of the view read only this process's map under the tenant's keys, so a throttle the store held showed as ok or unknown,
// and a refused call could carry `rate_limit: ok`. Every value is synthetic; nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const owner = {tenantId: 'cooling', userId: 'owner', role: 'admin'};
const meta = 'meta_native_action';
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});
const account = {
  id: 'act_123',
  account_id: '123',
  name: 'Synthetic',
  currency: 'USD',
  timezone_name: 'UTC',
  account_status: 1,
  tos_accepted: {custom_audience_tos: 1},
};
/** Meta's documented usage header: one business use case of the ad account, at `percent` and not blocked. */
const usage = percent => ({
  'x-business-use-case-usage': JSON.stringify({
    123: [
      {
        type: 'ads_management',
        call_count: percent,
        total_cputime: 5,
        total_time: 5,
        estimated_time_to_regain_access: 0,
      },
    ],
  }),
});
const seconds = ahead => String(Math.ceil(Date.now() / 1000) + ahead);
const throttledMeta = () => json({error: {message: 'Too many calls', code: 4}}, 429, {'retry-after': '600'});
const throttledX = header =>
  json({errors: [{code: 88, message: 'Rate limit exceeded'}]}, 429, {[header]: seconds(120)});

/** The store every process of a deployment shares: a Meta login with ad account 123 and an X login with account xacct. */
function sharedStore() {
  const store = new Store(':memory:', Buffer.alloc(32, 83).toString('base64'));
  for (const [id, gateway, accounts, credentials] of [
    ['m', meta, ['123'], {accessToken: 'synthetic'}],
    [
      'x',
      'x_ads_native_action',
      ['xacct'],
      {consumerKey: 'synthetic', consumerSecret: 'synthetic', accessToken: 'synthetic', tokenSecret: 'synthetic'},
    ],
  ])
    store.putConnection(
      owner,
      {
        id,
        tenantId: owner.tenantId,
        gateway,
        accounts,
        writeAccounts: accounts,
        enabled: true,
        label: id,
        scopes: ['ads_read', 'ads_management'],
      },
      credentials,
    );
  return store;
}
/** One process of the deployment: a service over a transport of its own, on the shared store. `sent` counts what it sent. */
function processOn(store, answer) {
  const sent = [];
  const transport = new NativeTransport(
    async (raw, init = {}) => {
      sent.push((init.method ?? 'GET') + ' ' + new URL(String(raw)).pathname);
      return answer(sent.length, new URL(String(raw)).pathname, init.method ?? 'GET');
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    1000000,
    1,
    1000,
  );
  transport.coordination = store;
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const call = (tool, input) => service.call(tool, input, owner);
  return {
    transport,
    sent,
    call,
    check: (input = {}) => call('amcp_workspace', {action: 'check', connection_id: 'm', account_id: '123', ...input}),
    checkX: (input = {}) =>
      call('amcp_workspace', {action: 'check', connection_id: 'x', account_id: 'xacct', ...input}),
    prepare: () =>
      call('amcp_write', {
        action: 'prepare',
        gateway: meta,
        arguments: {
          action: 'meta_campaign_create',
          account_id: '123',
          payload: {
            name: 'Draft',
            status: 'PAUSED',
            objective: 'OUTCOME_TRAFFIC',
            special_ad_categories: [],
            is_adset_budget_sharing_enabled: false,
          },
        },
      }),
  };
}
const metaAccount = (n, path) => (path === '/v26.0/act_123' ? json(account, 200, usage(10)) : json({data: []}));
const waits = shown => Date.parse(shown.until) - Date.now();

test('a cooldown another process opened, of which this one holds no entry, shows as cooling in check and in the refused call', async () => {
  const store = sharedStore();
  try {
    const here = processOn(store, metaAccount);
    assert.deepEqual((await here.check({live: true})).data.rate_limit, {state: 'ok', usage_pct: 10});
    // Another process of the deployment is throttled by Meta for this login: a 429 that names ten minutes. Only the shared store
    // learns it; this process's own map has nothing.
    const there = processOn(store, throttledMeta);
    await there.check({live: true});
    const cooling = await here.check();
    assert.equal(cooling.data.rate_limit.state, 'cooling', JSON.stringify(cooling.data.rate_limit));
    assert.ok(waits(cooling.data.rate_limit) > 9 * 60000, 'ten minutes, as the store holds them');
    assert.equal(cooling.data.rate_limit.usage_pct, 10, 'what this process saw of the usage is kept');
    // The refusal AMCP itself makes on that row is a cooling answer, never ok.
    const refused = await here.prepare();
    assertRefused(refused, 'PLATFORM_RATE_LIMIT');
    assert.equal(refused.meta.rate_limit?.state, 'cooling', JSON.stringify(refused.meta));
    assert.ok(waits(refused.meta.rate_limit) > 9 * 60000);
  } finally {
    store.close();
  }
});

test('a process that has read nothing, a restart, shows the cooldown the store holds and not unknown', async () => {
  const store = sharedStore();
  try {
    await processOn(store, throttledMeta).check({live: true});
    const restarted = processOn(store, () => {
      throw new Error('Nothing is sent while the cooldown holds');
    });
    const shown = await restarted.check();
    assert.equal(shown.data.rate_limit.state, 'cooling', JSON.stringify(shown.data.rate_limit));
    assert.ok(waits(shown.data.rate_limit) > 9 * 60000);
    const refused = await restarted.prepare();
    assertRefused(refused, 'PLATFORM_RATE_LIMIT');
    assert.equal(refused.meta.rate_limit?.state, 'cooling');
    assert.deepEqual(restarted.sent, [], 'refused before anything was sent');
  } finally {
    store.close();
  }
});

for (const header of ['x-rate-limit-reset', 'x-account-rate-limit-reset'])
  test(
    'an X throttle shows as cooling, though X keys its cooldown by token, origin and endpoint (' + header + ')',
    async () => {
      const store = sharedStore();
      try {
        const x = processOn(store, () => throttledX(header));
        assert.deepEqual((await x.checkX()).data.rate_limit, {state: 'unknown'});
        const throttled = await x.checkX({live: true});
        assert.equal(throttled.data.rate_limit.state, 'cooling', JSON.stringify(throttled.data.rate_limit));
        assert.ok(waits(throttled.data.rate_limit) > 100000, 'the two minutes X named');
        assert.equal(throttled.meta.rate_limit?.state, 'cooling', 'the answer of the call that met it shows it too');
        const later = await x.checkX();
        assert.equal(later.data.rate_limit.state, 'cooling');
        assert.equal(x.sent.length, 1, 'the later check sent nothing');
        // X's cooldown is one login's: a Meta login of the workspace is untouched.
        assert.deepEqual((await x.check()).data.rate_limit, {state: 'unknown'});
      } finally {
        store.close();
      }
    },
  );

test('an X cooldown another process opened refuses a request here, and the answer of the refused call shows it as cooling', async () => {
  const store = sharedStore();
  try {
    await processOn(store, () => throttledX('x-rate-limit-reset')).checkX({live: true});
    const here = processOn(store, () => {
      throw new Error('Nothing is sent while the cooldown holds');
    });
    const refused = await here.checkX({live: true});
    assert.deepEqual(here.sent, [], 'the shared cooldown refused it before it was sent');
    assert.equal(refused.data.rate_limit.state, 'cooling', JSON.stringify(refused.data.rate_limit));
    assert.equal(refused.meta.rate_limit?.state, 'cooling');
  } finally {
    store.close();
  }
});

test('a refused call never carries rate_limit: ok, whatever it was refused for', async () => {
  const store = sharedStore();
  try {
    // The provider refuses the read itself (HTTP 400) and still reports 10% of the limit used: the call failed, and a limit that is fine
    // is no news about a failure, so the answer carries no rate_limit.
    const here = processOn(store, () => json({error: {message: 'Invalid parameter', code: 100}}, 400, usage(10)));
    const refused = await here.call('meta_native_action', {
      action: 'meta_ad_account_id_campaigns_get',
      account_id: '123',
      params: {fields: 'id,name'},
    });
    assertRefused(refused, 'UPSTREAM_ERROR');
    assert.equal(here.sent.length, 1, 'the provider was asked, and answered with usage');
    assert.deepEqual(here.transport.rateLimit({id: 'm', tenantId: owner.tenantId, gateway: meta}, '123'), {
      state: 'ok',
      usage_pct: 10,
    });
    assert.equal(Object.hasOwn(refused.meta, 'rate_limit'), false, JSON.stringify(refused.meta));
    // The same answer that succeeded does carry it.
    const read = processOn(store, () => json({data: []}, 200, usage(10)));
    const fine = await read.call('meta_native_action', {
      action: 'meta_ad_account_id_campaigns_get',
      account_id: '123',
      params: {fields: 'id,name'},
    });
    assert.equal(fine.success, true, JSON.stringify(fine).slice(0, 400));
    assert.deepEqual(fine.meta.rate_limit, {state: 'ok', usage_pct: 10});
  } finally {
    store.close();
  }
});

test('a cooldown that has ended is no longer shown, and the store reads it without changing it', () => {
  const store = sharedStore();
  try {
    assert.equal(store.providerCooldownUntil('a key nothing cooled'), undefined);
    store.providerCooldown('cooled key', 600000);
    const until = store.providerCooldownUntil('cooled key');
    assert.ok(until > Date.now() + 590000 && until <= Date.now() + 600000, 'the end of the cooldown, in milliseconds');
    assert.equal(store.providerCooldownUntil('cooled key'), until, 'a read changes nothing');
    store.db.prepare('INSERT INTO provider_cooldowns VALUES(?,?)').run('ended key', Date.now() - 1);
    assert.equal(store.providerCooldownUntil('ended key'), undefined);
  } finally {
    store.close();
  }
});

test('after a shared cooldown ends the account shows ok again, not cooling', async () => {
  const store = sharedStore();
  try {
    const here = processOn(store, metaAccount);
    assert.equal((await here.check({live: true})).data.rate_limit.state, 'ok');
    const rows = () => store.db.prepare('SELECT key FROM provider_cooldowns').all();
    await processOn(store, throttledMeta).check({live: true});
    assert.ok(rows().length > 0, 'the other process left its cooldown in the store');
    assert.equal((await here.check()).data.rate_limit.state, 'cooling');
    store.db.prepare('UPDATE provider_cooldowns SET until_at=?').run(Date.now() - 1);
    assert.deepEqual((await here.check()).data.rate_limit, {state: 'ok', usage_pct: 10});
  } finally {
    store.close();
  }
});
