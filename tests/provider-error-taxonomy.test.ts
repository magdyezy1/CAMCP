// PRV-01: provider refusals are classified from documented provider codes, not only from the HTTP status. Before this
// change, Meta 190 at HTTP 400 was UPSTREAM_ERROR with a "review settings" step, Meta throttles at HTTP 400 were
// non-retryable with no cooldown, and readiness dropped the provider code and request ID.
import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeTransport} from '../src/transport.js';
import {classifyProviderError, metaRegainAccessMs, providerRequestId} from '../src/provider-error-taxonomy.js';
import {reportSourceError} from '../src/report-errors.js';
import {errorResult, MirrorError} from '../src/errors.js';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {ReportingOverview} from '../src/reporting-overview.js';
import {ReportWorker} from '../src/worker.js';
import {scopeKey} from '../src/security.js';
import type {Actor, CompiledRequest, Connection, Credentials, JsonObject} from '../src/types.js';

const connection = (gateway = 'meta_native_action'): Connection => ({
  id: 'c',
  tenantId: 't',
  gateway,
  accounts: ['123', '456'],
  label: 'synthetic',
  enabled: true,
  scopes: [],
});
const plan = (gateway = 'meta_native_action', extra: Partial<CompiledRequest> = {}): CompiledRequest => ({
  gateway,
  action: 'list',
  method: 'GET',
  path: gateway === 'meta_native_action' ? '/v26.0/act_123/campaigns' : '/v1/accounts/123',
  query: {},
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  accountId: '123',
  evidence: 'TEST',
  warnings: [],
  ...extra,
});
const credentials: Credentials = {accessToken: 'TEST_CREDENTIAL_NOT_REAL'};
/** X Ads signs with OAuth 1.0a; these synthetic values only let the transport build a signature. */
const xCredentials: Credentials = {
  accessToken: 'TEST_CREDENTIAL_NOT_REAL',
  tokenSecret: 'TEST_SECRET_NOT_REAL',
  consumerKey: 'TEST_CONSUMER_NOT_REAL',
  consumerSecret: 'TEST_CONSUMER_SECRET_NOT_REAL',
};
const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});
/** A fake shared coordinator that records the cooldowns and metrics the transport sets. */
function coordinator() {
  const cooldowns: [string, number][] = [],
    metrics: string[] = [];
  return {
    cooldowns,
    metrics,
    store: {
      assertProviderCooldown() {},
      providerPermit() {},
      providerMetric(_tenant: string, _gateway: string, name: string) {
        metrics.push(name);
      },
      providerCooldown(key: string, ms: number) {
        cooldowns.push([key, ms]);
      },
    },
  };
}
async function refusal(gateway: string, response: () => Response, extra: Partial<CompiledRequest> = {}) {
  let calls = 0;
  const shared = coordinator(),
    transport = new NativeTransport(
      (async () => {
        calls++;
        return response();
      }) as typeof fetch,
      async () => {},
    );
  transport.coordination = shared.store as any;
  const error = await transport
    .request(plan(gateway, extra), connection(gateway), gateway === 'x_ads_native_action' ? xCredentials : credentials)
    .then(() => assert.fail('expected a refusal'))
    .catch((e: unknown) => e as MirrorError);
  assert.ok(error instanceof MirrorError, String(error));
  return {error, calls, shared, transport};
}
const tenantKey = (gateway: string) => scopeKey('t', gateway),
  accountKey = (gateway: string, account = '123') => scopeKey(tenantKey(gateway), 'account-rate', 'c', account);
const meta = (error: JsonObject) => ({error: {message: 'Synthetic Meta refusal', type: 'OAuthException', ...error}});

