import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {actionContracts} from '../src/action-contracts.js';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {Compiler} from '../src/compiler.js';
import {xReportBuckets, admitXReport} from '../src/x-report-jobs.js';
import {xReportUrl, parseXReportArchive} from '../src/x-report-download.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {removeTestDirectory} from './temp.js';
import type {Actor, Connection, JsonObject} from '../src/types.js';

const registry = new Registry(),
  gateway = 'x_ads_native_action';
test('X asynchronous report creation has an executable reviewed contract with result retrieval evidence', () => {
  const c = actionContracts(registry).find(
    r => r.gateway === gateway && r.action === 'x_stats_jobs_accounts_account_id_post',
  )!;
  assert.equal(c.status, 'reviewed_write_family');
  assert.equal(c.family, 'x_report_jobs');
  assert.ok(c.tests.includes('tests/x-report-jobs.test.ts'));
});

const actor: Actor = {tenantId: 'x-report-fixture', userId: 'operator', role: 'operator'},
  owner: Actor = {...actor, role: 'admin'},
  account = 'abc123',
  entity = 'camp1',
  jobId = '1120829647711653888';
const credentials = {
  consumerKey: 'synthetic-app',
  consumerSecret: 'synthetic-secret',
  accessToken: 'synthetic-user',
  tokenSecret: 'synthetic-token-secret',
};
const definition = (): JsonObject => ({
  entity: 'CAMPAIGN',
  entity_ids: entity,
  metric_groups: 'ENGAGEMENT,BILLING',
  placement: 'ALL_ON_TWITTER',
  granularity: 'TOTAL',
  start_time: '2026-08-01T00:00:00Z',
  end_time: '2026-08-03T00:00:00Z',
});
const options = {mode: 'strict' as const, flags: {}};
function fixture(file = ':memory:', allowWrites = true) {
  const key = Buffer.alloc(32, 72).toString('base64');
  let store = new Store(file, key),
    onNative: ((path: string, method: string) => void | Promise<void>) | undefined,
    onDownload: (() => void | Promise<void>) | undefined,
    mode = '';
  const c: Connection = {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: actor.tenantId,
    gateway,
    accounts: [account],
    writeAccounts: [account],
    label: 'Synthetic original X login',
    enabled: true,
    scopes: [],
  };
  store.putConnection(owner, c, credentials);
  const calls: JsonObject[] = [],
    state: JsonObject = {
      writes: 0,
      downloads: 0,
      status: 'PROCESSING',
      job_id: jobId,
      currency: 'SAR',
      timezone: 'UTC',
      expiry: Date.now() + 86400000,
      query: definition(),
    };
  const nativeDefinition = () => ({
    ...state.query,
    entity_ids: state.query.entity_ids.split(','),
    metric_groups: state.query.metric_groups.split(','),
    segmentation_type: state.query.segmentation_type ?? null,
    country: state.query.country ?? null,
    platform: null,
  });
  const row = () => ({
    ...nativeDefinition(),
    account_id: mode === 'foreign_job' ? 'other' : account,
    id_str: state.job_id,
    id: Number(state.job_id),
    status: state.status,
    url:
      state.status === 'SUCCESS'
        ? (state.url ??
          'https://ton.twimg.com/advertiser-api-async-analytics/stats_job_' +
            state.job_id +
            '.json.gz?signature=synthetic-private')
        : null,
    expires_at: state.status === 'SUCCESS' ? new Date(state.expiry).toISOString() : null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const result = () => ({
    data_type: 'stats',
    time_series_length: xReportBuckets(state.query, state.timezone),
    data: state.query.entity_ids
      .split(',')
      .map((id: string) => ({
        id,
        id_data: [
          {
            segment: state.query.segmentation_type
              ? {name: 'Synthetic <script>ignored</script>', value: 'native-segment'}
              : null,
            metrics: {
              impressions: Array(xReportBuckets(state.query, state.timezone)).fill(100),
              clicks: null,
              billed_charge_local_micro: Array(xReportBuckets(state.query, state.timezone)).fill(1234567),
              conversion_purchases: {post_view: Array(xReportBuckets(state.query, state.timezone)).fill(null)},
            },
          },
        ],
      })),
    request: {params: nativeDefinition()},
  });
  const transport = new NativeTransport(
    async (raw, init) => {
      const u = new URL(String(raw)),
        method = init?.method ?? 'GET';
      assert.equal(u.origin, 'https://ads-api.x.com');
      assert.equal(init?.redirect, 'error');
      assert.match((init?.headers as Record<string, string>).Authorization!, /^OAuth /);
      calls.push({path: u.pathname, method, query: Object.fromEntries(u.searchParams), body: init?.body});
      await onNative?.(u.pathname, method);
      if (method === 'POST') {
        state.writes++;
        state.query = Object.fromEntries(u.searchParams);
        assert.ok(!init?.body, 'X async analytics uses query parameters');
        if (mode === 'lost') throw Error('Accepted, response lost');
        if (mode === 'write_error') return Response.json({errors: [{code: 'INVALID_PARAMETER', message: 'Rejected'}]});
        if (mode === 'empty_receipt') return Response.json({data: {}});
        return Response.json({
          data: mode === 'reused_receipt' ? {...row(), id_str: jobId} : row(),
          request: {params: {trace: calls.length}},
        });
      }
      if (u.pathname === '/12/stats/jobs/accounts/' + account) {
        if (mode === 'status_error') return Response.json({errors: [{code: 'BAD_JOB', message: 'Unknown'}]});
        let rows = [row()];
        if (mode === 'missing_job') rows = [];
        if (mode === 'duplicate_job') rows = [row(), row()];
        return Response.json({
          data: rows,
          next_cursor: mode === 'cursor' ? '123' : null,
          request: {params: {job_ids: [Number(state.job_id)]}},
        });
      }
      if (u.pathname === '/12/accounts/' + account)
        return Response.json({
          data: {
            id: mode === 'foreign_account' ? 'wrong' : account,
            currency: state.currency,
            timezone: state.timezone,
            deleted: mode === 'deleted',
            name: 'Synthetic ' + calls.length,
            updated_at: String(calls.length),
          },
          ...(mode === 'partial' ? {partial: true} : {}),
        });
      const id = u.pathname.split('/').at(-1)!;
      return Response.json({
        data: {
          id,
          account_id: mode === 'foreign_entity' ? 'other' : account,
          deleted: true,
          name: 'Historical entity ' + calls.length,
        },
      });
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const downloader: typeof fetch = async (raw, init) => {
    const u = new URL(String(raw));
    assert.equal(u.hostname, 'ton.twimg.com');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    state.downloads++;
    await onDownload?.();
    const data = state.result ?? result();
    let bytes = gzipSync(JSON.stringify(data));
    if (mode === 'corrupt') bytes[bytes.length - 8] = bytes[bytes.length - 8]! ^ 1;
    if (mode === 'utf8') bytes = gzipSync(new Uint8Array([255]));
    if (mode === 'truncated') bytes = bytes.subarray(0, -2);
    return new Response(new Uint8Array(bytes), {
      status: mode === 'redirect' ? 302 : 200,
      headers: {
        'content-type': 'application/gzip',
        'content-length': String(bytes.length + (mode === 'short_transfer' ? 1 : 0)),
      },
    });
  };
  const build = () =>
    new MirrorService(
      registry,
      store,
      transport,
      undefined,
      {allowWrites, requireBeforeState: true, maxBudgetChange: 0},
      downloader,
    );
  let service = build();
  const args = (query = definition()): JsonObject => ({
    action: 'x_stats_jobs_accounts_account_id_post',
    account_id: account,
    connection_id: c.id,
    params: query,
  });
  const prepare = (query = definition()) =>
    service.call('amcp_write', {action: 'prepare', gateway, arguments: args(query)}, actor);
  const execute = (p: JsonObject, extra: JsonObject = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        ...extra,
      },
      actor,
    );
  const get = (download = true, extra: JsonObject = {}, as = actor) =>
    service.call(
      gateway,
      {
        action: 'x_stats_jobs_accounts_account_id_get',
        account_id: account,
        connection_id: c.id,
        params: {job_ids: state.job_id},
        dry_run: false,
        ...(download ? {download_report: true} : {}),
        ...extra,
      },
      as,
    );
  const verify = (p: JsonObject) =>
    service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    c,
    calls,
    state,
    prepare,
    execute,
    get,
    verify,
    args,
    row,
    result,
    mode: (s: string) => {
      mode = s;
    },
    onNative: (f: typeof onNative) => {
      onNative = f;
    },
    onDownload: (f: typeof onDownload) => {
      onDownload = f;
    },
    restart: () => {
      store.close();
      store = new Store(file, key);
      service = build();
    },
  };
}

test('X reviewed submission, pending poll, successful verification and server download preserve native values', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal(f.state.writes, 0);
    assert.match(p.data.creative_impact.effect, /analytics job/);
    const e = await f.execute(p);
    assert.equal(e.success, true, JSON.stringify(e));
    assert.equal(e.data.success, true, JSON.stringify(e));
    assert.equal(e.data.data.data.id_str, jobId);
    assert.equal((await f.verify(p)).data.status, 'pending');
    const pending = await f.get();
    assert.equal(pending.success, true, JSON.stringify(pending));
    assert.equal(pending.data.data.report.complete, false);
    assert.equal(f.state.downloads, 0);
    f.state.status = 'SUCCESS';
    const v = await f.verify(p);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
    assert.equal(v.data.verified_resources[0].read_result.arguments.download_report, true);
    const r = await f.get();
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.data.report.complete, true);
    assert.equal(r.data.data.report.currency, 'SAR');
    assert.equal(r.data.data.data[0].metrics.billed_charge_local_micro[0], 1234567);
    assert.equal(r.data.data.data[0].metrics.clicks, null);
    assert.equal(r.data.data.data[0].metrics.conversion_purchases.post_view[0], null);
    const again = await f.get();
    assert.equal(again.success, true);
    assert.equal(f.state.downloads, 1);
    assert.equal(f.state.writes, 1);
    assert.equal((await f.execute(p)).data.replayed, true);
    const persisted = f.store.db.prepare("SELECT data FROM documents WHERE kind='x_report_result'").get() as JsonObject;
    assert.ok(!persisted.data.includes('billed_charge_local_micro'));
    assert.ok(!JSON.stringify(r).includes('signature'));
    assert.ok(!JSON.stringify(e).includes('signature'));
  } finally {
    f.store.close();
  }
});

