import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {Store} from '../../dist/src/store.js';
import {operationsWorkerHealth} from '../../dist/src/operations-worker-health.js';
const [mode, countText, bodyText] = process.argv.slice(2),
  count = Number(countText),
  bodyBytes = Number(bodyText),
  iterations = 25;
assert.ok(['legacy', 'bounded'].includes(mode));
assert.ok([4, 1000].includes(count));
assert.ok([0, 4096].includes(bodyBytes));
const store = new Store(':memory:', Buffer.alloc(32, 101).toString('base64')),
  now = Date.UTC(2026, 9, 6, 1);
try {
  store.transaction(() => {
    for (let n = 0; n < count; n++)
      store.putDocument('__service_limits__', 'worker_heartbeat', String(n).padStart(4, '0'), {
        at: now - n,
        state: n % 2 ? 'idle' : 'working',
        ...(bodyBytes ? {unselected_body: 'SYNTHETIC-PRIVATE-'.repeat(Math.ceil(bodyBytes / 18))} : {}),
      });
  });
  const original = () => {
      const workers = store
        .documents('__service_limits__', 'worker_heartbeat')
        .map(w => ({state: w.state, age_ms: Math.max(0, now - w.at), stale: now - w.at > 90000}));
      return {
        status: !workers.length ? 'not_observed' : workers.every(w => w.stale) ? 'stale' : 'active',
        observations: workers,
      };
    },
    read = mode === 'legacy' ? original : () => operationsWorkerHealth(store, now),
    samples = [],
    initial = process.memoryUsage();
  let out;
  for (let n = 0; n < iterations; n++) {
    const start = performance.now();
    out = read();
    samples.push(performance.now() - start);
  }
  const bytes = Buffer.byteLength(JSON.stringify(out)),
    after = process.memoryUsage();
  assert.doesNotMatch(JSON.stringify(out), /SYNTHETIC-PRIVATE|unselected_body/);
  if (mode === 'bounded') {
    assert.equal(out.total_heartbeat_records, count);
    assert.equal(out.observations.length, bodyBytes ? 0 : Math.min(100, count));
    assert.equal(out.unavailable_records, bodyBytes ? count : 0);
    assert.equal(out.has_more, !bodyBytes && count > 100);
    assert.equal(out.status, bodyBytes ? 'unavailable' : 'active');
    assert.ok(bytes < 8192);
  } else {
    assert.equal(out.status, 'active');
    assert.equal(out.observations.length, count);
  }
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      mode,
      stored_heartbeat_records: count,
      unselected_body_bytes_per_record: bodyBytes,
      iterations,
      median_read_ms: samples[Math.floor(samples.length / 2)],
      maximum_read_ms: samples.at(-1),
      result_bytes: bytes,
      observations: out.observations.length,
      status: out.status,
      unavailable_records: out.unavailable_records ?? null,
      heap_delta_bytes: after.heapUsed - initial.heapUsed,
      rss_delta_bytes: after.rss - initial.rss,
      max_rss_kib: process.resourceUsage().maxRSS,
      platform: process.platform,
      node: process.version,
      external_requests: 0,
      mutations_of_provider_accounts: 0,
    }),
  );
} finally {
  store.close();
}
