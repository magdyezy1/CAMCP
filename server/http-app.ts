import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import path from 'node:path';
import express, {type ErrorRequestHandler, type RequestHandler} from 'express';
import {hostHeaderValidation} from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {createMcpServer} from './mcp.js';
import {MirrorService} from '../src/service.js';
import {Store} from '../src/store.js';
import {MirrorError} from '../src/errors.js';
import {createWebsite} from './website.js';
import {validateMcpToken} from './mcp-oauth.js';
import type {WebsiteOptions} from './web-store.js';
import type {Actor, JsonObject} from '../src/types.js';
import {OAuthError} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {createReleaseStatus} from '../src/release-status.js';
import {SUPPORTED_PROTOCOL_VERSIONS} from '@modelcontextprotocol/sdk/types.js';
import {recordSqliteFailure} from '../src/sqlite-diagnostics.js';
import {mediaRetentionState, storageState} from '../src/storage-health.js';
import {McpRequestLimiter, batchItems, bodySizeBucket, type McpLimitOptions} from './mcp-limits.js';
import {isModernRequest, modernProtocolModes, serveModernRequest, type ModernProtocolMode} from './mcp-modern.js';
import {runtimeToolchain, type RuntimeToolchain} from '../src/runtime-toolchain.js';
import {createPublicAssets} from './public-assets.js';
import {REQUEST_ID_HEADER, newRequestId, runWithRequestId} from '../src/request-context.js';
export interface HttpOptions {
  host?: string;
  publicOrigin?: string;
  maxBodyBytes?: number;
  /** Batch and per-actor request limits of /mcp (SEC-02); unset values use the defaults of owner decision D6. */
  mcpLimits?: McpLimitOptions;
  website?: WebsiteOptions;
  /** Browser origins, besides the public origin, whose MCP requests are accepted (AMCP_MCP_ALLOWED_ORIGINS). None by
   * default. An allowed origin's CORS preflight is answered and its responses carry its exact Access-Control-Allow-Origin,
   * so a browser client can read them; every other origin stays refused. */
  mcpAllowedOrigins?: string[];
  /** AMCP_MCP_MODERN_PROTOCOL (MCP-03 phase 3): where MCP 2026-07-28 is served besides the legacy revisions. `off`
   * (default) serves the legacy revisions only; `next` serves both eras at /mcp/next; `on` at /mcp as well. */
  mcpModernProtocol?: ModernProtocolMode;
  /** Receives one structured entry per refused or failed MCP request or non-MCP HTTP error; no request payload or credentials. */
  log?: (entry: JsonObject) => void;
  /** Milliseconds since the epoch; tests replace it. */
  clock?: () => number;
  /** Trusted packaged-artifact root, never selected by HTTP input. */
  releaseRoot?: string;
  /** Whether unknown storage degrades health (production); defaults to NODE_ENV=production. */
  production?: boolean;
  /** The validated runtime toolchain reported by /versionz; tests replace it. */
  toolchain?: () => Promise<RuntimeToolchain>;
}
/**
 * Keeps an idle keep-alive connection open longer than the idle timeouts of the proxies in front of AMCP (commonly 60
 * seconds), so a proxy never reuses a connection Node has just closed, which a client sees as a closed connection
 * (F-88). Request and header timeouts are unchanged.
 */
export function tuneListener(listener: Server): void {
  listener.keepAliveTimeout = 65000;
  listener.requestTimeout = 45000;
  listener.headersTimeout = 10000;
}
const healthActor: Actor = {tenantId: '__amcp_health', userId: '__amcp_health', role: 'reader'};
/**
 * The health check (F-88, OPS-02): the database answers and commits one small write, the volume holding it has room
 * and is persistent, media expiry is current, and the offline help (the call that failed on 2026-09-24) completes
 * through a real MCP client and server in memory. A result lasts ten seconds, so probes cannot become load (at most one
 * small committed write per window, and no cleanup scan); it names only each check's state, never paths or numbers.
 * Unavailable (503): the database cannot read or commit, storage is full, or MCP fails. Degraded: contention, low,
 * ephemeral or (in production) unknown storage, or stale media expiry.
 */
