import {compileEntityRead} from './workflows.js';
import {bad, fingerprint, validate, type ToolCall} from './workspace-core.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {metaPortfolioPage} from './meta-portfolio.js';
import {linkedinPortfolioPage} from './linkedin-portfolio.js';
import {snapchatPortfolioPage} from './snapchat-portfolio.js';
export async function portfolioPage(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  if (input.gateway === 'meta_native_action') return metaPortfolioPage(store, call, actor, input);
  if (input.gateway === 'linkedin_native_action') return linkedinPortfolioPage(store, call, actor, input);
  if (input.gateway === 'snapchat_native_action') return snapchatPortfolioPage(store, call, actor, input);
  if (input.gateway !== 'google_ads_native_action')
    bad(
      'Portfolio adapters cover Google Ads, Meta, LinkedIn and Snapchat. Other platforms retain their native read workflows.',
      'PORTFOLIO_UNQUALIFIED',
    );
  const config = input.requirements ?? {};
  validate(config, ['entity', 'campaign_id', 'ad_group_id']);
  const entity = config.entity ?? 'campaign';
  if (!['campaign', 'ad_group', 'ad'].includes(entity)) bad('Choose campaign, ad_group or ad.');
  if (entity !== 'campaign' && !/^\d+$/.test(config.campaign_id ?? '')) bad('Choose the parent campaign.');
  if (entity === 'ad' && !/^\d+$/.test(config.ad_group_id ?? '')) bad('Choose the parent ad group.');
  const connection = store.resolveConnection(actor, input.gateway, input.account_id, input.connection_id),
    limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) bad('Portfolio pages contain 1–100 entities.');
  const binding = fingerprint({
    gateway: input.gateway,
    connection_id: connection.id,
    account_id: input.account_id,
    entity,
    config,
  });
  let after: string | undefined;
  if (input.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(String(input.cursor), 'base64url').toString('utf8'));
      if (cursor.binding !== binding || !/^\d+$/.test(cursor.after))
        bad('The cursor belongs to another account or entity.');
      after = cursor.after;
    } catch {
      bad('Choose a cursor from this exact portfolio page.', 'INVALID_CURSOR');
    }
  }
  const native = compileEntityRead(
      entity === 'campaign' ? 'list_campaigns' : entity === 'ad_group' ? 'fetch_adsets' : 'fetch_ads',
      {
        platform: 'google',
        account_id: input.account_id,
        campaign_id: config.campaign_id,
        adset_id: config.ad_group_id,
        limit: limit + 1,
      },
    ),
    key = entity === 'ad' ? 'ad_group_ad.ad.id' : entity + '.id';
  if (after)
    native.input.payload.query = native.input.payload.query.replace(' ORDER BY ', ` AND ${key} > ${after} ORDER BY `);
  const budget = new ReportCollectionBudget(undefined, binding, () => {}, {
    requests: 5,
    rows: 101,
    elapsed_ms: 60000,
    bytes: 8 * 1024 * 1024,
  });
  let response: JsonObject;
  try {
    response = await budget.run(() =>
      call(native.gateway, {...native.input, connection_id: connection.id, dry_run: false}, actor),
    );
  } finally {
    budget.close();
  }
  if (!response.success)
    bad(response.error?.message ?? 'Portfolio read failed.', response.error?.code ?? 'PORTFOLIO_FAILED');
  const raw = response.data?.data?.results;
  if (!Array.isArray(raw) || response.data?.truncated)
    bad('The provider inventory was incomplete or had an unknown shape.', 'PORTFOLIO_INCOMPLETE');
  store.resolveConnection(actor, input.gateway, input.account_id, connection.id);
  const rows = raw.map((r: JsonObject) => {
    const object = entity === 'campaign' ? r.campaign : entity === 'ad_group' ? r.adGroup : r.adGroupAd?.ad;
    if (!object || !/^\d+$/.test(String(object.id)))
      bad('A portfolio entity has no exact native ID.', 'PORTFOLIO_INVALID_RESPONSE');
    if (config.campaign_id && String(r.campaign?.id) !== config.campaign_id)
      bad('The provider returned a different parent campaign.', 'STATE_TARGET_MISMATCH');
    if (config.ad_group_id && String(r.adGroup?.id) !== config.ad_group_id)
      bad('The provider returned a different parent ad group.', 'STATE_TARGET_MISMATCH');
    return {
      id: String(object.id),
      name: object.name ?? object.id,
      status: entity === 'ad' ? r.adGroupAd.status : object.status,
      entity,
      campaign_id: r.campaign?.id ?? null,
      ad_group_id: r.adGroup?.id ?? null,
      resource_name: object.resourceName ?? r.adGroupAd?.resourceName ?? null,
      currency: r.customer?.currencyCode ?? null,
      timezone: r.customer?.timeZone ?? null,
      budget_micros: r.campaignBudget?.amountMicros ?? null,
      cpc_bid_micros: r.adGroup?.cpcBidMicros ?? null,
      native: r,
    };
  });
  if (
    rows.length > limit + 1 ||
    rows.some((r, i) => i > 0 && BigInt(r.id) <= BigInt(rows[i - 1]!.id)) ||
    (after && rows.some(r => BigInt(r.id) <= BigInt(after!)))
  )
    bad('The inventory page is not a unique ordered continuation.', 'PORTFOLIO_INVALID_RESPONSE');
  const more = rows.length > limit,
    visible = rows.slice(0, limit);
  return {
    gateway: input.gateway,
    connection_id: connection.id,
    account_id: input.account_id,
    entity,
    rows: visible,
    has_more: more,
    next_cursor: more ? Buffer.from(JSON.stringify({binding, after: visible.at(-1)!.id})).toString('base64url') : null,
    captured_at: Date.now(),
    meaning:
      'Current native inventory, ordered by immutable IDs. Changes at the provider between pages are possible. This read grants no write authority.',
  };
}
