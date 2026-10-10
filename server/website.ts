import {compressedAssets} from './compressed-assets.js';
import {createPublicAssets, robotsTxt, securityTxt, type PublicPage} from './public-assets.js';
import {wooCommerceSources} from '../src/woocommerce-source.js';
import {mediaSourceRoutes} from './media-source-routes.js';
import express, {type Request, type Response, type NextFunction} from 'express';
import path from 'node:path';
import {reportEvidence} from '../src/report-quality.js';
import {randomUUID} from 'node:crypto';
import {WebStore, type WebsiteOptions} from './web-store.js';
import {PlatformOAuth, platform, platforms, selectableKinds, selectionKind} from './platform-oauth.js';
import {AssetDiscovery, type AssetGroup} from './asset-discovery.js';
import {MirrorService} from '../src/service.js';
import {MediaUploadService} from '../src/media-upload.js';
import {mediaType} from '../src/drive-media.js';
import {Store} from '../src/store.js';
import {disconnectLocalConnection} from '../src/connection-disconnect.js';
import {MirrorError} from '../src/errors.js';
import {sha256, stable} from '../src/security.js';
import type {Connection, Credentials, JsonObject} from '../src/types.js';
import {McpOAuth} from './mcp-oauth.js';
import {mcpOAuthProtocolRoutes} from './mcp-oauth-routes.js';
import {microsoftGateway} from '../src/microsoft-native.js';
import {ReportingOverview} from '../src/reporting-overview.js';
import {auditHistoryPage} from '../src/audit-history.js';
import {exportCsv} from '../src/google-sheets.js';
import {assertDownloadAllowed, downloadsAllowed, saveExportPolicy} from '../src/export-policy.js';
import {UserAccounts} from './user-accounts.js';
import {SocialSignIn} from './social-signin.js';
import {accountRoutes} from './account-routes.js';
import {mfaBaseline, mfaBaselineConfig} from './mfa-policy.js';
import {connectedAt, reviewerConnectionLifetime} from './account-lifecycle.js';
import {googleAuthorizationInfo, reauthorizeGoogleConnection} from './google-reauthorization.js';
import {authorizationRevision, reauthorizationEnabled, reauthorizeConnection} from './connection-reauthorization.js';
import {clearRefreshFailure, credentialHealth, recordAuthorized} from '../src/connection-health.js';
import {grantedScopes, publicGrants} from '../src/provider-grants.js';
import {mcpAuthRouter} from '@modelcontextprotocol/sdk/server/auth/router.js';

