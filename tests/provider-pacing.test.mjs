// Package r25-m2-refusal, item 3 (MT3, L3-01 stage a; owner decision Q20, 2026-11-15; Round 2.5 M2 acceptance 5): pacing before
// dispatch. A throttle after dispatch stays uncertain and non-retryable (PRV-01, src/provider-error-taxonomy.ts: "a refusal of a
// write is never made retryable here"), so the only safe use of what Meta's usage headers say is before anything is sent: a
// request for a login or an account the provider has already said is blocked is refused with PLATFORM_RATE_LIMIT and the wait,
// and nothing leaves AMCP, so no write is claimed and none is uncertain (WRT-04, owner decision D12).
//
// It starts in observe mode, as the shared provider quota does (src/provider-quota.ts, AMCP_PROVIDER_QUOTA_MODE): AMCP_PROVIDER_PACING_MODE
// unset or observe only counts the requests that were sent into a throttle the headers had announced (`pacing_would_refuse`);
// enforce opens the cooldown such a header calls for, and the next request refuses. A refusal after dispatch is the same in both.
// The headers are Meta's documented shapes, and every value is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const meta = 'meta_native_action';
const connection = {
  id: 'm',
  tenantId: 'pacing',
  gateway: meta,
  accounts: ['123', '456'],
  writeAccounts: ['123', '456'],
  enabled: true,
  label: 'Synthetic Meta',
  scopes: ['ads_management'],
};
const credentials = {accessToken: 'TEST_CREDENTIAL_NOT_REAL'};
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});
const read = (path = '/v26.0/act_123/campaigns', accountId = '123') => ({
  gateway: meta,
  action: 'list',
  method: 'GET',
  path,
  query: {},
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  accountId,
  evidence: 'TEST',
  warnings: [],
});
/** Meta's documented headers: a business use case of one ad account, and the app's usage. */
const blocked = (minutes = 12, account = '123') => ({
  'x-business-use-case-usage': JSON.stringify({
    [account]: [
      {
        type: 'ads_management',
        call_count: 100,
        total_cputime: 30,
        total_time: 30,
        estimated_time_to_regain_access: minutes,
        ads_api_access_tier: 'standard_access',
      },
    ],
  }),
});
// Meta throttles a bucket when a percentage passes 100 (S3-1 of the lead's review): at 100 it has not yet.
const appOverLimit = {'x-app-usage': JSON.stringify({call_count: 101, total_time: 20, total_cputime: 20})};
const calm = {'x-app-usage': JSON.stringify({call_count: 10, total_time: 5, total_cputime: 5})};

/** A transport with a request budget no test of this size can exhaust, so that only the governor is under test. */
function transportOver(answer, store) {
  const calls = [];
  const transport = new NativeTransport(
    async (raw, init = {}) => {
      calls.push((init.method ?? 'GET') + ' ' + new URL(String(raw)).pathname);
      return answer(calls.length);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    1000000,
    1,
    1000,
  );
  if (store) transport.coordination = store;
  return {transport, calls};
}
const mode = async (value, run) => {
  const before = process.env.AMCP_PROVIDER_PACING_MODE;
  if (value === undefined) delete process.env.AMCP_PROVIDER_PACING_MODE;
  else process.env.AMCP_PROVIDER_PACING_MODE = value;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.AMCP_PROVIDER_PACING_MODE;
    else process.env.AMCP_PROVIDER_PACING_MODE = before;
  }
};
const attempt = (transport, plan) =>
  transport.request(plan, connection, credentials).then(
    () => undefined,
    error => error,
  );

test('the mode is observe unless AMCP_PROVIDER_PACING_MODE is exactly enforce: a mistyped value never enforces', async () => {
  const {pacingMode} = await import('../dist/src/provider-usage.js');
  assert.equal(pacingMode({}), 'observe');
  assert.equal(pacingMode({AMCP_PROVIDER_PACING_MODE: 'observe'}), 'observe');
  assert.equal(pacingMode({AMCP_PROVIDER_PACING_MODE: 'enforce'}), 'enforce');
  for (const value of ['Enforce', 'enforced', 'on', 'true', '1', '', ' enforce'])
    assert.equal(pacingMode({AMCP_PROVIDER_PACING_MODE: value}), 'observe', JSON.stringify(value));
});

