import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import express, {type ErrorRequestHandler} from 'express';
import {hostHeaderValidation} from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {createMcpServer} from './mcp.js';
import {MirrorService} from '../src/service.js';
import {Store} from '../src/store.js';
import {MirrorError} from '../src/errors.js';
import {createWebsite} from './website.js';
import type {WebsiteOptions} from './web-store.js';
import type {Actor, JsonObject} from '../src/types.js';
import {OAuthError} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {createReleaseStatus} from '../src/release-status.js';
import {recordSqliteFailure} from '../src/sqlite-diagnostics.js';
import {mediaRetentionState, storageState} from '../src/storage-health.js';
export interface HttpOptions {
  host?: string;
  publicOrigin?: string;
  maxBodyBytes?: number;
  website?: WebsiteOptions;
  /** Browser origins, besides the public origin, whose MCP requests are accepted (AMCP_MCP_ALLOWED_ORIGINS). None by default. */
  mcpAllowedOrigins?: string[];
  /** Receives one structured entry per refused or failed MCP request or non-MCP HTTP error; no request payload or credentials. */
  log?: (entry: JsonObject) => void;
  /** Milliseconds since the epoch; tests replace it. */
  clock?: () => number;
  /** Trusted packaged-artifact root, never selected by HTTP input. */
  releaseRoot?: string;
  /** Whether unknown storage degrades health (production); defaults to NODE_ENV=production. */
  production?: boolean;
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
/** JSON-RPC's code for a refusal before the request reached MCP: parse error, invalid request, internal, or server. */
const jsonRpcCode = (e: MirrorError) =>
  e.code === 'INVALID_JSON' ? -32700 : e.code === 'REQUEST_TOO_LARGE' ? -32600 : e.status >= 500 ? -32603 : -32000;
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
  const log = options.log ?? (() => {}),
    health = healthCheck(
      service,
      store,
      options.clock ?? Date.now,
      options.production ?? process.env.NODE_ENV === 'production',
    );
  // MCP tool failures that reach no HTTP status (JSON responses are 200) still leave one metadata-only line (OPS-02).
  if (options.log) service.onToolFailure = entry => log(entry);
  const app = express();
  app.disable('x-powered-by');
  // Railway health probes need no workspace data and may use a platform host header. This route
  // is mounted before host validation so the platform probe can reach it, which makes it
  // unauthenticated: it reports liveness only. Whether the instance can perform real provider
  // mutations is operational detail an anonymous caller has no use for, and it is still reported
  // on the authenticated health surface (amcp_workspace health).
  app.get('/healthz', async (_req, res) => {
    const result = await health();
    res.status(result.status).setHeader('Cache-Control', 'no-store').json(result.body);
  });
  // Every refused or failed MCP request leaves one log line, host validation's included: an outage like 2026-09-24's
  // must leave evidence. The line never carries the bearer token.
  app.use('/mcp', (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode < 400) return;
      log({
        level: res.statusCode >= 500 ? 'error' : 'warn',
        event: res.statusCode >= 500 ? 'mcp_failed' : 'mcp_refused',
        status: res.statusCode,
        code: res.locals.errorCode ?? 'HTTP_' + res.statusCode,
        method: req.method,
        origin: req.headers.origin ?? null,
        at: new Date().toISOString(),
      });
    });
    next();
  });
  app.use(hostHeaderValidation(['127.0.0.1', 'localhost', '[::1]', ...(origin ? [origin.hostname] : [])]));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (origin) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const releaseStatus = createReleaseStatus({
    root: options.releaseRoot ?? process.cwd(),
    clock: options.clock ?? Date.now,
  });
  app.get('/versionz', async (_req, res) => {
    const result = await releaseStatus();
    res.status(result.status === 'matches_build' ? 200 : 503).json(result);
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
      if (options.website)
        res.setHeader(
          'WWW-Authenticate',
          'Bearer resource_metadata="' + options.website.origin + '/.well-known/oauth-protected-resource/mcp"',
        );
      const authorization = req.headers.authorization;
      if (!authorization?.startsWith('Bearer '))
        throw new MirrorError('UNAUTHORIZED', 'Bearer authentication required.', {}, 401);
      res.locals.actor = store.authenticate(authorization.slice(7));
      next();
    } catch (e) {
      next(e);
    }
  });
  app.post(
    '/mcp',
    express.json({limit: options.maxBodyBytes ?? 4 * 1024 * 1024, strict: true}),
    async (req, res, next) => {
      const server = createMcpServer(service, res.locals.actor),
        transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
      res.on('close', () => {
        void Promise.allSettled([transport.close(), server.close()]);
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (e) {
        next(e);
      }
    },
  );
  app.all('/mcp', (_req, res) =>
    res.status(405).setHeader('Allow', 'POST').json({error: 'Stateless MCP endpoint: use POST.'}),
  );
  if (options.website) {
    const website = createWebsite(store, options.website, service.policy.allowWrites, service);
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
    if (req.baseUrl === '/mcp' || req.path === '/mcp')
      res.status(error.status).json({
        jsonrpc: '2.0',
        id: typeof req.body?.id === 'string' || typeof req.body?.id === 'number' ? req.body.id : null,
        error: {code: jsonRpcCode(error), message: error.message, data: {code: error.code}},
      });
    else {
      const requestId = randomUUID();
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
