import type {JsonObject} from './types.js';

/** Maintained contract boundaries, not inferred from generated action counts. */
export const providerContracts:JsonObject[]=[
 ['google','google_ads','v23','google-ads','google-ads','campaigns, budgets, targeting, ads','google-legacy','https://developers.google.com/google-ads/api/docs/start'],
 ['meta','meta','v25.0','meta','meta','campaigns, ad sets, creatives, ads','meta-provision','https://developers.facebook.com/docs/marketing-apis/'],
 ['tiktok','tiktok','v1.3','tiktok-snapchat','tiktok-snapchat','campaigns, ad groups, ads','write-platforms','https://business-api.tiktok.com/portal/docs'],
 ['snapchat','snapchat','v1','tiktok-snapchat','tiktok-snapchat','campaigns, ad squads, creatives, ads','review-state','https://developers.snap.com/api/marketing-api/Ads-API/introduction'],
 ['linkedin','linkedin','202605','linkedin-x','linkedin-x','campaign groups, campaigns, creatives','write-platforms','https://learn.microsoft.com/en-us/linkedin/marketing/'],
 ['x','x_ads','12','linkedin-x','linkedin-x','campaigns, line items, promoted content and targeting','x-targeting-writes','https://docs.x.com/x-ads-api/introduction'],
 ['microsoft','microsoft_ads','v13','microsoft-ads',null,'Search campaigns, ad groups, responsive search ads, keywords','microsoft','https://learn.microsoft.com/en-us/advertising/guides/'],
 ['apple','apple_ads','v1','dv360-and-measurement',null,'campaigns only; child writes unsupported','measurement-apple','https://github.com/apple/apple-ads-platform-api-node'],
 ['reddit','reddit','v3','reddit',null,'classic campaigns, ad groups, existing-post ads, saved audiences','reddit-writes','https://ads-api.reddit.com/docs/v3/'],
 ['dv360','dv360','v4','dv360-and-measurement','dv360','campaigns, insertion orders, line items, creatives','write-platforms','https://developers.google.com/display-video/api/reference/rest/v4'],
 ['ga4','ga4','v1beta/v1alpha','dv360-and-measurement',null,'audience exports and report tasks','ga4-campaign-report','https://developers.google.com/analytics/devguides/reporting/data/v1'],
 ['gtm','gtm','v2','dv360-and-measurement',null,'container entities and explicit version publishing','measurement-apple','https://developers.google.com/tag-platform/tag-manager/api/v2'],
 ['gsc','google_search_console','v3/v1','dv360-and-measurement',null,'sitemaps; organic reporting only','measurement-apple','https://developers.google.com/webmaster-tools/v1/api_reference_index'],
 ['drive','google_drive','v3','media',null,null,'private-media','https://developers.google.com/workspace/drive/api/reference/rest/v3'],
 ['sheets','google_sheets','v4/v3','reporting-overview',null,'AMCP-owned report destinations only','report-delivery-discovery','https://developers.google.com/workspace/sheets/api/reference/rest'],
 ['amazon','amazon','catalog-dependent',null,null,null,'delegated-native','https://advertising.amazon.com/API/docs/en-us'],
 ['criteo','criteo','2026-01',null,null,null,'delegated-native','https://developers.criteo.com/retail-media/docs/overview'],
 ['adjust','adjust','catalog-dependent',null,null,null,'delegated-native','https://dev.adjust.com/en/api/'],
 ['google_business','google_business','v1',null,null,null,'delegated-native','https://developers.google.com/my-business/reference/rest'],
].map(([id,gateway,version,guide,media,writes,test,docs])=>({id,gateway:gateway+'_native_action',contract_version:1,api_version:version,owner_role:'AMCP integration maintainer',reviewed_at:'2026-09-12',documentation:docs,guide:guide?'amcp://guides/'+guide:null,website_connection:!!guide,discovery:guide?'implemented':'unsupported',native_reads:guide?'implemented':'partial',overview_reporting:['google','meta','tiktok','snapchat','linkedin','x','microsoft','apple','reddit','ga4','gsc'].includes(String(id))?'implemented':'unsupported',reviewed_writes:writes?'partial':'unsupported',write_scope:writes,media_import:media?'implemented':'unsupported',media_platform:media?({google:'google_ads',x:'x_ads'} as Record<string,string>)[String(id)]??id:null,tests:['tests/'+test+'.test.ts'],fixture_evidence:'Local fixtures validate the stated family only; inspect release test evidence.',live_qualification:'unverified',external_requirements:['provider account permission','configured app/identity','provider approval and quota as applicable'],recovery:'Read-only retries and durable local jobs; uncertain provider mutations require reconciliation with the original review.'}));
export function effectiveProviderContract(id:string){const c=providerContracts.find(c=>c.id===id);return c?{...c,api_version:id==='linkedin'?process.env.AMCP_LINKEDIN_API_VERSION??c.api_version:c.api_version}:undefined;}