test('Meta token expiry is a reauthorization at HTTP 400 and 401, with the body trace ID when no header carries it', async () => {
  for (const status of [400, 401]) {
    const {error, calls, shared} = await refusal('meta_native_action', () =>
      json(meta({code: 190, error_subcode: 463, fbtrace_id: 'AbC123_trace-1'}), status),
    );
    assert.equal(error.code, 'REAUTHORIZATION_REQUIRED');
    assert.equal(error.details.layer, 'credential');
    assert.equal(error.details.provider_code, 190);
    assert.equal(error.details.provider_subcode, 463);
    assert.equal(error.details.request_id, 'AbC123_trace-1');
    assert.equal(error.retryable, false);
    assert.equal(error.details.retry_after_ms, undefined);
    assert.equal(calls, 1);
    assert.deepEqual(shared.cooldowns, []);
    const out = errorResult(error, 'r', 1);
    assert.match(out.error.next_action, /Reconnect the provider from Connections/);
    assert.match(out.error.remedy.action, /Reconnect the affected provider identity/);
    assert.equal(
      reportSourceError(error, {platform: 'meta', account_id: '123', connection_id: 'c'}).next_action,
      'Reconnect the affected login in Connections, sync its accounts, then retry this report.',
    );
  }
  // A header trace ID wins over the body.
  const {error} = await refusal('meta_native_action', () =>
    json(meta({code: 190, fbtrace_id: 'body-trace'}), 400, {'x-fb-trace-id': 'header-trace'}),
  );
  assert.equal(error.details.request_id, 'header-trace');
});

test('Meta permission codes 10 and 200-299 name the consent layer, never a missing OAuth scope or a reconnect', async () => {
  for (const code of [10, 200, 299]) {
    const {error} = await refusal('meta_native_action', () => json(meta({code}), 403));
    assert.equal(error.code, 'PROVIDER_PERMISSION_MISSING');
    assert.equal(error.details.layer, 'consent');
    assert.equal(error.retryable, false);
    const out = errorResult(error, 'r', 1);
    assert.equal(out.error.category, 'grant');
    assert.match(out.error.next_action, /permission this login has not granted/);
    assert.match(
      reportSourceError(error, {platform: 'meta', account_id: '123', connection_id: 'c'}).next_action as string,
      /Reauthorize the login in Connections and approve the permission/,
    );
  }
  // Code 300 is not in Meta's permission range: it keeps today's code with an unknown layer.
  const {error} = await refusal('meta_native_action', () => json(meta({code: 300}), 400));
  assert.equal(error.code, 'UPSTREAM_ERROR');
  assert.equal(error.details.layer, 'unknown');
});

test('Meta throttles at HTTP 400 are retryable reads with a cooldown on the scope Meta names, never repeated at once', async () => {
  const cases: [JsonObject, Record<string, string>, number, 'account' | 'login'][] = [
    [{code: 17, error_subcode: 2446079, is_transient: true}, {}, 60000, 'account'],
    [{code: 613, error_subcode: 1487742}, {}, 60000, 'account'],
    [{code: 80004}, {}, 60000, 'account'],
    [
      {code: 80004},
      {
        'x-business-use-case-usage': JSON.stringify({
          123: [{type: 'ads_management', call_count: 100, estimated_time_to_regain_access: 12}],
        }),
      },
      720000,
      'account',
    ],
    [{code: 4}, {}, 60000, 'login'],
    [{code: 17}, {}, 60000, 'login'],
  ];
  for (const [body, headers, wait, scope] of cases) {
    const {error, calls, shared, transport} = await refusal('meta_native_action', () => json(meta(body), 400, headers));
    assert.equal(error.code, 'PLATFORM_RATE_LIMIT', JSON.stringify(body));
    assert.equal(error.details.layer, 'rate_limit');
    assert.equal(error.details.cooldown_scope, scope);
    assert.equal(error.retryable, true);
    assert.equal(error.details.retry_after_ms, wait);
    assert.equal(calls, 1, 'A throttle is never retried immediately');
    assert.deepEqual(shared.cooldowns, [
      [scope === 'account' ? accountKey('meta_native_action') : tenantKey('meta_native_action'), wait],
    ]);
    assert.deepEqual(shared.metrics, ['requests', 'rate_limits', 'errors']);
    assert.equal(transport.metrics.rateLimits, 1);
  }
});

