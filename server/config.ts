import path from 'node:path';

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
  adminPassword: string | undefined;
  adminPasswordHash: string | undefined;
  testPassword: string | undefined;
  testPasswordHash: string | undefined;
  tenantId: string | undefined;
  allowWrites: boolean;
  mode: 'strict' | 'enhanced';
  flags: Readonly<Record<string, unknown>>;
  runWorker: boolean;
  trustedProxyCidrs: readonly string[] | undefined;
  /**
   * AMCP_CLIENT_IP_SOURCE (SEC-01): socket, xff-cidrs, railway or railway+cloudflare. Unset keeps the earlier behavior
   * (xff-cidrs when trusted CIDRs are set, otherwise socket); any other value stops the HTTP server before it starts.
   */
  clientIpSource: string | undefined;
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
  return Object.freeze({
    entry,
    production,
    host,
    port,
    publicOrigin,
    origin: publicOrigin ?? 'http://127.0.0.1:' + port,
    databasePath: text(env.MIRROR_DB) ?? DEFAULT_DATABASE_PATH,
    masterKey,
    adminPassword,
    adminPasswordHash,
    testPassword: env.AMCP_TEST_PASSWORD,
    testPasswordHash: env.AMCP_TEST_PASSWORD_HASH,
    tenantId: env.AMCP_TENANT_ID,
    allowWrites,
    mode: env.MIRROR_MODE === 'enhanced' ? 'enhanced' : 'strict',
    flags: Object.freeze(JSON.parse(env.MIRROR_FLAGS ?? '{}')),
    runWorker: env.AMCP_RUN_WORKER !== 'false',
    trustedProxyCidrs: list(env.AMCP_TRUSTED_PROXY_CIDRS),
    clientIpSource,
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
