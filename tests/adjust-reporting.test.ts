import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {Actor, Connection, JsonObject} from '../src/types.js';
import {actionContracts} from '../src/action-contracts.js';
import {mkdtempSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {removeTestDirectory} from './temp.js';
import {readGuidance} from '../src/guidance.js';
import {effectiveProviderContract} from '../src/provider-contracts.js';

const registry = new Registry(),
  owner = {tenantId: 'adjust-reporting', userId: 'owner', role: 'admin' as const},
  key = Buffer.alloc(32, 73).toString('base64'),
  app = 'abcdefghijkl',
  id = '336ecb51-2df8-4967-8bd3-cba64d552296';
const reportRequest = {
  dimensions: ['app_token', 'day'],
  metrics: ['installs', 'network_cost'],
  date_period: '2026-09-01:2026-09-02',
  app_token__in: app,
  currency: 'USD',
  utc_offset: '+00:00',
};
function fixture(file = ':memory:') {
  const store = new Store(file, key),
    connection: Connection = {
      id,
      tenantId: owner.tenantId,
      gateway: 'adjust_native_action',
      label: 'Synthetic Adjust',
      enabled: true,
      accounts: [app],
      writeAccounts: [],
      scopes: [],
    };
  store.putConnection(owner, connection, {accessToken: 'synthetic-adjust-token'});
  const calls: {url: URL; init: RequestInit | undefined}[] = [];
  let hook: ((url: URL) => Response | Promise<Response>) | undefined;
  const fetcher: typeof fetch = async (u, init) => {
    const url = new URL(String(u));
    calls.push({url, init});
    if (hook) return hook(url);
    if (url.pathname.endsWith('/filters_data'))
      return Response.json(
        url.searchParams.get('required_filters') === 'apps'
          ? {apps: [{id: app, name: 'Synthetic app'}]}
          : {countries: [{id: 'eg', name: 'Egypt'}]},
      );
    if (url.pathname.endsWith('/events'))
      return Response.json([{id: 'purchase', name: 'Purchase', app_token: [app], tokens: ['event12']}]);
    return Response.json({
      rows: [{app_token: app, day: '2026-09-01', installs: '10', network_cost: '10.000001'}],
      totals: {installs: 10, network_cost: 10.000001},
      warnings: [],
      ...(url.pathname.endsWith('/pivot_report') ? {totals_per_dimension: {}} : {}),
    });
  };
  const service = new MirrorService(registry, store, new NativeTransport(fetcher), undefined, {
    allowWrites: false,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  return {
    store,
    connection,
    calls,
    service,
    hook: (h: typeof hook) => (hook = h),
    call: (action: string, payload: JsonObject = {}, actor: Actor = owner) =>
      service.call(
        'adjust_native_action',
        {operation: 'adjust_reporting', arguments: {action, label: id, payload}},
        actor,
      ),
    assets: (arguments_: JsonObject = {}) =>
      service.call('adjust_native_action', {operation: 'adjust_list_assets', arguments: arguments_}, owner),
  };
}
test('Adjust lists configured connection and app bindings without claiming live token visibility', async () => {
  const f = fixture();
  try {
    const r = await f.assets();
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.connections[0].label, id);
    assert.deepEqual(r.data.connections[0].app_tokens, [app]);
    assert.equal(r.data.live_verified, false);
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
for (const [action, payload] of [
  ['LIST_APPS', {}],
  ['LIST_FILTERS', {requiredFilters: ['countries']}],
  ['LIST_EVENTS', {appTokens: [app]}],
  ['GET_REPORT', {request: reportRequest}],
  ['GET_PIVOT', {request: {...reportRequest, index: ['app_token']}}],
] as [string, JsonObject][])
  test('Adjust ' + action + ' performs a scoped native GET', async () => {
    const f = fixture();
    try {
      const r = await f.call(action, payload);
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(r.data.complete, true);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0]!.init?.method, 'GET');
      assert.equal(f.calls[0]!.init?.redirect, 'error');
      assert.equal(f.calls[0]!.url.origin, 'https://automate.adjust.com');
      assert.equal((f.calls[0]!.init?.headers as any).Authorization, 'Bearer synthetic-adjust-token');
      assert.equal(f.calls[0]!.url.search.includes('synthetic-adjust-token'), false);
    } finally {
      f.store.close();
    }
  });

test('configured discovery excludes disabled connections by default and never decrypts secrets', async () => {
  const f = fixture(),
    spy = mock.method(f.store, 'credentials', () => {
      throw Error('No credentials in local discovery');
    });
  try {
    f.store.putConnection(owner, {...f.connection, id: 'disabled', enabled: false}, {accessToken: 'unused'});
    assert.equal((await f.assets()).data.connections.length, 1);
    assert.equal((await f.assets({include_disconnected: true})).data.connections.length, 2);
    assert.equal(spy.mock.callCount(), 0);
    assert.equal(f.calls.length, 0);
  } finally {
    spy.mock.restore();
    f.store.close();
  }
});

test('connection UUID wins over a colliding display label; duplicate display labels remain ambiguous', async () => {
  const f = fixture();
  try {
    f.store.putConnection(owner, {...f.connection, id: 'second', label: id}, {accessToken: 'other'});
    assert.equal((await f.call('GET_REPORT', {request: reportRequest})).success, true);
    f.store.putConnection(owner, {...f.connection, id: 'second', label: f.connection.label}, {accessToken: 'other'});
    const r = await f.service.call(
      'adjust_native_action',
      {operation: 'adjust_reporting', arguments: {action: 'LIST_APPS', label: f.connection.label}},
      owner,
    );
    assert.equal(r.error?.code, 'AMBIGUOUS_CONNECTION');
  } finally {
    f.store.close();
  }
});

test('reports and events require exact app grants while account-wide discovery requires administrator role', async () => {
  const f = fixture();
  try {
    for (const action of ['LIST_APPS', 'LIST_FILTERS'])
      assert.equal(
        (await f.call(action, action === 'LIST_FILTERS' ? {requiredFilters: ['apps']} : {}, {...owner, role: 'reader'}))
          .error?.code,
        'FORBIDDEN',
      );
    assert.equal(
      (await f.call('GET_REPORT', {request: {...reportRequest, app_token__in: 'unauthorized'}})).error?.code,
      'ACCOUNT_SCOPE_MISMATCH',
    );
    assert.equal((await f.call('LIST_EVENTS', {appTokens: ['unauthorized']})).error?.code, 'ACCOUNT_SCOPE_MISMATCH');
    assert.equal(
      (await f.call('GET_REPORT', {request: reportRequest}, {...owner, tenantId: 'another'})).error?.code,
      'CONNECTION_REQUIRED',
    );
    assert.equal(f.calls.length, 0);
    assert.equal((await f.call('GET_REPORT', {request: reportRequest}, {...owner, role: 'reader'})).success, true);
  } finally {
    f.store.close();
  }
});

test('multi-app selection requires explicit grants and returned app identity for every row', async () => {
  const f = fixture();
  try {
    const second = 'mnopqrstuvwx';
    f.store.putConnection(owner, {...f.connection, accounts: [app, second]}, {accessToken: 'synthetic-adjust-token'});
    assert.equal(
      (await f.call('GET_REPORT', {request: {...reportRequest, app_token__in: undefined}})).error?.code,
      'INVALID_ARGUMENT',
    );
    f.hook(() =>
      Response.json({
        rows: [
          {app_token: app, day: '2026-09-01', installs: '1', network_cost: null},
          {app_token: second, day: '2026-09-01', installs: '2', network_cost: '0'},
        ],
        totals: {installs: 3},
        warnings: [],
      }),
    );
    const r = await f.call('GET_REPORT', {request: {...reportRequest, app_token__in: [app, second]}});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.data.rows[0].network_cost, null);
    assert.equal(r.data.data.rows[1].network_cost, '0');
    assert.equal(f.calls[0]!.url.searchParams.get('app_token__in'), app + ',' + second);
  } finally {
    f.store.close();
  }
});

test('effective report requests include app identity and explicit UTC without changing input data', async () => {
  const f = fixture();
  try {
    const request = {...reportRequest, dimensions: ['day'], utc_offset: undefined},
      before = structuredClone(request);
    const r = await f.call('GET_REPORT', {request});
    assert.equal(r.success, true);
    assert.deepEqual(request, before);
    assert.equal(f.calls[0]!.url.searchParams.get('dimensions'), 'app_token,day');
    assert.equal(f.calls[0]!.url.searchParams.get('utc_offset'), '+00:00');
    assert.equal(f.calls[0]!.url.searchParams.get('format_dates'), 'false');
  } finally {
    f.store.close();
  }
});

test('native integer and fractional JSON numbers remain exact decimal text', async () => {
  const f = fixture();
  try {
    f.hook(
      () =>
        new Response(
          '{"rows":[{"app_token":"abcdefghijkl","day":"2026-09-01","installs":9007199254740993,"network_cost":123456789.123456789}],"totals":{"installs":9007199254740993,"network_cost":123456789.123456789},"warnings":[]}',
          {headers: {'content-type': 'application/json'}},
        ),
    );
    const r = await f.call('GET_REPORT', {request: reportRequest});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.data.rows[0].installs, '9007199254740993');
    assert.equal(r.data.data.totals.network_cost, '123456789.123456789');
    assert.equal(r.data.provider_count_verified, false);
  } finally {
    f.store.close();
  }
});

test('documented HTTP 204 is empty native data only on qualified Adjust reads', async () => {
  for (const action of ['LIST_APPS', 'LIST_FILTERS', 'LIST_EVENTS', 'GET_REPORT', 'GET_PIVOT']) {
    const f = fixture();
    try {
      f.hook(() => new Response(null, {status: 204}));
      const payload =
        action === 'LIST_FILTERS'
          ? {requiredFilters: ['countries']}
          : action === 'LIST_EVENTS'
            ? {appTokens: [app]}
            : action.startsWith('GET_')
              ? {request: reportRequest}
              : {};
      const r = await f.call(action, payload);
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(r.data.rows, 0);
      assert.equal(r.data.provider_no_content, true);
      assert.equal(r.data.complete, true);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    const plan = {
      gateway: 'adjust_native_action',
      action: 'UNQUALIFIED',
      path: '/reports-service/report',
      query: {},
      method: 'GET',
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      evidence: 'test',
      warnings: [],
      adjustReportRead: true,
    };
    await assert.rejects(
      new NativeTransport(async () => new Response(null, {status: 204})).request(plan, f.connection, {
        accessToken: 'synthetic',
      }),
      {code: 'UPSTREAM_RESPONSE_INVALID'},
    );
  } finally {
    f.store.close();
  }
});

test('warnings preserve native data while preventing an unqualified completeness claim', async () => {
  const f = fixture();
  try {
    f.hook(() => Response.json({rows: [], totals: {}, warnings: ['Provider source is delayed.'], pagination: null}));
    const r = await f.call('GET_REPORT', {request: reportRequest});
    assert.equal(r.success, true);
    assert.equal(r.data.complete, false);
    assert.deepEqual(r.data.data.warnings, ['Provider source is delayed.']);
  } finally {
    f.store.close();
  }
});

test('incomplete envelopes, unknown pagination, repeated grain and foreign apps fail instead of becoming empty reports', async () => {
  const row = {app_token: app, day: '2026-09-01', installs: '1', network_cost: '1'};
  for (const body of [
    {},
    {rows: [], totals: {}, warnings: [], pagination: {next: 'https://private.invalid/'}},
    {rows: [row, row], totals: {}, warnings: []},
    {rows: [{...row, app_token: 'another'}], totals: {}, warnings: []},
    {rows: [{...row, day: '2026-08-01'}], totals: {}, warnings: []},
    {rows: [{...row, network_cost: undefined}], totals: {}, warnings: []},
  ]) {
    const f = fixture();
    try {
      f.hook(() => Response.json(body));
      assert.equal((await f.call('GET_REPORT', {request: reportRequest})).success, false);
      assert.equal(f.calls.length, 1);
    } finally {
      f.store.close();
    }
  }
});

test('app-indexed native pivot groups retain exact rows and reject foreign totals or unsupported nesting', async () => {
  const f = fixture();
  try {
    const body = {
      rows: [{[app]: {rows: [{day: '2026-09-01', installs: '1', network_cost: '2'}]}}],
      totals: {installs: 1},
      warnings: [],
      totals_per_dimension: {app_token: {[app]: {installs: 1}}},
    };
    f.hook(() => Response.json(body));
    const r = await f.call('GET_PIVOT', {request: reportRequest});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.rows, 1);
    assert.equal(f.calls[0]!.url.searchParams.get('index'), 'app_token');
    f.hook(() => Response.json({...body, totals_per_dimension: {app_token: {unselected: {installs: 2}}}}));
    assert.equal((await f.call('GET_PIVOT', {request: reportRequest})).error?.code, 'ACCOUNT_SCOPE_MISMATCH');
    assert.equal(
      (await f.call('GET_PIVOT', {request: {...reportRequest, index: ['campaign']}})).error?.code,
      'INVALID_ARGUMENT',
    );
  } finally {
    f.store.close();
  }
});

test('catalog section/search remain literal filters and event mappings cannot reveal unselected apps', async () => {
  const f = fixture();
  try {
    f.hook(url =>
      url.pathname.endsWith('/filters_data')
        ? Response.json({
            countries: [
              {id: 'eg', name: 'Egypt', section: 'geo'},
              {id: 'gb', name: 'UK', section: 'other'},
            ],
          })
        : Response.json([{id: 'buy', app_token: [app], app_token_x_event_tokens_mapping: {unselected: ['event']}}]),
    );
    const r = await f.call('LIST_FILTERS', {
      requiredFilters: ['countries'],
      section: 'geo',
      search: 'eg&token=untrusted',
    });
    assert.equal(r.success, true);
    assert.equal(r.data.data.countries.length, 1);
    assert.equal(f.calls[0]!.url.searchParams.get('countries__contains'), 'eg&token=untrusted');
    assert.equal(f.calls[0]!.url.searchParams.has('token'), false);
    assert.equal(
      (await f.call('LIST_EVENTS', {appTokens: [app], tokens_mapping: true})).error?.code,
      'ACCOUNT_SCOPE_MISMATCH',
    );
  } finally {
    f.store.close();
  }
});

test('unrecognized payloads, dates, token overrides and contradictory account filters stop before egress', async () => {
  const f = fixture();
  try {
    for (const change of [
      {access_token: 'private'},
      {headers: {Authorization: 'private'}},
      {url: 'https://private.invalid/'},
      {app_token__not_in: app},
      {date_period: '2026-02-30:2026-03-02'},
      {date_period: '2026-09-02:2026-09-01'},
      {utc_offset: '+25:00'},
      {format_dates: true},
      {metrics: ['installs', 'installs']},
      {currency: 'usd'},
    ])
      assert.equal(
        (await f.call('GET_REPORT', {request: {...reportRequest, ...change}})).error?.code,
        'INVALID_ARGUMENT',
        JSON.stringify(change),
      );
    assert.equal(
      (await f.call('LIST_EVENTS', {appTokens: [app], datePeriod: 'today'})).error?.code,
      'INVALID_ARGUMENT',
    );
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});

test('dynamic periods retain their native expression and unknown currency is not invented', async () => {
  const f = fixture();
  try {
    for (const date_period of ['today', 'last_month', '-10d:-3d']) {
      const r = await f.call('GET_REPORT', {request: {...reportRequest, date_period, currency: undefined}});
      assert.equal(r.success, true);
      assert.equal(r.data.period_is_dynamic, true);
      assert.equal(r.data.requested_currency, null);
      assert.equal(r.data.date_period, date_period);
    }
  } finally {
    f.store.close();
  }
});

test('revoking keys, app grants, the connection or its token during a read withholds provider data', async () => {
  for (const mode of ['key', 'grant', 'disconnect', 'token']) {
    const f = fixture();
    try {
      const token = f.store.createKey(owner),
        actor = f.store.authenticate(token);
      f.hook(() => {
        if (mode === 'key') f.store.revokeKey(token);
        if (mode === 'grant')
          f.store.putConnection(
            owner,
            {...f.connection, accounts: ['different']},
            {accessToken: 'synthetic-adjust-token'},
          );
        if (mode === 'disconnect')
          f.store.db.prepare('DELETE FROM connections WHERE tenant_id=? AND id=?').run(owner.tenantId, id);
        if (mode === 'token') f.store.replaceCredentials(owner.tenantId, id, {accessToken: 'replacement'});
        return Response.json({rows: [], totals: {}, warnings: []});
      });
      const r = await f.call('GET_REPORT', {request: reportRequest}, actor);
      assert.equal(r.success, false);
      assert.equal(f.calls.length, 1);
      assert.equal(
        f.store.audit(owner.tenantId).some((x: any) => JSON.parse(x.event).event === 'adjust_read_completed'),
        false,
      );
    } finally {
      f.store.close();
    }
  }
});

test('provider errors do not disclose token-bearing bodies or infer scope from HTTP 403', async () => {
  const f = fixture();
  try {
    f.hook(() => Response.json({error: 'private token synthetic-adjust-token', detail: 'private'}, {status: 403}));
    const r = await f.call('GET_REPORT', {request: reportRequest});
    assert.equal(r.error?.code, 'PROVIDER_ACCESS_DENIED');
    assert.equal(JSON.stringify(r).includes('synthetic-adjust-token'), false);
    assert.equal(r.error.details.http_status, 403);
  } finally {
    f.store.close();
  }
});

test('UTF-8, byte and elapsed deadline limits never yield partial Adjust success', async () => {
  for (const body of [new Uint8Array([0xff, 0xfe]), 'x'.repeat(8 * 1024 * 1024 + 1)]) {
    const f = fixture();
    try {
      f.hook(() => new Response(body));
      assert.equal((await f.call('GET_REPORT', {request: reportRequest})).success, false);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  let clock: ReturnType<typeof mock.method> | undefined;
  try {
    f.hook(() => {
      const now = performance.now();
      clock = mock.method(performance, 'now', () => now + 70000);
      return Response.json({rows: [], totals: {}, warnings: []});
    });
    assert.equal((await f.call('GET_REPORT', {request: reportRequest})).error?.code, 'ADJUST_REPORT_LIMIT');
  } finally {
    clock?.mock.restore();
    f.store.close();
  }
});

test('report output is marked untrusted and audit omits native rows, event names and totals', async () => {
  const f = fixture();
  try {
    f.hook(() =>
      Response.json({
        rows: [{app_token: app, day: '2026-09-01', installs: '0', network_cost: '0', campaign: 'private-row-value'}],
        totals: {installs: 0},
        warnings: [],
      }),
    );
    const r = await f.call('GET_REPORT', {request: reportRequest});
    assert.equal(r.success, true);
    assert.match(r.meta.untrusted_provider_content, /data/);
    assert.equal(JSON.stringify(f.store.audit(owner.tenantId)).includes('private-row-value'), false);
  } finally {
    f.store.close();
  }
});

test('exactly six Adjust workflows are implemented and no Adjust write obtains a reviewed contract', () => {
  const rows = actionContracts(registry).filter(r => r.gateway === 'adjust_native_action'),
    implemented = rows.filter(r => r.implementation === 'src/adjust-reporting.ts');
  assert.equal(implemented.length, 6);
  assert.ok(implemented.every(r => r.status === 'local_workflow'));
  assert.equal(rows.filter(r => r.status === 'reviewed_write_family').length, 0);
  assert.equal(rows.find(r => r.action === 'SEND_AD_SPEND')!.status, 'unmapped');
});

test('documented dimension exclusions and numeric metric comparisons use distinct operator contracts', async () => {
  const f = fixture();
  try {
    const good = await f.call('GET_REPORT', {
      request: {
        ...reportRequest,
        day__exclude: '2026-08',
        installs__gte: '0',
        attribution_types: 'click,engaged_ad',
        reattributed: 'false',
        sort: '-installs,day',
      },
    });
    assert.equal(good.success, true, JSON.stringify(good));
    assert.equal(f.calls[0]!.url.searchParams.get('day__exclude'), '2026-08');
    for (const change of [
      {day__not_contains: 'x'},
      {day__gte: '10'},
      {installs__contains: '1'},
      {installs__gte: 'anything'},
      {currency: true},
      {utc_offset: true},
      {reattributed: false},
      {attribution_source: 'unknown'},
      {attribution_types: 'click,click'},
      {sort: 'unselected_field'},
    ])
      assert.equal(
        (await f.call('GET_REPORT', {request: {...reportRequest, ...change}})).error?.code,
        'INVALID_ARGUMENT',
        JSON.stringify(change),
      );
    assert.equal(f.calls.length, 1);
  } finally {
    f.store.close();
  }
});

test('unknown metric types fail and incomplete totals and null values remain explicit', async () => {
  const f = fixture();
  try {
    for (const value of ['not a number', true, {}, []]) {
      f.hook(() =>
        Response.json({
          rows: [{app_token: app, day: '2026-09-01', installs: value, network_cost: '0'}],
          totals: {},
          warnings: [],
        }),
      );
      assert.equal((await f.call('GET_REPORT', {request: reportRequest})).error?.code, 'ADJUST_RESPONSE_INVALID');
    }
    f.hook(() =>
      Response.json({
        rows: [{app_token: app, day: '2026-09-01', installs: null, network_cost: '0'}],
        totals: {installs: null},
        warnings: [],
      }),
    );
    const r = await f.call('GET_REPORT', {request: reportRequest});
    assert.equal(r.success, true);
    assert.equal(r.data.complete, false);
    assert.deepEqual(r.data.missing_total_metrics, ['network_cost']);
    assert.equal(r.data.null_metric_values, 1);
    assert.equal(r.data.data.rows[0].installs, null);
    assert.equal(r.data.data.rows[0].network_cost, '0');
    assert.equal(r.data.output_contract_version, 1);
    assert.ok(Number.isFinite(Date.parse(r.data.retrieved_at)));
  } finally {
    f.store.close();
  }
});

test('25,001 distinct rows fail without returning a truncated success', async () => {
  const f = fixture();
  try {
    f.hook(() =>
      Response.json({
        rows: Array.from({length: 25001}, (_, i) => ({app_token: app, campaign: 'c' + i, installs: '1'})),
        totals: {installs: 25001},
        warnings: [],
      }),
    );
    const r = await f.call('GET_REPORT', {
      request: {...reportRequest, dimensions: ['campaign'], metrics: ['installs']},
    });
    assert.equal(r.error?.code, 'ADJUST_REPORT_LIMIT');
    assert.equal(r.data, undefined);
  } finally {
    f.store.close();
  }
});

test('in-flight fetch timeout aborts each bounded attempt and never returns empty success', async () => {
  const f = fixture();
  let attempts = 0,
    aborts = 0;
  try {
    const native = new NativeTransport(
      async (_u, init) => {
        attempts++;
        return new Promise<Response>((_resolve, reject) => {
          const alive = setTimeout(() => reject(Error('abort was missing')), 2000);
          init!.signal!.addEventListener(
            'abort',
            () => {
              clearTimeout(alive);
              aborts++;
              reject(init!.signal!.reason);
            },
            {once: true},
          );
        });
      },
      async () => {},
      10,
    );
    const service = new MirrorService(registry, f.store, native),
      r = await service.call(
        'adjust_native_action',
        {
          operation: 'adjust_reporting',
          arguments: {action: 'GET_REPORT', label: id, payload: {request: reportRequest}},
        },
        owner,
      );
    assert.equal(r.success, false);
    assert.equal(r.error?.code, 'UPSTREAM_UNAVAILABLE');
    assert.equal(attempts, 3);
    assert.equal(aborts, 3);
  } finally {
    f.store.close();
  }
});

test('revocation after a transient failure stops before the next provider attempt', async () => {
  const f = fixture();
  try {
    f.hook(() => {
      f.store.putConnection(owner, {...f.connection, enabled: false}, {accessToken: 'synthetic-adjust-token'});
      return Response.json({error: 'temporarily unavailable'}, {status: 503});
    });
    const r = await f.call('GET_REPORT', {request: reportRequest});
    assert.equal(r.error?.code, 'CONNECTION_REQUIRED');
    assert.equal(f.calls.length, 1);
  } finally {
    f.store.close();
  }
});

test('two store handles share retry budgets through restart and a backwards wall-clock adjustment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amcp-adjust-reporting-')),
    file = join(dir, 'test.sqlite'),
    f = fixture(file),
    g = fixture(file);
  let reopened: Store | undefined, clock: ReturnType<typeof mock.method> | undefined;
  try {
    let now = Date.now(),
      attempts = 0;
    clock = mock.method(Date, 'now', () => now);
    f.hook(() =>
      ++attempts === 1 ? Response.json({}, {status: 503}) : Response.json({rows: [], totals: {}, warnings: []}),
    );
    assert.equal((await f.call('GET_REPORT', {request: reportRequest})).success, true);
    assert.equal(attempts, 2);
    for (let i = 0; i < 28; i++) {
      const h = i % 2 ? f : g;
      assert.equal((await h.call('GET_REPORT', {request: reportRequest})).success, true);
    }
    const count = f.calls.length + g.calls.length;
    assert.equal(count, 30);
    assert.equal((await g.call('GET_REPORT', {request: reportRequest})).error?.code, 'TENANT_RATE_LIMIT');
    assert.equal(f.calls.length + g.calls.length, count);
    now -= 86400000;
    reopened = new Store(file, key);
    assert.throws(() => reopened!.providerPermit('adjust-report-source-ip'), {code: 'TENANT_RATE_LIMIT'});
  } finally {
    clock?.mock.restore();
    reopened?.close();
    f.store.close();
    g.store.close();
    removeTestDirectory(dir, 'amcp-adjust-reporting-');
  }
});

test('native source-IP cooldowns propagate to another worker without leaking provider errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amcp-adjust-reporting-')),
    file = join(dir, 'test.sqlite'),
    f = fixture(file),
    g = fixture(file);
  try {
    f.hook(() => Response.json({error: 'synthetic-adjust-token'}, {status: 429, headers: {'retry-after': '10'}}));
    const first = await f.call('GET_REPORT', {request: reportRequest});
    assert.equal(first.error?.code, 'PLATFORM_RATE_LIMIT');
    assert.equal(first.error.details.retry_after_ms, 10000);
    assert.equal(JSON.stringify(first).includes('synthetic-adjust-token'), false);
    const next = await g.call('GET_REPORT', {request: reportRequest});
    assert.equal(next.error?.code, 'PLATFORM_RATE_LIMIT');
    assert.equal(g.calls.length, 0);
  } finally {
    f.store.close();
    g.store.close();
    removeTestDirectory(dir, 'amcp-adjust-reporting-');
  }
});