test('an account-scoped throttle pauses that account on this login only; a login throttle pauses every account', async () => {
  for (const [code, otherBlocked] of [
    [80004, false],
    [4, true],
  ] as const) {
    let calls = 0;
    const transport = new NativeTransport(
      (async () => {
        calls++;
        return calls === 1 ? json(meta({code}), 400) : json({data: []}, 200);
      }) as typeof fetch,
      async () => {},
    );
    await assert.rejects(
      transport.request(plan(), connection(), credentials),
      (e: any) => e.code === 'PLATFORM_RATE_LIMIT',
    );
    await assert.rejects(
      transport.request(plan(), connection(), credentials),
      (e: any) => e.code === 'PLATFORM_RATE_LIMIT' && e.retryable === true,
    );
    const other = plan('meta_native_action', {accountId: '456', path: '/v26.0/act_456/campaigns'});
    if (otherBlocked)
      await assert.rejects(
        transport.request(other, connection(), credentials),
        (e: any) => e.code === 'PLATFORM_RATE_LIMIT',
      );
    else assert.deepEqual((await transport.request(other, connection(), credentials)).data, {data: []});
    assert.equal(calls, otherBlocked ? 1 : 2, 'The cooldown refuses before any provider request');
  }
});

test('a throttled or transient write is never made retryable or sent twice, and its cooldown still applies', async () => {
  const write = {readOnly: false, method: 'POST', body: {name: 'draft'}} as const;
  for (const body of [
    {code: 17, error_subcode: 2446079, is_transient: true},
    {code: 1, is_transient: true},
  ]) {
    const {error, calls, shared} = await refusal('meta_native_action', () => json(meta(body), 400), write);
    assert.equal(error.retryable, false, JSON.stringify(body));
    assert.equal(calls, 1);
    if (body.code === 17) {
      assert.equal(error.code, 'PLATFORM_RATE_LIMIT');
      assert.equal(shared.cooldowns.length, 1);
    } else assert.equal(error.code, 'UPSTREAM_ERROR');
  }
});

test('Meta is_transient makes a read retryable with bounded backoff; code 2 at HTTP 500 keeps its server-error retries', async () => {
  for (const [status, body] of [
    [400, {code: 1, is_transient: true}],
    [500, {code: 2, is_transient: true}],
  ] as const) {
    const {error, calls} = await refusal('meta_native_action', () => json(meta(body), status));
    assert.equal(error.code, 'UPSTREAM_ERROR');
    assert.equal(error.details.layer, 'unknown');
    assert.equal(error.retryable, true);
    assert.equal(calls, 3);
  }
});

test('TikTok in-body codes stay PLATFORM_ERROR with an unknown layer until its official code table is verified', async () => {
  for (const code of [40100, 40105]) {
    const {error, calls, shared} = await refusal(
      'tiktok_native_action',
      () => json({code, message: 'Synthetic TikTok refusal', request_id: 'tt'}, 200),
      {path: '/v1.3/campaign/get/'},
    );
    assert.equal(error.code, 'PLATFORM_ERROR');
    assert.equal(error.details.layer, 'unknown');
    assert.equal(error.details.provider_code, code);
    assert.equal(error.retryable, false);
    assert.equal(error.status, 502);
    assert.equal(calls, 1);
    assert.deepEqual(shared.cooldowns, []);
  }
});

