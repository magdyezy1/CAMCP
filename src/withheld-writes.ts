/**
 * Blocked writes whose refusal can say more than "no reviewed family": the ledger (src/action-contracts.ts) records the
 * reason, and the write-shape refusal (src/write-shape.ts) carries it in `details.reason`. They stay refused like every
 * other write without a family. First, writes a check of the official sources found too little to state exactly
 * (F-58, batch 33, read 2026-09-29).
 */
const evidenceWithheld: Record<string, string> = {
  'tiktok_native_action tiktok_creative_portfolio_delete':
    "Blocked on evidence: TikTok's official SDK (tiktok/tiktok-business-api-sdk, 2026-02-28) defines portfolio create, get and list but no delete, and TikTok's documentation pages render only in a browser, so which portfolios can be deleted and what becomes of ads using them is unread.",
  'x_ads_native_action x_accounts_account_id_targeting_criteria_targeting_criterion_id_put':
    "Not documented: docs.x.com's Campaign Management reference (read 2026-09-29) gives targeting criteria a read, a create, a batch create and a delete, and no update. To change a criterion, delete it and create the new one with the reviewed targeting writes.",
  'meta_native_action meta_ad_account_id_campaigns_delete':
    "Deletes the account's campaigns by rule (delete_strategy, before_date, object_count and delete_offset in Meta's official Business SDK), not by ID, so no review can name what it would delete. Delete each campaign with the reviewed meta_campaign_id_delete.",
  'snapchat_native_action snapchat_adaccounts_ad_account_id_creatives_creative_id_update':
    "Snapchat's Creatives page (read 2026-09-29) names PUT /creatives/{creative_id} once, but its example sends the full creative to the collection. Use the reviewed collection PUT (snapchat_adaccounts_ad_account_id_creatives_update, a complete replacement) or the reviewed JSON Patch (snapchat_creative_patch).",
  'x_ads_native_action x_stats_jobs_accounts_account_id_delete':
    "Blocked on evidence: docs.x.com's analytics page (read 2026-09-29) no longer documents deleting an asynchronous job, and the earlier reference placed the job ID in the path (stats/jobs/accounts/:account_id/:job_id), which the captured route lacks.",
  'google_ads_native_action CREATE_CAMPAIGN_BID_MODIFIER':
    'Blocked on evidence: Google Ads API v25\'s discovery document marks CampaignBidModifier.campaign "Output only" and expects no resource name on create, so no documented request names the campaign, and Google\'s code samples (read 2026-09-29) show no campaign bid modifier creation. Change or remove an existing call modifier with the reviewed campaignBidModifiers update and remove.',
  'dv360_native_action DV360_FLOODLIGHT_GROUPS_PATCH':
    'Outside the selected advertiser: DV360 API v4 updates a Floodlight group in a partner context (partnerId is required), and its lookback window and custom variables decide how conversions are counted for every advertiser that uses the group. Change Floodlight groups in Display & Video 360.',
  'google_business_native_action gmb_verification_ops/COMPLETE_VERIFICATION':
    "Account setup, which the owner kept blocked on 2026-09-29 (enabled on request): completing a PENDING verification with its code changes the location's verification state. Complete it in Business Profile.",
};
/** DV360 API v4 (pinned discovery document): "This method is only available to an informed subset of users." */
for (const action of [
  'DV360_ADVERTISERS_AD_GROUPS_YOUTUBE_ASSET_TYPES_YOUTUBE_ASSET_ASSOCIATIONS_CREATE',
  'DV360_ADVERTISERS_AD_GROUPS_YOUTUBE_ASSET_TYPES_YOUTUBE_ASSET_ASSOCIATIONS_DELETE',
  'DV360_ADVERTISERS_LINE_ITEMS_YOUTUBE_ASSET_TYPES_YOUTUBE_ASSET_ASSOCIATIONS_CREATE',
  'DV360_ADVERTISERS_LINE_ITEMS_YOUTUBE_ASSET_TYPES_YOUTUBE_ASSET_ASSOCIATIONS_DELETE',
])
  evidenceWithheld['dv360_native_action ' + action] =
    'Allowlist-only: DV360 API v4 documents this method as "only available to an informed subset of users", and AMCP keeps allowlist-only methods unqualified.';
