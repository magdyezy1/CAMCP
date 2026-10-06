import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ReportCollectionBudget,
  collectionRequestTimeout,
  collectionResponseBytes,
  reportCollectionLimits,
} from '../src/report-collection-budget.js';
import {collectReportPeriods} from '../src/report-periods.js';
import {NativeTransport} from '../src/transport.js';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {ReportingOverview} from '../src/reporting-overview.js';
import {ReportWorker} from '../src/worker.js';
import {fingerprint} from '../src/report-quality.js';
import type {Actor, JsonObject} from '../src/types.js';

test('nested page collectors charge their original whole-workflow request and byte allowances', async () => {
  let whole: JsonObject = {},
    page: JsonObject = {};
  const limits = {requests: 2, rows: 10, elapsed_ms: 10000, bytes: 10};
  const outer = new ReportCollectionBudget(
    undefined,
    'workflow',
    value => {
      whole = value;
    },
    limits,
  );
  const inner = new ReportCollectionBudget(
    undefined,
    'page',
    value => {
      page = value;
    },
    {...limits, requests: 10},
  );
  await outer.run(async () => {
    await inner.run(async () => {
      assert.ok(collectionRequestTimeout(100) <= 100);
      collectionResponseBytes(6);
      await outer.run(async () => collectionRequestTimeout(100));
      assert.equal(whole.requests, 2, 'Re-entering the original budget does not double-charge it');
      assert.equal(page.requests, 2);
      assert.equal(whole.bytes, 6);
      assert.equal(page.bytes, 6);
      assert.throws(() => collectionRequestTimeout(100), {code: 'REPORT_COLLECTION_LIMIT'});
    });
    const next = new ReportCollectionBudget(undefined, 'next-page', () => {}, limits);
    await assert.rejects(() => next.run(async () => collectionResponseBytes(5)), {code: 'REPORT_COLLECTION_LIMIT'});
    next.close();
  });
  outer.close();
  inner.close();
  assert.equal(collectionRequestTimeout(100), 100, 'Completion releases the complete context stack');
});

