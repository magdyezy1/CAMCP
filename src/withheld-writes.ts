import {discoveryOnlyProgram, withheldWriteProgram} from './discovery-programs.js';

/**
 * Blocked writes whose refusal can say more than "no reviewed family": the ledger (src/action-contracts.ts) records the
 * reason, and the write-shape refusal (src/write-shape.ts) carries it in `details.reason`. They stay refused like every
 * other write without a family. First, writes a check of the official sources found too little to state exactly
 * (F-58, batch 33, read 2026-09-29).
 */
const evidenceWithheld: Record<string, string> = {
  'tiktok_native_action tiktok_creative_portfolio_delete':
    "Blocked on evidence: TikTok's official SDK (tiktok/tiktok-business-api-sdk, 2026-02-28) defines portfolio create, get and list but no delete, and TikTok's documentation pages render only in a browser, so which portfolios can be deleted and what becomes of ads using them is unread.",
  // PRV-06 B: comment moderation starts with hiding and unhiding, which can be undone.
  'tiktok_native_action tiktok_comment_post_create':
    "Not reviewed yet: a reply publishes text on the advertiser's ad under one of its identities. AMCP reviews hiding and unhiding comments first (tiktok_comment_status_update); reply in TikTok Ads Manager.",
  'tiktok_native_action tiktok_comment_delete':
    'Blocked: deleting a comment cannot be undone, and the TikTok sources AMCP read give it no state to verify. Hide the comment with the reviewed tiktok_comment_status_update (operation HIDDEN), which unhides with PUBLIC.',
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
/**
 * Criteo's supply side (read 2026-09-29): AMCP connects demand accounts and their own line items, while these serve
 * retailers. The "Keyword Review" guide: "When an advertiser proposes a set of keywords for review, these keywords are
 * then forwarded to the retailer reviewer"; its report is "not applicable for demand accounts". The "Supply Side
 * Reporting (SSP)" guide lists the revenue and fill rate reports, and the fill rate and unfilled placement requests
 * require supplyAccountIds.
 */
evidenceWithheld['criteo_native_action criteo_catalog_ops/UPDATE_KEYWORD_REVIEWS'] =
  "Supply side: Criteo's Keyword Review guide (read 2026-09-29) has the retailer reviewer approve or reject the keywords advertisers propose, and AMCP connects demand accounts. Advertisers add, remove and bid on keywords with the reviewed ADD_REMOVE_KEYWORDS and SET_KEYWORD_BIDS.";
for (const report of ['FILL_RATE', 'REVENUE', 'UNFILLED_PLACEMENTS'])
  evidenceWithheld['criteo_native_action criteo_reporting_ops/GENERATE_ASYNC_' + report + '_REPORT'] =
    "Supply side: Criteo's Supply Side Reporting (SSP) guide (read 2026-09-29) serves retailers' inventory reports, and AMCP connects demand accounts. Campaign and line item reports run through the reviewed Criteo report jobs.";
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
/**
 * Batch 41: the remaining candidates of X, Meta, TikTok and LinkedIn whose sources (read 2026-09-29) leave no review
 * to build, or put them under an owner decision.
 */
const xDoNotReach =
  "Personal data, not yet opened on X: an account's one Do Not Reach list only excludes the SHA-256 email hashes added to it through its users batch, and X applies it as exclusion targeting to every campaign of the account (docs.x.com Audiences reference, read 2026-09-29). The owner approved the personal-data policy on 2026-09-30, which opens platforms one at a time, Meta customer lists and Google Customer Match first.";
evidenceWithheld['x_ads_native_action x_accounts_account_id_do_not_reach_lists_post'] = xDoNotReach;
evidenceWithheld['x_ads_native_action x_accounts_account_id_do_not_reach_lists_do_not_reach_list_id_delete'] =
  xDoNotReach;
/** A personal-data write of a platform the approved order has not reached (personal-data policy, 2026-09-30). */
const personalLater = (platform: string) =>
  'Personal data, not yet opened on ' +
  platform +
  ': the personal-data policy the owner approved on 2026-09-30 opens platforms one at a time, Meta customer lists first (meta_customer_lists), and each needs its own review of the same seven rules.';
/**
 * Google Customer Match through the Google Ads API. Google Ads API deprecations (read 2026-09-30): "Developer tokens
 * with no Customer Match requests between October 1, 2025 and March 31, 2026 are restricted from using the Google Ads
 * API for Customer Match workflows ... CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE ... Use the Data Manager API". Data
 * Manager API v1 (discovery revision 20260929): audienceMembers:ingest needs the datamanager OAuth scope and carries
 * termsOfService.customerMatchTermsOfServiceStatus, "the caller's decision to accept or reject" the Customer Match terms.
 */
const googleCustomerMatch =
  "Replaced: since April 1, 2026, Google refuses Customer Match requests to OfflineUserDataJobService and UserDataService from projects that sent none between October 1, 2025 and March 31, 2026 (CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE, Google Ads API deprecations, read 2026-09-30), and AMCP sent none. Customer Match goes through Google's Data Manager API instead, reviewed as google_customer_match (DATA_MANAGER_INGEST_AUDIENCE_MEMBERS and DATA_MANAGER_REMOVE_AUDIENCE_MEMBERS), which the owner opened on 2026-09-30. Store sales uploads through the same jobs stay outside.";
/**
 * Google offline conversions through the Google Ads API. Google Ads API deprecations (read 2026-09-30): "Developer tokens
 * with no offline conversion upload requests between December 17, 2025 and June 15, 2026 are restricted ...
 * UploadClickConversions requests for these tokens will return a CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE error. Migrate
 * your offline conversion workflows to the Data Manager API". v25 CallConversion.callerId: "E.164 format with preceding
 * '+' sign".
 */
const googleClickConversions =
  "Replaced: since June 15, 2026, Google refuses UploadClickConversions from projects that sent no offline conversion upload between December 17, 2025 and June 15, 2026 (CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE, Google Ads API deprecations, read 2026-09-30), and AMCP sent none. Offline conversions go through Google's Data Manager API instead, reviewed as google_offline_conversions (DATA_MANAGER_INGEST_EVENTS), which the owner opened on 2026-09-30.";
const googleCallConversions =
  "Cannot meet the personal-data policy: a call conversion names the caller by phone number, which Google takes unhashed (callerId in E.164, Google Ads API v25 reference), while the policy's first rule sends phone numbers only hashed.";
const tiktokRules =
  "Blocked on evidence: the owner unblocked automated rules on 2026-09-30, and Meta's are reviewed (meta_ad_rules), but TikTok's documentation portal shows only its Reporting and Authentication pages without signing in (read 2026-09-30) and its official SDK gives no rule conditions, actions or limits, so no review could state what a TikTok rule would do or bound it.";
Object.assign(evidenceWithheld, {
  'google_ads_native_action CREATE_OFFLINE_USER_DATA_JOB': googleCustomerMatch,
  'google_ads_native_action ADD_OFFLINE_USER_DATA_JOB_OPERATIONS': googleCustomerMatch,
  'google_ads_native_action RUN_OFFLINE_USER_DATA_JOB': googleCustomerMatch,
  'google_ads_native_action google_ads_v23_offline_user_data_job_create_offline_user_data_job': googleCustomerMatch,
  'google_ads_native_action google_ads_v23_offline_user_data_job_add_offline_user_data_job_operations':
    googleCustomerMatch,
  'google_ads_native_action google_ads_v23_offline_user_data_job_run_offline_user_data_job': googleCustomerMatch,
  'google_ads_native_action google_ads_v23_user_data_upload_user_data': googleCustomerMatch,
  'tiktok_native_action tiktok_optimizer_rule_create': tiktokRules,
  'tiktok_native_action tiktok_optimizer_rule_update': tiktokRules,
  'meta_native_action meta_ad_account_id_recommendations_create':
    "Applies a Meta recommendation by its recommendation_signature (Meta's official Business SDK, v26.0). What it changes, whether budgets, placements, music or campaign structure, comes from the recommendation, not the request, so no review could name it. Read recommendations with the GET and make the change with its own reviewed write.",
  'meta_native_action meta_ad_account_id_tracking_create':
    'Cannot be reviewed or undone: Meta\'s AdAccountTracking reference (read 2026-09-29) adds tracking_specs "to the account level" with no update or deletion, and does not describe the object, so a review could neither state what it tracks nor reverse it.',
  'meta_native_action meta_business_id_event_source_groups_create':
    "Business-wide and permanent through the API: an event source group gathers pixels of the whole business, and Meta's reference (read 2026-09-29) documents creating one but no update or deletion. AMCP writes Meta objects of the selected ad account and its catalogs.",
  'meta_native_action meta_ad_account_id_adpreviews_create':
    "Not in Meta's official Business SDK for v26.0, which previews through GET act_{id}/generatepreviews. Preview with meta_ad_account_id_generatepreviews_get, or existing ads with amcp_ad_previews.",
  'meta_native_action meta_user_id_ad_studies_create':
    "A study owned by a user sits outside the selected ad account's business. Create split tests on the account's business with the reviewed meta_business_id_ad_studies_create.",
  'tiktok_native_action tiktok_pixel_track':
    'Personal data, not yet opened on TikTok: it sends pixel events for people. The personal-data policy the owner approved on 2026-09-30 opens platforms one at a time; Meta offline conversions are reviewed (meta_offline_conversions), and TikTok needs its own review, which its documentation, unreadable without signing in, does not yet allow.',
  'meta_native_action meta_custom_audience_id_usersreplace_create':
    'Replaces every person in a customer list in a session Meta ends 90 minutes after its first batch (Custom Audiences guide, read 2026-09-30), during which the list may not be changed otherwise. AMCP reviews additions and removals of up to 10,000 people each (meta_customer_lists); remove people, or delete the list and add them again.',
  'dv360_native_action DV360_FIRST_PARTY_AND_PARTNER_AUDIENCES_EDIT_CUSTOMER_MATCH_MEMBERS':
    personalLater('Display & Video 360'),
  'linkedin_native_action linkedin_rest_dmp_segments_segment_id_users_post': personalLater('LinkedIn'),
  'tiktok_native_action tiktok_dmp_custom_audience_file_upload': personalLater('TikTok'),
  'google_ads_native_action UPLOAD_CLICK_CONVERSIONS': googleClickConversions,
  'google_ads_native_action google_ads_v23_conversion_upload_upload_click_conversions': googleClickConversions,
  'google_ads_native_action UPLOAD_CALL_CONVERSIONS': googleCallConversions,
  'google_ads_native_action google_ads_v23_conversion_upload_upload_call_conversions': googleCallConversions,
  'snapchat_native_action snapchat_adaccounts_ad_account_id_claim_media_by_ad_code_create':
    "Outside the hosts AMCP calls: a claim by ad code names the brand's public profile (profile_id), and Snap's Public Profile API reads profiles on businessapi.snapchat.com (Profiles page, read 2026-09-30), not on the Ads API host AMCP reads and writes, so a review could not check that the profile belongs to the account's organization. Claiming a Snap by its ID is reviewed (snapchat_claim_media).",
  'snapchat_native_action snapchat_adaccounts_ad_account_id_creative_elements_create':
    "Cannot be read back: Snap's Creative Elements page (read 2026-09-30) documents creating an element but no way to read one, so AMCP could neither verify an element it creates nor check the elements a request names. Collection ads, which use them, work only on iOS (same page).",
  'snapchat_native_action snapchat_adaccounts_ad_account_id_interaction_zones_create':
    "Built from creative elements that cannot be read: Snap's Interaction Zones page (read 2026-09-30) needs at least four creative element IDs per zone, and no documented read shows an element's ad account, so AMCP could not check that a zone's elements belong to the selected account.",
  'snapchat_native_action snapchat_adsquads_ad_squad_id_ad_squad_ui_render_data_create':
    "Not documented: Snap's Campaigns page (read 2026-09-30) describes Ad Squad Render UI Data only as what tells Ads Manager whether an ad squad's ads are for web, app or both; it documents no request body and no effect on delivery, so a review could not state what it changes.",
  'linkedin_native_action linkedin_rest_example_post':
    "Not documented: a search of Microsoft Learn's LinkedIn Marketing API pages (2026-09-29) found no /rest/example resource. The captured name looks like a placeholder.",
});
/**
 * LinkedIn writes behind a permission AMCP does not request, and one without a documented request (Microsoft Learn,
 * li-lms-2026-09, read 2026-09-30). DMP segments that retarget engagement need only rw_ads (Engagement Retargeting page)
 * and are not listed here. The program-gated reasons come from their discovery-only program entries (ACC-05), which
 * also list the actions they withhold.
 */
const linkedinAudiences = discoveryOnlyProgram('program:linkedin_matched_audiences')!.withheld_reason!;
for (const action of [
  'linkedin_rest_ad_page_sets_post',
  'linkedin_rest_ad_segment_sources_source_urn_li_ad_page_set_id_segment_urn_li_ad_segment_id_put',
  'linkedin_rest_ad_segment_sources_source_urn_li_ad_page_set_id_segment_urn_li_ad_segment_id_delete',
  'linkedin_rest_dmp_segments_segment_id_business_objective_based_audiences_post',
  'linkedin_rest_dmp_segments_segment_id_business_objective_based_audiences_audience_id_post',
  'linkedin_rest_dmp_segments_segment_id_business_objective_based_audiences_audience_id_delete',
  'linkedin_rest_dmp_segments_segment_id_destinations_post',
])
  evidenceWithheld['linkedin_native_action ' + action] = linkedinAudiences;
Object.assign(evidenceWithheld, {
  'linkedin_native_action linkedin_rest_dmp_segments_segment_id_companies_post':
    linkedinAudiences + ' A company list is also a customer list under the personal-data policy.',
  'linkedin_native_action linkedin_rest_ad_segments_segment_id_post':
    "LinkedIn's pages disagree on the permission: the Ad Segments page names rw_ads, while Getting Access names rw_dmp_segments for the Ad Segments APIs (read 2026-09-30). Ad segments come from DMP segments and page sets, so renaming or archiving one waits with them on the owner's decision about rw_dmp_segments.",
  'linkedin_native_action linkedin_rest_media_plans_post':
    discoveryOnlyProgram('program:linkedin_media_plans')!.withheld_reason!,
  'linkedin_native_action linkedin_rest_ad_lift_tests_lift_test_id_ad_lift_test_surveys_post':
    "Not documented: LinkedIn's Lift Test Survey Management page (read 2026-09-30) shows the URL and a batch response for creating survey questions, but no request body, so AMCP could not build or check one. Add questions in Campaign Manager; lift tests and deleting their questions are reviewed (linkedin_lift_tests).",
  'linkedin_native_action linkedin_rest_global_publisher_list_post':
    "A read, not a write: LinkedIn's Manage Audience Restrictions page (read 2026-09-30) returns a signed URL to download the global list of Audience Network publishers (publisherListType WEB_AND_APP or CONNECTED_TELEVISION). It names no ad account, and the download is served from www.linkedin.com, a host AMCP does not call. The account's own allow and block lists are reviewed (linkedin_publisher_restrictions).",
  'linkedin_native_action linkedin_rest_ad_previews_post':
    "A preview, not a write: LinkedIn's Ad Preview page (read 2026-09-30) renders a creative that does not exist yet (action=livePreviewForCreative), named by a campaign and a post in the body. AMCP binds reads to the selected account by path or by ownership it has read, and does not yet record LinkedIn campaigns that way. Preview existing creatives with amcp_ad_previews.",
  'meta_native_action meta_ad_account_id_ad_place_page_sets_create':
    "Permanent through the API: Meta's official Business SDK for v26.0 creates an ad place page set of the ad account (name, parent_page, location_types, targeted_area_type) and reads one, with no update or deletion, so a set AMCP created could not be changed or removed.",
});
const tiktokEvidence =
  "Blocked on evidence: TikTok's documentation portal shows only its Reporting and Authentication pages without signing in (read 2026-09-29), and TikTok's official SDK gives at most this request's fields, with no response or meaning, so no review could state its effect or read it back.";
for (const action of [
  'tiktok_ad_aco_create',
  'tiktok_ad_aco_material_status_update',
  'tiktok_ad_aco_update',
  'tiktok_adgroup_appeal',
  'tiktok_business_property_add',
  'tiktok_business_property_delete',
  'tiktok_dmp_custom_audience_lookalike_update',
  'tiktok_mmm_api_create',
  'tiktok_page_library_transfer',
  'tiktok_segment_mapping',
  'tiktok_smart_plus_ad_appeal',
  'tiktok_split_test_create',
  'tiktok_split_test_end_get',
  'tiktok_split_test_promote_run',
  'tiktok_split_test_update',
  'tiktok_tcm_tt_video_apply',
  'tiktok_tt_video_authorize_apply',
  'tiktok_tt_video_unbind',
  'tiktok_video_fix_task_create',
])
  evidenceWithheld['tiktok_native_action ' + action] = tiktokEvidence;
/** The specific reason a write without a family stays blocked, when AMCP knows one. */
export function withheldWriteReason(gateway: string, action: string): string | undefined {
  return evidenceWithheld[gateway + ' ' + action];
}
/** The discovery-only program a withheld write waits on (ACC-05), by its ID; undefined for every other write. */
export function withheldWriteProgramId(gateway: string, action: string): string | undefined {
  return withheldWriteProgram(gateway, action)?.id;
}
