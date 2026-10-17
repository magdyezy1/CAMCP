import {bad, type ToolCall} from './workspace-core.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import type {PortfolioAdapter} from './portfolio-runner.js';
import {googlePortfolioAdapter} from './google-portfolio.js';
import {metaPortfolioAdapter} from './meta-portfolio.js';
import {linkedinPortfolioAdapter} from './linkedin-portfolio.js';
import {snapchatPortfolioAdapter} from './snapchat-portfolio.js';
import {tiktokPortfolioAdapter} from './tiktok-portfolio.js';
import {xPortfolioAdapter} from './x-portfolio.js';
import {microsoftPortfolioAdapter} from './microsoft-portfolio.js';

/**
 * The portfolio adapters (ARC-04 stage E), one per provider gateway: amcp_workspace portfolio pages a provider's
 * inventory through the adapter of its gateway. RPT-07 (B27) added Microsoft Advertising, whose campaigns AMCP itself
 * creates.
 */
export const portfolioAdapters: readonly PortfolioAdapter[] = Object.freeze([
  googlePortfolioAdapter,
  metaPortfolioAdapter,
  linkedinPortfolioAdapter,
  snapchatPortfolioAdapter,
  tiktokPortfolioAdapter,
  xPortfolioAdapter,
  microsoftPortfolioAdapter,
]);

export async function portfolioPage(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  const adapter = portfolioAdapters.find(a => a.gateway === input.gateway);
  if (adapter) return adapter.page(store, call, actor, input);
  return bad(
    'Portfolio adapters cover Google Ads, Meta, LinkedIn, Snapchat, TikTok, X and Microsoft Advertising. Other platforms retain their native read workflows.',
    'PORTFOLIO_UNQUALIFIED',
  );
}
