import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeTransport, providerRetryDelay} from '../src/transport.js';
import {xCampaignReport} from '../src/x-campaign-report.js';
import {Store} from '../src/store.js';
import {MirrorError} from '../src/errors.js';
import type {CompiledRequest, Connection} from '../src/types.js';
const connection: Connection = {
  id: 'x-login',
  tenantId: 'tenant',
  gateway: 'x_ads_native_action',
  accounts: ['one', 'two'],
  enabled: true,
  label: 'Fixture',
  scopes: [],
};
const credentials = {
  consumerKey: 'synthetic',
  consumerSecret: 'synthetic',
  accessToken: 'synthetic',
  tokenSecret: 'synthetic',
};
const plan: CompiledRequest = {
  gateway: connection.gateway,
  accountId: 'one',
  action: 'AMCP_CAMPAIGN_REPORT',
  path: '/12/stats/accounts/one',
  method: 'GET',
  query: {},
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  warnings: [],
  evidence: 'SYNTHETIC',
};
test('terminal provider input and access errors never poison the circuit or mask the original X error', async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    let calls = 0;
    const transport = new NativeTransport(
      async () => {
        calls++;
        return Response.json({errors: [{code: 'INVALID_PARAMETER', message: 'Native cause'}]}, {status});
      },
      async () => {},
    );
    for (let i = 0; i < 7; i++)
      await assert.rejects(
        () => transport.request(plan, connection, credentials),
        (e: any) => e.status === status && e.code !== 'CIRCUIT_OPEN',
      );
    assert.equal(calls, 7);
  }
});
test('X analytics accepts native null metric columns and uses current documented placements', async () => {
  const placements: string[] = [];
  const r = await xCampaignReport([{id: 'one'}], 0, 86400000, [], async q => {
    placements.push(q.placement);
    return {
      data: [
        {
          id: 'one',
          id_data: [
            {
              segment: null,
              metrics: {
                impressions: Array(24).fill(2),
                clicks: null,
                billed_charge_local_micro: Array(24).fill(1000000),
              },
            },
          ],
        },
      ],
    };
  });
  assert.deepEqual(placements, ['ALL_ON_TWITTER', 'SPOTLIGHT', 'TREND']);
  assert.equal(r.rows[0]!.metrics.clicks, 0);
  assert.equal(r.rows[0]!.metrics.spend, 72);
});

test('genuine transient circuits isolate accounts, logins and tenants and allow only one recovery probe', async t => {
  let now = 1000,
    calls = 0,
    status = 503,
    release!: () => void,
    started!: () => void;
  t.mock.method(performance, 'now', () => now);
  let gate: Promise<void> | undefined;
  const transport = new NativeTransport(
    async () => {
      calls++;
      if (gate) {
        started();
        await gate;
      }
      return Response.json({data: []}, {status});
    },
    async () => {},
  );
  for (let i = 0; i < 5; i++)
    await assert.rejects(() => transport.request(plan, connection, credentials), {code: 'UPSTREAM_ERROR'});
  assert.equal(calls, 15);
  await assert.rejects(
    () => transport.request(plan, connection, credentials),
    (e: any) => e.code === 'CIRCUIT_OPEN' && e.details.last_http_status === 503,
  );
  assert.equal(calls, 15);
  status = 200;
  await transport.request({...plan, accountId: 'two'}, connection, credentials);
  await transport.request(plan, {...connection, id: 'other-login'}, credentials);
  await transport.request(plan, {...connection, tenantId: 'other-tenant'}, credentials);
  now += 30001;
  const arrived = new Promise<void>(r => (started = r));
  gate = new Promise<void>(r => (release = r));
  const probe = transport.request(plan, connection, credentials);
  await arrived;
  await assert.rejects(() => transport.request(plan, connection, credentials), {code: 'CIRCUIT_OPEN'});
  release();
  await probe;
  gate = undefined;
  await transport.request(plan, connection, credentials);
  assert.equal(calls, 20);
});

test('a provider throttle neither counts toward nor resets the transient-failure circuit', async t => {
  let now = 1000,
    calls = 0,
    status = 503;
  t.mock.method(performance, 'now', () => now);
  const transport = new NativeTransport(
    async () => {
      calls++;
      return Response.json({data: []}, {status});
    },
    async () => {},
  );
  for (let i = 0; i < 4; i++)
    await assert.rejects(() => transport.request(plan, connection, credentials), {code: 'UPSTREAM_ERROR'});
  // A throttle between transient failures used to delete the circuit entry and its four counted failures.
  status = 429;
  let wait = 0;
  await assert.rejects(
    () => transport.request(plan, connection, credentials),
    (e: any) => e.code === 'PLATFORM_RATE_LIMIT' && (wait = Number(e.details.retry_after_ms ?? 0)) >= 0,
  );
  now += wait + 1;
  status = 503;
  await assert.rejects(() => transport.request(plan, connection, credentials), {code: 'UPSTREAM_ERROR'});
  const sent = calls;
  await assert.rejects(() => transport.request(plan, connection, credentials), {code: 'CIRCUIT_OPEN'});
  assert.equal(calls, sent, 'the fifth transient failure opened the circuit');
  now += 30001;
  status = 200;
  await transport.request(plan, connection, credentials);
});

