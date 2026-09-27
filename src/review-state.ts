import {keywordPlanObserved} from './google-keyword-plan-writes.js';
import {sha256,stable} from './security.js';
import {MirrorError} from './errors.js';
import {microsoftContracts} from './microsoft-native.js';
import {microsoftAssociationProjection} from './microsoft-associations.js';
import {gtmSafeConfiguration} from './gtm-workflow-writes.js';
import {assetSetCanonical} from './google-asset-set-writes.js';
import {isGoogleBidRead} from './google-bid-modifiers.js';
import {isSnapchatMediaCopyRead} from './snapchat-media-copy.js';
import {isSnapDisclaimerRead} from './snapchat-offer-disclaimers.js';
import {isSnapSegmentDeleteRead} from './snapchat-segment-deletions.js';
import {isSnapConversionRead} from './snapchat-custom-conversions.js';
import {isSnapProductSetRead} from './snapchat-product-sets.js';
import {isLinkedInDomainRead} from './linkedin-insight-domains.js';
import {isSnapTemplateRead} from './snapchat-dynamic-templates.js';
import {isGoogleBrandGuidelinesRead} from './google-pmax-brand-guidelines.js';
import {isGoogleCustomerTypeRead} from './google-user-list-customer-types.js';
import {isGoogleDraftRead} from './google-campaign-drafts.js';
import {isGoogleExperimentRead} from './google-experiments.js';
import {isGoogleCustomerSettingsRead} from './google-customer-settings.js';
import {isGoogleAutoAssetRead} from './google-auto-assets.js';
import {isGoogleUploadRead} from './google-youtube-uploads.js';
import {isGoogleSubscriptionRead} from './google-recommendation-subscriptions.js';
import {isGoogleSmartRead} from './google-smart-campaign-settings.js';
import {isGoogleApplyRead} from './google-recommendation-apply.js';
import {googleSegmentResource,googleSegmentCanonical} from './google-custom-segments.js';
import {googleUserListCanonical} from './google-user-lists.js';
import {googleValueRuleCanonical} from './google-value-rules.js';
import {snapSegmentState} from './snapchat-segments.js';
import {tiktokImageInfoPath,tiktokImageState} from './tiktok-identities.js';
import {tiktokAudienceGetPath,tiktokAudienceState} from './tiktok-lookalikes.js';
import {tiktokPixelListPath,tiktokConversionListPath,tiktokConversionGetPath,tiktokPixelState,tiktokConversionListState} from './tiktok-custom-conversions.js';
import {tiktokConversionEligibility} from './tiktok-adgroup-conversions.js';
import {tiktokPortfolioGetPath,tiktokCtaPortfolioState} from './tiktok-cta-portfolios.js';
import {tiktokSmartPlusAdState} from './tiktok-smart-plus-ads.js';
import {tiktokSmartPlusAdgroupCampaignState} from './tiktok-smart-plus-adgroup-updates.js';
import {tiktokInstantFormState} from './tiktok-instant-forms.js';
import {isGoogleListingGroupRead,googleListingGroupState} from './google-listing-groups.js';
import {isTiktokBrandSafetyRead,tiktokBrandSafetyState} from './tiktok-brand-safety.js';
import {isMetaValueRuleRead,metaValueRuleState} from './meta-value-rules.js';
import {isMetaObjectRead} from './meta-object-edits.js';
import {isMetaImageRead} from './meta-ad-images.js';
import {isMetaConversionRead} from './meta-custom-conversions.js';
import {isMetaBrandSafetyRead,metaBrandSafetyState} from './meta-brand-safety.js';
import {isCriteoLineItemRead,criteoLineItemReviewState} from './criteo-auction-line-items.js';
import {isCriteoOverrideRead} from './criteo-budget-overrides.js';
import {isCriteoPreferredRead} from './criteo-preferred-line-items.js';
import {isCriteoCatalogRead} from './criteo-catalog-requests.js';
import {isCriteoSegmentRead} from './criteo-audience-segments.js';
import {isDV360AdGroupRead,dv360AdGroupReviewState} from './dv360-demand-gen-ad-groups.js';
import {isDV360AdAssetRead,dv360AdAssetReviewState} from './dv360-ad-assets.js';
import {isDV360AdRead,dv360AdReviewState} from './dv360-demand-gen-ads.js';
import {isDV360LineItemBulkRead} from './dv360-line-item-bulk-update.js';
import {isLinkedInThirdPartyRead} from './linkedin-third-party-tracking.js';
import {isLinkedInInsightRead} from './linkedin-insight-tags.js';
import {isLinkedInAbRead} from './linkedin-ab-tests.js';
import {isLinkedInMessageRead} from './linkedin-message-ads.js';
import {isDV360LineItemDuplicateRead} from './dv360-line-item-duplicate.js';
import {isDV360InventoryGroupRead} from './dv360-inventory-source-groups.js';
import {isDV360AdvertiserRead} from './dv360-advertiser-settings.js';
import {isDV360BiddingRead} from './dv360-custom-bidding.js';
import {isDV360SdfRead} from './dv360-sdf-downloads.js';
import {isXTrackingTagRead} from './x-tracking-tags.js';
import {isXPrerollCtaRead} from './x-preroll-ctas.js';
import {isXMediaRead} from './x-media-library.js';
import {isXScheduledRead} from './x-scheduled-tweets.js';
import {isXAudienceRead} from './x-custom-audiences.js';
import {isXAssociationRead} from './x-line-item-associations.js';
import {isXCuratedRead} from './x-curated-categories.js';
import {isDV360AudienceStateRead,dv360AudienceReviewState} from './dv360-line-item-targeting.js';
import type {CompiledRequest,JsonObject} from './types.js';

