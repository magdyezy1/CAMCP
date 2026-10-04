// Actual ReportWorker and lease transactions against an owned disposable synthetic SQLite file.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {Store} from '../../dist/src/store.js';
import {ReportWorker} from '../../dist/src/worker.js';
const [database, indexText, delayText, mode = 'drain'] = process.argv.slice(2),
  index = Number(indexText),
  delayMs = Number(delayText);
if (
  !database ||
  !process.send ||
  !Number.isInteger(index) ||
  index < 0 ||
  index > 5 ||
  !Number.isInteger(delayMs) ||
  delayMs < 0 ||
  delayMs > 30 ||
  !['drain', 'once'].includes(mode) ||
  process.argv.length > 6
)
  throw Error('Invalid synthetic worker arguments');
const parent = fs.realpathSync(path.dirname(database)),
  temp = fs.realpathSync(os.tmpdir());
if (
  path.dirname(parent) !== temp ||
  !path.basename(parent).startsWith('amcp-worker-benchmark-') ||
  path.basename(database) !== 'fixture.sqlite'
)
  throw Error('Worker requires its owned synthetic temporary database');
const store = new Store(database, Buffer.alloc(32, 83).toString('base64'));
try {
  const lease = store.leaseJob.bind(store),
    claims = [],
    executed = [];
  store.leaseJob = ms => {
    const started = performance.now();
    const result = store.transaction(() => {
      const job = lease(ms);
      if (job) {
        const ordinal = JSON.parse(
          store.db
            .prepare(
              "SELECT data FROM documents WHERE tenant_id='__service_limits__' AND kind='queue_cursor' AND id='dispatch'",
            )
            .get().data,
        ).ordinal;
        store.db
          .prepare('INSERT INTO benchmark_dispatch(ordinal,job_id,tenant_id,worker) VALUES(?,?,?,?)')
          .run(ordinal, job.id, job.tenant_id, index);
      }
      return job;
    });
    claims.push(performance.now() - started);
    return result;
  };
  const worker = new ReportWorker(store, async (tenant, config, actor) => {
    if (tenant !== config.synthetic_tenant || actor?.tenantId !== tenant || !/^\d+$/.test(config.synthetic_native_id))
      throw Error('Synthetic worker crossed original scope');
    store.assertActorActive(actor);
    if (config.synthetic_barrier) {
      const release = new Promise(resolve =>
        process.once('message', message => {
          if (message !== 'release') throw Error('Invalid authority barrier');
          resolve();
        }),
      );
      process.send({state: 'held', tenant});
      await release;
    }
    if (delayMs) await delay(delayMs);
    store.assertActorActive(actor);
    executed.push({tenant, sequence: config.synthetic_sequence});
    return {tenant_id: tenant, sequence: config.synthetic_sequence, native_id: config.synthetic_native_id};
  });
  const start = new Promise(resolve =>
    process.once('message', message => {
      if (message !== 'start') throw Error('Invalid benchmark barrier');
      resolve();
    }),
  );
  process.send({state: 'ready', index});
  await start;
  const started = performance.now();
  if (mode === 'once') await worker.once();
  else
    for (let iterations = 0; await worker.once(); iterations++)
      if (iterations > 2000) throw Error('Synthetic worker exceeded iteration bound');
  process.send({
    state: 'done',
    index,
    elapsed_ms: performance.now() - started,
    claims_ms: claims,
    executed,
    sampled_rss_bytes: process.memoryUsage().rss,
    provider_requests: 0,
    advertising_writes: 0,
  });
} finally {
  store.close();
  process.disconnect();
}
