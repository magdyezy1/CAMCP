import {randomBytes, randomUUID, createHash} from 'node:crypto';
import type {Response} from 'express';
import type {OAuthServerProvider, AuthorizationParams} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidClientMetadataError,
  InvalidClientError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {redirectUriMatches} from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import {WebStore, type WebSession} from './web-store.js';
import {endMcpGrants, familyEndReason, type GrantEndReason} from './mcp-grants.js';
import {ClientMetadataDocuments, acceptableRedirectUri, isClientMetadataUrl} from './client-metadata.js';
import {mcpClientLimit, releaseStaleMcpClients} from '../src/mcp-clients.js';
import {sha256, safeEqual} from '../src/security.js';
import {MirrorError} from '../src/errors.js';
import type {Store} from '../src/store.js';
import type {Actor, JsonObject} from '../src/types.js';

const opaque = () => randomBytes(32).toString('base64url');
const readScope = 'mcp:read',
  writeScope = 'mcp:write';
const roleOf = (scopes: string[]) => (scopes.includes(writeScope) ? 'operator' : 'reader');
/** The most a member may grant an AI client (owner decision D16): a viewer reads; an operator, administrator or owner
 * may also approve reviewed changes. Per-account write grants, spending policy, write pauses and reviews still apply. */
const memberScopeCap = (role: string) => (role === 'reader' ? [readScope] : [readScope, writeScope]);
const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];
/** Seconds a just-rotated refresh token may be presented again (owner decision D16, review 2026-10-08). */
export const defaultRefreshReuseSeconds = 60;
/** The token endpoint's reason when a refresh token belongs to a connection that has ended. */
const endedDescriptions: Record<GrantEndReason, string> = {
  refresh_replay:
    'This refresh token was already used, so AMCP ended the connection to protect it. Authorize the client again.',
  code_replay:
    'An authorization code of this connection was presented twice, so AMCP ended the connection. Authorize the client again.',
  client_revoke: 'The client revoked this authorization. Authorize the client again.',
  workspace_revoke: 'This client was revoked in AMCP. Authorize the client again.',
  membership_change: 'Your workspace membership changed, so this access ended. Authorize the client again.',
  password_change: 'The account password changed, so this access ended. Sign in and authorize the client again.',
  email_change: 'The account email changed, so this access ended. Sign in and authorize the client again.',
  mfa_change: 'Two-step verification changed, so this access ended. Sign in and authorize the client again.',
  account_access_revoked: 'Access to this AMCP account was removed, so this access ended.',
  owner_migration:
    'This workspace now uses its owner account, so this access ended. Sign in as the owner and authorize the client again.',
  door_password_change: 'The administrator password changed, so this access ended. Authorize the client again.',
  restore_quarantine:
    'AMCP was restored from a backup and every earlier authorization ended. Sign in and authorize the client again.',
};
/** The refusal of an AI-client access token whose authorization is no longer live (SEC-05). */
const endedAccess = () =>
  new MirrorError(
    'UNAUTHORIZED',
    'This AI-client authorization ended, expired or was revoked. Reconnect the AMCP connector.',
    {},
    401,
  );
/**
 * The one validator of a bearer token at /mcp (SEC-05). Every token is an api_keys row (store.authenticate: not
 * revoked or expired, and the person's account and membership still active). A token AMCP's authorization server
 * issued to an AI client must also have its live access grant (McpOAuth.assertAccessGrant). That check is bound to
 * the actor, so a revocation during a long request is caught at the next check. Before, /mcp read only api_keys, so
 * every revocation path had to remember to revoke the key too. Where the authorization server is not running (no
 * website), nothing can vouch for an AI-client token, so it is refused.
 */