test('X report accepts explicit native query or body inputs, compiles only query wire fields, and rejects conflicting aliases', async () => {
  const f = fixture();
  try {
    for (const input of [{query: definition()}, {payload: definition()}, {params: definition()}]) {
      const r = await f.service.call(
        'amcp_write',
        {
          action: 'inspect',
          gateway,
          arguments: {action: 'x_stats_jobs_accounts_account_id_post', account_id: account, ...input},
        },
        actor,
      );
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(r.data.request.body, undefined);
      assert.deepEqual(r.data.request.query, definition());
    }
    assert.equal(f.calls.length, 0);
    assert.equal(
      (await f.service.call(gateway, {...f.args(), query: {entity: 'LINE_ITEM'}, dry_run: true}, actor)).success,
      false,
    );
    for (const extra of [{download_report: true}, {offset: 0}, {query: {method: 'DELETE'}}])
      assert.equal(
        (await f.service.call('amcp_write', {action: 'prepare', gateway, arguments: {...f.args(), ...extra}}, actor))
          .success,
        false,
      );
  } finally {
    f.store.close();
  }
});

test('X report invalid fields, entities, metric combinations, time ranges and retired segmentations never reach provider', async () => {
  const changes = [
    {entity: 'INVENTED'},
    {entity_ids: 'camp1,camp1'},
    {entity_ids: '../bad'},
    {entity_ids: Array.from({length: 21}, (_, i) => 'a' + i).join(',')},
    {entity: 'ACCOUNT'},
    {entity: 'FUNDING_INSTRUMENT', metric_groups: 'VIDEO'},
    {metric_groups: 'BILLING,BOGUS'},
    {metric_groups: 'MOBILE_CONVERSION,BILLING'},
    {granularity: 'WEEK'},
    {placement: 'PUBLISHER_NETWORK'},
    {start_time: '2026-02-30T00:00:00Z'},
    {start_time: '2026-08-01T00:30:00Z'},
    {start_time: '2026-08-01'},
    {end_time: '2026-08-01T00:00:00Z'},
    {end_time: '2027-01-01T00:00:00Z'},
    {segmentation_type: 'INTERESTS'},
    {segmentation_type: 'METROS'},
    {segmentation_type: 'GENDER', country: '96683cc9126741d1'},
    {segmentation_type: 'CONVERSION_TAGS'},
    {segmentation_type: 'AGE', metric_groups: 'WEB_CONVERSION'},
    {segmentation_type: 'AGE', metric_groups: 'LIFE_TIME_VALUE_MOBILE_CONVERSION'},
    {platform: 'DESKTOP'},
    {include_pii: true},
  ];
  for (const change of changes) {
    const f = fixture();
    try {
      assert.equal((await f.prepare({...definition(), ...change})).success, false, JSON.stringify(change));
      assert.equal(f.calls.length, 0, JSON.stringify(change));
    } finally {
      f.store.close();
    }
  }
});

