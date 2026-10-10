// OPS-08 small checkpoint documents: an Overview report's collection counters and per-source (and per-period)
// checkpoints are saved in their own documents, so a counter or checkpoint save no longer rewrites the whole report.
// Each test below would fail on the earlier layout, where every save re-read and rewrote `overview_report` with every
// collected row inline. Synthetic store and a fake fetcher only; no provider request or real credential is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';
import {ReportCollectionBudget} from '../dist/src/report-collection-budget.js';
import {
  REPORT_BUDGET_KIND,
  REPORT_CHECKPOINT_KIND,
  ReportParts,
  reportBudgetState,
  splitLayout,
} from '../dist/src/report-checkpoints.js';
import {fingerprint} from '../dist/src/report-quality.js';

const key = Buffer.alloc(32, 58).toString('base64');
function fixture({failDay} = {}) {
  const actor = {tenantId: 'checkpoints', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', key),
    source = {platform: 'meta', account_id: '100', connection_id: 'split-meta'};
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
  const requests = [];
  let failing = failDay;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async raw => {
        const url = decodeURIComponent(String(raw));
        requests.push(url);
        if (!url.includes('/insights')) return Response.json({id: 'act_100', currency: 'USD', timezone_name: 'UTC'});
        // Daily periods: each request names one day as its since and until.
        if (failing && url.includes(failing))
          return Response.json({error: {message: 'Synthetic outage', code: 2}}, {status: 503});
        return Response.json({
          data: [{campaign_id: 'c1', campaign_name: 'Synthetic', spend: '1.5', impressions: '10'}],
        });
      },
      async () => {},
    ),
  );
  const overview = new ReportingOverview(service),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (t, k, i) => overview.work(t, k, i),
    ),
    config = {
      name: 'Split checkpoints',
      sources: [source],
      date_range: {since: '2026-09-01', until: '2026-09-04'},
      metrics: ['spend'],
      custom_metrics: [],
      grain: 'daily',
    };
  return {
    actor,
    store,
    overview,
    worker,
    config,
    requests,
    insights: () => requests.filter(u => u.includes('/insights')),
    recover: () => (failing = undefined),
    // Makes a retried job available now instead of after its back-off.
    due: () => store.db.prepare("UPDATE jobs SET available_at=0 WHERE state='queued'").run(),
  };
}
const parts = (store, tenant, id) =>
  store.db
    .prepare('SELECT kind,id FROM documents WHERE tenant_id=? AND kind IN (?,?) AND (id=? OR id LIKE ?) ORDER BY id')
    .all(tenant, REPORT_BUDGET_KIND, REPORT_CHECKPOINT_KIND, id, id + ':%')
    .map(row => row.kind + ' ' + row.id.slice(id.length));

test('counters and checkpoints are saved in their own documents; the report is not rewritten on every save', async () => {
  const f = fixture();
  try {
    // Every write of the report document is counted (the earlier layout wrote it on every counter save).
    let reportWrites = 0;
    const put = f.store.putDocument.bind(f.store);
    f.store.putDocument = (tenant, kind, id, data, revision) => {
      if (kind === 'overview_report') reportWrites++;
      return put(tenant, kind, id, data, revision);
    };
    const queued = await f.overview.handle({action: 'run', config: f.config, confirmed: true}, f.actor);
    const before = reportWrites;
    assert.equal(await f.worker.once(), true);
    const report = await f.overview.handle({action: 'get', id: queued.id}, f.actor);
    assert.equal(report.state, 'complete');
    assert.equal(report.row_count, 4);
    // The usage is read from the budget document: one request per account read and per day.
    assert.equal(report.collection_budget.requests, f.requests.length);
    assert.ok(report.collection_budget.requests >= 5);
    assert.equal(report.collection_budget.row_counts, undefined, 'usage only, as before');
    const stored = f.store.document(f.actor.tenantId, 'overview_report', queued.id);
    assert.ok(splitLayout(stored), 'the report carries only the split marker');
    assert.deepEqual(Object.keys(stored.collection_budget).sort(), ['definition', 'layout', 'version']);
    assert.deepEqual(stored.checkpoints, {});
    // Running, the one-time marker and the finished snapshot: independent of the number of requests and periods.
    assert.ok(reportWrites - before <= 3, 'report writes during collection: ' + (reportWrites - before));
    // The completed source keeps one result document; its period documents were dropped in the same transaction.
    assert.deepEqual(parts(f.store, f.actor.tenantId, queued.id), [
      REPORT_BUDGET_KIND + ' ',
      REPORT_CHECKPOINT_KIND + ' :0',
    ]);
    const list = await f.overview.handle({action: 'list', limit: 10}, f.actor);
    assert.equal(list.reports[0].collection_budget.requests, f.requests.length, 'the list reads the same counters');
  } finally {
    f.store.close();
  }
});

