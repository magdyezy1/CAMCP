import type {CompiledRequest} from './types.js';

// Read-only metadata is a compatibility observation, never sufficient execution
// authorization. POST reads must match a separately maintained route allowlist.
const googleReadMethods=new Set(['search','searchStream','suggest','generateAudienceCompositionInsights','generateAudienceDefinition','generateAudienceOverlapInsights','generateInsightsFinderReport','generateSuggestedTargetingInsights','generateTargetingSuggestionMetrics','searchAudienceInsightsAttributes','listInsightsEligibleDates','generateBenchmarksMetrics','listBenchmarksAvailableDates','listBenchmarksLocations','listBenchmarksProducts','listBenchmarksSources','suggestBrands','generateCreatorInsights','generateTrendingInsights','generateAdGroupThemes','generateKeywordForecastMetrics','generateKeywordHistoricalMetrics','generateKeywordIdeas','generateConversionRates','generateReachForecast','listPlannableLocations','listPlannableProducts','listPlannableUserInterests','listPlannableUserLists','quoteCampaigns','suggestKeywordThemes','suggestSmartCampaignAd','suggestSmartCampaignBudgetOptions','suggestTravelAssets']);
const tiktokReads=new Set(['/v1.3/ad/audience_size/estimate/','/v1.3/audience/insight/info/','/v1.3/tool/bid/recommend/','/v1.3/tool/targeting/info/','/v1.3/tool/targeting/search/','/v1.3/tool/targeting_category/recommend/','/v1.3/business/message/auto_message/get/','/v1.3/business/message/media/download/','/v1.3/gmv_max/creation/custom_anchor_video_list/get/']);
export function independentlyReadOnly(plan:CompiledRequest):boolean{
 if(!plan.readOnly)return false;
 let pathname:string;try{pathname=decodeURIComponent(plan.path);}catch{return false;}
 // Search Console encodes full property/sitemap URLs as resource segments.
 // Their escaped query delimiters and path words are identifiers, not HTTP
 // method overrides. Only documented fixed route structures receive this rule.
 if(plan.gateway==='google_search_console_native_action'&&/^\/webmasters\/v3\/sites\/[^/?#\r\n\\]+(?:\/sitemaps(?:\/[^/?#\r\n\\]+)?|\/searchAnalytics\/query)?$/.test(plan.path))pathname=plan.path.replace(/^(\/webmasters\/v3\/sites\/)[^/]+/,'$1PROPERTY').replace(/(\/sitemaps\/)[^/]+$/,'$1SITEMAP');
 if(/[?#\r\n\\]/.test(pathname))return false;
 const tokens=pathname.replace(/([a-z])([A-Z])/g,'$1_$2').toLowerCase().split(/[\/_:.-]+/);
 if(tokens.some(t=>['update','delete','remove','mutate','activate','deactivate','publish','unpublish','revoke','authorize','authorization','verify','create','insert','patch','set','upload','submit','send'].includes(t)))return false;
 const queryAndBody=[plan.query,plan.body];
 for(const bag of queryAndBody)if(bag&&typeof bag==='object'&&!Array.isArray(bag))for(const [key,v]of Object.entries(bag)){
  if(['method','_method','http_method','method_override'].includes(key)&&!['GET','HEAD'].includes(String(v).toUpperCase()))return false;
  if(plan.gateway==='meta_native_action'&&key==='batch')return false;
 }
 const override=plan.headers['X-HTTP-Method-Override'];if(override&&!['GET','HEAD'].includes(override.toUpperCase()))return false;
 const restli=plan.headers['X-RestLi-Method'];if(restli&&!['GET','BATCH_GET','FINDER','GET_ALL'].includes(restli.toUpperCase()))return false;
 const method=override??plan.method;if(['GET','HEAD'].includes(method))return true;
 if(method!=='POST')return false;
 switch(plan.gateway){
  case 'google_ads_native_action':return /^\/v23\//.test(pathname)&&googleReadMethods.has(pathname.split(':').at(-1)!);
  case 'tiktok_native_action':return tiktokReads.has(pathname.replace(/^\/open_api/,''));
  case 'snapchat_native_action':return /^\/v1\/adaccounts\/[^/]+\/(?:get_(?:campaigns|adsquads|ads|creatives|media)_by_ids|ad_squad_outcome_estimates_v2|audience_size(?:_v2)?|bid_estimate)$/.test(pathname)||/^\/v1\/(?:catalogs\/[^/]+\/(?:product_search|products\/search|flights\/search|hotels\/search|facets)|ads_library\/(?:ads|sponsored_content)\/search)$/.test(pathname);
  case 'ga4_native_action':return /\/properties\/[^/:]+:(?:runReport|batchRunReports|runPivotReport|batchRunPivotReports|runRealtimeReport|checkCompatibility|runFunnelReport)$/.test(pathname)||/\/audienceExports\/[^/:]+:query$/.test(pathname);
  case 'gtm_native_action':return /\/folders\/[^/:]+:entities$/.test(pathname);
  case 'google_search_console_native_action':return /\/searchAnalytics\/query$/.test(pathname)||pathname==='/v1/urlInspection/index:inspect';
  case 'criteo_native_action':return /\/(?:search|preview)$/.test(pathname);
  case 'reddit_native_action':return /^\/api\/v3\/ad_accounts\/[^/]+\/reports$/.test(pathname);
  case 'apple_ads_native_action':return plan.origin==='https://api.ads.apple.com'&&/^\/v1\/(?:campaigns|adgroups|ads|creatives|keywords|negative-keywords|shared-budgets|reports\/apps\/(?:campaigns|adgroups|ads|keywords|searchterms))\/query$/.test(pathname);
  default:return false;
 }
}
export function applyExecutionRisk(plan:CompiledRequest):CompiledRequest{
 const readOnly=independentlyReadOnly(plan);
 return {...plan,readOnly,requiresConfirmation:plan.requiresConfirmation||!readOnly,warnings:plan.readOnly&&!readOnly?[...plan.warnings,'Catalog read-only metadata is not sufficient for this route; execution is treated as a mutation or an unqualified operation.']:plan.warnings};
}