test('X current currency/timezone and exact historical entity ownership are required while names and telemetry do not conflict', async () => {
  for (const mode of ['foreign_account', 'foreign_entity', 'deleted', 'partial']) {
    const f = fixture();
    try {
      f.mode(mode);
      assert.equal((await f.prepare()).success, false, mode);
      assert.equal(f.state.writes, 0);
    } finally {
      f.store.close();
    }
  }
  for (const key of ['currency', 'timezone']) {
    const f = fixture();
    try {
      const p = await f.prepare();
      assert.equal(p.success, true);
      f.state[key] = key === 'currency' ? 'EUR' : 'America/New_York';
      const e = await f.execute(p);
      assert.equal(e.error.code, 'STATE_CHANGED');
      assert.ok(e.error.details.changed_fields.some((s: string) => s.includes(key)));
      assert.equal(f.state.writes, 0);
    } finally {
      f.store.close();
    }
  }
});

test('X DAY validates account midnight and counts DST days, while HOUR retains 23 and 25 hour series', () => {
  for (const [start, end, hours] of [
    ['2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z', 23],
    ['2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z', 25],
  ] as const) {
    const d = {...definition(), start_time: start, end_time: end};
    assert.equal(xReportBuckets({...d, granularity: 'DAY'}, 'America/New_York'), 1);
    assert.equal(xReportBuckets({...d, granularity: 'HOUR'}, 'America/New_York'), hours);
  }
  assert.throws(() => xReportBuckets({...definition(), granularity: 'DAY'}, 'America/New_York'), /midnight/);
});

