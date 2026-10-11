import path from 'node:path';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import type {CallOptions} from '../src/types.js';
import {linkedinVersion} from '../src/linkedin-version.js';
import {resolveMetaVersion} from '../src/meta-version.js';
import {googleDeveloperTokenWarning} from '../src/google-version.js';
import {loadConfig, type AmcpConfig} from './config.js';
import {checkVolumeMarker, verifyDataVolume, type VolumeLog, type VolumeStat} from './volume.js';
import {MirrorError} from '../src/errors.js';
import {sqliteDiagnostic} from '../src/sqlite-diagnostics.js';
import {quotaPolicyFromEnv} from '../src/provider-quota.js';
/** Metadata-only start-up lines: info on stdout for HTTP and the worker; everything on stderr for stdio MCP. */
export function startupLog(entry: AmcpConfig['entry']): VolumeLog {
  return line =>
    (entry === 'stdio' || line.level !== 'info' ? process.stderr : process.stdout).write(JSON.stringify(line) + '\n');
}
/**
 * Opens the store and service for one entry point. Every precondition runs before the database opens (OPS-03): the
 * validated configuration, then, in production, the persistent-volume guard; the volume marker is checked after.
 * A failure at any stage after the volume guard (which logs its own refusal) leaves one metadata-only
 * `startup_failed` line naming the stage, its code and, for SQLite, the diagnostic (OPS-08), and is then rethrown.
 */
export function createRuntime(
  config: AmcpConfig = loadConfig(process.env, 'stdio'),
  options: {log?: VolumeLog; stat?: VolumeStat} = {},
) {
  const log = options.log ?? startupLog(config.entry);
  let stage: StartupStage = 'provider_versions',
    opened: Store | undefined;
  try {
    // Provider version pins fail closed at startup (PRV-02): an unreviewed or sunset LinkedIn-Version, or a Meta
    // version AMCP holds no evidence for, stops the process instead of every later provider request. Unset, the
    // reviewed default is sent: its own sunset refuses LinkedIn requests (owner health alarms 90 days ahead), never
    // every other provider.
    for (const [name, check] of [
      ['AMCP_LINKEDIN_API_VERSION', () => process.env.AMCP_LINKEDIN_API_VERSION === undefined || linkedinVersion()],
      ['AMCP_META_API_VERSION', () => resolveMetaVersion()],
    ] as const)
      try {
        check();
      } catch (e) {
        throw new Error(name + ' is not a reviewed provider version: ' + (e instanceof Error ? e.message : String(e)));
      }
    for (const problem of config.problems) log({level: 'warn', event: 'config_problem', message: problem});
    // Configuration that still starts but needs the operator’s attention (PRV-04): stated once, at startup, without
    // the token’s value; owner health repeats it.
    const developerToken = googleDeveloperTokenWarning();
    if (developerToken) log({level: 'warn', event: 'google_developer_token_ignored', message: developerToken});
    // Issuer quota profiles are validated before the database opens; an invalid profile stops start-up (OPS-08).
    const quotaPolicy = quotaPolicyFromEnv(process.env);
    stage = 'volume';
    const volume = verifyDataVolume(config, log, options.stat);
    stage = 'store_open';
    const registry = new Registry();
    const store = (opened = new Store(config.databasePath, config.masterKey, config.previousMasterKeys));
    // Saved logins use the deployment's current app secrets of their own OAuth client (SEC-07 S2).
    store.appEnvironment = process.env;
    stage = 'volume_marker';
    if (volume?.persistent)
      volume.marker = checkVolumeMarker(store, path.dirname(path.resolve(config.databasePath)), log);
    store.volume = volume;
    store.quotaPolicy = quotaPolicy;
    stage = 'service';
    const callOptions: CallOptions = {mode: config.mode, flags: config.flags as CallOptions['flags']};
    const service = new MirrorService(registry, store, undefined, callOptions, {
      allowWrites: config.allowWrites,
      maxBudgetChange: 0,
      requireBeforeState: true,
      providerValidation: config.providerValidation,
    });
    service.transport.coordination = store;
    // Metadata-only failure lines on stderr (stdout carries stdio MCP); the HTTP app replaces this with its own log.
    service.onToolFailure = entry => process.stderr.write(JSON.stringify(entry) + '\n');
    return {registry, store, service, config};
  } catch (error) {
    if (stage !== 'volume')
      try {
        const database = sqliteDiagnostic(error);
        log({
          level: 'error',
          event: 'startup_failed',
          stage,
          code: startupCode(error),
          ...(database ? {database} : {}),
          // A database newer than this release names its versions and the recovery guide (never a path or SQL).
          ...(error instanceof MirrorError && error.code === 'SCHEMA_TOO_NEW' ? {details: error.details} : {}),
        });
      } catch {}
    try {
      opened?.close();
    } catch {}
    throw error;
  }
}
type StartupStage = 'provider_versions' | 'volume' | 'store_open' | 'volume_marker' | 'service';
const startupCode = (error: unknown) => {
  const code = error instanceof MirrorError ? error.code : (error as {code?: unknown})?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'STARTUP_FAILED';
};
