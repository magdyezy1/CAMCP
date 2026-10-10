import {randomUUID} from 'node:crypto';
import {businessScope, businessDiscoveryOptions, collectBusinessAssets} from './google-business-assets.js';
import {MirrorError} from './errors.js';
import {scopeKey} from './security.js';
import type {Actor, JsonObject} from './types.js';
import type {Store} from './store.js';
import type {CredentialProvider} from './auth.js';
import type {NativeTransport} from './transport.js';
import {loginStamp, storedLogin} from './connection-authority.js';

const gateway = 'google_business_native_action',
  operation = 'gmb_connection_ops';
export const businessConnectionSyncKind = (g: string, op: string, action: unknown) =>
  g === gateway && op === operation && action === 'sync_assets';

/** Discovery changes metadata only. Native roles and parent membership never grant AMCP access. */
export async function syncBusinessConnection(
  store: Store,
  transport: NativeTransport,
  credentials: CredentialProvider,
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
  const allowed = [
    'action',
    'connection_id',
    'dry_run',
    'include_locations',
    'max_accounts',
    'max_locations_per_account',
    'read_mask',
  ];
  if (
    input.action !== 'sync_assets' ||
    Object.keys(input).some(k => !allowed.includes(k)) ||
    (input.dry_run !== undefined && typeof input.dry_run !== 'boolean')
  )
    throw new MirrorError(
      'INVALID_ARGUMENT',
      'Use discovery parameters only; OAuth codes, redirects and grant changes do not belong in synchronization.',
    );
  const options = businessDiscoveryOptions({
    includeLocations: input.include_locations,
    maxAccounts: input.max_accounts,
    maxLocationsPerAccount: input.max_locations_per_account,
    readMask: input.read_mask,
  });
  if (
    input.connection_id !== undefined &&
    (typeof input.connection_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.connection_id))
  )
    throw new MirrorError('CONNECTION_ID_REQUIRED', 'Select the connection UUID.');
  const choices = store.listConnections(actor.tenantId).filter(c => c.gateway === gateway),
    defaults = choices.filter(c => c.enabled && c.isDefault);
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
      'Select an existing Business Profile connection in this workspace; no Google login is inferred.',
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
      provider_changes: 0,
      network_requests: 0,
      local_changes: 0,
      effective_read_mask: options.readMask,
      locations_included: options.includeLocations,
      limits: {accounts: options.maxAccounts, locations_per_account: options.maxLocationsPerAccount},
      effect:
        'Read the selected login and replace only completely validated discovery groups. Existing account selections and write grants are preserved.',
      next_call: {tool: gateway, arguments: {operation, arguments: {...input, connection_id: id, dry_run: false}}},
    };
  const scope = () => {
    const c = current();
    if (!c.scopes.includes(businessScope))
      throw new MirrorError(
        'INSUFFICIENT_SCOPE',
        'The selected connection lacks the recorded Business Profile discovery scope.',
        {required: businessScope},
        403,
      );
    return c;
  };
  scope();
  const lock = 'business-sync:' + scopeKey(actor.tenantId, id),
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
  const before = previous(),
    kinds = ['business_accounts', ...(options.includeLocations ? ['locations'] : [])];
  let fingerprint: string | undefined,
    attempts = 0;
  const access = (checkTime = true) => {
    const c = scope();
    if (checkTime && performance.now() >= deadline)
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
      throw new MirrorError('CONNECTION_CHANGED', 'The selected login changed during discovery.', {}, 409);
    return c;
  };
  try {
    fingerprint = storedLogin(store, connection);
    const token = await credentials.get(connection);
    fingerprint = loginStamp(token);
    access();
    const result = await collectBusinessAssets(
      async plan => {
        const c = access();
        const out = await transport.request(plan, c, token, undefined, {
          beforeAttempt: () => {
            access();
            if (++attempts > 250)
              throw new MirrorError(
                'ASSET_SYNC_LIMIT',
                'Discovery exceeded 250 native HTTP attempts, including retries. Prior metadata was retained.',
                {},
                409,
              );
          },
        });
        access();
        return out.data;
      },
      {...options, deadline},
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
      const groups = (latest?.groups ?? []).filter((g: JsonObject) => !kinds.includes(g.kind)),
        checkedAt = Date.now();
      groups.push({kind: 'business_accounts', assets: result.accounts, complete: true, checkedAt});
      if (options.includeLocations)
        groups.push({
          kind: 'locations',
          assets: result.locations,
          complete: true,
          checkedAt,
          effectiveReadMask: result.effective_read_mask,
        });
      const record = store.putDocument(actor.tenantId, 'website_assets', id, {
        ...latest,
        groups,
        selected:
          latest?.selected ??
          c.accounts.map(x => (x.startsWith('locations/') ? 'locations:' : 'business_accounts:') + x),
        lastSync: checkedAt,
        lastAttemptAt: checkedAt,
        error: null,
      });
      store.appendAudit(actor.tenantId, requestId, {
        event: 'business_connection_synced',
        gateway,
        connection_id: id,
        accounts: result.accounts.length,
        locations: options.includeLocations ? result.locations.length : null,
        requests: result.requests,
        native_http_attempts: attempts,
        provider_changes: 0,
        grant_changes: 0,
      });
      return record;
    });
    const discovered = new Set([...result.accounts, ...result.locations].map(a => a.id));
    return {
      ...result,
      native_http_attempts: attempts,
      executed: true,
      dry_run: false,
      connection_id: id,
      revision: saved.revision,
      provider_changes: 0,
      grant_changes: 0,
      selection_preserved: true,
      missing_selected_ids: current().accounts.filter(
        x => (options.includeLocations || !x.startsWith('locations/')) && !discovered.has(x),
      ),
      unchecked_selected_ids: options.includeLocations
        ? []
        : current().accounts.filter(x => x.startsWith('locations/')),
    };
  } catch (e) {
    // Expired work may mark retained rows stale, but cannot overwrite a newer login, selection or lease.
    try {
      store.transaction(() => {
        access(false);
        const latest = previous();
        if (latest?.revision !== before?.revision) return;
        const code = e instanceof MirrorError ? e.code : 'ASSET_SYNC_FAILED',
          error = 'Discovery failed (' + code + '). Prior metadata is retained and must not be treated as fresh.',
          groups = (latest?.groups ?? []).filter((g: JsonObject) => !kinds.includes(g.kind));
        for (const kind of kinds) {
          const old = (latest?.groups ?? []).find((g: JsonObject) => g.kind === kind);
          groups.push({...old, kind, assets: old?.assets ?? [], complete: false, error, retained_previous: true});
        }
        store.putDocument(actor.tenantId, 'website_assets', id, {...latest, groups, error, lastAttemptAt: Date.now()});
      });
    } catch {
      /* Revoked authority and stale work cannot modify newer metadata. */
    }
    throw e;
  } finally {
    store.releaseLock(lock, lease);
  }
}