function healthCheck(service: MirrorService, store: Store, clock: () => number, production: boolean) {
  let last: {at: number; status: number; body: JsonObject} | undefined;
  const run = async () => {
    const checks: Record<string, string> = {
      database: 'failed',
      database_write: 'failed',
      storage: 'unknown',
      media_retention: 'ok',
      mcp: 'failed',
    };
    try {
      store.db.prepare('SELECT 1').get();
      checks.database = 'ok';
      checks.database_write = store.probeWrite(clock());
    } catch (e) {
      recordSqliteFailure(e, 'health');
    }
    try {
      checks.storage = storageState(store, checks.database_write === 'full');
      checks.media_retention = mediaRetentionState(store.mediaCleanupHealth);
    } catch {}
    try {
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair(),
        server = createMcpServer(service, healthActor),
        client = new Client({name: 'amcp-health', version: '1'});
      try {
        await server.connect(serverSide);
        await client.connect(clientSide);
        const help = await client.callTool({name: 'amcp_tool_help', arguments: {}});
        const text = (help.content as {text?: string}[] | undefined)?.[0]?.text;
        if (!help.isError && text) {
          const parsed = JSON.parse(text);
          if (
            parsed.success === true &&
            parsed.data?.surface === 'compact-v1' &&
            text === JSON.stringify(help.structuredContent)
          )
            checks.mcp = 'ok';
        }
      } finally {
        await Promise.allSettled([client.close(), server.close()]);
      }
    } catch {}
    const failed =
        checks.database !== 'ok' ||
        ['full', 'failed'].includes(checks.database_write!) ||
        checks.storage === 'full' ||
        checks.mcp !== 'ok',
      degraded =
        checks.database_write === 'busy' ||
        ['low', 'not_persistent'].includes(checks.storage!) ||
        (production && checks.storage === 'unknown') ||
        checks.media_retention === 'stale';
    return {
      status: failed ? 503 : 200,
      body: {
        status: failed ? 'unavailable' : degraded ? 'degraded' : 'up',
        version: '0.1.0',
        checks,
        media_retention: store.mediaCleanupHealth,
        checked_at: new Date(clock()).toISOString(),
      },
    };
  };
  return async () => {
    const now = clock();
    if (!last || now - last.at > 10000) last = {at: now, ...(await run())};
    return last;
  };
}
/** /mcp refusals whose details (limits and waits, never request content) are returned in the JSON-RPC error data. */
const limitRefusals: ReadonlySet<string> = new Set(['RATE_LIMITED', 'BATCH_UNSUPPORTED']);
/**
 * Refusals of MCP 2026-07-28 framing (server/mcp-modern.ts) and the codes that revision defines for them. Their
 * details sit directly in the error data, where the revision puts them (`supported` and `requested` for -32022).
 */
const modernRefusals: Readonly<Record<string, number>> = {
  MCP_HEADER_MISMATCH: -32020,
  MCP_PROTOCOL_UNSUPPORTED: -32022,
  MCP_PARAMS_INVALID: -32602,
  MCP_METHOD_NOT_FOUND: -32601,
  MCP_REQUEST_INVALID: -32600,
};
/** JSON-RPC's code for a refusal before the request reached MCP: parse error, invalid request, internal, or server. */
const jsonRpcCode = (e: MirrorError) =>
  modernRefusals[e.code] ??
  (e.code === 'INVALID_JSON'
    ? -32700
    : e.code === 'REQUEST_TOO_LARGE' || e.code === 'BATCH_UNSUPPORTED'
      ? -32600
      : e.status >= 500
        ? -32603
        : -32000);
