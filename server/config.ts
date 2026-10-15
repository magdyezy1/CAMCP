import path from 'node:path';
import {previousMasterKeys} from '../src/security.js';
import {accountRetention, selfServiceDeletion} from '../src/account-erasure.js';
import {reportRetentionDefault} from '../src/data-retention.js';
import {mcpRegistrationLimitDefaults, mcpRegistrationLimits, type McpRegistrationLimits} from '../src/mcp-clients.js';

/** The process an AMCP configuration starts. */
export type EntryPoint = 'http' | 'worker' | 'stdio';
/**
 * One validated configuration for every entry point (OPS-03). Each entry point used to read `process.env` on its own,
 * so the public origin was derived differently and the production preconditions ran in the HTTP server only, after the
 * database had already been opened. `loadConfig` runs before anything opens the database.
 */
export type AmcpConfig = Readonly<{
  entry: EntryPoint;
  production: boolean;
  host: string;
  port: number;
  /** The configured HTTPS public origin, when there is one. */
  publicOrigin: string | undefined;
  /** The origin links and callbacks use: the public origin, otherwise the local listener. */
  origin: string;
  databasePath: string;
  masterKey: string | undefined;
  /** MIRROR_MASTER_KEY_PREVIOUS (SEC-07 S3): keys a rotation replaced; they open values until `admin rekey` ran. */
  previousMasterKeys: readonly string[];
  adminPassword: string | undefined;
  adminPasswordHash: string | undefined;
  testPassword: string | undefined;
  testPasswordHash: string | undefined;
  tenantId: string | undefined;
  allowWrites: boolean;
  /**
   * AMCP_PROVIDER_VALIDATION (WRT-06, owner decision D18): the owner's opt-in to provider validation in a deployment
   * without write support. Only true or false is accepted, so an ambiguous opt-in is never guessed.
   */
  providerValidation: boolean;
  /**
   * AMCP_PROVIDER_JOBS (RPT-06, owner decision D18): the owner's switch for provider report and export jobs as their own
   * quota-bounded effect. On, a job is allowed while live writes are off and for a reader with an account report-job
   * grant; off (the default), jobs stay reviewed writes. Only true or false is accepted.
   */
  providerJobs: boolean;
  mode: 'strict' | 'enhanced';
  flags: Readonly<Record<string, unknown>>;
  runWorker: boolean;
  trustedProxyCidrs: readonly string[] | undefined;
  /**
   * AMCP_CLIENT_IP_SOURCE (SEC-01): socket, xff-cidrs, railway or railway+cloudflare. Unset keeps the earlier behavior
   * (xff-cidrs when trusted CIDRs are set, otherwise socket); any other value stops the HTTP server before it starts.
   */
  clientIpSource: string | undefined;
  /** AMCP_MCP_REFRESH_REUSE_SECONDS (MCP-08): the website refuses to start with a value outside 0-60. */
  mcpRefreshReuseSeconds: number | undefined;
  /** AMCP_MCP_CLIENT_METADATA (`off` disables CIMD) and AMCP_MCP_CLIENT_METADATA_HOSTS (MCP-03). */
  mcpClientMetadata: Readonly<{enabled: boolean; hosts: readonly string[] | undefined}>;
  /**
   * AMCP_MCP_REGISTRATIONS_PER_ADDRESS_DAILY and AMCP_MCP_REGISTRATIONS_DAILY (MCP-03 phase 2): new AI-client
   * registrations per client address and per deployment in 24 hours. A bad value is ignored (listed in `problems`).
   */
  mcpRegistrationLimits: Readonly<McpRegistrationLimits>;
  /**
   * AMCP_MCP_MODERN_PROTOCOL (MCP-03 phase 3): `off` (default), `next` (MCP 2026-07-28 and the legacy revisions at
   * /mcp/next) or `on` (at /mcp as well). Another value is ignored and listed in `problems`.
   */
  mcpModernProtocol: 'off' | 'next' | 'on';
  mcpAllowedOrigins: readonly string[] | undefined;
  /** Declared persistent mounts the database may live in: `AMCP_DATA_MOUNT`, then `RAILWAY_VOLUME_MOUNT_PATH`. */
  dataMounts: readonly string[];
  /** `AMCP_ALLOW_EPHEMERAL_DB=true`: start in production without a verified volume (local and development use). */
  allowEphemeralDb: boolean;
  /** How long a shutdown waits for running work to settle before exiting (AMCP_SHUTDOWN_GRACE_MS, OPS-07). */
  shutdownGraceMs: number;
  /** Optional settings that were ignored, and why; entry points report them at start. */
  problems: readonly string[];
}>;
export const DEFAULT_DATABASE_PATH = '.runtime/mirror.sqlite';
/** Below Railway's draining window when that is set to 30 s; see docs/OPERATIONS.md. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 25000;
/** The values of AMCP_MCP_MODERN_PROTOCOL (modernProtocolModes in server/mcp-modern.ts; kept equal by a test). */
export const modernProtocolModeNames: readonly string[] = ['off', 'next', 'on'];
/** The client address profiles server/web-store.ts accepts (clientIpSources there; kept equal by a test). */
export const clientIpSourceNames: readonly string[] = ['socket', 'xff-cidrs', 'railway', 'railway+cloudflare'];
const text = (value: string | undefined) => (value === undefined || value === '' ? undefined : value);
const list = (value: string | undefined) => (value === undefined ? undefined : value.split(/[ ,]+/).filter(Boolean));
/**
 * Reads and validates the environment once. Required settings fail fast with a message naming the setting; optional
 * settings with a bad value are ignored and listed in `problems`, so they never stop a start on their own.
 */
