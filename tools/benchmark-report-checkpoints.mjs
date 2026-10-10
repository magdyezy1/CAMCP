#!/usr/bin/env node
// OPS-08: time of one Overview collection save against the rows a report already retains, for the earlier layout
// (re-read and rewrite the whole `overview_report`, rows and checkpoints inline) and the split layout (only the
// counters' or the period's own small document). Fixed synthetic in-memory workload: no database path, credentials,
// provider request or production configuration.
//   node tools/benchmark-report-checkpoints.mjs [--rows 0,5000,25000] [--saves 200]
import {Store} from '../dist/src/store.js';
import {ReportParts} from '../dist/src/report-checkpoints.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const counts = arg('--rows', '0,5000,25000').split(',').map(Number),
  saves = Number(arg('--saves', '200'));
if (counts.some(n => !Number.isInteger(n) || n < 0 || n > 100000) || !Number.isInteger(saves) || saves < 10)
  throw Error('--rows takes counts from 0 to 100000 and --saves at least 10');
const row = i => ({
  campaign_id: 'c' + i,
  entity_level: 'ad',
  metrics: {spend: i / 7, impressions: i * 3, clicks: i, conversions: i % 5},
});
const periodsOf = rows => {
  const periods = {};
  for (let day = 0, left = rows; left > 0; day++, left -= 500)
    periods[day] = {result: {rows: Array.from({length: Math.min(500, left)}, (_, i) => row(day * 500 + i))}};
  return periods;
};
const stats = samples => {
  const s = [...samples].sort((a, b) => a - b),
    at = q => Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] * 1000) / 1000;
  return {
    mean_ms: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 1000) / 1000,
    p50_ms: at(0.5),
    p95_ms: at(0.95),
    max_ms: at(1),
  };
};
const counters = rows => ({
  version: 1,
  definition: 'synthetic',
  requests: 0,
  rows,
  bytes: 0,
  elapsed_ms: 0,
  row_counts: Object.fromEntries(Array.from({length: Math.ceil(rows / 500)}, (_, d) => ['0:day-' + d, 500])),
});
const results = [];
for (const rows of counts) {
  const out = {retained_rows: rows};
  for (const layout of ['whole_document', 'split']) {
    const store = new Store(':memory:', Buffer.alloc(32, 83).toString('base64'));
    try {
      store.ensureTenant('bench');
      const periods = periodsOf(rows);
      store.putDocument('bench', 'overview_report', 'r', {
        state: 'running',
        config: {},
        rows: [],
        ...(layout === 'whole_document'
          ? {collection_budget: counters(rows), checkpoints: {0: {definition: 'grouped', periods}}}
          : {checkpoints: {}}),
      });
      const parts = new ReportParts(store, 'bench', {id: 'r'}),
        state = {definition: 'grouped', periods};
      if (layout === 'split') parts.save('0', state);
      const samples = [];
      for (let i = 0; i < saves; i++) {
        const started = performance.now();
        if (layout === 'whole_document') {
          // The earlier counter save: re-read the report, then rewrite it with the new counters.
          const current = store.document('bench', 'overview_report', 'r');
          store.putDocument('bench', 'overview_report', 'r', {
            ...current,
            collection_budget: {...counters(rows), requests: i},
          });
        } else parts.saveBudget({...counters(rows), requests: i});
        samples.push(performance.now() - started);
      }
      out[layout] = {
        ...stats(samples),
        bytes_per_save:
          layout === 'whole_document'
            ? Buffer.byteLength(store.db.prepare("SELECT data FROM documents WHERE kind='overview_report'").get().data)
            : Buffer.byteLength(
                store.db.prepare("SELECT data FROM documents WHERE kind='overview_report_budget'").get().data,
              ),
      };
    } finally {
      store.close();
    }
  }
  results.push(out);
}
const largest = results.at(-1);
console.log(
  JSON.stringify(
    {
      benchmark: 'report-checkpoint-save',
      synthetic: true,
      created_at: new Date().toISOString(),
      workload: {retained_rows: counts, saves_per_layout: saves, rows_per_period: 500},
      results,
      // The OPS-08 target: a save at 25,000 retained rows takes at most 5 ms and does not grow with the rows.
      target: {
        retained_rows: largest.retained_rows,
        split_p50_ms: largest.split.p50_ms,
        within_5_ms: largest.split.p50_ms <= 5,
      },
      environment: {node: process.version, platform: process.platform},
      provider_requests: 0,
      qualification:
        'In-memory SQLite on this machine, one process; counter saves only (period saves write one period document). Not a deployed measurement.',
    },
    null,
    2,
  ),
);
