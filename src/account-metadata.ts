import type {Store} from './store.js';
import type {JsonObject} from './types.js';
import {sha256, stable} from './security.js';

/**
 * What a live account read said about an account: its name, currency, timezone and organization (Snapchat S8).
 * list_accounts showed the connection's label as the account name and null currency and timezone for every platform,
 * although a live check had read them. Nothing here is invented: an account never read live has no record, and
 * list_accounts then says how to read it.
 */
export const accountMetadataStaleMs = 7 * 86400000;
const key = (connectionId: string, accountId: string) => sha256(stable([connectionId, accountId]));
export function rememberAccountMetadata(
  store: Store,
  tenantId: string,
  connectionId: string,
  accountId: string,
  metadata: {name: unknown; currency: unknown; timezone: unknown; organization_id?: unknown},
) {
  const text = (v: unknown) => (typeof v === 'string' && v.length <= 300 ? v : null);
  store.putDocument(tenantId, 'account_metadata', key(connectionId, accountId), {
    connection_id: connectionId,
    account_id: accountId,
    name: text(metadata.name),
    currency: text(metadata.currency),
    timezone: text(metadata.timezone),
    organization_id: text(metadata.organization_id),
    source: 'live_account_read',
    checked_at: Date.now(),
  });
}
export function recallAccountMetadata(
  store: Store,
  tenantId: string,
  connectionId: string,
  accountId: string,
): JsonObject | undefined {
  const row = store.db
    .prepare("SELECT data FROM documents WHERE tenant_id=? AND kind='account_metadata' AND id=?")
    .get(tenantId, key(connectionId, accountId)) as {data: string} | undefined;
  return row ? JSON.parse(row.data) : undefined;
}
/** The account's own name in a native account read, however the provider nests it. */
export function accountName(metadata: JsonObject): unknown {
  return metadata.name ?? metadata.descriptiveName ?? metadata.Name ?? metadata.advertiser_name ?? metadata.displayName;
}
