import {randomUUID} from 'node:crypto';
import {accountKey} from '../src/access-sets.js';
import {clientViews} from '../src/client-scope.js';
import {credentialHealth} from '../src/connection-health.js';
import {MirrorError} from '../src/errors.js';
import {providerOf} from '../src/provider-adapters.js';
import {grantedScopes, publicGrants} from '../src/provider-grants.js';
import {providerJobGateways, reportJobAccounts} from '../src/provider-jobs.js';
import {providerLogin} from '../src/provider-logins.js';
import {stable} from '../src/security.js';
import type {Store} from '../src/store.js';
import type {Actor, Connection, Credentials, JsonObject} from '../src/types.js';
import {connectedAt} from './account-lifecycle.js';
import type {AssetDiscovery, AssetGroup} from './asset-discovery.js';
import {authorizationRevision, reauthorizationEnabled} from './connection-reauthorization.js';
import {googleAuthorizationInfo} from './google-reauthorization.js';
import {
  loginLabel,
  platform,
  platforms,
  providerDisplayName,
  selectableKinds,
  selectionKind,
  type PlatformDefinition,
  type PlatformOAuth,
} from './platform-oauth.js';
import type {WebStore, WebsiteOptions} from './web-store.js';
import {writeConnectionLabel} from './website-repository.js';
import {googleAdsGateway} from './website-site.js';

/**
 * The website's views of a workspace's logins (ARC-04 stage D, moved from createWebsite): a login by ID, its saved
 * asset selection and website record, its public view (status, credential health, grants, renewal), the logins and
 * working clients a person may see, and the asset sync that refreshes a login's inventory. The route modules of
 * server/website.ts share one set, built once per website.
 */
