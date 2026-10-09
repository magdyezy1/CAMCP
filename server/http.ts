import {ReportingOverview} from '../src/reporting-overview.js';
import {createRuntime} from './runtime.js';
import {createHttpApp, tuneListener} from './http-app.js';
import {ReportWorker} from '../src/worker.js';
import {createReportExecutor} from '../src/report-executor.js';
import {runWorkerLoop} from '../src/worker-loop.js';
import {loadConfig} from './config.js';
// Configuration and the production preconditions are validated before the database opens (OPS-03).
const config = loadConfig(process.env, 'http');
const {service, store} = createRuntime(config);
const {host, port, publicOrigin} = config;
const app = createHttpApp(service, store, {
  host,
  publicOrigin,
  production: config.production,
  website: {
    origin: config.origin,
    masterKey: config.masterKey,
    adminPassword: config.adminPassword,
    adminPasswordHash: config.adminPasswordHash,
    testPassword: config.testPassword,
    testPasswordHash: config.testPasswordHash,
    tenantId: config.tenantId,
    trustedProxyCidrs: config.trustedProxyCidrs && [...config.trustedProxyCidrs],
  },
  mcpAllowedOrigins: config.mcpAllowedOrigins && [...config.mcpAllowedOrigins],
  log: entry => (entry.level === 'error' ? process.stderr : process.stdout).write(JSON.stringify(entry) + '\n'),
});
const listener = app.listen(port, host, (error?: NodeJS.ErrnoException) => {
  if (error) {
    process.stderr.write(
      JSON.stringify({
        level: 'error',
        event: 'http_listen_failed',
        message: 'AMCP HTTP server could not listen.',
        code: error.code ?? 'LISTEN_FAILED',
        host,
        port,
      }) + '\n',
    );
    stop(1);
    return;
  }
  const address = listener.address();
  if (address && typeof address !== 'string')
    process.stdout.write(
      JSON.stringify({
        level: 'info',
        event: 'http_listening',
        message: 'AMCP HTTP server is listening.',
        host: address.address,
        port: address.port,
        public_origin: publicOrigin ?? null,
      }) + '\n',
    );
});
tuneListener(listener);
let closing = false;
const overview = new ReportingOverview(service);
const worker = new ReportWorker(store, createReportExecutor(service), (t, k, i) => overview.work(t, k, i));
const workerDone = (async () => {
  if (!config.runWorker) return;
  await runWorkerLoop({
    schedule: () => overview.tick(),
    deliverEmails: () => app.locals.website.accounts.deliverEmails(),
    work: () => worker.once(),
    shouldStop: () => closing,
    onFailure: entry => process.stderr.write(JSON.stringify(entry) + '\n'),
  });
})();
const stop = (exitCode = 0) => {
  if (closing) return;
  closing = true;
  listener.close(() => {
    void workerDone.then(() => {
      store.close();
      process.exit(exitCode);
    });
  });
  setTimeout(() => {
    listener.closeAllConnections();
    process.exit(1);
  }, 10000).unref();
};
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
