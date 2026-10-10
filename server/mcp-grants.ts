import {randomUUID} from 'node:crypto';
import type {Store} from '../src/store.js';
import type {JsonObject} from '../src/types.js';

/**
 * Why an AI client's authorization ended (MCP-08). The reason is kept on each ended grant row and in one
 * `mcp_oauth_family_revoked` audit row per client and approving person, so an approval can be joined to the revocation
 * that ended it. A client metadata document (CIMD) client ID is shared by everyone who uses that app, so the client
 * alone does not identify a connection; the person who approved it does.
 * Never token material: rows are keyed by hash and audit carries only the client, the reason and counts.
 */
export const grantEndReasons = [
  'refresh_replay',
  'code_replay',
  'client_revoke',
  'workspace_revoke',
  'membership_change',
  'password_change',
  'email_change',
  'mfa_change',
  'account_access_revoked',
  'owner_migration',
  'door_password_change',
  'restore_quarantine',
] as const;
export type GrantEndReason = (typeof grantEndReasons)[number];

/**
 * Ends the live MCP OAuth grants that `where` selects (a condition on the unaliased amcp_mcp_grants table): each
 * unused row is marked used with its reason and time, the API key of each ended access grant is revoked, and one
 * audit row per tenant, client and approving person records the reason (unless `audit` is false because the caller
 * writes its own).
 * Rows already used (rotated or ended before) keep their state. Returns the number of grant rows ended.
 */
export function endMcpGrants(
  store: Store,
  where: string,
  params: unknown[],
  reason: GrantEndReason,
  options: {audit?: boolean; details?: JsonObject} = {},
): number {
  const db = store.db,
    now = Date.now();
  return store.transaction(() => {
    const rows = db
      .prepare('SELECT hash,kind,client_id,tenant_id,data FROM amcp_mcp_grants WHERE used=0 AND (' + where + ')')
      .all(...(params as never[])) as JsonObject[];
    type Ended = {tenant: string; client: string; families: Set<string>; owner?: string};
    const clients = new Map<string, Ended>();
    for (const row of rows) {
      db.prepare(
        "UPDATE amcp_mcp_grants SET used=1,data=json_set(data,'$.ended_reason',?,'$.ended_at',?) WHERE hash=?",
      ).run(reason, now, row.hash);
      if (row.kind === 'access')
        db.prepare('UPDATE api_keys SET revoked=1 WHERE tenant_id=? AND hash=?').run(row.tenant_id, row.hash);
      const data = JSON.parse(row.data) as JsonObject,
        owner = typeof data.ownerUserId === 'string' ? data.ownerUserId : undefined,
        key = row.tenant_id + '\u0000' + row.client_id + '\u0000' + (owner ?? ''),
        entry: Ended = clients.get(key) ?? {
          tenant: row.tenant_id,
          client: row.client_id,
          families: new Set<string>(),
          ...(owner ? {owner} : {}),
        };
      if ((row.kind === 'access' || row.kind === 'refresh') && typeof data.family === 'string')
        entry.families.add(data.family);
      clients.set(key, entry);
    }
    if (options.audit !== false)
      for (const entry of clients.values())
        store.appendAudit(entry.tenant, randomUUID(), {
          event: 'mcp_oauth_family_revoked',
          client_id: entry.client,
          reason,
          families: entry.families.size,
          ...(entry.owner ? {owner_user_id: entry.owner} : {}),
          ...options.details,
        });
    return rows.length;
  });
}

/** The reason recorded on a token family that has ended, if one was recorded. */
export function familyEndReason(store: Store, tenant: string, family: unknown): GrantEndReason | undefined {
  if (typeof family !== 'string') return;
  const row = store.db
    .prepare(
      "SELECT json_extract(data,'$.ended_reason') AS reason FROM amcp_mcp_grants WHERE tenant_id=? AND kind IN ('access','refresh') AND json_extract(data,'$.family')=? AND json_extract(data,'$.ended_reason') IS NOT NULL ORDER BY json_extract(data,'$.ended_at') DESC LIMIT 1",
    )
    .get(tenant, family) as {reason?: string} | undefined;
  return grantEndReasons.find(r => r === row?.reason);
}