test('X native bypass, deployment controls, reader roles, review ownership and revoked write grants remain enforced', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    assert.equal(p.success, true);
    assert.equal(
      (
        await f.service.call(
          gateway,
          {...f.args(), dry_run: false, confirmed: true, idempotency_key: '12345678-1234-4234-9234-123456789abc'},
          actor,
        )
      ).error.code,
      'WRITE_REVIEW_REQUIRED',
    );
    assert.equal((await f.execute(p, {confirmed: false})).error.code, 'CONFIRMATION_REQUIRED');
    assert.equal((await f.execute(p, {idempotency_key: 'another'})).error.code, 'IDEMPOTENCY_REQUIRED');
    assert.equal(
      (
        await f.service.call(
          'amcp_write',
          {action: 'prepare', gateway, arguments: f.args()},
          {...actor, role: 'reader'},
        )
      ).success,
      false,
    );
    f.store.putConnection(owner, {...f.c, writeAccounts: []}, credentials);
    assert.equal((await f.execute(p)).error.code, 'WRITE_ACCOUNT_FORBIDDEN');
    assert.equal(f.state.writes, 0);
  } finally {
    f.store.close();
  }
  const d = fixture(':memory:', false);
  try {
    assert.equal((await d.prepare()).error.code, 'LIVE_WRITES_DISABLED');
    assert.equal(d.calls.length, 0);
  } finally {
    d.store.close();
  }
});

test('X report creation has zero spend under zero-budget and disabled activation policies', async () => {
  const f = fixture();
  try {
    saveSpendPolicy(f.store, owner, {
      scope: 'workspace',
      confirmed: true,
      policy: {allow_activation: false, allow_deletion: false, max_budget_native: 0, max_daily_increase_native: 0},
    });
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal((await f.execute(p)).data.success, true);
  } finally {
    f.store.close();
  }
});

test('X original job account, connection, login and tenant bindings precede every read', async () => {
  const f = fixture();
  try {
    assert.equal((await f.get(false)).error.code, 'RESOURCE_SCOPE_REQUIRED');
    const p = await f.prepare();
    await f.execute(p);
    const other = {...f.c, id: '22222222-2222-4222-8222-222222222222'};
    f.store.putConnection(owner, other, credentials);
    for (const extra of [
      {connection_id: other.id},
      {params: {job_ids: '999'}},
      {account_id: 'different'},
      {aggregate_pages: true},
      {params: {job_ids: jobId + ',999'}},
      {result_fields: ['id']},
      {max_items: 1},
      {compact: true},
    ]) {
      const n = f.calls.length;
      assert.equal((await f.get(true, extra)).success, false, JSON.stringify(extra));
      assert.equal(f.calls.length, n);
    }
    assert.equal((await f.get(true, {}, {...actor, tenantId: 'other'})).success, false);
    f.store.putConnection(owner, f.c, {...credentials, expiresAt: Date.now() + 86400000});
    assert.equal((await f.get(false)).success, true);
    f.store.putConnection(owner, f.c, {...credentials, tokenSecret: 'replacement'});
    const n = f.calls.length;
    assert.equal((await f.get(false)).error.code, 'X_REPORT_LOGIN_CHANGED');
    const denied = await f.verify(p);
    assert.notEqual(denied.data.status, 'verified');
    assert.ok(denied.data.checks.some((v: JsonObject) => v.code === 'X_REPORT_LOGIN_CHANGED'));
    assert.equal(f.calls.length, n);
  } finally {
    f.store.close();
  }
});