test('a retried run resumes from its split checkpoints: completed days are not read again and counters continue', async () => {
  const f = fixture({failDay: '2026-09-03'});
  try {
    const queued = await f.overview.handle({action: 'run', config: f.config, confirmed: true}, f.actor);
    await f.worker.once();
    const job = f.store.db.prepare('SELECT state,error FROM jobs').get();
    assert.equal(job.state, 'queued', 'a retryable provider outage schedules a retry');
    const first = f.insights().filter(u => !u.includes('2026-09-03')).length;
    assert.ok(first >= 2);
    // Days 1 and 2 are saved as their own period documents.
    assert.deepEqual(
      parts(f.store, f.actor.tenantId, queued.id).filter(p => p.includes(':0:')),
      [REPORT_CHECKPOINT_KIND + ' :0:0', REPORT_CHECKPOINT_KIND + ' :0:1'],
    );
    const counted = reportBudgetState(
      f.store,
      f.actor.tenantId,
      f.store.document(f.actor.tenantId, 'overview_report', queued.id),
    );
    f.recover();
    f.due();
    const before = f.requests.length;
    await f.worker.once();
    const report = await f.overview.handle({action: 'get', id: queued.id}, f.actor);
    assert.equal(report.state, 'complete');
    assert.equal(report.row_count, 4);
    const resumed = f.requests.slice(before).filter(u => u.includes('/insights'));
    assert.ok(
      resumed.every(u => !u.includes('2026-09-01') && !u.includes('2026-09-02')),
      'completed days are never read again',
    );
    assert.ok(report.collection_budget.requests >= counted.requests + resumed.length, 'counters never restart');
  } finally {
    f.store.close();
  }
});

test('a report started by an older release resumes from its inline counters and checkpoints (legacy layout)', async () => {
  const f = fixture({failDay: '2026-09-03'});
  try {
    const queued = await f.overview.handle({action: 'run', config: f.config, confirmed: true}, f.actor);
    await f.worker.once();
    // Rewrite the interrupted run into the earlier inline layout: version 1 counters and source checkpoints with their
    // periods inside the report, and no split documents.
    const tenant = f.actor.tenantId,
      report = f.store.document(tenant, 'overview_report', queued.id),
      budget = reportBudgetState(f.store, tenant, report),
      head = f.store.document(tenant, REPORT_CHECKPOINT_KIND, queued.id + ':0'),
      periods = Object.fromEntries(
        f.store
          .documents(tenant, REPORT_CHECKPOINT_KIND)
          .filter(d => d.id.startsWith(queued.id + ':0:'))
          .map(d => [d.id.slice(queued.id.length + 3), d.period]),
      ),
      {id: _id, revision: _revision, report_id: _report, ...legacyBudget} = budget;
    assert.equal(Object.keys(periods).length, 2);
    f.store.db
      .prepare('DELETE FROM documents WHERE tenant_id=? AND kind IN (?,?)')
      .run(tenant, REPORT_BUDGET_KIND, REPORT_CHECKPOINT_KIND);
    const {id: _rid, revision: _rrev, ...data} = report;
    f.store.putDocument(tenant, 'overview_report', queued.id, {
      ...data,
      collection_budget: legacyBudget,
      checkpoints: {0: {definition: head.definition, periods}},
    });
    f.recover();
    f.due();
    const before = f.requests.length;
    await f.worker.once();
    const done = await f.overview.handle({action: 'get', id: queued.id}, f.actor);
    assert.equal(done.state, 'complete');
    assert.equal(done.row_count, 4);
    const resumed = f.requests.slice(before).filter(u => u.includes('/insights'));
    assert.ok(resumed.length >= 1 && resumed.length <= 2, 'only the two unread days: ' + resumed.length);
    assert.ok(resumed.every(u => !u.includes('2026-09-01') && !u.includes('2026-09-02')));
    assert.ok(done.collection_budget.requests >= legacyBudget.requests + resumed.length, 'inline counters continue');
    assert.ok(splitLayout(f.store.document(tenant, 'overview_report', queued.id)), 'later saves use the split layout');
  } finally {
    f.store.close();
  }
});

