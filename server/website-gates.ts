import {MirrorError} from '../src/errors.js';
import type {WebsiteSite} from './website-site.js';

/** The security headers of every website response: a strict CSP, no referrer, no framing, no device APIs (WEB-02). */
export function securityHeaders({router}: WebsiteSite) {
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
}
/** Reviewers may use product workflows in their isolated workspace, excluding account and owner administration. */
export function testAccountScope({router, web}: WebsiteSite) {
  // Keep the shared sign-in's security and owner controls closed. Product workflows,
  // including reviewed writes and AI clients, retain their normal authority checks.
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
    [/^\/api\/connections\/[^/]+\/(assets|write-access|label)$/, ['PATCH']],
    [/^\/api\/activity$/, ['GET']], // Activity tab
    [/^\/api\/reporting-(overview|files|evidence)\/[^/]+$/, ['GET']],
    [/^\/api\/workspace\/[a-z]+$/, ['POST']], // narrowed further by testAccountTools below
    [/^\/api\/workspace-search$/, ['POST']],
    [/^\/api\/working-clients$/, ['GET']],
    [/^\/api\/access-sets$/, ['GET']],
    [/^\/api\/connector-tokens$/, ['GET', 'POST']],
    [/^\/api\/connector-tokens\/[^/]+$/, ['DELETE']],
    [/^\/api\/mcp\/consent$/, ['GET', 'POST']],
    [/^\/api\/mcp\/authorizations$/, ['GET']],
    [/^\/api\/mcp\/authorizations\/[^/]+$/, ['DELETE']],
    [/^\/api\/write-approvals\/[^/]+$/, ['GET', 'POST']],
    [/^\/api\/media\/sources$/, ['GET', 'POST']],
    [/^\/api\/media\/sources\/[^/]+$/, ['GET', 'DELETE']],
    [/^\/api\/media\/sources\/(link|drive)$/, ['POST']],
    [/^\/api\/media\/sources\/[^/]+\/(retain|complete)$/, ['POST']],
    [/^\/api\/media\/sources\/[^/]+\/parts\/[^/]+$/, ['PUT']],
    [/^\/api\/media\/sources\/[^/]+\/thumbnail$/, ['GET']],
    [/^\/api\/media\/drive\/folder$/, ['POST']],
    [/^\/api\/media\/variants\/[^/]+\/preview$/, ['GET']],
    [/^\/api\/account$/, ['GET']], // Settings: read own profile
    [/^\/api\/account\/(options|delivery|sessions)$/, ['GET']],
    [/^\/api\/account\/sessions\/[^/]+$/, ['DELETE']], // Settings: end one's own sessions
    [/^\/api\/account\/reauthenticate$/, ['POST']], // "Confirm it's you" before a write grant (SEC-06)
    [/^\/api\/workspaces(\/members)?$/, ['GET']], // Settings: the reviewer's own workspace
  ];
  // Deliberately absent, because the reviewer password is shared: changing the password, email,
  // MFA or linked identities would let one evaluator lock every other one out, and owner
  // administration is not part of an evaluation.
  const testAccountTools = new Set(['workspace', 'overview', 'campaign', 'reporting', 'media', 'write', 'previews']);
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
}
/** The two-step enrollment gate (SEC-06 S3): an unenrolled member past the grace period reaches only enrollment. */
export function enrollmentScope({router, web}: WebsiteSite) {
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
}
