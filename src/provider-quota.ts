import {AsyncLocalStorage} from 'node:async_hooks';
import type {DatabaseSync} from 'node:sqlite';
import {MirrorError} from './errors.js';
import {sha256} from './security.js';
import type {Credentials} from './types.js';

/**
 * Provider quota by issuer (OPS-08). Providers ration requests per OAuth app, Cloud project or developer token across
 * every account that uses it (Google per project per day, Meta per app), while AMCP's own budgets are per workspace.
 * The issuer is a one-way hash of the gateway and the credential field that names the app, never the raw value. Every
 * provider permit records the issuer's daily request and operation counts per workspace; owner health shows them.
 *
 * Mode `observe` (the default) only counts, including how often enforcement would have refused, so a seven-day baseline
 * exists before any profile is set. Mode `enforce` refuses before egress, with a retryable
 * PROVIDER_QUOTA_SHARE_EXHAUSTED, once a profile's limit for the current UTC day is reached:
 *   - standard requests stop when one workspace reaches its share of the general pool, or the pool is spent;
 *   - reserved requests (write verification read-backs and reauthorization checks) may also use the reserved slice.
 * Counters live in SQLite, so they are shared between processes and survive a restart.
 */
export type QuotaPurpose = 'standard' | 'reserved';
export type QuotaProfile = {daily_requests: number; reserved_fraction: number; tenant_share: number};
export type QuotaPolicy = {mode: 'observe' | 'enforce'; profiles: Readonly<Record<string, QuotaProfile>>};
export type IssuerPermit = {
  issuer: string;
  tenant: string;
  gateway: string;
  purpose: QuotaPurpose;
  operations: number;
};
export const QUOTA_RETAINED_DAYS = 8;
const purposes = new AsyncLocalStorage<QuotaPurpose>();
/** Runs `fn` with every provider request it makes counted as `purpose`. */
export function runWithQuotaPurpose<T>(purpose: QuotaPurpose, fn: () => T): T {
  return purposes.run(purpose, fn);
}
export function currentQuotaPurpose(): QuotaPurpose {
  return purposes.getStore() ?? 'standard';
}
/**
 * The issuer of a request: the hashed app identity of its credentials (OAuth client, X consumer key, developer token or
 * Apple team), scoped by gateway. Null when the credentials name no app; such requests are not issuer-counted.
 */
export function issuerKey(gateway: string, credentials: Credentials | undefined): string | null {
  const identity =
    credentials?.clientId ?? credentials?.consumerKey ?? credentials?.developerToken ?? credentials?.appleTeamId;
  if (typeof identity !== 'string' || !identity) return null;
  return 'iss_' + sha256('amcp-provider-issuer\0' + gateway + '\0' + identity).slice(0, 24);
}
/** Google Ads style mutate bodies count each operation; every other request counts one. */
export function requestOperations(body: unknown): number {
  const operations = (body as {operations?: unknown} | null | undefined)?.operations;
  return Array.isArray(operations) && operations.length > 0 ? Math.min(100000, operations.length) : 1;
}
export const quotaDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
export const nextQuotaDayMs = (now = Date.now()) => {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - now;
};
const gatewayName = /^[a-z][a-z0-9_]{1,62}_native_action$/;
/**
 * Reads AMCP_PROVIDER_QUOTA_MODE (observe | enforce) and AMCP_PROVIDER_QUOTA_PROFILES, a JSON object of gateway ->
 * {daily_requests, reserved_fraction (0-0.5, default 0.1), tenant_share (0-1, default 0.5)}. Invalid values throw, so
 * start-up stops instead of enforcing something unintended.
 */
