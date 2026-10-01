import {ReportingOverview} from '../src/reporting-overview.js';
import {createRuntime} from './runtime.js';
import {createHttpApp, tuneListener} from './http-app.js';
import {ReportWorker} from '../src/worker.js';
import {createReportExecutor} from '../src/report-executor.js';
import {setTimeout as delay} from 'node:timers/promises';
const {service, store} = createRuntime();
const host = process.env.MIRROR_HOST ?? (process.env.PORT ? '0.0.0.0' : '127.0.0.1'),
  port = Number(process.env.PORT ?? process.env.MIRROR_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid MIRROR_PORT.');
const publicOrigin =
  process.env.AMCP_PUBLIC_ORIGIN ??
  process.env.MIRROR_PUBLIC_ORIGIN ??
  (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : undefined);
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.MIRROR_MASTER_KEY || !(process.env.AMCP_ADMIN_PASSWORD || process.env.AMCP_ADMIN_PASSWORD_HASH))
)
  throw Error('Production requires MIRROR_MASTER_KEY and an AMCP administrator password.');
const app = createHttpApp(service, store, {
  host,
  publicOrigin,
  website: {
    origin: publicOrigin ?? 'http://127.0.0.1:' + port,
    masterKey: process.env.MIRROR_MASTER_KEY,
    adminPassword: process.env.AMCP_ADMIN_PASSWORD,
    adminPasswordHash: process.env.AMCP_ADMIN_PASSWORD_HASH,
    testPassword: process.env.AMCP_TEST_PASSWORD,
    testPasswordHash: process.env.AMCP_TEST_PASSWORD_HASH,
    tenantId: process.env.AMCP_TENANT_ID,
    trustedProxyCidrs: process.env.AMCP_TRUSTED_PROXY_CIDRS?.split(/[ ,]+/).filter(Boolean),
  },
  mcpAllowedOrigins: process.env.AMCP_MCP_ALLOWED_ORIGINS?.split(/[ ,]+/).filter(Boolean),
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
  if (process.env.AMCP_RUN_WORKER === 'false') return;
  let consecutiveFailures = 0;
  while (!closing) {
    let stage = 'schedule';
    try {
      overview.tick();
      stage = 'email_delivery';
      await app.locals.website.accounts.deliverEmails();
      stage = 'job';
      const worked = await worker.once();
      consecutiveFailures = 0;
      if (worked) continue;
    } catch (error) {
      const code =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string' &&
        /^[A-Z_0-9]{1,80}$/.test(error.code)
          ? error.code
          : 'WORKER_STAGE_FAILED';
      process.stderr.write(
        JSON.stringify({
          event: 'worker_stage_failed',
          stage,
          code,
          consecutive_failures: ++consecutiveFailures,
          at: new Date().toISOString(),
        }) + '\n',
      );
    }
    await delay(1000);
  }
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
