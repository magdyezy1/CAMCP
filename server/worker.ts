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
import {accountLifecycleSweeper} from './account-lifecycle.js';
// The same validated configuration as the HTTP server, with the worker's production preconditions, checked before
// the database opens (OPS-03); links in delivered e-mail use the same origin.
const config = loadConfig(process.env, 'worker');
const {service, store} = createRuntime(config);
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
let running = true,
  closed = false;
const close = () => {
  if (closed) return;
  closed = true;
  store.close();
};
// A long-running worker records the time-zone database its schedule clocks use. --once stays quiet.
if (!process.argv.includes('--once')) process.stdout.write(JSON.stringify(workerClockEvent()) + '\n');
// Hourly account lifecycle sweep (SEC-06 S6) in the schedule stage, after the report schedules.
const lifecycle = accountLifecycleSweeper(store, {tenantId: config.tenantId ?? 'local'});
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
