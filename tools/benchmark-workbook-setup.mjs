import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {Store} from '../dist/src/store.js';
import {workbookBindingPage} from '../dist/src/workbook-bindings.js';

// Always synthetic and in memory. Never accepts a database path or reads deployed configuration.
const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64'));
const actor = {tenantId: 'scale-a', userId: 'operator', role: 'operator'};
const bindingsPerTenant = 250,
  queriesPerBinding = 20,
  iterations = 12;
try {
  store.transaction(() => {
    for (const tenantId of ['scale-a', 'scale-b']) {
      store.putConnection(
        {...actor, tenantId, role: 'admin'},
        {
          id: 'meta',
          tenantId,
          gateway: 'meta_native_action',
          accounts: ['100'],
          enabled: true,
          label: 'Synthetic',
          scopes: [],
        },
        {accessToken: 'synthetic'},
      );
      for (let b = 0; b < bindingsPerTenant; b++) {
        const id = 'b-' + String(b).padStart(4, '0');
        store.putDocument(tenantId, 'workbook', id, {
          spreadsheet_id: 'synthetic-' + id,
          spreadsheet_name: 'Workbook ' + b,
          created_by: actor.userId,
        });
        for (let q = 0; q < queriesPerBinding; q++)
          store.putDocument(tenantId, 'reporting_query', id + '-' + String(q).padStart(3, '0'), {
            name: 'Synthetic ' + q,
            workbook_binding_id: id,
            query_config: {
              platform: 'meta',
              connection_id: 'meta',
              account_id: '100',
              date_range: {since: '2026-09-01', until: '2026-09-07'},
            },
          });
      }
    }
  });
  const index = store.db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='reporting_query_workbook'")
    .get();
  if (!index?.sql) throw Error('Build the current implementation before running this benchmark.');
  const query =
    "SELECT q.id FROM documents q WHERE q.tenant_id=? AND q.kind='reporting_query' AND json_extract(q.data,'$.workbook_binding_id')=? ORDER BY q.id LIMIT 501";
  const plan = () =>
    store.db
      .prepare('EXPLAIN QUERY PLAN ' + query)
      .all(actor.tenantId, 'b-0000')
      .map(p => p.detail);
  let original;
  const run = () => {
    for (let i = 0; i < 3; i++) workbookBindingPage(store, actor, {limit: 20});
    const samples = [];
    let maxSampledRss = 0,
      output;
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      output = JSON.stringify(workbookBindingPage(store, actor, {limit: 20}));
      samples.push(performance.now() - start);
      maxSampledRss = Math.max(maxSampledRss, process.memoryUsage().rss);
      original ??= output;
      if (original !== output) throw Error('The index changed the authorized workbook projection.');
    }
    const sorted = [...samples].sort((a, b) => a - b);
    return {
      p50_ms: sorted[Math.floor(sorted.length * 0.5)],
      p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      samples_ms: samples,
      max_sampled_rss_bytes: maxSampledRss,
      structured_response_bytes: Buffer.byteLength(output),
    };
  };
  store.db.exec('DROP INDEX reporting_query_workbook');
  const beforePlan = plan(),
    before = run();
  const start = performance.now();
  store.db.exec(index.sql);
  const buildMs = performance.now() - start;
  const afterPlan = plan(),
    after = run();
  const indexPages = store.db
    .prepare("SELECT sum(pgsize) AS bytes FROM dbstat WHERE name='reporting_query_workbook'")
    .get();
  console.log(
    JSON.stringify(
      {
        benchmark: 'workbook-association-lookup',
        created_at: new Date().toISOString(),
        synthetic: true,
        environment: {
          node: process.version,
          platform: process.platform,
          sqlite: store.db.prepare('SELECT sqlite_version() AS version').get().version,
          storage: 'memory',
        },
        workload: {
          tenants: 2,
          bindings_per_tenant: bindingsPerTenant,
          queries_per_binding: queriesPerBinding,
          iterations,
          warmup_per_stage: 3,
          returned_bindings: 20,
        },
        before_plan: beforePlan,
        after_plan: afterPlan,
        before,
        after,
        index_build_ms: buildMs,
        index_bytes: indexPages.bytes,
        identical_projection_sha256: createHash('sha256').update(original).digest('hex'),
        provider_requests: 0,
        qualification:
          'One local synthetic process. Not production latency, a concurrent-user test, or continuous peak-memory measurement. Baseline removes only this index from the disposable in-memory fixture.',
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
}
