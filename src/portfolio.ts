import {bad, type ToolCall} from './workspace-core.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {googlePortfolioPage} from './google-portfolio.js';
import {metaPortfolioPage} from './meta-portfolio.js';
import {linkedinPortfolioPage} from './linkedin-portfolio.js';
import {snapchatPortfolioPage} from './snapchat-portfolio.js';
import {tiktokPortfolioPage} from './tiktok-portfolio.js';
import {xPortfolioPage} from './x-portfolio.js';
import {microsoftPortfolioPage} from './microsoft-portfolio.js';

export async function portfolioPage(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  if (input.gateway === 'google_ads_native_action') return googlePortfolioPage(store, call, actor, input);
  if (input.gateway === 'meta_native_action') return metaPortfolioPage(store, call, actor, input);
  if (input.gateway === 'linkedin_native_action') return linkedinPortfolioPage(store, call, actor, input);
  if (input.gateway === 'snapchat_native_action') return snapchatPortfolioPage(store, call, actor, input);
  if (input.gateway === 'tiktok_native_action') return tiktokPortfolioPage(store, call, actor, input);
  if (input.gateway === 'x_ads_native_action') return xPortfolioPage(store, call, actor, input);
  // RPT-07 (B27): Microsoft Advertising, whose campaigns AMCP itself creates.
  if (input.gateway === 'microsoft_ads_native_action') return microsoftPortfolioPage(store, call, actor, input);
  return bad(
    'Portfolio adapters cover Google Ads, Meta, LinkedIn, Snapchat, TikTok, X and Microsoft Advertising. Other platforms retain their native read workflows.',
    'PORTFOLIO_UNQUALIFIED',
  );
}
