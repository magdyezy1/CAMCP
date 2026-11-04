import express from 'express';
import {createOAuthMetadata, type AuthRouterOptions} from '@modelcontextprotocol/server-legacy/auth';
import {metadataHandler} from '@modelcontextprotocol/server-legacy/auth';
import type {McpOAuth} from './mcp-oauth.js';

/**
 * One readable sentence for an OAuth error description. The MCP SDK puts the raw JSON of its schema validation in
 * error_description (MCP-03, review 2026-10-08); a client shows that to a person, so it is turned into field names and
 * reasons. Any other description is returned as it was.
 */
export function readableOAuthDescription(description: unknown): unknown {
  if (typeof description !== 'string' || !/^\s*[[{]/.test(description)) return description;
  try {
    const parsed = JSON.parse(description),
      issues: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.issues) ? parsed.issues : [parsed];
    const parts = issues.slice(0, 3).map(issue => {
      const {path, message} = (issue ?? {}) as {path?: unknown; message?: unknown},
        field = Array.isArray(path) && path.length ? path.map(String).join('.') : undefined,
        reason = typeof message === 'string' ? message.replace(/\s+/g, ' ').slice(0, 120) : 'is invalid';
      return field ? field + ' (' + reason + ')' : reason;
    });
    return ('The request is invalid: ' + parts.join('; ') + (issues.length > 3 ? '; and more' : '') + '.').slice(
      0,
      400,
    );
  } catch {
    return 'The request is invalid.';
  }
}

/**
 * Protocol additions in front of the SDK's authorization router (MCP-03):
 * - authorization-server metadata that also advertises RFC 9207 `iss` and, when enabled, Client ID Metadata Documents;
 * - `iss` on every authorization response the SDK redirects to the client (its error redirects); AMCP's own consent
 *   decision adds it in McpOAuth.decide;
 * - readable error descriptions on /authorize, /register, /token and /revoke;
 * - per-address and per-deployment limits on dynamic registration (phase 2).
 * Mount it before mcpAuthRouter with the same options.
 */
export function mcpOAuthProtocolRoutes(oauth: McpOAuth, options: AuthRouterOptions): express.Router {
  const router = express.Router(),
    origin = new URL(oauth.issuer).origin;
  router.use(
    '/.well-known/oauth-authorization-server',
    metadataHandler({
      ...createOAuthMetadata(options),
      authorization_response_iss_parameter_supported: true,
      ...(oauth.metadataDocuments ? {client_id_metadata_document_supported: true} : {}),
    }),
  );
  router.use(['/authorize', '/register', '/token', '/revoke'], (req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body => {
      if (body && typeof body === 'object' && 'error_description' in body)
        body = {...body, error_description: readableOAuthDescription(body.error_description)};
      return json(body);
    }) as typeof res.json;
    if (req.baseUrl === '/authorize') {
      const redirect = res.redirect.bind(res) as (...args: unknown[]) => void;
      res.redirect = ((...args: unknown[]) => {
        const at = typeof args[0] === 'number' ? 1 : 0;
        try {
          const url = new URL(String(args[at]));
          // AMCP's own consent page is not an authorization response; every redirect to the client is.
          if (!(url.origin === origin && url.pathname === '/oauth/consent')) {
            if (url.searchParams.has('error_description'))
              url.searchParams.set(
                'error_description',
                String(readableOAuthDescription(url.searchParams.get('error_description'))),
              );
            url.searchParams.set('iss', oauth.issuer);
            args[at] = url.href;
          }
        } catch {}
        return redirect(...args);
      }) as typeof res.redirect;
    }
    next();
  });
  // MCP-03 phase 2: dynamic registrations are limited per client address (SEC-01 attribution) and per deployment in 24
  // hours, before the SDK registers anything. A registration that does not complete gives its place back.
  router.post('/register', (req, res, next) => {
    const admitted = oauth.admitRegistration(oauth.web.limitAddress(req));
    if (!('settle' in admitted)) {
      res
        .status(429)
        .setHeader('Retry-After', String(admitted.wait))
        .setHeader('Cache-Control', 'no-store')
        .json({
          error: 'too_many_requests',
          error_description:
            admitted.scope === 'address'
              ? 'Too many AI-client registrations from this network in the last 24 hours. Try again later.'
              : 'This AMCP deployment has accepted its daily number of new AI-client registrations. Try again later.',
        });
      return;
    }
    const json = res.json.bind(res);
    res.json = (body => {
      admitted.settle(res.statusCode === 201 && typeof body?.client_id === 'string');
      return json(body);
    }) as typeof res.json;
    res.on('close', () => admitted.settle(false));
    next();
  });
  return router;
}
