import {NativeTransport, buildUrl} from '../src/transport.js';
import {MirrorError} from '../src/errors.js';
import {CredentialProvider} from '../src/auth.js';
import type {Connection, Credentials, CompiledRequest, JsonObject} from '../src/types.js';
import type {
  AssetGroup,
  DiscoveryContext,
  DiscoveryFindings,
  DiscoveryParents,
  WorkspaceAsset,
} from '../src/provider-login.js';
import {Store} from '../src/store.js';
import {platforms, selectionKind, type PlatformDefinition} from './platform-oauth.js';
import {assetSyncDiagnostic, assetSyncErrorMessage} from '../src/report-errors.js';
import {loginStamp, storedLogin} from '../src/connection-authority.js';
import {runWithQuotaPurpose} from '../src/provider-quota.js';
import {providerLogin} from '../src/provider-logins.js';

// The asset types are the website login contract's (src/provider-login.ts): each provider's discovery step builds them.
export type {AssetGroup, WorkspaceAsset} from '../src/provider-login.js';

/**
 * The website's asset discovery. It keeps the platform and kind checks, the connection, scope and login checks before
 * and after every request, the page rules, the asset rules, the walk beneath parents and each kind's failure group;
 * each provider supplies the reads that list its assets (`discovery` of its login steps, src/<provider>-login.ts,
 * ARC-01 phase B), consulted by the connection's gateway.
 */