export function createWebsite(store: Store, options: WebsiteOptions, allowWrites = false, service?: MirrorService) {
  const web = new WebStore(store, options);
  // Saved logins use the app secrets of this deployment's environment, the one connecting uses (SEC-07 S2).
  if (options.authEnv || !store.appEnvironment) store.appEnvironment = options.authEnv ?? process.env;
  // Two-step verification for owners and administrators of write-enabled deployments (SEC-06, owner decision P2).
  web.mfaBaseline = mfaBaseline(store, web.tenantId, mfaBaselineConfig(options.authEnv ?? process.env, allowWrites));
  // How long a reviewer workspace login stays before the worker removes it (SEC-06 S6).
  const reviewerLifetime = reviewerConnectionLifetime(options.authEnv ?? process.env);
  const oauth = new PlatformOAuth(web, options.authEnv ?? process.env, options.fetcher, allowWrites),
    discovery = new AssetDiscovery(store, options.fetcher),
    router = express.Router({caseSensitive: true});
  router.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    );
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
  const mcpOAuth = new McpOAuth(web, allowWrites);
  const accounts = new UserAccounts(web),
    social = new SocialSignIn(accounts),
    // For handlers whose own `accounts` is a list of advertising accounts (recent-proof checks, SEC-06).
    webAccounts = accounts;
  // A test account is limited to the tabs an evaluator needs. Hiding navigation is presentation
  // only, so every API behind an excluded tab refuses it here, at one chokepoint.
  //
  // Evaluators can connect their own platform logins and manage their workspace's selections.
  // Connection mutations retain session, administrator, CSRF and tenant checks; callbacks retain
  // their session-bound OAuth state checks.
  // Keep an allow-list so new APIs remain excluded until explicitly added to this scope.
  const testAccountRoutes: [RegExp, string[]][] = [
    [/^\/api\/session$/, ['GET', 'DELETE']], // read the session, sign out
    [/^\/api\/session\/test$/, ['POST']], // the reviewer door itself
    [/^\/api\/platforms$/, ['GET']], // Connections tab: available platforms
    [/^\/api\/auth\/[^/]+\/start$/, ['POST']], // Connections: initiate provider authorization
    [/^\/api\/auth\/[^/]+\/callback$/, ['GET']], // Session-bound provider return
    [/^\/api\/[^/]+\/callback$/, ['GET']], // Existing provider callback alias
    [/^\/api\/oauth\/progress\/[^/]+$/, ['GET']], // Connections: authorization and discovery result
    [/^\/api\/connections\/[^/]+$/, ['GET', 'DELETE']],
    [/^\/api\/connections\/[^/]+\/(reauthorize|sync|default|credential-retry)$/, ['POST']],
    [/^\/api\/connections\/[^/]+\/(assets|write-access)$/, ['PATCH']],
    [/^\/api\/activity$/, ['GET']], // Activity tab
    [/^\/api\/reporting-overview\/[^/]+$/, ['GET']], // Reporting overview: CSV export
    [/^\/api\/workspace\/[a-z]+$/, ['POST']], // narrowed further by testAccountTools below
    [/^\/api\/account$/, ['GET']], // Settings: read own profile
    [/^\/api\/account\/(options|delivery|sessions)$/, ['GET']],
    [/^\/api\/account\/sessions\/[^/]+$/, ['DELETE']], // Settings: end one's own sessions
    [/^\/api\/account\/reauthenticate$/, ['POST']], // "Confirm it's you" before a write grant (SEC-06)
    [/^\/api\/workspaces(\/members)?$/, ['GET']], // Settings: the reviewer's own workspace
  ];
  // Deliberately absent, because the reviewer password is shared: changing the password, email,
  // MFA or linked identities would let one evaluator lock every other one out, and owner
  // administration is not part of an evaluation.
  const testAccountTools = new Set(['workspace', 'overview']);
  // The gate compares a lower-cased path, and the router above matches case-sensitively. Express
  // routes case-insensitively by default, so a case-sensitive prefix test here let `/API/...`
  // skip the gate while still reaching the handler — five endpoints, connector tokens among
  // them, were reachable that way. Both halves matter: the router option stops odd spellings
  // routing at all, and the lower-cased comparison means this gate never depends on that option
  // still being set.
  router.use((req, _res, next) => {
    let session;
    try {
      session = web.session(req);
    } catch {
      return next();
    }
    const path = req.path.toLowerCase(),
      method = req.method.toUpperCase();
    if (!session?.actor.testAccount || !path.startsWith('/api/')) return next();
    const refuse = () =>
      next(new MirrorError('TEST_ACCOUNT_SCOPE', 'This test account does not include that area of AMCP.', {}, 403));
    if (!testAccountRoutes.some(([route, methods]) => route.test(path) && methods.includes(method))) return refuse();
    const tool = /^\/api\/workspace\/([a-z]+)$/.exec(path)?.[1];
    if (tool && !testAccountTools.has(tool)) return refuse();
    next();
  });
  // A member whose two-step grace period ended before they enrolled reaches only sign-in, account and enrollment
  // routes (SEC-06 S3); the same lower-cased comparison as the test-account gate above.
  const enrollmentRoutes: [RegExp, string[]][] = [
    [/^\/api\/session$/, ['GET', 'DELETE']],
    [/^\/api\/platforms$/, ['GET']], // the shell's start-up read
    [/^\/api\/account$/, ['GET']],
    [/^\/api\/account\/(options|sessions)$/, ['GET']],
    [/^\/api\/account\/sessions\/[^/]+$/, ['DELETE']],
    [/^\/api\/account\/(reauthenticate|mfa\/start|mfa\/enable)$/, ['POST']],
    [/^\/api\/workspaces$/, ['GET']],
    [/^\/api\/workspaces\/switch$/, ['POST']],
  ];
  router.use((req, _res, next) => {
    let session;
    try {
      session = web.session(req);
    } catch {
      return next();
    }
    const path = req.path.toLowerCase(),
      method = req.method.toUpperCase();
    if (!session?.actor.mfaEnrollmentRequired || !path.startsWith('/api/')) return next();
    if (enrollmentRoutes.some(([route, methods]) => route.test(path) && methods.includes(method))) return next();
    next(
      new MirrorError(
        'MFA_ENROLLMENT_REQUIRED',
        'This workspace requires two-step verification. Set it up in Account to continue.',
        {},
        403,
      ),
    );
  });
  router.use(accountRoutes(web, accounts, social));
  router.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(['/token', '/revoke'], express.urlencoded({extended: false, limit: '16kb'}), async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      next();
      return;
    }
    // Only failures count (SEC-01): an address that failed 50 times in 15 minutes waits, but clients that authenticate
    // and exchange successfully never use up the bucket they share with everyone behind the same address.
    const address = web.limitAddress(req),
      tooMany = (seconds: number, description: string) =>
        res
          .status(429)
          .setHeader('Retry-After', String(seconds))
          .json({error: 'too_many_requests', error_description: description});
    const wait = web.mcpFailureWait(address);
    if (wait) {
      tooMany(wait, 'Too many failed token requests from this network. Try again later.');
      return;
    }
    let clientId: string;
    try {
      clientId = await mcpOAuth.authenticateClient(req.body, req.headers.authorization);
    } catch {
      web.recordMcpFailure(address);
      res
        .status(400)
        .json({error: 'invalid_client', error_description: 'Invalid client credentials or authentication method.'});
      return;
    }
    const token = req.baseUrl === '/token',
      // The success budget is per connection (client, workspace and approving person), not per client ID alone: a
      // client metadata document's client ID is shared by everyone using that app (SEC-01 with MCP-03).
      subject = token ? mcpOAuth.tokenSubject(clientId, req.body) : '';
    if (token) {
      const clientWait = web.mcpClientWait(clientId, subject);
      if (clientWait) {
        tooMany(clientWait, 'Too many token requests for this client. Try again later.');
        return;
      }
    }
    // A refused grant (invalid_grant and other 4xx answers of the token handler) counts as a failure afterwards.
    res.on('finish', () => {
      if (res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 429) web.recordMcpFailure(address);
      else if (token && res.statusCode < 300) web.recordMcpClientSuccess(clientId, subject);
    });
    next();
  });
  // The SDK's limiters default to req.ip, which is the proxy's address behind Railway (Express trust proxy is off), so
  // every client shared one bucket. Key them on the same resolved client address as every other AMCP limit.
  const sdkRateLimit = {
    keyGenerator: (req: express.Request) => web.limitAddress(req),
    validate: {xForwardedForHeader: false, keyGeneratorIpFallback: false},
  };
  // Token and revocation answers that succeed are not counted by the SDK's limiter either (SEC-01).
  const sdkFailureLimit = {...sdkRateLimit, skipSuccessfulRequests: true};
  const authRouterOptions = {
    authorizationOptions: {rateLimit: sdkRateLimit},
    tokenOptions: {rateLimit: sdkFailureLimit},
    clientRegistrationOptions: {rateLimit: sdkRateLimit},
    revocationOptions: {rateLimit: sdkFailureLimit},
    provider: mcpOAuth,
    issuerUrl: new URL(web.origin),
    resourceServerUrl: mcpOAuth.resource,
    scopesSupported: allowWrites ? ['mcp:read', 'mcp:write'] : ['mcp:read'],
    resourceName: 'AMCP',
    serviceDocumentationUrl: new URL(web.origin + '/connectors'),
  };
  // MCP-03: iss on authorization responses, CIMD and readable errors, in front of the SDK's own routes.
  router.use(mcpOAuthProtocolRoutes(mcpOAuth, authRouterOptions));
  router.use(mcpAuthRouter(authRouterOptions));
  const handler =
    (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
      try {
        await fn(req, res);
      } catch (e) {
        next(e);
      }
    };
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
  const publicConnection = (tenant: string, c: Connection) => {
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
    const dead = health.state === 'reauthorization_required';
    return {
      id: c.id,
      name: c.label,
      enabled: c.enabled,
      isDefault: c.isDefault === true,
      defaultWriteAccess: c.defaultWriteAccess === true,
      accounts: c.accounts,
      writeAccounts: (c.writeAccounts ?? []).filter(id => c.accounts.includes(id)),
      // The login's own expiry: null while AMCP renews access automatically (CON-02).
      expiresAt: health.login_expires_at,
      credentialHealth: health,
      // What the provider confirmed it granted, including declined Meta permissions (CON-03); names and dates only.
      grants: publicGrants(readDocument(tenant, 'website_connection', c.id, {}).grants),
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
      ...(c.gateway === 'google_ads_native_action'
        ? {authorization: googleAuthorizationInfo(store, c, oauth.config(platform('google')).clientId)}
        : {}),
    };
  };
  const sync = async (tenant: string, c: Connection, assertActive: () => void, kinds?: string[]) => {
    const revision = authorizationRevision(store, tenant, c.id);
    const result = await discovery.sync(c, kinds, assertActive);
    result.assertCurrent();
    // A newer authorization also prevents an older in-flight sync from replacing its asset inventory (CON-02).
    if (authorizationRevision(store, tenant, c.id) !== revision)
      throw new MirrorError(
        'CONNECTION_CHANGED',
        c.gateway === 'google_ads_native_action'
          ? 'Google was reauthorized while this sync was running. Refresh the connection to see its current assets.'
          : 'This login was reauthorized while this sync was running. Refresh the connection to see its current assets.',
        {},
        409,
      );
    // The provider user discovery read (Meta, Microsoft) identifies the login for later renewals (D19), and Meta's
    // permissions read records what was actually granted (CON-03).
    if (result.identity || result.grants) {
      const record = readDocument(tenant, 'website_connection', c.id, {});
      if ((result.identity && !record.providerId) || result.grants)
        store.putDocument(tenant, 'website_connection', c.id, {
          ...Object.fromEntries(Object.entries(record).filter(([k]) => !['id', 'revision'].includes(k))),
          ...(result.identity && !record.providerId ? {providerId: result.identity} : {}),
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
      const accountCustomers =
        c.gateway === microsoftGateway && accountsGroup
          ? Object.fromEntries(accountsGroup.assets.filter(a => accounts.includes(a.id)).map(a => [a.id, a.parentId!]))
          : c.accountCustomers;
      const accountLoginCustomers =
        c.gateway === 'google_ads_native_action' && accountsGroup
          ? Object.fromEntries(
              accountsGroup.assets
                .filter(a => accounts.includes(a.id) && a.loginCustomerId)
                .map(a => [a.id, a.loginCustomerId!]),
            )
          : c.accountLoginCustomers;
      if (
        accounts.length !== c.accounts.length ||
        JSON.stringify(accountCustomers) !== JSON.stringify(c.accountCustomers) ||
        JSON.stringify(accountLoginCustomers) !== JSON.stringify(c.accountLoginCustomers)
      ) {
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
      error: failed.length ? failed.map(g => g.error).join(' ') : null,
    });
    if (result.label) {
      c = {...c, label: result.label};
      // Only the label changes: the stored login revision and grants stay as they are now (CON-01).
      store.db
        .prepare("UPDATE connections SET data=json_set(data,'$.label',?) WHERE tenant_id=? AND id=?")
        .run(result.label, tenant, c.id);
    }
    store.appendAudit(tenant, randomUUID(), {
      event: 'website_asset_sync',
      connection_id: c.id,
      kinds: result.groups.map(g => g.kind),
      complete: failed.length === 0,
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
  if (service) {
    router.get(
      '/api/reporting-evidence/:id.xlsx',
      handler(async (req, res) => {
        const session = web.requireSession(req),
          tenant = session.actor.tenantId,
          id = String(req.params.id),
          language = req.query.language ?? 'en';
        assertDownloadAllowed(store, session.actor);
        if (typeof language !== 'string' || !['en', 'ar'].includes(language))
          throw new MirrorError('INVALID_ARGUMENT', 'Choose an evidence workbook language: en or ar.', {}, 400);
        const report = store.document(tenant, 'decision_report', id);
        store.resolveConnection(session.actor, report.gateway, report.account_id, report.connection_id);
        const {evidenceArtifact} = await import('../src/evidence-artifacts.js');
        const bytes = await evidenceArtifact(tenant, {...report, id}, language);
        const current = web.requireSession(req);
        if (current.actor.tenantId !== tenant || current.actor.userId !== session.actor.userId)
          throw new MirrorError('FORBIDDEN', 'The report session changed.', {}, 403);
        assertDownloadAllowed(store, current.actor);
        store.resolveConnection(current.actor, report.gateway, report.account_id, report.connection_id);
        const retained = store.document(tenant, 'decision_report', id);
        if (retained.revision !== report.revision)
          throw new MirrorError(
            'REVISION_CONFLICT',
            'The evidence changed during generation. Download it again.',
            {},
            409,
          );
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Disposition', 'attachment; filename="AMCP-detailed-evidence.xlsx"');
        res.setHeader('X-Content-SHA256', sha256(bytes));
        res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(bytes);
      }),
    );
    for (const format of ['pdf', 'xlsx'] as const)
      router.get(
        '/api/reporting-files/:id.' + format,
        handler((req, res) => {
          const session = web.requireSession(req),
            overview = new ReportingOverview(service);
          assertDownloadAllowed(store, session.actor);
          const file = overview.files.download(session.actor, String(req.params.id), format);
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Content-Disposition', 'attachment; filename="AMCP-retained-report.' + format + '"');
          res.setHeader('X-Content-SHA256', file.sha256);
          res.type(file.mime_type).send(file.bytes);
        }),
      );
    for (const format of ['pdf', 'xlsx'] as const)
      router.get(
        '/api/reporting-overview/:id.' + format,
        handler(async (req, res) => {
          const session = web.requireSession(req),
            tenant = session.actor.tenantId,
            id = String(req.params.id);
          assertDownloadAllowed(store, session.actor);
          const overview = new ReportingOverview(service),
            report = store.document(tenant, 'overview_report', id);
          overview.access(session.actor, report.config);
          const {retainedPresentation} = await import('../src/report-packs.js');
          const {reportArtifact} = await import('../src/report-artifacts.js');
          const style = retainedPresentation(store, tenant, id);
          const bytes = await reportArtifact(tenant, report, format, style.presentation);
          const current = web.requireSession(req);
          if (current.actor.tenantId !== tenant || current.actor.userId !== session.actor.userId)
            throw new MirrorError('FORBIDDEN', 'The report session changed.', {}, 403);
          assertDownloadAllowed(store, current.actor);
          const retained = store.document(tenant, 'overview_report', id);
          overview.access(current.actor, retained.config);
          if (
            retained.revision !== report.revision ||
            retainedPresentation(store, tenant, id).presentation_revision !== style.presentation_revision
          )
            throw new MirrorError(
              'REVISION_CONFLICT',
              'The report or presentation changed during generation. Download it again.',
              {},
              409,
            );
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Content-Disposition', 'attachment; filename="AMCP-report-pack.' + format + '"');
          res
            .type(
              format === 'pdf'
                ? 'application/pdf'
                : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            )
            .send(bytes);
        }),
      );
    router.get(
      '/api/reporting-overview/:id.metadata.json',
      handler((req, res) => {
        const session = web.requireSession(req);
        assertDownloadAllowed(store, session.actor);
        const report = store.document(session.actor.tenantId, 'overview_report', String(req.params.id));
        new ReportingOverview(service).access(session.actor, report.config);
        res.setHeader('Content-Disposition', 'attachment; filename=AMCP-report-evidence.json');
        res.json(reportEvidence(report));
      }),
    );
    router.get(
      '/api/reporting-overview/:id.csv',
      handler((req, res) => {
        const session = web.requireSession(req);
        assertDownloadAllowed(store, session.actor);
        const report = store.document(session.actor.tenantId, 'overview_report', String(req.params.id));
        new ReportingOverview(service).access(session.actor, report.config);
        const csv = exportCsv(report);
        res.setHeader('Content-Disposition', 'attachment; filename=AMCP-campaign-report.csv');
        res.type('text/csv').send(csv);
      }),
    );
    router.post(
      '/api/workspace/:tool',
      express.json({limit: '512kb'}),
      handler(async (req, res) => {
        const session = web.requireMutation(req),
          tools: Record<string, string> = {
            workspace: 'amcp_workspace',
            campaign: 'amcp_campaign',
            reporting: 'amcp_reporting',
            overview: 'amcp_reporting_overview',
            media: 'amcp_media',
            write: 'amcp_write',
            previews: 'amcp_ad_previews',
          };
        const tool = tools[String(req.params.tool)];
        if (!tool) throw new MirrorError('NOT_FOUND', 'Unknown workspace operation.', {}, 404);
        const actor = {...session.actor};
        store.bindActorCheck(actor, () => {
          web.requireMutation(req);
        });
        const result = await service.call(tool, req.body, actor);
        web.requireMutation(req);
        res.setHeader('Cache-Control', 'no-store');
        res.json(result);
      }),
    );
    router.use(mediaSourceRoutes(web, store, () => service.mediaSources()));
    router.post(
      '/api/commerce/stores',
      express.json({limit: '4kb'}),
      handler(async (req, res) => {
        const session = web.requireAdminMutation(req),
          actor = {...session.actor},
          controller = new AbortController();
        const current = () => {
          const now = web.requireAdminMutation(req);
          if (now.id !== session.id || now.csrf !== session.csrf || stable(now.actor) !== stable(actor))
            throw new MirrorError(
              'CONNECTION_CHANGED',
              'Workspace access changed during setup. Refresh Commerce and sign in again.',
              {},
              403,
            );
        };
        store.bindActorCheck(actor, current);
        const closed = () => {
          if (!res.writableEnded) controller.abort();
        };
        res.on('close', closed);
        try {
          current();
          const result = await service.connectWooCommerce(actor, req.body, controller.signal);
          current();
          res.status(result.replayed ? 200 : 201).json(result);
        } finally {
          res.off('close', closed);
        }
      }),
    );
    router.delete(
      '/api/commerce/stores/:id',
      express.json({limit: '1kb'}),
      handler((req, res) => {
        const session = web.requireAdminMutation(req),
          id = String(req.params.id);
        if (
          !/^[A-Za-z0-9_-]{1,160}$/.test(id) ||
          !req.body ||
          typeof req.body !== 'object' ||
          Array.isArray(req.body) ||
          Object.keys(req.body).length !== 1 ||
          req.body.confirmed !== true
        )
          throw new MirrorError(
            'WOOCOMMERCE_DISCONNECT_CONFIRMATION_REQUIRED',
            'Confirm removal of this local WooCommerce connection. The store key and products are not changed.',
          );
        const receipt = disconnectLocalConnection(store, session.actor, 'commerce_native_action', id, 'website');
        res.json(receipt);
      }),
    );
    router.get(
      '/api/media/variants/:id/preview',
      handler((req, res) => {
        const session = web.requireSession(req),
          media = new MediaUploadService(
            service.registry,
            store,
            service.transport,
            service.credentials,
            service.policy,
            options.fetcher,
          ),
          v = media.variant(session.actor, String(req.params.id)),
          bytes = store.stagedMedia(session.actor.tenantId, v.id);
        if (sha256(bytes) !== v.sha256 || mediaType(bytes).mime !== v.mime)
          throw new MirrorError('MEDIA_CHANGED', 'Preview integrity check failed.');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.type(v.mime).send(bytes);
      }),
    );
  }
  router.get(
    '/api/session',
    handler((req, res) => {
      const session = web.session(req);
      res.json({
        authenticated: !!session,
        configured: web.configured,
        testConfigured: web.testConfigured,
        csrf: session?.csrf ?? null,
        ...(session ? accounts.profile(session) : {name: null}),
        // Whether this person may download report files (SEC-05); the download routes enforce it.
        ...(session ? {downloadsAllowed: downloadsAllowed(store, session.actor)} : {}),
        origin: web.origin,
        readOnly: !allowWrites,
        writesEnabled: allowWrites,
      });
    }),
  );
  // The workspace owner decides whether viewers may download report files (SEC-05, account_settings/exports).
  router.post(
    '/api/export-policy',
    express.json({limit: '4kb'}),
    handler((req, res) => {
      const s = web.requireMutation(req);
      res.json(saveExportPolicy(store, s.actor, req.body && typeof req.body === 'object' ? req.body : {}));
    }),
  );
  router.post(
    '/api/session',
    express.json({limit: '4kb'}),
    handler(async (req, res) => {
      web.requireOrigin(req);
      if (typeof req.body?.password !== 'string')
        throw new MirrorError('INVALID_LOGIN', 'Enter your workspace password.', {}, 400);
      const old = web.session(req),
        session = await web.signIn(req.body.password, web.limitAddress(req));
      if (old) web.signOut(old.id);
      res.setHeader('Set-Cookie', web.cookie(session.id));
      res.json({authenticated: true, csrf: session.csrf, name: 'Workspace administrator'});
    }),
  );
  router.post(
    '/api/session/test',
    express.json({limit: '4kb'}),
    handler(async (req, res) => {
      web.requireOrigin(req);
      if (typeof req.body?.password !== 'string')
        throw new MirrorError('INVALID_LOGIN', 'Enter the test password.', {}, 400);
      const old = web.session(req),
        session = await web.signInTest(req.body.password, web.limitAddress(req));
      if (old) web.signOut(old.id);
      res.setHeader('Set-Cookie', web.cookie(session.id));
      res.json({authenticated: true, csrf: session.csrf, name: 'Test reviewer'});
    }),
  );
  router.delete(
    '/api/session',
    handler((req, res) => {
      const session = web.requireMutation(req);
      web.signOut(session.id);
      res.setHeader('Set-Cookie', [web.cookie('', 0), social.cookie('', 0)]);
      res.json({success: true});
    }),
  );
  // The person an AI-client grant or connector token belongs to: an account user, or null for the administrator door.
  const grantOwner = (s: {actor: {userId: string}}) => (s.actor.userId === 'workspace-admin' ? null : s.actor.userId);
  router.get(
    '/api/mcp/consent',
    handler((req, res) => {
      const s = web.requireSession(req);
      if (typeof req.query.request !== 'string')
        throw new MirrorError('INVALID_CONSENT', 'Start authorization from your MCP client.');
      const consent = mcpOAuth.consent(req.query.request, s),
        profile = accounts.profile(s);
      res.json({
        ...consent,
        // The workspace the grant binds, named above the decision (MCP-08).
        workspace: {id: profile.workspaceId, name: profile.workspaceName},
        memberRole: profile.workspaceRole ?? null,
      });
    }),
  );
  router.post(
    '/api/mcp/consent',
    express.json({limit: '4kb'}),
    handler((req, res) => {
      const s = web.requireMutation(req);
      if (
        typeof req.body?.request !== 'string' ||
        typeof req.body?.approved !== 'boolean' ||
        (req.body.scope !== undefined && typeof req.body.scope !== 'string')
      )
        throw new MirrorError('INVALID_CONSENT', 'Invalid authorization decision.');
      // An approval issues a 30-day refresh family, so it needs recent proof of identity (SEC-06); a denial does not.
      if (req.body.approved) accounts.fresh(s);
      const consent = mcpOAuth.consent(req.body.request, s),
        url = mcpOAuth.decide(req.body.request, s, req.body.approved, req.body.scope),
        scope: string = req.body.approved ? (req.body.scope ?? consent.scope) : consent.scope,
        owner = grantOwner(s);
      // Approvals and denials name the client, so they join the later mcp_oauth_family_revoked rows (MCP-08).
      store.appendAudit(s.actor.tenantId, randomUUID(), {
        event: req.body.approved ? 'mcp_oauth_approved' : 'mcp_oauth_denied',
        client_id: consent.clientId,
        client_name: String(consent.name ?? '').slice(0, 120),
        redirect_host: consent.redirectHost,
        requested_scope: consent.requestedScope,
        scope,
        role: scope.split(' ').includes('mcp:write') ? 'operator' : 'reader',
        ...(owner ? {owner_user_id: owner} : {}),
      });
      res.json({url});
    }),
  );
  router.get(
    '/api/mcp/authorizations',
    handler((req, res) => {
      const s = web.requireSession(req),
        // Administrators see who approved each connection, so they can end one person's (MCP-08 with CIMD).
        owners = s.actor.role === 'admin';
      res.json({
        clients: mcpOAuth.authorizations(s.actor.tenantId, grantOwner(s), {owners}),
        ended: mcpOAuth.endedAuthorizations(s.actor.tenantId, {owners}),
      });
    }),
  );
  router.delete(
    '/api/mcp/authorizations/:id',
    handler((req, res) => {
      const s = web.requireMutation(req),
        id = String(req.params.id),
        administrator = s.actor.role === 'admin',
        // ?owner=<user ID> (or empty for the administrator sign-in) ends one person's connection of this client.
        requested = typeof req.query.owner === 'string' ? req.query.owner || null : undefined,
        owner = administrator ? requested : s.actor.userId;
      // Administrators revoke any connection of the workspace; a member revokes the connections they authorized.
      const ended = mcpOAuth.revokeClient(id, s.actor.tenantId, owner);
      if (!administrator && !ended)
        throw new MirrorError(
          'FORBIDDEN',
          'You can revoke only the AI clients you authorized. Ask a workspace administrator to revoke this one.',
          {},
          403,
        );
      store.appendAudit(s.actor.tenantId, randomUUID(), {
        event: 'mcp_oauth_revoked',
        client_id: id,
        reason: 'workspace_revoke',
        grants: ended,
        ...(owner !== undefined ? {owner_user_id: owner} : {}),
        ...(grantOwner(s) ? {by_user_id: grantOwner(s)} : {}),
      });
      res.json({success: true});
    }),
  );
  router.get(
    '/api/platforms',
    handler((req, res) => {
      const session = web.session(req),
        connections = session ? store.listConnections(session.actor.tenantId) : [];
      res.json({
        platforms: oauth.publicConfig().map(p => ({
          ...p,
          connections: connections
            .filter(c => c.gateway === p.gateway)
            .map(c => publicConnection(session!.actor.tenantId, c)),
        })),
        authenticated: !!session,
        commerce_sources: session ? wooCommerceSources(store, session.actor).items : [],
      });
    }),
  );
  router.post(
    '/api/auth/:platform/start',
    express.json({limit: '4kb'}),
    handler(async (req, res) => {
      const session = web.requireAdminMutation(req),
        id = String(req.params.platform),
        p = platform(id);
      if (!p.authType) {
        res.json(await oauth.start(session, id));
        return;
      }
      if (session.actor.tenantId !== web.tenantId)
        throw new MirrorError(
          'SERVICE_CONNECTION_RESTRICTED',
          'This server-owned API connection is available only in the deployment administrator workspace.',
          {},
          403,
        );
      const result = await oauth.connectService(id),
        connectionId = randomUUID(),
        attemptId = randomUUID(),
        tenant = session.actor.tenantId;
      // Browser sessions may be revoked while the token service is responding.
      web.requireAdminMutation(req);
      const c: Connection = {
        id: connectionId,
        tenantId: tenant,
        gateway: p.gateway,
        accounts: [],
        ...(p.id === 'reddit' ? {userAgent: oauth.redditUserAgent()} : {}),
        defaultWriteAccess: allowWrites,
        label: result.label,
        enabled: false,
        scopes: result.scopes,
        isDefault: !store.listConnections(tenant).some(c => c.gateway === p.gateway && c.isDefault),
      };
      store.putConnection(session.actor, c, result.credentials);
      store.putDocument(tenant, 'website_connection', connectionId, {
        platform: id,
        expiresAt: result.credentials.expiresAt ?? null,
        createdAt: Date.now(),
      });
      recordAuthorized(store, connection(tenant, connectionId), result.credentials);
      store.appendAudit(tenant, attemptId, {
        event: 'website_api_connected',
        platform: id,
        connection_id: connectionId,
        vendor_writes: 0,
      });
      let error: string | null = null;
      try {
        error = (
          await sync(tenant, c, () => {
            web.requireAdminMutation(req);
          })
        ).error;
      } catch (e) {
        error =
          e instanceof MirrorError
            ? e.message
            : 'Asset sync could not be completed. Retry from the connection manager.';
      }
      store.putDocument(tenant, 'oauth_progress', attemptId, {
        platform: id,
        state: error ? 'sync_attention' : 'complete',
        authorization: true,
        exchange: true,
        sync: !error,
        connectionId,
        createdAt: Date.now(),
        message: error ?? 'Connection secured. Choose the assets AMCP can use.',
      });
      res.json({url: '/oauth/result?attempt=' + encodeURIComponent(attemptId), attemptId});
    }),
  );
  const callback = handler(async (req, res) => {
    const session = web.requireSession(req),
      id = String(req.params.platform),
      query: Record<string, string> = {};
    platform(id);
    const assertActive = () => {
      const current = web.requireSession(req);
      if (
        current.actor.role !== 'admin' ||
        current.actor.tenantId !== session.actor.tenantId ||
        current.actor.userId !== session.actor.userId
      )
        throw new MirrorError('FORBIDDEN', 'A current workspace administrator session is required.', {}, 403);
    };
    assertActive();
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v !== 'string' || v.length > 8192)
        throw new MirrorError('OAUTH_CALLBACK_INVALID', 'The provider returned invalid callback parameters.', {}, 400);
      query[k] = v;
    }
    if (!query.state)
      throw new MirrorError('OAUTH_STATE_INVALID', 'The callback is missing its security state.', {}, 400);
    const pending = web.consumeOAuth(session, id, query.state),
      attemptId = String(pending.attemptId),
      tenant = session.actor.tenantId,
      p = platform(id);
    const progress = (data: JsonObject) =>
      store.putDocument(tenant, 'oauth_progress', attemptId, {platform: id, createdAt: Date.now(), ...data});
    let securedConnectionId: string | undefined;
    try {
      progress({state: 'exchange', authorization: true, exchange: false, sync: false});
      const result = await oauth.exchange(id, pending, query, assertActive),
        connectionId = pending.reauthorization?.connectionId ?? randomUUID();
      // A completed token exchange must not restore access after the initiating session ended.
      assertActive();
      if (pending.reauthorization) {
        // The state names the platform it was started for; a callback on another platform's route cannot use it.
        if ((pending.reauthorization.platform ?? 'google') !== id)
          throw new MirrorError('OAUTH_STATE_INVALID', 'This reauthorization does not match this platform.', {}, 400);
        progress({state: 'sync', authorization: true, exchange: true, sync: false, connectionId});
        const renewalInput = {
          store,
          actor: session.actor,
          connectionId,
          revision: pending.reauthorization.revision ?? null,
          credentials: result.credentials,
          scopes: result.scopes,
          allowWrites: allowWrites && pending.requestedWriteAccess === true,
          assertActive,
        };
        if (id === 'google') await reauthorizeGoogleConnection({...renewalInput, fetcher: options.fetcher});
        else
          await reauthorizeConnection({
            ...renewalInput,
            platform: p,
            providerId: result.providerId,
            loginExpiresAt: result.loginExpiresAt ?? null,
            grants: result.grants,
            discovery,
          });
        securedConnectionId = connectionId;
        progress({
          state: 'complete',
          authorization: true,
          exchange: true,
          sync: true,
          connectionId,
          message:
            id === 'google'
              ? 'Google authorization renewed and account access verified. Your account selections, saved reports and schedules are preserved.'
              : 'Authorization renewed and account access verified. Your account selections, saved reports and schedules are preserved.',
        });
        res.redirect(303, '/oauth/result?attempt=' + encodeURIComponent(attemptId));
        return;
      }
      const c: Connection = {
        id: connectionId,
        tenantId: tenant,
        gateway: p.gateway,
        accounts: [],
        ...(p.id === 'reddit' ? {userAgent: oauth.redditUserAgent()} : {}),
        defaultWriteAccess: p.reviewedWrites !== false && allowWrites && pending.requestedWriteAccess === true,
        label: result.label,
        enabled: false,
        scopes: result.scopes,
        isDefault: !store.listConnections(tenant).some(c => c.gateway === p.gateway && c.isDefault),
      };
      store.putConnection(session.actor, c, result.credentials);
      securedConnectionId = connectionId;
      store.putDocument(tenant, 'website_connection', connectionId, {
        platform: id,
        expiresAt: result.credentials.expiresAt ?? null,
        providerId: result.providerId ?? null,
        ...(result.grants ? {grants: result.grants} : {}),
        createdAt: Date.now(),
      });
      recordAuthorized(store, connection(tenant, connectionId), result.credentials, result.loginExpiresAt ?? null);
      store.appendAudit(tenant, attemptId, {
        event: 'website_oauth_connected',
        platform: id,
        connection_id: connectionId,
      });
      progress({state: 'sync', authorization: true, exchange: true, sync: false, connectionId});
      const synced = await sync(tenant, c, assertActive);
      progress({
        state: synced.error ? 'sync_attention' : 'complete',
        authorization: true,
        exchange: true,
        sync: !synced.error,
        connectionId,
        message: synced.error ?? 'Connection secured. Choose the assets AMCP can use.',
      });
    } catch (e) {
      const diagnostics = e instanceof MirrorError && Array.isArray(e.details.diagnostics) ? e.details.diagnostics : [];
      progress({
        state: securedConnectionId ? 'sync_attention' : 'failed',
        authorization: !query.error && !query.denied,
        exchange: !!securedConnectionId,
        sync: false,
        connectionId: securedConnectionId ?? pending.reauthorization?.connectionId,
        message: e instanceof MirrorError ? e.message : 'The connection could not be completed. Start again from AMCP.',
        ...(diagnostics.length ? {diagnostics} : {}),
      });
      if (pending.reauthorization)
        store.appendAudit(tenant, attemptId, {
          event: 'website_oauth_reauthorization_failed',
          platform: id,
          connection_id: pending.reauthorization.connectionId,
          error: {
            code: e instanceof MirrorError ? e.code : 'REAUTHORIZATION_FAILED',
            message: e instanceof MirrorError ? e.message : 'Reauthorization failed.',
          },
          diagnostics,
          vendor_writes: 0,
        });
    }
    res.redirect(303, '/oauth/result?attempt=' + encodeURIComponent(attemptId));
  });
  router.get('/api/auth/:platform/callback', callback);
  router.get('/api/:platform/callback', callback);
  router.get(
    '/api/oauth/progress/:id',
    handler((req, res) => {
      const session = web.requireSession(req);
      res.json(store.document(session.actor.tenantId, 'oauth_progress', String(req.params.id)));
    }),
  );
  router.get(
    '/api/connections/:id',
    handler((req, res) => {
      const s = web.requireSession(req);
      res.json(publicConnection(s.actor.tenantId, connection(s.actor.tenantId, String(req.params.id))));
    }),
  );
  router.post(
    '/api/connections/:id/reauthorize',
    handler(async (req, res) => {
      const s = web.requireAdminMutation(req),
        c = connection(s.actor.tenantId, String(req.params.id)),
        p = platforms.find(p => p.gateway === c.gateway);
      // Every browser-OAuth login renews in place (CON-02); AMCP_REAUTHORIZATION_DISABLED turns a platform off again.
      if (!p || p.authType || !reauthorizationEnabled(p, options.authEnv ?? process.env))
        throw new MirrorError(
          'REAUTHORIZATION_UNAVAILABLE',
          'Reauthorization in place is not available for this connection. Use Connect another for this platform.',
          {},
          400,
        );
      res.json(
        await oauth.start(s, p.id, {
          connectionId: c.id,
          revision: authorizationRevision(store, s.actor.tenantId, c.id),
        }),
      );
    }),
  );
  router.post(
    '/api/connections/:id/credential-retry',
    handler((req, res) => {
      const s = web.requireAdminMutation(req),
        c = connection(s.actor.tenantId, String(req.params.id));
      // An administrator's explicit Retry after a recorded renewal failure; the next request may refresh again.
      const cleared = clearRefreshFailure(store, c);
      if (cleared)
        store.appendAudit(s.actor.tenantId, randomUUID(), {
          event: 'website_credential_retry',
          connection_id: c.id,
          vendor_writes: 0,
        });
      res.json({...publicConnection(s.actor.tenantId, connection(s.actor.tenantId, c.id)), retry: cleared});
    }),
  );
  router.post(
    '/api/connections/:id/sync',
    express.json({limit: '8kb'}),
    handler(async (req, res) => {
      const s = web.requireAdminMutation(req),
        c = connection(s.actor.tenantId, String(req.params.id));
      if (c.gateway === 'commerce_native_action')
        throw new MirrorError(
          'SOURCE_READ_ONLY',
          'WooCommerce connections are read-only catalog sources. Manage them in Commerce.',
        );
      const kinds = req.body?.kinds;
      if (
        kinds !== undefined &&
        (!Array.isArray(kinds) || kinds.length > 8 || kinds.some((k: unknown) => typeof k !== 'string'))
      )
        throw new MirrorError('INVALID_ARGUMENT', 'Select valid asset types.');
      res.json(
        await sync(
          s.actor.tenantId,
          c,
          () => {
            web.requireAdminMutation(req);
          },
          kinds,
        ),
      );
    }),
  );
  router.patch(
    '/api/connections/:id/assets',
    express.json({limit: '256kb'}),
    handler((req, res) => {
      const s = web.requireAdminMutation(req),
        tenant = s.actor.tenantId,
        c = connection(tenant, String(req.params.id)),
        assets = savedAssets(tenant, c),
        selected = req.body?.selected;
      if (c.gateway === 'commerce_native_action')
        throw new MirrorError(
          'SOURCE_READ_ONLY',
          'WooCommerce connections are read-only catalog sources. Manage them in Commerce.',
        );
      if (
        !Array.isArray(selected) ||
        selected.length > 10000 ||
        selected.some(k => typeof k !== 'string') ||
        new Set(selected).size !== selected.length
      )
        throw new MirrorError('INVALID_ASSET_SELECTION', 'Select valid, unique assets.');
      const known = new Set((assets.groups ?? []).flatMap((g: AssetGroup) => g.assets.map(a => g.kind + ':' + a.id)));
      if (selected.some(k => !known.has(k)))
        throw new MirrorError('UNKNOWN_ASSET', 'Sync assets before selecting them.', {}, 409);
      const kinds = selectableKinds(c.gateway),
        kindOf = (k: string) => kinds.find(kind => k.startsWith(kind + ':'));
      if (selected.some(k => !kindOf(k)))
        throw new MirrorError(
          'INVALID_ASSET_SELECTION',
          'Select the platform’s primary accounts, properties or sites for MCP access. Other tabs show related inventory.',
        );
      const accounts = selected.map(k => k.slice(kindOf(k)!.length + 1));
      if (new Set(accounts).size !== accounts.length)
        throw new MirrorError('INVALID_ASSET_SELECTION', 'Select valid, unique assets.');
      if (req.body?.write_access !== undefined && typeof req.body.write_access !== 'boolean')
        throw new MirrorError('INVALID_WRITE_ACCOUNTS', 'write_access must be a boolean.');
      const sourceOnly = platforms.find(p => p.gateway === c.gateway)?.reviewedWrites === false;
      if (sourceOnly && req.body.write_access === true)
        throw new MirrorError('SOURCE_READ_ONLY', 'Drive is a read-only media source.');
      const defaultWriteAccess = sourceOnly ? false : (req.body.write_access ?? c.defaultWriteAccess === true);
      if (req.body.write_access === true && !allowWrites)
        throw new MirrorError('WRITES_DISABLED', 'Reviewed writes are disabled in this deployment.', {}, 403);
      const writeAccounts = sourceOnly
        ? []
        : defaultWriteAccess && allowWrites
          ? accounts
          : req.body.write_access === false
            ? []
            : (c.writeAccounts ?? []).filter(id => accounts.includes(id));
      const accountCustomers =
        c.gateway === microsoftGateway
          ? Object.fromEntries(
              (assets.groups as AssetGroup[])
                .flatMap(g => g.assets)
                .filter(a => a.kind === 'ad_accounts' && accounts.includes(a.id))
                .map(a => [a.id, a.parentId!]),
            )
          : c.accountCustomers;
      const accountLoginCustomers =
        c.gateway === 'google_ads_native_action'
          ? Object.fromEntries(
              (assets.groups as AssetGroup[])
                .flatMap(g => g.assets)
                .filter(a => a.kind === 'ad_accounts' && accounts.includes(a.id) && a.loginCustomerId)
                .map(a => [a.id, a.loginCustomerId!]),
            )
          : c.accountLoginCustomers;
      // A selection that adds write access needs recent proof of identity (SEC-06); keeping or removing it never does.
      if (writeAccounts.some(id => !(c.writeAccounts ?? []).includes(id))) webAccounts.fresh(s);
      store.transaction(() => {
        store.updateConnection(s.actor, {
          ...c,
          accounts,
          accountCustomers,
          accountLoginCustomers,
          writeAccounts,
          defaultWriteAccess,
          enabled: accounts.length > 0,
        });
        store.db
          .prepare(
            'INSERT INTO documents(tenant_id,kind,id,data) VALUES(?,?,?,?) ON CONFLICT(tenant_id,kind,id) DO UPDATE SET data=excluded.data,revision=documents.revision+1',
          )
          .run(tenant, 'website_assets', c.id, JSON.stringify({...assets, selected}));
      });
      store.appendAudit(tenant, randomUUID(), {
        event: 'website_asset_selection',
        connection_id: c.id,
        selected_accounts: accounts,
        selected_assets: selected.length,
        vendor_writes: 0,
      });
      res.json(publicConnection(tenant, connection(tenant, c.id)));
    }),
  );
  router.patch(
    '/api/connections/:id/write-access',
    express.json({limit: '256kb'}),
    handler((req, res) => {
      const s = web.requireAdminMutation(req),
        tenant = s.actor.tenantId,
        c = connection(tenant, String(req.params.id)),
        accounts = req.body?.accounts;
      if (c.gateway === 'commerce_native_action')
        throw new MirrorError(
          'SOURCE_READ_ONLY',
          'WooCommerce connections are read-only catalog sources. Manage them in Commerce.',
        );
      if (s.actor.role !== 'admin')
        throw new MirrorError('FORBIDDEN', 'Only the workspace administrator can change write access.', {}, 403);
      if (
        !Array.isArray(accounts) ||
        accounts.length > 10000 ||
        accounts.some(id => typeof id !== 'string') ||
        new Set(accounts).size !== accounts.length
      )
        throw new MirrorError('INVALID_WRITE_ACCOUNTS', 'Select valid, unique resources for write access.');
      if (accounts.length && platforms.find(p => p.gateway === c.gateway)?.reviewedWrites === false)
        throw new MirrorError('SOURCE_READ_ONLY', 'Drive is a read-only media source.');
      if (accounts.length && (!allowWrites || !c.enabled))
        throw new MirrorError(
          'WRITES_DISABLED',
          'Enable deployment write support and select resources before granting write access.',
          {},
          403,
        );
      if (accounts.some(id => !c.accounts.includes(id)))
        throw new MirrorError(
          'WRITE_ACCOUNT_NOT_SELECTED',
          'Write access is limited to this login’s selected resources.',
          {},
          403,
        );
      if (accounts.length && req.body?.confirmed !== true)
        throw new MirrorError(
          'WRITE_ACCESS_CONFIRMATION_REQUIRED',
          'Explicitly confirm that operator connectors may change these resources.',
          {},
          400,
        );
      // Adding write access needs recent proof of identity (SEC-06); removing it never does.
      if (accounts.some(id => !(c.writeAccounts ?? []).includes(id))) webAccounts.fresh(s);
      store.updateConnection(s.actor, {...c, writeAccounts: accounts, defaultWriteAccess: false});
      store.appendAudit(tenant, randomUUID(), {
        event: 'website_write_access_changed',
        connection_id: c.id,
        write_accounts: accounts,
        previous_write_accounts: c.writeAccounts ?? [],
        vendor_writes: 0,
      });
      res.json(publicConnection(tenant, connection(tenant, c.id)));
    }),
  );
  router.post(
    '/api/connections/:id/default',
    handler((req, res) => {
      const s = web.requireAdminMutation(req),
        tenant = s.actor.tenantId,
        c = connection(tenant, String(req.params.id));
      store.transaction(() => {
        for (const existing of store.listConnections(tenant).filter(x => x.gateway === c.gateway))
          store.db
            .prepare('UPDATE connections SET data=? WHERE tenant_id=? AND id=?')
            .run(JSON.stringify({...existing, isDefault: existing.id === c.id}), tenant, existing.id);
      });
      store.appendAudit(tenant, randomUUID(), {event: 'website_default_connection', connection_id: c.id});
      res.json({success: true});
    }),
  );
  router.delete(
    '/api/connections/:id',
    handler((req, res) => {
      const s = web.requireAdminMutation(req),
        tenant = s.actor.tenantId,
        c = connection(tenant, String(req.params.id));
      disconnectLocalConnection(store, s.actor, c.gateway, c.id, 'website');
      res.json({success: true});
    }),
  );
  router.get(
    '/api/connector-tokens',
    handler((req, res) => {
      const s = web.requireSession(req),
        owner = grantOwner(s) ?? 'workspace-admin';
      res.json({
        tokens: store
          .documents(s.actor.tenantId, 'website_mcp_token')
          .map(({hash, ...v}) => ({...v, yours: (v.created_by ?? 'workspace-admin') === owner})),
        url: web.origin + '/mcp',
      });
    }),
  );
  router.post(
    '/api/connector-tokens',
    express.json({limit: '4kb'}),
    handler((req, res) => {
      const s = web.requireMutation(req),
        name = String(req.body?.name ?? 'MCP connector').trim();
      if (!name || name.length > 80)
        throw new MirrorError('INVALID_ARGUMENT', 'Use a connector name of 1 to 80 characters.');
      // Any active member may create a token for their own AI tools, capped by their role (owner decision D16):
      // viewers read only; operators, administrators and owners may also create reviewed-write tokens.
      const viewer = s.actor.role === 'reader',
        role = req.body?.role ?? (allowWrites && !viewer ? 'operator' : 'reader');
      if (role !== 'reader' && role !== 'operator')
        throw new MirrorError('INVALID_ROLE', 'Choose reader or operator access.');
      if (role === 'operator' && viewer)
        throw new MirrorError('FORBIDDEN', 'Viewers can create read-only connector tokens only.', {}, 403);
      if (role === 'operator' && !allowWrites)
        throw new MirrorError('WRITES_DISABLED', 'Advertising writes are disabled in this deployment.', {}, 403);
      if (role === 'operator' && req.body?.confirmed !== true)
        throw new MirrorError(
          'WRITE_ACCESS_CONFIRMATION_REQUIRED',
          'Explicitly confirm this connector’s operator access.',
          {},
          400,
        );
      // A connector token is a 30-day bearer credential that outlives this session: recent proof first (SEC-06).
      accounts.fresh(s);
      const id = randomUUID(),
        token = store.createKey({...s.actor, userId: 'connector/' + id, role}, 30 * 86400000),
        expiresAt = Date.now() + 30 * 86400000;
      store.putDocument(s.actor.tenantId, 'website_mcp_token', id, {
        name,
        role,
        hash: sha256(token),
        createdAt: Date.now(),
        expiresAt,
        revoked: false,
        created_by: grantOwner(s) ?? 'workspace-admin',
      });
      store.appendAudit(s.actor.tenantId, id, {
        event: 'website_mcp_token_created',
        name,
        role,
        ...(grantOwner(s) ? {owner_user_id: grantOwner(s)} : {}),
      });
      res.json({id, token, role, expiresAt});
    }),
  );
  router.delete(
    '/api/connector-tokens/:id',
    handler((req, res) => {
      const s = web.requireMutation(req),
        record = store.document(s.actor.tenantId, 'website_mcp_token', String(req.params.id));
      // Administrators revoke any token of the workspace; a member revokes the tokens they created.
      if (s.actor.role !== 'admin' && (record.created_by ?? 'workspace-admin') !== (grantOwner(s) ?? 'workspace-admin'))
        throw new MirrorError(
          'FORBIDDEN',
          'You can revoke only the connector tokens you created. Ask a workspace administrator to revoke this one.',
          {},
          403,
        );
      store.db.prepare('UPDATE api_keys SET revoked=1 WHERE tenant_id=? AND hash=?').run(s.actor.tenantId, record.hash);
      store.putDocument(s.actor.tenantId, 'website_mcp_token', record.id, {...record, revoked: true});
      store.appendAudit(s.actor.tenantId, randomUUID(), {event: 'website_mcp_token_revoked', token_id: record.id});
      res.json({success: true});
    }),
  );
  router.get(
    '/api/activity',
    handler((req, res) => {
      const s = web.requireSession(req);
      const page = auditHistoryPage(store, s.actor, {
        limit: req.query.limit === undefined ? 100 : Number(req.query.limit),
        ...(req.query.cursor !== undefined ? {cursor: req.query.cursor} : {}),
        ...Object.fromEntries(
          ['search', 'gateway', 'account_id', 'connection_id']
            .filter(k => req.query[k] !== undefined)
            .map(k => [k, req.query[k]]),
        ),
      });
      res.json({
        ...page,
        events: page.events.map(({id, at, diagnostics, ...event}: JsonObject) => ({id, at, event, diagnostics})),
      });
    }),
  );
  const directory = path.resolve(options.staticDirectory ?? 'web'),
    publicAssets = createPublicAssets(directory);
  router.use(
    '/assets',
    // Pages are served at their own addresses with their own headers; their templates are not assets (WEB-02).
    (req, res, next) =>
      /\.html$/i.test(req.path) ? void res.status(404).setHeader('Cache-Control', 'no-store').end() : next(),
    publicAssets.middleware,
    // Existing versionless links continue to revalidate; new pages bind all assets to one public-file snapshot.
    // Brotli or gzip copies of text assets; everything else falls through to the static handler.
    compressedAssets(directory),
    express.static(directory, {
      dotfiles: 'deny',
      index: false,
      fallthrough: false,
      maxAge: 0,
      setHeaders: res => res.setHeader('Cache-Control', 'no-cache'),
    }),
  );
  router.get('/tiktok94H3oMGQTvC0GEzgKcmffbz8W0CAHhan.txt', (_req, res) =>
    res.type('text/plain').sendFile('tiktok94H3oMGQTvC0GEzgKcmffbz8W0CAHhan.txt', {root: directory}),
  );
  // Reviewers and users must be able to read the entire policy, terms and deletion instructions without a session or
  // JavaScript, and while the APIs are unavailable (WEB-02). Provider dashboards may already register these URLs.
  const staticPage =
    (english: PublicPage, arabic: PublicPage, status = 200) =>
    (req: Request, res: Response) => {
      const language = req.query.lang === 'ar' ? 'ar' : 'en';
      res.status(status).setHeader('Content-Language', language);
      res.type('html').send(publicAssets.html(language === 'ar' ? arabic : english));
    };
  router.get('/privacy', staticPage('privacy.html', 'privacy-ar.html'));
  router.get('/terms', staticPage('terms.html', 'terms-ar.html'));
  router.get('/data-deletion', staticPage('data-deletion.html', 'data-deletion-ar.html'));
  router.get('/about', (_req, res) => res.type('html').send(publicAssets.html('about.html')));
  router.get('/robots.txt', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('text/plain').send(robotsTxt);
  });
  router.get('/.well-known/security.txt', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('text/plain').send(securityTxt(web.origin, options.authEnv ?? process.env));
  });
  // The mark is an SVG: /favicon.ico points to it at its own versioned address, whose type matches its path. Temporary,
  // because the version changes with every deployment.
  router.get('/favicon.ico', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.redirect(302, '/assets/v/' + publicAssets.version + '/mark.svg');
  });
  for (const route of [
    '/dashboard',
    '/campaigns',
    '/media',
    '/reports',
    '/reporting-overview',
    '/operations',
    '/capabilities',
    '/report-library',
    '/report-pack',
    '/monitors',
    '/portfolio',
    '/measurement',
    '/commerce',
    '/schedules',
    '/profiles',
    '/',
    '/connections',
    '/connectors',
    '/activity',
    '/settings',
    '/login',
    '/signup',
    '/forgot-password',
    '/reset-password',
    '/verify-email',
    '/account',
    '/auth/complete',
    '/oauth/result',
    '/oauth/consent',
  ])
    router.get(route, (_req, res) => res.type('html').send(publicAssets.html('index.html')));
  // Every other page address gets the branded, localized not-found page with a real 404, never Express's default page;
  // an unknown API address gets the JSON error every API caller reads. Protocol and asset paths keep their own
  // responses (WEB-02).
  const notFound = staticPage('404.html', '404-ar.html', 404);
  router.use((req, res, next) => {
    // The shared error handler answers a plain 404 with its JSON NOT_FOUND error.
    if (/^\/api(?:\/|$)/i.test(req.path)) return next(Object.assign(new Error('Not found'), {status: 404}));
    if ((req.method !== 'GET' && req.method !== 'HEAD') || /^\/(?:mcp|assets|\.well-known)(?:\/|$)/i.test(req.path))
      return next();
    res.setHeader('Cache-Control', 'no-store');
    notFound(req, res);
  });
  // The public asset version of the snapshot these routes serve; /versionz reports it (QA-01).
  return {router, web, oauth, discovery, mcpOAuth, accounts, assetVersion: publicAssets.version};
}