export function loadConfig(env: NodeJS.ProcessEnv, entry: EntryPoint): AmcpConfig {
  const problems: string[] = [],
    production = env.NODE_ENV === 'production';
  if (env.MIRROR_ALLOW_WRITES !== undefined && !['true', 'false'].includes(env.MIRROR_ALLOW_WRITES))
    throw new Error('MIRROR_ALLOW_WRITES must be true or false.');
  const allowWrites = env.MIRROR_ALLOW_WRITES === 'true',
    masterKey = text(env.MIRROR_MASTER_KEY);
  if (allowWrites && !masterKey) throw new Error('Write support requires encrypted persistent connection credentials.');
  const previousKeys = previousMasterKeys(text(env.MIRROR_MASTER_KEY_PREVIOUS));
  if (previousKeys.length && !masterKey) throw new Error('MIRROR_MASTER_KEY_PREVIOUS requires MIRROR_MASTER_KEY.');
  if (env.AMCP_PROVIDER_VALIDATION !== undefined && !['true', 'false'].includes(env.AMCP_PROVIDER_VALIDATION))
    throw new Error('AMCP_PROVIDER_VALIDATION must be true or false.');
  if (env.AMCP_PROVIDER_JOBS !== undefined && !['true', 'false'].includes(env.AMCP_PROVIDER_JOBS))
    throw new Error('AMCP_PROVIDER_JOBS must be true or false.');
  // Retention (SEC-07, owner decision P3): an unknown AMCP_PENDING_ACCOUNT_DAYS, AMCP_REVOKED_ACCOUNT_DAYS,
  // AMCP_REPORT_RETENTION_DAYS or AMCP_ACCOUNT_SELF_DELETION stops start-up.
  if (entry !== 'stdio') {
    accountRetention(env);
    reportRetentionDefault(env);
    selfServiceDeletion(env);
  }
  const host = env.MIRROR_HOST ?? (env.PORT ? '0.0.0.0' : '127.0.0.1'),
    port = Number(env.PORT ?? env.MIRROR_PORT ?? 4317);
  if (entry !== 'stdio' && (!Number.isInteger(port) || port < 1 || port > 65535)) throw Error('Invalid MIRROR_PORT.');
  const publicOrigin =
      text(env.AMCP_PUBLIC_ORIGIN) ??
      text(env.MIRROR_PUBLIC_ORIGIN) ??
      (text(env.RAILWAY_PUBLIC_DOMAIN) ? 'https://' + env.RAILWAY_PUBLIC_DOMAIN : undefined),
    // Website door settings keep their exact values: the website validates them, an empty one included.
    adminPassword = env.AMCP_ADMIN_PASSWORD,
    adminPasswordHash = env.AMCP_ADMIN_PASSWORD_HASH;
  if (production && entry === 'http' && (!masterKey || !(adminPassword || adminPasswordHash)))
    throw Error('Production requires MIRROR_MASTER_KEY and an AMCP administrator password.');
  if (production && entry === 'worker' && !masterKey) throw Error('The production worker requires MIRROR_MASTER_KEY.');
  const dataMounts: string[] = [];
  for (const name of ['AMCP_DATA_MOUNT', 'RAILWAY_VOLUME_MOUNT_PATH'] as const) {
    const mount = text(env[name]);
    if (mount === undefined) continue;
    if (path.isAbsolute(mount)) dataMounts.push(path.resolve(mount));
    else problems.push(name + ' must be an absolute path; it was ignored.');
  }
  const graceText = text(env.AMCP_SHUTDOWN_GRACE_MS),
    grace = Number(graceText);
  if (graceText !== undefined && !(/^\d{1,6}$/.test(graceText) && grace >= 1000 && grace <= 600000))
    problems.push('AMCP_SHUTDOWN_GRACE_MS must be an integer from 1000 to 600000; the 25000 ms default applies.');
  const clientIpSource = text(env.AMCP_CLIENT_IP_SOURCE?.trim());
  if (entry === 'http' && clientIpSource !== undefined && !clientIpSourceNames.includes(clientIpSource))
    throw Error('AMCP_CLIENT_IP_SOURCE must be socket, xff-cidrs, railway or railway+cloudflare.');
  const ephemeral = text(env.AMCP_ALLOW_EPHEMERAL_DB);
  if (ephemeral !== undefined && !['true', 'false'].includes(ephemeral))
    problems.push('AMCP_ALLOW_EPHEMERAL_DB must be true or false; it was treated as false.');
  let registrationLimits: McpRegistrationLimits = {...mcpRegistrationLimitDefaults};
  try {
    const whole = (name: string) => {
      const raw = text(env[name]?.trim());
      if (raw !== undefined && !/^\d{1,6}$/.test(raw)) throw Error(name + ' must be a whole number.');
      return raw === undefined ? undefined : Number(raw);
    };
    registrationLimits = mcpRegistrationLimits({
      perAddressDaily: whole('AMCP_MCP_REGISTRATIONS_PER_ADDRESS_DAILY'),
      daily: whole('AMCP_MCP_REGISTRATIONS_DAILY'),
    });
  } catch (e) {
    problems.push((e as Error).message + ' The registration limit defaults apply.');
  }
  const modern = text(env.AMCP_MCP_MODERN_PROTOCOL?.trim().toLowerCase());
  if (modern !== undefined && !modernProtocolModeNames.includes(modern))
    problems.push('AMCP_MCP_MODERN_PROTOCOL must be off, next or on; it was treated as off.');
  return Object.freeze({
    entry,
    production,
    host,
    port,
    publicOrigin,
    origin: publicOrigin ?? 'http://127.0.0.1:' + port,
    databasePath: text(env.MIRROR_DB) ?? DEFAULT_DATABASE_PATH,
    masterKey,
    previousMasterKeys: Object.freeze(previousKeys.filter(key => key !== masterKey)),
    adminPassword,
    adminPasswordHash,
    testPassword: env.AMCP_TEST_PASSWORD,
    testPasswordHash: env.AMCP_TEST_PASSWORD_HASH,
    tenantId: env.AMCP_TENANT_ID,
    allowWrites,
    providerValidation: env.AMCP_PROVIDER_VALIDATION === 'true',
    providerJobs: env.AMCP_PROVIDER_JOBS === 'true',
    mode: env.MIRROR_MODE === 'enhanced' ? 'enhanced' : 'strict',
    flags: Object.freeze(JSON.parse(env.MIRROR_FLAGS ?? '{}')),
    runWorker: env.AMCP_RUN_WORKER !== 'false',
    trustedProxyCidrs: list(env.AMCP_TRUSTED_PROXY_CIDRS),
    clientIpSource,
    mcpRefreshReuseSeconds: env.AMCP_MCP_REFRESH_REUSE_SECONDS?.trim()
      ? Number(env.AMCP_MCP_REFRESH_REUSE_SECONDS.trim())
      : undefined,
    mcpClientMetadata: Object.freeze({
      enabled: env.AMCP_MCP_CLIENT_METADATA?.trim().toLowerCase() !== 'off',
      hosts: list(env.AMCP_MCP_CLIENT_METADATA_HOSTS),
    }),
    mcpRegistrationLimits: Object.freeze(registrationLimits),
    mcpModernProtocol:
      modern !== undefined && modernProtocolModeNames.includes(modern) ? (modern as 'off' | 'next' | 'on') : 'off',
    mcpAllowedOrigins: list(env.AMCP_MCP_ALLOWED_ORIGINS),
    dataMounts: Object.freeze([...new Set(dataMounts)]),
    allowEphemeralDb: ephemeral === 'true',
    shutdownGraceMs:
      graceText !== undefined && /^\d{1,6}$/.test(graceText) && grace >= 1000 && grace <= 600000
        ? grace
        : DEFAULT_SHUTDOWN_GRACE_MS,
    problems: Object.freeze(problems),
  });
}
/**
 * Administrative commands run as root (for example over `railway ssh`) can create database files, or sidecars, that the
 * unprivileged server cannot open. In production they are refused unless `--allow-root` is given deliberately (OPS-03).
 */
export function adminRootRefusal(input: {
  production: boolean;
  uid: number | undefined;
  allowRoot: boolean;
}): string | undefined {
  if (!input.production || input.uid !== 0 || input.allowRoot) return;
  return 'Run admin commands as the application user: gosu node npm run admin -- <command>. As root they can leave database files the server cannot open; pass --allow-root only for a deliberate repair.';
}
