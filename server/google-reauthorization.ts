import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {NativeTransport} from '../src/transport.js';
import {MirrorError} from '../src/errors.js';
import {scopeKey} from '../src/security.js';
import {assetSyncDiagnostic} from '../src/report-errors.js';
import type {Actor, Connection, Credentials, JsonObject} from '../src/types.js';
import {googleAccountDiscovery} from './google-account-discovery.js';
import type {AssetGroup} from './asset-discovery.js';
import {googleAdsCustomers} from '../src/google-version.js';
import {storedLogin} from '../src/connection-authority.js';
import {recordAuthorized} from '../src/connection-health.js';
import {authorizationRevision} from './connection-reauthorization.js';
import {googleAdsScope} from '../src/provider-grants.js';

export {googleAdsScope};
/** Every platform's reauthorization revision lives in website_connection (server/connection-reauthorization.ts). */
export const googleAuthorizationRevision = authorizationRevision;
export function googleAuthorizationInfo(
  store: Store,
  c: Connection,
  configuredClientId: string | undefined,
): JsonObject {
  const saved = store.credentials(c.tenantId, c.id).clientId;
  // OAuth client IDs are public identifiers. No token, secret or raw credential object leaves this helper.
  const clientId =
    typeof saved === 'string' && /^[A-Za-z0-9.-]{1,250}\.apps\.googleusercontent\.com$/.test(saved) ? saved : null;
  return {
    clientId,
    matchesCurrentClient: saved && configuredClientId ? saved === configuredClientId : null,
    adsScopeRecorded: c.scopes.includes(googleAdsScope),
    reauthorizeAvailable: !!configuredClientId,
  };
}

