import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script, createContext} from 'node:vm';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {ReportingOverview} from '../src/reporting-overview.js';
import {ReportWorker} from '../src/worker.js';
import {MirrorError} from '../src/errors.js';
import {reportSourceError, activityReportErrors} from '../src/report-errors.js';
import type {Actor, JsonObject} from '../src/types.js';
import {createHttpApp} from '../server/http-app.js';

const actor: Actor = {tenantId: 'report-diagnostics', userId: 'owner', role: 'admin'},
  key = Buffer.alloc(32, 39).toString('base64');
const source = {platform: 'google', connection_id: 'google-connection', account_id: '1234567890'};
const config = {
  name: 'Synthetic Google report',
  sources: [source],
  date_range: {since: '2026-08-01', until: '2026-08-07'},
  metrics: ['spend', 'clicks'],
  custom_metrics: [],
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json', 'request-id': 'synthetic-provider-trace'},
  });
const googleFailure = (reason = 'USER_PERMISSION_DENIED') => ({
  error: {
    code: 403,
    message: 'The caller does not have permission',
    status: 'PERMISSION_DENIED',
    details: [
      {
        '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure',
        requestId: 'body-trace',
        errors: [
          {
            errorCode: {authorizationError: reason},
            message: 'User does not have permission to access this customer.',
            trigger: {stringValue: 'private-trigger'},
            access_token: 'private-access-token',
          },
        ],
      },
    ],
  },
  refresh_token: 'private-refresh-token',
});
function fixture(reply: (body: JsonObject, call: number) => Response) {
  const store = new Store(':memory:', key),
    requests: JsonObject[] = [];
  store.putConnection(
    actor,
    {
      id: source.connection_id,
      tenantId: actor.tenantId,
      gateway: 'google_ads_native_action',
      accounts: [source.account_id],
      enabled: true,
      label: 'Synthetic Google connection',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    {accessToken: 'synthetic-access-token', developerToken: 'synthetic-developer-token', loginCustomerId: '9999999999'},
  );
  const transport = new NativeTransport(
    async (url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push({url: String(url), body, headers: init?.headers});
      return reply(body, requests.length);
    },
    async () => {},
  );
  const service = new MirrorService(new Registry(), store, transport),
    overview = new ReportingOverview(service),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (t, k, i) => overview.work(t, k, i),
    );
  return {store, service, overview, worker, requests};
}
test('Google 403 preserves provider reason, request stage and routing without retrying denied access or exposing credentials', async () => {
  const f = fixture(() => json(googleFailure(), 403));
  try {
    const run = await f.overview.handle({action: 'run', config, confirmed: true}, actor);
    await f.worker.once();
    const r = await f.overview.handle({action: 'get', id: run.id}, actor),
      error = r.sources[0].error;
    assert.equal(f.requests.length, 1);
    assert.match(f.requests[0]!.body.query, /FROM customer/);
    assert.equal(r.state, 'failed');
    assert.equal(r.job.state, 'failed');
    assert.deepEqual(r.rows, []);
    assert.equal(error.provider.code, 'USER_PERMISSION_DENIED');
    assert.equal(error.http_status, 403);
    assert.equal(error.request.stage, 'account_lookup');
    assert.equal(error.request.path, '/v25/customers/1234567890/googleAds:search');
    assert.equal(error.provider.request_id, 'synthetic-provider-trace');
    assert.equal(error.login_customer_id, '9999999999');
    assert.match(error.next_action, /direct access/);
    assert.match(r.job.error.message, /Google Ads 1234567890: USER_PERMISSION_DENIED/);
    for (const secret of [
      'private-trigger',
      'private-access-token',
      'private-refresh-token',
      'synthetic-access-token',
      'synthetic-developer-token',
    ])
      assert.ok(!JSON.stringify(r).includes(secret), secret);
    await assert.rejects(() =>
      f.overview.handle({action: 'get', id: run.id}, {...actor, tenantId: 'another-workspace'}),
    );
    f.store.db.prepare('DELETE FROM connections WHERE id=?').run(source.connection_id);
    await assert.rejects(() => f.overview.handle({action: 'get', id: run.id}, actor));
  } finally {
    f.store.close();
  }
});
test('a metrics-request rejection is identified separately from a successful Google account lookup', async () => {
  const f = fixture(body =>
    body.query.includes('FROM customer')
      ? json({results: [{customer: {id: source.account_id, currencyCode: 'USD', timeZone: 'UTC'}}]})
      : json(googleFailure('METRIC_ACCESS_DENIED'), 403),
  );
  try {
    const run = await f.overview.handle({action: 'run', config, confirmed: true}, actor);
    await f.worker.once();
    const r = await f.overview.handle({action: 'get', id: run.id}, actor);
    assert.equal(f.requests.length, 2);
    assert.equal(r.sources[0].error.provider.code, 'METRIC_ACCESS_DENIED');
    assert.equal(r.sources[0].error.request.stage, 'campaign_report');
  } finally {
    f.store.close();
  }
});
test('Google reporting retains exact account, manager routing, query dates and rows across pages', async () => {
  const f = fixture(body =>
    body.query.includes('FROM customer')
      ? json({results: [{customer: {id: source.account_id, currencyCode: 'USD', timeZone: 'UTC'}}]})
      : json({
          results: [
            {
              campaign: {
                id: body.pageToken ? '20' : '10',
                name: 'Synthetic campaign',
                advertisingChannelType: 'SEARCH',
              },
              customer: {currencyCode: 'USD'},
              metrics: {costMicros: '2000000', clicks: '5', impressions: '50', conversions: '1', conversionsValue: '3'},
            },
          ],
          ...(!body.pageToken ? {nextPageToken: 'second-page'} : {}),
        }),
  );
  try {
    const run = await f.overview.handle({action: 'run', config, confirmed: true}, actor);
    await f.worker.once();
    const r = await f.overview.handle({action: 'get', id: run.id}, actor);
    assert.equal(r.state, 'complete');
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[0].metrics.spend, 2);
    assert.equal(r.sources[0].currency, 'USD');
    assert.equal(f.requests.length, 3);
    assert.equal(f.requests[2]!.body.pageToken, 'second-page');
    for (const request of f.requests) {
      assert.equal(new URL(request.url).pathname, '/v25/customers/1234567890/googleAds:search');
      assert.equal(request.headers['login-customer-id'], '9999999999');
    }
    assert.match(f.requests[1]!.body.query, /segments.date BETWEEN '2026-08-01' AND '2026-08-07'/);
  } finally {
    f.store.close();
  }
});
test('empty successful Google data is a complete empty report, while temporary failures retain source diagnostics for retry', async () => {
  const empty = fixture(body =>
    json(body.query.includes('FROM customer') ? {results: [{customer: {currencyCode: 'USD', timeZone: 'UTC'}}]} : {}),
  );
  try {
    const run = await empty.overview.handle({action: 'run', config, confirmed: true}, actor);
    await empty.worker.once();
    const r = await empty.overview.handle({action: 'get', id: run.id}, actor);
    assert.equal(r.state, 'complete');
    assert.equal(r.rows.length, 0);
    assert.equal(r.sources[0].complete, true);
    assert.equal(r.job.error, null);
  } finally {
    empty.store.close();
  }
  const retry = fixture(() =>
    json({error: {code: 503, status: 'UNAVAILABLE', message: 'Temporarily unavailable'}}, 503),
  );
  try {
    const run = await retry.overview.handle({action: 'run', config, confirmed: true}, actor);
    await retry.worker.once();
    const r = await retry.overview.handle({action: 'get', id: run.id}, actor);
    assert.equal(r.job.state, 'queued');
    assert.equal(r.sources[0].error.retryable, true);
    assert.equal(r.sources[0].error.provider.code, 'UNAVAILABLE');
    assert.equal(r.job.error.details.source.account_id, source.account_id);
    assert.ok(r.job.available_at > Date.now());
  } finally {
    retry.store.close();
  }
});
test('provider diagnostics distinguish Google app restrictions and safely project Meta, TikTok and LinkedIn messages', () => {
  const restriction = reportSourceError(
    new MirrorError(
      'INSUFFICIENT_SCOPE',
      'Platform returned HTTP 403',
      {upstream: googleFailure('DEVELOPER_TOKEN_NOT_APPROVED')},
      403,
    ),
    source,
  );
  assert.match(restriction.next_action, /developer token/);
  assert.match(restriction.next_action, /alone will not fix/);
  for (const [platform, upstream, expected] of [
    [
      'meta',
      {
        error: {
          code: 100,
          error_user_msg: 'Invalid metric access_token=private-token',
          fbtrace_id: 'meta-trace',
          secret: 'private',
        },
      },
      '100',
    ],
    [
      'tiktok',
      {code: 40002, message: 'Unsupported metric', request_id: 'tiktok-trace', access_token: 'private'},
      '40002',
    ],
    ['linkedin', {serviceErrorCode: 100, message: 'Invalid analytics field', access_token: 'private'}, '100'],
  ] as const) {
    const diagnostic = reportSourceError(
      new MirrorError('PLATFORM_ERROR', 'Provider rejected the request', {upstream, http_status: 200}, 502),
      {...source, platform},
    );
    assert.equal(diagnostic.provider.code, expected);
    // The provider answered HTTP 200 and reported the failure in its body: there is no HTTP failure to label (F-L1-05).
    assert.equal('http_status' in diagnostic, false);
    assert.ok(!JSON.stringify(diagnostic).includes('private'));
  }
});
test('Activity exposes diagnostic fields for historical Google failures while preserving session protection', async () => {
  const f = fixture(() => json(googleFailure(), 403)),
    origin = 'https://amcp.shop';
  const app = createHttpApp(f.service, f.store, {
      publicOrigin: origin,
      website: {
        origin,
        masterKey: key,
        adminPassword: 'synthetic-smoke-password',
        tenantId: actor.tenantId,
        authEnv: {},
      },
    }),
    listener = await listenForFetch(app);
  const base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  try {
    f.store.appendAudit(actor.tenantId, 'historical-read', {
      event: 'request_failed',
      request: {
        gateway: 'google_ads_native_action',
        action: 'AMCP_READINESS',
        method: 'POST',
        path: '/v25/customers/1234567890/googleAds:search',
        accountId: source.account_id,
      },
      error: {code: 'INSUFFICIENT_SCOPE', message: 'Platform returned HTTP 403', details: {upstream: googleFailure()}},
    });
    assert.equal((await fetch(base + '/api/activity')).status, 401);
    const login = await fetch(base + '/api/session', {
      method: 'POST',
      headers: {Origin: origin, 'Content-Type': 'application/json'},
      body: JSON.stringify({password: 'synthetic-smoke-password'}),
    });
    await login.text();
    const result = (await (
      await fetch(base + '/api/activity', {headers: {Cookie: login.headers.get('set-cookie')!.split(';')[0]!}})
    ).json()) as JsonObject;
    const diagnostic = result.events.find((e: JsonObject) => e.event.event === 'request_failed').diagnostics[0];
    assert.equal(diagnostic.provider.code, 'USER_PERMISSION_DENIED');
    assert.equal(diagnostic.http_status, 403);
    assert.equal(diagnostic.request.stage, 'account_lookup');
    assert.ok(!JSON.stringify(diagnostic).includes('private'));
    assert.deepEqual(activityReportErrors({event: 'sign_in'}), []);
    assert.equal(f.requests.length, 0);
  } finally {
    await new Promise<void>(resolve => {
      listener.close(() => resolve());
      listener.closeAllConnections();
    });
    f.store.close();
  }
});
test('failed source panels open by default, explain the provider error, and escape untrusted error text', () => {
  const esc = (value: unknown) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  const context = createContext({esc, document: {addEventListener() {}}});
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/report-quality.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/report-workflows.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/reporting-overview.js', 'utf8')).runInContext(context);
  // WEB-07: provider diagnostics are a shell helper (web/workspace.js) since the report builder's script left the shell.
  const workspace = readFileSync('web/workspace.js', 'utf8');
  new Script(
    workspace.slice(
      workspace.indexOf('const overviewCall = async input => {'),
      workspace.indexOf('const capabilityFeatureLabels'),
    ),
  ).runInContext(context);
  context.input = {
    source,
    complete: false,
    error: {
      code: 'INSUFFICIENT_SCOPE',
      message: 'Forbidden',
      http_status: 403,
      provider: {code: 'USER_PERMISSION_DENIED', message: '<img src=x onerror=alert(1)>'},
      next_action: 'Reconnect the correct Google identity',
    },
  };
  const html = new Script('renderReportSourceHealth(input,[{id:"google",name:"Google Ads"}],0)').runInContext(
    context,
  ) as string;
  assert.match(html, /attention" open/);
  assert.match(html, /USER_PERMISSION_DENIED/);
  assert.match(html, /Reconnect the correct Google identity/);
  assert.match(html, /Copy error details/);
  assert.match(html, /&lt;img/);
  assert.ok(!html.includes('<img'));
});
