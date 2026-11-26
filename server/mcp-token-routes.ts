import express from 'express';
import {InvalidGrantError, mcpAuthRouter} from '@modelcontextprotocol/server-legacy/auth';
import {mcpOAuthProtocolRoutes} from './mcp-oauth-routes.js';
import type {WebsiteSite} from './website-site.js';

/**
 * The failure and success budgets of the MCP OAuth token and revocation endpoints (SEC-01, MCP-03), in front of the
 * SDK's own handlers.
 */
export function mcpTokenLimits({router, web, mcpOAuth}: WebsiteSite) {
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
    } catch (e) {
      // A stale credential of a metadata-document client (F3), answered here as the SDK's handlers answer it for a registered
      // client, CORS header included (a browser client reads it): invalid_grant at /token, counted like any refused grant;
      // at /revoke the 200 RFC 7009 gives a token the server does not hold, which counts nothing.
      if (e instanceof InvalidGrantError) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.baseUrl === '/revoke') {
          res.status(200).json({});
          return;
        }
        web.recordMcpFailure(address);
        res.status(400).json(e.toResponseObject());
        return;
      }
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
}
/** The MCP OAuth authorization server: AMCP's protocol routes (MCP-03), then the SDK's, keyed on the client address. */
export function mcpAuthorizationServer({router, web, mcpOAuth, allowWrites}: WebsiteSite) {
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
}
