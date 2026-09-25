import {snapUpdateKind} from './snapchat-nested-updates.js';
import {xReportKind} from './x-report-jobs.js';
import {googlePreviewKind} from './google-preview-writes.js';
import {criteoCampaignKind} from './criteo-campaign-writes.js';
import {metaReportKind} from './meta-insights-jobs.js';
import {tiktokReportKind} from './tiktok-report-jobs.js';
import {criteoReportKind} from './criteo-report-jobs.js';
import {placeActionKind} from './google-place-action-links.js';
import {businessNotificationKind} from './google-business-notifications.js';
import {businessAccessKind} from './google-business-access.js';
import {googleDismissalKind} from './google-recommendation-dismissal.js';
import {googleAccessKind} from './google-user-access.js';
import {redditCreativeKind} from './reddit-creative-writes.js';
import {linkedinConversionKind} from './linkedin-conversion-links.js';
import {linkedinTemplateKind} from './linkedin-audience-templates.js';
import {linkedinRuleKind} from './linkedin-conversion-rules.js';
import {criteoTargetingKind} from './criteo-targeting-writes.js';
import {metaLabelKind} from './meta-label-writes.js';
import {googleBidKind} from './google-bid-modifiers.js';
import {googleConversionGoalKind} from './google-conversion-goals.js';
import {googleBiddingEventKind} from './google-bidding-events.js';
import {googlePortfolioKind} from './google-portfolio-strategies.js';
import {googleConversionActionKind} from './google-conversion-actions.js';
import type {CompiledRequest} from './types.js';
import {appleEntityKind} from './apple-entity-writes.js';
import {dv360ListKind} from './dv360-list-writes.js';
import {googleTargetingKind} from './google-targeting-writes.js';
import {googleAssetLinkKind} from './google-asset-links.js';
import {googleConfigurationKind} from './google-configuration-writes.js';
import {xCreativeKind} from './x-creative-writes.js';
import {xDraftKind} from './x-draft-writes.js';
import {xTargetingBatchRoute} from './x-targeting-batch.js';
import {linkedinDSC} from './linkedin-posts.js';
import {redditWriteKind} from './reddit-writes.js';
import {microsoftContracts,microsoftGateway} from './microsoft-native.js';
import {microsoftAssociationWrite} from './microsoft-associations.js';
import {gtmWriteActions} from './measurement-writes.js';
import {gtmWorkflowKind} from './gtm-workflow-writes.js';
import {gtmWorkspaceKind} from './gtm-workspace-writes.js';

/** Route membership only. This never substitutes for assertWriteShape, scope,
 * prerequisites, spend policies, frozen review, provider receipts or read-back.
 * Both execution and the complete action ledger use this same declaration. */
