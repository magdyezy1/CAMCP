import {bad, type ToolCall} from './workspace-core.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {googlePortfolioPage} from './google-portfolio.js';
import {metaPortfolioPage} from './meta-portfolio.js';
import {linkedinPortfolioPage} from './linkedin-portfolio.js';
import {snapchatPortfolioPage} from './snapchat-portfolio.js';

export async function portfolioPage(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  if (input.gateway === 'google_ads_native_action') return googlePortfolioPage(store, call, actor, input);
  if (input.gateway === 'meta_native_action') return metaPortfolioPage(store, call, actor, input);
  if (input.gateway === 'linkedin_native_action') return linkedinPortfolioPage(store, call, actor, input);
  if (input.gateway === 'snapchat_native_action') return snapchatPortfolioPage(store, call, actor, input);
  return bad(
    'Portfolio adapters cover Google Ads, Meta, LinkedIn and Snapchat. Other platforms retain their native read workflows.',
    'PORTFOLIO_UNQUALIFIED',
  );
}