test('maintained guide examples execute synthetic contracts and captured metadata remains unchanged', async () => {
  const examples = JSON.parse(
    readFileSync('Skills/amcp-campaign-builder/examples/adjust-reporting.json', 'utf8'),
  ).examples;
  assert.equal(examples.length, 6);
  for (const example of examples) {
    const f = fixture();
    try {
      const r = await f.service.call(example.gateway, example.input, owner);
      assert.equal(r.success, true, JSON.stringify(r));
    } finally {
      f.store.close();
    }
  }
  const runtime = registry.tools
      .get('adjust_native_action')!
      .operations!.find(o => o.operation === 'adjust_reporting')!,
    captured = registry.data.tools
      .find(t => t.name === 'adjust_native_action')!
      .operations!.find(o => o.operation === 'adjust_reporting')!;
  assert.notDeepEqual(runtime.argumentsSchema, captured.argumentsSchema);
  assert.match(readGuidance('amcp://guides/adjust').text, /datePeriod/);
  assert.equal(runtime.amcp_contract?.guide, 'amcp://guides/adjust');
});

test('Adjust capability descriptor separates native reads from website, writes and normalized reporting', () => {
  const c = effectiveProviderContract('adjust')!;
  assert.equal(c.guide, 'amcp://guides/adjust');
  assert.equal(c.contract_version, 2);
  assert.equal(c.native_reads, 'partial');
  assert.equal(c.discovery, 'partial');
  assert.equal(c.website_connection, false);
  assert.equal(c.reviewed_writes, 'unsupported');
  assert.equal(c.overview_reporting, 'unsupported');
  assert.equal(c.live_qualification, 'unverified');
  assert.ok(c.tests.includes('tests/adjust-reporting.test.ts'));
});