// Response envelopes are validated before projection. Within each resource keep
// unknown fields: a new configuration field must remain protected by default.
const volatile = new Set([
 'delivery_status','effective_status','secondary_status','updated_at','updated_time','last_modified_time',
 'last_modified_at','last_modified','update_time','modification_time','modify_time','modified_at','modified_time','last_updated_at','last_update_time',
 'request_id','request_time','trace_id','sub_request_status','request_status',
 'stats','statistics','metrics','insights','reporting','pacing_stats','pacing_metrics','total_stats','timeseries_stats',
 'delivery_metrics','delivery_stats','delivery_pacing','spend_to_date','last_synced_at'
]);
const fieldName=(key:string)=>key.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase();
const scalar=(value:unknown)=>value===null||['string','number','boolean'].includes(typeof value);
// Only fields whose provider contracts define membership, rather than sequence.
// Unknown scalar arrays stay ordered until a contract explicitly qualifies them.
const unorderedFields=new Set(['country_codes','countries','genders','age_groups','age_ranges','locales','device_platforms','publisher_platforms','facebook_positions','instagram_positions','messenger_positions','audience_network_positions','placements','included_languages','excluded_languages']);

/** Configuration projection only; never use this to canonicalize a mutation payload. */
export function normalizeReviewState(value:unknown,key=''):unknown {
 if(Array.isArray(value)){
  const values=value.map(item=>normalizeReviewState(item));
  // Preserve duplicates and types. Arrays of objects may have meaningful order.
  return unorderedFields.has(fieldName(key))&&values.every(scalar)?values.sort((a,b)=>{const x=stable(a),y=stable(b);return x<y?-1:x>y?1:0;}):values;
 }
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
  .filter(([key])=>!volatile.has(fieldName(key))).sort(([a],[b])=>a<b?-1:a>b?1:0)
  .map(([key,item])=>[key,normalizeReviewState(item,key)]));
 return value;
}
/** Allowlist configuration-bearing response containers, not response metadata.
 * Only call after raw success, completeness and exact-target validation. Preserve
 * the native container shape for spending/ownership checks and field diagnostics.
 * Flat resource responses have no separate envelope: keep unknown configuration.
 * This is idempotent so saved, unsubmitted reviews can use the same projection. */
