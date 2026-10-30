import type {NextFunction, Request, Response, Router} from 'express';
import {providerById} from '../src/provider-adapters.js';
import type {MirrorService} from '../src/service.js';
import type {Store} from '../src/store.js';
import type {AssetDiscovery} from './asset-discovery.js';
import type {McpOAuth} from './mcp-oauth.js';
import type {PlatformOAuth} from './platform-oauth.js';
import type {createPublicAssets} from './public-assets.js';
import type {SocialSignIn} from './social-signin.js';
import type {UserAccounts} from './user-accounts.js';
import type {WebStore, WebsiteOptions} from './web-store.js';
import type {ConnectionViews} from './website-connections.js';

/**
 * The website's parts as every route module receives them (ARC-04 stage D). createWebsite (server/website.ts) builds
 * one site and calls the route modules in their registration order (websiteRoutes), which is the order Express
 * matches them in; each module registers on `router` itself, so the router holds the layers createWebsite registered
 * before the split, in the same order.
 */
export interface WebsiteSite {
  readonly store: Store;
  readonly options: WebsiteOptions;
  readonly allowWrites: boolean;
  readonly service?: MirrorService;
  readonly web: WebStore;
  /** RPT-06: the deployment owner's switch for provider report and export jobs, as the MCP service applies it. */
  readonly providerJobs: boolean;
  readonly oauth: PlatformOAuth;
  readonly discovery: AssetDiscovery;
  readonly router: Router;
  readonly mcpOAuth: McpOAuth;
  readonly accounts: UserAccounts;
  readonly social: SocialSignIn;
  /** The same accounts, for handlers whose own `accounts` is a list of advertising accounts (recent-proof checks). */
  readonly webAccounts: UserAccounts;
  /** The directory the public website files are served from, and their snapshot (WEB-02). */
  readonly directory: string;
  readonly publicAssets: ReturnType<typeof createPublicAssets>;
  /** The website's views of the workspace's logins (server/website-connections.ts). */
  readonly connections: ConnectionViews;
}
/** A route module: registers its middleware and routes on site.router, in its own order. */
export type WebsiteRoutes = (site: WebsiteSite) => void;
/** A route handler whose thrown error or rejected promise goes on to the error handler. */
export const handler =
  (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (e) {
      next(e);
    }
  };
// The person an AI-client grant or connector token belongs to: an account user, or null for the administrator door.
export const grantOwner = (s: {actor: {userId: string}}) =>
  s.actor.userId === 'workspace-admin' ? null : s.actor.userId;
/**
 * The gateways the website treats by name: Google Ads (its renewal and authorization view) and WooCommerce (store
 * connections, which Commerce manages). They come from the provider adapter registry (ARC-01), so no website module
 * names a gateway itself; how a login's accounts are reached (Microsoft's parent customers, Google Ads' manager routes)
 * is its provider's fact and login step.
 */
export const googleAdsGateway = providerById('google')!.gateway,
  commerceGateway = providerById('woocommerce')!.gateway;
