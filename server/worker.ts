import {ReportingOverview} from '../src/reporting-overview.js';
import {WebStore} from './web-store.js';
import {UserAccounts} from './user-accounts.js';
import {runWorkerLoop, stageFailureLog} from '../src/worker-loop.js';
import {gracefulShutdown, jsonLine, loopEventLog} from './shutdown.js';
import {createRuntime} from './runtime.js';
import {ReportWorker} from '../src/worker.js';
import {workerClockEvent} from '../src/scheduled-work.js';
import {createReportExecutor} from '../src/report-executor.js';
import {loadConfig} from './config.js';
import {startEventLoopMonitor} from '../src/runtime-metrics.js';
import {logRuntimeStart} from '../src/storage-health.js';
import {accountLifecycleSweeper} from './account-lifecycle.js';
// The same validated configuration as the HTTP server, with the worker's production preconditions, checked before
// the database opens (OPS-03); links in delivered e-mail use the same origin.
const config = loadConfig(process.env, 'worker');
const {service, store} = createRuntime(config);
// OPS-08: a long-running worker's event-loop delay (owner health shows the figures of the process that answers).
if (!process.argv.includes('--once')) startEventLoopMonitor();
const overview = new ReportingOverview(service),
  accounts = new UserAccounts(
    new WebStore(store, {
      origin: config.origin,
      masterKey: config.masterKey,
      previousMasterKeys: config.previousMasterKeys,
      tenantId: config.tenantId,
    }),
  );
const worker = new ReportWorker(store, createReportExecutor(service), (t, k, i) => overview.work(t, k, i));
worker.onRelease = (t, k, i) => overview.releaseJob(t, k, i);
// One metadata-only job_started and job_finished line per job (OPS-08).
worker.onJobEvent = jsonLine;
let running = true,
  closed = false;
const close = () => {
  if (closed) return;
  closed = true;
  store.close();
};
// A long-running worker records the time-zone database its schedule clocks use, and its runtime identity and schema
// bootstrap, including the website tables' steps (OPS-08). --once stays quiet.
if (!process.argv.includes('--once')) {
  process.stdout.write(JSON.stringify(workerClockEvent()) + '\n');
  void logRuntimeStart(store, {level: 'info', event: 'runtime_started', entry: 'worker'}, jsonLine);
}
// Hourly account lifecycle and retention sweep (SEC-06 S6, SEC-07) in the schedule stage, after the report schedules.
const lifecycle = accountLifecycleSweeper(store, {tenantId: config.tenantId ?? 'local', log: jsonLine});
const loop = runWorkerLoop({
  schedule: () => {
    overview.tick();
    lifecycle();
  },
  deliverEmails: () => accounts.deliverEmails(),
  work: () => worker.once(),
  shouldStop: () => !running,
  onceOnly: process.argv.includes('--once'),
  // The first failure of a stage at once, then at most one summary line per stage per minute (OPS-07).
  onFailure: stageFailureLog(jsonLine),
  onEvent: loopEventLog(jsonLine),
  storageProbe: () => store.probeWrite() === 'ok',
});
const stop = () => {
  if (!running) return;
  running = false;
  // Read-only jobs go back to the queue at once; a job that may be mid-mutation settles within the grace period.
  gracefulShutdown({
    graceMs: config.shutdownGraceMs,
    log: jsonLine,
    drain: () => worker.drain(),
    workerDone: loop,
    close,
    exit: code => process.exit(code),
  });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
try {
  await loop;
} finally {
  if (running) close();
}