test('observe mode (the default) sends the request and counts it: it was sent into a throttle Meta’s headers had announced', async () => {
  await mode(undefined, async () => {
    const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64'));
    try {
      const {transport, calls} = transportOver(n => json({data: []}, 200, n === 1 ? blocked(12) : calm), store);
      assert.equal(await attempt(transport, read()), undefined);
      assert.equal(transport.rateLimit(connection, '123').state, 'cooling', 'the header announced a block');
      // The second request is sent all the same, and counted.
      assert.equal(await attempt(transport, read()), undefined);
      assert.equal(calls.length, 2, 'observe mode refuses nothing');
      assert.equal(transport.metrics.pacingWouldRefuse, 1);
      assert.equal(transport.metrics.pacingEnforced, 0);
      const [counters] = store.documents(connection.tenantId, 'provider_metrics').filter(d => d.id === meta);
      assert.equal(counters.pacing_would_refuse, 1, 'the owner’s health view reads it');
      assert.equal(counters.pacing_enforced, undefined);
      // A request for an account the block does not name is not counted: the business use case was account 123's.
      assert.equal(await attempt(transport, read('/v26.0/act_456/campaigns', '456')), undefined);
      assert.equal(transport.metrics.pacingWouldRefuse, 1);
    } finally {
      store.close();
    }
  });
});

test('enforce mode refuses the next request before it is sent, with PLATFORM_RATE_LIMIT and the wait Meta named', async () => {
  await mode('enforce', async () => {
    const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64'));
    try {
      const {transport, calls} = transportOver(n => json({data: []}, 200, n === 1 ? blocked(12) : calm), store);
      assert.equal(await attempt(transport, read()), undefined);
      assert.equal(transport.metrics.pacingEnforced, 1);
      const refused = await attempt(transport, read());
      assertRefused(refused, 'PLATFORM_RATE_LIMIT', {status: 429});
      assert.equal(refused.retryable, true, 'nothing was sent, so a retry after the wait is safe');
      assert.ok(refused.details.retry_after_ms > 11.9 * 60000 && refused.details.retry_after_ms <= 12 * 60000);
      assert.equal(calls.length, 1, 'the refused request never reached the provider');
      // The same refusal for a write, which is never sent.
      const write = {...read('/v26.0/act_123/campaigns'), method: 'POST', readOnly: false, body: {name: 'x'}};
      assertRefused(await attempt(transport, write), 'PLATFORM_RATE_LIMIT');
      assert.equal(calls.length, 1);
      // Another account of the login is not blocked: the business use case was account 123's.
      assert.equal(await attempt(transport, read('/v26.0/act_456/campaigns', '456')), undefined);
      assert.equal(calls.length, 2);
      assert.equal(transport.rateLimit(connection, '123').state, 'cooling');
      assert.equal(transport.rateLimit(connection, '456').state, 'ok');
      const [counters] = store.documents(connection.tenantId, 'provider_metrics').filter(d => d.id === meta);
      assert.equal(counters.pacing_enforced, 1);
      assert.equal(counters.pacing_would_refuse, undefined);
    } finally {
      store.close();
    }
  });
});

test('a bucket the login shares (the app’s) blocks every account of the login, and one that is not over its limit blocks none', async () => {
  await mode('enforce', async () => {
    const {transport, calls} = transportOver(n => json({data: []}, 200, n === 1 ? appOverLimit : calm));
    assert.equal(await attempt(transport, read()), undefined);
    assertRefused(await attempt(transport, read()), 'PLATFORM_RATE_LIMIT');
    assertRefused(await attempt(transport, read('/v26.0/act_456/campaigns', '456')), 'PLATFORM_RATE_LIMIT');
    assert.equal(calls.length, 1);
    // Without a named wait the block is the minute the throttle path assumes.
    const view = transport.rateLimit(connection, '456');
    assert.ok(Date.parse(view.until) - Date.now() > 59000);
    // A bucket that has not passed its limit, however full, is never refused.
    const busy = transportOver(() =>
      json({data: []}, 200, {'x-app-usage': JSON.stringify({call_count: 99.9, total_time: 99, total_cputime: 99})}),
    );
    for (let i = 0; i < 5; i++) assert.equal(await attempt(busy.transport, read()), undefined);
    assert.equal(busy.calls.length, 5);
  });
});