test('collection counters survive serialization, queue waits and retries without refunding rows', async () => {
  let state: JsonObject | undefined,
    mono = 0,
    wall = 1000;
  const limits = {requests: 2, rows: 3, elapsed_ms: 100, bytes: 1000};
  const create = () =>
    new ReportCollectionBudget(
      state,
      'same-definition',
      value => (state = JSON.parse(JSON.stringify(value))),
      limits,
      () => mono,
      () => wall,
    );
  let budget = create();
  await budget.run(async () => {
    collectionRequestTimeout(30000);
    budget.rows('first-period', 2);
  });
  mono = 30;
  wall += 30;
  budget.close();
  wall += 100000;
  budget = create();
  assert.equal(state!.elapsed_ms, 30, 'clean queue waiting is not active collection time');
  budget.rows('first-period', 1);
  assert.equal(state!.rows, 2, 're-reading fewer rows does not refund usage');
  await budget.run(async () => {
    assert.equal(collectionRequestTimeout(30000), 70);
  });
  await assert.rejects(async () => budget.run(async () => collectionRequestTimeout(30000)), {
    code: 'REPORT_COLLECTION_LIMIT',
  });
  assert.equal(state!.requests, 2);
  assert.throws(() => budget.rows('next-period', 2), {code: 'REPORT_COLLECTION_LIMIT'});
  budget.close();
  assert.throws(() => new ReportCollectionBudget(state, 'changed-definition', () => {}), {
    code: 'REPORT_DEFINITION_CHANGED',
  });
});
test('independent async jobs cannot share or reset each other’s allowance', async () => {
  const a = new ReportCollectionBudget(undefined, 'a', () => {}, {
    requests: 1,
    rows: 2,
    elapsed_ms: 10000,
    bytes: 1000,
  });
  const b = new ReportCollectionBudget(undefined, 'b', () => {}, {
    requests: 2,
    rows: 2,
    elapsed_ms: 10000,
    bytes: 1000,
  });
  await Promise.all([
    a.run(async () => {
      collectionRequestTimeout(100);
      await Promise.resolve();
      assert.throws(() => collectionRequestTimeout(100), {code: 'REPORT_COLLECTION_LIMIT'});
    }),
    b.run(async () => {
      collectionRequestTimeout(100);
      await Promise.resolve();
      collectionRequestTimeout(100);
    }),
  ]);
  assert.equal(collectionRequestTimeout(100), 100, 'ordinary requests have no report context');
  a.close();
  b.close();
});
test('a period limit retains earlier valid rows and explicitly marks remaining dates incomplete', async () => {
  let count = 0;
  const budget = new ReportCollectionBudget(undefined, 'periods', () => {}, {
    requests: 2,
    rows: 10,
    elapsed_ms: 10000,
    bytes: 1000,
  });
  const result = await budget.run(() =>
    collectReportPeriods(
      {platform: 'meta'},
      {since: '2026-09-01', until: '2026-09-04'},
      'daily',
      {},
      async () => {
        collectionRequestTimeout(1000);
        count++;
        return {rows: [{campaign_id: 'one', metrics: {spend: 1}}], complete: true, currency: 'USD'};
      },
      () => {},
    ),
  );
  budget.close();
  assert.equal(count, 2);
  assert.equal(result.rows.length, 2);
  assert.equal(result.complete, false);
  assert.equal(result.period_errors.length, 2);
  assert.equal(result.collection_limit, true);
  assert.equal(result.rows[1].report_period.since, '2026-09-02');
});
function fixture() {
  const actor: Actor = {tenantId: 'collection-budget', userId: 'owner', role: 'admin'};
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64'));
  const source = {platform: 'meta', account_id: '100', connection_id: 'budget-meta'};
  store.putConnection(
    actor,
    {
      id: source.connection_id,
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['ads_read'],
    },
    {accessToken: 'synthetic'},
  );
  let calls = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async raw => {
        calls++;
        return Response.json(
          String(raw).includes('/insights') ? {data: []} : {id: 'act_100', currency: 'USD', timezone_name: 'UTC'},
        );
      },
      async () => {},
    ),
  );
  const overview = new ReportingOverview(service);
  const worker = new ReportWorker(
    store,
    async () => ({}),
    (t, k, i) => overview.work(t, k, i),
  );
  const config = {
    name: 'Budget test',
    sources: [source],
    date_range: {since: '2026-09-01', until: '2026-09-03'},
    metrics: ['spend'],
    custom_metrics: [],
    grain: 'daily',
  };
  return {actor, store, service, overview, worker, config, calls: () => calls};
}
test('real Overview transport counts account reads and pages, and an exhausted resumed job sends nothing', async () => {
  const f = fixture();
  try {
    const queued = await f.overview.handle({action: 'run', config: f.config, confirmed: true}, f.actor);
    await f.worker.once();
    const report = await f.overview.handle({action: 'get', id: queued.id}, f.actor);
    assert.equal(report.state, 'complete');
    assert.equal(report.collection_budget.requests, f.calls());
    assert.ok(f.calls() >= 3);
    assert.ok(report.collection_budget.bytes > 0);
    const next = await f.overview.handle({action: 'run', config: f.config, confirmed: true}, f.actor);
    const record = f.store.document(f.actor.tenantId, 'overview_report', next.id);
    f.store.putDocument(f.actor.tenantId, 'overview_report', next.id, {
      ...record,
      collection_budget: {
        version: 1,
        definition: fingerprint(record.config),
        requests: reportCollectionLimits.requests,
        elapsed_ms: 0,
        bytes: 0,
        rows: 0,
        row_counts: {},
      },
    });
    const before = f.calls();
    await f.worker.once();
    const stopped = await f.overview.handle({action: 'get', id: next.id}, f.actor);
    assert.equal(f.calls(), before);
    assert.equal(stopped.state, 'failed');
    assert.match(JSON.stringify(stopped.sources), /REPORT_COLLECTION_LIMIT/);
  } finally {
    f.store.close();
  }
});
test('schedule preview reads no provider and resolves three independent delivery windows', async () => {
  const f = fixture();
  try {
    const out = await f.overview.handle(
      {
        action: 'preview_schedule',
        config: {...f.config, date_range: {preset: 'last_complete_days', days: 7, timezone: 'Asia/Riyadh'}},
        schedule: {schedule_kind: 'weekly', schedule_config: {weekday: 1, hour: 8}, timezone: 'Africa/Cairo'},
      },
      f.actor,
    );
    assert.equal(out.occurrences.length, 3);
    assert.equal(f.calls(), 0);
    assert.notEqual(out.occurrences[0].date_range.since, out.occurrences[1].date_range.since);
    assert.equal(out.occurrences[0].window_timezone, 'Asia/Riyadh');
  } finally {
    f.store.close();
  }
});

test('snapshot history reaches older than 200 records with exact paging and current access filtering', async () => {
  const f = fixture();
  try {
    const expected = [];
    for (let i = 0; i < 235; i++) {
      const id = 'snapshot-' + i;
      const allowed = i % 4 !== 0;
      if (allowed) expected.push(id);
      f.store.putDocument(f.actor.tenantId, 'overview_report', id, {
        created_at: 1000000 - i,
        state: 'complete',
        rows: [{metrics: {spend: 1}}],
        actor_binding: {private: true},
        checkpoints: {private: true},
        collection_budget: {row_counts: {period: 1}, active_since: 1, rows: 1},
        config: {...f.config, sources: [{...f.config.sources[0], account_id: allowed ? '100' : '200'}]},
      });
    }
    const found = [];
    let offset = 0;
    for (let page = 0; page < 10; page++) {
      const result = await f.overview.handle({action: 'list', offset, limit: 40}, f.actor);
      for (const r of result.reports) {
        assert.equal(r.rows, undefined);
        assert.equal(r.checkpoints, undefined);
        assert.equal(r.actor_binding, undefined);
        assert.equal(r.collection_budget.row_counts, undefined);
        assert.equal(r.row_count, 1);
        found.push(r.id);
      }
      if (!result.has_more) break;
      assert.ok(result.next_offset > offset);
      offset = result.next_offset;
    }
    assert.deepEqual(found, expected);
    assert.ok(found.includes('snapshot-234'));
    assert.equal(f.calls(), 0);
  } finally {
    f.store.close();
  }
});
