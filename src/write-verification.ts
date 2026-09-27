import {snapUpdateKind,verifySnapUpdate} from './snapchat-nested-updates.js';
import {snapchatMediaCopyKind,snapchatMediaCopyVerification,isSnapchatMediaCopyCheck,snapchatMediaCopyObserved,readSnapchatMediaCopy} from './snapchat-media-copy.js';
import {snapLeadFormProjection} from './snapchat-lead-forms.js';
import {snapSegmentProjection} from './snapchat-segments.js';
import {tiktokIdentityKind,tiktokIdentityVerification} from './tiktok-identities.js';
import {metaCopyKind,metaCopyVerification} from './meta-copies.js';
import {tiktokLookalikeKind,tiktokLookalikeVerification,tiktokAudienceGetPath} from './tiktok-lookalikes.js';
import {metaLookalikeKind,metaLookalikeVerification,metaLookalikeRead,metaLookalikeProjection} from './meta-lookalikes.js';
import {tiktokBudgetKind,tiktokBudgetVerification} from './tiktok-budgets.js';
import {tiktokCustomConversionKind,tiktokCustomConversionVerification,tiktokConversionGetPath,tiktokCustomConversionProjection} from './tiktok-custom-conversions.js';
import {tiktokSavedAudienceKind,tiktokSavedAudienceVerification,tiktokSavedAudienceRead,tiktokSavedAudienceProjection} from './tiktok-saved-audiences.js';
import {tiktokSmartPlusStatusKind,tiktokSmartPlusStatusVerification} from './tiktok-smart-plus-status.js';
import {tiktokSmartPlusBudgetKind,tiktokSmartPlusBudgetVerification} from './tiktok-smart-plus-budgets.js';
import {tiktokSmartPlusCampaignKind,tiktokSmartPlusCampaignVerification,tiktokSmartPlusCampaignProjection} from './tiktok-smart-plus-campaigns.js';
import {tiktokSmartPlusAdgroupKind,tiktokSmartPlusAdgroupVerification,tiktokSmartPlusAdgroupProjection} from './tiktok-smart-plus-adgroups.js';
import {tiktokSmartPlusCampaignUpdateKind,tiktokSmartPlusCampaignUpdateVerification} from './tiktok-smart-plus-campaign-updates.js';
import {tiktokCtaPortfolioKind,tiktokCtaPortfolioVerification,tiktokCtaPortfolioProjection,tiktokPortfolioGetPath} from './tiktok-cta-portfolios.js';
import {tiktokSmartPlusAdKind,tiktokSmartPlusAdVerification,tiktokSmartPlusAdProjection,tiktokSmartPlusAdGetPath} from './tiktok-smart-plus-ads.js';
import {tiktokSmartPlusAdUpdateKind,tiktokSmartPlusAdUpdateVerification} from './tiktok-smart-plus-ad-updates.js';
import {tiktokSmartPlusAdgroupUpdateKind,tiktokSmartPlusAdgroupUpdateVerification} from './tiktok-smart-plus-adgroup-updates.js';
import {tiktokSmartPlusMaterialStatusKind,tiktokSmartPlusMaterialStatusVerification} from './tiktok-smart-plus-material-status.js';
import {linkedinLeadFormKind,linkedinLeadFormVerification,isLinkedInLeadFormRead,linkedinLeadFormProjection} from './linkedin-lead-forms.js';
import {googlePreviewKind,verifyGooglePreview} from './google-preview-writes.js';
import {criteoCampaignKind,assertCriteoCampaignScopes,verifyCriteoCampaign} from './criteo-campaign-writes.js';
import {metaReportKind,assertMetaReportScope,verifyMetaReport,metaReportReadResult,observeMetaReportRead} from './meta-insights-jobs.js';
import {xReportKind,verifyXReport,observeXReport,xReportStatus} from './x-report-jobs.js';
import {tiktokReportKind,verifyTiktokReport} from './tiktok-report-jobs.js';
import {criteoReportKind,assertCriteoReportScopes,verifyCriteoReport,criteoReportReadResult,observeCriteoReportRead} from './criteo-report-jobs.js';
import {placeActionKind,assertPlaceActionScope,verifyPlaceAction} from './google-place-action-links.js';
import {businessNotificationKind,assertBusinessNotificationActor,assertBusinessNotificationScope,verifyBusinessNotification} from './google-business-notifications.js';
import {businessAccessKind,assertBusinessAccessActor,assertBusinessAccessScope,verifyBusinessAccess} from './google-business-access.js';
import {googleDismissalKind,verifyGoogleDismissal} from './google-recommendation-dismissal.js';
import {googleAccessKind,assertGoogleAccessActor,verifyGoogleAccess} from './google-user-access.js';
import {redditCreativeKind,redditCreativeVerification,readRedditProfiles} from './reddit-creative-writes.js';
import {criteoTargetingKind,criteoTargetingVerification,readCriteoTargeting,assertCriteoReadScope} from './criteo-targeting-writes.js';
import {redditPostCreation,verifyRedditPostCreation} from './reddit-post-creation.js';
import {metaLabelKind,metaLabelVerification,readMetaLabels,assertMetaLabelScope} from './meta-label-writes.js';
import {googleBrandGuidelinesKind,googleBrandGuidelinesVerification,readGoogleBrandGuidelines,isGoogleBrandGuidelinesRead,googleBrandGuidelinesObserved} from './google-pmax-brand-guidelines.js';
import {assertGoogleAdsScope as assertBrandGuidelinesScope} from './google-contracts.js';
import {googleCustomerSettingsKind,googleCustomerSettingsVerification,readGoogleCustomerSettings,isGoogleCustomerSettingsRead,googleCustomerSettingsObserved} from './google-customer-settings.js';
import {googleAutoAssetKind,googleAutoAssetVerification,readGoogleAutoAssets,isGoogleAutoAssetRead,googleAutoAssetObserved} from './google-auto-assets.js';
import {googleUploadKind,googleUploadVerification,readGoogleUploads,isGoogleUploadRead,googleUploadObserved} from './google-youtube-uploads.js';
import {googleExperimentKind,googleExperimentVerification,readGoogleExperiments,isGoogleExperimentRead,googleExperimentObserved} from './google-experiments.js';
import {googleDraftKind,googleDraftVerification,readGoogleDrafts,isGoogleDraftRead,googleDraftObserved} from './google-campaign-drafts.js';
import {googleCustomerTypeKind,googleCustomerTypeVerification,readGoogleCustomerTypes,isGoogleCustomerTypeRead,googleCustomerTypeObserved} from './google-user-list-customer-types.js';
import {googleBidKind,googleBidVerification,readGoogleBidState,isGoogleBidRead,assertGoogleBidScope} from './google-bid-modifiers.js';
import {assertGoogleAdsScope} from './google-contracts.js';
import {googleSegmentKind} from './google-custom-segments.js';
import {googleConversionGoalKind,verifyGoogleConversionGoal} from './google-conversion-goals.js';
import {googleBiddingEventKind,verifyGoogleBiddingEvent} from './google-bidding-events.js';
import {googlePortfolioKind,verifyGooglePortfolio} from './google-portfolio-strategies.js';
import {googleConversionActionKind,verifyGoogleConversionAction} from './google-conversion-actions.js';
import {xDraftKind,verifyXDraft} from './x-draft-writes.js';
import {xTargetingBatchRoute,verifyXTargetingBatch} from './x-targeting-batch.js';
import {linkedinTemplateKind,verifyLinkedInTemplate} from './linkedin-audience-templates.js';
import {linkedinMessageKind,linkedinMessageVerification,readLinkedInMessage,isLinkedInMessageRead,linkedinMessageObserved,assertLinkedInMessageScope} from './linkedin-message-ads.js';
import {linkedinThirdPartyKind,linkedinThirdPartyVerification,readLinkedInThirdParty,isLinkedInThirdPartyRead,linkedinThirdPartyObserved,assertLinkedInThirdPartyScope} from './linkedin-third-party-tracking.js';
import {linkedinTrackingKind,linkedinTrackingVerification,readLinkedInTracking,isLinkedInTrackingRead,linkedinTrackingObserved,assertLinkedInTrackingScope} from './linkedin-tracking-parameters.js';
import {linkedinConversionKind,linkedinConversionVerification,readLinkedInConversions,isLinkedInConversionRead,assertLinkedInConversionScope} from './linkedin-conversion-links.js';
import {linkedinRuleKind,linkedinRuleVerification,readLinkedInRules,isLinkedInRuleRead} from './linkedin-conversion-rules.js';
import {Store} from './store.js';
import {Registry} from './catalog.js';
import {NativeTransport} from './transport.js';
import {CredentialProvider} from './auth.js';
import {ScopeGuard} from './scope.js';
import {independentlyReadOnly} from './execution-risk.js';
import {MirrorError} from './errors.js';
import {sha256,stable} from './security.js';
import {setTimeout as delay} from 'node:timers/promises';
import {readConsistently} from './read-consistency.js';
import {linkedinDSC,assertLinkedInDSCGrant,rememberLinkedInPost} from './linkedin-posts.js';
import {xCreativeKind,xPromotion,verifyXCreative} from './x-creative-writes.js';
import {normalizeReviewState} from './review-state.js';
import {googleAssetLinkKind,googleAssetLinkVerification} from './google-asset-links.js';
import {googleConfigurationKind,googleConfigurationVerification,googleConfigurationObserved} from './google-configuration-writes.js';
import {measurementWriteGateways,measurementVerification,measurementVerificationPhase,optionalMissingState} from './measurement-writes.js';
import {appleSharedAccounts} from './apple-entity-writes.js';
import {dv360ListKind,dv360ListVerification,dv360ListObserved,readDV360List} from './dv360-list-writes.js';
import {dv360TargetingKind,dv360TargetingVerification,dv360TargetingObserved,readDV360Targeting} from './dv360-line-item-targeting.js';
import {googleListingGroupKind,googleListingGroupVerification,isGoogleListingGroupRead,googleListingGroupObserved} from './google-listing-groups.js';
import {tiktokNegativeKeywordKind,tiktokNegativeKeywordVerification,isTiktokNegativeKeywordRead,tiktokNegativeKeywordObserved,readTiktokNegativeKeywords} from './tiktok-negative-keywords.js';
import {tiktokBrandSafetyKind,tiktokBrandSafetyVerification,isTiktokBrandSafetyRead,tiktokBrandSafetyObserved} from './tiktok-brand-safety.js';
import {metaValueRuleKind,metaValueRuleVerification,isMetaValueRuleRead,metaValueRuleObserved} from './meta-value-rules.js';
import {metaBrandSafetyKind,metaBrandSafetyVerification,isMetaBrandSafetyRead,metaBrandSafetyObserved} from './meta-brand-safety.js';
import {criteoOverrideKind,criteoOverrideVerification,readCriteoOverrides,isCriteoOverrideRead,criteoOverrideObserved,assertCriteoOverrideScopes} from './criteo-budget-overrides.js';
import {criteoLineItemKind,criteoLineItemVerification,isCriteoLineItemRead,criteoLineItemObserved,readCriteoLineItems,assertCriteoLineItemScopes} from './criteo-auction-line-items.js';
import {criteoPromotedProductsKind,criteoPromotedProductsVerification} from './criteo-promoted-products.js';
import {criteoKeywordKind,criteoBidMultiplierKind,criteoLineItemBiddingVerification} from './criteo-line-item-bidding.js';
import {dv360AdGroupKind,dv360AdGroupVerification,isDV360AdGroupRead,dv360AdGroupObserved,readDV360AdGroups} from './dv360-demand-gen-ad-groups.js';
import {dv360AdAssetKind,dv360AdAssetVerification} from './dv360-ad-assets.js';
import {xCuratedKind,xCuratedVerification,readXCurated,isXCuratedRead,xCuratedObserved} from './x-curated-categories.js';
import {xAssociationKind,xAssociationVerification,readXAssociations,isXAssociationRead,xAssociationObserved} from './x-line-item-associations.js';
import {xTrackingTagKind,xTrackingTagVerification,readXTrackingTags,isXTrackingTagRead,xTrackingTagObserved} from './x-tracking-tags.js';
import {dv360InventoryGroupKind,dv360InventoryGroupVerification,readDV360InventoryGroup,isDV360InventoryGroupRead,dv360InventoryGroupObserved} from './dv360-inventory-source-groups.js';
import {dv360LineItemDuplicateKind,dv360LineItemDuplicateVerification,readDV360LineItemDuplicate,isDV360LineItemDuplicateRead,dv360LineItemDuplicateObserved} from './dv360-line-item-duplicate.js';
import {dv360LineItemBulkKind,dv360LineItemBulkVerification,readDV360LineItemBulk,isDV360LineItemBulkRead,dv360LineItemBulkObserved} from './dv360-line-item-bulk-update.js';
import {dv360AdKind,dv360AdVerification,isDV360AdRead,dv360AdObserved,readDV360Ads} from './dv360-demand-gen-ads.js';
import {gtmWorkflowKind,gtmWorkflowVerification,gtmWorkflowObserved,readGtmWorkflow} from './gtm-workflow-writes.js';
import {gtmWorkspaceKind,gtmWorkspaceVerification,gtmWorkspaceObserved,readGtmWorkspace} from './gtm-workspace-writes.js';
import {validateState,snapshotPlans} from './write-review.js';
import {compileMicrosoft,microsoftGateway,microsoftContracts} from './microsoft-native.js';
import {microsoftAssociationWrite,microsoftAssociationVerification,microsoftAssociationObserved} from './microsoft-associations.js';
import {audit,bad,fingerprint,obj,optional,read} from './workspace-core.js';
import type {Actor,CompiledRequest,Connection,Credentials,JsonObject} from './types.js';
import {nativeAuthority} from './native-authority.js';
// Snapchat records whose read-back adds provider fields or renames sent ones are compared as projections.
const snapProjections:Record<string,(row:unknown)=>unknown>={lead_generation_forms:snapLeadFormProjection,segments:snapSegmentProjection};
const snake=(s:string)=>s.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase();
const normalize=(v:any):any=>Array.isArray(v)?normalizeReviewState(v.map(normalize)):obj(v)?Object.fromEntries(Object.entries(v).map(([k,x])=>[snake(k),normalize(x)])):v;
function differing(expected:any,actual:any,path='',out:string[]=[]):string[]{
 if(obj(expected)){for(const [key,value]of Object.entries(expected))differing(value,actual?.[key],path+'/'+key,out);}
 else if((typeof expected==='number'&&typeof actual==='string'||typeof expected==='string'&&typeof actual==='number')&&String(expected)===String(actual))return out;
 else if(fingerprint(expected)!==fingerprint(actual??null))out.push(path);return out;
}
type Acknowledged=Record<string,{sent:unknown;echoed:unknown}>;
function verificationReads(plan:CompiledRequest,result:JsonObject,registry:Registry,before:unknown[]=[]):{read:CompiledRequest;expected:JsonObject;id:string;acknowledged?:Acknowledged;unobservable?:string[]}[]{
 if(linkedinRuleKind(plan))return linkedinRuleVerification(plan,result,before);
 if(linkedinLeadFormKind(plan))return linkedinLeadFormVerification(plan,result);
 if(linkedinConversionKind(plan))return linkedinConversionVerification(plan);
 if(linkedinTrackingKind(plan))return linkedinTrackingVerification(plan);
 if(linkedinThirdPartyKind(plan))return linkedinThirdPartyVerification(plan,result,before);
 if(linkedinMessageKind(plan))return linkedinMessageVerification(plan,result,before);
 if(googleBidKind(plan))return googleBidVerification(plan,result);
 if(googleBrandGuidelinesKind(plan))return googleBrandGuidelinesVerification(plan);
 if(googleCustomerTypeKind(plan))return googleCustomerTypeVerification(plan,result,before);
 if(googleDraftKind(plan))return googleDraftVerification(plan,result);
 if(googleExperimentKind(plan))return googleExperimentVerification(plan,result);
 if(googleCustomerSettingsKind(plan))return googleCustomerSettingsVerification(plan);
 if(googleAutoAssetKind(plan))return googleAutoAssetVerification(plan);
 if(googleUploadKind(plan))return googleUploadVerification(plan);
 if(criteoTargetingKind(plan))return criteoTargetingVerification(plan,before);
 if(metaLabelKind(plan))return metaLabelVerification(plan,result,before);
 if(redditCreativeKind(plan))return redditCreativeVerification(plan,result);
 if(gtmWorkspaceKind(plan))return gtmWorkspaceVerification(plan,result,before);
 if(gtmWorkflowKind(plan))return gtmWorkflowVerification(plan,result,before);
 if(dv360TargetingKind(plan))return dv360TargetingVerification(plan,before);
 if(dv360ListKind(plan))return dv360ListVerification(plan,result,before);
 if(googleListingGroupKind(plan))return googleListingGroupVerification(plan,before);
 if(tiktokNegativeKeywordKind(plan))return tiktokNegativeKeywordVerification(plan,before);
 if(tiktokBrandSafetyKind(plan))return tiktokBrandSafetyVerification(plan,before);
 if(metaValueRuleKind(plan))return metaValueRuleVerification(plan,result,before);
 if(metaBrandSafetyKind(plan))return metaBrandSafetyVerification(plan,result);
 if(criteoLineItemKind(plan))return criteoLineItemVerification(plan,result,before);
 if(criteoOverrideKind(plan))return criteoOverrideVerification(plan);
 if(criteoPromotedProductsKind(plan))return criteoPromotedProductsVerification(plan);
 if(criteoKeywordKind(plan)||criteoBidMultiplierKind(plan))return criteoLineItemBiddingVerification(plan);
 if(dv360AdGroupKind(plan))return dv360AdGroupVerification(plan,result,before);
 if(dv360AdAssetKind(plan))return dv360AdAssetVerification(plan,result);
 if(dv360AdKind(plan))return dv360AdVerification(plan,result,before);
 if(dv360LineItemBulkKind(plan))return dv360LineItemBulkVerification(plan);
 if(dv360LineItemDuplicateKind(plan))return dv360LineItemDuplicateVerification(plan,result,before);
 if(dv360InventoryGroupKind(plan))return dv360InventoryGroupVerification(plan,result,before);
 if(xTrackingTagKind(plan))return xTrackingTagVerification(plan,result,before);
 if(xAssociationKind(plan))return xAssociationVerification(plan,result,before);
 if(xCuratedKind(plan))return xCuratedVerification(plan,result,before);
 if(snapchatMediaCopyKind(plan))return snapchatMediaCopyVerification(plan,result,before);
 if(googleConfigurationKind(plan))return googleConfigurationVerification(plan,result);
 if(googleAssetLinkKind(plan))return googleAssetLinkVerification(plan);
 if(microsoftAssociationWrite(plan))return microsoftAssociationVerification(plan,compileMicrosoft);
 if(measurementWriteGateways.has(plan.gateway))return measurementVerification(plan,result);
 const b=(plan.body??{}) as JsonObject,d=result.data??{},gateway=plan.gateway;
 const base=(path:string,query:JsonObject={}):CompiledRequest=>({...plan,path,method:'GET',query,body:undefined,headers:gateway==='linkedin_native_action'?Object.fromEntries(Object.entries(plan.headers).filter(([k])=>['LinkedIn-Version','X-Restli-Protocol-Version'].includes(k))):{},readOnly:true,destructive:false,requiresConfirmation:false,action:'AMCP_VERIFY_READ'});
 if(plan.method==='DELETE')return [];
 if(gateway==='google_ads_native_action'){
  const leaves=(value:JsonObject,prefix=''):string[]=>Object.entries(value).flatMap(([k,v])=>obj(v)?leaves(v,prefix+snake(k)+'.'):[prefix+snake(k)]);
  return (d.results??[]).map((r:JsonObject,i:number)=>{const op=b.operations[i],record=op.create??op.update,expected=op.remove?{status:'REMOVED'}:Object.fromEntries(Object.entries(record).filter(([k])=>!['resource_name','resourceName'].includes(k))),fake={...plan,body:{operations:[op.remove?{remove:op.remove}:{update:{resource_name:r.resourceName,...expected},update_mask:leaves(expected).join(',')}]}};
   const p=snapshotPlans(fake,registry)[0]!;if(op.remove){const resource=String((p.body as JsonObject).query).match(/ FROM ([a-z_]+)/)?.[1];if(!resource)bad('Removal has no exact state read.','VERIFICATION_UNSUPPORTED');p.googleState={resource,names:[r.resourceName],allowMissing:true,removedAsAbsent:true};}return {read:p,expected,id:r.resourceName};});
 }
 if(gateway===microsoftGateway){const contract=microsoftContracts.get(plan.action)!;if(!contract.kind)return [];
  const records=b[contract.kind]??[],ids=plan.action.startsWith('Add')?d[contract.result]:records.map((r:JsonObject)=>r.Id),idKey=contract.kind.slice(0,-1)+'Ids';
  return ids.map((id:string,i:number)=>({read:compileMicrosoft({action:'Get'+contract.kind+'ByIds',account_id:plan.accountId,payload:{[idKey]:[id],...(contract.kind==='Campaigns'?{CampaignType:'Search'}:contract.kind==='AdGroups'?{CampaignId:b.CampaignId}:{AdGroupId:b.AdGroupId})}}),expected:records[i],id}));
 }
 if(metaCopyKind(plan))return metaCopyVerification(plan,result,before).map(v=>({...v,read:base(v.path,v.query)}));
 if(metaLookalikeKind(plan))return metaLookalikeVerification(plan,result).map(v=>({...v,read:base(v.path,v.query)}));
 if(gateway==='meta_native_action'){const id=String(d.id??plan.path.split('/').at(-1));if(!/^\d+$/.test(id))return [];const expected={...b};delete expected.execution_options;if(expected.creative?.creative_id)expected.creative={id:expected.creative.creative_id};return [{read:base('/v25.0/'+id,{fields:['id',...Object.keys(expected)].join(',')}),expected,id}];}
 if(tiktokIdentityKind(plan))return tiktokIdentityVerification(plan,result).map(v=>({...v,read:{...base(v.path,v.query),action:'tiktok_identity_info_get'}}));
 if(tiktokBudgetKind(plan))return tiktokBudgetVerification(plan).map(v=>({...v,read:{...base(v.path,v.query),action:'tiktok_adgroup_get'}}));
 if(tiktokCustomConversionKind(plan))return tiktokCustomConversionVerification(plan,result).map(v=>({...v,read:{...base(v.path,v.query),action:'tiktok_custom_conversion_get'}}));
 if(tiktokSavedAudienceKind(plan))return tiktokSavedAudienceVerification(plan,result).map(v=>({...v,read:{...base(v.path,v.query),action:'tiktok_dmp_saved_audience_list_get'}}));
 if(tiktokSmartPlusStatusKind(plan))return tiktokSmartPlusStatusVerification(plan).map(v=>({read:{...base(v.path,v.query),action:v.action},expected:v.expected,id:v.id}));
 if(tiktokSmartPlusBudgetKind(plan))return tiktokSmartPlusBudgetVerification(plan).map(v=>({...v,read:{...base(v.path,v.query),action:'tiktok_smart_plus_adgroup_get'}}));
 if(tiktokSmartPlusCampaignKind(plan))return tiktokSmartPlusCampaignVerification(plan,result).map(v=>({...v,read:{...base(v.path,v.query),action:'tiktok_smart_plus_campaign_get'}}));
 if(tiktokSmartPlusAdgroupKind(plan))return tiktokSmartPlusAdgroupVerification(plan,result).map(v=>({...v,read:{...base(v.path,v.query),action:'tiktok_smart_plus_adgroup_get'}}));
 if(tiktokSmartPlusCampaignUpdateKind(plan))return tiktokSmartPlusCampaignUpdateVerification(plan).map(v=>({...v,read:{...base(v.path,v.query),action:'tiktok_smart_plus_campaign_get'}}));
 if(tiktokCtaPortfolioKind(plan))return tiktokCtaPortfolioVerification(plan,result).map(v=>({...v,read:{...base(v.path,v.query),action:'tiktok_creative_portfolio_get'}}));
 if(tiktokSmartPlusAdKind(plan))return tiktokSmartPlusAdVerification(plan,result).map(v=>({...v,read:{...base(v.path,v.query),action:'tiktok_smart_plus_ad_get'}}));
 if(tiktokSmartPlusAdUpdateKind(plan))return tiktokSmartPlusAdUpdateVerification(plan).map(v=>({...v,read:{...base(v.path,v.query),action:'tiktok_smart_plus_ad_get'}}));
 if(tiktokSmartPlusAdgroupUpdateKind(plan))return tiktokSmartPlusAdgroupUpdateVerification(plan).map(v=>({...v,read:{...base(v.path,v.query),action:'tiktok_smart_plus_adgroup_get'}}));
 if(tiktokSmartPlusMaterialStatusKind(plan))return tiktokSmartPlusMaterialStatusVerification(plan).map(v=>({...v,read:{...base(v.path,v.query),action:'tiktok_smart_plus_ad_get'}}));
 if(tiktokLookalikeKind(plan))return tiktokLookalikeVerification(plan,result).map(v=>({...v,read:{...base(v.path,v.query),action:'tiktok_dmp_custom_audience_get'}}));
 if(gateway==='tiktok_native_action'){
  const kind=plan.path.split('/')[2]!,ids=d.data?.[kind+'_ids']??[d.data?.[kind+'_id']??b[kind+'_id']];if(ids.some((id:unknown)=>typeof id!=='string'))return [];
  const expected=kind==='ad'&&plan.path==='/v1.3/ad/create/'?{...b.creatives[0],adgroup_id:b.adgroup_id}:Object.fromEntries(Object.entries(b).filter(([k])=>!['advertiser_id',kind+'_ids'].includes(k)));
  return ids.map((id:string)=>({read:{...base('/v1.3/'+kind+'/get/',{advertiser_id:plan.accountId,filtering:{[kind+'_ids']:[id]},page_size:100}),action:'tiktok_'+kind+'_get'},expected,id}));
 }
 if(gateway==='snapchat_native_action'){
  const kind=Object.keys(d).find(k=>['campaigns','adsquads','ads','creatives','lead_generation_forms','segments'].includes(k));if(!kind)return [];const singular=kind==='adsquads'?'adsquad':kind.slice(0,-1);
  // Array-index patches and removes need before/after reconstruction. Do not label partial checks verified.
  if(Array.isArray(plan.body)&&plan.body.some((p:JsonObject)=>!['add','replace'].includes(p.op)||!/^\/[A-Za-z_]+$/.test(p.path)))return [];
  // Snapchat's GET never returns placement_v2 (it reads back as placement:"UNSUPPORTED"). A field no read
  // can observe is compared with the provider's own write response instead; a missing echo stays inconclusive.
  const writeOnly=kind==='adsquads'?['placement_v2']:[];
  return d[kind].map((r:JsonObject,i:number)=>{
   const id=r[singular].id,expected={...(b[kind]?.[i]??(Array.isArray(plan.body)?Object.fromEntries((plan.body as JsonObject[]).map(p=>[p.path.slice(1),p.value])):b))},acknowledged:Acknowledged={};
   for(const field of writeOnly)if(Object.hasOwn(expected,field)){acknowledged[field]={sent:expected[field],echoed:r[singular]?.[field]};delete expected[field];}
   return {read:base('/v1/'+kind+'/'+id),expected:(snapProjections[kind]?.(expected)??expected) as JsonObject,id,...(Object.keys(acknowledged).length?{acknowledged}:{})};
  });
 }
 if(gateway==='reddit_native_action'){const kind=plan.method==='POST'?plan.path.split('/').at(-1):plan.path.split('/').at(-2),id=d.data?.id;if(!id)return [];return [{read:base('/api/v3/'+kind+'/'+id),expected:b.data,id}];}
 if(gateway==='x_ads_native_action'){const records=Array.isArray(d.data)?d.data:[d.data];return records.filter(Boolean).map((r:JsonObject)=>({read:base(plan.method==='POST'?plan.path+'/'+r.id:plan.path),expected:b,id:String(r.id)}));}
 if(gateway==='linkedin_native_action'){const id=String(result.created_id??result.headers?.['x-restli-id']??plan.path.split('/').at(-1)),expected=b.patch?.$set??b;return [{read:base(plan.method==='POST'&&result.status===201?plan.path+'/'+encodeURIComponent(id):plan.path),expected,id:id.split(':').at(-1)!}];}
 if(gateway==='dv360_native_action'){const id=d.campaignId??d.insertionOrderId??d.lineItemId??d.creativeId;if(!id)return [];return [{read:base(plan.method==='POST'?plan.path+'/'+id:plan.path),expected:b,id:String(id)}];}
 return [];
}
function entity(plan:CompiledRequest,data:JsonObject):JsonObject{
 if(isLinkedInTrackingRead(plan))return linkedinTrackingObserved(plan,data);
 if(isLinkedInThirdPartyRead(plan))return linkedinThirdPartyObserved(plan,data);
 if(isLinkedInMessageRead(plan))return linkedinMessageObserved(plan,data);
 if(isLinkedInConversionRead(plan)||isLinkedInRuleRead(plan))return data;
 if(isLinkedInLeadFormRead(plan))return linkedinLeadFormProjection(data);
 if(isGoogleBidRead(plan))return data;
 if(isGoogleBrandGuidelinesRead(plan))return googleBrandGuidelinesObserved(plan,data);
 if(isGoogleCustomerTypeRead(plan))return googleCustomerTypeObserved(plan,data);
 if(isGoogleDraftRead(plan))return googleDraftObserved(plan,data);
 if(isGoogleExperimentRead(plan))return googleExperimentObserved(plan,data);
 if(isGoogleCustomerSettingsRead(plan))return googleCustomerSettingsObserved(plan,data);
 if(isGoogleAutoAssetRead(plan))return googleAutoAssetObserved(plan,data);
 if(isGoogleUploadRead(plan))return googleUploadObserved(plan,data);
 if(plan.gtmWorkspaceState)return gtmWorkspaceObserved(plan,data);
 if(data.amcp_absent===true)return data;
 if(plan.gtmState)return gtmWorkflowObserved(plan,data);
 if(plan.dv360ListState)return dv360ListObserved(plan,data);
 if(plan.dv360TargetingState)return dv360TargetingObserved(plan,data);
 if(plan.gateway===microsoftGateway&&plan.action==='GetAdExtensionsAssociations')return microsoftAssociationObserved(plan,data);
 if(plan.gateway==='apple_ads_native_action'){
  if(plan.action==='AMCP_STATE_OPTIONAL'&&data.result?.deleted===true)return {amcp_absent:true,path:plan.path};
  return Array.isArray(data.result?.adAccountIds)?{...data.result,adAccountIds:[...data.result.adAccountIds].sort((a,b)=>String(a).localeCompare(String(b),'en'))}:data.result;
 }
 if(plan.googleState?.removedAsAbsent&&!data.results?.length)return {status:'REMOVED'};
 if(isGoogleListingGroupRead(plan))return googleListingGroupObserved(plan,data);
 if(isTiktokNegativeKeywordRead(plan))return tiktokNegativeKeywordObserved(plan,data);
 if(isTiktokBrandSafetyRead(plan))return tiktokBrandSafetyObserved(plan,data);
 if(isMetaValueRuleRead(plan))return metaValueRuleObserved(plan,data);
 if(isMetaBrandSafetyRead(plan))return metaBrandSafetyObserved(plan,data);
 if(isCriteoLineItemRead(plan))return criteoLineItemObserved(plan,data);
 if(isCriteoOverrideRead(plan))return criteoOverrideObserved(plan,data);
 if(isDV360AdGroupRead(plan))return dv360AdGroupObserved(plan,data);
 if(isDV360AdRead(plan))return dv360AdObserved(plan,data);
 if(isDV360LineItemBulkRead(plan))return dv360LineItemBulkObserved(plan,data);
 if(isDV360LineItemDuplicateRead(plan))return dv360LineItemDuplicateObserved(plan,data);
 if(isDV360InventoryGroupRead(plan))return dv360InventoryGroupObserved(plan,data);
 if(isXTrackingTagRead(plan))return xTrackingTagObserved(plan,data);
 if(isXAssociationRead(plan))return xAssociationObserved(plan,data);
 if(isXCuratedRead(plan))return xCuratedObserved(plan,data);
 if(isSnapchatMediaCopyCheck(plan))return snapchatMediaCopyObserved(plan,data);
 if(plan.gateway==='google_ads_native_action')return googleConfigurationObserved(plan,Object.values(data.results?.[0]??{})[0] as JsonObject);
 if(plan.gateway===microsoftGateway)return data[microsoftContracts.get(plan.action)!.result]?.[0];
 if(plan.gateway==='tiktok_native_action'&&plan.path==='/v1.3/identity/info/')return data.data?.identity_info;
 if(plan.gateway==='tiktok_native_action'&&plan.path===tiktokAudienceGetPath)return data.data?.list?.[0]?.audience_details;
 if(metaLookalikeRead(plan))return metaLookalikeProjection(data) as JsonObject;
 if(plan.gateway==='tiktok_native_action'&&plan.path===tiktokConversionGetPath)return tiktokCustomConversionProjection(data.data);
 if(tiktokSavedAudienceRead(plan))return tiktokSavedAudienceProjection(data.data?.saved_audiences?.[0]);
 if(plan.gateway==='tiktok_native_action'&&plan.path==='/v1.3/smart_plus/campaign/get/')return tiktokSmartPlusCampaignProjection(data.data?.list?.[0]) as JsonObject;
 if(plan.gateway==='tiktok_native_action'&&plan.path==='/v1.3/smart_plus/adgroup/get/')return tiktokSmartPlusAdgroupProjection(data.data?.list?.[0]) as JsonObject;
 if(plan.gateway==='tiktok_native_action'&&plan.path===tiktokPortfolioGetPath)return tiktokCtaPortfolioProjection(data.data);
 if(plan.gateway==='tiktok_native_action'&&plan.path===tiktokSmartPlusAdGetPath)return tiktokSmartPlusAdProjection(data.data?.list?.[0]) as JsonObject;
 if(plan.gateway==='tiktok_native_action')return data.data?.list?.[0];
 if(plan.gateway==='snapchat_native_action'){const kind=plan.path.split('/').at(-2)!,singular=kind==='adsquads'?'adsquad':kind.slice(0,-1),row=data[kind]?.[0]?.[singular];return (snapProjections[kind]?.(row)??row) as JsonObject;}
 if(['reddit_native_action','x_ads_native_action'].includes(plan.gateway))return data.data;
 return data;
}
export class WriteVerifier{
 constructor(private store:Store,private registry:Registry,private transport:NativeTransport,private credentials:CredentialProvider){}
 private async request(actor:Actor,plan:CompiledRequest,connection:Connection,auth:Credentials){
  const access=nativeAuthority(this.store,this.registry,actor,plan,connection,auth);
  const response=await this.transport.request(plan,access(),auth,undefined,{beforeAttempt:access});access();return response;
 }
 async verify(actor:Actor,reviewId:string):Promise<JsonObject>{
  const review=read(this.store,actor,'write_review',reviewId);if(review.user_id!==actor.userId&&actor.role!=='admin')bad('This write belongs to another actor.','FORBIDDEN');
  const row=this.store.db.prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?').get(actor.tenantId,reviewId) as JsonObject|undefined;
  if(row?.state!=='complete'||!row.result)bad('The write outcome is uncertain or unavailable; verification cannot make it safe to resubmit.','WRITE_OUTCOME_UNCERTAIN');
  const result=JSON.parse(row.result),plan=review.plan as CompiledRequest,c=this.store.resolveConnection(actor,plan.gateway,plan.accountId,review.connection_id);
  const checkAppleAccounts=()=>{for(const account of appleSharedAccounts(plan))this.store.resolveConnection(actor,plan.gateway,account,c.id);};checkAppleAccounts();
  if(linkedinDSC(plan))assertLinkedInDSCGrant(plan,c,false);
  if(redditPostCreation(plan)&&!c.scopes.includes('adsread'))bad('Reddit post verification requires adsread.','INSUFFICIENT_SCOPE');
  if(criteoTargetingKind(plan))assertCriteoReadScope(c);
  if(metaReportKind(plan))assertMetaReportScope(c);
  if(criteoCampaignKind(plan))assertCriteoCampaignScopes(c);
  if(criteoLineItemKind(plan)||criteoPromotedProductsKind(plan)||criteoKeywordKind(plan)||criteoBidMultiplierKind(plan))assertCriteoLineItemScopes(c);
  if(criteoOverrideKind(plan))assertCriteoOverrideScopes(c);
  if(criteoReportKind(plan))assertCriteoReportScopes(c);
  if(placeActionKind(plan))assertPlaceActionScope(c);
  if(businessNotificationKind(plan)){assertBusinessNotificationActor(plan,actor);assertBusinessNotificationScope(c);}
  if(businessAccessKind(plan)){assertBusinessAccessActor(plan,actor);assertBusinessAccessScope(c);}
  if(googlePreviewKind(plan)||googleDismissalKind(plan)||googleAccessKind(plan))assertGoogleAdsScope(c);
  assertGoogleAccessActor(plan,actor);
  if(metaLabelKind(plan))assertMetaLabelScope(c);
  if(googleBidKind(plan))assertGoogleBidScope(c);
  if(googleBrandGuidelinesKind(plan))assertBrandGuidelinesScope(c);
  if(googleCustomerTypeKind(plan))assertBrandGuidelinesScope(c);
  if(googleDraftKind(plan))assertBrandGuidelinesScope(c);
  if(googleExperimentKind(plan)||googleCustomerSettingsKind(plan)||googleAutoAssetKind(plan)||googleUploadKind(plan))assertBrandGuidelinesScope(c);
  if(googleSegmentKind(plan)||googleBiddingEventKind(plan)||googleConversionGoalKind(plan)||googlePortfolioKind(plan)||googleConversionActionKind(plan))assertGoogleAdsScope(c);
  if(linkedinConversionKind(plan)||linkedinRuleKind(plan)||linkedinTemplateKind(plan))assertLinkedInConversionScope(c);
  if(linkedinTrackingKind(plan))assertLinkedInTrackingScope(c);
  if(linkedinThirdPartyKind(plan))assertLinkedInThirdPartyScope(c);
  if(linkedinMessageKind(plan))assertLinkedInMessageScope(c);
  if(result.success!==true)bad('Inspect the retained partial failure before recovery.','WRITE_PARTIAL_OR_FAILED');
  const cached=optional(this.store,actor.tenantId,'write_verification',reviewId);if(!linkedinTemplateKind(plan)&&!xTargetingBatchRoute(plan)&&!snapUpdateKind(plan)&&!xReportKind(plan)&&!tiktokReportKind(plan)&&!googlePreviewKind(plan)&&cached?.status==='verified'&&Date.now()-cached.checked_at<10000)return {...cached,cached:true};
  let reads:ReturnType<typeof verificationReads>=[],status='unverified',checks:JsonObject[]=[],resources:JsonObject[]=[];
  try{if(redditPostCreation(plan)){
   const verified=await verifyRedditPostCreation(plan,result,reviewId,c,this.store,read=>readRedditProfiles(read,async page=>{
    if(!independentlyReadOnly(page))bad('Post verification must remain read-only.','VERIFICATION_UNSUPPORTED');
    this.store.assertActorActive(actor);let current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);
    if(!current.scopes.includes('adsread'))bad('Reddit post verification requires adsread.','INSUFFICIENT_SCOPE');
    new ScopeGuard(this.registry,this.store).authorize(page,current);const auth=await this.credentials.get(current);
    this.store.assertActorActive(actor);current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);if(!current.scopes.includes('adsread'))bad('Reddit post verification requires adsread.','INSUFFICIENT_SCOPE');new ScopeGuard(this.registry,this.store).authorize(page,current);
    const response=await this.request(actor,page,current,auth);this.store.assertActorActive(actor);current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);
    if(!current.scopes.includes('adsread'))bad('Reddit post verification requires adsread.','INSUFFICIENT_SCOPE');new ScopeGuard(this.registry,this.store).authorize(page,current);return response;
   }));status=verified.status;checks=verified.checks;resources=verified.resources??[];
  }else if(snapUpdateKind(plan)){
   let credentialHash:string|undefined;
   const verified=await verifySnapUpdate(plan,review.state,async read=>{
    if(!independentlyReadOnly(read))bad('Snapchat verification must remain read-only.','VERIFICATION_UNSUPPORTED');
    const access=()=>{this.store.assertActorActive(actor);const current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);new ScopeGuard(this.registry,this.store).authorize(read,current);if(credentialHash&&sha256(stable(this.store.credentials(actor.tenantId,current.id)))!==credentialHash)bad('The selected login changed during Snapchat verification.','REAUTHORIZATION_REQUIRED');return current;};
    const current=access(),auth=await this.credentials.get(current);credentialHash??=sha256(stable(auth));access();const response=await this.request(actor,read,current,auth);access();return response;
   });status=verified.status;checks=verified.checks;
  }else if(googlePreviewKind(plan)){
   let credentialHash:string|undefined;
   const verified=await verifyGooglePreview(plan,review.state,result,this.store.previewReceipt(actor.tenantId,reviewId),async read=>{
    if(!independentlyReadOnly(read))bad('Preview verification must remain read-only.','VERIFICATION_UNSUPPORTED');
    const access=()=>{this.store.assertActorActive(actor);const current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);assertGoogleAdsScope(current);new ScopeGuard(this.registry,this.store).authorize(read,current);if(credentialHash&&sha256(stable(this.store.credentials(actor.tenantId,current.id)))!==credentialHash)bad('The selected login changed during preview verification.','REAUTHORIZATION_REQUIRED');return current;};
    const current=access(),auth=await this.credentials.get(current);credentialHash??=sha256(stable(auth));access();const response=await this.request(actor,read,current,auth);access();return response;
   });status=verified.status;checks=verified.checks;
  }else if(googlePortfolioKind(plan)||googleConversionActionKind(plan)){
   let credentialHash:string|undefined;
   const verified=await (googleConversionActionKind(plan)?verifyGoogleConversionAction:verifyGooglePortfolio)(plan,result,review.state,async read=>{
    if(!independentlyReadOnly(read))bad('Portfolio verification must remain read-only.','VERIFICATION_UNSUPPORTED');
    const access=()=>{this.store.assertActorActive(actor);const current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);assertGoogleAdsScope(current);new ScopeGuard(this.registry,this.store).authorize(read,current);if(credentialHash&&sha256(stable(this.store.credentials(actor.tenantId,current.id)))!==credentialHash)bad('The selected login changed during portfolio verification.','REAUTHORIZATION_REQUIRED');return current;};
    const current=access(),auth=await this.credentials.get(current);credentialHash??=sha256(stable(auth));access();const response=await this.request(actor,read,current,auth);access();return response;
   });status=verified.status;checks=verified.checks;
  }else if(googleAccessKind(plan)){
   const verified=await verifyGoogleAccess(plan,result,review.state,async read=>{
    if(!independentlyReadOnly(read))bad('Google access verification must remain read-only.','VERIFICATION_UNSUPPORTED');
    const access=()=>{this.store.assertActorActive(actor);assertGoogleAccessActor(plan,actor);const current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);assertGoogleAdsScope(current);new ScopeGuard(this.registry,this.store).authorize(read,current);return current;};
    const current=access(),auth=await this.credentials.get(current);access();const response=await this.request(actor,read,current,auth);access();return response;
   });status=verified.status;checks=verified.checks;
  }else if(googleDismissalKind(plan)){
   const verified=await verifyGoogleDismissal(plan,review.state,async read=>{
    if(!independentlyReadOnly(read))bad('Dismissal verification must remain read-only.','VERIFICATION_UNSUPPORTED');
    const access=()=>{this.store.assertActorActive(actor);const current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);assertGoogleAdsScope(current);new ScopeGuard(this.registry,this.store).authorize(read,current);return current;};
    const current=access(),auth=await this.credentials.get(current);access();const response=await this.request(actor,read,current,auth);access();return response;
   });status=verified.status;checks=verified.checks;
  }else if(businessAccessKind(plan)){
   const verified=await verifyBusinessAccess(plan,result,review.state,async read=>{
    if(!independentlyReadOnly(read))bad('Business access verification must remain read-only.','VERIFICATION_UNSUPPORTED');
    const access=()=>{this.store.assertActorActive(actor);assertBusinessAccessActor(plan,actor);const current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);assertBusinessAccessScope(current);new ScopeGuard(this.registry,this.store).authorize(read,current);return current;};
    const current=access(),auth=await this.credentials.get(current);access();const response=await this.request(actor,read,current,auth);access();return response;
   });status=verified.status;checks=verified.checks;resources=verified.resources;
  }else if(placeActionKind(plan)||businessNotificationKind(plan)){
   const verified=await (placeActionKind(plan)?verifyPlaceAction:verifyBusinessNotification)(plan,result,review.state,async read=>{
    if(!independentlyReadOnly(read))bad('Place-action verification must remain read-only.','VERIFICATION_UNSUPPORTED');
    const access=()=>{this.store.assertActorActive(actor);assertBusinessNotificationActor(plan,actor);const current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);assertPlaceActionScope(current);new ScopeGuard(this.registry,this.store).authorize(read,current);return current;};
    const current=access(),auth=await this.credentials.get(current);access();const response=await this.request(actor,read,current,auth);access();return response;
   });status=verified.status;checks=verified.checks;resources=verified.resources;
  }else if(criteoCampaignKind(plan)){
   let credentialHash:string|undefined;
   const verified=await verifyCriteoCampaign(plan,result,review.state,async read=>{
    if(!independentlyReadOnly(read))bad('Campaign verification must remain read-only.','VERIFICATION_UNSUPPORTED');
    const access=()=>{this.store.assertActorActive(actor);const active=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);assertCriteoCampaignScopes(active);new ScopeGuard(this.registry,this.store).authorize(read,active);if(credentialHash&&sha256(stable(this.store.credentials(actor.tenantId,active.id)))!==credentialHash)bad('The selected login changed during campaign verification.','REAUTHORIZATION_REQUIRED');return active;};
    const current=access(),auth=await this.credentials.get(current);credentialHash??=sha256(stable(auth));access();const response=await this.request(actor,read,current,auth);access();return response;
   });status=verified.status;checks=verified.checks;resources=verified.resources;
   if(status==='verified')for(const resource of resources){const current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);assertCriteoCampaignScopes(current);this.store.rememberResource(current,plan.accountId!,'criteo-report-target/campaigns/'+resource.resource_id);resource.read_result.arguments.arguments.connection_id=c.id;}
  }else if(xReportKind(plan)){
   const verified=await verifyXReport(plan,result,async read=>{
    if(!independentlyReadOnly(read))bad('Report verification must remain read-only.','VERIFICATION_UNSUPPORTED');
    const access=()=>{this.store.assertActorActive(actor);const active=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);new ScopeGuard(this.registry,this.store).authorize(read,active);return active;};
    const current=access(),auth=await this.credentials.get(current);access();const response=await this.request(actor,read,current,auth),active=access();observeXReport(read,active,this.store,xReportStatus(read,response));return response;
   });status=verified.status;checks=verified.checks;resources=verified.resources;for(const resource of resources)resource.read_result.arguments.connection_id=c.id;
  }else if(tiktokReportKind(plan)){
   const verified=await verifyTiktokReport(plan,result,async read=>{
    if(!independentlyReadOnly(read))bad('Report verification must remain read-only.','VERIFICATION_UNSUPPORTED');
    const access=()=>{this.store.assertActorActive(actor);const active=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);new ScopeGuard(this.registry,this.store).authorize(read,active);return active;};
    const current=access(),auth=await this.credentials.get(current);access();const response=await this.request(actor,read,current,auth);access();return response;
   });status=verified.status;checks=verified.checks;resources=verified.resources;for(const resource of resources)resource.read_result.arguments.connection_id=c.id;
  }else if(criteoReportKind(plan)){
   const verified=await verifyCriteoReport(plan,result,reviewId,async read=>{
    if(!independentlyReadOnly(read))bad('Report verification must remain read-only.','VERIFICATION_UNSUPPORTED');
    const access=()=>{this.store.assertActorActive(actor);const active=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);assertCriteoReportScopes(active);new ScopeGuard(this.registry,this.store).authorize(read,active);return active;};
    const current=access(),auth=await this.credentials.get(current);access();const response=await this.request(actor,read,current,auth),active=access();
    if(stable(this.store.credentials(actor.tenantId,active.id))!==stable(auth))bad('The login changed while checking this report.','REAUTHORIZATION_REQUIRED');
    const data=criteoReportReadResult(read,response)!;observeCriteoReportRead(read,active,this.store,data);return response;
   });status=verified.status;checks=verified.checks;resources=verified.resources;for(const resource of resources)resource.read_result.arguments.arguments.connection_id=c.id;
  }else if(metaReportKind(plan)){
   const verified=await verifyMetaReport(plan,result,reviewId,async read=>{
    if(!independentlyReadOnly(read))bad('Report verification must remain read-only.','VERIFICATION_UNSUPPORTED');
    const access=()=>{this.store.assertActorActive(actor);const active=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);assertMetaReportScope(active);new ScopeGuard(this.registry,this.store).authorize(read,active);return active;};
    const current=access(),auth=await this.credentials.get(current);access();const response=await this.request(actor,read,current,auth),active=access(),data=metaReportReadResult(read,response)!;observeMetaReportRead(read,active,this.store,data);return {...response,data};
   });status=verified.status;checks=verified.checks;resources=verified.resources??[];for(const resource of resources)resource.read_result.arguments.connection_id=c.id;
  }else if(googleBiddingEventKind(plan)||googleConversionGoalKind(plan)){
   const verified=await (googleConversionGoalKind(plan)?verifyGoogleConversionGoal:verifyGoogleBiddingEvent)(plan,result,review.state,async read=>{
    if(!independentlyReadOnly(read))bad('Google goal and bidding-event verification must remain read-only.','VERIFICATION_UNSUPPORTED');
    this.store.assertActorActive(actor);let current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);assertGoogleAdsScope(current);new ScopeGuard(this.registry,this.store).authorize(read,current);
    const auth=await this.credentials.get(current);this.store.assertActorActive(actor);current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);assertGoogleAdsScope(current);new ScopeGuard(this.registry,this.store).authorize(read,current);
    const response=await this.request(actor,read,current,auth);this.store.assertActorActive(actor);current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);assertGoogleAdsScope(current);new ScopeGuard(this.registry,this.store).authorize(read,current);return response;
   });status=verified.status;checks=verified.checks;
  }else if(xTargetingBatchRoute(plan)||linkedinTemplateKind(plan)){
   let credentialHash:string|undefined;
   const verified=await (linkedinTemplateKind(plan)?verifyLinkedInTemplate:verifyXTargetingBatch)(plan,result,review.state,async read=>{
    if(!independentlyReadOnly(read))bad('Targeting verification must remain read-only.','VERIFICATION_UNSUPPORTED');
    const access=()=>{this.store.assertActorActive(actor);const current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);new ScopeGuard(this.registry,this.store).authorize(read,current);if(credentialHash&&sha256(stable(this.store.credentials(actor.tenantId,current.id)))!==credentialHash)bad('The selected login changed during targeting verification.','REAUTHORIZATION_REQUIRED');return current;};
    const current=access(),auth=await this.credentials.get(current);credentialHash??=sha256(stable(auth));access();const response=await this.request(actor,read,current,auth);access();return response;
   });status=verified.status;checks=verified.checks;
  }else if(xDraftKind(plan)){
   const verified=await verifyXDraft(plan,result,review.state,async read=>{
    if(!independentlyReadOnly(read))bad('Draft verification must remain read-only.','VERIFICATION_UNSUPPORTED');
    this.store.assertActorActive(actor);let current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);new ScopeGuard(this.registry,this.store).authorize(read,current);
    const auth=await this.credentials.get(current);this.store.assertActorActive(actor);current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);new ScopeGuard(this.registry,this.store).authorize(read,current);
    const response=await this.request(actor,read,current,auth);this.store.assertActorActive(actor);new ScopeGuard(this.registry,this.store).authorize(read,this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id));return response;
   });status=verified.status;checks=verified.checks;
  }else if(xCreativeKind(plan)){
   for(let attempt=0;attempt<3;attempt++){
    if(attempt)await delay(attempt*250);
    const verified=await verifyXCreative(plan,result,async read=>{
     if(!independentlyReadOnly(read))bad('X verification must remain read-only.','VERIFICATION_UNSUPPORTED');
     this.store.assertActorActive(actor);const current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);new ScopeGuard(this.registry,this.store).authorize(read,current);
     const auth=await this.credentials.get(current);this.store.assertActorActive(actor);this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);
     const response=await this.request(actor,read,current,auth);this.store.assertActorActive(actor);this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);return response;
    });status=verified.status;checks=verified.checks;
    if(!xPromotion(plan)||status!=='pending')break;
   }
  }else{reads=verificationReads(plan,result,this.registry,review.state);for(const item of reads){
   if(linkedinDSC(plan)){item.read.scopeContext={linkedinPostReviewId:reviewId};item.read.query={viewContext:'AUTHOR'};}
   if(!obj(item.expected)||!Object.keys(item.expected).length||!independentlyReadOnly(item.read))bad('No complete configuration read contract exists for this write.','VERIFICATION_UNSUPPORTED');
   const expected=normalize(item.expected),readback=await readConsistently(async()=>{
    this.store.assertActorActive(actor);checkAppleAccounts();const current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);new ScopeGuard(this.registry,this.store).authorize(item.read,current);
    const auth=await this.credentials.get(current);this.store.assertActorActive(actor);new ScopeGuard(this.registry,this.store).authorize(item.read,this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id));
    let response;try{response=await readGoogleCustomerSettings(item.read,settingsPage=>readGoogleAutoAssets(settingsPage,autoAssetPage=>readGoogleUploads(autoAssetPage,uploadPage=>readGoogleExperiments(uploadPage,experimentPage=>readDV360InventoryGroup(experimentPage,inventoryPage=>readCriteoOverrides(inventoryPage,overridePage=>readLinkedInMessage(overridePage,messagePage=>readXCurated(messagePage,curatedPage=>readGoogleDrafts(curatedPage,draftPage=>readXAssociations(draftPage,xAssociationPage=>readLinkedInThirdParty(xAssociationPage,thirdPartyPage=>readXTrackingTags(thirdPartyPage,xTagPage=>readDV360LineItemDuplicate(xTagPage,copyLinePage=>readGoogleCustomerTypes(copyLinePage,typePage=>readSnapchatMediaCopy(typePage,copyPage=>readDV360LineItemBulk(copyPage,bulkPage=>readGoogleBrandGuidelines(bulkPage,brandPage=>readLinkedInTracking(brandPage,trackingPage=>readLinkedInRules(trackingPage,rulePage=>readLinkedInConversions(rulePage,linkPage=>readGoogleBidState(linkPage,bidPage=>readMetaLabels(bidPage,metaPage=>readCriteoTargeting(metaPage,criteoPage=>readGtmWorkspace(criteoPage,workspacePage=>readGtmWorkflow(workspacePage,gtmPage=>readDV360List(gtmPage,listPage=>readDV360Targeting(listPage,targetingPage=>readTiktokNegativeKeywords(targetingPage,negativePage=>readCriteoLineItems(negativePage,lineItemPage=>readDV360AdGroups(lineItemPage,groupPage=>readDV360Ads(groupPage,async page=>{this.store.assertActorActive(actor);const latest=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);if(googleBidKind(plan))assertGoogleBidScope(latest);new ScopeGuard(this.registry,this.store).authorize(page,latest);const result=await this.request(actor,page,latest,auth);this.store.assertActorActive(actor);const current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);if(googleBidKind(plan))assertGoogleBidScope(current);new ScopeGuard(this.registry,this.store).authorize(page,current);return result;})))))))))))))))))))))))))))))));}catch(e){const absent=optionalMissingState(item.read,e);if(!absent)throw e;response=absent;}this.store.assertActorActive(actor);new ScopeGuard(this.registry,this.store).authorize(item.read,this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id));validateState(item.read,response);
    checkAppleAccounts();return normalize(entity(item.read,response.data as JsonObject));
   },actual=>differing(expected,actual).length===0);
   const actual=readback.value,changed=differing(expected,actual),acknowledged=item.acknowledged??{},unacknowledged=Object.entries(acknowledged).filter(([,v])=>differing(normalize(v.sent),normalize(v.echoed)).length).map(([k])=>'/'+k);
   const measured=readback.consistent?measurementVerificationPhase(item.read,actual):'inconclusive',phase=measured==='verified'&&unacknowledged.length?'inconclusive':measured;
   checks.push({resource_id:item.id,status:phase,code:phase==='inconclusive'?'VERIFICATION_INCONCLUSIVE':undefined,read_attempts:readback.attempts,changed_fields:changed,expected_hash:fingerprint(expected),actual_hash:fingerprint(actual??null),checked_fields:Object.keys(expected),...(Object.keys(acknowledged).length?{acknowledged_fields:Object.keys(acknowledged),acknowledgment:'The native read never returns these fields; they are compared with the provider write response.',...(unacknowledged.length?{unacknowledged_fields:unacknowledged}:{})}:{}),...(item.unobservable?.length?{unobservable_fields:item.unobservable,unobservable:'Neither the write response nor any native read returns these sent fields, so they cannot be compared.'}:{})});
   if(linkedinDSC(plan)&&readback.consistent)rememberLinkedInPost(this.store,this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id),plan,result.headers['x-restli-id']);
   if(metaLabelKind(plan)&&readback.consistent&&item.expected.label?.present===true){const current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);assertMetaLabelScope(current);this.store.rememberResource(current,plan.accountId!,item.id);}
   if(criteoLineItemKind(plan)==='create'&&readback.consistent&&typeof (actual as JsonObject)?.line?.id==='string'){const current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);assertCriteoLineItemScopes(current);this.store.rememberResource(current,plan.accountId!,'criteo-report-target/line-items/'+(actual as JsonObject).line.id);}
  }status=reads.length?(checks.some(c=>c.status==='failed')?'failed':checks.every(c=>c.status==='verified')?'verified':checks.some(c=>c.status==='pending')?'pending':'inconclusive'):'unsupported';}}
  catch(e){if(redditPostCreation(plan)&&e instanceof MirrorError&&e.retryable)status='pending';checks.push({status:status==='pending'?'pending':'unverified',code:e instanceof MirrorError?e.code:'READ_FAILED',message:e instanceof MirrorError?e.message:'Verification read failed.'});}
  this.store.assertActorActive(actor);const receipt={review_id:reviewId,connection_id:c.id,account_id:plan.accountId,action:plan.action,status,...(status==='inconclusive'?{code:'VERIFICATION_INCONCLUSIVE'}:{}),checks,checked_at:Date.now(),automatic_retry_of_mutation:false,recovery:'Preserve successful resources. Field disagreement after bounded reads is inconclusive, not permission to repeat a mutation. Corrective writes need a new review; verification never resets idempotency.',...(['pending','inconclusive'].includes(status)?{retry_read_after_ms:criteoReportKind(plan)?6000:1000,next_call:{tool:'amcp_campaign',arguments:{action:'verify',review_id:reviewId}}}:{})};
  if(resources.length)Object.assign(receipt,{verified_resources:resources});
  this.store.putDocument(actor.tenantId,'write_verification',reviewId,receipt);audit(this.store,actor,'write_verification',{connection_id:c.id,account_id:plan.accountId,review_id:reviewId,status});return receipt;
 }
}
