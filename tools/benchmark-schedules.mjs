import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Store} from '../dist/src/store.js';
import {dueSchedules, dueScheduleSQL, scheduleIndexSQL} from '../dist/src/scheduled-work.js';

// Fixed synthetic in-memory workload. No database path, credentials or production configuration inputs.
//   node tools/benchmark-schedules.mjs                       legacy vs indexed selection, 12 tenants x 1,000 per kind
//   node tools/benchmark-schedules.mjs --sweep [--tenants a,b] tenant-count sweep (OPS-08): 12 tenants with schedules
//                                                            and the rest empty, one full worker selection pass each
const stage = process.argv[2],
  tenants = 12,
  perKind = 1000,
  kinds = ['reporting_schedule', 'overview_schedule'];
const digest = value => createHash('sha256').update(value).digest('hex');
const sweepDefault = [12, 100, 1000, 10000],
  sweepActive = 12,
  sweepPerKind = 100;
if (stage === '--sweep') {
  const index = process.argv.indexOf('--tenants'),
    counts = index > 0 ? process.argv[index + 1].split(',').map(Number) : sweepDefault;
  if (!counts.length || counts.some(n => !Number.isInteger(n) || n < 1 || n > 100000))
    throw Error('--tenants takes comma-separated counts from 1 to 100000');
  const results = counts.map(count =>
    JSON.parse(
      execFileSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), 'sweep:' + count], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      }),
    ),
  );
  if (new Set(results.map(r => r.projection_sha256)).size !== 1)
    throw Error('The selected schedules differ between tenant counts');
  const largest = results.at(-1);
  console.log(
    JSON.stringify(
      {
        benchmark: 'due-schedule-tenant-sweep',
        synthetic: true,
        created_at: new Date().toISOString(),
        workload: {
          tenant_counts: counts,
          tenants_with_schedules: sweepActive,
          schedules_per_kind_per_active_tenant: sweepPerKind,
          kinds,
          iterations: 7,
          warmup: 2,
        },
        results,
        // The decision gate (OPS-08): the worker loop pauses one second between idle cycles, so a selection pass that
        // stays under 10% of that (100 ms) at the largest count is not material; above it, a global due query is due.
        decision: {
          threshold_p95_ms: 100,
          largest_tenant_count: largest.tenants,
          largest_p95_ms: largest.p95_ms,
          per_tenant_us: Math.round((largest.p50_ms / largest.tenants) * 1000 * 100) / 100,
          material: largest.p95_ms > 100,
        },
        provider_requests: 0,
        advertising_writes: 0,
        qualification:
          'Independent local processes and in-memory SQLite on this machine; one selection pass (both schedule kinds) over every tenant, as the worker runs each cycle. Not a deployed measurement.',
      },
      null,
      2,
    ),
  );
} else if (stage?.startsWith('sweep:')) {
  const count = Number(stage.slice(6));
  if (!Number.isInteger(count) || count < 1 || process.argv.length !== 3 || typeof global.gc !== 'function')
    throw Error('Run the sweep with --sweep');
  const store = new Store(':memory:', Buffer.alloc(32, 82).toString('base64')),
    at = Date.now();
  try {
    store.transaction(() => {
      for (let t = 0; t < count; t++) {
        const tenant = 'sweep-' + String(t).padStart(6, '0');
        store.ensureTenant(tenant);
        if (t < sweepActive)
          for (const kind of kinds)
            for (let i = 0; i < sweepPerKind; i++)
              store.putDocument(tenant, kind, 'schedule-' + String(i).padStart(4, '0'), {
                name: 'Synthetic ' + i,
                is_active: i % 3 !== 0,
                next_run_at: i < 8 ? at - 1 : at + 86400000,
                config: {padding: 'x'.repeat(512)},
              });
      }
    });
    const samples = [];
    let original, selected;
    for (let i = 0; i < 9; i++) {
      global.gc();
      const started = performance.now(),
        out = [];
      for (const tenant of store.listTenants())
        for (const kind of kinds)
          out.push(...dueSchedules(store, tenant, kind, at).map(schedule => ({tenant, kind, id: schedule.id})));
      const elapsed = performance.now() - started,
        raw = JSON.stringify(out);
      original ??= raw;
      if (original !== raw) throw Error('Selected schedules changed');
      selected = out.length;
      if (i >= 2) samples.push(elapsed);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        tenants: count,
        p50_ms: Math.round(sorted[3] * 1000) / 1000,
        p95_ms: Math.round(sorted[6] * 1000) / 1000,
        selected_schedules: selected,
        projection_sha256: digest(original),
        environment: {
          node: process.version,
          platform: process.platform,
          sqlite: store.db.prepare('SELECT sqlite_version() v').get().v,
        },
      }),
    );
  } finally {
    store.close();
  }
} else if (stage === undefined) {
  const stages = {};
  for (const name of ['legacy', 'indexed'])
    stages[name] = JSON.parse(
      execFileSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), name], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      }),
    );
  if (
    stages.legacy.projection_sha256 !== stages.indexed.projection_sha256 ||
    stages.legacy.module_sha256 !== stages.indexed.module_sha256
  )
    throw Error('Benchmark projections or builds differ');
  console.log(
    JSON.stringify(
      {
        benchmark: 'due-schedule-discovery',
        synthetic: true,
        created_at: new Date().toISOString(),
        workload: {tenants, schedules_per_kind_per_tenant: perKind, kinds, due: 120, iterations: 7, warmup: 2},
        stages,
        provider_requests: 0,
        advertising_writes: 0,
        qualification:
          'Independent local processes and in-memory SQLite; sampled RSS/heap, not continuous peaks. Measures schedule selection, not enqueue, native collection or deployed capacity. Every due schedule is still processed; no new scheduler fan-out bound.',
      },
      null,
      2,
    ),
  );
} else {
  if (!['legacy', 'indexed'].includes(stage) || process.argv.length !== 3 || typeof global.gc !== 'function')
    throw Error('Run this benchmark without arguments');
  const store = new Store(':memory:', Buffer.alloc(32, 82).toString('base64')),
    at = Date.now();
  try {
    store.transaction(() => {
      for (let t = 0; t < tenants; t++) {
        const tenant = 'scale-' + String(t).padStart(2, '0');
        store.ensureTenant(tenant);
        for (const kind of kinds)
          for (let i = 0; i < perKind; i++)
            store.putDocument(tenant, kind, 'schedule-' + String(i).padStart(4, '0'), {
              name: 'Synthetic ' + i,
              is_active: i % 3 !== 0,
              next_run_at: i < 8 ? at - 1 : at + 86400000,
              config: {
                native_id: String(9007199254740993n + BigInt(i)),
                price: '123456789.000001',
                padding: 'x'.repeat(2048),
              },
            });
      }
    });
    for (const kind of kinds) store.db.exec('DROP INDEX ' + kind + '_due');
    const indexStarted = performance.now();
    store.db.exec(scheduleIndexSQL);
    const indexBuildMs = performance.now() - indexStarted;
    const plans = Object.fromEntries(
      kinds.map(kind => [
        kind,
        store.db
          .prepare('EXPLAIN QUERY PLAN ' + dueScheduleSQL[kind])
          .all('scale-00', at)
          .map(r => r.detail),
      ]),
    );
    const indexBytes = Number(
      store.db
        .prepare(
          "SELECT coalesce(sum(pgsize),0) n FROM dbstat WHERE name IN ('reporting_schedule_due','overview_schedule_due')",
        )
        .get().n,
    );
    if (stage === 'legacy') for (const kind of kinds) store.db.exec('DROP INDEX ' + kind + '_due');
    let original,
      maxRss = 0,
      maxHeap = 0,
      count;
    const samples = [];
    for (let i = 0; i < 9; i++) {
      global.gc();
      const started = performance.now(),
        out = [];
      for (const tenant of store.listTenants())
        for (const kind of kinds) {
          const due =
            stage === 'legacy'
              ? store.documents(tenant, kind).filter(s => s.is_active && s.next_run_at <= at)
              : dueSchedules(store, tenant, kind, at);
          out.push(...due.map(schedule => ({tenant, kind, schedule})));
        }
      const elapsed = performance.now() - started,
        raw = JSON.stringify(
          out.map(row => ({...row, schedule: {...row.schedule, next_run_at: row.schedule.next_run_at - at}})),
        );
      count = out.length;
      original ??= raw;
      if (original !== raw) throw Error('Selected schedules changed');
      if (i >= 2) samples.push(elapsed);
      const memory = process.memoryUsage();
      maxRss = Math.max(maxRss, memory.rss);
      maxHeap = Math.max(maxHeap, memory.heapUsed);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        p50_ms: sorted[3],
        p95_ms: sorted[6],
        samples_ms: samples,
        max_sampled_rss_bytes: maxRss,
        max_sampled_heap_bytes: maxHeap,
        selected_schedules: count,
        projection_sha256: digest(original),
        index_bytes: indexBytes,
        index_build_ms: indexBuildMs,
        module_sha256: digest(readFileSync(new URL('../dist/src/scheduled-work.js', import.meta.url))),
        environment: {
          node: process.version,
          platform: process.platform,
          sqlite: store.db.prepare('SELECT sqlite_version() v').get().v,
        },
        ...(stage === 'indexed' ? {query_plans: plans} : {}),
      }),
    );
  } finally {
    store.close();
  }
}