test('rollback gate: an older release refuses a split report instead of collecting again with counters it cannot see', () => {
  const store = new Store(':memory:', key);
  try {
    store.ensureTenant('t');
    const config = {name: 'Gate', sources: []},
      definition = fingerprint(config);
    store.putDocument('t', 'overview_report', 'r1', {state: 'running', config, checkpoints: {}});
    const split = new ReportParts(store, 't', store.document('t', 'overview_report', 'r1'));
    new ReportCollectionBudget(undefined, definition, state => split.saveBudget(state)).close();
    const report = store.document('t', 'overview_report', 'r1');
    assert.deepEqual(report.collection_budget, {version: 2, layout: 'split', definition});
    // The older release passed the inline field straight to the budget, which accepts version 1 only.
    assert.throws(
      () => new ReportCollectionBudget(report.collection_budget, definition, () => {}),
      e => e.code === 'REPORT_DEFINITION_CHANGED',
    );
    // A split marker whose counters are missing is refused, never restarted from zero (counters precede egress).
    store.deleteDocument('t', REPORT_BUDGET_KIND, 'r1');
    assert.throws(
      () => reportBudgetState(store, 't', report),
      e => e.code === 'REPORT_BUDGET_INVALID',
    );
  } finally {
    store.close();
  }
});

test('deleting a report removes its budget and checkpoint documents and nothing of another report', () => {
  const store = new Store(':memory:', key);
  try {
    store.ensureTenant('t');
    for (const id of ['r1', 'r10']) {
      store.putDocument('t', 'overview_report', id, {state: 'running', config: {}});
      const p = new ReportParts(store, 't', {id});
      p.saveBudget({version: 1, definition: 'd', requests: 1});
      p.save('0', {definition: 'periods', periods: {0: {result: {rows: []}}, 1: {native: {report_id: 'x'}}}});
      p.complete('1', {rows: []});
    }
    assert.equal(parts(store, 't', 'r1').length, 5);
    store.deleteDocument('t', 'overview_report', 'r1');
    assert.deepEqual(parts(store, 't', 'r1'), []);
    assert.equal(parts(store, 't', 'r10').length, 5, 'a report whose ID shares the prefix keeps its documents');
    // Retention and disconnect delete reports with their own statements; the trigger covers every DELETE.
    store.db.prepare("DELETE FROM documents WHERE tenant_id='t' AND kind='overview_report'").run();
    assert.deepEqual(parts(store, 't', 'r10'), []);
  } finally {
    store.close();
  }
});

test('per-save writes stay small and fast with 25,000 retained rows (the earlier layout rewrote all of them)', () => {
  const store = new Store(':memory:', key);
  try {
    store.ensureTenant('t');
    store.putDocument('t', 'overview_report', 'big', {state: 'running', config: {}, checkpoints: {}});
    const p = new ReportParts(store, 't', {id: 'big'}),
      row = i => ({campaign_id: 'c' + i, entity_level: 'ad', metrics: {spend: i / 7, impressions: i * 3, clicks: i}}),
      periods = {};
    // 50 completed days of 500 rows each: 25,000 retained rows (about 4 MB of JSON).
    for (let day = 0; day < 50; day++)
      periods[day] = {result: {rows: Array.from({length: 500}, (_, i) => row(day * 500 + i)), complete: true}};
    const state = {definition: 'grouped', periods};
    p.save('0', state);
    let written = 0;
    const put = store.putDocument.bind(store);
    store.putDocument = (tenant, kind, id, data, revision) => {
      written = Math.max(written, JSON.stringify(data).length);
      return put(tenant, kind, id, data, revision);
    };
    const budget = {version: 1, definition: 'd', requests: 0, rows: 25000, bytes: 0, elapsed_ms: 0, row_counts: {}};
    for (let day = 0; day < 50; day++) budget.row_counts['0:2026-01-' + day] = 500;
    const samples = [];
    for (let i = 0; i < 40; i++) {
      const started = performance.now();
      if (i % 2) p.saveBudget({...budget, requests: i});
      else {
        // A native checkpoint of the next, unfinished day: only that period's document is written.
        state.periods = {...state.periods, 50: {native: {report_id: 'job-' + i}}};
        p.save('0', state);
      }
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    assert.ok(written < 4096, 'largest document written by a save: ' + written + ' bytes');
    // The design target is at most 5 ms on the review workstation (see tools/benchmark-report-checkpoints.mjs); this
    // bound leaves room for a loaded test machine yet fails a whole-report rewrite (77 ms mean at 25,000 rows).
    assert.ok(samples[20] < 20, 'median save ' + samples[20].toFixed(3) + ' ms');
    assert.equal(store.document('t', 'overview_report', 'big').revision, 2, 'the report itself is written once');
  } finally {
    store.close();
  }
});