test('a Google Ads quota body is a rate limit with the delay Google names; other gateways keep their status codes', async () => {
  const quota = (retryDelay?: string) => ({
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          errors: [
            {
              errorCode: {quotaError: 'RESOURCE_TEMPORARILY_EXHAUSTED'},
              message: 'Too many requests',
              ...(retryDelay ? {details: {quotaErrorDetails: {retryDelay}}} : {}),
            },
          ],
        },
      ],
    },
  });
  const google = {
    path: '/v25/customers/123/googleAds:search',
    method: 'POST',
    body: {query: 'SELECT campaign.id FROM campaign'},
  };
  for (const [delay, expected] of [
    [undefined, 30000],
    ['45s', 45000],
  ] as const) {
    const {error, shared} = await refusal('google_ads_native_action', () => json(quota(delay), 429), google);
    assert.equal(error.code, 'PLATFORM_RATE_LIMIT');
    assert.equal(error.details.layer, 'rate_limit');
    assert.equal(error.details.provider_code, 'RESOURCE_TEMPORARILY_EXHAUSTED');
    assert.equal(error.details.retry_after_ms, expected);
    assert.ok(shared.cooldowns.every(([key]) => key === tenantKey('google_ads_native_action')));
    assert.equal(Math.max(...shared.cooldowns.map(([, ms]) => ms)), expected);
  }
  for (const gateway of ['linkedin_native_action', 'snapchat_native_action']) {
    const {error, shared} = await refusal(gateway, () => json({message: 'Too many requests'}, 429));
    assert.equal(error.code, 'PLATFORM_RATE_LIMIT');
    assert.equal(error.details.layer, 'rate_limit');
    assert.equal(error.details.retry_after_ms, 30000);
    assert.deepEqual(shared.cooldowns, [[tenantKey(gateway), 30000]]);
  }
});

test('LinkedIn and X 401s are credential failures; a LinkedIn 403 stays an unestablished access denial; 426 is a version refusal', async () => {
  for (const gateway of ['linkedin_native_action', 'x_ads_native_action']) {
    const {error} = await refusal(gateway, () => json({message: 'Unauthorized'}, 401), {
      path: gateway === 'x_ads_native_action' ? '/12/accounts/abc' : '/rest/adAccounts/123',
    });
    assert.equal(error.code, 'AUTH_EXPIRED');
    assert.equal(error.details.layer, 'credential');
  }
  const denied = await refusal(
    'linkedin_native_action',
    () => json({status: 403, code: 'ACCESS_DENIED', serviceErrorCode: 100, message: 'Not enough permissions'}, 403),
    {path: '/rest/adAccounts/123'},
  );
  assert.equal(denied.error.code, 'PROVIDER_ACCESS_DENIED');
  assert.equal(denied.error.details.layer, 'unknown');
  assert.equal(denied.error.details.provider_code, 'ACCESS_DENIED');
  assert.equal(denied.error.details.scope_denial, false);
  const version = await refusal(
    'linkedin_native_action',
    () => json({status: 426, code: 'NONEXISTENT_VERSION', message: 'Requested version 202401 is not active'}, 426),
    {path: '/rest/adAccounts/123'},
  );
  assert.equal(version.error.code, 'PROVIDER_VERSION_UNSUPPORTED');
  assert.equal(version.error.details.layer, 'api_version');
  assert.equal(version.error.retryable, false);
  assert.equal(errorResult(version.error, 'r', 1).error.remedy.owner, 'deployment_operator');
});

test('X reset headers keep their account cooldown and the classifier adds only the layer', async () => {
  const reset = String(Math.floor(Date.now() / 1000) + 120);
  const {error, shared} = await refusal(
    'x_ads_native_action',
    () =>
      json({errors: [{code: 'TOO_MANY_REQUESTS', message: 'Rate limit'}]}, 429, {'x-account-rate-limit-reset': reset}),
    {path: '/12/accounts/abc'},
  );
  assert.equal(error.code, 'PLATFORM_RATE_LIMIT');
  assert.equal(error.details.layer, 'rate_limit');
  assert.equal(error.details.provider_code, 'TOO_MANY_REQUESTS');
  assert.equal(shared.cooldowns.length, 1);
  assert.ok(shared.cooldowns[0]![1] > 100000);
});

