import express from 'express';
import path from 'node:path';
import type {MirrorService} from '../src/service.js';
import type {Store} from '../src/store.js';
import {reviewerConnectionLifetime} from './account-lifecycle.js';
import {accountRoutes} from './account-routes.js';
import {AssetDiscovery} from './asset-discovery.js';
import {McpOAuth} from './mcp-oauth.js';
import {mfaBaseline, mfaBaselineConfig} from './mfa-policy.js';
import {PlatformOAuth} from './platform-oauth.js';
import {createPublicAssets} from './public-assets.js';
import {SocialSignIn} from './social-signin.js';
import {UserAccounts} from './user-accounts.js';
import {WebStore, type WebsiteOptions} from './web-store.js';
import {connectionViews} from './website-connections.js';
import type {WebsiteRoutes, WebsiteSite} from './website-site.js';
import {enrollmentScope, securityHeaders, testAccountScope} from './website-gates.js';
import {mcpAuthorizationServer, mcpTokenLimits} from './mcp-token-routes.js';
import {reportDownloadRoutes} from './report-download-routes.js';
import {workspaceRoutes} from './workspace-routes.js';
import {sessionRoutes} from './session-routes.js';
import {mcpConsentRoutes} from './mcp-consent-routes.js';
import {platformRoutes} from './platform-routes.js';
import {connectionRoutes} from './connection-routes.js';
import {accessRoutes} from './access-routes.js';
import {activityRoutes} from './activity-routes.js';
import {helpRoutes} from './help-routes.js';
import {pageRoutes} from './page-routes.js';

/** Account sign-up, sign-in, recovery and security pages (server/account-routes.ts). */
const accountPages: WebsiteRoutes = ({router, web, accounts, social}) => {
  router.use(accountRoutes(web, accounts, social));
};
/** No API response is cached. */
const apiResponses: WebsiteRoutes = ({router}) => {
  router.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
};
/**
 * The website's route registry (ARC-04 stage D): its route modules in registration order, which is the order Express
 * matches their routes in. The security headers and the access gates come first, so they see every request; the
 * account pages before the no-store and MCP OAuth layers, as before; the provider callbacks before the connection
 * routes (/api/:platform/callback precedes /api/connections/:id); the members-only Help page (DOC-03) before the
 * public pages, and the public pages and the not-found page last. A new route joins the module of its area, in that
 * module's order.
 */
export const websiteRoutes: readonly WebsiteRoutes[] = Object.freeze([
  securityHeaders,
  testAccountScope,
  enrollmentScope,
  accountPages,
  apiResponses,
  mcpTokenLimits,
  mcpAuthorizationServer,
  reportDownloadRoutes,
  workspaceRoutes,
  sessionRoutes,
  mcpConsentRoutes,
  platformRoutes,
  connectionRoutes,
  accessRoutes,
  activityRoutes,
  helpRoutes,
  pageRoutes,
]);

/**
 * The website's parts, as its route modules receive them (ARC-04 stage D): built in the order createWebsite built
 * them, with a case-sensitive router (the test-account gate also compares lower-cased paths).
 */
export function websiteSite(
  store: Store,
  options: WebsiteOptions,
  allowWrites = false,
  service?: MirrorService,
): WebsiteSite {
  const web = new WebStore(store, options);
  // RPT-06: the deployment owner's switch for provider report and export jobs, as the MCP service applies it.
  const providerJobs = service?.policy.providerJobs === true;
  // Saved logins use the app secrets of this deployment's environment, the one connecting uses (SEC-07 S2).
  if (options.authEnv || !store.appEnvironment) store.appEnvironment = options.authEnv ?? process.env;
  // Two-step verification for owners and administrators of write-enabled deployments (SEC-06, owner decision P2).
  web.mfaBaseline = mfaBaseline(store, web.tenantId, mfaBaselineConfig(options.authEnv ?? process.env, allowWrites));
  // How long a reviewer workspace login stays before the worker removes it (SEC-06 S6).
  const reviewerLifetime = reviewerConnectionLifetime(options.authEnv ?? process.env);
  const oauth = new PlatformOAuth(web, options.authEnv ?? process.env, options.fetcher, allowWrites),
    discovery = new AssetDiscovery(store, options.fetcher),
    router = express.Router({caseSensitive: true});
  const mcpOAuth = new McpOAuth(web, allowWrites);
  const accounts = new UserAccounts(web),
    social = new SocialSignIn(accounts);
  const directory = path.resolve(options.staticDirectory ?? 'web'),
    publicAssets = createPublicAssets(directory);
  return {
    store,
    options,
    allowWrites,
    service,
    web,
    providerJobs,
    oauth,
    discovery,
    router,
    mcpOAuth,
    accounts,
    social,
    webAccounts: accounts,
    directory,
    publicAssets,
    connections: connectionViews(store, web, options, oauth, discovery, reviewerLifetime),
  };
}
/** The website: its parts, and every route module of the registry registered on its router, in order. */
export function createWebsite(store: Store, options: WebsiteOptions, allowWrites = false, service?: MirrorService) {
  const site = websiteSite(store, options, allowWrites, service);
  for (const routes of websiteRoutes) routes(site);
  const {router, web, oauth, discovery, mcpOAuth, accounts, publicAssets} = site;
  // The public asset version of the snapshot these routes serve; /versionz reports it (QA-01).
  return {router, web, oauth, discovery, mcpOAuth, accounts, assetVersion: publicAssets.version};
}
