import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Store} from '../dist/src/store.js';
import {evidenceIndex, evidenceIndexSQL} from '../dist/src/evidence-index.js';

// Disposable in-memory records only. No database/file/account input, provider transport or deployed settings.
const mode = process.argv[2],
  reportCount = 120,
  rowCount = 1000,
  iterations = 6,
  limit = 30;
const digest = value => createHash('sha256').update(value).digest('hex');
const core = r =>
  Object.fromEntries(
    [
      'id',
      'revision',
      'gateway',
      'account_id',
      'connection_id',
      'preset',
      'grain',
      'source',
      'source_hash',
      'captured_at',
      'row_count',
      'semantics',
    ].map(k => [k, r[k]]),
  );
if (mode === undefined) {
  const script = fileURLToPath(import.meta.url),
    stages = {};
  for (const stage of ['legacy', 'bounded'])
    stages[stage] = JSON.parse(
      execFileSync(process.execPath, ['--expose-gc', script, stage], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      }),
    );
  if (stages.legacy.projection_sha256 !== stages.bounded.projection_sha256)
    throw Error('Authorized first-page projections differ.');
  if (stages.legacy.module_sha256 !== stages.bounded.module_sha256)
    throw Error('Benchmark stages used different builds.');
  console.log(
    JSON.stringify(
      {
        benchmark: 'saved-evidence-discovery',
        created_at: new Date().toISOString(),
        synthetic: true,
        workload: {
          tenants: 2,
          reports_per_tenant: reportCount,
          rows_per_report: rowCount,
          iterations,
          warmup_per_stage: 2,
          requested_limit: limit,
        },
        stages,
        provider_requests: 0,
        identical_authorized_projection_sha256: stages.bounded.projection_sha256,
        qualification:
          'Separate local synthetic processes and in-memory SQLite. Sampled heap/RSS, not continuous peak memory; forced GC outside timed calls. No production, concurrent-user, provider or deployed-capacity claim.',
      },
      null,
      2,
    ),
  );
} else {
  if (!['legacy', 'bounded'].includes(mode) || process.argv.length !== 3)
    throw Error('Use this benchmark without arguments.');
  if (typeof global.gc !== 'function') throw Error('Internal benchmark stages require --expose-gc.');
  const actor = {tenantId: 'synthetic-scale-a', userId: 'operator', role: 'operator'},
    store = new Store(':memory:', Buffer.alloc(32, 123).toString('base64'));
  let maxHeap = 0,
    maxRss = 0;
  const sample = () => {
    const m = process.memoryUsage();
    maxHeap = Math.max(maxHeap, m.heapUsed);
    maxRss = Math.max(maxRss, m.rss);
  };
  try {
    store.transaction(() => {
      for (const tenantId of [actor.tenantId, 'synthetic-scale-b']) {
        store.putConnection(
          {...actor, tenantId, role: 'admin'},
          {
            id: 'synthetic',
            tenantId,
            gateway: 'meta_native_action',
            accounts: ['100'],
            enabled: true,
            label: 'Synthetic',
            scopes: [],
          },
          {accessToken: 'synthetic'},
        );
        const rows = Array.from({length: rowCount}, (_, i) => ({
          entity_id: String(9007199254740993n + BigInt(i)),
          date: '2026-09-01',
          spend: '10.000001',
          impressions: '100',
          clicks: '1',
          conversions: '0',
          conversion_value: null,
          reach: null,
          frequency: null,
        }));
        for (let i = 0; i < reportCount; i++)
          store.putDocument(tenantId, 'decision_report', 'report-' + String(i).padStart(4, '0'), {
            gateway: 'meta_native_action',
            account_id: '100',
            connection_id: 'synthetic',
            preset: 'meta_campaign',
            grain: 'campaign × day',
            source: 'provider_read',
            source_hash: 'a'.repeat(64),
            captured_at: 1790900000000,
            semantics: {
              source_name: 'Synthetic report ' + i,
              currency: 'USD',
              timezone: 'UTC',
              date_from: '2026-09-01',
              date_to: '2026-09-02',
              attribution: 'declared',
              conversion_definition: 'purchase',
              complete: true,
            },
            rows,
            source_request: {synthetic: true, account_id: '100'},
            source_pages: [{page: 1, row_count: rowCount, source_hash: 'b'.repeat(64), captured_at: 1790900000000}],
          });
      }
    });
    const original = store.documents.bind(store);
    store.documents = (...args) => {
      const rows = original(...args);
      sample();
      return rows;
    };
    const legacy = () => ({
      reports: store
        .documents(actor.tenantId, 'decision_report')
        .filter(d => {
          store.resolveConnection(actor, d.gateway, d.account_id, d.connection_id);
          return true;
        })
        .map(({rows, ...d}) => ({...d, row_count: rows.length})),
    });
    const run = () => (mode === 'legacy' ? legacy() : evidenceIndex(store, actor, {limit}));
    for (let i = 0; i < 2; i++) run();
    global.gc();
    maxHeap = 0;
    maxRss = 0;
    sample();
    const startMemory = process.memoryUsage(),
      samples = [];
    let output;
    for (let i = 0; i < iterations; i++) {
      global.gc();
      const start = performance.now();
      output = run();
      samples.push(performance.now() - start);
      sample();
    }
    const sorted = [...samples].sort((a, b) => a - b),
      projection = output.reports.slice(0, limit).map(core),
      stableProjection = JSON.stringify(
        projection.map(r => ({
          ...r,
          semantics: Object.fromEntries(Object.entries(r.semantics).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
        })),
      );
    if (projection.length !== limit || projection.some(r => r.account_id !== '100' || r.row_count !== rowCount))
      throw Error('Unexpected authorized projection.');
    const plan = store.db
      .prepare('EXPLAIN QUERY PLAN ' + evidenceIndexSQL)
      .all(actor.tenantId, '', null, null, null, null, null, null, limit + 1)
      .map(r => r.detail);
    console.log(
      JSON.stringify({
        mode,
        environment: {
          node: process.version,
          platform: process.platform,
          sqlite: store.db.prepare('SELECT sqlite_version() AS v').get().v,
          storage: 'memory',
        },
        module_sha256: digest(readFileSync(new URL('../dist/src/evidence-index.js', import.meta.url))),
        p50_ms: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
        p95_ms: sorted.at(-1),
        samples_ms: samples,
        start_heap_bytes: startMemory.heapUsed,
        max_sampled_heap_bytes: maxHeap,
        start_rss_bytes: startMemory.rss,
        max_sampled_rss_bytes: maxRss,
        returned_reports: output.reports.length,
        structured_response_bytes: Buffer.byteLength(JSON.stringify(output)),
        projection_sha256: digest(stableProjection),
        query_plan: plan,
        provider_requests: 0,
      }),
    );
  } finally {
    store.close();
  }
}
