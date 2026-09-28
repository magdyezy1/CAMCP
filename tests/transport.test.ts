import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeTransport, oauth1, buildUrl} from '../src/transport.js';
import type {CompiledRequest, Connection, Credentials} from '../src/types.js';
import {setTimeout as delay} from 'node:timers/promises';
const connection: Connection = {
  id: 'c',
  tenantId: 't',
  gateway: 'meta_native_action',
  accounts: ['123'],
  label: 'test',
  enabled: true,
  scopes: [],
};
const plan: CompiledRequest = {
  gateway: 'meta_native_action',
  action: 'list',
  method: 'GET',
  path: '/v26.0/act_123/campaigns',
  query: {limit: 1},
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  accountId: '123',
  evidence: 'TEST',
  warnings: [],
};
const credentials: Credentials = {accessToken: 'TEST_CREDENTIAL_NOT_REAL'};
test('read retries are bounded and do not change request meaning', async () => {
  let calls = 0;
  const requests: any[] = [];
  const transport = new NativeTransport(
    (async (url, options) => {
      calls++;
      requests.push({url: String(url), options});
      return new Response(JSON.stringify(calls < 3 ? {error: 'temporary'} : {data: []}), {
        status: calls < 3 ? 503 : 200,
        headers: {'Content-Type': 'application/json'},
      });
    }) as typeof fetch,
    async () => {},
  );
  const result = await transport.request(plan, connection, credentials);
  assert.equal(calls, 3);
  assert.deepEqual(result.data, {data: []});
  assert.equal(requests[0].url, requests[2].url);
  assert.equal(transport.metrics.retries, 2);
});
test('writes never retry an uncertain upstream request', async () => {
  let calls = 0;
  const transport = new NativeTransport(
    (async () => {
      calls++;
      throw new Error('network failure');
    }) as typeof fetch,
    async () => {},
  );
  await assert.rejects(
    transport.request({...plan, readOnly: false, method: 'POST', body: {name: 'draft'}}, connection, credentials),
    (e: any) => e.code === 'WRITE_OUTCOME_UNCERTAIN',
  );
  assert.equal(calls, 1);
});
test('platform errors inside HTTP 200 are not successful responses', async () => {
  const transport = new NativeTransport(
    (async () => new Response('{"code":40001,"message":"bad"}', {status: 200})) as typeof fetch,
  );
  await assert.rejects(
    transport.request(
      {...plan, gateway: 'tiktok_native_action', path: '/v1.3/campaign/get/'},
      {...connection, gateway: 'tiktok_native_action'},
      credentials,
    ),
    (e: any) => e.code === 'PLATFORM_ERROR',
  );
});

