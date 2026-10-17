import type {DatabaseSync} from 'node:sqlite';

/**
 * Reads of the provider request counters (`provider_issuer_usage`, OPS-08; src/provider-quota.ts) in the store layer
 * (ARC-02), moved here verbatim. Issuers are hashed; the rows hold counts only.
 */
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
/** The deployment-wide daily counts, since `since`, of every issuer the workspace used since then. */
export function issuerUsageSince(db: DatabaseSync, tenant: string, since: string): UsageRow[] {
  return db
    .prepare(
      'SELECT issuer,gateway,day,sum(requests) AS requests,sum(reserved_requests) AS reserved_requests,sum(operations) AS operations,sum(rate_limits) AS rate_limits,sum(refused) AS refused,sum(would_refuse) AS would_refuse FROM provider_issuer_usage WHERE day>=? AND issuer IN (SELECT issuer FROM provider_issuer_usage WHERE tenant_id=? AND day>=?) GROUP BY issuer,gateway,day ORDER BY issuer,gateway,day',
    )
    .all(since, tenant, since) as UsageRow[];
}
/** The workspace's own counts on one day. */
export function workspaceIssuerUsage(db: DatabaseSync, tenant: string, day: string): UsageRow[] {
  return db
    .prepare(
      'SELECT issuer,gateway,day,requests,reserved_requests,operations,rate_limits,refused,would_refuse FROM provider_issuer_usage WHERE tenant_id=? AND day=?',
    )
    .all(tenant, day) as UsageRow[];
}
