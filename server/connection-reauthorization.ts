import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {MirrorError} from '../src/errors.js';
import {scopeKey} from '../src/security.js';
import {assetSyncDiagnostic} from '../src/report-errors.js';
import {storedLogin} from '../src/connection-authority.js';
import {recordAuthorized, renewsAutomatically} from '../src/connection-health.js';
import {missingScopes, providerGrant, recordedWriteGrant} from '../src/provider-grants.js';
import type {Actor, Connection, Credentials, JsonObject} from '../src/types.js';
import type {AssetDiscovery, AssetGroup} from './asset-discovery.js';
import {selectableKinds, selectionKind, type PlatformDefinition} from './platform-oauth.js';

/** The revision a reauthorization starts from; every completed reauthorization replaces it (website_connection). */
export function authorizationRevision(store: Store, tenant: string, id: string): string | null {
  try {
    return store.document(tenant, 'website_connection', id).authorizationRevision ?? null;
  } catch (e) {
    if (e instanceof MirrorError && e.code === 'NOT_FOUND') return null;
    throw e;
  }
}

/**
 * In-place reauthorization is on for every browser-OAuth platform. `AMCP_REAUTHORIZATION_DISABLED` lists platform IDs
 * (for example `meta,linkedin`, or `all`) for which it is turned off again, restoring "Connect another" as the only
 * path. Credentials are replaced only after verification, so turning a platform off is always safe.
 */
