import {ReportingOverview} from '../src/reporting-overview.js';
import {WebStore} from './web-store.js';
import {UserAccounts} from './user-accounts.js';
import {runWorkerLoop} from '../src/worker-loop.js';
import {createRuntime} from './runtime.js';
import {ReportWorker} from '../src/worker.js';
import {createReportExecutor} from '../src/report-executor.js';
const {service, store} = createRuntime();
const overview = new ReportingOverview(service),
  accounts = new UserAccounts(
    new WebStore(store, {
      origin:
        process.env.AMCP_PUBLIC_ORIGIN ??
        process.env.MIRROR_PUBLIC_ORIGIN ??
        (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'http://127.0.0.1:4317'),
      masterKey: process.env.MIRROR_MASTER_KEY,
      tenantId: process.env.AMCP_TENANT_ID,
    }),
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
