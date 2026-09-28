import express, {type ErrorRequestHandler} from 'express';
import {hostHeaderValidation} from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {createMcpServer} from './mcp.js';
import {MirrorService} from '../src/service.js';
import {Store} from '../src/store.js';
import {MirrorError} from '../src/errors.js';
import {createWebsite} from './website.js';
import type {WebsiteOptions} from './web-store.js';
import {OAuthError} from '@modelcontextprotocol/sdk/server/auth/errors.js';
export interface HttpOptions {
  host?: string;
  publicOrigin?: string;
  maxBodyBytes?: number;
  website?: WebsiteOptions;
}
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
  const app = express();
  app.disable('x-powered-by');
  // Railway health probes need no workspace data and may use a platform host header. This route
  // is mounted before host validation so the platform probe can reach it, which makes it
  // unauthenticated: it reports liveness only. Whether the instance can perform real provider
  // mutations is operational detail an anonymous caller has no use for, and it is still reported
  // on the authenticated health surface (amcp_workspace health).
  app.get('/healthz', (_req, res) => res.setHeader('Cache-Control', 'no-store').json({status: 'up', version: '0.1.0'}));
  app.use(hostHeaderValidation(['127.0.0.1', 'localhost', '[::1]', ...(origin ? [origin.hostname] : [])]));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (origin) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/mcp', (req, res, next) => {
    try {
      if (req.headers.origin && req.headers.origin !== origin?.origin)
        throw new MirrorError('FORBIDDEN_ORIGIN', 'Origin is not allowed.', {}, 403);
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
  const errors: ErrorRequestHandler = (e, _req, res, _next) => {
    if (res.headersSent) return;
    const error =
      e instanceof MirrorError
        ? e
        : e instanceof OAuthError
          ? new MirrorError('OAUTH_REQUEST_INVALID', e.message, {}, 400)
          : e.status === 404
            ? new MirrorError('NOT_FOUND', 'This resource was not found.', {}, 404)
            : e.type === 'entity.too.large'
              ? new MirrorError('REQUEST_TOO_LARGE', 'Request body exceeds the configured size limit.', {}, 413)
              : e instanceof SyntaxError
                ? new MirrorError('INVALID_JSON', 'Request body is not valid JSON.', {}, 400)
                : new MirrorError('INTERNAL_ERROR', 'Request could not be processed.', {}, 500);
    res.status(error.status).json({error: {code: error.code, message: error.message}});
  };
  app.use(errors);
  return app;
}
