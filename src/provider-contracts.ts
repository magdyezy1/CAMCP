import type {JsonObject} from './types.js';
import {linkedinVersion} from './linkedin-version.js';

/** Maintained contract boundaries, not inferred from generated action counts. */
export const providerContracts:JsonObject[]=[
 ['google','google_ads','v23','google-ads','google-ads','campaigns, budgets, targeting, ads; campaign/ad-group/customer/asset-group asset links; declared labels, customizers, ad parameters, campaign groups, conversion variables, remarketing actions, signals and exclusions; qualified asset sets, complete feed membership and saved Keyword Planner hierarchies','google-legacy','https://developers.google.com/google-ads/api/docs/start'],
 ['meta','meta','v25.0','meta','meta','campaigns, ad sets, creatives, ads','meta-provision','https://developers.facebook.com/docs/marketing-apis/'],
 ['tiktok','tiktok','v1.3','tiktok-snapchat','tiktok-snapchat','campaigns, ad groups, ads','write-platforms','https://business-api.tiktok.com/portal/docs'],
 ['snapchat','snapchat','v1','tiktok-snapchat','tiktok-snapchat','campaigns, ad squads, creatives, ads; reviewed creative collection PUT and existing JSON Patch','snapchat-writes','https://developers.snap.com/marketing-api/Ads-API/introduction'],
 ['linkedin','linkedin','202605','linkedin-x','linkedin-x','campaign groups, campaigns, creatives; organization-authored non-feed single-media DSC posts with exact organization/media bindings','linkedin-posts','https://learn.microsoft.com/en-us/linkedin/marketing/'],
 ['x','x_ads','12','linkedin-x','linkedin-x','campaigns, line items, targeting; single website cards, nullcast Tweets, library registration and explicit active promotions','x-creative-writes','https://docs.x.com/x-ads-api/introduction'],
 ['microsoft','microsoft_ads','v13','microsoft-ads',null,'Search campaigns, ad groups, responsive search ads, keywords; existing extension associations at account/campaign/ad-group levels','microsoft','https://learn.microsoft.com/en-us/advertising/guides/'],
 ['apple','apple_ads','v1','dv360-and-measurement',null,'campaigns, ad groups, ads, creatives, keywords, negative keywords and shared budgets; every affected account requires a grant and policy checks','measurement-apple','https://github.com/apple/apple-ads-platform-api-node'],
 ['reddit','reddit','v3','reddit',null,'classic campaigns, ad groups, existing-post ads, saved audiences; current-account post-comment updates; lead forms only before the announced 2026-09-21 sunset','reddit-writes','https://ads-api.reddit.com/docs/v3/'],
 ['dv360','dv360','v4','dv360-and-measurement','dv360','campaigns, insertion orders, line items, creatives; advertiser-owned channel, location and negative-keyword lists with complete membership review','write-platforms','https://developers.google.com/display-video/api/reference/rest/v4'],
 ['ga4','ga4','v1beta/v1alpha','dv360-and-measurement',null,'audience exports and report tasks','ga4-campaign-report','https://developers.google.com/analytics/devguides/reporting/data/v1'],
 ['gtm','gtm','v2','dv360-and-measurement',null,'container entities and explicit publishing; scoped reverts, built-in variables, folders, pinned gallery imports, latest/undelete; complete workspace bulk edits, sync, conflict resolution and temporary preview; administrator account/permission and environment rotation workflows','measurement-apple','https://developers.google.com/tag-platform/tag-manager/api/v2'],
 ['gsc','google_search_console','v3/v1','dv360-and-measurement',null,'sitemaps; organic reporting only','measurement-apple','https://developers.google.com/webmaster-tools/v1/api_reference_index'],
 ['drive','google_drive','v3','media',null,null,'private-media','https://developers.google.com/workspace/drive/api/reference/rest/v3'],
 ['sheets','google_sheets','v4/v3','reporting-overview',null,'AMCP-owned report destinations only','report-delivery-discovery','https://developers.google.com/workspace/sheets/api/reference/rest'],
 ['amazon','amazon','catalog-dependent',null,null,null,'delegated-native','https://advertising.amazon.com/API/docs/en-us'],
 ['criteo','criteo','2026-01',null,null,null,'delegated-native','https://developers.criteo.com/retail-media/docs/overview'],
 ['adjust','adjust','catalog-dependent',null,null,null,'delegated-native','https://dev.adjust.com/en/api/'],
 ['google_business','google_business','v1',null,null,null,'delegated-native','https://developers.google.com/my-business/reference/rest'],
].map(([id,gateway,version,guide,media,writes,test,docs])=>({
 id,gateway:gateway+'_native_action',
 contract_version:({google:6,reddit:2,dv360:2,meta:2,microsoft:3,snapchat:2,linkedin:3,x:2,tiktok:2,ga4:2,gtm:4,gsc:2,apple:3} as Record<string,number>)[String(id)]??1,
 api_version:version,owner_role:'AMCP integration maintainer',
 reviewed_at:['google','apple','dv360','gtm'].includes(String(id))?'2026-09-19':['google','meta','microsoft','snapchat','linkedin','ga4','gtm','gsc','apple'].includes(String(id))?'2026-09-18':['x','tiktok'].includes(String(id))?'2026-09-14':'2026-09-12',
 documentation:docs,guide:guide?'amcp://guides/'+guide:null,
 website_connection:!!guide,discovery:guide?'implemented':'unsupported',native_reads:guide?'implemented':'partial',
 overview_reporting:['google','meta','tiktok','snapchat','linkedin','x','microsoft','apple','reddit','ga4','gsc'].includes(String(id))?'implemented':'unsupported',
 reviewed_writes:writes?'partial':'unsupported',write_scope:writes,media_import:media?'implemented':'unsupported',
 media_platform:media?({google:'google_ads',x:'x_ads'} as Record<string,string>)[String(id)]??id:null,
 tests:[...new Set(['tests/'+test+'.test.ts',...(['linkedin','tiktok'].includes(String(id))?['tests/creative-chain-audit.test.ts']:id==='x'?['tests/x-targeting-writes.test.ts']:id==='google'?['tests/google-contracts.test.ts','tests/google-asset-links.test.ts','tests/google-configuration-writes.test.ts']:id==='apple'?['tests/measurement-writes.test.ts','tests/apple-entity-writes.test.ts']:id==='reddit'?['tests/reddit-creative-writes.test.ts']:id==='dv360'?['tests/dv360-list-writes.test.ts']:id==='gtm'?['tests/measurement-writes.test.ts','tests/gtm-workflow-writes.test.ts','tests/gtm-workspace-writes.test.ts','tests/gtm-diagnostics.test.ts','tests/retired-provider-actions.test.ts']:id==='microsoft'?['tests/wsdl-model.test.mjs','tests/microsoft-associations.test.ts']:id==='meta'?['tests/meta-contracts.test.ts']:['ga4','gtm','gsc','apple'].includes(String(id))?['tests/measurement-writes.test.ts']:[])])],
 fixture_evidence:'Local fixtures validate the stated family only; inspect release test evidence.',live_qualification:'unverified',
 external_requirements:['provider account permission','configured app/identity','provider approval and quota as applicable'],
 recovery:'Read-only retries and durable local jobs; uncertain provider mutations require reconciliation with the original review.'
}));
export function effectiveProviderContract(id:string){const c=providerContracts.find(c=>c.id===id);return c?{...c,api_version:id==='linkedin'?linkedinVersion():c.api_version}:undefined;}