export function quotaPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): QuotaPolicy {
  const mode = env.AMCP_PROVIDER_QUOTA_MODE ?? 'observe';
  if (mode !== 'observe' && mode !== 'enforce') throw TypeError('AMCP_PROVIDER_QUOTA_MODE must be observe or enforce.');
  const raw = env.AMCP_PROVIDER_QUOTA_PROFILES;
  if (raw === undefined || raw.trim() === '') return Object.freeze({mode, profiles: Object.freeze({})});
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw TypeError('AMCP_PROVIDER_QUOTA_PROFILES must be a JSON object.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw TypeError('AMCP_PROVIDER_QUOTA_PROFILES must be a JSON object.');
  const profiles: Record<string, QuotaProfile> = {};
  for (const [gateway, value] of Object.entries(parsed)) {
    const v = value as Record<string, unknown>;
    const daily = v?.daily_requests,
      reserved = v?.reserved_fraction ?? 0.1,
      share = v?.tenant_share ?? 0.5;
    if (
      !gatewayName.test(gateway) ||
      !v ||
      typeof v !== 'object' ||
      Object.keys(v).some(k => !['daily_requests', 'reserved_fraction', 'tenant_share'].includes(k)) ||
      !Number.isSafeInteger(daily) ||
      (daily as number) < 1 ||
      typeof reserved !== 'number' ||
      !(reserved >= 0 && reserved <= 0.5) ||
      typeof share !== 'number' ||
      !(share > 0 && share <= 1)
    )
      throw TypeError(
        'AMCP_PROVIDER_QUOTA_PROFILES: ' +
          (gatewayName.test(gateway) ? gateway : 'an entry') +
          ' needs daily_requests (a positive integer), reserved_fraction from 0 to 0.5 and tenant_share above 0 up to 1.',
      );
    profiles[gateway] = Object.freeze({
      daily_requests: daily as number,
      reserved_fraction: reserved,
      tenant_share: share,
    });
  }
  return Object.freeze({mode, profiles: Object.freeze(profiles)});
}
export type IssuerDay = {requests: number; reserved_requests: number; operations: number};
/**
 * Whether `permit` fits `profile` given today's counts so far: null when it does, else which limit it reached. The
 * general pool excludes the reserved slice; one workspace's share is a fraction of the general pool.
 */
export function quotaRefusal(
  profile: QuotaProfile,
  permit: Pick<IssuerPermit, 'purpose'>,
  issuerToday: IssuerDay,
  workspaceToday: IssuerDay,
): 'workspace_share' | 'issuer_pool' | 'issuer_daily' | null {
  const pool = Math.floor(profile.daily_requests * (1 - profile.reserved_fraction)),
    share = Math.max(1, Math.floor(pool * profile.tenant_share));
  if (permit.purpose === 'reserved') return issuerToday.requests >= profile.daily_requests ? 'issuer_daily' : null;
  if (workspaceToday.requests - workspaceToday.reserved_requests >= share) return 'workspace_share';
  if (issuerToday.requests - issuerToday.reserved_requests >= pool) return 'issuer_pool';
  return null;
}
type UsageRow = {
  issuer: string;
  gateway: string;
  day: string;
  requests: number;
  reserved_requests: number;
  operations: number;
  rate_limits: number;
  refused: number;
  would_refuse: number;
};
const counts = (rows: UsageRow[]) =>
  rows.reduce(
    (sum, r) => ({
      requests: sum.requests + r.requests,
      reserved_requests: sum.reserved_requests + r.reserved_requests,
      operations: sum.operations + r.operations,
      rate_limits: sum.rate_limits + r.rate_limits,
      refused: sum.refused + r.refused,
      would_refuse: sum.would_refuse + r.would_refuse,
    }),
    {requests: 0, reserved_requests: 0, operations: 0, rate_limits: 0, refused: 0, would_refuse: 0},
  );
/**
 * Owner health (OPS-08): the issuers this workspace used in the retained days, each with its deployment-wide daily
 * counts, this workspace's counts today, the profile and what remains of today's general pool. Hashes and counts only.
 */
export function providerQuotaHealth(db: DatabaseSync, tenant: string, policy: QuotaPolicy, now = Date.now()) {
  const today = quotaDay(now),
    since = quotaDay(now - (QUOTA_RETAINED_DAYS - 1) * 86400000),
    rows = db
      .prepare(
        'SELECT issuer,gateway,day,sum(requests) AS requests,sum(reserved_requests) AS reserved_requests,sum(operations) AS operations,sum(rate_limits) AS rate_limits,sum(refused) AS refused,sum(would_refuse) AS would_refuse FROM provider_issuer_usage WHERE day>=? AND issuer IN (SELECT issuer FROM provider_issuer_usage WHERE tenant_id=? AND day>=?) GROUP BY issuer,gateway,day ORDER BY issuer,gateway,day',
      )
      .all(since, tenant, since) as UsageRow[],
    mine = db
      .prepare(
        'SELECT issuer,gateway,day,requests,reserved_requests,operations,rate_limits,refused,would_refuse FROM provider_issuer_usage WHERE tenant_id=? AND day=?',
      )
      .all(tenant, today) as UsageRow[];
  const keys = [...new Set(rows.map(r => r.issuer + '\0' + r.gateway))];
  return {
    version: 1,
    mode: policy.mode,
    day: today,
    issuers: keys.map(k => {
      const [issuer, gateway] = k.split('\0') as [string, string],
        own = rows.filter(r => r.issuer === issuer && r.gateway === gateway),
        todayCounts = counts(own.filter(r => r.day === today)),
        profile = policy.profiles[gateway] ?? null,
        pool = profile ? Math.floor(profile.daily_requests * (1 - profile.reserved_fraction)) : null;
      return {
        issuer,
        gateway,
        profile,
        today: todayCounts,
        workspace_today: counts(mine.filter(r => r.issuer === issuer && r.gateway === gateway)),
        general_pool_remaining:
          pool === null ? null : Math.max(0, pool - (todayCounts.requests - todayCounts.reserved_requests)),
        days: own.map(r => ({day: r.day, requests: r.requests, operations: r.operations, rate_limits: r.rate_limits})),
      };
    }),
    scope:
      'Provider requests per hashed app identity (issuer) and UTC day, for the issuers this workspace used in the last 8 days; deployment-wide totals beside this workspace’s own. Observe mode only counts; would_refuse is how often enforcement would have refused.',
  };
}
export function quotaExhausted(scope: string, now = Date.now()): MirrorError {
  return new MirrorError(
    'PROVIDER_QUOTA_SHARE_EXHAUSTED',
    scope === 'workspace_share'
      ? 'This workspace used its share of the shared provider app quota for today. Nothing was sent; work continues after the daily reset.'
      : 'The shared provider app quota for today is used up. Nothing was sent; work continues after the daily reset.',
    {scope, retry_after_ms: nextQuotaDayMs(now)},
    429,
    true,
  );
}