export function reviewedWriteFamily(p:CompiledRequest):string|undefined{
 const route=p.path,method=p.method,action=p.action.split('/').at(-1)!;
 if(p.readOnly||p.specialTransport)return;
 if(xTargetingBatchRoute(p))return 'x_targeting_batch';
 if(xReportKind(p))return 'x_report_jobs';
 if(snapUpdateKind(p))return 'snapchat_nested_updates';
 if(googlePreviewKind(p))return 'google_shareable_previews';
 if(placeActionKind(p))return 'google_place_actions';
 if(businessNotificationKind(p))return 'google_business_notifications';
 if(businessAccessKind(p))return 'google_business_access';
 if(googleDismissalKind(p))return 'google_recommendation_dismissal';
 if(googleAccessKind(p))return 'google_user_access';
 if(linkedinTemplateKind(p))return 'linkedin_audience_templates';
 if(linkedinConversionKind(p))return 'linkedin_conversion_links';
 if(linkedinRuleKind(p))return 'linkedin_conversion_rules';
 if(metaReportKind(p))return 'meta_insights_jobs';
 if(criteoCampaignKind(p))return 'criteo_campaigns';
 if(tiktokReportKind(p))return 'tiktok_report_jobs';
 if(criteoReportKind(p))return 'criteo_report_jobs';
 if(metaLabelKind(p))return 'meta_labels';
 if(googleBidKind(p))return 'google_bid_modifiers';
 if(googleBiddingEventKind(p))return 'google_bidding_events';
 if(googlePortfolioKind(p))return 'google_portfolio_strategies';
 if(googleConversionActionKind(p))return 'google_conversion_actions';
 if(googleConversionGoalKind(p))return 'google_conversion_goals';
 if(criteoTargetingKind(p))return 'criteo_targeting';
 if(gtmWorkflowKind(p))return 'gtm_workflows';
 if(gtmWorkspaceKind(p))return 'gtm_workspace';
 if(p.gateway===microsoftGateway){const c=microsoftContracts.get(p.action);return c&&c.path===route&&c.method===method?(microsoftAssociationWrite(p)?'microsoft_asset_links':/^(Add|Update|Delete)/.test(c.name)?'microsoft_search':undefined):undefined;}
 if(p.gateway==='reddit_native_action')return redditCreativeKind(p)?'reddit_creatives':redditWriteKind(p)?'reddit_classic':undefined;
 if(linkedinDSC(p))return 'linkedin_dsc';
 if(appleEntityKind(p))return 'apple_entities';
 if(dv360ListKind(p))return 'dv360_lists';
 if(p.gateway==='apple_ads_native_action')return p.origin==='https://api.ads.apple.com'&&['apple_ads_v1_campaign_create','apple_ads_v1_campaign_update','apple_ads_v1_campaign_delete'].includes(action)&&(method==='POST'&&route==='/v1/campaigns'||['PUT','DELETE'].includes(method)&&/^\/v1\/campaigns\/\d+$/.test(route))?'apple_campaigns':undefined;
 if(p.gateway==='ga4_native_action')return p.origin==='https://analyticsdata.googleapis.com'&&method==='POST'&&['ga4_create_audience_export','ga4_create_report_task'].includes(p.action)&&/^\/v1(?:alpha|beta)\/properties\/\d+\/(audienceExports|reportTasks)$/.test(route)?'ga4_export_jobs':undefined;
 if(p.gateway==='gtm_native_action')return p.origin==='https://tagmanager.googleapis.com'&&gtmWriteActions.has(action)&&/^\/tagmanager\/v2\/accounts\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*(?::create_version|:publish)?$/.test(route)?'gtm_entities':undefined;
 if(p.gateway==='google_search_console_native_action')return ['https://www.googleapis.com','https://searchconsole.googleapis.com'].includes(p.origin!)&&['ADD_SITE','DELETE_SITE','SUBMIT_SITEMAP','DELETE_SITEMAP'].includes(action)&&['PUT','DELETE'].includes(method)&&/^\/webmasters\/v3\/sites\/[^/]+(?:\/sitemaps\/[^/]+)?$/.test(route)?'search_console_sites':undefined;
 if(p.gateway==='google_ads_native_action'){
  if(googleConfigurationKind(p))return 'google_configuration';
  if(googleAssetLinkKind(p))return 'google_asset_links';
  if(googleTargetingKind(p))return 'google_targeting';
  return method==='POST'&&/^\/v23\/customers\/[^/]+\/(campaigns|adGroups|adGroupAds|campaignBudgets|ads|assetGroups|assets):mutate$/.test(route)?'google_entities':undefined;
 }
 if(p.gateway==='meta_native_action')return method==='POST'&&/^\/v[^/]+\/act_[^/]+\/(campaigns|adsets|ads|adcreatives)$/.test(route)||['POST','DELETE'].includes(method)&&/^meta_(campaign_id|ad_set_id|ad_id)_(update|delete)$/.test(p.action)?'meta_entities':undefined;
 if(p.gateway==='snapchat_native_action')return method==='POST'&&/^\/v1\/(adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives)|campaigns\/[^/]+\/adsquads|adsquads\/[^/]+\/ads)$/.test(route)||method==='PUT'&&/^\/v1\/adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives)$/.test(route)||method==='PATCH'&&/^\/v1\/adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives)\/[^/]+$/.test(route)||method==='DELETE'&&/^\/v1\/(campaigns|adsquads|ads)\/[^/]+$/.test(route)?'snapchat_entities':undefined;
 if(p.gateway==='tiktok_native_action')return method==='POST'&&/^\/v1\.3\/(campaign|adgroup|ad)\/(?:status\/)?(create|update|delete)\/$/.test(route)?'tiktok_entities':undefined;
 if(p.gateway==='x_ads_native_action'){
  if(xDraftKind(p))return 'x_drafts';
  if(xCreativeKind(p))return 'x_creatives';
  return method==='POST'&&/^\/12\/accounts\/[^/]+\/(campaigns|line_items|targeting_criteria)$/.test(route)||['PUT','DELETE'].includes(method)&&/^\/12\/accounts\/[^/]+\/(campaigns|line_items)\/[^/]+$/.test(route)||method==='DELETE'&&/^\/12\/accounts\/[^/]+\/(targeting_criteria|promoted_tweets)\/[^/]+$/.test(route)?'x_entities':undefined;
 }
 if(p.gateway==='linkedin_native_action')return method==='POST'&&/^\/rest\/adAccounts\/[^/]+\/(adCampaigns|adCampaignGroups|creatives)$/.test(route)||['POST','PUT','PATCH','DELETE'].includes(method)&&/^\/rest\/adAccounts\/[^/]+\/(adCampaigns|adCampaignGroups|creatives)\/[^/]+$/.test(route)?'linkedin_entities':undefined;
 if(p.gateway==='dv360_native_action')return method==='POST'&&/^\/v\d+\/advertisers\/[^/]+\/(campaigns|insertionOrders|lineItems|creatives)$/.test(route)||['PATCH','DELETE'].includes(method)&&/^\/v\d+\/advertisers\/[^/]+\/(campaigns|insertionOrders|lineItems|creatives)\/[^/]+$/.test(route)?'dv360_entities':undefined;
}
