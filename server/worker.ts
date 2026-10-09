import {ReportingOverview} from '../src/reporting-overview.js';
import {WebStore} from './web-store.js';
import {UserAccounts} from './user-accounts.js';
import {runWorkerLoop} from '../src/worker-loop.js';
import {createRuntime} from './runtime.js';
import {ReportWorker} from '../src/worker.js';
import {createReportExecutor} from '../src/report-executor.js';
import {loadConfig} from './config.js';
// The same validated configuration as the HTTP server, with the worker's production preconditions, checked before
// the database opens (OPS-03); links in delivered e-mail use the same origin.
const config = loadConfig(process.env, 'worker');
const {service, store} = createRuntime(config);
const overview = new ReportingOverview(service),
  accounts = new UserAccounts(
    new WebStore(store, {origin: config.origin, masterKey: config.masterKey, tenantId: config.tenantId}),
  );
const worker = new ReportWorker(store, createReportExecutor(service), (t, k, i) => overview.work(t, k, i));
let running = true;
process.on('SIGTERM', () => {
  running = false;
});
process.on('SIGINT', () => {
  running = false;
});
try {
  await runWorkerLoop({
    schedule: () => overview.tick(),
    deliverEmails: () => accounts.deliverEmails(),
    work: () => worker.once(),
    shouldStop: () => !running,
    onceOnly: process.argv.includes('--once'),
    onFailure: entry => process.stderr.write(JSON.stringify(entry) + '\n'),
  });
} finally {
  store.close();
}