/**
 * Blocked writes that duplicate an account-scoped route AMCP reviews: LinkedIn's current Creatives and Campaigns pages
 * (Microsoft Learn, li-lms-2026-09, read 2026-09-29) document creatives and campaigns only under
 * /rest/adAccounts/{id}/…, which binds the request to the selected ad account. The ledger names the route to use.
 */
const accountScoped = (action: string) =>
  'Not documented at LinkedIn-Version 202609, whose pages place this resource under /rest/adAccounts/{id}/. Use the reviewed ' +
  action +
  ', which binds the request to the selected ad account.';
const linkedinAccountScoped: Record<string, string> = {
  linkedin_rest_ad_campaigns_post: accountScoped('linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post'),
  linkedin_rest_adcampaigns_post: accountScoped('linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post'),
  linkedin_rest_creatives_post: accountScoped('linkedin_rest_ad_accounts_ad_account_id_creatives_post'),
  linkedin_rest_creatives_delete: accountScoped('linkedin_rest_ad_accounts_ad_account_id_creatives_delete'),
  linkedin_rest_creatives_creative_urn_post: accountScoped(
    'linkedin_rest_ad_accounts_ad_account_id_creatives_creative_urn_post',
  ),
  linkedin_rest_creatives_creative_urn_delete: accountScoped(
    'linkedin_rest_ad_accounts_ad_account_id_creatives_creative_id_delete',
  ),
};
for (const [action, reason] of Object.entries(linkedinAccountScoped))
  evidenceWithheld['linkedin_native_action ' + action] = reason;
/**
 * TikTok catalogs, opened by the owner on 2026-09-29 but blocked on evidence: TikTok's documentation portal
 * (business-api.tiktok.com/portal/docs, rendered in a browser on 2026-09-29) shows only its Reporting and Authentication
 * pages without signing in, and every other page falls back to the guide's front page. TikTok's official SDK
 * (tiktok/tiktok-business-api-sdk) gives these requests their fields but no responses and no meaning: the product set
 * conditions, the feed schedule and what a deletion removes. A review could state neither the effect nor read it back.
 */
const tiktokCatalog =
  "Blocked on evidence: TikTok's documentation portal shows only its Reporting and Authentication pages without signing in (read 2026-09-29), and TikTok's official SDK gives this catalog request its fields but no response or meaning, so no review could state its effect or read it back. Manage TikTok catalogs in TikTok Catalog Manager for now.";
for (const action of [
  'tiktok_catalog_capitalize_migrate',
  'tiktok_catalog_create',
  'tiktok_catalog_delete',
  'tiktok_catalog_eventsource_bind',
  'tiktok_catalog_eventsource_unbind',
  'tiktok_catalog_feed_create',
  'tiktok_catalog_feed_delete',
  'tiktok_catalog_feed_switch_update',
  'tiktok_catalog_feed_update',
  'tiktok_catalog_product_delete',
  'tiktok_catalog_product_file_upload',
  'tiktok_catalog_product_update',
  'tiktok_catalog_product_upload',
  'tiktok_catalog_set_create',
  'tiktok_catalog_set_delete',
  'tiktok_catalog_set_update',
  'tiktok_catalog_set_upload',
  'tiktok_catalog_update',
  'tiktok_catalog_video_delete',
  'tiktok_catalog_video_file_upload',
])
  evidenceWithheld['tiktok_native_action ' + action] = tiktokCatalog;
/** The specific reason a write without a family stays blocked, when AMCP knows one. */
export function withheldWriteReason(gateway: string, action: string): string | undefined {
  return evidenceWithheld[gateway + ' ' + action];
}
