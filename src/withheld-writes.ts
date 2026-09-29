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
  'snapchat_native_action snapchat_adaccounts_ad_account_id_creatives_creative_id_update':
    "Snapchat's Creatives page (read 2026-09-29) names PUT /creatives/{creative_id} once, but its example sends the full creative to the collection. Use the reviewed collection PUT (snapchat_adaccounts_ad_account_id_creatives_update, a complete replacement) or the reviewed JSON Patch (snapchat_creative_patch).",
  'x_ads_native_action x_stats_jobs_accounts_account_id_delete':
    "Blocked on evidence: docs.x.com's analytics page (read 2026-09-29) no longer documents deleting an asynchronous job, and the earlier reference placed the job ID in the path (stats/jobs/accounts/:account_id/:job_id), which the captured route lacks.",
};
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
/** The specific reason a write without a family stays blocked, when AMCP knows one. */
export function withheldWriteReason(gateway: string, action: string): string | undefined {
  return evidenceWithheld[gateway + ' ' + action];
}
