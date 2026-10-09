import {ReportingOverview} from '../src/reporting-overview.js';
import {createRuntime} from './runtime.js';
import {createHttpApp, tuneListener} from './http-app.js';
import {ReportWorker} from '../src/worker.js';
import {createReportExecutor} from '../src/report-executor.js';
import {runWorkerLoop, stageFailureLog} from '../src/worker-loop.js';
import {gracefulShutdown, jsonLine, loopEventLog} from './shutdown.js';
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
worker.onRelease = (t, k, i) => overview.releaseJob(t, k, i);
const workerDone = (async () => {
  if (!config.runWorker) return;
  await runWorkerLoop({
    schedule: () => overview.tick(),
    deliverEmails: () => app.locals.website.accounts.deliverEmails(),
    work: () => worker.once(),
    shouldStop: () => closing,
    // The first failure of a stage at once, then at most one summary line per stage per minute (OPS-07).
    onFailure: stageFailureLog(jsonLine),
    onEvent: loopEventLog(jsonLine),
    storageProbe: () => store.probeWrite() === 'ok',
  });
})();
const stop = (exitCode = 0) => {
  if (closing) return;
  closing = true;
  // Read-only jobs go back to the queue at once; a job that may be mid-mutation settles within the grace period.
  gracefulShutdown({
    graceMs: config.shutdownGraceMs,
    log: jsonLine,
    drain: () => worker.drain(),
    workerDone,
    others: [new Promise<void>(resolve => listener.close(() => resolve()))],
    close: () => store.close(),
    exit: code => {
      listener.closeAllConnections();
      process.exit(code);
    },
    exitCode,
  });
};
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