test('provider codes and request IDs are closed-set tokens; free text and token-shaped secrets never become a code', () => {
  const headers = (h: Record<string, string>) => new Headers(h);
  assert.equal(
    providerRequestId('linkedin_native_action', headers({'x-li-uuid': 'AAYz9-uuid_1', 'x-li-request-id': 'other'}), {}),
    'AAYz9-uuid_1',
  );
  assert.equal(providerRequestId('linkedin_native_action', headers({'x-li-request-id': 'legacy.id'}), {}), 'legacy.id');
  for (const bad of ['has spaces', 'x'.repeat(129), '<script>', ''])
    assert.equal(providerRequestId('linkedin_native_action', headers({'x-li-uuid': bad}), {}), undefined);
  assert.equal(
    providerRequestId('meta_native_action', headers({}), {error: {fbtrace_id: 'trace with space'}}),
    undefined,
  );
  const free = classifyProviderError({
    gateway: 'linkedin_native_action',
    status: 403,
    headers: headers({}),
    body: {code: 'access_token=EAAB secret text', message: 'free text'},
    readOnly: true,
  });
  assert.equal(free.providerCode, undefined);
  assert.equal(free.code, 'PROVIDER_ACCESS_DENIED');
  assert.equal(
    metaRegainAccessMs('{"1":[{"estimated_time_to_regain_access":3}],"2":[{"estimated_time_to_regain_access":5}]}'),
    300000,
  );
  for (const bad of [
    null,
    'not json',
    '{"1":"x"}',
    '{"1":[{"estimated_time_to_regain_access":-1}]}',
    'x'.repeat(17000),
  ])
    assert.equal(metaRegainAccessMs(bad), undefined);
});

test('the classifier switch restores the HTTP-status codes exactly', async () => {
  process.env.AMCP_PROVIDER_ERROR_TAXONOMY = 'off';
  try {
    const {error, shared} = await refusal('meta_native_action', () => json(meta({code: 190, error_subcode: 463}), 400));
    assert.equal(error.code, 'UPSTREAM_ERROR');
    assert.equal(error.details.layer, undefined);
    assert.equal(error.retryable, false);
    const throttle = await refusal('meta_native_action', () => json(meta({code: 80004}), 400));
    assert.equal(throttle.error.code, 'UPSTREAM_ERROR');
    assert.deepEqual(throttle.shared.cooldowns, []);
    assert.deepEqual(shared.cooldowns, []);
  } finally {
    delete process.env.AMCP_PROVIDER_ERROR_TAXONOMY;
  }
});

test('upstream bodies stay redacted under the new fields', async () => {
  const {error} = await refusal('meta_native_action', () =>
    json(
      meta({
        code: 190,
        access_token: 'EAAB' + 'x'.repeat(80),
        message: 'Retry with ?access_token=EAAB' + 'y'.repeat(80),
        fbtrace_id: 'not a trace reference',
      }),
      400,
    ),
  );
  assert.doesNotMatch(JSON.stringify(error.details), /EAAB[xy]{60}/);
  assert.equal(typeof error.details.provider_code, 'number');
  // The new fields are closed-set: a layer, a numeric code and no oversized trace reference.
  assert.equal(error.details.layer, 'credential');
  assert.equal(error.details.request_id, null);
});