export function createHttpApp(service: MirrorService, store: Store, options: HttpOptions = {}) {
  const host = options.host ?? '127.0.0.1';
  const origin = options.publicOrigin ? new URL(options.publicOrigin) : undefined;
  if (
    origin &&
    (origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash)
  )
    throw new Error('Public origin must be an HTTPS origin.');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !origin)
    throw new Error('External binding requires an HTTPS public origin and TLS reverse proxy.');
  const allowedOrigins = new Set(options.mcpAllowedOrigins ?? []);
  for (const allowed of allowedOrigins) {
    let exact = false;
    try {
      exact = new URL(allowed).origin === allowed && /^https:|^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(allowed);
    } catch {}
    if (!exact)
      throw new Error(
        'AMCP_MCP_ALLOWED_ORIGINS must list exact origins such as https://claude.ai, separated by commas.',
      );
  }
  if (origin) allowedOrigins.add(origin.origin);
  const modernMode = options.mcpModernProtocol ?? 'off';
  if (!modernProtocolModes.includes(modernMode)) throw new Error('AMCP_MCP_MODERN_PROTOCOL must be off, next or on.');
  const log = options.log ?? (() => {}),
    health = healthCheck(
      service,
      store,
      options.clock ?? Date.now,
      options.production ?? process.env.NODE_ENV === 'production',
    ),
    limiter = new McpRequestLimiter(store, options.mcpLimits, options.clock ?? Date.now);
  // MCP tool failures that reach no HTTP status (JSON responses are 200) still leave one metadata-only line (OPS-02).
  if (options.log) service.onToolFailure = entry => log(entry);
  // Built before /mcp authentication, which checks AI-client tokens against its authorization server (SEC-05); its
  // routes are mounted after the MCP endpoint, as before.
  const website = options.website
    ? createWebsite(store, options.website, service.policy.allowWrites, service)
    : undefined;
  // Registration limit refusals and alarms leave a line without the address (MCP-03 phase 2).
  if (website && options.log) website.mcpOAuth.onRegistrationAlarm = entry => log(entry);
  const app = express();
  app.disable('x-powered-by');
  // OPS-08: every response carries a server-generated request ID (never a client's), and the work the request starts
  // runs with it as the ingress ID, so log lines written for this request can be found from the header.
  app.use((_req, res, next) => {
    const requestId = newRequestId();
    res.locals.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    runWithRequestId(requestId, next);
  });
  const securityHeaders: RequestHandler = (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (origin) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
  // Railway health probes need no workspace data and may use a platform host header. This route
  // is mounted before host validation so the platform probe can reach it, which makes it
  // unauthenticated: it reports liveness only. Whether the instance can perform real provider
  // mutations is operational detail an anonymous caller has no use for, and it is still reported
  // on the authenticated health surface (amcp_workspace health). It still carries the shared security headers (WEB-02).
  app.get('/healthz', securityHeaders, async (_req, res) => {
    const result = await health();
    res.status(result.status).setHeader('Cache-Control', 'no-store').json(result.body);
  });
  // Every refused or failed MCP request leaves one log line, host validation's included: an outage like 2026-09-24's
  // must leave evidence. The line never carries the bearer token.
  app.use('/mcp', (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode < 400) return;
      // A client probing a protocol revision this endpoint does not serve is expected, not a fault (MCP-03): the SDK's
      // own refusal (no AMCP code) of a revision it does not know, or the modern handler's MCP_PROTOCOL_UNSUPPORTED.
      const probed = req.headers['mcp-protocol-version'],
        refusal = res.locals.errorCode,
        modern =
          res.statusCode === 400 &&
          typeof probed === 'string' &&
          (refusal === 'MCP_PROTOCOL_UNSUPPORTED' ||
            (refusal === undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(probed)));
      log({
        level: res.statusCode >= 500 ? 'error' : modern ? 'info' : 'warn',
        event: res.statusCode >= 500 ? 'mcp_failed' : modern ? 'mcp_protocol_unsupported' : 'mcp_refused',
        ...(modern ? {protocol_version: probed.replace(/[^\w.-]/g, '').slice(0, 32)} : {}),
        status: res.statusCode,
        code: res.locals.errorCode ?? 'HTTP_' + res.statusCode,
        method: req.method,
        origin: req.headers.origin ?? null,
        // A coarse size class only (SEC-02), to tune the body limit from refusals; never the content.
        body_size: bodySizeBucket(req.headers['content-length']),
        // The X-AMCP-Request-Id the client received (OPS-08).
        request_id: res.locals.requestId,
        at: new Date().toISOString(),
      });
    });
    next();
  });
  app.use(hostHeaderValidation(['127.0.0.1', 'localhost', '[::1]', ...(origin ? [origin.hostname] : [])]));
  app.use(securityHeaders);
  const releaseRoot = options.releaseRoot ?? process.cwd(),
    releaseStatus = createReleaseStatus({root: releaseRoot, clock: options.clock ?? Date.now}),
    toolchain = options.toolchain ?? (() => runtimeToolchain());
  let assetVersion: string | undefined;
  // The public asset version (the /assets/v/<version>/ snapshot) the packaged web files produce; QA-01 compares it.
  // The website's own snapshot when it serves pages (no second copy of web/ in memory); otherwise built once, lazily.
  const publicAssetVersion = () => {
    if (assetVersion) return assetVersion;
    if (website) return (assetVersion = website.assetVersion);
    try {
      return (assetVersion = createPublicAssets(path.join(releaseRoot, 'web')).version);
    } catch {
      return 'unavailable';
    }
  };
  app.get('/versionz', async (_req, res) => {
    const [result, runtime] = await Promise.all([
      releaseStatus(),
      toolchain().catch(() => ({node: 'unavailable', ffmpeg: 'unavailable', os: 'unavailable' as const})),
    ]);
    res
      .status(result.status === 'matches_build' ? 200 : 503)
      .json({...result, toolchain: runtime, public_asset_version: publicAssetVersion()});
  });
  // An allowed browser origin can read MCP responses: its preflight is answered before authentication, and responses
  // carry its exact origin (MCP-03). Other origins get no CORS headers and stay refused below.
  app.use('/mcp', (req, res, next) => {
    const from = req.headers.origin;
    if (!from || !allowedOrigins.has(from)) return next();
    res.setHeader('Access-Control-Allow-Origin', from);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
      'Access-Control-Expose-Headers',
      'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version, ' + REQUEST_ID_HEADER,
    );
    if (req.method !== 'OPTIONS') return next();
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader(
      'Access-Control-Allow-Headers',
      // Mcp-Method and Mcp-Name mirror the body in MCP 2026-07-28 (MCP-03 phase 3).
      'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID',
    );
    res.setHeader('Access-Control-Max-Age', '600');
    res.status(204).end();
  });
  app.use('/mcp', (req, res, next) => {
    try {
      if (req.headers.origin && !allowedOrigins.has(req.headers.origin))
        throw new MirrorError(
          'FORBIDDEN_ORIGIN',
          'Requests from the browser origin ' +
            req.headers.origin.slice(0, 200) +
            ' are refused at /mcp. MCP clients that run on a server send no Origin; the owner can allow an exact origin in AMCP_MCP_ALLOWED_ORIGINS.',
          {origin: req.headers.origin.slice(0, 200)},
          403,
        );
      const authorization = req.headers.authorization;
      if (!authorization?.startsWith('Bearer '))
        throw new MirrorError('UNAUTHORIZED', 'Bearer authentication required.', {}, 401);
      res.locals.actor = validateMcpToken(store, authorization.slice(7), website?.mcpOAuth);
      next();
    } catch (e) {
      next(e);
    }
  });
  /** The /mcp POST handler; `dualEra` also serves MCP 2026-07-28 requests (MCP-03 phase 3, server/mcp-modern.ts). */
  const mcpPost =
    (dualEra: boolean): RequestHandler =>
    async (req, res, next) => {
      // SEC-02: a JSON-RPC array is refused before any item runs, and each actor has a rate and an in-flight cap. A
      // request holds its in-flight slot until its response has closed and every tool call it started has finished,
      // so a client that disconnects cannot free its slot while the server is still working on its request.
      let release!: () => void;
      try {
        const protocol = req.headers['mcp-protocol-version'],
          items = batchItems(req.body, typeof protocol === 'string' ? protocol : undefined, limiter.limits.batchMax);
        release = limiter.admit(res.locals.actor, items);
      } catch (e) {
        if (e instanceof MirrorError && e.code === 'RATE_LIMITED')
          res.setHeader('Retry-After', String(e.details.retry_after_seconds ?? 1));
        next(e);
        return;
      }
      let running = 0,
        closed = false;
      const settle = () => {
        if (closed && running === 0) release();
      };
      res.on('close', () => {
        closed = true;
        settle();
      });
      const track = async <T>(work: Promise<T>): Promise<T> => {
        running++;
        try {
          return await work;
        } finally {
          running--;
          settle();
        }
      };
      try {
        const server = createMcpServer(service, res.locals.actor, {track});
        if (dualEra && isModernRequest(req.headers, req.body)) {
          // The modern era: stateless, one JSON answer per request, no session (MCP-03 phase 3).
          res.on('close', () => void server.close());
          const answer = await serveModernRequest(server, req.headers, req.body);
          if (answer.body) res.status(answer.status).json(answer.body);
          else res.status(answer.status).end();
          return;
        }
        const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
        res.on('close', () => {
          void Promise.allSettled([transport.close(), server.close()]);
        });
        await server.connect(transport);
        // Body parsing resumes outside the ingress context, so the tool calls of this request re-enter it (OPS-08).
        await runWithRequestId(res.locals.requestId, () => transport.handleRequest(req, res, req.body));
      } catch (e) {
        next(e);
      }
    };
  const mcpJson = express.json({limit: options.maxBodyBytes ?? 4 * 1024 * 1024, strict: true}),
    mcpOnlyPost: RequestHandler = (_req, res) =>
      res.status(405).setHeader('Allow', 'POST').json({error: 'Stateless MCP endpoint: use POST.'});
  // AMCP_MCP_MODERN_PROTOCOL (MCP-03 phase 3): `next` serves both eras at /mcp/next for the client checks of ACC-02,
  // `on` at /mcp too. /mcp/next lies inside the /mcp resource, so OAuth clients accept /mcp's tokens and metadata there.
  if (modernMode !== 'off') {
    app.post('/mcp/next', mcpJson, mcpPost(true));
    app.all('/mcp/next', mcpOnlyPost);
  }
  app.post('/mcp', mcpJson, mcpPost(modernMode === 'on'));
  app.all('/mcp', mcpOnlyPost);
  if (website) {
    // Handoffs from this deployment link to its own website by absolute URL (MCP-09); stdio leaves this unset.
    service.websiteOrigin = new URL(options.website!.origin).origin;
    app.locals.website = website;
    app.use(website.router);
  }
  const errors: ErrorRequestHandler = (e, req, res, _next) => {
    if (res.headersSent) return;
    const database = recordSqliteFailure(e, 'http');
    const error =
      e instanceof MirrorError
        ? e
        : database?.primary_code === 13
          ? new MirrorError(
              'STORAGE_FULL',
              'AMCP storage is full. The deployment administrator must restore capacity before sign-in or saving can continue.',
              {},
              503,
            )
          : e instanceof OAuthError
            ? new MirrorError('OAUTH_REQUEST_INVALID', e.message, {}, 400)
            : e.status === 404
              ? new MirrorError('NOT_FOUND', 'This resource was not found.', {}, 404)
              : e.type === 'entity.too.large'
                ? new MirrorError('REQUEST_TOO_LARGE', 'Request body exceeds the configured size limit.', {}, 413)
                : e instanceof SyntaxError
                  ? new MirrorError('INVALID_JSON', 'Request body is not valid JSON.', {}, 400)
                  : new MirrorError('INTERNAL_ERROR', 'Request could not be processed.', {}, 500);
    res.locals.errorCode = error.code;
    // An MCP client reads JSON-RPC: a refusal in that shape shows its reason instead of a closed connection (F-88).
    if (req.baseUrl === '/mcp' || req.path === '/mcp' || req.path === '/mcp/next') {
      // The bearer challenge belongs to authentication refusals only (MCP-03): it names the protected-resource
      // metadata and the scope new clients receive, and says invalid_token when a token was presented.
      if (options.website && (error.status === 401 || (error.status === 403 && error.code !== 'FORBIDDEN_ORIGIN'))) {
        const presented = /^Bearer \S/.test(req.headers.authorization ?? '');
        res.setHeader(
          'WWW-Authenticate',
          'Bearer ' +
            (presented ? 'error="invalid_token", ' : '') +
            'scope="' +
            (service.policy.allowWrites ? 'mcp:read mcp:write' : 'mcp:read') +
            '", resource_metadata="' +
            options.website.origin +
            '/.well-known/oauth-protected-resource/mcp"',
        );
      }
      res.status(error.status).json({
        jsonrpc: '2.0',
        id: typeof req.body?.id === 'string' || typeof req.body?.id === 'number' ? req.body.id : null,
        error: {
          code: jsonRpcCode(error),
          message: error.message,
          // A limit refusal carries its numbers (SEC-02), since its sentence is fixed for translation; a modern framing
          // refusal carries its details where MCP 2026-07-28 defines them.
          data: {
            code: error.code,
            ...(limitRefusals.has(error.code)
              ? {details: error.details}
              : error.code in modernRefusals
                ? error.details
                : {}),
          },
        },
      });
    } else {
      // The ingress ID the response header already carries (OPS-08), so the header, the body and the log line agree.
      const requestId: string = res.locals.requestId ?? randomUUID();
      // Correlate the existing early website refusal without logging its URL, body, credentials or message.
      // Diagnostic delivery must not prevent the original HTTP response if an optional sink fails.
      try {
        log({
          level: error.status >= 500 ? 'error' : 'warn',
          event: error.status >= 500 ? 'http_failed' : 'http_refused',
          status: error.status,
          code: error.code,
          requestId,
          at: new Date((options.clock ?? Date.now)()).toISOString(),
          ...(database ? {database} : {}),
        });
      } catch {}
      res.status(error.status).json({error: {code: error.code, message: error.message}, meta: {requestId}});
    }
  };
  app.use(errors);
  return app;
}