export function connectionViews(
  store: Store,
  web: WebStore,
  options: WebsiteOptions,
  oauth: PlatformOAuth,
  discovery: AssetDiscovery,
  reviewerLifetime: number | null,
) {
  const connection = (tenant: string, id: string) => {
    const c = store.listConnections(tenant).find(c => c.id === id);
    if (!c) throw new MirrorError('CONNECTION_NOT_FOUND', 'The connection was not found in this workspace.', {}, 404);
    return c;
  };
  const readDocument = (tenant: string, kind: string, id: string, fallback: JsonObject = {}) => {
    try {
      return store.document(tenant, kind, id);
    } catch (e) {
      if (e instanceof MirrorError && e.code === 'NOT_FOUND') return fallback;
      throw e;
    }
  };
  const savedAssets = (tenant: string, c: Connection) => {
    const kind = selectionKind(c.gateway);
    return readDocument(tenant, 'website_assets', c.id, {
      groups: [
        {kind, complete: false, assets: c.accounts.map(id => ({id, kind, name: id, source: 'configured_binding'}))},
      ],
      selected: c.accounts.map(id => kind + ':' + id),
      lastSync: null,
    });
  };
  /**
   * Another saved login of this platform authorized by the same provider user (CON-05), when the provider states the
   * user: renewing that login keeps its work, while a second login of one user makes requests ambiguous.
   */
  const sameIdentity = (tenant: string, gateway: string, providerId: unknown, except: string) =>
    typeof providerId === 'string' && providerId
      ? store
          .listConnections(tenant)
          .find(
            x =>
              x.gateway === gateway &&
              x.id !== except &&
              readDocument(tenant, 'website_connection', x.id, {}).providerId === providerId,
          )?.id
      : undefined;
  /** Only the label changes: the stored login revision and grants stay as they are now (CON-01). */
  const writeLabel = (tenant: string, id: string, label: string) => writeConnectionLabel(store, tenant, id, label);
  /** The platform whose browser OAuth renews this connection in place, when reauthorization is available (CON-02). */
  const renewal = (c: Connection) => {
    const p = platforms.find(p => p.gateway === c.gateway);
    return p && reauthorizationEnabled(p, options.authEnv ?? process.env) && oauth.config(p).configured ? p : undefined;
  };
  /**
   * The saved credentials, or why they cannot be read. Only a login whose secret is genuinely gone or must be
   * re-provisioned needs reauthorization; a missing or changed encryption key (or any other server-side failure) makes
   * every login unreadable at once and is the deployment administrator's to fix, so it is not shown as a dead login.
   */
  const readableCredentials = (
    tenant: string,
    c: Connection,
  ): {saved?: Credentials; unreadable?: 'reauthorize' | 'operator'} => {
    try {
      return {saved: store.credentials(tenant, c.id)};
    } catch (e) {
      return {
        unreadable: e instanceof MirrorError && e.code === 'REAUTHORIZATION_REQUIRED' ? 'reauthorize' : 'operator',
      };
    }
  };
  // A login's public view and its asset sync are their own steps (ARC-04), given the parts they read.
  const parts: ViewParts = {
    store,
    web,
    oauth,
    discovery,
    reviewerLifetime,
    connection,
    readDocument,
    savedAssets,
    sameIdentity,
    writeLabel,
    renewal,
    readableCredentials,
  };
  const publicConnection = publicConnectionView(parts);
  /**
   * A login as this person may see it (SEC-08): for access limited to a client access set, only the set's accounts of
   * the login (Store.connectionsFor) and only those discovered assets; Pages, catalogs and other accounts stay out.
   */
  const actorConnections = (actor: Actor) => store.connectionsFor(actor);
  /**
   * The working clients a person may choose (SEC-08 phase 1): client profiles with their accounts within current
   * access, unless a required two-step setup is pending (SEC-06).
   */
  const workingClientChoices = (actor: Actor): JsonObject[] =>
    actor.mfaEnrollmentRequired === true ? [] : clientViews(store, actor).map(({has: _has, ...client}) => client);
  const actorConnection = (actor: Actor, id: string) => {
    const c = actorConnections(actor).find(c => c.id === id);
    if (!c) throw new MirrorError('CONNECTION_NOT_FOUND', 'The connection was not found in this workspace.', {}, 404);
    return c;
  };
  const visibleConnection = (actor: Actor, c: Connection) => {
    const view = publicConnection(actor.tenantId, c);
    if (actor.accessSetId === undefined) return view;
    const kinds = selectableKinds(c.gateway),
      inSet = (id: unknown) => c.accounts.some(a => accountKey(c.gateway, a) === accountKey(c.gateway, id));
    return {
      ...view,
      duplicateOf: null,
      selected: view.selected.filter((s: string) =>
        kinds.some(kind => s.startsWith(kind + ':') && inSet(s.slice(kind.length + 1))),
      ),
      groups: view.groups
        .filter((g: JsonObject) => kinds.includes(g.kind))
        .map((g: JsonObject) => ({...g, assets: (g.assets ?? []).filter((a: JsonObject) => inSet(a.id))})),
    };
  };
  const sync = assetSync(parts, publicConnection);
  return {
    connection,
    readDocument,
    savedAssets,
    sameIdentity,
    writeLabel,
    renewal,
    readableCredentials,
    publicConnection,
    actorConnections,
    workingClientChoices,
    actorConnection,
    visibleConnection,
    sync,
  };
}
export type ConnectionViews = ReturnType<typeof connectionViews>;

/** What a login's public view and its asset sync read: the website's parts and the login views they share. */
interface ViewParts {
  store: Store;
  web: WebStore;
  oauth: PlatformOAuth;
  discovery: AssetDiscovery;
  reviewerLifetime: number | null;
  connection: (tenant: string, id: string) => Connection;
  readDocument: (tenant: string, kind: string, id: string, fallback?: JsonObject) => JsonObject;
  savedAssets: (tenant: string, c: Connection) => JsonObject;
  sameIdentity: (tenant: string, gateway: string, providerId: unknown, except: string) => string | undefined;
  writeLabel: (tenant: string, id: string, label: string) => unknown;
  renewal: (c: Connection) => PlatformDefinition | undefined;
  readableCredentials: (
    tenant: string,
    c: Connection,
  ) => {saved?: Credentials; unreadable?: 'reauthorize' | 'operator'};
}