test('the block ends when the wait Meta named is over, and requests are sent again', async () => {
  await mode('enforce', async () => {
    // An ad account over its limit names seconds: one second here.
    const header = {'x-ad-account-usage': JSON.stringify({acc_id_util_pct: 101, reset_time_duration: 1})};
    const {transport, calls} = transportOver(n => json({data: []}, 200, n === 1 ? header : calm));
    assert.equal(await attempt(transport, read()), undefined);
    assertRefused(await attempt(transport, read()), 'PLATFORM_RATE_LIMIT');
    assert.equal(calls.length, 1);
    await new Promise(resolve => setTimeout(resolve, 1150));
    assert.equal(await attempt(transport, read()), undefined);
    assert.equal(calls.length, 2);
    assert.equal(transport.rateLimit(connection, '123').state, 'ok');
  });
});

test('a response that answers a refusal carries usage too, and the throttle path is as it was: the same cooldown, the same wait', async () => {
  await mode('enforce', async () => {
    const throttle = json(
      {error: {code: 17, error_subcode: 2446079, message: 'User request limit reached', type: 'OAuthException'}},
      400,
      blocked(12),
    );
    const {transport, calls} = transportOver(() => throttle.clone());
    const refused = await attempt(transport, read());
    assertRefused(refused, 'PLATFORM_RATE_LIMIT');
    assert.equal(refused.details.retry_after_ms, 720000);
    assert.equal(refused.details.cooldown_scope, 'account');
    assert.equal(transport.metrics.rateLimits, 1);
    // The next request is refused by the cooldown, as before, and the governor shows the same block.
    assertRefused(await attempt(transport, read()), 'PLATFORM_RATE_LIMIT');
    assert.equal(calls.length, 1);
    assert.equal(transport.rateLimit(connection, '123').state, 'cooling');
  });
});

/**
 * A Meta advertiser behind the real review lifecycle: the account read, and a paused campaign create. `headersFor(method, nth)`
 * adds response headers to the nth request of that method; `answerPost` replaces the answer to the create.
 */
