import {randomUUID} from 'node:crypto';
import {collectMeasurementAssets, measurementScopes} from './google-measurement-assets.js';
import {MirrorError} from './errors.js';
import {scopeKey} from './security.js';
import type {Actor, JsonObject} from './types.js';
import type {Store} from './store.js';
import type {CredentialProvider} from './auth.js';
import type {NativeTransport} from './transport.js';
import {loginStamp, storedLogin} from './connection-authority.js';

export const measurementConnectionSyncKind = (gateway: string, operation: string, action: unknown) =>
  (gateway === 'ga4_native_action' &&
    operation === 'ga4_sync_properties' &&
    (action === undefined || action === 'ga4_sync_properties')) ||
  (gateway === 'google_search_console_native_action' && operation === 'gsc_connection_ops' && action === 'sync_sites');
export async function syncMeasurementConnection(
  store: Store,
  transport: NativeTransport,
  credentials: CredentialProvider,
  gateway: string,
  operation: string,
  input: JsonObject,
  actor: Actor,
  requestId: string,
) {
  const authority = () => {
    store.assertActorActive(actor);
    if (actor.role !== 'admin')
      throw new MirrorError(
        'FORBIDDEN',
        'Only a workspace administrator can synchronize connection discovery.',
        {},
        403,
      );
  };
  authority();
  const ga4 = gateway === 'ga4_native_action',
    kind = ga4 ? 'properties' : 'sites',
    allowed = ga4
      ? ['connection_id', 'include_details', 'max_pages', 'dry_run']
      : ['action', 'connection_id', 'dry_run'];
  if (
    !measurementConnectionSyncKind(gateway, operation, input.action) ||
    Object.keys(input).some(k => !allowed.includes(k)) ||
    (input.dry_run !== undefined && typeof input.dry_run !== 'boolean') ||
    (input.include_details !== undefined && typeof input.include_details !== 'boolean') ||
    (input.max_pages !== undefined &&
      (!Number.isInteger(input.max_pages) || input.max_pages < 1 || input.max_pages > 50))
  )
    throw new MirrorError(
      'INVALID_ARGUMENT',
      'Use the discovered synchronization parameters; OAuth codes, redirects and grant changes do not belong in discovery.',
    );
  if (
    input.connection_id !== undefined &&
    (typeof input.connection_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.connection_id))
  )
    throw new MirrorError('CONNECTION_ID_REQUIRED', 'Select the connection UUID.');
  const choices = store.listConnections(actor.tenantId).filter(c => c.gateway === gateway),
    defaults = choices.filter(c => c.isDefault && c.enabled);
  const connection = input.connection_id
    ? choices.find(c => c.id === input.connection_id)
    : choices.length === 1
      ? choices[0]
      : defaults.length === 1
        ? defaults[0]
        : undefined;
  if (!connection)
    throw new MirrorError(
      input.connection_id || !choices.length ? 'CONNECTION_NOT_FOUND' : 'AMBIGUOUS_CONNECTION',
      'Select an existing connection in this workspace; no Google login is inferred.',
      {},
      input.connection_id || !choices.length ? 404 : 409,
    );
  const id = connection.id,
    current = () => {
      authority();
      const c = store.listConnections(actor.tenantId).find(c => c.id === id && c.gateway === gateway);
      if (!c) throw new MirrorError('CONNECTION_CHANGED', 'The selected connection was removed or changed.', {}, 409);
      return c;
    };
  if (input.dry_run !== false)
    return {
      dry_run: true,
      executed: false,
      connection_id: id,
      kind,
      provider_changes: 0,
      network_requests: 0,
      local_changes: 0,
      effect:
        'Read the selected login and replace its discovery metadata only after complete validation. Existing AMCP account selections and write grants are preserved.',
      next_call: {tool: gateway, arguments: {operation, arguments: {...input, connection_id: id, dry_run: false}}},
    };
  const scope = () => {
    const c = current();
    if (!measurementScopes[gateway]!.some(s => c.scopes.includes(s)))
      throw new MirrorError(
        'INSUFFICIENT_SCOPE',
        'The selected connection lacks the recorded Google discovery scope.',
        {required_any: measurementScopes[gateway]},
        403,
      );
    return c;
  };
  scope();
  const lock = 'measurement-sync:' + scopeKey(actor.tenantId, id),
    lease = randomUUID(),
    deadline = performance.now() + 60000;
  if (!store.acquireLock(lock, lease, 120000))
    throw new MirrorError(
      'ASSET_SYNC_IN_PROGRESS',
      'Another worker is synchronizing this connection. Wait for its result.',
      {retry_after_ms: 1000},
      409,
      true,
    );
  const previous = () => {
    try {
      return store.document(actor.tenantId, 'website_assets', id);
    } catch (e) {
      if (e instanceof MirrorError && e.code === 'NOT_FOUND') return undefined;
      throw e;
    }
  };
  const before = previous();
  let fingerprint: string | undefined;
  const access = () => {
    const c = scope();
    if (performance.now() >= deadline)
      throw new MirrorError(
        'ASSET_SYNC_LIMIT',
        'Discovery exceeded its time limit; previous metadata was retained.',
        {},
        409,
      );
    if (
      !store.db
        .prepare('SELECT key FROM service_locks WHERE key=? AND owner=? AND expires_at>?')
        .get(lock, lease, Date.now())
    )
      throw new MirrorError(
        'ASSET_SYNC_CHANGED',
        'This synchronization no longer owns its lease. Read the latest discovery result.',
        {},
        409,
      );
    if (fingerprint !== undefined && storedLogin(store, c) !== fingerprint)
      throw new MirrorError(
        'CONNECTION_CHANGED',
        'The selected login changed during discovery. Its previous metadata was retained.',
        {},
        409,
      );
    return c;
  };
  try {
    fingerprint = storedLogin(store, connection);
    const token = await credentials.get(connection);
    fingerprint = loginStamp(token);
    access();
    const result = await collectMeasurementAssets(
      gateway,
      async plan => {
        const c = access();
        const out = await transport.request({...plan, measurementSyncDeadline: deadline}, c, token, undefined, {
          beforeAttempt: () => {
            access();
          },
        });
        access();
        return out.data;
      },
      {maxPages: input.max_pages ?? 10, includeDetails: input.include_details === true, deadline},
    );
    const saved = store.transaction(() => {
      const c = access(),
        latest = previous();
      if (latest?.revision !== before?.revision)
        throw new MirrorError(
          'ASSET_SYNC_CHANGED',
          'Discovery metadata or selection changed during synchronization. Your newer changes were retained; retry discovery.',
          {},
          409,
        );
      const groups = (latest?.groups ?? []).filter((g: JsonObject) => g.kind !== kind),
        checkedAt = Date.now();
      groups.push({
        kind,
        assets: result.assets,
        complete: true,
        checkedAt,
        excludedUnverified: result.excluded_unverified,
      });
      const record = store.putDocument(actor.tenantId, 'website_assets', id, {
        ...latest,
        groups,
        selected: latest?.selected ?? c.accounts.map(x => kind + ':' + x),
        lastSync: checkedAt,
        lastAttemptAt: checkedAt,
        error: null,
      });
      store.appendAudit(actor.tenantId, requestId, {
        event: 'measurement_connection_synced',
        gateway,
        connection_id: id,
        assets: result.assets.length,
        requests: result.requests,
        provider_changes: 0,
        grant_changes: 0,
      });
      return record;
    });
    return {
      ...result,
      executed: true,
      dry_run: false,
      connection_id: id,
      kind,
      revision: saved.revision,
      provider_changes: 0,
      grant_changes: 0,
      selection_preserved: true,
      reportability: 'Not verified by discovery. Native access and AMCP grants are separate.',
      missing_selected_ids: current().accounts.filter(x => !result.assets.some(a => a.id === x)),
    };
  } catch (e) {
    // Retain prior rows but mark them stale. Never overwrite another sync, selection or login.
    try {
      store.transaction(() => {
        access();
        const latest = previous();
        if (latest?.revision !== before?.revision) return;
        const code = e instanceof MirrorError ? e.code : 'ASSET_SYNC_FAILED',
          error = 'Discovery failed (' + code + '). Prior metadata is retained and must not be treated as fresh.';
        const groups = (latest?.groups ?? []).filter((g: JsonObject) => g.kind !== kind),
          old = (latest?.groups ?? []).find((g: JsonObject) => g.kind === kind);
        groups.push({...old, kind, assets: old?.assets ?? [], complete: false, error, retained_previous: true});
        store.putDocument(actor.tenantId, 'website_assets', id, {...latest, groups, error, lastAttemptAt: Date.now()});
      });
    } catch {
      /* Revoked authority or a stale lease may not change newer metadata. */
    }
    throw e;
  } finally {
    store.releaseLock(lock, lease);
  }
}