/**
 * A login's public view: its status, credential health, grants, renewal, asset selection and synced groups. Metadata
 * only: no token, secret or raw credential object leaves it.
 */
function publicConnectionView({
  store,
  web,
  oauth,
  reviewerLifetime,
  savedAssets,
  readDocument,
  renewal,
  readableCredentials,
}: ViewParts) {
  return (tenant: string, c: Connection) => {
    const assets = savedAssets(tenant, c),
      p = platforms.find(p => p.gateway === c.gateway),
      // Metadata only: no token, secret or raw credential object leaves this function.
      {saved, unreadable} = readableCredentials(tenant, c),
      configuredClient = p && !p.authType ? oauth.config(p).clientId : undefined,
      health = credentialHealth(store, c, saved ?? {}, {
        clientChanged: !!(saved?.clientId && configuredClient && saved.clientId !== configuredClient),
      });
    // A legacy login that must be re-provisioned can only be replaced by a new authorization; one this server cannot
    // open (its encryption key is missing or changed) needs the deployment administrator, not every person's reconnect.
    if (unreadable === 'reauthorize') health.state = 'reauthorization_required';
    else if (unreadable === 'operator') health.state = 'credentials_unreadable';
    const dead = health.state === 'reauthorization_required',
      record = readDocument(tenant, 'website_connection', c.id, {}),
      duplicateOf =
        typeof record.duplicateOf === 'string' && store.listConnections(tenant).some(x => x.id === record.duplicateOf)
          ? record.duplicateOf
          : null;
    return {
      id: c.id,
      name: c.label,
      // The provider user's display name, when the provider stated one; never its subject identifier (CON-05).
      identity: typeof record.displayName === 'string' ? {name: record.displayName} : null,
      duplicateOf,
      enabled: c.enabled,
      isDefault: c.isDefault === true,
      defaultWriteAccess: c.defaultWriteAccess === true,
      accounts: c.accounts,
      writeAccounts: (c.writeAccounts ?? []).filter(id => c.accounts.includes(id)),
      // RPT-06: whether this provider has report or export job families, and the accounts granted report jobs.
      reportJobsAvailable: providerJobGateways.includes(c.gateway),
      reportJobAccounts: reportJobAccounts(store, c),
      // The login's own expiry: null while AMCP renews access automatically (CON-02).
      expiresAt: health.login_expires_at,
      credentialHealth: health,
      // What the provider confirmed it granted, including declined Meta permissions (CON-03); names and dates only.
      grants: publicGrants(record.grants),
      // A reviewer workspace login says when it was connected and when it is removed (SEC-06 S6).
      ...(tenant === web.testTenantId && reviewerLifetime !== null
        ? (at => ({connectedAt: at || null, reviewerRemovesAt: at ? at + reviewerLifetime : Date.now()}))(
            connectedAt(store, tenant, c.id),
          )
        : {}),
      reauthorizeAvailable: !!renewal(c),
      lastSync: assets.lastSync ?? null,
      error: assets.error ?? null,
      selected: assets.selected ?? [],
      groups: assets.groups ?? [],
      status: dead
        ? 'reauthorization_required'
        : assets.error || health.state === 'credentials_unreadable'
          ? 'attention'
          : !c.enabled
            ? 'selection_required'
            : health.state === 'expiring'
              ? 'expiring_soon'
              : 'connected',
      ...(c.gateway === googleAdsGateway
        ? {authorization: googleAuthorizationInfo(store, c, oauth.config(platform('google')).clientId)}
        : {}),
    };
  };
}

