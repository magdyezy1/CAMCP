import {authorizeCriteoCampaign} from './criteo-campaign-writes.js';
import {authorizeCriteoLineItem} from './criteo-auction-line-items.js';
import {authorizeCriteoPreferred} from './criteo-preferred-line-items.js';
import {authorizeCriteoCatalog} from './criteo-catalog-requests.js';
import {authorizeCriteoOverride} from './criteo-budget-overrides.js';
import {authorizeCriteoPromotedProducts} from './criteo-promoted-products.js';
import {authorizeCriteoLineItemBidding} from './criteo-line-item-bidding.js';
import {authorizeMetaReportRead,assertMetaReportScope} from './meta-insights-jobs.js';
import {authorizeXReport} from './x-report-jobs.js';
import {authorizeTiktokReport} from './tiktok-report-jobs.js';
import {authorizeCriteoReport,observeCriteoReportTargets,assertCriteoReportScopes} from './criteo-report-jobs.js';
import {authorizePlaceActionRead} from './google-place-action-links.js';
import {authorizePlaceActionDiscovery} from './google-place-action-discovery.js';
import {authorizeBusinessAccessRead} from './google-business-access.js';
import type {CompiledRequest,Connection,JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {Registry} from './catalog.js';
import {Store} from './store.js';
import {stable} from './security.js';
import {microsoftGateway,microsoftCustomer,microsoftContracts} from './microsoft-native.js';
import {microsoftReportKey} from './microsoft-report-download.js';
import {authorizeLinkedInSpecial} from './linkedin-posts.js';
import {authorizeRedditPostRead,redditPostCreation} from './reddit-post-creation.js';
import {googleGlobalReadMethods} from './execution-risk.js';
import {authorizeQualifiedProviderRead} from './provider-read-contracts.js';
import {authorizeDV360TargetingSearch} from './dv360-targeting-search.js';
import {authorizeDV360AudienceRead} from './dv360-audiences.js';
import {authorizeDV360InventoryGroup} from './dv360-inventory-source-groups.js';
import {authorizeDV360Bidding} from './dv360-custom-bidding.js';
import {authorizeDV360Sdf} from './dv360-sdf-downloads.js';
import {authorizeXAudienceEstimate} from './x-audience-estimate.js';
import {authorizeCriteoInternalRead,assertCriteoReadScope} from './criteo-targeting-writes.js';
import {assertGoogleGenerationScope} from './google-generation.js';
import {assertMetaLabelScope,metaLabelIdentities} from './meta-label-writes.js';
import {authorizeLinkedInConversion} from './linkedin-conversion-links.js';
import {authorizeSnapchatMediaCopyRead} from './snapchat-media-copy.js';
import {authorizeLinkedInTracking} from './linkedin-tracking-parameters.js';
import {authorizeLinkedInThirdParty} from './linkedin-third-party-tracking.js';
import {authorizeLinkedInInsight} from './linkedin-insight-tags.js';
import {authorizeLinkedInAb} from './linkedin-ab-tests.js';
import {authorizeSnapConversion} from './snapchat-custom-conversions.js';
import {authorizeSnapProductSet} from './snapchat-product-sets.js';
import {authorizeLinkedInDomain} from './linkedin-insight-domains.js';
import {authorizeSnapTemplate} from './snapchat-dynamic-templates.js';
import {authorizeSnapEvent} from './snapchat-event-details.js';
import {authorizeSnapPixelName} from './snapchat-pixel-names.js';
import {authorizeLinkedInPublisher} from './linkedin-publisher-restrictions.js';
import {authorizeDV360BiddingFile} from './dv360-custom-bidding-files.js';
import {authorizeMetaPixel} from './meta-pixels.js';
import {authorizeLinkedInLeadFormState} from './linkedin-lead-form-states.js';
import {authorizeLinkedInDelete} from './linkedin-entity-deletes.js';
import {authorizeMetaSplitTest} from './meta-split-tests.js';
import {authorizeLinkedInDscEdit} from './linkedin-dsc-edits.js';
import {authorizeLinkedInMessage} from './linkedin-message-ads.js';
import {authorizeLinkedInTemplate} from './linkedin-audience-templates.js';
import {authorizeLinkedInRule} from './linkedin-conversion-rules.js';
import {authorizeLinkedInLeadForm,observeLinkedInLeadForms} from './linkedin-lead-forms.js';
import {metaAdLibraryRead} from './meta-ad-library.js';
import {assertGoogleBidScope} from './google-bid-modifiers.js';
import {assertGoogleAdsScope} from './google-contracts.js';
import {googleSegmentResource,googleSegmentKind} from './google-custom-segments.js';
import {metaCopyKind,metaCopiedIds} from './meta-copies.js';

export function normalizeAccount(gateway:string,id:unknown):string{
 const value=String(id);return gateway==='meta_native_action'?value.replace(/^act_/,''):gateway==='google_ads_native_action'?value.replaceAll('-',''):value;
}
const accountFields:Record<string,Set<string>>={
 microsoft_ads_native_action:new Set(['AccountId','AccountIds','CustomerAccountId']),
 meta_native_action:new Set(['account_id','ad_account_id']),
 google_ads_native_action:new Set(['customer_id','customerId']),
 tiktok_native_action:new Set(['advertiser_id','advertiser_ids']),
 snapchat_native_action:new Set(['ad_account_id','ad_account_ids']),
 linkedin_native_action:new Set(['ad_account_id','account_id']),
 apple_ads_native_action:new Set(['adAccountId','account_id','ad_account_id']),
 x_ads_native_action:new Set(['account_id']),dv360_native_action:new Set(['advertiserId','advertiser_id']),reddit_native_action:new Set(['ad_account_id','account_id'])
};
function mismatch(field:string):never{throw new MirrorError('ACCOUNT_SCOPE_MISMATCH','The final request targets a resource outside the selected account binding.',{field},403);}

/** This guard runs on every final page, before token refresh or authenticated egress. */
/** The global Snapchat entity that scopes a path (campaigns/<id>, adsquads/<id>, …), as held in resource ownership. */
export function snapchatScopedResource(path:string):string|undefined{
 let decoded:string;try{decoded=decodeURIComponent(path);}catch{return undefined;}
 return /^\/v1\/(campaigns|adsquads|ads|creatives|media|pixels|lead_generation_forms|segments)\/([^/]+)/.exec(decoded)?.slice(1).join('/');
}
export class ScopeGuard {
 constructor(private registry:Registry,private store:Store){}
 authorize(plan:CompiledRequest,connection:Connection):string{
  if(connection.gateway!==plan.gateway)throw new MirrorError('ACCOUNT_SCOPE_MISMATCH','Connection gateway does not match request.',{},403);
  if(metaAdLibraryRead(plan))return 'public_ad_library';
  const id=normalizeAccount(plan.gateway,plan.accountId??(connection.accounts.length===1?connection.accounts[0]:''));
  if(!id||!connection.accounts.some(a=>normalizeAccount(plan.gateway,a)===id))throw new MirrorError('ACCOUNT_REQUIRED','Select an explicitly bound account for this request.',{},403);
  let decoded:string;try{decoded=decodeURIComponent(plan.path);}catch{throw new MirrorError('INVALID_PATH','Malformed path encoding.');}
  const compare=(value:unknown,field:string)=>{for(const item of Array.isArray(value)?value:[value])if(normalizeAccount(plan.gateway,item)!==id)mismatch(field);};
  const walk=(value:unknown,field='$'):void=>{
   // Customer-level RPCs use customers/{id}:method. The colon ends the ID,
   // just like the slash in customers/{id}/resources; it is not account data.
   if(typeof value==='string'&&plan.gateway==='google_ads_native_action')for(const m of value.matchAll(/\bcustomers\/([^/:\s'"),]+)/g))compare(m[1],field);
   if(typeof value==='string'&&plan.gateway==='linkedin_native_action')for(const m of value.matchAll(/urn:li:sponsoredAccount:(\d+)/g))compare(m[1],field);
   if(Array.isArray(value)){value.forEach(v=>walk(v,field));return;}
   if(value&&typeof value==='object'&&plan.gateway==='snapchat_native_action'&&plan.method==='PATCH'){
    const patch=value as JsonObject;if(typeof patch.path==='string'&&accountFields[plan.gateway]?.has(patch.path.split('/').at(-1)!)){
     if(patch.op==='remove'||patch.value===undefined)mismatch('account patch');compare(patch.value,'account patch');
    }
   }
   if(value&&typeof value==='object')for(const [key,v]of Object.entries(value)){
    if(/^(?:access_token|oauth_token|refresh_token|client_secret|developer_token|authorization)$/i.test(key))throw new MirrorError('CREDENTIAL_PARAMETER_FORBIDDEN','Credentials must come from the encrypted connection provider.',{field:key},403);
    if(accountFields[plan.gateway]?.has(key)){
     let candidate=v;if(typeof v==='string'&&v.startsWith('[')){try{candidate=JSON.parse(v);}catch{mismatch(key);}}
     compare(candidate,key);
    }
    walk(v,field+'.'+key);
   }
  };
  walk(plan.query);walk(plan.body);walk(decoded,'path');
  assertGoogleGenerationScope(plan,connection);
  if(plan.gateway==='google_ads_native_action'&&plan.action==='AMCP_GOOGLE_BID_READ')assertGoogleBidScope(connection);
  if(googleSegmentKind(plan)||plan.gateway==='google_ads_native_action'&&plan.action==='AMCP_CONFIG_READ'&&googleSegmentResource(plan.googleState?.resource??''))assertGoogleAdsScope(connection);
  if(plan.gateway==='meta_native_action'&&(plan.action==='AMCP_META_LABEL_READ'||plan.method==='GET'&&/^\/v25\.0\/act_\d+\/adlabels$/.test(plan.path)))assertMetaLabelScope(connection);
  if(plan.gateway==='criteo_native_action'&&plan.action==='AMCP_CRITEO_TARGET_READ')assertCriteoReadScope(connection);
  if(plan.gateway==='criteo_native_action'&&plan.action==='AMCP_CRITEO_REPORT_READ')assertCriteoReportScopes(connection);
  if(authorizeCriteoCampaign(plan,connection,this.store,id))return id;
  if(authorizeCriteoLineItem(plan,connection,this.store,id))return id;
  if(authorizeCriteoPreferred(plan,connection,this.store,id))return id;
  if(authorizeCriteoCatalog(plan,connection,this.store,id))return id;
  if(authorizeCriteoOverride(plan,connection,this.store,id))return id;
  if(authorizeCriteoPromotedProducts(plan,connection,this.store,id))return id;
  if(authorizeCriteoLineItemBidding(plan,connection,this.store,id))return id;
  if(authorizeXReport(plan,connection,this.store,id))return id;
  if(authorizeTiktokReport(plan,connection,this.store,id))return id;
  if(authorizeCriteoReport(plan,connection,this.store,id))return id;
  if(authorizeQualifiedProviderRead(plan,connection,id))return id;
  if(authorizePlaceActionRead(plan,connection,id))return id;
  if(authorizePlaceActionDiscovery(plan,connection,id))return id;
  if(authorizeBusinessAccessRead(plan,connection,id))return id;
  if(authorizeDV360TargetingSearch(plan,connection,id))return id;
  if(authorizeDV360AudienceRead(plan,connection,id))return id;
  if(authorizeDV360InventoryGroup(plan,connection,id))return id;
  if(authorizeDV360Bidding(plan,connection,id))return id;
  if(authorizeDV360Sdf(plan,connection,this.store,id))return id;
  if(authorizeXAudienceEstimate(plan,connection,id))return id;
  if(authorizeLinkedInTemplate(plan,connection,id))return id;
  if(authorizeLinkedInConversion(plan,connection,id))return id;
  if(authorizeSnapchatMediaCopyRead(plan,connection,id))return id;
  if(authorizeLinkedInTracking(plan,connection,id))return id;
  if(authorizeLinkedInThirdParty(plan,connection,id))return id;
  if(authorizeLinkedInInsight(plan,connection,id))return id;
  if(authorizeLinkedInAb(plan,connection,id))return id;
  if(authorizeSnapConversion(plan,connection,id))return id;
  if(authorizeSnapProductSet(plan,connection,id))return id;
  if(authorizeLinkedInDomain(plan,connection,id))return id;
  if(authorizeSnapTemplate(plan,connection,id))return id;
  if(authorizeSnapEvent(plan,connection,id))return id;
  if(authorizeSnapPixelName(plan,connection,id))return id;
  if(authorizeLinkedInPublisher(plan,connection,id))return id;
  if(authorizeDV360BiddingFile(plan,connection,id))return id;
  if(authorizeMetaPixel(plan,connection,id))return id;
  if(authorizeLinkedInLeadFormState(plan,connection,id))return id;
  if(authorizeLinkedInDelete(plan,connection,id))return id;
  if(authorizeMetaSplitTest(plan,connection,id))return id;
  if(authorizeLinkedInDscEdit(plan,connection,this.store,id))return id;
  if(authorizeLinkedInMessage(plan,connection,id))return id;
  if(authorizeLinkedInRule(plan,connection,id))return id;
  if(authorizeLinkedInLeadForm(plan,connection,this.store,id))return id;
  if(authorizeCriteoInternalRead(plan,connection,id))return id;
  if(plan.gateway==='google_ads_native_action'&&plan.readOnly&&plan.method==='POST'&&/^\/v23:[A-Za-z]+$/.test(decoded)&&googleGlobalReadMethods.has(decoded.slice(5)))return id;
  if(plan.gateway==='meta_native_action'&&plan.action==='AMCP_META_REPORT_READ')assertMetaReportScope(connection);
  if(authorizeMetaReportRead(plan,connection,this.store,id))return id;
  if(authorizeLinkedInSpecial(plan,connection,this.store,id))return id;
  if(authorizeRedditPostRead(plan,connection,this.store,id))return id;
  const patterns:Record<string,RegExp>={
   google_ads_native_action:/\/customers\/([^/:]+)/,
   meta_native_action:/^\/v[^/]+\/act_([^/]+)/,
   snapchat_native_action:/^\/v1\/adaccounts\/([^/]+)/,
   linkedin_native_action:/^\/rest\/(?:adAccounts|adAccountTrustPreferences)\/([^/]+)/,
   x_ads_native_action:/\/accounts\/([^/]+)/,
   dv360_native_action:/\/advertisers\/([^/:]+)/
   ,ga4_native_action:/\/properties\/([^/:]+)/,gtm_native_action:/\/accounts\/([^/:]+)/,criteo_native_action:/\/accounts\/([^/:]+)/,reddit_native_action:/^\/api\/v3\/ad_accounts\/([^/]+)/
  };
  const match=patterns[plan.gateway]?.exec(decoded);
  if(match){compare(match[1],'path');return id;}
  if(plan.gateway==='google_search_console_native_action'){
   const site=/\/sites\/([^/]+)/.exec(plan.path)?.[1];
   const value=site?decodeURIComponent(site):(plan.body as JsonObject)?.siteUrl;
   if(value!==undefined){compare(value,'siteUrl');return id;}
  }
  if(plan.gateway==='google_business_native_action'){
   const account=/\/accounts\/([^/:]+)/.exec(decoded)?.[1];if(account){compare(account,'path');return id;}
   const location=/\/locations\/([^/:]+)/.exec(decoded)?.[1];if(location&&id.startsWith('locations/')){compare('locations/'+location,'path');return id;}
  }
  if(plan.gateway==='linkedin_native_action'&&['/rest/adAnalytics','/rest/audienceCounts'].includes(decoded)){
   const value=plan.query.accounts??plan.query.account;
   if(typeof value==='string'){
    let decodedValue:string;try{decodedValue=decodeURIComponent(value);}catch{mismatch('account filter');}
    const filter=/^(?:List\()?urn:li:sponsoredAccount:(\d+)\)?$/.exec(decodedValue);
    if(filter){compare(filter[1],'account filter');return id;}
   }
  }
  if(plan.gateway==='tiktok_native_action'){
   if(plan.readOnly&&plan.method==='GET'&&['/v1.3/report/integrated/get/','/v1.3/campaign/get/'].includes(decoded)&&plan.query.advertiser_id===id)return id;
   if(plan.readOnly&&decoded==='/v1.3/advertiser/info/'&&Array.isArray(plan.query.advertiser_ids)&&plan.query.advertiser_ids.length===1){compare(plan.query.advertiser_ids,'advertiser_ids');return id;}
   // /page/get/ takes advertiser_id or a Business Center library_id; only the advertiser's own pages are in scope.
   if(plan.readOnly&&plan.method==='GET'&&decoded==='/v1.3/page/get/'&&plan.query.advertiser_id===id&&plan.query.library_id===undefined)return id;
   const action=this.registry.action(plan.gateway,plan.action);
   // Some Business Center routes ignore advertiser_id. Only vendor-declared required
   // advertiser parameters establish this automatic boundary.
   if(action?.required.includes('advertiser_id')&&((plan.query.advertiser_id===id)||(plan.body as JsonObject)?.advertiser_id===id))return id;
  }
  if(plan.gateway===microsoftGateway){
   microsoftCustomer(connection,id);
   const contract=microsoftContracts.get(plan.action);if(!contract||contract.path!==plan.path||contract.method!==plan.method)throw new MirrorError('RESOURCE_SCOPE_REQUIRED','Unqualified Microsoft request contract.',{},403);
   const body=plan.body as JsonObject;
   if(plan.action==='PollGenerateReport'){
    let receipt:JsonObject|undefined;try{receipt=this.store.document(connection.tenantId,'microsoft_report',microsoftReportKey(connection.id,id,body.ReportRequestId));}catch(e){if(!(e instanceof MirrorError)||e.code!=='NOT_FOUND')throw e;}
    const ownsReport=receipt?.connection_id===connection.id&&receipt.account_id===id&&receipt.expires_at>Date.now();
    if(!ownsReport&&!this.store.ownsResource(connection,id,'report/'+body.ReportRequestId))throw new MirrorError('RESOURCE_SCOPE_REQUIRED','Submit the Microsoft report using this account and connection before polling.',{},403);
   }
   // Mandatory CustomerAccountId header confines CampaignManagement resources;
   // report scope is additionally validated by the compiler and caller cannot override headers.
   return id;
  }
  if(['amazon_native_action','apple_ads_native_action'].includes(plan.gateway))return id; // account header scope is mandatory in transport
  if(plan.gateway==='reddit_native_action'){
   if(['/api/v3/time_zones','/api/v3/targeting/interests','/api/v3/targeting/geolocations','/api/v3/targeting/communities/search'].includes(decoded)&&plan.readOnly)return id;
   if(decoded==='/api/v3/me/businesses'&&plan.query.ad_account_id===id)return id;
   const entity=/^\/api\/v3\/(campaigns|ad_groups|ads|profiles|saved_audiences|lead_gen_forms|posts|structured_posts|funding_instruments)\/([^/]+)/.exec(decoded);
   if(entity&&this.store.ownsResource(connection,id,entity[1]+'/'+entity[2]))return id;
  }
  // Global object paths need an ownership observation from an account-scoped list.
  if(plan.gateway==='criteo_native_action'){
   const line=/^\/2026-01\/retail-media\/preferred-line-items\/(\d+)(?:\/targeting\/(?:audiences|stores|add-to-basket)(?:\/(?:append|delete))?)?$/.exec(decoded)?.[1];
   if(line&&this.store.ownsResource(connection,id,'preferred-line-items/'+line))return id;
  }
  const resource=plan.gateway==='meta_native_action'?/^\/v[^/]+\/([^/]+)/.exec(decoded)?.[1]:plan.gateway==='snapchat_native_action'?snapchatScopedResource(plan.path):undefined;
  if(resource&&this.store.ownsResource(connection,id,resource))return id;
  // Administrative provisioning can declare otherwise unscoped Business/Profile resources.
  for(const binding of connection.resourceBindings??[]){
   if(normalizeAccount(plan.gateway,binding.accountId)!==id)continue;
   if((decoded===binding.pathPrefix||decoded.startsWith(binding.pathPrefix+'/')||decoded.startsWith(binding.pathPrefix+':'))&&Object.entries(binding.query??{}).every(([k,v])=>stable(plan.query[k])===stable(v)))return id;
  }
  throw new MirrorError('RESOURCE_SCOPE_REQUIRED','Resource ownership is not established. Read its account-scoped collection first, or have an administrator provision an exact resource binding.',{gateway:plan.gateway,path:plan.path,account_id:id},403);
 }
 observe(plan:CompiledRequest,connection:Connection,data:unknown):void{
  if(!plan.readOnly)return;
  const id=this.authorize(plan,connection),d=data as JsonObject;
  observeCriteoReportTargets(plan,connection,this.store,data);
  observeLinkedInLeadForms(plan,connection,this.store,id,data);
  if(plan.gateway===microsoftGateway&&plan.action==='SubmitGenerateReport'&&typeof d?.ReportRequestId==='string'){
   this.store.rememberResource(connection,id,'report/'+d.ReportRequestId);
   this.store.db.prepare("DELETE FROM documents WHERE tenant_id=? AND kind='microsoft_report' AND json_extract(data,'$.expires_at')<=?").run(connection.tenantId,Date.now());
   this.store.putDocument(connection.tenantId,'microsoft_report',microsoftReportKey(connection.id,id,d.ReportRequestId),{connection_id:connection.id,account_id:id,request:(plan.body as JsonObject).ReportRequest,expires_at:Date.now()+86400000});
  }
  // Only named entity collections are ownership evidence; never learn from arbitrary
  // nested IDs, reports, user supplied state, search results or unscoped account lists.
  if(plan.gateway==='criteo_native_action'&&new RegExp('^/2026-01/retail-media/accounts/'+id+'/line-items$').test(plan.path)&&Array.isArray(d?.data)&&!d.error&&(!d.errors||Array.isArray(d.errors)&&!d.errors.length)){
   for(const row of d.data)if(typeof row?.id==='string'&&/^[1-9][0-9]*$/.test(row.id)&&row.attributes?.type==='preferred'&&typeof row.attributes?.campaignId==='string'&&/^[1-9][0-9]*$/.test(row.attributes.campaignId))this.store.rememberResource(connection,id,'preferred-line-items/'+row.id);
  }
  if(plan.gateway==='meta_native_action'&&/^\/v[^/]+\/act_[^/]+\/(campaigns|adsets|ads|adcreatives|customaudiences)$/.test(plan.path)&&Array.isArray(d?.data)){
   // Account audience lists also show audiences shared from other accounts; only rows naming this account are owned.
   const audiences=plan.path.endsWith('/customaudiences');
   for(const entity of d.data)if(typeof entity?.id==='string'&&/^\d+$/.test(entity.id)&&(!audiences||entity.account_id!==undefined&&normalizeAccount(plan.gateway,entity.account_id)===id))this.store.rememberResource(connection,id,entity.id);
  }
  // The account's value rule set list is ownership evidence for later edits and deletion of those sets by ID.
  if(plan.gateway==='meta_native_action'&&/^\/v25\.0\/act_\d+\/value_rule_set$/.test(plan.path)&&Array.isArray(d?.data)){
   for(const set of d.data)if(typeof set?.id==='string'&&/^\d+$/.test(set.id))this.store.rememberResource(connection,id,set.id);
  }
  if(plan.gateway==='meta_native_action'&&/^\/v25\.0\/act_\d+\/adlabels$/.test(plan.path)){
   const labels=metaLabelIdentities(d,id);for(const label of labels)this.store.rememberResource(connection,id,label);
  }
  if(plan.gateway==='snapchat_native_action'){
   const m=/^\/v1\/adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives|media|pixels|lead_generation_forms|segments)$/.exec(plan.path);
   const kind=m?.[1];if(kind&&Array.isArray(d?.[kind]))for(const wrapped of d[kind]){
    const entity=wrapped[kind==='media'?'media':kind.slice(0,-1)]??wrapped;
    // Account segment lists also show segments shared from other accounts; only the account's own are owned.
    if(typeof entity?.id==='string'&&/^[\w-]+$/.test(entity.id)&&(kind!=='segments'||entity.ad_account_id===id))this.store.rememberResource(connection,id,kind+'/'+entity.id);
   }
   // A read of an entity authorize() already required ownership for keeps that ownership fresh when the
   // provider names the owning account, or a parent this login still owns. It never learns a new ID.
   const single=/^\/v1\/(campaigns|adsquads|ads|creatives|media|lead_generation_forms|segments)\/([\w-]+)$/.exec(plan.path);
   if(single&&String(d?.request_status).toUpperCase()==='SUCCESS'){
    const kind=single[1]!,entity=d[kind]?.[0]?.[kind==='media'?'media':kind.slice(0,-1)],parentField=kind==='adsquads'?'campaign_id':kind==='ads'?'ad_squad_id':undefined;
    const confirmed=parentField?typeof entity?.[parentField]==='string'&&this.store.ownsResource(connection,id,(kind==='adsquads'?'campaigns/':'adsquads/')+entity[parentField]):entity?.ad_account_id===id;
    if(entity?.id===single[2]&&confirmed)this.store.rememberResource(connection,id,kind+'/'+single[2]);
   }
  }
  if(plan.gateway==='reddit_native_action'){
   const collection=/^\/api\/v3\/ad_accounts\/[^/]+\/(campaigns|ad_groups|ads|profiles|saved_audiences|lead_gen_forms|funding_instruments)$/.exec(plan.path)?.[1]??/^\/api\/v3\/profiles\/[^/]+\/(posts|structured_posts)$/.exec(plan.path)?.[1];
   if(collection&&Array.isArray(d?.data))for(const entity of d.data)if(typeof entity?.id==='string'&&/^[A-Za-z0-9_-]+$/.test(entity.id)&&(!entity.ad_account_id||entity.ad_account_id===id))this.store.rememberResource(connection,id,collection+'/'+entity.id);
  }
 }
 /** Called only after a verified successful mutation, never on caller-supplied data. */
 observeCreated(plan:CompiledRequest,connection:Connection,data:unknown):void{
  if(plan.readOnly||plan.method!=='POST')return;
  const id=normalizeAccount(plan.gateway,plan.accountId),d=data as JsonObject;
  if(plan.gateway==='reddit_native_action'){
   // Only an accepted, account/profile-bound original creation may authorize a job read.
   if(redditPostCreation(plan)?.structured&&typeof d?.data?.id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(d.data.id))this.store.rememberResource(connection,id,'structured_post_jobs/'+d.data.id);
   const kind=/^\/api\/v3\/ad_accounts\/[^/]+\/(campaigns|ad_groups|ads|saved_audiences|lead_gen_forms)$/.exec(plan.path)?.[1],entity=d?.data;
   if(kind&&typeof entity?.id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(entity.id)&&entity.ad_account_id===id)this.store.rememberResource(connection,id,kind+'/'+entity.id);
  }
  // Other qualified gateways carry the account in every child path/body. These two
  // use global IDs and therefore need this extra, connection-bound observation.
  if(plan.gateway==='meta_native_action'&&/^\/v[^/]+\/act_[^/]+\/(campaigns|adsets|ads|adcreatives|customaudiences)$/.test(plan.path)&&typeof d?.id==='string'&&/^\d+$/.test(d.id)){
   if(d.account_id!==undefined&&normalizeAccount(plan.gateway,d.account_id)!==id)return;
   this.store.rememberResource(connection,id,d.id);
  }
  // A Meta copy is made from an owned source inside the same account; verification then reads each copy's account.
  if(metaCopyKind(plan))for(const copied of metaCopiedIds(plan,d))this.store.rememberResource(connection,id,copied);
  if(plan.gateway==='snapchat_native_action'){
   const match=/^\/v1\/(?:adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives|media|lead_generation_forms|segments)|adaccounts\/[^/]+\/(media)_copy|campaigns\/[^/]+\/(adsquads)|adsquads\/[^/]+\/(ads))$/.exec(plan.path);
   const kind=match?.slice(1).find(Boolean);
   if(!kind||String(d?.request_status).toUpperCase()!=='SUCCESS'||!Array.isArray(d[kind]))return;
   for(const row of d[kind]){
    const entity=row[kind==='media'?'media':kind.slice(0,-1)];
    if(String(row.sub_request_status).toUpperCase()!=='SUCCESS'||typeof entity?.id!=='string'||!/^[-\w]+$/.test(entity.id))continue;
    if(entity.ad_account_id!==undefined&&entity.ad_account_id!==id)continue;
    const parent=/^\/v1\/(campaigns|adsquads)\/([^/]+)\//.exec(plan.path);
    if(parent&&entity[parent[1]==='campaigns'?'campaign_id':'ad_squad_id']!==undefined&&entity[parent[1]==='campaigns'?'campaign_id':'ad_squad_id']!==parent[2])continue;
    this.store.rememberResource(connection,id,kind+'/'+entity.id);
   }
  }
 }
}