function readinessFixture(response: () => Response) {
  const store = new Store(':memory:', Buffer.alloc(32, 61).toString('base64')),
    actor: Actor = {tenantId: 'readiness', userId: 'owner', role: 'admin'};
  store.ensureTenant(actor.tenantId);
  store.putConnection(
    actor,
    {
      id: 'meta-login',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['123'],
      enabled: true,
      label: 'Meta',
      scopes: ['ads_read'],
    },
    {accessToken: 'synthetic'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport((async () => response()) as typeof fetch, async () => {}),
  );
  return {store, actor, service};
}

test('readiness keeps the provider code, request ID and layer, and gives the next step of that layer', async () => {
  for (const [code, headers, next, layer] of [
    [190, {'x-fb-trace-id': 'trace-190'}, /Reconnect the affected login/, 'credential'],
    [200, {'x-fb-trace-id': 'trace-200'}, /approve the permission the provider names/, 'consent'],
  ] as const) {
    const body = meta(code === 190 ? {code, error_subcode: 463} : {code});
    const f = readinessFixture(() => json(body, 400, headers));
    try {
      const out = await f.service.call(
        'amcp_workspace',
        {action: 'check', connection_id: 'meta-login', account_id: '123', live: true},
        f.actor,
      );
      assert.equal(out.success, true, JSON.stringify(out));
      const check = out.data.checks.find((c: JsonObject) => c.key === 'provider_read');
      assert.equal(check.status, 'blocked');
      assert.match(check.next_step, next);
      assert.doesNotMatch(check.next_step, /Reconnect or resolve the provider account permission/);
      assert.equal(check.diagnostic.layer, layer);
      assert.equal(check.diagnostic.provider.code, String(code));
      assert.equal(check.diagnostic.provider.request_id, headers['x-fb-trace-id']);
      assert.doesNotMatch(JSON.stringify(check), /synthetic/);
    } finally {
      f.store.close();
    }
  }
});

test('an Overview run defers a throttled Meta source to the provider cooldown instead of failing it', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 62).toString('base64')),
    actor: Actor = {tenantId: 'overview-throttle', userId: 'owner', role: 'admin'};
  try {
    store.ensureTenant(actor.tenantId);
    store.putConnection(
      actor,
      {
        id: 'meta-connection',
        tenantId: actor.tenantId,
        gateway: 'meta_native_action',
        accounts: ['100'],
        enabled: true,
        label: 'Meta',
        scopes: ['ads_read'],
      },
      {accessToken: 'synthetic'},
    );
    const read: typeof fetch = async url => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/insights'))
        return json(meta({code: 80000, error_subcode: 2446079, is_transient: true, fbtrace_id: 'trace-buc'}), 400, {
          'x-business-use-case-usage': JSON.stringify({
            100: [{type: 'ads_insights', estimated_time_to_regain_access: 2}],
          }),
        });
      return json({id: 'act_100', currency: 'USD', timezone_name: 'America/New_York'}, 200);
    };
    const service = new MirrorService(new Registry(), store, new NativeTransport(read, async () => {})),
      overview = new ReportingOverview(service, read),
      worker = new ReportWorker(
        store,
        async () => ({}),
        (t, k, i) => overview.work(t, k, i),
      );
    const run = await overview.handle(
      {
        action: 'run',
        config: {
          name: 'Throttled',
          sources: [{platform: 'meta', connection_id: 'meta-connection', account_id: '100', objective: 'sales'}],
          date_range: {since: '2026-08-01', until: '2026-08-07'},
          metrics: ['spend'],
        },
        confirmed: true,
      },
      actor,
    );
    const before = Date.now();
    assert.equal(await worker.once(), true);
    const job = store.db.prepare("SELECT * FROM jobs WHERE kind='report_overview'").get() as JsonObject;
    assert.equal(job.state, 'queued', 'A throttled source defers the run instead of failing it');
    assert.equal(JSON.parse(job.error).code, 'PLATFORM_RATE_LIMIT');
    assert.ok(job.available_at >= before + 110000, 'The retry waits for Meta’s estimated regain time');
    const r = store.document(actor.tenantId, 'overview_report', run.id);
    const source = r.sources?.[0]?.error ?? JSON.parse(job.error).details.source;
    assert.equal(source.layer, 'rate_limit');
    assert.equal(source.provider.request_id, 'trace-buc');
    assert.match(source.next_action, /AMCP will wait for the provider cooldown/);
  } finally {
    store.close();
  }
});
