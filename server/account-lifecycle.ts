import {randomUUID} from 'node:crypto';
import type {Store} from '../src/store.js';
import type {Actor, JsonObject} from '../src/types.js';
import {disconnectLocalConnection} from '../src/connection-disconnect.js';
import {
  accountRetention,
  accountsDueForErasure,
  eraseAccount,
  retentionBlockedAccounts,
} from '../src/account-erasure.js';

const day = 86400000;
/** The shared reviewer workspace of a deployment workspace (WebStore.testTenantId). */
export const reviewerTenant = (tenant: string) => tenant + '-test';
/** The actor recorded on disconnections this module makes; it is never a person and opens no session. */
const lifecycleActor = (tenantId: string): Actor => ({tenantId, userId: 'system:account-lifecycle', role: 'admin'});
/**
 * How long a login connected in the shared reviewer workspace stays (SEC-06 S6): 7 days unless
 * AMCP_REVIEWER_CONNECTION_DAYS sets 1 to 90, or `off` (the rollback). An unknown value stops start-up.
 */
export function reviewerConnectionLifetime(env: NodeJS.ProcessEnv): number | null {
  const value = env.AMCP_REVIEWER_CONNECTION_DAYS;
  if (value === 'off') return null;
  const days = value === undefined || value === '' ? 7 : Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 90)
    throw Error('AMCP_REVIEWER_CONNECTION_DAYS must be a whole number of days from 1 to 90, or off.');
  return days * day;
}
/** When a login of the reviewer workspace was connected: its first website authorization, or 0 when unrecorded. */
export function connectedAt(store: Store, tenant: string, id: string): number {
  const row = store.db
    .prepare(
      "SELECT json_extract(data,'$.createdAt') AS at FROM documents WHERE tenant_id=? AND kind='website_connection' AND id=?",
    )
    .get(tenant, id) as {at: number | null} | undefined;
  return Number(row?.at) || 0;
}
/**
 * Removes the reviewer workspace's logins (SEC-06 S6), each exactly as a local disconnect does (credentials, selections,
 * report content read through it; receipts and audit stay), and audits `reviewer_connections_purged` with the reason
 * and count. `connectedBefore` limits it to logins connected before that time; a login with no recorded connection time
 * is treated as old. Never calls a provider.
 */
export function purgeReviewerConnections(
  store: Store,
  tenant: string,
  reason: 'reviewer_password_change' | 'reviewer_connection_expired',
  connectedBefore = Infinity,
): {connections: number} {
  return store.transaction(() => {
    const rows = store.db.prepare('SELECT id,data FROM connections WHERE tenant_id=?').all(tenant) as {
      id: string;
      data: string;
    }[];
    let removed = 0;
    for (const row of rows) {
      if (connectedAt(store, tenant, row.id) >= connectedBefore) continue;
      const gateway = (JSON.parse(row.data) as JsonObject).gateway as string;
      disconnectLocalConnection(store, lifecycleActor(tenant), gateway, row.id, 'website');
      removed++;
    }
    if (removed)
      store.appendAudit(tenant, randomUUID(), {event: 'reviewer_connections_purged', reason, connections: removed});
    return {connections: removed};
  });
}
/**
 * Erases the accounts retention makes due (SEC-07 S4, owner decision P3): sign-ups never approved for
 * `AMCP_PENDING_ACCOUNT_DAYS` (30 by default) and accounts revoked `AMCP_REVOKED_ACCOUNT_DAYS` ago (90 by default).
 * Each is erased like `admin erase-account --confirm` and receipted (`account_erased`); one whose erasure fails is
 * counted as refused and tried again next run. Accounts whose workspace other active members use are not selected and
 * are counted as `blocked`. At most 100 of each per run. A run that erased or refused anything appends one
 * `retention_sweep` record to the deployment's audit with the counts and the periods.
 */
export function eraseDueAccounts(
  store: Store,
  deploymentTenant: string,
  retention: ReturnType<typeof accountRetention>,
  now = Date.now(),
): {pending: number; revoked: number; refused: number; blocked: number} {
  const due = accountsDueForErasure(store, deploymentTenant, retention, now),
    out = {
      pending: 0,
      revoked: 0,
      refused: 0,
      blocked: retentionBlockedAccounts(store, deploymentTenant, retention, now),
    };
  for (const [kind, reason] of [
    ['pending', 'pending_retention'],
    ['revoked', 'revoked_retention'],
  ] as const)
    for (const userId of due[kind])
      try {
        eraseAccount(store, {userId}, {deploymentTenant, reason, by: 'system:retention'});
        out[kind]++;
      } catch {
        out.refused++;
      }
  if (out.pending || out.revoked || out.refused) {
    store.ensureTenant(deploymentTenant);
    store.appendAudit(deploymentTenant, 'retention/' + randomUUID(), {
      event: 'retention_sweep',
      pending_erased: out.pending,
      revoked_erased: out.revoked,
      refused: out.refused,
      blocked: out.blocked,
      pending_days: retention.pendingMs === null ? null : retention.pendingMs / day,
      revoked_days: retention.revokedMs === null ? null : retention.revokedMs / day,
    });
  }
  return out;
}
/**
 * The worker's account lifecycle sweep, at most once an hour: logins of the shared reviewer workspace older than their
 * lifetime are removed (SEC-06 S6), and accounts past their retention are erased (SEC-07 S4). Returns what it removed,
 * or undefined when it did not run. An unknown retention or lifetime value stops start-up. A run that erased or refused
 * an account also writes one metadata-only `retention_sweep` line to `log` (counts only, never an account).
 */
export function accountLifecycleSweeper(
  store: Store,
  options: {
    tenantId: string;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    intervalMs?: number;
    log?: (entry: Record<string, unknown>) => void;
  },
) {
  const env = options.env ?? process.env,
    now = options.now ?? Date.now,
    interval = options.intervalMs ?? 3600000,
    reviewerLifetime = reviewerConnectionLifetime(env),
    retention = accountRetention(env),
    reviewers = reviewerTenant(options.tenantId);
  let next = 0;
  return () => {
    const at = now();
    if (at < next) return;
    next = at + interval;
    const reviewer_connections =
      reviewerLifetime === null
        ? 0
        : purgeReviewerConnections(store, reviewers, 'reviewer_connection_expired', at - reviewerLifetime).connections;
    // A store without website accounts (the stdio server's) has nothing to retain.
    if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='amcp_users'").get())
      return {reviewer_connections};
    const accounts_erased = eraseDueAccounts(store, options.tenantId, retention, at);
    if (accounts_erased.pending || accounts_erased.revoked || accounts_erased.refused)
      options.log?.({level: 'info', event: 'retention_sweep', ...accounts_erased});
    return {reviewer_connections, accounts_erased};
  };
}