function metaWrites({headersFor = () => ({}), answerPost} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 78).toString('base64')),
    owner = {tenantId: connection.tenantId, userId: 'owner', role: 'admin'},
    counts = {GET: 0, POST: 0},
    log = [];
  store.putConnection(owner, connection, credentials);
  const transport = new NativeTransport(
    async (raw, init = {}) => {
      const method = init.method ?? 'GET',
        path = new URL(String(raw)).pathname,
        headers = headersFor(method, ++counts[method]);
      log.push(method + ' ' + path);
      if (method === 'GET' && path === '/v26.0/act_123')
        return json(
          {
            id: 'act_123',
            account_id: '123',
            currency: 'USD',
            account_status: 1,
            tos_accepted: {custom_audience_tos: 1},
          },
          200,
          headers,
        );
      if (method === 'POST' && path === '/v26.0/act_123/campaigns')
        return answerPost?.(headers) ?? json({id: '111'}, 200, headers);
      throw Error('Unexpected synthetic request: ' + method + ' ' + path);
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
  const call = input => service.call('amcp_write', input, owner);
  return {
    store,
    transport,
    log,
    writes: () => counts.POST,
    prepare: () =>
      call({
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
    execute: id => call({action: 'execute', review_id: id, idempotency_key: id, confirmed: true}),
    claim: id =>
      store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get(connection.tenantId, id)?.state,
    audit: () =>
      store.db
        .prepare('SELECT event FROM audit WHERE tenant_id=?')
        .all(connection.tenantId)
        .map(r => JSON.parse(r.event).event),
  };
}

test('enforce mode: a write whose state read announced a block is refused before it is sent; nothing is claimed, and the same review executes when the block is over', async () => {
  await mode('enforce', async () => {
    // The advertiser is read at prepare (1) and again at execute (2); the second answer carries the block.
    const f = metaWrites({headersFor: (method, nth) => (method === 'GET' && nth === 2 ? blocked(12) : {})});
    try {
      const prepared = await f.prepare();
      assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 600));
      const id = prepared.data.review_id,
        refused = await f.execute(id);
      assertRefused(refused, 'PLATFORM_RATE_LIMIT');
      assert.equal(refused.error.details.submission, 'not_sent', 'refused before dispatch: nothing left AMCP');
      assert.ok(refused.error.details.retry_after_ms > 11.9 * 60000);
      assert.equal(f.writes(), 0);
      assert.equal(f.claim(id), undefined, 'the idempotency claim is released');
      assert.ok(f.audit().includes('write_not_sent'));
      assert.equal(f.audit().includes('write_uncertain'), false);
      // The cooldown is shared with the other processes of the deployment, which refuse the same way until it ends.
      assertRefused(await f.execute(id), 'PLATFORM_RATE_LIMIT');
      f.transport.cooldowns.clear();
      assertRefused(await f.execute(id), 'PLATFORM_RATE_LIMIT');
      assert.equal(f.writes(), 0);
      // The block is over: the same review is executed, not prepared again.
      f.store.db.exec('DELETE FROM provider_cooldowns');
      const done = await f.execute(id);
      assert.equal(done.success, true, JSON.stringify(done).slice(0, 600));
      assert.equal(f.writes(), 1);
      assert.equal(f.claim(id), 'complete');
    } finally {
      f.store.close();
    }
  });
});

test('observe mode: the same write is sent, and counted as one that would have been refused', async () => {
  await mode(undefined, async () => {
    const f = metaWrites({headersFor: (method, nth) => (method === 'GET' && nth === 2 ? blocked(12) : {})});
    try {
      const id = (await f.prepare()).data.review_id,
        done = await f.execute(id);
      assert.equal(done.success, true, JSON.stringify(done).slice(0, 600));
      assert.equal(f.writes(), 1, 'observe mode never changes what is sent');
      assert.equal(f.claim(id), 'complete');
      assert.equal(f.transport.metrics.pacingWouldRefuse, 1, 'the create was sent while the block was announced');
    } finally {
      f.store.close();
    }
  });
});

test('after dispatch nothing changes, in either mode: a throttle on the write itself leaves the review uncertain and non-retryable (Q20, PRV-01)', async () => {
  for (const value of [undefined, 'enforce']) {
    await mode(value, async () => {
      const f = metaWrites({
        answerPost: () =>
          json(
            {error: {code: 17, error_subcode: 2446079, is_transient: true, message: 'Limit', type: 'OAuthException'}},
            400,
            blocked(12),
          ),
      });
      try {
        const id = (await f.prepare()).data.review_id,
          refused = await f.execute(id);
        assertRefused(refused, 'PLATFORM_RATE_LIMIT');
        assert.equal(refused.error.retryable, false, 'a write throttled after it was sent is never made retryable');
        assert.notEqual(refused.error.details.submission, 'not_sent');
        assert.equal(f.writes(), 1);
        assert.equal(f.claim(id), 'uncertain');
        assertRefused(await f.execute(id), 'WRITE_OUTCOME_UNCERTAIN');
        assert.equal(f.writes(), 1, 'never sent again');
        assert.ok(f.audit().includes('write_uncertain'));
      } finally {
        f.store.close();
      }
    });
  }
});

test('a block announced by a write that succeeded leaves that write complete, and refuses only what comes after it', async () => {
  await mode('enforce', async () => {
    const f = metaWrites({answerPost: headers => json({id: '111'}, 200, {...headers, ...blocked(12)})});
    try {
      const id = (await f.prepare()).data.review_id,
        done = await f.execute(id);
      assert.equal(done.success, true, JSON.stringify(done).slice(0, 600));
      assert.equal(f.claim(id), 'complete');
      assert.equal(f.transport.rateLimit(connection, '123').state, 'cooling');
      // The next prepare reads the account first, and is refused before it is sent.
      const again = await f.prepare();
      assertRefused(again, 'PLATFORM_RATE_LIMIT');
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  });
});

/** One business use case of account 123 at `percent`, naming `minutes` to regain access (0 names none). */
const bucket = (type, percent, minutes = 0) => ({
  'x-business-use-case-usage': JSON.stringify({
    123: [{type, call_count: percent, total_cputime: 5, total_time: 5, estimated_time_to_regain_access: minutes}],
  }),
});
const insights = () => read('/v26.0/act_123/insights');
const write = () => ({...read('/v26.0/act_123/campaigns'), method: 'POST', readOnly: false, body: {name: 'x'}});

test('a business use case blocks only the requests it counts (S3-1): an insights block refuses insights reads and sends every other request of the account', async () => {
  await mode('enforce', async () => {
    const {transport, calls} = transportOver(n => json({data: []}, 200, n === 1 ? bucket('ads_insights', 100, 5) : {}));
    assert.equal(await attempt(transport, insights()), undefined);
    // The next insights read is refused, with the five minutes Meta named...
    const refused = await attempt(transport, insights());
    assertRefused(refused, 'PLATFORM_RATE_LIMIT');
    assert.ok(refused.details.retry_after_ms > 4.9 * 60000 && refused.details.retry_after_ms <= 5 * 60000);
    assert.equal(calls.length, 1);
    // ...and a request of the account's other bucket, a read or a write, is sent: its own bucket is at 3 percent.
    assert.equal(await attempt(transport, read()), undefined);
    assert.equal(await attempt(transport, write()), undefined);
    assert.equal(calls.length, 3);
    // The account still shows a throttle, which is one bucket's.
    assert.equal(transport.rateLimit(connection, '123').state, 'cooling');
  });
  // The other way round: a management block refuses management requests and sends an insights read.
  await mode('enforce', async () => {
    const {transport, calls} = transportOver(n =>
      json({data: []}, 200, n === 1 ? bucket('ads_management', 100, 9) : {}),
    );
    assert.equal(await attempt(transport, read()), undefined);
    assertRefused(await attempt(transport, read()), 'PLATFORM_RATE_LIMIT');
    assertRefused(await attempt(transport, write()), 'PLATFORM_RATE_LIMIT');
    assert.equal(await attempt(transport, insights()), undefined);
    assert.equal(calls.length, 2);
  });
});

test('observe mode counts only the requests of the blocked bucket as would-refuse, so the number an owner reads before enforcing is not inflated', async () => {
  await mode(undefined, async () => {
    const {transport, calls} = transportOver(n => json({data: []}, 200, n === 1 ? bucket('ads_insights', 100, 5) : {}));
    assert.equal(await attempt(transport, insights()), undefined);
    assert.equal(await attempt(transport, read()), undefined);
    assert.equal(await attempt(transport, write()), undefined);
    assert.equal(transport.metrics.pacingWouldRefuse, 0, 'requests of another bucket were not sent into this throttle');
    assert.equal(await attempt(transport, insights()), undefined);
    assert.equal(transport.metrics.pacingWouldRefuse, 1, 'an insights read was');
    assert.equal(calls.length, 4, 'observe mode refuses nothing');
  });
});

test('a business use case that names no wait is not blocked, even at 100 or beyond: only a wait Meta names is a block', async () => {
  for (const value of ['enforce', undefined])
    await mode(value, async () => {
      for (const percent of [100, 130]) {
        const {transport, calls} = transportOver(() => json({data: []}, 200, bucket('ads_management', percent, 0)));
        for (let i = 0; i < 3; i++) assert.equal(await attempt(transport, read()), undefined);
        assert.equal(calls.length, 3, String(value) + ' ' + percent);
        assert.equal(transport.metrics.pacingWouldRefuse, 0);
        assert.deepEqual(transport.rateLimit(connection, '123'), {state: 'ok', usage_pct: percent});
      }
    });
});

test('the app’s and the ad account’s usage block only above 100: at the limit Meta has not throttled yet, and one step above it has', async () => {
  await mode('enforce', async () => {
    for (const [header, over] of [
      [{'x-app-usage': JSON.stringify({call_count: 100, total_time: 20, total_cputime: 20})}, false],
      [{'x-app-usage': JSON.stringify({call_count: 100.5, total_time: 20, total_cputime: 20})}, true],
      [{'x-ad-account-usage': JSON.stringify({acc_id_util_pct: 100, reset_time_duration: 45})}, false],
      [{'x-ad-account-usage': JSON.stringify({acc_id_util_pct: 100.5, reset_time_duration: 45})}, true],
    ]) {
      const {transport, calls} = transportOver(n => json({data: []}, 200, n === 1 ? header : calm));
      assert.equal(await attempt(transport, read()), undefined);
      const next = await attempt(transport, read());
      if (over) assertRefused(next, 'PLATFORM_RATE_LIMIT');
      else assert.equal(next, undefined, JSON.stringify(header));
      assert.equal(calls.length, over ? 1 : 2, JSON.stringify(header));
    }
  });
});

test('a business use case no request is counted in is shown and never paces: a custom audience block refuses nothing in either mode', async () => {
  for (const value of ['enforce', undefined])
    await mode(value, async () => {
      const {transport, calls} = transportOver(n =>
        json({data: []}, 200, n === 1 ? bucket('custom_audience', 100, 30) : {}),
      );
      assert.equal(await attempt(transport, read()), undefined);
      assert.equal(await attempt(transport, read()), undefined);
      assert.equal(await attempt(transport, insights()), undefined);
      assert.equal(await attempt(transport, write()), undefined);
      assert.equal(calls.length, 4, String(value));
      assert.equal(transport.metrics.pacingWouldRefuse, 0);
      assert.equal(transport.metrics.pacingEnforced, 0, 'nothing was opened');
      // What Meta said is not hidden: the account shows a throttle, for the thirty minutes it named.
      const view = transport.rateLimit(connection, '123');
      assert.equal(view.state, 'cooling');
      assert.ok(Date.parse(view.until) - Date.now() > 29 * 60000);
    });
});

test('a bucket’s block is shared through the store with the same bucket alone: another process refuses an insights read and sends a management read', async () => {
  await mode('enforce', async () => {
    const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64'));
    try {
      const first = transportOver(() => json({data: []}, 200, bucket('ads_insights', 100, 5)), store);
      assert.equal(await attempt(first.transport, insights()), undefined);
      const second = transportOver(() => json({data: []}), store);
      assert.equal(second.transport.rateLimit(connection, '123').state, 'cooling', 'the view reads the shared row');
      assertRefused(await attempt(second.transport, insights()), 'PLATFORM_RATE_LIMIT');
      assert.equal(await attempt(second.transport, read()), undefined);
      assert.equal(second.calls.length, 1, 'only the management read was sent');
    } finally {
      store.close();
    }
  });
});

test('a misspelt AMCP_PROVIDER_PACING_MODE stops startup before anything opens, as a misspelt quota mode or wire-contract mode does (S4-7)', async () => {
  const {assertPacingMode} = await import('../dist/src/provider-usage.js');
  for (const ok of [undefined, '', 'observe', 'enforce']) assertPacingMode({AMCP_PROVIDER_PACING_MODE: ok});
  for (const bad of ['Enforce', 'enforced', 'on', 'true', '1', ' enforce', 'OBSERVE'])
    assert.throws(() => assertPacingMode({AMCP_PROVIDER_PACING_MODE: bad}), /observe or enforce/, JSON.stringify(bad));
  // The composition root runs it: createRuntime refuses before the database opens (a valid value would open one, so none is tried).
  const {createRuntime} = await import('../dist/server/runtime.js');
  const {loadConfig} = await import('../dist/server/config.js');
  for (const bad of ['Enforce', 'enforced'])
    await mode(bad, async () =>
      assert.throws(
        () => createRuntime(loadConfig({}, 'stdio'), {log: () => {}}),
        /AMCP_PROVIDER_PACING_MODE must be observe or enforce/,
        bad,
      ),
    );
});

test('a call that sent many requests keeps one touch per login and account, so a later account is never dropped (S4-8)', async () => {
  const {collectUsageTouches, noteUsageTouch} = await import('../dist/src/provider-usage.js');
  const touch = account => ({tenantId: 't', gateway: meta, connectionId: 'm', accountId: account});
  const {touched} = await collectUsageTouches(async () => {
    for (let i = 0; i < 300; i++) noteUsageTouch(touch('123'));
    noteUsageTouch(touch('456'));
    // A nested call hands what it touched up, and a repeat of an account already named is not a second touch.
    await collectUsageTouches(async () => {
      for (let i = 0; i < 300; i++) noteUsageTouch(touch('123'));
      noteUsageTouch(touch('789'));
    });
  });
  assert.deepEqual(
    touched.map(t => t.accountId),
    ['123', '456', '789'],
  );
});