for (const boundary of ['metadata', 'download', 'final_status'])
  for (const revoke of ['account', 'login', 'actor'])
    test('X report withholds ' + revoke + ' revocation at ' + boundary, async () => {
      const f = fixture();
      try {
        let active = true;
        f.store.bindActorCheck(actor, () => {
          if (!active) throw Error('actor revoked');
        });
        const p = await f.prepare();
        await f.execute(p);
        f.state.status = 'SUCCESS';
        let statusReads = 0;
        const withdraw = () => {
          if (revoke === 'actor') active = false;
          else
            f.store.putConnection(
              owner,
              revoke === 'account' ? {...f.c, accounts: ['another'], writeAccounts: []} : f.c,
              revoke === 'login' ? {...credentials, accessToken: 'replacement'} : credentials,
            );
        };
        if (boundary === 'download') f.onDownload(withdraw);
        else
          f.onNative(path => {
            if (path.includes('/stats/jobs/') && ++statusReads === (boundary === 'metadata' ? 1 : 2)) withdraw();
          });
        const r = await f.get();
        assert.equal(r.success, false, JSON.stringify(r));
        assert.equal(f.state.downloads, boundary === 'metadata' ? 0 : 1);
        assert.equal(f.store.db.prepare("SELECT count(*) n FROM documents WHERE kind='x_report_result'").get()!.n, 0);
        assert.equal(f.state.writes, 1);
      } finally {
        f.store.close();
      }
    });

test('X in-flight prerequisite login replacement prevents reviewed submission', async () => {
  const f = fixture();
  try {
    f.onNative(() => f.store.putConnection(owner, f.c, {...credentials, accessToken: 'replacement'}));
    const p = await f.prepare();
    assert.equal(p.success, false);
    assert.equal(f.calls.length, 1);
    assert.equal(f.state.writes, 0);
  } finally {
    f.store.close();
  }
});

test('X failed, cancelled, expired, malformed or missing job state is never a successful empty report', async () => {
  for (const mode of [
    'FAILED',
    'CANCELLED',
    'UNKNOWN',
    'expired',
    'foreign_job',
    'missing_job',
    'duplicate_job',
    'status_error',
  ]) {
    const f = fixture();
    try {
      const p = await f.prepare();
      await f.execute(p);
      f.state.status = ['FAILED', 'CANCELLED', 'UNKNOWN'].includes(mode) ? mode : 'SUCCESS';
      if (mode === 'expired') f.state.expiry = Date.now() - 1;
      else f.mode(mode);
      const r = await f.get();
      assert.equal(r.success, false, mode + JSON.stringify(r));
      assert.equal(f.state.downloads, 0);
      assert.equal(f.state.writes, 1);
    } finally {
      f.store.close();
    }
  }
});

test('X lost, malformed and foreign creation receipts never permit resubmission', async () => {
  for (const mode of ['lost', 'empty_receipt', 'foreign_job', 'write_error']) {
    const f = fixture();
    try {
      const p = await f.prepare();
      f.mode(mode);
      const e = await f.execute(p);
      assert.ok(!e.success || !e.data?.success, mode);
      await f.execute(p);
      assert.equal(f.state.writes, 1);
      assert.equal((await f.get(false)).success, false);
      assert.equal(f.state.downloads, 0);
    } finally {
      f.store.close();
    }
  }
});

test('X concurrent execution and encrypted result recovery survive SQLite restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amcp-xreports-')),
    f = fixture(join(dir, 'store.sqlite'));
  try {
    const p = await f.prepare();
    await Promise.all([f.execute(p), f.execute(p)]);
    assert.equal(f.state.writes, 1);
    f.state.status = 'SUCCESS';
    assert.equal((await f.get()).success, true);
    assert.equal(f.state.downloads, 1);
    f.restart();
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal((await f.get()).success, true);
    assert.equal(f.state.downloads, 1);
    assert.equal(f.state.writes, 1);
  } finally {
    f.store.close();
    removeTestDirectory(dir, 'amcp-xreports-');
  }
});