export class AssetDiscovery {
  private transport: NativeTransport;
  private credentials: CredentialProvider;
  constructor(
    private store: Store,
    fetcher: typeof fetch = fetch,
  ) {
    this.transport = new NativeTransport(fetcher);
    if (fetcher === fetch) this.transport.coordination = store;
    this.credentials = new CredentialProvider(store, fetcher);
  }
  private plan(c: Connection, path: string, query: JsonObject = {}, method = 'GET', body?: unknown): CompiledRequest {
    return {
      gateway: c.gateway,
      action: 'AMCP_ASSET_DISCOVERY',
      path,
      query,
      method,
      body,
      headers: providerLogin(c.gateway)?.discovery?.headers?.() ?? {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      evidence: 'INDEPENDENT_ACCOUNT_DISCOVERY',
      warnings: [],
    };
  }
  private async pages(
    c: Connection,
    request: (plan: CompiledRequest) => ReturnType<NativeTransport['request']>,
    path: string,
    query: JsonObject,
    extract: (data: JsonObject) => unknown[],
    origin?: string,
  ): Promise<JsonObject[]> {
    const plan = {...this.plan(c, path, query), ...(origin ? {origin} : {})},
      original = buildUrl(plan, c),
      items: JsonObject[] = [],
      seen = new Set<string>(),
      discovery = providerLogin(c.gateway)?.discovery;
    for (let page = 0; page < 25; page++) {
      const response = await request(plan),
        data = response.data as JsonObject,
        rows = extract(data);
      if (!Array.isArray(rows))
        throw new MirrorError('ASSET_RESPONSE_INVALID', 'The provider returned an unexpected asset list.', {}, 502);
      if (rows.some(r => !r || typeof r !== 'object' || Array.isArray(r)))
        throw new MirrorError('ASSET_RESPONSE_INVALID', 'The provider returned an invalid asset record.', {}, 502);
      items.push(...(rows as JsonObject[]));
      if (items.length > 10000)
        throw new MirrorError('ASSET_SYNC_LIMIT', 'Too many assets for one sync; narrow the provider login.', {}, 409);
      const next =
        data.pagination?.next_url ??
        data.paging?.next ??
        data.paging?.next_link ??
        data.paging?.links?.find((l: JsonObject) => l.rel === 'next')?.href;
      const cursor = data.next_cursor ?? data.cursor?.next ?? null;
      let start: number | undefined;
      if (data.nextPageToken !== undefined && data.nextPageToken !== '') {
        if (typeof data.nextPageToken !== 'string' || seen.has('pageToken' + data.nextPageToken))
          throw new MirrorError('PAGINATION_LOOP', 'Provider returned an invalid or repeated page token.', {}, 502);
        seen.add('pageToken' + data.nextPageToken);
        plan.query.pageToken = data.nextPageToken;
      } else if (next) {
        const nextUrl = new URL(next, original);
        if (
          nextUrl.origin !== original.origin ||
          nextUrl.pathname !== original.pathname ||
          nextUrl.username ||
          nextUrl.password ||
          nextUrl.hash
        )
          throw new MirrorError('UNSAFE_PAGINATION', 'Provider pagination changed the asset endpoint.', {}, 502);
        const cursorKey = ['after', 'cursor', 'start', 'offset'].find(k => nextUrl.searchParams.has(k));
        if (!cursorKey)
          throw new MirrorError('ASSET_SYNC_LIMIT', 'Provider paging does not expose a supported cursor.', {}, 409);
        // A provider whose links may change only their cursor checks the rest (Reddit).
        discovery?.nextLink?.(nextUrl, original, cursorKey);
        const value = nextUrl.searchParams.get(cursorKey)!;
        if (seen.has(cursorKey + value))
          throw new MirrorError('PAGINATION_LOOP', 'Provider repeated its pagination cursor.', {}, 502);
        seen.add(cursorKey + value);
        plan.query[cursorKey] = value;
      } else if (cursor !== null && cursor !== '' && cursor !== 0 && cursor !== '0') {
        if (seen.has(String(cursor)))
          throw new MirrorError('PAGINATION_LOOP', 'Provider repeated its pagination cursor.', {}, 502);
        seen.add(String(cursor));
        plan.query.cursor = String(cursor);
      } else if ((start = discovery?.nextStart?.(data, rows)) !== undefined) {
        // A listing that pages by start and count (LinkedIn): its provider says where the next page starts.
        if (seen.has('start' + start))
          throw new MirrorError('PAGINATION_LOOP', 'Provider repeated its page offset.', {}, 502);
        seen.add('start' + start);
        plan.query.start = start;
      } else return items;
    }
    throw new MirrorError('ASSET_SYNC_LIMIT', 'Asset sync reached its page limit before completing.', {}, 409);
  }
  private asset(row: JsonObject, kind: string, parentId?: string): WorkspaceAsset {
    const raw = row.account_id ?? row.advertiser_id ?? row.id;
    if (raw === undefined || (typeof raw === 'number' && !Number.isSafeInteger(raw)))
      throw new MirrorError('ASSET_ID_INVALID', 'The provider returned an invalid asset identifier.', {}, 502);
    const id = String(raw).replace(kind === 'ad_accounts' ? /^act_/ : /$^/, '');
    if (!id || id.length > 300)
      throw new MirrorError('ASSET_ID_INVALID', 'The provider returned an invalid asset identifier.', {}, 502);
    return {
      id,
      kind,
      name: String(row.name ?? row.advertiser_name ?? row.username ?? id),
      parentId,
      currency: row.currency,
      timezone: row.timezone_name ?? row.timezone,
      status:
        row.account_status === undefined
          ? row.status === undefined
            ? undefined
            : String(row.status)
          : String(row.account_status),
      source: 'vendor',
    };
  }
  /**
   * The accounts beneath each parent a login reaches. Parent visibility is discovery evidence, never an AMCP account
   * grant or proof of write access.
   */
  private async parents(
    p: PlatformDefinition,
    connection: Connection,
    kind: string,
    spec: DiscoveryParents,
    pages: DiscoveryContext['pages'],
  ): Promise<WorkspaceAsset[] | AssetGroup> {
    const assets: WorkspaceAsset[] = [],
      diagnostics: JsonObject[] = [];
    const listing = spec.parents(),
      parents = await pages(listing.path, listing.query, listing.extract);
    if (parents.length > 100)
      throw new MirrorError(
        'ASSET_SYNC_LIMIT',
        'This login has more than 100 businesses/partners. Use a narrower login.',
        {},
        409,
      );
    const seenParents = new Set<string>();
    for (const parent of parents) {
      const id = spec.parentId(parent);
      if (!spec.parentPattern.test(id) || seenParents.has(id))
        throw new MirrorError(
          'ASSET_ID_INVALID',
          'The provider returned an invalid or repeated discovery parent.',
          {},
          502,
        );
      seenParents.add(id);
      try {
        const children = spec.accounts(id),
          rows = await pages(children.path, children.query, children.extract);
        for (const row of rows) {
          const child = spec.accountId(row),
            actualParent = spec.accountParent(row);
          if (
            typeof child !== 'string' ||
            !spec.accountPattern.test(child) ||
            (actualParent !== undefined && actualParent !== id)
          )
            throw new MirrorError(
              'ASSET_ID_INVALID',
              'The provider returned an account outside the requested business/partner.',
              {},
              502,
            );
          if (assets.length >= 10000)
            throw new MirrorError(
              'ASSET_SYNC_LIMIT',
              'Discovery exceeds 10,000 accounts. Use a narrower login.',
              {},
              409,
            );
          assets.push(this.asset({...row, id: child, ...spec.fields(row)}, kind, id));
        }
      } catch (e) {
        diagnostics.push({...assetSyncDiagnostic(e, p.id, connection.id, kind), parent_id: id});
      }
    }
    if (diagnostics.length)
      return {
        kind,
        assets: [...new Map(assets.map(a => [a.id, a])).values()],
        complete: false,
        error:
          'Some businesses/partners could not be read. Available accounts are retained; inspect individual diagnostics.',
        diagnostics,
      };
    // A listing that leaves accounts out says so on its complete group (Reddit's list-by-business).
    const coverage = spec.coverage?.();
    if (coverage)
      return {kind, assets: [...new Map(assets.map(a => [a.id, a])).values()], complete: true, diagnostics: coverage};
    return assets;
  }
  async sync(
    connection: Connection,
    kinds?: string[],
    assertActive: () => void = () => {},
  ): Promise<{
    groups: AssetGroup[];
    label?: string;
    identity?: string;
    grants?: JsonObject;
    assertCurrent: () => void;
  }> {
    const p = platforms.find(p => p.gateway === connection.gateway);
    if (!p) throw new MirrorError('PLATFORM_NOT_FOUND', 'This connection is not supported by the website.', {}, 404);
    const selected = kinds ?? [selectionKind(connection.gateway)];
    if (selected.some(k => !p.assetKinds.includes(k)))
      throw new MirrorError('ASSET_KIND_INVALID', 'This asset type is not available for the platform.');
    let credentials: Credentials;
    const failure = (kind: string, error: unknown) => this.failure(p, connection, kind, error);
    const current = () => {
      assertActive();
      const c = this.store.listConnections(connection.tenantId).find(c => c.id === connection.id);
      if (!c || c.gateway !== connection.gateway)
        throw new MirrorError('CONNECTION_NOT_FOUND', 'This connection was removed during discovery.', {}, 404);
      if (connection.scopes.some(s => !c.scopes.includes(s)))
        throw new MirrorError('INSUFFICIENT_SCOPE', 'This login lost permissions during discovery.', {}, 403);
      return c;
    };
    let fingerprint = storedLogin(this.store, current());
    const check = () => {
      if (storedLogin(this.store, current()) !== fingerprint)
        throw new MirrorError(
          'CONNECTION_CHANGED',
          'The selected login changed during discovery. Sync again with its current authorization.',
          {},
          409,
        );
    };
    try {
      credentials = await this.credentials.get(current());
      fingerprint = loginStamp(credentials);
    } catch (e) {
      check();
      return {groups: selected.map(kind => failure(kind, e)), assertCurrent: check};
    }
    check();
    const found = await this.discover(p, connection, credentials, selected, check);
    return {...found, assertCurrent: check};
  }
  private failure(p: PlatformDefinition, connection: Connection, kind: string, error: unknown): AssetGroup {
    const diagnostic = assetSyncDiagnostic(error, p.id, connection.id, kind);
    return {kind, assets: [], complete: false, error: assetSyncErrorMessage(diagnostic), diagnostics: [diagnostic]};
  }
  /**
   * Read-only discovery with candidate credentials that are not stored (CON-02): reauthorization verifies a fresh
   * login this way before it replaces the saved one. Nothing is persisted and the stored credentials are never used.
   * `check` runs before and after every request. `identity` is the provider's user ID where discovery reads it
   * without extra permissions (Meta `/me`, Microsoft's authenticated user).
   */
  async discoverWith(
    connection: Connection,
    credentials: Credentials,
    kinds: string[],
    check: () => void,
  ): Promise<{groups: AssetGroup[]; label?: string; identity?: string; grants?: JsonObject}> {
    const p = platforms.find(p => p.gateway === connection.gateway);
    if (!p) throw new MirrorError('PLATFORM_NOT_FOUND', 'This connection is not supported by the website.', {}, 404);
    if (kinds.some(k => !p.assetKinds.includes(k)))
      throw new MirrorError('ASSET_KIND_INVALID', 'This asset type is not available for the platform.');
    check();
    // A reauthorization check may use the reserved slice of a shared provider app quota (OPS-08).
    return runWithQuotaPurpose('reserved', () => this.discover(p, connection, credentials, kinds, check));
  }
  /**
   * Each selected kind through its provider's discovery step, in order: a kind whose step refuses gets its failure
   * group, and a provider whose adapter declares no discovery cannot be discovered.
   */
  private async discover(
    p: PlatformDefinition,
    connection: Connection,
    credentials: Credentials,
    selected: string[],
    check: () => void,
  ): Promise<{groups: AssetGroup[]; label?: string; identity?: string; grants?: JsonObject}> {
    const groups: AssetGroup[] = [],
      found: DiscoveryFindings = {},
      discovery = providerLogin(connection.gateway)?.discovery;
    const failure = (kind: string, error: unknown) => this.failure(p, connection, kind, error);
    // Guards are operation-local: this discovery instance serves concurrent workspaces.
    const request = async (plan: CompiledRequest) => {
      check();
      const out = await this.transport.request(plan, connection, credentials, undefined, {beforeAttempt: check});
      check();
      return out;
    };
    const pages: DiscoveryContext['pages'] = (path, query, extract, origin) =>
      this.pages(connection, request, path, query, extract, origin);
    const context: DiscoveryContext = Object.freeze({
      connection,
      credentials,
      found,
      transport: this.transport,
      check,
      plan: (path: string, query?: JsonObject, method?: string, body?: unknown) =>
        this.plan(connection, path, query, method, body),
      request,
      read: async (plan: CompiledRequest) => (await request(plan)).data,
      pages,
      asset: (row: JsonObject, kind: string, parentId?: string) => this.asset(row, kind, parentId),
      failure,
      parents: (kind: string, spec: DiscoveryParents) => this.parents(p, connection, kind, spec, pages),
    });
    // A provider that discovers every selected kind in one bounded pass (Business Profile).
    if (discovery?.all) {
      groups.push(...(await discovery.all(selected, context)));
      check();
      return {groups};
    }
    for (const kind of selected) {
      try {
        if (!discovery?.kind)
          throw new MirrorError(
            'ASSET_DISCOVERY_UNAVAILABLE',
            'Asset discovery has not been implemented for this provider.',
            {},
            501,
          );
        const assets = await discovery.kind(kind, context);
        if (!Array.isArray(assets)) {
          groups.push(assets);
          continue;
        }
        const unique = new Map(assets.map(a => [a.kind + ':' + a.id, a]));
        groups.push({kind, assets: [...unique.values()], complete: true});
      } catch (e) {
        groups.push(failure(kind, e));
      }
    }
    check();
    return {groups, label: found.label, identity: found.identity, ...(found.grants ? {grants: found.grants} : {})};
  }
}
