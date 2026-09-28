import {randomUUID} from 'node:crypto';
import {MirrorError} from './errors.js';
import {sha256, stable, redact} from './security.js';
import type {Store} from './store.js';
import type {Actor, Connection, JsonObject} from './types.js';

const operations: Record<string, string> = {
  ga4_native_action: 'ga4_connection_ops',
  google_search_console_native_action: 'gsc_connection_ops',
  google_business_native_action: 'gmb_connection_ops',
};
export function connectionDisconnectKind(gateway: string, operation: string, action: unknown): boolean {
  return operations[gateway] === operation && action === 'disconnect';
}
const receiptId = (gateway: string, id: string) => sha256(stable([gateway, id]));
function access(store: Store, actor: Actor) {
  store.assertActorActive(actor);
  if (actor.role !== 'admin')
    throw new MirrorError('FORBIDDEN', 'Only a workspace administrator can disconnect a platform identity.', {}, 403);
}
function find(store: Store, actor: Actor, gateway: string, id: string): Connection | undefined {
  const row = store.db.prepare('SELECT data FROM connections WHERE tenant_id=? AND id=?').get(actor.tenantId, id) as
    {data: string} | undefined;
  const c = row ? (JSON.parse(row.data) as Connection) : undefined;
  if (c && (c.tenantId !== actor.tenantId || c.gateway !== gateway))
    throw new MirrorError('CONNECTION_NOT_FOUND', 'No matching connection exists in this workspace.', {}, 404);
  return c;
}
function previous(store: Store, actor: Actor, gateway: string, id: string): JsonObject | undefined {
  try {
    const r = store.document(actor.tenantId, 'connection_disconnection', receiptId(gateway, id));
    return r.gateway === gateway && r.connection_id === id ? r : undefined;
  } catch (e) {
    if (e instanceof MirrorError && e.code === 'NOT_FOUND') return;
    throw e;
  }
}
function impact(c: Connection): JsonObject {
  return redact({
    gateway: c.gateway,
    connection_id: c.id,
    label: c.label,
    enabled: c.enabled,
    is_default: c.isDefault === true,
    selected_account_count: c.accounts.length,
    write_account_count: c.writeAccounts?.length ?? 0,
    effect:
      'Removes this AMCP connection, its encrypted credentials, saved discovery metadata and resource bindings. Other connections, provider accounts, advertising entities and provider OAuth grants are unchanged.',
    pending_work:
      'Jobs bound to this connection will fail current-access checks. In-flight provider requests may already have completed; retain their reviews, audit history and idempotency claims for reconciliation. This does not cancel a submitted provider mutation.',
    provider_access:
      'Local disconnect only. Revoke the external application grant separately at the provider if that is intended.',
  });
}
/** One transaction removes the vault row and related configuration and records
 * its receipt/audit. Never decrypt credentials or delete mutation/recovery history. */
export function disconnectLocalConnection(
  store: Store,
  actor: Actor,
  gateway: string,
  id: string,
  source: 'website' | 'mcp',
): JsonObject {
  return store.transaction(() => {
    access(store, actor);
    const c = find(store, actor, gateway, id);
    if (!c) {
      const replay = previous(store, actor, gateway, id);
      if (replay) return {...replay, replayed: true, already_disconnected: true};
      throw new MirrorError('CONNECTION_NOT_FOUND', 'No matching connection exists in this workspace.', {}, 404);
    }
    const details = impact(c),
      bindings = store.db
        .prepare('DELETE FROM resource_ownership WHERE tenant_id=? AND connection_id=?')
        .run(actor.tenantId, id).changes;
    const documents = store.db
      .prepare("DELETE FROM documents WHERE tenant_id=? AND id=? AND kind IN ('website_assets','website_connection')")
      .run(actor.tenantId, id).changes;
    store.db.prepare('DELETE FROM connections WHERE tenant_id=? AND id=?').run(actor.tenantId, id);
    const receipt = {
      success: true,
      executed: true,
      disconnected: true,
      ...details,
      local_changes: {connections: 1, resource_bindings: Number(bindings), discovery_documents: Number(documents)},
      network_requests: 0,
      provider_changes: 0,
      disconnected_at: Date.now(),
      disconnected_by: actor.userId,
    };
    store.putDocument(actor.tenantId, 'connection_disconnection', receiptId(gateway, id), receipt);
    store.appendAudit(actor.tenantId, randomUUID(), {
      event: source === 'website' ? 'website_local_disconnect' : 'mcp_local_disconnect',
      connection_id: id,
      gateway,
      source,
      local_changes: receipt.local_changes,
      vendor_writes: 0,
    });
    return receipt;
  });
}
/** Dry run is the default. Destructive execution always names a UUID explicitly;
 * neither a default identity nor an account ID can silently choose what to remove. */
export function connectionDisconnect(
  store: Store,
  gateway: string,
  operation: string,
  input: JsonObject,
  actor: Actor,
): JsonObject {
  access(store, actor);
  if (
    !connectionDisconnectKind(gateway, operation, input.action) ||
    Object.keys(input).some(k => !['action', 'connection_id', 'dry_run'].includes(k)) ||
    (input.dry_run !== undefined && typeof input.dry_run !== 'boolean')
  )
    throw new MirrorError(
      'INVALID_ARGUMENT',
      'Disconnect accepts only action, connection_id and dry_run. It never exchanges codes, refreshes tokens or calls the provider.',
    );
  const id = input.connection_id;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new MirrorError(
      'CONNECTION_ID_REQUIRED',
      'Disconnect requires the exact connection UUID; use status or Connections to select it. No default login is inferred.',
    );
  if (input.dry_run === false) return disconnectLocalConnection(store, actor, gateway, id, 'mcp');
  const c = find(store, actor, gateway, id);
  if (!c) {
    const replay = previous(store, actor, gateway, id);
    if (replay)
      return {
        success: true,
        executed: false,
        dry_run: true,
        already_disconnected: true,
        gateway,
        connection_id: id,
        network_requests: 0,
        local_changes: 0,
        provider_changes: 0,
      };
    throw new MirrorError('CONNECTION_NOT_FOUND', 'No matching connection exists in this workspace.', {}, 404);
  }
  return {
    success: true,
    executed: false,
    dry_run: true,
    ...impact(c),
    network_requests: 0,
    local_changes: 0,
    provider_changes: 0,
    next_call: {
      tool: gateway,
      arguments: {operation, arguments: {action: 'disconnect', connection_id: id, dry_run: false}},
    },
    next_action:
      'Confirm the named local disconnection with the user before sending dry_run:false. This is an immediate local administrative command, not an advertising write review.',
  };
}