/**
 * The asset sync that refreshes a login's inventory (server/asset-discovery.ts): the identity, grants and recorded
 * scopes its reads found, the merged asset groups, the selected accounts and write grants a complete listing no
 * longer shows, the login's name and the audit; then the login's public view.
 */
function assetSync(
  {store, discovery, connection, readDocument, savedAssets, sameIdentity, writeLabel}: ViewParts,
  publicConnection: ReturnType<typeof publicConnectionView>,
) {
  return async (tenant: string, c: Connection, assertActive: () => void, kinds?: string[]) => {
    const revision = authorizationRevision(store, tenant, c.id);
    const result = await discovery.sync(c, kinds, assertActive);
    result.assertCurrent();
    // A newer authorization also prevents an older in-flight sync from replacing its asset inventory (CON-02).
    if (authorizationRevision(store, tenant, c.id) !== revision)
      throw new MirrorError(
        'CONNECTION_CHANGED',
        c.gateway === googleAdsGateway
          ? 'Google was reauthorized while this sync was running. Refresh the connection to see its current assets.'
          : 'This login was reauthorized while this sync was running. Refresh the connection to see its current assets.',
        {},
        409,
      );
    // The provider user discovery read (Meta, Microsoft) identifies the login for later renewals (D19), and Meta's
    // permissions read records what was actually granted (CON-03).
    // The user's display name is kept with the login, minimal and removed on disconnect (CON-05); a first identity that
    // another login of this platform already holds is flagged instead of silently adding a second login of one user.
    const displayName = providerDisplayName(result.label);
    if (result.identity || result.grants || displayName) {
      const record = readDocument(tenant, 'website_connection', c.id, {}),
        first = result.identity && !record.providerId,
        duplicate = first ? sameIdentity(tenant, c.gateway, result.identity, c.id) : undefined;
      if (first || result.grants || (displayName && record.displayName !== displayName))
        store.putDocument(tenant, 'website_connection', c.id, {
          ...Object.fromEntries(Object.entries(record).filter(([k]) => !['id', 'revision'].includes(k))),
          ...(first ? {providerId: result.identity} : {}),
          ...(duplicate ? {duplicateOf: duplicate} : {}),
          ...(displayName ? {displayName} : {}),
          ...(result.grants ? {grants: result.grants} : {}),
        });
    }
    // Recorded scopes become the permissions Meta granted; a declined permission is no longer recorded as granted.
    const granted = grantedScopes(result.grants);
    if (granted) {
      const latest = connection(tenant, c.id);
      if (stable([...latest.scopes].sort()) !== stable(granted))
        store.updateConnection(
          {tenantId: tenant, userId: 'workspace-admin', role: 'admin'},
          {...latest, scopes: granted},
        );
    }
    // A sync may overlap selection, default changes, or disconnect. Never restore its old grants.
    c = connection(tenant, c.id);
    const previous = savedAssets(tenant, c),
      groups: AssetGroup[] = [...(previous.groups ?? [])];
    for (const group of result.groups) {
      group.checkedAt = Date.now();
      const old = groups.findIndex(g => g.kind === group.kind);
      const replacement =
        !group.complete && old >= 0
          ? {...group, assets: [...new Map([...groups[old]!.assets, ...group.assets].map(a => [a.id, a])).values()]}
          : group;
      if (old >= 0) groups[old] = replacement;
      else groups.push(replacement);
    }
    const failed = result.groups.filter(g => !g.complete),
      prefix = selectionKind(c.gateway) + ':',
      selectable = selectableKinds(c.gateway);
    let selection = (previous.selected ?? c.accounts.map(id => prefix + id)) as string[];
    // The selected accounts and write grants a complete listing no longer shows, recorded with the sync (CON-05).
    let droppedAccounts: string[] = [],
      droppedWriteAccounts: string[] = [];
    const accountsGroup = result.groups.find(g => g.kind === selectionKind(c.gateway) && g.complete);
    // Each complete listing of a selectable kind drops the selected assets of that kind it no longer shows. With one
    // selectable kind (every platform but Drive) this keeps exactly the accounts that listing shows.
    const listed = new Map(
      result.groups
        .filter(g => g.complete && selectable.includes(g.kind))
        .map(g => [g.kind, new Set(g.assets.map(a => a.id))]),
    );
    if (listed.size) {
      const kindOf = (k: string) => selectable.find(kind => k.startsWith(kind + ':')),
        dropped = new Set<string>();
      selection = selection.filter(k => {
        const kind = kindOf(k),
          shown = kind ? listed.get(kind) : undefined,
          id = kind ? k.slice(kind.length + 1) : k;
        if (!shown || shown.has(id)) return true;
        dropped.add(id);
        return false;
      });
      const alsoSelected = new Set(selection.filter(k => !k.startsWith(prefix)).map(k => k.slice(k.indexOf(':') + 1))),
        visible = accountsGroup ? new Set(accountsGroup.assets.map(a => a.id)) : undefined;
      const accounts = c.accounts.filter(
        id => !dropped.has(id) && (!visible || visible.has(id) || alsoSelected.has(id)),
      );
      // How each kept account is reached, from the complete listing, on a login whose provider keeps it (as the asset
      // selection does: server/connection-routes.ts).
      const routes = accountsGroup ? providerOf(c.gateway)?.account?.routes : undefined,
        routed = () => providerLogin(c.gateway)!.routes!(accountsGroup!.assets, accounts);
      const accountCustomers = routes === 'accountCustomers' ? routed() : c.accountCustomers;
      const accountLoginCustomers = routes === 'accountLoginCustomers' ? routed() : c.accountLoginCustomers;
      if (
        accounts.length !== c.accounts.length ||
        JSON.stringify(accountCustomers) !== JSON.stringify(c.accountCustomers) ||
        JSON.stringify(accountLoginCustomers) !== JSON.stringify(c.accountLoginCustomers)
      ) {
        droppedAccounts = c.accounts.filter(id => !accounts.includes(id));
        droppedWriteAccounts = (c.writeAccounts ?? []).filter(id => c.accounts.includes(id) && !accounts.includes(id));
        c = {
          ...c,
          accounts,
          accountCustomers,
          accountLoginCustomers,
          writeAccounts: (c.writeAccounts ?? []).filter(id => accounts.includes(id)),
          enabled: c.enabled && accounts.length > 0,
        };
        store.updateConnection({tenantId: tenant, userId: 'workspace-admin', role: 'admin'}, c);
      }
    }
    store.putDocument(tenant, 'website_assets', c.id, {
      groups,
      selected: selection,
      lastSync: Date.now(),
      // One refusal that fails several groups (Business Profile accounts and locations, CON-06) is stated once.
      error: failed.length ? [...new Set(failed.map(g => g.error))].join(' ') : null,
    });
    // A login keeps the name an administrator gave it; otherwise it is named "<Platform> · <user>" (CON-05).
    const named = platforms.find(p => p.gateway === c.gateway);
    if (displayName && named && readDocument(tenant, 'website_connection', c.id, {}).labelCustom !== true) {
      const label = loginLabel(named, displayName);
      c = {...c, label};
      writeLabel(tenant, c.id, label);
    }
    store.appendAudit(tenant, randomUUID(), {
      event: 'website_asset_sync',
      connection_id: c.id,
      kinds: result.groups.map(g => g.kind),
      complete: failed.length === 0,
      ...(droppedAccounts.length
        ? {dropped_accounts: droppedAccounts, dropped_write_accounts: droppedWriteAccounts}
        : {}),
      vendor_writes: 0,
      ...(failed.length
        ? {
            error: {code: 'ASSET_SYNC_INCOMPLETE', message: failed.map(g => g.error).join(' ')},
            diagnostics: failed.flatMap(g => g.diagnostics ?? []).slice(0, 100),
          }
        : {}),
    });
    return publicConnection(tenant, c);
  };
}