test('X missing requested entities remain visibly incomplete, and pagination preserves provenance', async () => {
  const f = fixture();
  try {
    const p = await f.prepare({...definition(), entity_ids: 'camp1,camp2'});
    await f.execute(p);
    f.state.status = 'SUCCESS';
    let r = await f.get(true, {limit: 1});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.data.report.source_complete, true);
    assert.equal(r.data.data.report.complete, false);
    assert.equal(r.data.data.report.has_more, true);
    r = await f.get(true, {limit: 1, offset: 1});
    assert.equal(r.data.data.data[0].id, 'camp2');
    assert.equal(r.data.data.report.has_more, false);
    assert.equal(r.data.data.report.source_rows, 2);
    assert.equal(f.state.downloads, 1);
  } finally {
    f.store.close();
  }
  const d = fixture();
  try {
    const p = await d.prepare({...definition(), entity_ids: 'camp1,camp2'});
    await d.execute(p);
    d.state.status = 'SUCCESS';
    d.state.result = d.result();
    d.state.result.data = [];
    const r = await d.get();
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.data.report.complete, false);
    assert.deepEqual(r.data.data.report.missing_entity_ids, ['camp1', 'camp2']);
  } finally {
    d.store.close();
  }
});

test('X downloaded result rejects substituted definitions, foreign IDs, duplicate grains and invalid buckets/numbers', async () => {
  const mutations = [
    (d: JsonObject) => {
      d.request.params.placement = 'TREND';
    },
    (d: JsonObject) => {
      d.request.params.start_time = '2026-08-02T00:00:00Z';
    },
    (d: JsonObject) => {
      d.data[0].id = 'other';
    },
    (d: JsonObject) => {
      d.data.push(d.data[0]);
    },
    (d: JsonObject) => {
      d.data[0].id_data.push(d.data[0].id_data[0]);
    },
    (d: JsonObject) => {
      d.data[0].id_data[0].metrics.impressions = [1, 2];
    },
    (d: JsonObject) => {
      d.data[0].id_data[0].metrics.impressions = [9007199254740992];
    },
    (d: JsonObject) => {
      d.data[0].id_data[0].metrics.impressions = ['5'];
    },
    (d: JsonObject) => {
      d.data[0].id_data[0].segment = {unexpected: true};
    },
    (d: JsonObject) => {
      d.time_series_length = 2;
    },
    (d: JsonObject) => {
      d.next_cursor = 'more';
    },
    (d: JsonObject) => {
      d.data_type = 'other';
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    try {
      const p = await f.prepare();
      await f.execute(p);
      f.state.status = 'SUCCESS';
      f.state.result = f.result();
      mutate(f.state.result);
      assert.equal((await f.get()).success, false);
      assert.equal(f.state.writes, 1);
      assert.equal(f.store.db.prepare("SELECT count(*) n FROM documents WHERE kind='x_report_result'").get()!.n, 0);
    } finally {
      f.store.close();
    }
  }
});

test('X gzip CRC, truncation, byte counts, UTF-8 and redirects are validated before any result is saved', async () => {
  for (const mode of ['corrupt', 'truncated', 'short_transfer', 'utf8', 'redirect']) {
    const f = fixture();
    try {
      const p = await f.prepare();
      await f.execute(p);
      f.state.status = 'SUCCESS';
      f.mode(mode);
      assert.equal((await f.get()).success, false, mode);
      assert.equal(f.store.db.prepare("SELECT count(*) n FROM documents WHERE kind='x_report_result'").get()!.n, 0);
    } finally {
      f.store.close();
    }
  }
  assert.throws(() => parseXReportArchive(gzipSync('x'.repeat(33 * 1024 * 1024)), {}), /32 MiB/);
});

test('X report locations reject private networks, credential URLs, port changes and substituted job files', () => {
  const valid = 'https://ton.twimg.com/advertiser-api-async-analytics/stats_job_' + jobId + '.json.gz';
  assert.equal(xReportUrl(valid, jobId).hostname, 'ton.twimg.com');
  for (const url of [
    'http://ton.twimg.com/' + jobId,
    'https://127.0.0.1/a.gz',
    'https://ton.twimg.com.evil.invalid/a.gz',
    valid.replace('https://', 'https://user:pass@'),
    valid.replace('.com/', '.com:8443/'),
    valid + '#fragment',
    valid.replace(jobId, '999'),
    valid.replace('/stats_job_', '/../stats_job_'),
  ])
    assert.throws(() => xReportUrl(url, jobId), /X result location/, url);
});

test('X local concurrent-job admission is account-wide, capped and not reset by new logins or wall clocks', async () => {
  const f = fixture();
  try {
    const plan = new Compiler(registry).compile(gateway, f.args(), options);
    f.store.transaction(() => {
      for (let i = 0; i < 100; i++) admitXReport(plan, f.store, 'review-' + i);
    });
    assert.throws(() => admitXReport(plan, f.store, 'new'), {code: 'PLATFORM_RATE_LIMIT'});
    admitXReport(plan, f.store, 'review-0');
    const p = await f.prepare();
    const e = await f.execute(p);
    assert.equal(e.error.code, 'PLATFORM_RATE_LIMIT');
    assert.equal(f.state.writes, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM idempotency').get()!.n, 0);
  } finally {
    f.store.close();
  }
});

test('X terminal job polling frees the local slot, while processing and uncertain submissions retain it', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    await f.execute(p);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM documents WHERE kind='x_report_quota'").get()!.n, 1);
    await f.get(false);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM documents WHERE kind='x_report_quota'").get()!.n, 1);
    f.state.status = 'SUCCESS';
    await f.get(false);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM documents WHERE kind='x_report_quota'").get()!.n, 0);
  } finally {
    f.store.close();
  }
});