test('an interrupted half-open probe releases its claim when shared pacing rejects a retry', async t => {
  let now = 1000,
    status = 503;
  t.mock.method(performance, 'now', () => now);
  const transport = new NativeTransport(
    async () => Response.json({data: []}, {status}),
    async () => {},
  );
  for (let i = 0; i < 5; i++) await assert.rejects(() => transport.request(plan, connection, credentials));
  now += 30001;
  const store = new Store(':memory:');
  try {
    let permits = 0;
    t.mock.method(store, 'providerPermit', () => {
      if (++permits === 2)
        throw new MirrorError('TENANT_RATE_LIMIT', 'Synthetic pacing', {retry_after_ms: 200}, 429, true);
    });
    transport.coordination = store;
    await assert.rejects(() => transport.request(plan, connection, credentials), {code: 'TENANT_RATE_LIMIT'});
    status = 200;
    await transport.request(plan, connection, credentials);
  } finally {
    store.close();
  }
});

test('X reset time is honored without early inline retries and survives a transport restart', async t => {
  const at = Date.parse('2026-09-24T10:00:00Z');
  let now = at,
    calls = 0;
  t.mock.method(Date, 'now', () => now);
  const response = () =>
    Response.json(
      {errors: [{code: 88, message: 'Rate limit'}]},
      {status: 429, headers: {date: new Date(at).toUTCString(), 'x-rate-limit-reset': String(at / 1000 + 900)}},
    );
  assert.equal(providerRetryDelay(response(), connection.gateway, at + 120000), 900000);
  assert.equal(
    providerRetryDelay(
      Response.json(
        {},
        {status: 429, headers: {'retry-after': '60', 'x-account-rate-limit-reset': String(at / 1000 + 120)}},
      ),
      connection.gateway,
      at,
    ),
    120000,
  );
  const store = new Store(':memory:');
  try {
    const first = new NativeTransport(
      async () => {
        calls++;
        return response();
      },
      async () => {
        throw Error('Must queue until reset');
      },
    );
    first.coordination = store;
    await assert.rejects(
      () => first.request(plan, connection, credentials),
      (e: any) => e.code === 'PLATFORM_RATE_LIMIT' && e.details.retry_after_ms === 900000,
    );
    assert.equal(calls, 1);
    const second = new NativeTransport(async () => {
      calls++;
      return Response.json({data: []});
    });
    second.coordination = store;
    await assert.rejects(
      () => second.request({...plan, accountId: 'two', path: '/12/stats/accounts/two'}, connection, credentials),
      {code: 'PLATFORM_RATE_LIMIT'},
    );
    assert.equal(calls, 1);
    await second.request(plan, {...connection, tenantId: 'independent-tenant'}, credentials);
    assert.equal(calls, 2);
    now += 900001;
    await second.request(plan, connection, credentials);
    assert.equal(calls, 3);
  } finally {
    store.close();
  }
});

test('account-specific X cooldown does not stop a different account and 503 Retry-After delays reads', async () => {
  let calls = 0;
  const transport = new NativeTransport(async () => {
    calls++;
    return calls === 1
      ? Response.json(
          {},
          {status: 429, headers: {'x-account-rate-limit-reset': String(Math.ceil(Date.now() / 1000) + 60)}},
        )
      : Response.json({data: []});
  });
  await assert.rejects(() => transport.request(plan, connection, credentials), {code: 'PLATFORM_RATE_LIMIT'});
  await transport.request({...plan, accountId: 'two'}, connection, credentials);
  assert.equal(calls, 2);
  let retries = 0;
  const maintenance = new NativeTransport(
    async () => {
      retries++;
      return Response.json({}, {status: 503, headers: {'retry-after': '120'}});
    },
    async () => {
      throw Error('No early retry');
    },
  );
  await assert.rejects(
    () => maintenance.request(plan, connection, credentials),
    (e: any) => e.code === 'UPSTREAM_ERROR' && e.details.retry_after_ms === 120000,
  );
  assert.equal(retries, 1);
});

test('X HTTP 200 error envelopes are unsuccessful and resumable analytics never double-count completed batches', async () => {
  const transport = new NativeTransport(async () =>
    Response.json({errors: [{code: 'BAD_ARGUMENT', message: 'Synthetic input error'}]}),
  );
  await assert.rejects(() => transport.request(plan, connection, credentials), {code: 'PLATFORM_ERROR'});
  let checkpoint: any = {},
    calls = 0;
  const success = () => ({
    data: [
      {
        id: 'one',
        id_data: [
          {segment: null, metrics: {clicks: Array(24).fill(1), billed_charge_local_micro: Array(24).fill(1000000)}},
        ],
      },
    ],
  });
  await assert.rejects(
    () =>
      xCampaignReport(
        [{id: 'one'}],
        0,
        86400000,
        [],
        async () => {
          if (++calls === 2)
            throw new MirrorError('PLATFORM_RATE_LIMIT', 'Reset required', {retry_after_ms: 900000}, 429, true);
          return success();
        },
        {save: v => (checkpoint = structuredClone(v))},
      ),
    {code: 'PLATFORM_RATE_LIMIT'},
  );
  assert.equal(checkpoint.next, 1);
  const placements: string[] = [];
  const report = await xCampaignReport(
    [{id: 'one'}],
    0,
    86400000,
    [],
    async q => {
      placements.push(q.placement);
      return success();
    },
    {checkpoint, save: v => (checkpoint = structuredClone(v))},
  );
  assert.deepEqual(placements, ['SPOTLIGHT', 'TREND']);
  assert.equal(report.rows[0]!.metrics.spend, 72);
  assert.equal(report.rows[0]!.metrics.impressions, null);
  await assert.rejects(() => xCampaignReport([{id: 'one'}], 0, 2 * 86400000, [], async () => success(), {checkpoint}), {
    code: 'REPORT_DEFINITION_CHANGED',
  });
});