export function reauthorizationEnabled(p: PlatformDefinition, env: NodeJS.ProcessEnv = process.env): boolean {
  if (p.authType) return false;
  const disabled = (env.AMCP_REAUTHORIZATION_DISABLED ?? '')
    .split(/[ ,]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return !disabled.includes(p.id) && !disabled.includes('all');
}

const document = (store: Store, tenant: string, kind: string, id: string): JsonObject => {
  try {
    const {id: _id, revision: _revision, ...data} = store.document(tenant, kind, id);
    return data;
  } catch (e) {
    if (e instanceof MirrorError && e.code === 'NOT_FOUND') return {};
    throw e;
  }
};
const idOf = (key: string) => key.slice(key.indexOf(':') + 1);
/** The selection keys a connection grants now: saved keys still granted, or its accounts under the primary kind. */
const grantedKeys = (assets: JsonObject, c: Connection) =>
  Array.isArray(assets.selected)
    ? (assets.selected as string[]).filter(k => typeof k === 'string' && c.accounts.includes(idOf(k)))
    : c.accounts.map(id => selectionKind(c.gateway) + ':' + id);

/**
 * Renew a saved browser-OAuth login in place (CON-02), for every platform except Google Ads, which keeps its own
 * manager-route verification (server/google-reauthorization.ts). The fresh authorization replaces the saved one only
 * after read-only discovery with the candidate credentials shows every selected account, the provider identity
 * matches where the provider states one (owner decision D19), and offline access is kept. The connection ID,
 * selections, saved reports, schedules and default flag stay; write grants stay only while the recorded scopes and
 * deployment still allow writes, and any removal is audited. The replacement shares the token-refresh lock and bumps
 * the login revision, so a refresh or request still bound to the previous login cannot overwrite or reuse it.
 */
export async function reauthorizeConnection(input: {
  store: Store;
  actor: Actor;
  platform: PlatformDefinition;
  connectionId: string;
  revision: string | null;
  credentials: Credentials;
  scopes: string[];
  providerId?: string;
  loginExpiresAt?: number | null;
  allowWrites: boolean;
  assertActive: () => void;
  discovery: Pick<AssetDiscovery, 'discoverWith'>;
}): Promise<Connection> {
  const {store, actor, platform: p, connectionId, revision, credentials, scopes, assertActive} = input;
  const current = () => {
    assertActive();
    if (actor.role !== 'admin') throw new MirrorError('FORBIDDEN', 'A workspace administrator is required.', {}, 403);
    const c = store.listConnections(actor.tenantId).find(c => c.id === connectionId);
    if (!c || c.gateway !== p.gateway)
      throw new MirrorError(
        'CONNECTION_NOT_FOUND',
        'This connection was removed. Start again from Connections.',
        {},
        404,
      );
    if (authorizationRevision(store, actor.tenantId, c.id) !== revision)
      throw new MirrorError(
        'CONNECTION_CHANGED',
        'This connection was already reauthorized. Start again from Connections.',
        {},
        409,
      );
    return c;
  };
  const c = current(),
    previous = store.connectionCredentials(c),
    login = storedLogin(store, c);
  const check = () => {
    if (storedLogin(store, current()) !== login)
      throw new MirrorError(
        'CONNECTION_CHANGED',
        'The retained login changed during reauthorization. Start again; its current credentials were kept.',
        {},
        409,
      );
  };
  const grant = providerGrant(p.gateway),
    missing = grant?.read ? missingScopes(grant.read, scopes) : [];
  if (missing.length)
    throw new MirrorError(
      'INSUFFICIENT_SCOPE',
      'The fresh authorization did not grant the permission this connection reads with. Reauthorize and approve it. Your existing connection was kept.',
      {required_scopes: missing},
      403,
    );
  if (renewsAutomatically(p.gateway, previous) && !renewsAutomatically(p.gateway, credentials))
    throw new MirrorError(
      'REAUTHORIZATION_REQUIRED',
      'The provider did not return renewable offline access. Reauthorize and approve consent again. Your existing connection was kept.',
      {},
      401,
    );
  const selectedKeys = grantedKeys(document(store, actor.tenantId, 'website_assets', c.id), c),
    kinds = selectableKinds(p.gateway).filter((kind, i) => i === 0 || selectedKeys.some(k => k.startsWith(kind + ':')));
  let found: {groups: AssetGroup[]; identity?: string};
  try {
    found = await input.discovery.discoverWith(c, credentials, kinds, check);
  } catch (e) {
    check();
    throw new MirrorError(
      'REAUTHORIZATION_ACCESS_FAILED',
      'The fresh authorization could not read the account list. Your existing connection was kept.',
      {diagnostics: [assetSyncDiagnostic(e, p.id, c.id, kinds[0]!)]},
      e instanceof MirrorError ? e.status : 502,
      e instanceof MirrorError && e.retryable,
    );
  }
  check();
  // A fresh login whose primary listing failed outright proves nothing, even when no account is selected yet.
  const primary = found.groups.find(g => g.kind === kinds[0]);
  if (!primary || (!primary.complete && !primary.assets.length))
    throw new MirrorError(
      'REAUTHORIZATION_ACCESS_FAILED',
      'The fresh authorization could not read the account list. Your existing connection was kept.',
      {diagnostics: primary?.diagnostics ?? []},
      403,
    );
  // D19: a renewal by a different provider user is refused where the provider states the user.
  const saved = document(store, actor.tenantId, 'website_connection', c.id),
    savedIdentity = typeof saved.providerId === 'string' && saved.providerId ? saved.providerId : undefined,
    identity = input.providerId || found.identity || undefined;
  if (savedIdentity && identity && savedIdentity !== identity)
    throw new MirrorError(
      'REAUTHORIZATION_IDENTITY_MISMATCH',
      'This authorization belongs to a different provider user than the saved login. Sign in as the original user, or connect the other user as a separate login. Your existing connection was kept.',
      {},
      403,
    );
  const visible = new Set(found.groups.flatMap(g => g.assets.map(a => a.kind + ':' + a.id)));
  const verify = (keys: string[]) => {
    const absent = keys.filter(k => !visible.has(k));
    if (!absent.length) return;
    const incomplete = found.groups.filter(g => !g.complete);
    if (incomplete.length)
      throw new MirrorError(
        'REAUTHORIZATION_ACCESS_FAILED',
        'The fresh authorization could not confirm every selected account. Your existing connection was kept.',
        {account_ids: absent.map(idOf), diagnostics: incomplete.flatMap(g => g.diagnostics ?? [])},
        403,
      );
    throw new MirrorError(
      'REAUTHORIZATION_ACCOUNT_MISMATCH',
      'The authorized login cannot access every account selected on this connection. Choose the original login, or add a separate login. Your existing connection was kept.',
      {account_ids: absent.map(idOf)},
      403,
    );
  };
  verify(selectedKeys);
  // Use the same lock as token refresh, so a refresh started earlier cannot overwrite the new credentials.
  const lock = 'refresh:' + scopeKey(actor.tenantId, connectionId),
    owner = randomUUID();
  if (!store.acquireLock(lock, owner, 45000))
    throw new MirrorError(
      'REFRESH_IN_PROGRESS',
      'This connection is refreshing. Start reauthorization again shortly; the existing connection was kept.',
      {},
      409,
      true,
    );
  try {
    return store.transaction(() => {
      check();
      // Selections may have narrowed while the provider was asked; the renewal keeps exactly what is granted now.
      const latest = current(),
        assets = document(store, actor.tenantId, 'website_assets', c.id),
        keys = grantedKeys(assets, latest);
      verify(keys);
      const writable =
          input.allowWrites && p.reviewedWrites !== false && recordedWriteGrant({gateway: p.gateway, scopes}) !== false,
        accountsGroup = found.groups.find(g => g.kind === selectionKind(p.gateway)),
        next: Connection = {
          ...latest,
          scopes,
          writeAccounts: writable ? (latest.writeAccounts ?? []) : [],
          defaultWriteAccess: writable && latest.defaultWriteAccess === true,
          ...(latest.accountCustomers && accountsGroup
            ? {
                accountCustomers: Object.fromEntries(
                  latest.accounts.map(id => [
                    id,
                    accountsGroup.assets.find(a => a.id === id)?.parentId ?? latest.accountCustomers![id]!,
                  ]),
                ),
              }
            : {}),
        },
        removed = (latest.writeAccounts ?? []).filter(id => !(next.writeAccounts ?? []).includes(id));
      store.putConnection(actor, next, credentials);
      const stored = store.listConnections(actor.tenantId).find(x => x.id === connectionId)!;
      store.putDocument(actor.tenantId, 'website_connection', connectionId, {
        ...saved,
        platform: p.id,
        expiresAt: credentials.expiresAt ?? null,
        providerId: savedIdentity ?? identity ?? null,
        createdAt: saved.createdAt ?? Date.now(),
        reauthorizedAt: Date.now(),
        authorizationRevision: randomUUID(),
      });
      const groups: AssetGroup[] = [...((assets.groups as AssetGroup[] | undefined) ?? [])];
      for (const group of found.groups) {
        const index = groups.findIndex(g => g.kind === group.kind),
          fresh = {...group, checkedAt: Date.now()};
        if (index >= 0) groups[index] = fresh;
        else groups.push(fresh);
      }
      store.putDocument(actor.tenantId, 'website_assets', connectionId, {
        ...assets,
        groups,
        selected: keys,
        lastSync: Date.now(),
        error: null,
      });
      recordAuthorized(store, stored, credentials, input.loginExpiresAt);
      store.appendAudit(actor.tenantId, randomUUID(), {
        event: 'website_oauth_reauthorized',
        platform: p.id,
        connection_id: connectionId,
        identity: savedIdentity && identity ? 'matched' : identity ? 'recorded' : 'unavailable',
        vendor_writes: 0,
      });
      if (removed.length)
        store.appendAudit(actor.tenantId, randomUUID(), {
          event: 'website_write_access_changed',
          connection_id: connectionId,
          write_accounts: next.writeAccounts ?? [],
          previous_write_accounts: latest.writeAccounts ?? [],
          reason: 'reauthorization_without_write_permission',
          vendor_writes: 0,
        });
      return stored;
    });
  } finally {
    store.releaseLock(lock, owner);
  }
}