test('X future unqualified cancellation stays blocked and does not bypass the reviewed workflow', async () => {
  const f = fixture();
  try {
    const r = await f.service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action: 'x_stats_jobs_accounts_account_id_delete', account_id: account, params: {job_ids: jobId}},
      },
      actor,
    );
    assert.equal(r.success, false);
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});

test('X immediately failed native jobs retain the original ID and release processing admission without resubmission', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    f.state.status = 'FAILED';
    const e = await f.execute(p);
    assert.equal(e.success, false, JSON.stringify(e));
    assert.equal(e.error.code, 'WRITE_PARTIAL_OR_FAILED');
    assert.equal(e.data.success, false);
    assert.equal(e.data.data.data.id_str, jobId);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM documents WHERE kind='x_report_run'").get()!.n, 1);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM documents WHERE kind='x_report_quota'").get()!.n, 0);
    const status = await f.get(false);
    assert.equal(status.success, true, JSON.stringify(status));
    assert.equal(status.data.data.data[0].status, 'FAILED');
    const report = await f.get();
    assert.equal(report.success, false);
    assert.equal(report.error.code, 'X_REPORT_FAILED');
    const replay = await f.execute(p);
    assert.equal(replay.data.replayed, true);
    assert.equal(replay.data.success, false);
    assert.equal(f.state.writes, 1);
    assert.equal(f.state.downloads, 0);
  } finally {
    f.store.close();
  }
});

test('X native entity types and all current segmentations have complete report journeys', async () => {
  const inputs: JsonObject[] = [
    ...['ACCOUNT', 'FUNDING_INSTRUMENT', 'CAMPAIGN', 'LINE_ITEM', 'PROMOTED_TWEET', 'MEDIA_CREATIVE'].map(entity => ({
      ...definition(),
      entity,
      entity_ids: entity === 'ACCOUNT' ? account : 'entity1',
      metric_groups: entity === 'ACCOUNT' ? 'ENGAGEMENT' : 'ENGAGEMENT,BILLING',
    })),
    ...['AGE', 'GENDER', 'METROS', 'REGIONS', 'PLATFORMS', 'CONVERSION_TAGS'].map(segmentation_type => ({
      ...definition(),
      segmentation_type,
      metric_groups: segmentation_type === 'CONVERSION_TAGS' ? 'WEB_CONVERSION' : 'ENGAGEMENT',
      ...(['METROS', 'REGIONS'].includes(segmentation_type) ? {country: '96683cc9126741d1'} : {}),
    })),
  ];
  for (const input of inputs) {
    const f = fixture();
    try {
      const p = await f.prepare(input);
      assert.equal(p.success, true, JSON.stringify(p));
      assert.equal((await f.execute(p)).data.success, true);
      f.state.status = 'SUCCESS';
      const r = await f.get();
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(r.data.data.report.complete, true);
      if (input.segmentation_type) assert.equal(r.data.data.report.segmentation_reconciles_to_total, false);
    } finally {
      f.store.close();
    }
  }
});