/** Replace authorization only after fresh, read-only discovery verifies every retained account. */
export async function reauthorizeGoogleConnection(input: {
  store: Store;
  actor: Actor;
  connectionId: string;
  revision: string | null;
  credentials: Credentials;
  scopes: string[];
  allowWrites: boolean;
  assertActive: () => void;
  fetcher?: typeof fetch;
  /** The Google user the fresh ID token names, and their display name (CON-05). */
  providerId?: string;
  displayName?: string;
}): Promise<Connection> {
  const {store, actor, connectionId, revision, credentials, scopes, assertActive} = input;
  const saved = (): JsonObject => {
    try {
      const {
        id: _id,
        revision: _revision,
        ...data
      } = store.document(actor.tenantId, 'website_connection', connectionId);
      return data;
    } catch (e) {
      if (e instanceof MirrorError && e.code === 'NOT_FOUND') return {};
      throw e;
    }
  };
  const current = () => {
    assertActive();
    if (actor.role !== 'admin') throw new MirrorError('FORBIDDEN', 'A workspace administrator is required.', {}, 403);
    const c = store.listConnections(actor.tenantId).find(c => c.id === connectionId);
    if (!c || c.gateway !== 'google_ads_native_action')
      throw new MirrorError(
        'CONNECTION_NOT_FOUND',
        'This Google connection was removed. Start again from Connections.',
        {},
        404,
      );
    if (googleAuthorizationRevision(store, actor.tenantId, c.id) !== revision)
      throw new MirrorError(
        'CONNECTION_CHANGED',
        'This connection was already reauthorized. Start again from Connections.',
        {},
        409,
      );
    return c;
  };
  const c = current();
  const previousFingerprint = storedLogin(store, c);
  const check = () => {
    const latest = current();
    if (storedLogin(store, latest) !== previousFingerprint)
      throw new MirrorError(
        'CONNECTION_CHANGED',
        'The retained login changed during reauthorization. Start again; its current credentials were kept.',
        {},
        409,
      );
  };
  if (!scopes.includes(googleAdsScope))
    throw new MirrorError(
      'INSUFFICIENT_SCOPE',
      'Google Ads permission was not granted. Reauthorize and approve Google Ads access. Your existing connection was kept.',
      {},
      403,
    );
  if (!credentials.refreshToken)
    throw new MirrorError(
      'REAUTHORIZATION_REQUIRED',
      'Google did not return offline access. Reauthorize and approve consent again. Your existing connection was kept.',
      {},
      401,
    );
  // D19: a renewal by a different Google user is refused now that the ID token names the user (CON-05).
  const savedIdentity = typeof saved().providerId === 'string' && saved().providerId ? saved().providerId : undefined;
  if (savedIdentity && input.providerId && savedIdentity !== input.providerId)
    throw new MirrorError(
      'REAUTHORIZATION_IDENTITY_MISMATCH',
      'This authorization belongs to a different provider user than the saved login. Sign in as the original user, or connect the other user as a separate login. Your existing connection was kept.',
      {},
      403,
    );
  const transport = new NativeTransport(input.fetcher);
  if (!input.fetcher || input.fetcher === fetch) transport.coordination = store;
  let group: AssetGroup;
  try {
    group = await googleAccountDiscovery(transport, c, credentials, check);
  } catch (e) {
    check();
    throw new MirrorError(
      'REAUTHORIZATION_ACCESS_FAILED',
      'Fresh Google authorization could not read the account list. Your existing connection was kept.',
      {diagnostics: [assetSyncDiagnostic(e, 'google', c.id, 'ad_accounts')]},
      e instanceof MirrorError ? e.status : 502,
      e instanceof MirrorError && e.retryable,
    );
  }
  const visible = new Map(group.assets.map(a => [a.id, a]));
  // Inventory completeness and access to the selected accounts are separate.
  // Hierarchy membership alone is visibility evidence; verify each selected child
  // through its discovered manager route before replacing a working credential.
  for (const id of c.accounts) {
    check();
    const asset = visible.get(id);
    if (!asset || asset.readVerified) continue;
    const priorFailure = group.diagnostics?.find(d => d.account_id === id && d.request?.stage === 'account_lookup');
    if (priorFailure)
      throw new MirrorError(
        'REAUTHORIZATION_ACCESS_FAILED',
        'Fresh authorization could not verify a selected Google account. Your existing connection was kept.',
        {account_id: id, diagnostics: [priorFailure]},
        403,
      );
    try {
      const result = await transport.request(
        {
          gateway: c.gateway,
          action: 'AMCP_GOOGLE_SELECTED_VERIFICATION',
          method: 'POST',
          path: googleAdsCustomers + id + '/googleAds:search',
          query: {},
          body: {
            query: 'SELECT customer.id, customer.currency_code, customer.time_zone, customer.status FROM customer',
          },
          headers: {},
          readOnly: true,
          destructive: false,
          requiresConfirmation: false,
          evidence: 'SELECTED_ACCOUNT_VERIFICATION',
          warnings: [],
        },
        c,
        {...credentials, loginCustomerId: asset.loginCustomerId},
        undefined,
        {beforeAttempt: check},
      );
      check();
      const customer = (result.data as JsonObject)?.results?.[0]?.customer;
      if (String(customer?.id) !== id)
        throw new MirrorError('ASSET_RESPONSE_INVALID', 'Google did not verify the selected account.', {}, 502);
      Object.assign(asset, {
        readVerified: true,
        currency: customer.currencyCode ?? asset.currency,
        timezone: customer.timeZone ?? asset.timezone,
        status: customer.status ?? asset.status,
      });
    } catch (e) {
      check();
      throw new MirrorError(
        'REAUTHORIZATION_ACCESS_FAILED',
        'Fresh authorization could not verify a selected Google account. Your existing connection was kept.',
        {account_id: id, diagnostics: [assetSyncDiagnostic(e, 'google', c.id, 'ad_accounts', id)]},
        e instanceof MirrorError ? e.status : 502,
        e instanceof MirrorError && e.retryable,
      );
    }
  }
  // Use the same lock as token refresh, preventing a refresh started earlier from overwriting these credentials.
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
      const latest = current(),
        missing = latest.accounts.filter(id => !visible.get(id)?.readVerified);
      if (missing.length)
        throw new MirrorError(
          'REAUTHORIZATION_ACCOUNT_MISMATCH',
          'The selected Google login cannot access every account selected on this connection. Choose the original Google login, or add a separate login. Your existing connection was kept.',
          {account_ids: missing},
          403,
        );
      const next: Connection = {
        ...latest,
        scopes,
        accountLoginCustomers: Object.fromEntries(latest.accounts.map(id => [id, visible.get(id)!.loginCustomerId!])),
        writeAccounts: input.allowWrites ? latest.writeAccounts : [],
        defaultWriteAccess: input.allowWrites && latest.defaultWriteAccess === true,
      };
      const meta = saved();
      store.putConnection(actor, next, credentials);
      store.putDocument(actor.tenantId, 'website_connection', connectionId, {
        ...meta,
        platform: 'google',
        expiresAt: credentials.expiresAt ?? null,
        ...(meta.providerId || input.providerId ? {providerId: meta.providerId || input.providerId} : {}),
        ...(input.displayName ? {displayName: input.displayName} : {}),
        createdAt: meta.createdAt ?? Date.now(),
        reauthorizedAt: Date.now(),
        authorizationRevision: randomUUID(),
      });
      store.putDocument(actor.tenantId, 'website_assets', connectionId, {
        groups: [{...group, checkedAt: Date.now()}],
        selected: next.accounts.map(id => 'ad_accounts:' + id),
        lastSync: Date.now(),
        error: null,
      });
      store.appendAudit(actor.tenantId, randomUUID(), {
        event: 'website_oauth_reauthorized',
        platform: 'google',
        connection_id: connectionId,
        identity: meta.providerId && input.providerId ? 'matched' : input.providerId ? 'recorded' : 'unavailable',
        vendor_writes: 0,
      });
      // The stored record carries the bumped login revision (CON-01); its credential health starts clean (CON-02).
      const stored = store.listConnections(actor.tenantId).find(x => x.id === connectionId) ?? next;
      recordAuthorized(store, stored, credentials);
      return stored;
    });
  } finally {
    store.releaseLock(lock, owner);
  }
}