export function normalizeSnapshot(read:CompiledRequest,data:unknown):unknown{
 if(!data||Array.isArray(data)||typeof data!=='object')return normalizeReviewState(data);
 const d=data as JsonObject;
 if(isGoogleBidRead(read))return normalizeReviewState(data);
 if(isSnapchatMediaCopyRead(read))return normalizeReviewState(data);
 if(isSnapDisclaimerRead(read))return normalizeReviewState(data);
 if(isSnapSegmentDeleteRead(read))return normalizeReviewState(data);
 if(isSnapConversionRead(read))return normalizeReviewState(data);
 if(isSnapProductSetRead(read))return normalizeReviewState(data);
 if(isLinkedInDomainRead(read))return normalizeReviewState(data);
 if(isSnapTemplateRead(read))return normalizeReviewState(data);
 if(isGoogleBrandGuidelinesRead(read))return normalizeReviewState(data);
 if(isGoogleCustomerTypeRead(read))return normalizeReviewState(data);
 if(isGoogleDraftRead(read))return normalizeReviewState(data);
 if(isGoogleExperimentRead(read))return normalizeReviewState(data);
 if(isGoogleCustomerSettingsRead(read)||isGoogleAutoAssetRead(read)||isGoogleUploadRead(read)||isGoogleSubscriptionRead(read)||isGoogleSmartRead(read)||isGoogleApplyRead(read))return normalizeReviewState(data);
 if(isGoogleListingGroupRead(read))return normalizeReviewState(googleListingGroupState(read,d));
 if(isTiktokBrandSafetyRead(read))return normalizeReviewState(tiktokBrandSafetyState(read,d));
 if(isMetaValueRuleRead(read))return normalizeReviewState(metaValueRuleState(d));
 if(isMetaObjectRead(read))return normalizeReviewState(d);
 if(isMetaImageRead(read))return normalizeReviewState(d);
 if(isMetaConversionRead(read))return normalizeReviewState(d);
 if(isMetaBrandSafetyRead(read))return normalizeReviewState(metaBrandSafetyState(read,d));
 if(isCriteoLineItemRead(read))return normalizeReviewState(criteoLineItemReviewState(d));
 if(isCriteoOverrideRead(read))return normalizeReviewState(d);
 if(isCriteoPreferredRead(read))return normalizeReviewState(d);
 if(isCriteoCatalogRead(read))return normalizeReviewState(d);
 if(isCriteoSegmentRead(read))return normalizeReviewState(d);
 if(isDV360AdGroupRead(read))return normalizeReviewState(dv360AdGroupReviewState(d));
 if(isDV360AdAssetRead(read))return normalizeReviewState(dv360AdAssetReviewState(read,d));
 if(isDV360AdRead(read))return normalizeReviewState(dv360AdReviewState(d));
 if(isDV360LineItemBulkRead(read))return normalizeReviewState(d);
 if(isLinkedInThirdPartyRead(read))return normalizeReviewState(d);
 if(isLinkedInInsightRead(read))return normalizeReviewState(d);
 if(isLinkedInAbRead(read))return normalizeReviewState(d);
 if(isLinkedInMessageRead(read))return normalizeReviewState(d);
 if(isDV360LineItemDuplicateRead(read))return normalizeReviewState(d);
 if(isDV360InventoryGroupRead(read))return normalizeReviewState(d);
 if(isDV360AdvertiserRead(read))return normalizeReviewState(d);
 if(isDV360BiddingRead(read))return normalizeReviewState(d);
 if(isDV360SdfRead(read))return normalizeReviewState(d);
 if(isXTrackingTagRead(read))return normalizeReviewState(d);
 if(isXPrerollCtaRead(read))return normalizeReviewState(d);
 if(isXMediaRead(read))return normalizeReviewState(d);
 if(isXScheduledRead(read))return normalizeReviewState(d);
 if(isXAudienceRead(read))return normalizeReviewState(d);
 if(isXAssociationRead(read))return normalizeReviewState(d);
 if(isXCuratedRead(read))return normalizeReviewState(d);
 if(isDV360AudienceStateRead(read))return normalizeReviewState(dv360AudienceReviewState(read,d));
 if(read.gateway==='gtm_native_action')return normalizeReviewState(gtmSafeConfiguration(data));
 if(read.gateway==='tiktok_native_action'&&read.path===tiktokPixelListPath&&Array.isArray(d.data?.pixels))return normalizeReviewState({data:tiktokPixelState(d)});
 if(read.gateway==='tiktok_native_action'){const state=tiktokSmartPlusAdState(read,d)??tiktokSmartPlusAdgroupCampaignState(read,d)??tiktokInstantFormState(read,d);if(state)return normalizeReviewState(state);}
 if(read.gateway==='tiktok_native_action'&&read.path===tiktokPortfolioGetPath&&d.data&&typeof d.data==='object'&&!Array.isArray(d.data))return normalizeReviewState({data:tiktokCtaPortfolioState(read,d.data)});
 if(read.gateway==='tiktok_native_action'&&read.path===tiktokConversionGetPath&&d.data&&typeof d.data==='object'&&!Array.isArray(d.data))return normalizeReviewState({data:tiktokConversionEligibility(d.data)});
 if(read.gateway==='tiktok_native_action'&&Array.isArray(d.data?.list))return normalizeReviewState({data:read.path===tiktokImageInfoPath?tiktokImageState(d):read.path===tiktokAudienceGetPath?tiktokAudienceState(d):read.path===tiktokConversionListPath?tiktokConversionListState(d):{list:d.data.list}});
 if(['x_ads_native_action','reddit_native_action'].includes(read.gateway)&&Object.hasOwn(d,'data'))return normalizeReviewState({data:d.data});
 if(read.gateway==='apple_ads_native_action'&&Object.hasOwn(d,'result')){
  // SDK output-only processing/approval observations are not advertiser edits.
  const observational=new Set(['systemStatus','systemStatusReasons','systemStatusLimitingReasons','displayStatus','eligibility']);
  const result=Object.fromEntries(Object.entries(d.result??{}).filter(([key])=>!observational.has(key)));
  if(Array.isArray(result.adAccountIds))result.adAccountIds=[...result.adAccountIds].sort((a,b)=>String(a).localeCompare(String(b),'en'));
  return normalizeReviewState({result});
 }
 if(read.gateway==='microsoft_ads_native_action'){
  if(read.action==='GetAdExtensionsAssociations')return normalizeReviewState(microsoftAssociationProjection(read,d));
  const field=microsoftContracts.get(read.action)?.result;
  if(field&&Object.hasOwn(d,field))return normalizeReviewState({[field]:d[field]});
 }
 if(read.gateway==='snapchat_native_action'){
  const kind=read.path.split('/').at(-2)!,singular=kind==='adsquads'?'adsquad':kind==='media'?'media':kind.slice(0,-1);
  if(Array.isArray(d[kind]))return normalizeReviewState({[kind]:d[kind].map((row:JsonObject)=>Object.hasOwn(row,singular)?{[singular]:kind==='segments'?snapSegmentState(row[singular]):row[singular]}:row)});
 }
 if(read.gateway==='google_search_console_native_action'&&read.path.includes('/sitemaps/')&&d.amcp_absent!==true){
  // Crawl/processing observations are not a sitemap submission change. Keep
  // lastSubmitted, type, path, index identity and unknown configuration fields.
  const processing=new Set(['lastDownloaded','isPending','warnings','errors','contents']);
  return normalizeReviewState(Object.fromEntries(Object.entries(d).filter(([key])=>!processing.has(key))));
 }
 if(read.gateway!=='google_ads_native_action')return normalizeReviewState(data);
 const query=String((read.body as JsonObject)?.query??''),resource=/\bFROM\s+([a-z_]+)/i.exec(query)?.[1];
 const rows=d.results??(read.googleState?.allowMissing?[]:undefined);if(!Array.isArray(rows))return normalizeReviewState(data);
 // Even customer reads without resource_name must exclude query cost, field
 // masks, summary metrics and future envelope metadata. Never ignore a nonempty
 // nextPageToken here instead of rejecting the incomplete raw response first.
 if(!resource||!query.includes(resource+'.resource_name'))return normalizeReviewState({results:rows});
 const key=resource.replace(/_([a-z])/g,(_m,c)=>c.toUpperCase()),seen=new Set<string>();
 const items=rows.map((row:JsonObject)=>{const value=row[resource]??row[key],id=value?.resourceName??value?.resource_name;if(typeof id!=='string'||!id||seen.has(id))throw new MirrorError('STATE_RESOURCE_INVALID','The state response contains missing or duplicate resource identities.',{},502);seen.add(id);return {id,row};});
 const expected=[...new Set([...query.matchAll(/'(customers\/[^']+)'/g)].map(m=>m[1]!))];
 if(expected.length&&(read.googleState?.allowMissing?items.some(item=>!expected.includes(item.id)):expected.length!==seen.size||expected.some(id=>!seen.has(id))))throw new MirrorError('STATE_RESOURCE_MISMATCH','The state response does not cover exactly the requested resources.',{},409);
 items.sort((a,b)=>a.id.localeCompare(b.id,'en'));
 const state={results:items.map(item=>resource.startsWith('keyword_plan')?{...item.row,[key]:keywordPlanObserved(resource,item.row[key])}:googleSegmentResource(resource)?{...item.row,[item.row[resource]?resource:key]:googleSegmentCanonical(resource,item.row[resource]??item.row[key],true)}:resource==='user_list'?{...item.row,[item.row[resource]?resource:key]:googleUserListCanonical(item.row[resource]??item.row[key])}:resource==='conversion_value_rule'?{...item.row,[item.row[resource]?resource:key]:googleValueRuleCanonical(resource,item.row[resource]??item.row[key])}:item.row)};
 return normalizeReviewState(['asset','asset_set','asset_set_asset','campaign_asset_set','ad_group_asset_set','customer_asset_set'].includes(resource)?assetSetCanonical(state):state);
}
export const reviewStateHash=(value:unknown)=>sha256(stable(normalizeReviewState(value)));

/** JSON paths only: diagnostics must not disclose provider values or credentials. */
export function changedStateFields(expected:unknown,actual:unknown):string[]{
 const paths:string[]=[];
 const walk=(a:unknown,b:unknown,path:string)=>{
  if(stable(a)===stable(b))return;
  if(Array.isArray(a)&&Array.isArray(b)){
   for(let i=0;i<Math.max(a.length,b.length);i++){const child=path+'['+i+']';if(i>=a.length||i>=b.length)paths.push(child);else walk(a[i],b[i],child);}return;
  }
  if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b)){
   for(const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()){const child=path+'['+JSON.stringify(key)+']';if(!Object.hasOwn(a,key)||!Object.hasOwn(b,key))paths.push(child);else walk((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key],child);}return;
  }
  paths.push(path);
 };
 walk(normalizeReviewState(expected),normalizeReviewState(actual),'$');return paths;
}