test('X accepted submissions retain job receipts before denying a newly revoked caller', async () => {
  for (const kind of ['account', 'login']) {
    const f = fixture();
    try {
      const p = await f.prepare();
      f.onNative((_path, method) => {
        if (method === 'POST')
          f.store.putConnection(
            owner,
            kind === 'account' ? {...f.c, accounts: ['another'], writeAccounts: []} : f.c,
            kind === 'login' ? {...credentials, accessToken: 'changed'} : credentials,
          );
      });
      const e = await f.execute(p);
      assert.equal(e.success, false);
      const stored = f.store.db.prepare('SELECT state FROM idempotency WHERE key=?').get(p.data.review_id);
      assert.equal(stored!.state, 'complete', JSON.stringify({kind, e}));
      assert.equal(f.store.db.prepare("SELECT count(*) n FROM documents WHERE kind='x_report_run'").get()!.n, 1);
      f.onNative(undefined);
      f.store.putConnection(owner, f.c, credentials);
      assert.equal((await f.execute(p)).data.replayed, true);
      assert.equal(f.state.writes, 1);
    } finally {
      f.store.close();
    }
  }
});

test('X original uncertain submissions survive restart and reused job IDs cannot replace ownership', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amcp-xreport-lost-')),
    f = fixture(join(dir, 'store.sqlite'));
  try {
    const p = await f.prepare();
    f.mode('lost');
    assert.equal((await f.execute(p)).success, false);
    f.restart();
    assert.equal((await f.execute(p)).error.code, 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(f.state.writes, 1);
  } finally {
    f.store.close();
    removeTestDirectory(dir, 'amcp-xreport-lost-');
  }
  const d = fixture();
  try {
    const p = await d.prepare();
    await d.execute(p);
    const q = await d.prepare({...definition(), metric_groups: 'VIDEO'});
    const out = await d.execute(q);
    assert.equal(out.success, false);
    assert.equal((await d.execute(q)).error.code, 'WRITE_OUTCOME_UNCERTAIN');
    const b = JSON.parse(
      (d.store.db.prepare("SELECT data FROM documents WHERE kind='x_report_run'").get() as JsonObject).data,
    );
    assert.equal(b.definition.metric_groups, 'ENGAGEMENT,BILLING');
    assert.equal(d.state.writes, 2);
  } finally {
    d.store.close();
  }
});

test('X a busy deployment or lost result lease performs no unsafe result persistence', async () => {
  for (const mode of ['busy', 'lost']) {
    const f = fixture();
    try {
      const p = await f.prepare();
      await f.execute(p);
      f.state.status = 'SUCCESS';
      if (mode === 'busy') {
        f.store.acquireLock('x-report-memory:0', 'synthetic-other', 120000);
        f.store.acquireLock('x-report-memory:1', 'synthetic-other', 120000);
      } else
        f.onDownload(() => {
          f.store.db.prepare("DELETE FROM service_locks WHERE key LIKE 'x-report-result:%'").run();
        });
      const r = await f.get();
      assert.equal(r.error.code, 'X_REPORT_DOWNLOAD_BUSY');
      assert.equal(f.state.downloads, mode === 'busy' ? 0 : 1);
      assert.equal(f.store.db.prepare("SELECT count(*) n FROM documents WHERE kind='x_report_result'").get()!.n, 0);
    } finally {
      f.store.close();
    }
  }
});

test('X expired review and changed frozen request cannot allocate a job', async () => {
  for (const mode of ['expired', 'changed']) {
    const f = fixture();
    try {
      const p = await f.prepare(),
        review = f.store.document(actor.tenantId, 'write_review', p.data.review_id);
      if (mode === 'expired') review.expires_at = Date.now() - 1;
      else review.plan.query.entity_ids = 'different';
      f.store.putDocument(actor.tenantId, 'write_review', p.data.review_id, review);
      const e = await f.execute(p);
      assert.equal(e.error.code, mode === 'expired' ? 'REVIEW_EXPIRED' : 'REVIEW_CHANGED');
      assert.equal(f.state.writes, 0);
    } finally {
      f.store.close();
    }
  }
});

test('X actual read deadline prevents an HTTP attempt after operation expiry', async () => {
  const f = fixture();
  try {
    const p = new Compiler(registry).compile(
      gateway,
      {action: 'x_accounts_account_id_get', account_id: account},
      options,
    );
    let calls = 0;
    const t = new NativeTransport(async () => {
      calls++;
      throw Error('No network');
    });
    await assert.rejects(() => t.request({...p, xReportDeadline: performance.now() - 1}, f.c, credentials), {
      code: 'X_REPORT_STATE_UNVERIFIED',
    });
    assert.equal(calls, 0);
  } finally {
    f.store.close();
  }
});