export function validateMcpToken(store: Store, token: string, oauth?: McpOAuth): Actor {
  const actor = store.authenticate(token);
  if (!actor.userId.startsWith('oauth/')) return actor;
  if (!oauth)
    throw new MirrorError(
      'UNAUTHORIZED',
      'AI-client authorizations are accepted only where the AMCP website runs. Use an AMCP API key here.',
      {},
      401,
    );
  const hash = sha256(token),
    check = () => oauth.assertAccessGrant(hash, actor);
  check();
  store.bindActorCheck(actor, check);
  return actor;
}
export interface McpOAuthOptions {
  /** 0 to 60 seconds; 0 turns the reuse window off. Default: WebsiteOptions.mcpRefreshReuseSeconds, else 60. */
  refreshReuseSeconds?: number;
}
/** The scope a client gets when it names none: read and reviewed write on a write-enabled deployment, else read. */
export const defaultClientScope = (allowWrites: boolean) => (allowWrites ? readScope + ' ' + writeScope : readScope);
/** AMCP credentials carry only explicitly consented access. Platform tokens stay on the server. */
export class McpOAuth implements OAuthServerProvider {
  readonly resource: URL;
  /** A just-rotated refresh token presented again within this window, while its successor is unused, gets a fresh
   * pair instead of ending the connection: a lost response or two concurrent refreshes by one client. */
  readonly refreshReuseMs: number;
  /** The authorization server's issuer, byte for byte as its metadata names it; redirects carry it as `iss`. */
  readonly issuer: string;
  /** Client ID Metadata Documents (MCP-03): an HTTPS client_id is fetched under SSRF guards instead of registered. */
  readonly metadataDocuments?: ClientMetadataDocuments;
  constructor(
    readonly web: WebStore,
    readonly allowWrites = false,
    options: McpOAuthOptions = {},
  ) {
    this.resource = new URL(web.origin + '/mcp');
    const seconds = options.refreshReuseSeconds ?? web.options.mcpRefreshReuseSeconds ?? defaultRefreshReuseSeconds;
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 60)
      throw Error('AMCP_MCP_REFRESH_REUSE_SECONDS must be a whole number of seconds from 0 to 60.');
    this.refreshReuseMs = seconds * 1000;
    this.issuer = new URL(web.origin).href;
    const metadata = web.options.mcpClientMetadata;
    if (metadata?.enabled !== false)
      this.metadataDocuments = new ClientMetadataDocuments(defaultClientScope(allowWrites), metadata ?? {});
  }
  /** A client's scope from its metadata document, kept to what this deployment offers; read is required. */
  private documentScope(scope: string | undefined): string {
    const requested = (scope ?? defaultClientScope(this.allowWrites)).split(' ').filter(Boolean),
      offered = requested.filter(s => s === readScope || (s === writeScope && this.allowWrites));
    if (!offered.includes(readScope))
      throw new InvalidClientError('The client metadata document cannot be used: its scope must include mcp:read.');
    return [...new Set(offered)].join(' ');
  }
  get clientsStore() {
    return {
      getClient: async (id: string) => {
        if (isClientMetadataUrl(id)) {
          if (!this.metadataDocuments) return;
          const client = await this.metadataDocuments.client(id);
          return {...client, scope: this.documentScope(client.scope)};
        }
        const row = this.web.store.db.prepare('SELECT data FROM amcp_mcp_clients WHERE id=?').get(id) as
          {data: string} | undefined;
        if (!row) return;
        const {encrypted_client_secret, ...client} = JSON.parse(row.data);
        if (client.token_endpoint_auth_method === 'client_secret_post') {
          if (typeof encrypted_client_secret !== 'string')
            throw new InvalidClientError('Client credentials are unavailable.');
          client.client_secret = this.web.openClientSecret(id, encrypted_client_secret);
        }
        return client as OAuthClientInformationFull;
      },
      registerClient: async (input: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) => {
        // An omitted method registers a public client (RFC 7591 defaults to client_secret_basic, which AMCP does not
        // offer); the response echoes the method registered (MCP-03).
        const method = input.token_endpoint_auth_method ?? 'none';
        if (method !== 'none' && method !== 'client_secret_post')
          throw new InvalidClientMetadataError('Use none or client_secret_post with S256 PKCE.');
        if (
          !input.redirect_uris.length ||
          input.redirect_uris.length > 10 ||
          input.redirect_uris.some(uri => !acceptableRedirectUri(uri))
        )
          throw new InvalidClientMetadataError('Register exact HTTPS or loopback HTTP redirect URIs.');
        const scopes = this.validateScopes(
          input.scope === undefined
            ? this.allowWrites
              ? [readScope, writeScope]
              : [readScope]
            : input.scope.split(' '),
        );
        // Registration is anonymous and the cap is deployment wide, so every registration first releases the clients
        // nothing live is left for (MCP-03): before, any grant row kept a client, and pruning keeps each client's newest
        // refresh row, so the cap filled for good.
        releaseStaleMcpClients(this.web.store);
        const count = this.web.store.db.prepare('SELECT count(*) AS n FROM amcp_mcp_clients').get() as {n: number};
        if (count.n >= mcpClientLimit)
          throw new InvalidClientMetadataError(
            'Client registration limit reached. Contact the workspace administrator.',
          );
        const client: OAuthClientInformationFull = {
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_name: String(input.client_name ?? 'MCP client').slice(0, 120),
          redirect_uris: input.redirect_uris,
          token_endpoint_auth_method: method,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          scope: scopes.join(' '),
        };
        if (method === 'client_secret_post') {
          client.client_secret = opaque();
          client.client_secret_expires_at = 0;
        }
        const {client_secret, ...metadata} = client;
        this.web.store.db.prepare('INSERT INTO amcp_mcp_clients VALUES(?,?)').run(
          client.client_id,
          JSON.stringify({
            ...metadata,
            ...(client_secret
              ? {encrypted_client_secret: this.web.sealClientSecret(client.client_id, client_secret)}
              : {}),
          }),
        );
        return client;
      },
    };
  }
  /** Additional constant-time authentication before the SDK's token/revocation handlers; returns the client ID. */
  async authenticateClient(body: unknown, authorization?: string): Promise<string> {
    const input = body as JsonObject | undefined;
    if (authorization !== undefined || typeof input?.client_id !== 'string')
      throw new InvalidClientError('Use the registered token endpoint authentication method.');
    const client = await this.clientsStore.getClient(input.client_id);
    if (!client) throw new InvalidClientError('Invalid client credentials.');
    if (client.token_endpoint_auth_method === 'client_secret_post') {
      if (
        typeof input.client_secret !== 'string' ||
        !client.client_secret ||
        !safeEqual(client.client_secret, input.client_secret)
      )
        throw new InvalidClientError('Invalid client credentials.');
    } else if (input.client_secret !== undefined)
      throw new InvalidClientError('Public clients must not supply a client secret.');
    return client.client_id;
  }
  private validateScopes(scopes?: string[]) {
    const granted = scopes === undefined ? [readScope] : scopes;
    if (
      !granted.length ||
      new Set(granted).size !== granted.length ||
      granted.some(s => s !== readScope && s !== writeScope) ||
      !granted.includes(readScope)
    )
      throw new InvalidScopeError('Request mcp:read, optionally together with mcp:write.');
    if (granted.includes(writeScope) && !this.allowWrites)
      throw new InvalidScopeError('Advertising writes are disabled in this deployment.');
    return granted;
  }
  private validateResource(resource?: URL) {
    if (resource && resource.href !== this.resource.href)
      throw new InvalidTargetError('The resource must be the AMCP MCP endpoint.');
  }
  private put(token: string, kind: string, client: string, data: JsonObject, ttl: number, tenant = this.web.tenantId) {
    this.web.store.db
      .prepare('INSERT INTO amcp_mcp_grants VALUES(?,?,?,?,?,?,0)')
      .run(sha256(token), kind, client, tenant, JSON.stringify(data), Date.now() + ttl);
  }
  /** MCP access approved from the administrator's or the reviewer's password sign-in ends with that password (F-16). */
  private assertUsable(ownerUserId: unknown, tenant: unknown) {
    if (!this.web.doorGrantUsable(ownerUserId, tenant))
      throw new InvalidGrantError('This authorization has expired or was already used.');
  }
  private get(token: string, kind: string, client?: string, allowUsed = false): JsonObject {
    const row = this.web.store.db
      .prepare('SELECT * FROM amcp_mcp_grants WHERE hash=? AND kind=?')
      .get(sha256(token), kind) as JsonObject | undefined;
    if (!row || (client && row.client_id !== client) || row.expires_at <= Date.now() || (row.used && !allowUsed))
      throw new InvalidGrantError('This authorization has expired or was already used.');
    return {...row, data: JSON.parse(row.data)};
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    const scopes = this.validateScopes(params.scopes?.length ? params.scopes : client.scope?.split(' '));
    this.validateResource(params.resource);
    const registered = client.scope?.split(' ') ?? [readScope];
    if (scopes.some(s => !registered.includes(s)))
      throw new InvalidScopeError(
        'The requested scope exceeds this client registration. Register and authorize write access explicitly.',
      );
    const redirect = new URL(params.redirectUri);
    if (
      redirect.username ||
      redirect.password ||
      redirect.hash ||
      !client.redirect_uris.some(uri => redirectUriMatches(params.redirectUri, uri)) ||
      !/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)
    )
      throw new InvalidGrantError(
        'A registered redirect URI and S256 PKCE challenge are required. Only the port may vary for loopback callbacks.',
      );
    this.web.store.db
      .prepare("DELETE FROM amcp_mcp_grants WHERE kind IN ('request','code') AND expires_at<?")
      .run(Date.now());
    const request = opaque();
    this.put(
      request,
      'request',
      client.client_id,
      {
        redirectUri: params.redirectUri,
        challenge: params.codeChallenge,
        state: params.state,
        resource: this.resource.href,
        clientName: client.client_name ?? 'MCP client',
        scope: scopes.join(' '),
      },
      600000,
    );
    res.redirect(303, this.web.origin + '/oauth/consent?request=' + encodeURIComponent(request));
  }
  /**
   * What the consent screen shows, for any active member except reviewer test accounts. The scope is what the client
   * requested, capped by the member's role; `choices` are the scopes the member may approve instead (read only, or
   * read and reviewed changes). Names and return addresses come from the client and are not verified by AMCP.
   */
  consent(request: string, session: WebSession) {
    if (session.actor.testAccount === true)
      throw new InvalidGrantError('Reviewer test accounts cannot authorize AI clients.');
    const row = this.get(request, 'request'),
      requested = this.validateScopes(row.data.scope?.split(' ')),
      cap = memberScopeCap(session.actor.role),
      scopes = requested.filter(s => cap.includes(s)),
      redirect = new URL(row.data.redirectUri);
    return {
      clientId: row.client_id as string,
      name: row.data.clientName as string,
      redirectUri: row.data.redirectUri as string,
      redirectHost: redirect.host,
      loopback: loopbackHosts.includes(redirect.hostname),
      requestedScope: requested.join(' '),
      scope: scopes.join(' '),
      role: roleOf(scopes),
      choices: scopes.includes(writeScope) ? [readScope, readScope + ' ' + writeScope] : [readScope],
      capped: scopes.length < requested.length,
      writesEnabled: this.allowWrites,
      // A client identified by its metadata document: the host that published it, which AMCP fetched it from.
      ...(isClientMetadataUrl(row.client_id) ? {clientMetadataHost: new URL(row.client_id).host} : {}),
    };
  }
  /** Records the member's decision. `scope`, when given, must be one of the consent `choices`; the code carries the
   * chosen scope, so the token response and every refresh stay within it. */
  decide(request: string, session: WebSession, approved: boolean, scope?: string) {
    const consent = this.consent(request, session);
    if (approved && scope !== undefined && !consent.choices.includes(scope))
      throw new InvalidScopeError(
        'Choose read-only access, or read and reviewed changes, within what the client requested and your workspace role allows.',
      );
    const owner = session.actor.userId !== 'workspace-admin' ? {ownerUserId: session.actor.userId} : {};
    return this.web.store.transaction(() => {
      this.assertUsable(owner.ownerUserId, session.actor.tenantId);
      const row = this.get(request, 'request');
      this.web.store.db.prepare('UPDATE amcp_mcp_grants SET used=1 WHERE hash=?').run(row.hash);
      const url = new URL(row.data.redirectUri);
      if (row.data.state !== undefined) url.searchParams.set('state', row.data.state);
      // RFC 9207: the response names its issuer, so a client talking to several servers cannot be mixed up (MCP-03).
      url.searchParams.set('iss', this.issuer);
      if (approved) {
        const code = opaque();
        this.put(
          code,
          'code',
          row.client_id,
          {...row.data, scope: scope ?? consent.scope, ...owner},
          300000,
          session.actor.tenantId,
        );
        url.searchParams.set('code', code);
      } else url.searchParams.set('error', 'access_denied');
      return url.href;
    });
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    const row = this.get(code, 'code', client.client_id, true);
    // A code presented again revokes what its first exchange issued (RFC 6749 section 4.1.2), before PKCE is checked:
    // whoever replays it holds a code that should never have left the client.
    if (row.used) {
      if (row.data.family) this.revokeFamily(row.data.family, row.tenant_id, 'code_replay');
      throw new InvalidGrantError('This authorization has expired or was already used.');
    }
    return row.data.challenge as string;
  }
  /** Removes expired access grants with their keys, and expired refresh grants already rotated away. Each client keeps
   * its newest refresh grant, so a registration still in use is never orphaned for the unused-client cleanup. */
  private prune() {
    const db = this.web.store.db,
      now = Date.now(),
      expired = "SELECT hash FROM amcp_mcp_grants WHERE kind='access' AND expires_at<?";
    db.prepare('DELETE FROM credential_owners WHERE hash IN (' + expired + ')').run(now);
    db.prepare('DELETE FROM api_keys WHERE hash IN (' + expired + ')').run(now);
    db.prepare("DELETE FROM amcp_mcp_grants WHERE kind='access' AND expires_at<?").run(now);
    db.prepare(
      "DELETE FROM amcp_mcp_grants WHERE kind='refresh' AND used=1 AND expires_at<? AND EXISTS(SELECT 1 FROM amcp_mcp_grants o WHERE o.client_id=amcp_mcp_grants.client_id AND o.kind='refresh' AND o.expires_at>amcp_mcp_grants.expires_at)",
    ).run(now);
  }
  private issue(client: string, data: JsonObject, tenant: string): OAuthTokens {
    this.prune();
    const scopes = this.validateScopes(data.scope?.split(' ')),
      scope = scopes.join(' '),
      role = roleOf(scopes);
    const ownership = data.ownerUserId ? {ownerUserId: data.ownerUserId} : {},
      family = data.family ?? randomUUID(),
      // The name the client gave at authorization, so a client without a registration row (CIMD) is still named.
      named = typeof data.clientName === 'string' ? {clientName: data.clientName.slice(0, 120)} : {},
      access = this.web.store.createKey({tenantId: tenant, userId: 'oauth/' + client, role, ...ownership}, 3600000),
      refresh = opaque();
    // `pair` names the refresh grant issued with this access grant, so superseding the one ends the other. `resource`
    // is the protected resource the token was issued for; the resource server checks it on every request (SEC-05).
    this.put(
      access,
      'access',
      client,
      {family, scope, pair: sha256(refresh), resource: this.resource.href, ...ownership, ...named},
      3600000,
      tenant,
    );
    this.put(refresh, 'refresh', client, {family, scope, ...ownership, ...named}, 30 * 86400000, tenant);
    return {access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope};
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ) {
    this.validateResource(resource);
    return this.web.store.transaction(() => {
      const row = this.get(code, 'code', client.client_id);
      this.assertUsable(row.data.ownerUserId, row.tenant_id);
      // The SDK validates PKCE before this method and omits verifier afterwards.
      if (
        redirectUri !== row.data.redirectUri ||
        (verifier !== undefined &&
          (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
            !safeEqual(createHash('sha256').update(verifier).digest('base64url'), row.data.challenge)))
      )
        throw new InvalidGrantError('The redirect URI or PKCE verifier does not match.');
      // The code remembers the token family it issued, so a replay can revoke it.
      const data = {...row.data, family: randomUUID()};
      this.web.store.db
        .prepare('UPDATE amcp_mcp_grants SET used=1,data=? WHERE hash=?')
        .run(JSON.stringify(data), row.hash);
      return this.issue(client.client_id, data, row.tenant_id);
    });
  }
  /** Ends a token family and audits it with the reason (MCP-08). */
  private revokeFamily(family: string, tenant: string, reason: GrantEndReason) {
    return endMcpGrants(
      this.web.store,
      "tenant_id=? AND kind IN ('access','refresh') AND json_extract(data,'$.family')=?",
      [tenant, family],
      reason,
    );
  }
  /** Marks a refresh grant rotated: when, and which refresh grant replaced it. */
  private rotated(hash: string, successor: string) {
    this.web.store.db
      .prepare("UPDATE amcp_mcp_grants SET used=1,data=json_set(data,'$.rotated_at',?,'$.successor',?) WHERE hash=?")
      .run(Date.now(), sha256(successor), hash);
  }
  /**
   * The bounded reuse window (owner decision D16): the same client presents a refresh token that was rotated at most
   * refreshReuseMs ago, and the refresh grant that replaced it is still unused. The unused successor and the access
   * token issued with it are superseded, and a fresh pair is issued in the same family, within the successor's scope.
   * Anything else is a replay and ends the family, as before. The superseded successor gets the same window, so a
   * client that kept the other of two concurrent responses recovers by refreshing promptly.
   */
  private reissueWithinWindow(row: JsonObject, scopes?: string[]): OAuthTokens | undefined {
    const data = row.data as JsonObject,
      db = this.web.store.db,
      now = Date.now();
    if (
      !this.refreshReuseMs ||
      data.ended_reason !== undefined ||
      typeof data.rotated_at !== 'number' ||
      now - data.rotated_at > this.refreshReuseMs ||
      typeof data.successor !== 'string'
    )
      return;
    const next = db
      .prepare(
        "SELECT hash,data,used,expires_at FROM amcp_mcp_grants WHERE hash=? AND kind='refresh' AND client_id=? AND tenant_id=?",
      )
      .get(data.successor, row.client_id, row.tenant_id) as JsonObject | undefined;
    if (!next || next.used || next.expires_at <= now) return;
    const successor = JSON.parse(next.data) as JsonObject;
    if (successor.family !== data.family) return;
    this.assertUsable(data.ownerUserId, row.tenant_id);
    const current = (successor.scope ?? readScope).split(' ') as string[],
      requested = this.validateScopes(scopes ?? current);
    if (requested.some(s => !current.includes(s)))
      throw new InvalidScopeError('Refresh cannot add access. Start a new authorization to request write access.');
    const paired = db
      .prepare(
        "SELECT hash FROM amcp_mcp_grants WHERE tenant_id=? AND kind='access' AND used=0 AND json_extract(data,'$.pair')=?",
      )
      .all(row.tenant_id, next.hash) as JsonObject[];
    for (const access of paired) {
      db.prepare("UPDATE amcp_mcp_grants SET used=1,data=json_set(data,'$.superseded_at',?) WHERE hash=?").run(
        now,
        access.hash,
      );
      db.prepare('UPDATE api_keys SET revoked=1 WHERE tenant_id=? AND hash=?').run(row.tenant_id, access.hash);
    }
    const tokens = this.issue(row.client_id, {...successor, scope: requested.join(' ')}, row.tenant_id);
    this.rotated(next.hash, tokens.refresh_token!);
    db.prepare("UPDATE amcp_mcp_grants SET data=json_set(data,'$.successor',?) WHERE hash=?").run(
      sha256(tokens.refresh_token!),
      row.hash,
    );
    this.web.store.appendAudit(row.tenant_id, randomUUID(), {
      event: 'mcp_oauth_refresh_reused',
      client_id: row.client_id,
      age_ms: now - data.rotated_at,
      ...(data.ownerUserId ? {owner_user_id: data.ownerUserId} : {}),
    });
    return tokens;
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, token: string, scopes?: string[], resource?: URL) {
    this.validateResource(resource);
    const result = this.web.store.transaction((): OAuthTokens | {ended: GrantEndReason} => {
      const row = this.get(token, 'refresh', client.client_id, true);
      if (row.used) {
        const reissued = this.reissueWithinWindow(row, scopes);
        if (reissued) return reissued;
        const recorded = row.data.ended_reason as GrantEndReason | undefined;
        if (recorded && endedDescriptions[recorded]) return {ended: recorded};
        // A rotated token presented again outside the window: whoever holds it should not, so the family ends.
        const earlier = familyEndReason(this.web.store, row.tenant_id, row.data.family);
        this.revokeFamily(row.data.family, row.tenant_id, 'refresh_replay');
        return {ended: earlier ?? 'refresh_replay'};
      }
      this.assertUsable(row.data.ownerUserId, row.tenant_id);
      const original = (row.data.scope ?? readScope).split(' ') as string[],
        requested = this.validateScopes(scopes ?? original);
      if (requested.some(s => !original.includes(s)))
        throw new InvalidScopeError('Refresh cannot add access. Start a new authorization to request write access.');
      const tokens = this.issue(client.client_id, {...row.data, scope: requested.join(' ')}, row.tenant_id);
      this.rotated(row.hash, tokens.refresh_token!);
      return tokens;
    });
    if ('ended' in result) throw new InvalidGrantError(endedDescriptions[result.ended]);
    return result;
  }
  /**
   * Throws unless the access grant behind an AI-client access token (by its hash) is live (SEC-05): not ended or
   * superseded, not expired, issued to this actor's client, workspace, role and person, for this protected resource,
   * and, when approved from a password door, while that door keeps the password it was approved under. A grant from
   * before resources were recorded (at most an hour old at release) is accepted for this server's one resource.
   */
  assertAccessGrant(hash: string, actor: Actor) {
    const row = this.web.store.db
      .prepare("SELECT client_id,tenant_id,data,expires_at,used FROM amcp_mcp_grants WHERE hash=? AND kind='access'")
      .get(hash) as JsonObject | undefined;
    const data = row ? (JSON.parse(row.data) as JsonObject) : {};
    if (
      !row ||
      row.used ||
      row.expires_at <= Date.now() ||
      row.tenant_id !== actor.tenantId ||
      'oauth/' + row.client_id !== actor.userId ||
      roleOf((data.scope ?? readScope).split(' ')) !== actor.role ||
      (data.ownerUserId ?? undefined) !== actor.ownerUserId ||
      (data.resource !== undefined && data.resource !== this.resource.href) ||
      !this.web.doorGrantUsable(data.ownerUserId, row.tenant_id)
    )
      throw endedAccess();
  }
  /** The SDK's resource-server hook, answered by the same validator /mcp uses (SEC-05). */
  async verifyAccessToken(token: string) {
    validateMcpToken(this.web.store, token, this);
    const row = this.get(token, 'access');
    return {
      token,
      clientId: row.client_id,
      scopes: this.validateScopes(row.data.scope?.split(' ')),
      expiresAt: Math.floor(row.expires_at / 1000),
      resource: this.resource,
    };
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    const row = this.web.store.db
      .prepare('SELECT data,tenant_id FROM amcp_mcp_grants WHERE hash=? AND client_id=?')
      .get(sha256(request.token), client.client_id) as {data: string; tenant_id: string} | undefined;
    if (row) {
      const data = JSON.parse(row.data);
      if (data.family) this.revokeFamily(data.family, row.tenant_id, 'client_revoke');
    }
  }
  /**
   * The person a presented authorization code or refresh token belongs to, as "tenant\nowner", or '' when the
   * client has no such live grant. The per-client budget of successful token responses is kept per connection with it:
   * a client metadata document's client ID is shared by everyone using that app, so the client alone would put every
   * person and workspace of one app into one budget.
   */
  tokenSubject(clientId: string, body: unknown): string {
    const input = (body ?? {}) as JsonObject,
      [kind, token] =
        input.grant_type === 'refresh_token'
          ? ['refresh', input.refresh_token]
          : input.grant_type === 'authorization_code'
            ? ['code', input.code]
            : [undefined, undefined];
    if (!kind || typeof token !== 'string' || !token || token.length > 4096) return '';
    const row = this.web.store.db
      .prepare('SELECT tenant_id,data FROM amcp_mcp_grants WHERE hash=? AND kind=? AND client_id=?')
      .get(sha256(token), kind, clientId) as {tenant_id: string; data: string} | undefined;
    if (!row) return '';
    const owner = (JSON.parse(row.data) as JsonObject).ownerUserId;
    return row.tenant_id + '\n' + (typeof owner === 'string' ? owner : '');
  }
  /** Display names of the people who approved connections, for the workspace administrator's view. */
  private ownerNames(owners: Iterable<string>) {
    const names = new Map<string, string>(),
      byId = this.web.store.db.prepare('SELECT name FROM amcp_users WHERE id=?');
    for (const owner of owners) {
      const row = byId.get(owner) as {name?: string} | undefined;
      if (typeof row?.name === 'string') names.set(owner, row.name.slice(0, 120));
    }
    return names;
  }
  /**
   * Live authorizations of a workspace, one per client and approving person: a client metadata document (CIMD) client
   * ID is shared by every installation of that app, so each person's connection is listed (and revoked) on its own.
   * With `viewer` (a user ID, or null for the administrator door), each says whether that person approved it, so a
   * member can revoke their own. With `owners` (workspace administrators only), each names the person who approved
   * it (`owner`: their user ID, or null for the administrator sign-in) so one person's connection can be revoked.
   */
  authorizations(tenant = this.web.tenantId, viewer?: string | null, options: {owners?: boolean} = {}) {
    const rows = this.web.store.db
      .prepare(
        "SELECT g.client_id,g.expires_at,g.data AS grant_data,c.data FROM amcp_mcp_grants g LEFT JOIN amcp_mcp_clients c ON c.id=g.client_id WHERE g.tenant_id=? AND g.kind='refresh' AND g.used=0 AND g.expires_at>?",
      )
      .all(tenant, Date.now()) as JsonObject[];
    const clients = new Map<string, JsonObject>();
    for (const row of rows) {
      const grant = JSON.parse(row.grant_data),
        scopes = (grant.scope ?? readScope).split(' '),
        owner: string | null = typeof grant.ownerUserId === 'string' ? grant.ownerUserId : null,
        key = row.client_id + '\u0000' + (owner ?? ''),
        previous = clients.get(key);
      clients.set(key, {
        id: row.client_id,
        name: row.data ? JSON.parse(row.data).client_name : (grant.clientName ?? 'MCP client'),
        expiresAt: Math.max(row.expires_at, previous?.expiresAt ?? 0),
        role: scopes.includes(writeScope) || previous?.role === 'operator' ? 'operator' : 'reader',
        ...(viewer !== undefined ? {yours: owner === viewer} : {}),
        ...(options.owners ? {owner} : {}),
      });
    }
    const listed = [...clients.values()];
    if (options.owners) {
      const names = this.ownerNames(listed.flatMap(c => (typeof c.owner === 'string' ? [c.owner] : [])));
      for (const c of listed) c.ownerName = typeof c.owner === 'string' ? (names.get(c.owner) ?? null) : null;
    }
    return listed;
  }
  /** Connections of a workspace that ended in the last 14 days, newest first, with the recorded reason (MCP-08), one
   * per client and approving person. A connection the same person authorized again since then is listed with the live
   * authorizations instead. `owners` names the person, as in authorizations. */
  endedAuthorizations(tenant = this.web.tenantId, options: {owners?: boolean} = {}) {
    const now = Date.now(),
      rows = this.web.store.db
        .prepare(
          "SELECT g.client_id,json_extract(g.data,'$.ownerUserId') AS owner,max(json_extract(g.data,'$.ended_at')) AS ended_at,json_extract(g.data,'$.ended_reason') AS reason,json_extract(g.data,'$.clientName') AS grant_name,c.data FROM amcp_mcp_grants g LEFT JOIN amcp_mcp_clients c ON c.id=g.client_id WHERE g.tenant_id=? AND g.kind='refresh' AND json_extract(g.data,'$.ended_at')>? AND NOT EXISTS(SELECT 1 FROM amcp_mcp_grants l WHERE l.tenant_id=g.tenant_id AND l.client_id=g.client_id AND json_extract(l.data,'$.ownerUserId') IS json_extract(g.data,'$.ownerUserId') AND l.kind='refresh' AND l.used=0 AND l.expires_at>?) GROUP BY g.client_id,json_extract(g.data,'$.ownerUserId') ORDER BY ended_at DESC LIMIT 20",
        )
        .all(tenant, now - 14 * 86400000, now) as JsonObject[];
    const names = options.owners
      ? this.ownerNames(rows.flatMap(r => (typeof r.owner === 'string' ? [r.owner] : [])))
      : undefined;
    return rows.map(row => ({
      id: row.client_id as string,
      name: row.data ? (JSON.parse(row.data).client_name as string) : ((row.grant_name as string) ?? 'MCP client'),
      endedAt: row.ended_at as number,
      reason: row.reason as GrantEndReason,
      ...(names
        ? {
            owner: typeof row.owner === 'string' ? row.owner : null,
            ownerName: typeof row.owner === 'string' ? (names.get(row.owner) ?? null) : null,
          }
        : {}),
    }));
  }
  /**
   * Ends a client's grants in a workspace. `owner` limits it to one person's connection: a user ID, or null for
   * those approved from the administrator sign-in; undefined ends every person's connection of that client. Returns
   * the rows ended.
   */
  revokeClient(id: string, tenant = this.web.tenantId, owner?: string | null) {
    return endMcpGrants(
      this.web.store,
      'client_id=? AND tenant_id=?' +
        (owner === undefined
          ? ''
          : owner === null
            ? " AND json_extract(data,'$.ownerUserId') IS NULL"
            : " AND json_extract(data,'$.ownerUserId')=?"),
      owner === undefined || owner === null ? [id, tenant] : [id, tenant, owner],
      'workspace_revoke',
      {audit: false},
    );
  }
}
