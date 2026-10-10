import {ReportingOverview} from '../src/reporting-overview.js';
import {createRuntime} from './runtime.js';
import {createHttpApp, tuneListener} from './http-app.js';
import {mcpLimits as validMcpLimits, mcpLimitsFromEnv} from './mcp-limits.js';
import {ReportWorker} from '../src/worker.js';
import {workerClockEvent} from '../src/scheduled-work.js';
import {createReportExecutor} from '../src/report-executor.js';
import {runWorkerLoop, stageFailureLog} from '../src/worker-loop.js';
import {gracefulShutdown, jsonLine, loopEventLog} from './shutdown.js';
import {loadConfig} from './config.js';
import {runtimeIdentity, startFfmpegVersionProbe} from '../src/storage-health.js';
import {startEventLoopMonitor} from '../src/runtime-metrics.js';
// Configuration and the production preconditions are validated before the database opens (OPS-03).
const config = loadConfig(process.env, 'http');
const mcpLimits = validMcpLimits(mcpLimitsFromEnv(process.env));
const {service, store} = createRuntime(config);
// One asynchronous, deadline-bounded `ffmpeg -version` at startup, read in the background and never on a request: owner
// health, its media_processor state and /versionz share it (OPS-02 review, QA-01); it never delays /healthz.
void startFfmpegVersionProbe();
// OPS-08: event-loop delay percentiles for owner health and the support bundle.
startEventLoopMonitor();
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
    // Validated before the database opens; an unknown value stops the server (SEC-01).
    clientIpSource: config.clientIpSource,
    ...(config.mcpRefreshReuseSeconds !== undefined ? {mcpRefreshReuseSeconds: config.mcpRefreshReuseSeconds} : {}),
    mcpClientMetadata: {
      enabled: config.mcpClientMetadata.enabled,
      hosts: config.mcpClientMetadata.hosts && [...config.mcpClientMetadata.hosts],
    },
  },
  mcpAllowedOrigins: config.mcpAllowedOrigins && [...config.mcpAllowedOrigins],
  // AMCP_MCP_BATCH_MAX and the per-actor rate limits (SEC-02); an invalid value stops start-up.
  mcpLimits,
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
  // OPS-08: the line also names the release, Node, SQLite and FFmpeg versions and the schema bootstrap (including the
  // website tables' steps); it is written once the bounded FFmpeg probe settles.
  if (address && typeof address !== 'string')
    void startFfmpegVersionProbe().then(ffmpeg =>
      process.stdout.write(
        JSON.stringify({
          level: 'info',
          event: 'http_listening',
          message: 'AMCP HTTP server is listening.',
          host: address.address,
          port: address.port,
          public_origin: publicOrigin ?? null,
          ...runtimeIdentity(store, ffmpeg),
        }) + '\n',
      ),
    );
});
tuneListener(listener);
let closing = false;
const overview = new ReportingOverview(service);
const worker = new ReportWorker(store, createReportExecutor(service), (t, k, i) => overview.work(t, k, i));
worker.onRelease = (t, k, i) => overview.releaseJob(t, k, i);
// One metadata-only job_started and job_finished line per job (OPS-08).
worker.onJobEvent = jsonLine;
const workerDone = (async () => {
  if (!config.runWorker) return;
  process.stdout.write(JSON.stringify(workerClockEvent()) + '\n');
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
