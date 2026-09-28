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
import {sha256, safeEqual} from '../src/security.js';
import type {JsonObject} from '../src/types.js';

const opaque = () => randomBytes(32).toString('base64url');
const readScope = 'mcp:read',
  writeScope = 'mcp:write';
/** AMCP credentials carry only explicitly consented access. Platform tokens stay on the server. */
export class McpOAuth implements OAuthServerProvider {
  readonly resource: URL;
  constructor(
    readonly web: WebStore,
    readonly allowWrites = false,
  ) {
    this.resource = new URL(web.origin + '/mcp');
  }
  get clientsStore() {
    return {
      getClient: async (id: string) => {
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
        if (input.token_endpoint_auth_method !== 'none' && input.token_endpoint_auth_method !== 'client_secret_post')
          throw new InvalidClientMetadataError('Use none or client_secret_post with S256 PKCE.');
        if (
          !input.redirect_uris.length ||
          input.redirect_uris.length > 10 ||
          input.redirect_uris.some(uri => {
            try {
              const u = new URL(uri);
              return (
                !!(u.username || u.password || u.hash) ||
                (u.protocol !== 'https:' &&
                  !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
              );
            } catch {
              return true;
            }
          })
        )
          throw new InvalidClientMetadataError('Register exact HTTPS or loopback HTTP redirect URIs.');
        const scopes = this.validateScopes(
          input.scope === undefined
            ? this.allowWrites
              ? [readScope, writeScope]
              : [readScope]
            : input.scope.split(' '),
        );
        // Registration is anonymous, so a client that never completed authorization within a day is released; otherwise
        // abandoned registrations fill the cap below for good.
        this.web.store.db
          .prepare(
            "DELETE FROM amcp_mcp_clients WHERE json_extract(data,'$.client_id_issued_at')<? AND id NOT IN (SELECT client_id FROM amcp_mcp_grants)",
          )
          .run(Math.floor(Date.now() / 1000) - 86400);
        const count = this.web.store.db.prepare('SELECT count(*) AS n FROM amcp_mcp_clients').get() as {n: number};
        if (count.n >= 1000)
          throw new InvalidClientMetadataError(
            'Client registration limit reached. Contact the workspace administrator.',
          );
        const client: OAuthClientInformationFull = {
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_name: String(input.client_name ?? 'MCP client').slice(0, 120),
          redirect_uris: input.redirect_uris,
          token_endpoint_auth_method: input.token_endpoint_auth_method,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          scope: scopes.join(' '),
        };
        if (input.token_endpoint_auth_method === 'client_secret_post') {
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
  /** Additional constant-time authentication before the SDK's token/revocation handlers. */
  async authenticateClient(body: unknown, authorization?: string) {
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
  consent(request: string, session: WebSession) {
    if (session.actor.role !== 'admin') throw new InvalidGrantError('Workspace administrator access is required.');
    const row = this.get(request, 'request'),
      scopes = this.validateScopes(row.data.scope?.split(' '));
    return {
      name: row.data.clientName,
      redirectUri: row.data.redirectUri,
      scope: scopes.join(' '),
      role: scopes.includes(writeScope) ? 'operator' : 'reader',
      writesEnabled: this.allowWrites,
    };
  }
  decide(request: string, session: WebSession, approved: boolean) {
    this.consent(request, session);
    const owner = session.actor.userId !== 'workspace-admin' ? {ownerUserId: session.actor.userId} : {};
    return this.web.store.transaction(() => {
      this.assertUsable(owner.ownerUserId, session.actor.tenantId);
      const row = this.get(request, 'request');
      this.web.store.db.prepare('UPDATE amcp_mcp_grants SET used=1 WHERE hash=?').run(row.hash);
      const url = new URL(row.data.redirectUri);
      if (row.data.state !== undefined) url.searchParams.set('state', row.data.state);
      if (approved) {
        const code = opaque();
        this.put(code, 'code', row.client_id, {...row.data, ...owner}, 300000, session.actor.tenantId);
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
      if (row.data.family) this.web.store.transaction(() => this.revokeFamily(row.data.family, row.tenant_id));
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
      role = scopes.includes(writeScope) ? 'operator' : 'reader';
    const ownership = data.ownerUserId ? {ownerUserId: data.ownerUserId} : {},
      family = data.family ?? randomUUID(),
      access = this.web.store.createKey({tenantId: tenant, userId: 'oauth/' + client, role, ...ownership}, 3600000),
      refresh = opaque();
    this.put(access, 'access', client, {family, scope, ...ownership}, 3600000, tenant);
    this.put(refresh, 'refresh', client, {family, scope, ...ownership}, 30 * 86400000, tenant);
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
  private revokeFamily(family: string, tenant: string) {
    const rows = this.web.store.db
      .prepare("SELECT hash,kind,data FROM amcp_mcp_grants WHERE tenant_id=? AND kind IN ('access','refresh')")
      .all(tenant) as JsonObject[];
    for (const row of rows)
      if (JSON.parse(row.data).family === family) {
        this.web.store.db.prepare('UPDATE amcp_mcp_grants SET used=1 WHERE hash=?').run(row.hash);
        if (row.kind === 'access')
          this.web.store.db.prepare('UPDATE api_keys SET revoked=1 WHERE tenant_id=? AND hash=?').run(tenant, row.hash);
      }
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, token: string, scopes?: string[], resource?: URL) {
    this.validateResource(resource);
    const result = this.web.store.transaction(() => {
      const row = this.get(token, 'refresh', client.client_id, true);
      if (row.used) {
        this.revokeFamily(row.data.family, row.tenant_id);
        return undefined;
      }
      this.assertUsable(row.data.ownerUserId, row.tenant_id);
      const original = (row.data.scope ?? readScope).split(' ') as string[],
        requested = this.validateScopes(scopes ?? original);
      if (requested.some(s => !original.includes(s)))
        throw new InvalidScopeError('Refresh cannot add access. Start a new authorization to request write access.');
      this.web.store.db.prepare('UPDATE amcp_mcp_grants SET used=1 WHERE hash=?').run(row.hash);
      return this.issue(client.client_id, {...row.data, scope: requested.join(' ')}, row.tenant_id);
    });
    if (!result) throw new InvalidGrantError('Refresh token replay detected. Authorize the client again.');
    return result;
  }
  async verifyAccessToken(token: string) {
    this.web.store.authenticate(token);
    const row = this.get(token, 'access');
    this.assertUsable(row.data.ownerUserId, row.tenant_id);
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
      if (data.family) this.web.store.transaction(() => this.revokeFamily(data.family, row.tenant_id));
    }
  }
  authorizations(tenant = this.web.tenantId) {
    const rows = this.web.store.db
      .prepare(
        "SELECT g.client_id,g.expires_at,g.data AS grant_data,c.data FROM amcp_mcp_grants g JOIN amcp_mcp_clients c ON c.id=g.client_id WHERE g.tenant_id=? AND g.kind='refresh' AND g.used=0 AND g.expires_at>?",
      )
      .all(tenant, Date.now()) as JsonObject[];
    const clients = new Map<string, JsonObject>();
    for (const row of rows) {
      const scopes = (JSON.parse(row.grant_data).scope ?? readScope).split(' '),
        previous = clients.get(row.client_id);
      clients.set(row.client_id, {
        id: row.client_id,
        name: JSON.parse(row.data).client_name,
        expiresAt: Math.max(row.expires_at, previous?.expiresAt ?? 0),
        role: scopes.includes(writeScope) || previous?.role === 'operator' ? 'operator' : 'reader',
      });
    }
    return [...clients.values()];
  }
  revokeClient(id: string, tenant = this.web.tenantId) {
    this.web.store.transaction(() => {
      const rows = this.web.store.db
        .prepare('SELECT hash,kind FROM amcp_mcp_grants WHERE client_id=? AND tenant_id=?')
        .all(id, tenant) as JsonObject[];
      for (const row of rows) {
        this.web.store.db.prepare('UPDATE amcp_mcp_grants SET used=1 WHERE hash=?').run(row.hash);
        if (row.kind === 'access')
          this.web.store.db.prepare('UPDATE api_keys SET revoked=1 WHERE tenant_id=? AND hash=?').run(tenant, row.hash);
      }
    });
  }
}