test('invalid JSON never hides HTTP failures and no-content reads cannot become successful data', async () => {
  for (const [status, body, code] of [
    [401, '<html>expired</html>', 'AUTH_EXPIRED'],
    [403, '', 'PROVIDER_ACCESS_DENIED'],
    [204, null, 'UPSTREAM_RESPONSE_INVALID'],
  ] as const) {
    const transport = new NativeTransport((async () => new Response(body, {status})) as typeof fetch, async () => {});
    await assert.rejects(transport.request(plan, connection, credentials), (error: any) => error.code === code);
  }
  const transport = new NativeTransport((async () => new Response(null, {status: 204})) as typeof fetch);
  assert.equal((await transport.request({...plan, method: 'HEAD'}, connection, credentials)).data, null);
  assert.equal(
    (await transport.request({...plan, method: 'DELETE', readOnly: false}, connection, credentials)).data,
    null,
  );
});
test('OAuth 1.0a signs form and URL parameters using the published reference vector', () => {
  const signature = oauth1(
    'GET',
    new URL('http://photos.example.net/photos?file=vacation.jpg&size=original'),
    {
      consumerKey: 'dpf43f3p2l4k3l03',
      consumerSecret: 'kd94hf93k423kf44',
      accessToken: 'nnch734d00sl2jdk',
      tokenSecret: 'pfkkdhi9sl3r4s00',
    },
    undefined,
    'kllo9940pd9333jh',
    '1191242096',
  );
  assert.ok(signature.includes('oauth_signature="tR3%2BTy81lMeYAr%2FFid0kMTYa%2FWM%3D"'));
});
test('transport pins platform origins and rejects redirects', async () => {
  assert.throws(() => buildUrl(plan, {...connection, baseUrl: 'https://attacker.example'}), /not allowed/);
  assert.throws(() => buildUrl({...plan, path: '//attacker.example/steal'}, connection), /authority|escaped/);
  let redirect: string | undefined;
  const transport = new NativeTransport((async (_url, options) => {
    redirect = options?.redirect;
    return new Response('{}');
  }) as typeof fetch);
  await transport.request(plan, connection, credentials);
  assert.equal(redirect, 'error');
});
test('Meta writes use observed form encoding and TikTok adds open_api prefix', async () => {
  const sent: any[] = [];
  const transport = new NativeTransport((async (url, options) => {
    sent.push({url: String(url), ...options});
    return new Response('{}');
  }) as typeof fetch);
  await transport.request(
    {...plan, method: 'POST', readOnly: false, body: {name: 'draft', targeting: {geo_locations: {countries: ['US']}}}},
    connection,
    credentials,
  );
  assert.equal(sent[0].headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(new URLSearchParams(sent[0].body).get('name'), 'draft');
  await transport.request(
    {...plan, gateway: 'tiktok_native_action', path: '/v1.3/campaign/get/'},
    {...connection, gateway: 'tiktok_native_action'},
    credentials,
  );
  assert.ok(sent[1].url.startsWith('https://business-api.tiktok.com/open_api/v1.3/'));
  assert.equal(sent[1].headers['Access-Token'], credentials.accessToken);
});
test('a bounded burst is paced to the sustained tenant rate, and only a sustained overrun is rejected', async () => {
  const waits: number[] = [],
    sleeper = async (ms: number) => {
      waits.push(ms);
      await delay(ms);
    };
  // Burst 5, one refill every 10ms, shaping window 100ms: the same policy as production at test speed.
  const transport = new NativeTransport(
    (async () => new Response('{}')) as typeof fetch,
    sleeper,
    30000,
    8 * 1024 * 1024,
    5,
    10,
    100,
  );
  // A bounded sequential batch past the burst is paced, not failed: this is what account discovery does.
  for (let i = 0; i < 20; i++) await transport.request(plan, connection, credentials);
  assert.equal(transport.metrics.requests, 20);
  assert.ok(waits.length > 0);
  assert.ok(waits.every(ms => ms > 0 && ms <= 100));
  // A caller that never yields owes more than the shaping window and is still rate limited.
  const burst = new NativeTransport(
    (async () => new Response('{}')) as typeof fetch,
    sleeper,
    30000,
    8 * 1024 * 1024,
    5,
    10,
    100,
  );
  const outcomes = await Promise.allSettled(
    Array.from({length: 80}, () => burst.request(plan, connection, credentials)),
  );
  const rejected = outcomes.filter(o => o.status === 'rejected') as PromiseRejectedResult[];
  assert.ok(rejected.length > 0);
  assert.ok(rejected.every(o => o.reason.code === 'TENANT_RATE_LIMIT'));
  assert.ok(rejected[0]!.reason.details.retry_after_ms > 0);
});
test('pacing survives a backward wall-clock correction', async () => {
  // The monotonic clock is driven by the sleeper rather than by real timers. Waiting on setTimeout
  // and measuring with performance.now made this assert that a timer never wakes early, which is
  // load-dependent and fails on a busy machine even though pacing is correct.
  const waits: number[] = [];
  let monotonic = 1000;
  const sleeper = async (ms: number) => {
    waits.push(ms);
    monotonic += ms;
  };
  const transport = new NativeTransport(
    (async () => new Response('{}')) as typeof fetch,
    sleeper,
    30000,
    8 * 1024 * 1024,
    5,
    10,
    100,
  );
  // NTP steps the wall clock backwards on a freshly booted host. Refill reads a monotonic clock,
  // so the bucket must keep filling and no wait may exceed one refill interval.
  const realDate = Date.now,
    realNow = performance.now;
  let calls = 0,
    offset = 0;
  Date.now = () => {
    if (++calls === 9) offset = -5000;
    return realDate() + offset;
  };
  performance.now = () => monotonic;
  try {
    for (let i = 0; i < 20; i++) await transport.request(plan, connection, credentials);
  } finally {
    Date.now = realDate;
    performance.now = realNow;
  }
  assert.equal(transport.metrics.requests, 20);
  // Five burst tokens are free; every later request owes exactly one refill interval.
  assert.equal(waits.length, 15);
  assert.ok(waits.every(ms => ms > 0 && ms <= 10));
});
