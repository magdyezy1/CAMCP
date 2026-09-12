import {MirrorError} from './errors.js';
import type {Actor,JsonObject} from './types.js';
import type {Registry} from './catalog.js';
import type {Store} from './store.js';
import {guardInput,stable} from './security.js';
import {auditCampaign,optimizationSuggestions,type CampaignAuditInput} from './campaign-audit.js';

/** Independently implemented workflow semantics. Captured action routes are evidence,
 * not evidence that these composite response envelopes match AMCP byte-for-byte. */
export const workflowEvidence='INDEPENDENT_DESIGN';
export interface NativeStep {gateway:string;input:JsonObject}
export interface WorkflowDependencies {
 registry:Registry;store:Store;
 /** Must compile and use MirrorService.runPlan: never a raw HTTP or credential shortcut. */
 runNative(gateway:string,input:JsonObject,actor:Actor):Promise<unknown>;
}
type Platform='google'|'linkedin'|'x'|'dv360';
type Entity='campaign'|'adset'|'ad'|'creative';
const gateways:Record<Platform,string>={google:'google_ads_native_action',linkedin:'linkedin_native_action',x:'x_ads_native_action',dv360:'dv360_native_action'};
const obj=(v:unknown):JsonObject=>v&&typeof v==='object'&&!Array.isArray(v)?structuredClone(v):{};
function unsupported(message:string,details:JsonObject={}):never{throw new MirrorError('WORKFLOW_UNSUPPORTED',message,details);}
function platform(value:unknown):Platform {
 const name=String(value??'').toLowerCase();const p=name==='google_ads'?'google':name==='twitter'?'x':name;
 if(['meta','tiktok','snapchat'].includes(p))throw new MirrorError('NATIVE_ONLY_PLATFORM','This platform uses its native gateway for campaign, audience, creative and reporting workflows.',{platform:p,gateway:p+'_native_action'});
 if(!Object.hasOwn(gateways,p))return unsupported('No independent generic workflow adapter is available for this platform.',{platform:p});return p as Platform;
}
function id(value:unknown,label='identifier'):string {if(typeof value!=='string'||!value||!/^[-A-Za-z0-9_~]+$/.test(value))throw new MirrorError('INVALID_IDENTIFIER','Use a nonempty string identifier without query syntax.',{field:label});return value;}
function numericId(value:unknown,label='identifier'):string{const s=id(value,label);if(!/^\d+$/.test(s))throw new MirrorError('INVALID_IDENTIFIER','Google and LinkedIn identifiers must contain digits only.',{field:label});return s;}
function account(p:Platform,value:unknown){return p==='google'?numericId(String(value??'').replaceAll('-',''),'account_id'):p==='linkedin'||p==='dv360'?numericId(value,'account_id'):id(value,'account_id');}
function limit(value:unknown,fallback=100,max=500){const n=value??fallback;if(!Number.isInteger(n)||Number(n)<1||Number(n)>max)throw new MirrorError('INVALID_LIMIT','Requested row limit is outside its supported range.');return Number(n);}
export function dateRange(value:unknown):{since:string;until:string}{
 const r=obj(value);for(const field of ['since','until'])if(typeof r[field]!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(r[field])||Number.isNaN(Date.parse(r[field]))||new Date(r[field]).toISOString().slice(0,10)!==r[field])throw new MirrorError('INVALID_DATE_RANGE','Use valid calendar dates in YYYY-MM-DD format.');
 if(r.since>r.until)throw new MirrorError('INVALID_DATE_RANGE','since must not be after until.');
 if(Date.parse(r.until)-Date.parse(r.since)>3660*86400000)throw new MirrorError('INVALID_DATE_RANGE','Split reporting ranges longer than ten years.');return {since:r.since,until:r.until};
}
function lastDays(days:number){const now=new Date();const end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-1));return {since:new Date(end.getTime()-(days-1)*86400000).toISOString().slice(0,10),until:end.toISOString().slice(0,10)};}
const googleResource:Record<string,[string,string]>={campaign:['campaigns','google_ads_v23_campaign_mutate_campaigns'],adset:['adGroups','google_ads_v23_ad_group_mutate_ad_groups'],ad:['adGroupAds','google_ads_v23_ad_group_ad_mutate_ad_group_ads'],asset_group:['assetGroups','google_ads_v23_asset_group_mutate_asset_groups'],asset_group_asset:['assetGroupAssets','google_ads_v23_asset_group_asset_mutate_asset_group_assets'],asset_group_signal:['assetGroupSignals','google_ads_v23_asset_group_signal_mutate_asset_group_signals'],asset_group_listing_group_filter:['assetGroupListingGroupFilters','google_ads_v23_asset_group_listing_group_filter_mutate_asset_group_listing_group_filters']};
function resource(acct:string,kind:string,value:unknown):string{
 const text=String(value??'');if(text.startsWith('customers/')){if(!new RegExp('^customers/'+acct+'/'+kind+'/[0-9~_-]+$').test(text))throw new MirrorError('ACCOUNT_SCOPE_MISMATCH','Resource name must belong to the requested customer and entity type.',{},403);return text;}
 return `customers/${acct}/${kind}/${id(value,'entity_id')}`;
}
function urn(type:string,value:unknown):string {const text=String(value??'');if(text.startsWith('urn:li:')){if(!new RegExp('^urn:li:'+type+':\\d+$').test(text))throw new MirrorError('INVALID_IDENTIFIER','Incorrect LinkedIn URN type.');return text;}return 'urn:li:'+type+':'+numericId(value);}
function safety(args:JsonObject,write:boolean):JsonObject{return {dry_run:write?args.dry_run!==false:args.dry_run===true,confirmed:args.confirmed===true,...(args.idempotency_key?{idempotency_key:args.idempotency_key}:{})};}
function step(p:Platform,action:string,acct:string,args:JsonObject,fields:JsonObject={},write=false):NativeStep{return {gateway:gateways[p],input:{action,...(p==='dv360'?{advertiserId:acct}:{account_id:acct}),...fields,...safety(args,write)}};}
function gaql(acct:string,query:string,args:JsonObject={},aggregate=true):NativeStep{return step('google','google_ads_v23_google_ads_search',acct,args,{payload:{query},aggregate_pages:aggregate,max_pages:100});}
function literal(value:string){return "'"+value.replaceAll('\\','\\\\').replaceAll("'","\\'")+"'";}
function fieldsMask(data:JsonObject):string {const out:string[]=[];const walk=(v:JsonObject,prefix='')=>{for(const [key,value]of Object.entries(v)){if(!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key))throw new MirrorError('INVALID_FIELD','Field names must be native identifiers.');if(['resource_name','resourceName'].includes(key))continue;const field=prefix+key;if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length)walk(value,field+'.');else out.push(field);}};walk(data);if(!out.length)throw new MirrorError('EMPTY_UPDATE','Provide at least one editable field.');return out.join(',');}
function nonemptyPayload(value:unknown){const body=obj(value);if(!Object.keys(body).length)throw new MirrorError('MISSING_PAYLOAD','A complete platform-native payload is required.');return body;}
function immutableUpdate(updates:JsonObject){for(const key of ['id','account','account_id','customer_id','advertiserId','campaign_id','campaign','campaignGroup','ad_group','adGroup','line_item_id','resource_name','resourceName','created_at','createdAt'])if(Object.hasOwn(updates,key))throw new MirrorError('IMMUTABLE_FIELD','Entity ownership and parent fields cannot be changed by generic updates.',{field:key,workaround:'Create a new paused entity under the intended parent.'});}
/** X has no targeting field on any entity: targeting is the separate targeting_criteria
 * resource, so a `targeting` object is accepted by the route and then dropped by X. */
function assertNoPhantomTargeting(p:Platform,data:JsonObject){if(p==='x'&&Object.hasOwn(data,'targeting'))throw new MirrorError('UNSUPPORTED_FIELD','X entities have no targeting field; targeting is the separate targeting_criteria resource.',{field:'targeting',workaround:'Create each criterion against /12/accounts/{account_id}/targeting_criteria as its own reviewed write.'});}

/** Form compilation is deliberately conservative: native fields remain available,
 * while ambiguous objectives, currencies and identifiers are never guessed. */
export function compileEntityPayload(pValue:unknown,type:string,dataValue:unknown,context:JsonObject={},operation='create'):JsonObject{
 const p=platform(pValue),data=nonemptyPayload(dataValue),acct=context.account_id?account(p,context.account_id):undefined;guardInput(data);
 if(context.merge_with_original){if(!context.original_data)throw new MirrorError('ORIGINAL_DATA_REQUIRED','Merging requires an explicit original_data snapshot.');Object.assign(data,{...obj(context.original_data),...data});}
 if(operation==='update')immutableUpdate(data);
 assertNoPhantomTargeting(p,data);
 const aliases=p==='google'?{campaign_id:'campaign',adset_id:'ad_group',adgroup_id:'ad_group',start_date:'start_date',end_date:'end_date',bid_amount_micros:'cpc_bid_micros'}:p==='linkedin'?{objective:'objectiveType',targeting:'targetingCriteria',bid_strategy:'biddingStrategy'}:p==='dv360'?{name:'displayName',status:'entityStatus'}:{};
 for(const [from,to]of Object.entries(aliases))if(from!==to&&data[from]!==undefined){if(data[to]!==undefined&&stable(data[from])!==stable(data[to]))throw new MirrorError('CONFLICTING_FIELDS','Form alias and native field disagree.',{from,to});data[to]=data[from];delete data[from];}
 if(p==='google'&&acct){if(data.campaign)data.campaign=resource(acct,'campaigns',data.campaign);if(data.ad_group)data.ad_group=resource(acct,'adGroups',data.ad_group);}
 if(operation==='create'&&['campaign','adset','ad','asset_group'].includes(type)){
  if(p==='google')data.status='PAUSED';
  if(p==='linkedin')data.status=type==='campaign'?'DRAFT':'PAUSED';
  if(p==='x'){if(type==='ad')delete data.status;else data.entity_status='PAUSED';}
  if(p==='dv360')data.entityStatus='ENTITY_STATUS_PAUSED';
 }
 return {platform:p,entity_type:type,operation,payload:data,evidence:workflowEvidence,validation:{kind:'local structural compilation',platform_validated:false},warnings:p==='linkedin'&&type==='campaign'&&operation==='create'?['LinkedIn campaign groups support DRAFT creation; DRAFT is the non-serving equivalent used here.']:[]};
}

export function compileEntityMutation(operation:string,args:JsonObject):NativeStep {
 const p=platform(args.platform),acct=account(p,args.account_id);let entity:String|string=operation==='create_campaign'?'campaign':operation==='create_adset'?'adset':operation==='create_ad'?'ad':operation==='create_creative'?'creative':args.entity_type;
 const type=String(entity);if(!['campaign','adset','ad','creative',...Object.keys(googleResource)].includes(type))return unsupported('Unsupported entity type.',{entity_type:type});
 const create=operation.startsWith('create_'),remove=operation==='delete_entity';
 let payload=create?obj(args.payload):obj(args.updates);
 if(operation==='set_entity_status'||operation==='publish_campaign'){const raw=operation==='publish_campaign'?'ACTIVE':String(args.status).toUpperCase();const status=p==='google'?raw==='ACTIVE'?'ENABLED':raw==='DISABLE'?'PAUSED':raw:p==='dv360'?raw.startsWith('ENTITY_STATUS_')?raw:'ENTITY_STATUS_'+raw:raw;payload={[p==='x'?'entity_status':p==='dv360'?'entityStatus':'status']:status};}
 if(operation==='create_campaign'){
  if(args.autofill_from_history)return unsupported('Historical autofill requires a verified campaign snapshot compiler; provide explicit platform_form_data.');
  if(args.daily_budget!==undefined&&args.lifetime_budget!==undefined)throw new MirrorError('INVALID_BUDGET','Daily and lifetime budgets cannot be combined.');
  if(args.lifetime_budget!==undefined&&!args.end_date)throw new MirrorError('END_DATE_REQUIRED','A lifetime budget requires end_date.');
  if(args.start_date&&args.end_date)dateRange({since:args.start_date,until:args.end_date});
  payload={...obj(args.platform_form_data),name:args.name};
  if(args.targeting&&Object.keys(args.targeting).length)return unsupported('Campaign targeting is not implicitly translated. Create native targeting criteria or set targeting on the child entity.');
  if(p==='google'){
   if(!payload.advertising_channel_type&&!payload.advertisingChannelType)throw new MirrorError('CHANNEL_REQUIRED','Provide advertising_channel_type in platform_form_data; a business objective is not an API channel.');
   if(args.start_date)payload.start_date=args.start_date;if(args.end_date)payload.end_date=args.end_date;
   if(args.lifetime_budget!==undefined)return unsupported('Google lifetime budget needs an explicitly supported channel/budget contract; use a native campaign budget.');
   if(args.daily_budget!==undefined){
    if(payload.currency_code!=='USD')throw new MirrorError('CURRENCY_REQUIRED','Generic daily_budget is USD. Set platform_form_data.currency_code to USD only after verifying the account currency, or supply an existing native campaign_budget.');
    delete payload.currency_code;payload.status='PAUSED';const budgetName=`customers/${acct}/campaignBudgets/-1`;payload.campaign_budget=budgetName;
    const amount=Math.round(Number(args.daily_budget)*1e6);if(!Number.isSafeInteger(amount)||amount<=0)throw new MirrorError('INVALID_BUDGET','Budget cannot be represented safely in micros.');
    return step(p,'google_ads_v23_google_ads_mutate',acct,args,{payload:{mutate_operations:[{campaign_budget_operation:{create:{resource_name:budgetName,name:args.name+' budget',amount_micros:String(amount),delivery_method:'STANDARD',explicitly_shared:false}}},{campaign_operation:{create:payload}}],partial_failure:false}},true);
   }
   if(!payload.campaign_budget&&!payload.campaignBudget)throw new MirrorError('BUDGET_REQUIRED','Provide the existing campaign_budget resource name or an explicit USD daily_budget.');
  }else if(p==='linkedin'){
   payload.account=urn('sponsoredAccount',acct);if(args.start_date)payload.runSchedule={...obj(payload.runSchedule),start:Date.parse(args.start_date+'T00:00:00Z')};if(args.end_date)payload.runSchedule={...obj(payload.runSchedule),end:Date.parse(args.end_date+'T23:59:59Z')};
   if(args.daily_budget!==undefined)return unsupported('LinkedIn campaign groups do not accept a daily budget; set dailyBudget on create_adset.');
   if(args.lifetime_budget!==undefined)payload.totalBudget={amount:String(args.lifetime_budget),currencyCode:'USD'};
  }else if(p==='x'){
   if(!payload.funding_instrument_id)throw new MirrorError('FUNDING_INSTRUMENT_REQUIRED','Provide funding_instrument_id in platform_form_data.');
   if(args.start_date)payload.start_time=args.start_date+'T00:00:00Z';if(args.end_date)payload.end_time=new Date(Date.parse(args.end_date)+86400000).toISOString();
   for(const [key,dest]of [['daily_budget','daily_budget_amount_local_micro'],['lifetime_budget','total_budget_amount_local_micro']])if(args[key!]!==undefined){if(payload.currency_code!=='USD')throw new MirrorError('CURRENCY_REQUIRED','Generic budgets are USD. Provide a verified USD currency_code or native local-micro budget fields.');payload[dest!]=String(Math.round(Number(args[key!])*1e6));}delete payload.currency_code;
  }else {payload.displayName=payload.name;delete payload.name;if(args.daily_budget!==undefined||args.lifetime_budget!==undefined)return unsupported('DV360 serving budgets belong to insertion orders and line items; supply explicit native campaignBudgets for planned spend.');if(!payload.campaignGoal)throw new MirrorError('CAMPAIGN_GOAL_REQUIRED','Provide the native campaignGoal in platform_form_data.');}
 }
 if(!remove&&!create)immutableUpdate(payload);
 if(!remove&&!Object.keys(payload).length)throw new MirrorError('EMPTY_UPDATE','Provide a nonempty native payload.');
 if(args.payload_mode==='form'||create)payload=compileEntityPayload(p,type,payload,{account_id:acct},create?'create':'update').payload;
 assertNoPhantomTargeting(p,payload);
 const entityId=args.entity_id??args.campaign_id;
 if(p==='google'){
  const route=googleResource[type];if(!route)return unsupported('Use AssetService for standalone Google assets.');
  if(create&&type==='adset'){if(!args.parent_id&&!payload.campaign)throw new MirrorError('PARENT_REQUIRED','An ad group requires its campaign parent.');payload.campaign=resource(acct,'campaigns',args.parent_id??payload.campaign);}
  if(create&&type==='ad'){if(!args.parent_id&&!payload.ad_group)throw new MirrorError('PARENT_REQUIRED','An ad requires its ad group parent.');payload.ad_group=resource(acct,'adGroups',args.parent_id??payload.ad_group);}
  if(!create&&type==='ad'&&!/^\d+~\d+$/.test(String(entityId)))throw new MirrorError('COMPOSITE_ID_REQUIRED','Google ad mutations require entity_id as adGroupId~adId.');
  if(!create&&!remove&&type==='ad'&&payload.ad){if(Object.keys(payload).some(k=>k!=='ad'))return unsupported('Split ad creative updates from ad-group-ad status updates.');const adId=String(entityId).split('~')[1]!;const update={...obj(payload.ad),resource_name:resource(acct,'ads',adId)};return step(p,'google_ads_v23_ad_mutate_ads',acct,args,{payload:{operations:[{update,update_mask:fieldsMask(update)}]}},true);}
  const body=create?{create:payload}:remove?{remove:resource(acct,route[0],entityId)}:{update:{...payload,resource_name:resource(acct,route[0],entityId)},update_mask:fieldsMask(payload)};
  return step(p,route[1],acct,args,{payload:{operations:[body],partial_failure:false}},true);
 }
 if(p==='linkedin'){
  const base=type==='campaign'?'ad_campaign_groups':type==='adset'?'ad_campaigns':type==='ad'?'creatives':undefined;if(!base)return unsupported('LinkedIn creative creation is represented by create_ad.');
  const pathKey=type==='campaign'?'campaign_group_id':type==='adset'?'campaign_id':'creative_id';
  if(create){payload.account=urn('sponsoredAccount',acct);if(type==='adset')payload.campaignGroup=urn('sponsoredCampaignGroup',args.parent_id??payload.campaignGroup);if(type==='ad')payload.campaign=urn('sponsoredCampaign',args.parent_id??payload.campaign);}
  const action=`linkedin_rest_ad_accounts_ad_account_id_${base}${create?'':'_'+pathKey}_${remove?'delete':'post'}`;
  return step(p,action,acct,args,{path_params:create?{}:{[pathKey]:numericId(entityId)},...(remove?{}:{body:create?payload:{patch:{$set:payload}}}),...(!create&&!remove?{restli_method:'PARTIAL_UPDATE'}:{})},true);
 }
 if(p==='x'){
  const base=type==='campaign'?'campaigns':type==='adset'?'line_items':type==='ad'?'promoted_tweets':undefined;if(!base)return unsupported('Use X native media creative routes for standalone creatives.');const pathKey=type==='campaign'?'campaign_id':type==='adset'?'line_item_id':'promoted_tweet_id';
  if(type==='ad'&&!create&&!remove)return unsupported('X promoted tweets have no direct generic update/status endpoint; update the parent line item or replace the promoted tweet.');
  if(create&&type==='adset')payload.campaign_id=id(args.parent_id??payload.campaign_id);if(create&&type==='ad')payload.line_item_id=id(args.parent_id??payload.line_item_id);
  return step(p,`x_accounts_account_id_${base}${create?'':'_'+pathKey}_${create?'post':remove?'delete':'put'}`,acct,args,{params:create?{}:{[pathKey]:id(entityId)},...(remove?{}:{payload})},true);
 }
 const base=type==='campaign'?'CAMPAIGNS':type==='adset'?'LINE_ITEMS':type==='creative'?'CREATIVES':undefined;if(!base)return unsupported('DV360 generic ads require the native ad-group/ad association workflow.');const pathKey=type==='campaign'?'campaignId':type==='adset'?'lineItemId':'creativeId';
 if(create&&type==='adset')payload.insertionOrderId=numericId(args.parent_id??payload.insertionOrderId);
 return step(p,`DV360_ADVERTISERS_${base}_${create?'CREATE':remove?'DELETE':'PATCH'}`,acct,args,{pathParams:create?{}:{[pathKey]:numericId(entityId)},...(remove?{}:{body:payload}),...(!create&&!remove?{query:{updateMask:fieldsMask(payload)}}:{})},true);
}

export function compileEntityRead(operation:string,args:JsonObject):NativeStep {
 const p=platform(args.platform),acct=account(p,args.account_id??args.ad_account_id),n=limit(args.limit,operation==='list_campaigns'?50:100),single=operation==='fetch_campaign',ads=['fetch_ads','fetch_creatives','list_creatives','get_ads_with_creatives'].includes(operation),children=operation==='fetch_adsets';
 if(!single&&!ads&&!children&&operation!=='list_campaigns')return unsupported('Unknown entity read.');
 if(p==='google'){
  const type=ads?'ad_group_ad':children?'ad_group':'campaign';const selected=ads?['campaign.id','ad_group.id','ad_group_ad.resource_name','ad_group_ad.status','ad_group_ad.ad.id','ad_group_ad.ad.name','ad_group_ad.ad.type','ad_group_ad.ad.final_urls',...(args.lightweight===false||operation.includes('creative')?['ad_group_ad.ad.responsive_search_ad','ad_group_ad.ad.responsive_display_ad']:[])]:children?['campaign.id','ad_group.id','ad_group.name','ad_group.status','ad_group.type','ad_group.cpc_bid_micros']:['campaign.id','campaign.name','campaign.status','campaign.advertising_channel_type','campaign.campaign_budget','campaign_budget.amount_micros','customer.currency_code','customer.time_zone'];
  const where=[`${type}.status != 'REMOVED'`];if(args.campaign_id)where.push(`campaign.id = ${numericId(args.campaign_id)}`);if(args.adset_id)where.push(`ad_group.id = ${numericId(args.adset_id)}`);if(args.ad_id)where.push(`ad_group_ad.ad.id = ${numericId(args.ad_id)}`);if(args.status_filter&&args.status_filter!=='ALL')where.push(`campaign.status = '${args.status_filter==='ACTIVE'?'ENABLED':'PAUSED'}'`);
  return gaql(acct,`SELECT ${selected.join(', ')} FROM ${type} WHERE ${where.join(' AND ')} ORDER BY ${ads?'ad_group_ad.ad.id':type+'.id'} LIMIT ${single?1:n}`,args);
 }
 if(p==='linkedin'){
  if(single)return step(p,'linkedin_rest_ad_accounts_ad_account_id_ad_campaign_groups_ad_campaign_groups_id_get',acct,args,{path_params:{ad_campaign_groups_id:numericId(args.campaign_id)}});
  if(ads&&args.ad_id)return step(p,'linkedin_rest_ad_accounts_ad_account_id_creatives_creative_urn_get',acct,args,{path_params:{creative_urn:urn('sponsoredCreative',args.ad_id)}});
  const base=ads?'creatives':children?'ad_campaigns':'ad_campaign_groups';const search:string[]=[];
  if(children)search.push(`campaignGroup:(values:List(${urn('sponsoredCampaignGroup',args.campaign_id)}))`);
  if(ads&&args.adset_id)search.push(`campaign:(values:List(${urn('sponsoredCampaign',args.adset_id)}))`);
  if(ads&&args.campaign_id&&!args.adset_id)return unsupported('LinkedIn creative reads require adset_id (native campaign ID); fetch the campaign-group children first.');
  if(!children&&!ads)search.push(`status:(values:List(${args.status_filter&&args.status_filter!=='ALL'?args.status_filter:'ACTIVE,PAUSED,DRAFT,ARCHIVED,CANCELED,PENDING_DELETION,REMOVED'}))`);
  if(ads&&!search.length)return step(p,`linkedin_rest_ad_accounts_ad_account_id_${base}_get`,acct,args,{query:{start:0,count:n}});
  return step(p,`linkedin_rest_ad_accounts_ad_account_id_${base}_get`,acct,args,{query:{q:'search',search:'('+search.join(',')+')',pageSize:n},aggregate_pages:true,max_pages:25});
 }
 if(p==='x'){
  const base=ads?'promoted_tweets':children?'line_items':'campaigns',specific=single?'campaign_id':ads&&args.ad_id?'promoted_tweet_id':undefined;
  const query:JsonObject={count:n,with_deleted:false};if(children)query.campaign_ids=id(args.campaign_id);if(ads&&args.adset_id)query.line_item_ids=id(args.adset_id);if(ads&&args.campaign_id&&!args.adset_id)return unsupported('X promoted-tweet reads require adset_id (line item); fetch campaign children first.');if(args.status_filter&&args.status_filter!=='ALL')query.entity_status=args.status_filter;
  return step(p,`x_accounts_account_id_${base}${specific?'_'+specific:''}_get`,acct,args,{params:specific?{[specific]:id(args.ad_id??args.campaign_id)}:{},query,...(!specific?{aggregate_pages:true,max_pages:25}:{})});
 }
 const base=ads?'CREATIVES':children?'LINE_ITEMS':'CAMPAIGNS';const query:JsonObject={pageSize:n},filters:string[]=[];if(children)filters.push(`campaignId="${numericId(args.campaign_id)}"`);if(args.status_filter&&args.status_filter!=='ALL')filters.push(`entityStatus="ENTITY_STATUS_${args.status_filter}"`);if(filters.length)query.filter=filters.join(' AND ');
 if(ads&&(args.campaign_id||args.adset_id||args.ad_id))return unsupported('DV360 creative inventory is advertiser scoped; use native creative association reads for entity filters.');
 return step(p,`DV360_ADVERTISERS_${base}_${single?'GET':'LIST'}`,acct,args,{pathParams:single?{campaignId:numericId(args.campaign_id)}:{},query,...(!single?{aggregate_pages:true,max_pages:25}:{})});
}

const standardGoogleMetrics=['impressions','clicks','cost_micros','conversions','conversions_value'];
export function compileReport(args:JsonObject):NativeStep{
 const p=platform(args.platform),acct=account(p,args.account_id),range=dateRange(args.date_range),level=args.level??'campaign',granularity=args.granularity??'day';
 for(const name of ['breakdowns','action_breakdowns','summary_action_breakdowns','filtering'])if(args[name]?.length)return unsupported('Generic report '+name+' requires a platform-specific reporting contract; use the native gateway.',{field:name});
 if(args.include_targeting||args.include_creatives)return unsupported('Historical targeting and creative joins are not reconstructed from current settings. Fetch explicitly dated source snapshots.');
 const campaigns=[...new Set([...(args.campaign_ids??[]),...(args.comparison_target_ids??[])])];
 if(p==='google'){
  const resources:Record<string,string>={campaign:'campaign',adset:'ad_group',ad:'ad_group_ad',pmax:'campaign',pmax_asset_group:'asset_group'};const from=resources[level];if(!from)return unsupported('This PMax report needs its own validated field compatibility contract.',{level});
  const dimensions=['customer.currency_code','customer.time_zone','campaign.id','campaign.name'];if(from==='ad_group'||from==='ad_group_ad')dimensions.push('ad_group.id','ad_group.name');if(from==='ad_group_ad')dimensions.push('ad_group_ad.ad.id');if(from==='asset_group')dimensions.push('asset_group.id','asset_group.name');if(granularity==='day')dimensions.push('segments.date');if(granularity==='month')dimensions.push('segments.month');
  const metrics=(args.metrics??standardGoogleMetrics).map((m:string)=>m.startsWith('metrics.')?m:'metrics.'+m);for(const metric of metrics)if(!/^metrics\.[a-z][a-z0-9_]*$/.test(metric))throw new MirrorError('INVALID_METRIC','Google metrics must be simple native field names.');
  const where=[`segments.date BETWEEN '${range.since}' AND '${range.until}'`];if(campaigns.length)where.push(`campaign.id IN (${campaigns.map(v=>numericId(v)).join(',')})`);if(level==='pmax')where.push("campaign.advertising_channel_type = 'PERFORMANCE_MAX'");
  if(args.entity_ids?.length){if(level==='campaign')throw new MirrorError('INVALID_FILTER','Use campaign_ids at campaign level.');const field=from==='ad_group_ad'?'ad_group_ad.ad.id':from+'.id';where.push(`${field} IN (${args.entity_ids.map((v:unknown)=>numericId(v)).join(',')})`);}
  return gaql(acct,`SELECT ${[...new Set([...dimensions,...metrics])].join(', ')} FROM ${from} WHERE ${where.join(' AND ')}`,args);
 }
 if(p==='linkedin'){
  const pivot:Record<string,string>={campaign:'CAMPAIGN_GROUP',adset:'CAMPAIGN',ad:'CREATIVE'};if(!pivot[level])return unsupported('LinkedIn reporting supports campaign, adset and ad levels.');
  const tuple=(date:string)=>{const[y,m,d]=date.split('-').map(Number);return `(year:${y},month:${m},day:${d})`;};
  const metrics=args.metrics??['impressions','clicks','costInLocalCurrency','externalWebsiteConversions','conversionValueInLocalCurrency'];if(metrics.length>18||metrics.some((m:unknown)=>typeof m!=='string'||!/^\w+$/.test(m)))throw new MirrorError('INVALID_METRIC','Supply up to 18 simple LinkedIn metric names.');
  const query:JsonObject={q:'analytics',pivot:pivot[level],accounts:`List(${urn('sponsoredAccount',acct)})`,timeGranularity:granularity==='all'?'ALL':granularity==='month'?'MONTHLY':'DAILY',dateRange:`(start:${tuple(range.since)},end:${tuple(range.until)})`,fields:[...new Set(['dateRange','pivotValues',...metrics])].join(',')};
  if(campaigns.length)query.campaignGroups=`List(${campaigns.map(v=>urn('sponsoredCampaignGroup',v)).join(',')})`;if(args.entity_ids?.length){if(level==='campaign')throw new MirrorError('INVALID_FILTER','Use campaign_ids at campaign level.');query[level==='adset'?'campaigns':'creatives']=`List(${args.entity_ids.map((v:unknown)=>urn(level==='adset'?'sponsoredCampaign':'sponsoredCreative',v)).join(',')})`;}
  return step(p,'linkedin_rest_ad_analytics_get',acct,args,{query});
 }
 return unsupported(p==='x'?'X reports require account-timezone-aware chunking by WorkflowEngine.':'DV360 reporting uses the Bid Manager reporting API and a separately configured reporting connection.');
}

function unwrap(value:unknown):any{let v=value as any;for(let i=0;i<4&&v&&typeof v==='object'&&v.success===true&&Object.hasOwn(v,'data');i++)v=v.data;return v;}
export function responseRows(value:unknown):JsonObject[]{const v=unwrap(value);if(Array.isArray(v))return v.flatMap(x=>Array.isArray(x?.results)?x.results:[x]);for(const key of ['results','elements','data','campaigns','lineItems','creatives','assets'])if(Array.isArray(v?.[key]))return v[key];if(v&&typeof v==='object'&&(v.id!==undefined||v.resourceName!==undefined))return [v];throw new MirrorError('UNRECOGNIZED_RESPONSE','The native response does not contain a recognized row collection; refusing to treat it as an empty report.');}
function number(value:unknown):number|null {if(value===null||value===undefined||value==='')return null;const n=Number(value);if(!Number.isFinite(n))throw new MirrorError('INVALID_METRIC_VALUE','A native metric was non-numeric.');if(Number.isInteger(n)&&!Number.isSafeInteger(n))throw new MirrorError('METRIC_PRECISION_LOSS','Metric exceeds safe numeric precision; use the retained raw response.');return n;}
const pick=(v:JsonObject,...keys:string[])=>keys.map(k=>v?.[k]).find(x=>x!==undefined);
function ratio(n:number|null,d:number|null,multiple=1){return n!==null&&d!==null&&d>0?n/d*multiple:null;}
/** No cross-account totals, missing metrics stay null, monetary rows carry currency. */
export function normalizeReport(pValue:unknown,nativeRows:JsonObject[],args:JsonObject,currency:string|null=null):JsonObject{
 const p=platform(pValue);const rows=nativeRows.map(raw=>{
  const m=p==='google'?raw.metrics??{}:raw,localCurrency=pick(raw.customer??{},'currencyCode','currency_code')??currency;
  const impressions=number(m.impressions),clicks=number(m.clicks),spendNative=number(p==='google'?pick(m,'costMicros','cost_micros'):p==='linkedin'?m.costInLocalCurrency:m.spend),spend=p==='google'&&spendNative!==null?spendNative/1e6:spendNative;
  const conversions=number(p==='google'?m.conversions:p==='linkedin'?m.externalWebsiteConversions:m.conversions),value=number(p==='google'?pick(m,'conversionsValue','conversions_value'):p==='linkedin'?m.conversionValueInLocalCurrency:m.conversion_value);
  const entity=raw.adGroupAd?.ad??raw.ad_group_ad?.ad??raw.assetGroup??raw.asset_group??raw.adGroup??raw.ad_group??raw.campaign??{};
  const date=raw.segments?.date??raw.segments?.month??(raw.dateRange?.start?`${raw.dateRange.start.year}-${String(raw.dateRange.start.month).padStart(2,'0')}-${String(raw.dateRange.start.day).padStart(2,'0')}`:raw.date??null);
  return {platform:p,account_id:String(args.account_id),entity_id:String(entity.id??raw.pivotValues?.[0]??raw.id??''),entity_name:entity.name??null,date,currency:localCurrency??null,impressions,clicks,spend,conversions,conversion_value:value,ctr:ratio(clicks,impressions,100),cpc:ratio(spend,clicks),cpm:ratio(spend,impressions,1000),roas:ratio(value,spend),raw};
 });
 return {platform:p,account_id:String(args.account_id),date_range:dateRange(args.date_range),granularity:args.granularity??'day',level:args.level??'campaign',rows,evidence:workflowEvidence,normalized:true,totals:null,warnings:[...(rows.some(r=>r.currency===null)?['Account currency was not returned; monetary values retain native account units and must not be combined with other accounts.']:[]),'Missing metrics are null. Reach, frequency and attribution metrics are not summed across rows.']};
}
export function reportCsv(rows:JsonObject[]):string {
 const columns=['platform','account_id','entity_id','entity_name','date','currency','impressions','clicks','spend','conversions','conversion_value','ctr','cpc','cpm','roas'];
 const cell=(v:unknown)=>{let s=v===null||v===undefined?'':String(v);if(typeof v==='string'&&/^[\s\u0000-\u001f]*[=+\-@]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};return '\ufeff'+columns.map(cell).join(',')+'\r\n'+rows.map(r=>columns.map(c=>cell(r[c])).join(',')).join('\r\n')+'\r\n';
}

export const businessWorkflowOperations=new Set(['compile_entity_payload','create_campaign','create_adset','create_ad','create_creative','update_entities','set_entity_status','publish_campaign','delete_entity','list_campaigns','fetch_campaign','fetch_adsets','fetch_ads','fetch_creatives','list_creatives','get_ads_with_creatives','get_campaign_details','get_performance_report','get_entity_insights','get_search_terms','export_report','list_audiences','fetch_custom_audiences','list_media_assets','estimate_audience_size','get_ad_preview','plan_campaign_structure','audit_campaign','get_optimization_suggestions']);
export class WorkflowEngine {
 constructor(readonly dependencies:WorkflowDependencies){}
 private async execute(s:NativeStep,actor:Actor):Promise<any>{const action=this.dependencies.registry.action(s.gateway,s.input.action);if(!action?.path)throw new MirrorError('CONTRACT_UNAVAILABLE','Workflow route is absent from the captured/official registry.',{gateway:s.gateway,action:s.input.action});const result:any=await this.dependencies.runNative(s.gateway,s.input,actor);if(result?.success===false)throw new MirrorError(result.error?.code??'NATIVE_REQUEST_FAILED',result.error?.message??'Native workflow step failed.',result.error?.details??{});return result;}
 async handle(operation:string,args:JsonObject,actor:Actor):Promise<unknown>{
  guardInput(args);
  if(operation==='compile_entity_payload')return compileEntityPayload(args.platform,args.entity_type,args.entity_data,args.context??{},args.operation??'create');
  if(['create_campaign','create_adset','create_ad','create_creative','update_entities','set_entity_status','delete_entity'].includes(operation))return this.execute(compileEntityMutation(operation,args),actor);
  if(operation==='publish_campaign')return this.execute(compileEntityMutation(operation,{...args,entity_type:'campaign',entity_id:args.campaign_id,dry_run:args.dry_run!==false||args.confirmed!==true}),actor);
  if(['list_campaigns','fetch_campaign','fetch_adsets','fetch_ads','fetch_creatives','list_creatives','get_ads_with_creatives'].includes(operation)){
   const result=await this.execute(compileEntityRead(operation,args),actor);
   if(args.include_insights){const report=await this.report({...args,campaign_ids:args.campaign_id?[args.campaign_id]:undefined,date_range:args.date_range??lastDays(7)},actor);return {entities:result,insights:report,evidence:workflowEvidence};}return result;
  }
  if(operation==='get_campaign_details'){
   const result:JsonObject={campaign:await this.handle('fetch_campaign',{...args,include_insights:false},actor),evidence:workflowEvidence};
   if(args.include_adsets!==false||args.include_ads){result.adsets=await this.handle('fetch_adsets',args,actor);if(args.include_ads){const p=platform(args.platform);if(p==='google')result.ads=await this.handle('fetch_ads',args,actor);else {const children=responseRows(result.adsets);if(children.length>50)throw new MirrorError('WORKFLOW_BOUND_EXCEEDED','Fetch ads per child for accounts with more than 50 child entities.');result.ads=[];for(const child of children)result.ads.push(await this.handle('fetch_ads',{...args,adset_id:String(child.id??child.lineItemId)},actor));}}}
   if(args.include_insights!==false)result.insights=await this.report({...args,campaign_ids:[args.campaign_id],date_range:args.date_range??lastDays(7)},actor);return result;
  }
  if(operation==='get_performance_report')return this.report(args,actor);
  if(operation==='get_entity_insights'){const extra=obj(args.params);for(const key of Object.keys(extra))if(!['granularity','metrics','breakdowns'].includes(key))return unsupported('Unsupported entity-insights option.',{field:key});return this.report({...extra,platform:args.platform,account_id:args.account_id,level:args.entity_type,date_range:args.date_range,...(args.entity_type==='campaign'?{campaign_ids:[args.entity_id]}:{entity_ids:[args.entity_id]})},actor);}
  if(operation==='get_search_terms'){
   const acct=account('google',args.account_id),range=dateRange(args.date_range);const where=[`segments.date BETWEEN '${range.since}' AND '${range.until}'`,`metrics.impressions >= ${limit(args.min_impressions,1,1000000000)}`];if(args.campaign_id)where.push(`campaign.id = ${numericId(args.campaign_id)}`);if(args.ad_group_id)where.push(`ad_group.id = ${numericId(args.ad_group_id)}`);
   return this.execute(gaql(acct,`SELECT customer.currency_code, campaign.id, campaign.name, ad_group.id, ad_group.name, search_term_view.search_term, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE ${where.join(' AND ')} ORDER BY metrics.impressions DESC LIMIT ${limit(args.limit,100,1000)}`),actor);
  }
  if(operation==='export_report'){
   if(args.dry_run===true)return {dry_run:true,executed:false,format:args.format,report_request:args.platform==='x'?{requires_account_timezone_read:true}:compileReport(args),evidence:workflowEvidence};
   if(args.format!=='csv')return unsupported('Google Sheets export requires a separately authorized reporting destination; CSV export is available.');
   const report=await this.report(args,actor);return {format:'csv',mime_type:'text/csv;charset=utf-8',encoding:'base64',content:Buffer.from(reportCsv(report.rows),'utf8').toString('base64'),row_count:report.rows.length,report_metadata:{...report,rows:undefined},external_writes:false};
  }
  if(operation==='list_media_assets')return this.media(args,actor);
  if(['list_audiences','fetch_custom_audiences'].includes(operation))return this.audiences(args,actor);
  if(operation==='estimate_audience_size'){const acct=account('linkedin',args.account_id);return this.execute(step('linkedin','linkedin_rest_audience_counts_get',acct,args,{query:{q:'targetingCriteria',targetingCriteria:restli(args.targeting),account:urn('sponsoredAccount',acct)}}),actor);}
  if(operation==='get_ad_preview'){if(platform(args.platform)!=='linkedin')return unsupported('Generic live previews are implemented for LinkedIn; use the platform native preview route.');if(args.creative)return unsupported('LinkedIn payload preview is a POST workflow without a generic dry_run field; use the native preview action explicitly.');return this.execute(step('linkedin','linkedin_rest_ad_previews_get',account('linkedin',args.account_id),args,{query:{q:'creative',creative:urn('sponsoredCreative',args.creative_id??args.ad_id)}}),actor);}
  if(operation==='plan_campaign_structure'){
   const existing=await this.handle('list_campaigns',{platform:args.platform,account_id:args.account_id,limit:args.max_recent_campaigns??5},actor);const assets=this.dependencies.store.documents(actor.tenantId,'workspace_asset').filter(a=>!a.platform||a.platform===args.platform);
   return {evidence:workflowEvidence,source_campaigns:existing,workspace_assets:assets,objective:args.objective,recommendation:{adsets:1,ads_per_adset:2,basis:'Initial reviewable structure; split only where audience, budget or creative treatment must differ.'},missing_inputs:['Verified targeting IDs','Account currency and budget runway','Approved creative identifiers','Conversion tracking configuration'],created:false};
  }
  if(operation==='audit_campaign'||operation==='get_optimization_suggestions'){
   const p=platform(args.platform),acct=account(p,args.account_id),period=dateRange(args.date_range??lastDays(30));
   const campaignResult=await this.handle('fetch_campaign',{platform:p,account_id:acct,campaign_id:args.campaign_id,include_insights:false},actor),rows=responseRows(campaignResult);
   if(rows.length!==1)throw new MirrorError('CAMPAIGN_NOT_FOUND','The campaign read must return exactly one campaign.');
   const report=await this.report({platform:p,account_id:acct,campaign_ids:[args.campaign_id],date_range:period,level:'campaign',granularity:'day'},actor);
   const input:CampaignAuditInput={platform:p,account_id:acct,campaign_id:args.campaign_id,campaign:rows[0]!,report,checks:args.checks,date_range:period,as_of:new Date().toISOString().slice(0,10)};
   return operation==='audit_campaign'?auditCampaign(input):optimizationSuggestions(input,{budget_reallocation:args.budget_reallocation});
  }
  return unsupported('This workflow requires a separately implemented provider or contract.',{operation});
 }
 private async report(args:JsonObject,actor:Actor):Promise<JsonObject>{
  if(platform(args.platform)==='x')return this.xReport(args,actor);
  const s=compileReport(args),result:any=await this.execute(s,actor);if(result.dry_run===true)return result;
  if(result.truncated===true)throw new MirrorError('INCOMPLETE_REPORT','Native pagination reached its limit; split the reporting query.',{pages:result.pages});const rows=responseRows(result);if(args.platform==='linkedin'&&rows.length>=15000)throw new MirrorError('INCOMPLETE_REPORT','LinkedIn reached its 15,000 element response cap; narrow dates or entity filters.');
  return {...normalizeReport(args.platform,rows,args),native_meta:{pages:result.pages??1,truncated:result.truncated??false}};
 }
 private async media(args:JsonObject,actor:Actor):Promise<unknown>{
  const alias=(p:string)=>({google:'google_ads',x:'x_ads',twitter:'x_ads'} as Record<string,string>)[p]??p;
  const source=args.source??'all',uploaded=source==='platform'?[]:this.dependencies.store.documents(actor.tenantId,'workspace_asset').filter(a=>(!args.platform||alias(a.platform)===alias(args.platform))&&(!args.account_id||a.account_id===args.account_id.replace(/^act_/,''))&&(!args.asset_id||a.id===args.asset_id)&&(!args.upload_session_id||a.upload_session_id===args.upload_session_id)&&(!args.media_type||args.media_type==='all'||a.media_type===args.media_type)).slice(0,limit(args.limit,50,200));
  if(source==='all'&&['meta','tiktok','snapchat','linkedin'].includes(args.platform))return {uploaded,platform:[],platform_inventory_fetched:false,note:'Server-uploaded media receipts. Use the native account media inventory route for assets uploaded outside AMCP.',evidence:workflowEvidence};
  if(source==='uploaded'||!args.platform)return {uploaded,platform:[],evidence:workflowEvidence};const p=platform(args.platform),acct=account(p,args.account_id),n=limit(args.limit,50,200);let s:NativeStep;
  if(p==='google'){const where:string[]=[];if(args.media_type&&args.media_type!=='all')where.push(`asset.type = '${args.media_type==='image'?'IMAGE':args.media_type==='video'?'YOUTUBE_VIDEO':'UNKNOWN'}'`);if(args.query)where.push(`asset.name LIKE ${literal('%'+args.query+'%')}`);s=gaql(acct,`SELECT asset.id, asset.resource_name, asset.name, asset.type, asset.image_asset.full_size.url, asset.youtube_video_asset.youtube_video_id FROM asset${where.length?' WHERE '+where.join(' AND '):''} LIMIT ${n}`);}
  else if(p==='x')s=step(p,'x_accounts_account_id_media_library_get',acct,args,{query:{count:n,...(args.cursor?{cursor:args.cursor}:{})}});
  else if(p==='dv360')s=step(p,'DV360_ADVERTISERS_AD_ASSETS_LIST',acct,args,{query:{pageSize:n,...(args.cursor?{pageToken:args.cursor}:{})}});
  else return unsupported('LinkedIn reusable media inventory needs explicit owner context; use the native image/video owner finder.');
  return {uploaded,platform:await this.execute(s,actor),evidence:workflowEvidence};
 }
 private async audiences(args:JsonObject,actor:Actor):Promise<unknown>{
  const p=platform(args.platform),acct=account(p,args.account_id),n=limit(args.limit,50,200);if(p==='google')return this.execute(gaql(acct,`SELECT user_list.id, user_list.name, user_list.type, user_list.membership_status, user_list.size_for_search, user_list.size_for_display FROM user_list${args.query?' WHERE user_list.name LIKE '+literal('%'+args.query+'%'):''} LIMIT ${n}`),actor);
  if(p==='x')return this.execute(step(p,'x_accounts_account_id_custom_audiences_get',acct,args,{query:{count:n}}),actor);
  if(p==='linkedin'&&args.query)return this.execute(step(p,'linkedin_rest_ad_targeting_entities_get',acct,args,{query:{q:args.linkedin_finder??'typeahead',query:args.query,facet:args.linkedin_facet??'urn:li:adTargetingFacet:interests',count:n}}),actor);
  return unsupported('Use the native audience inventory route with the required platform owner/finder context.');
 }
 private async xReport(args:JsonObject,actor:Actor):Promise<JsonObject>{
  const acct=account('x',args.account_id),range=dateRange(args.date_range),level=args.level??'campaign';if(!['campaign','adset','ad'].includes(level))return unsupported('X reports support campaign, adset and ad levels.');
  for(const field of ['breakdowns','filtering','metrics','action_breakdowns','summary_action_breakdowns'])if(args[field]?.length)return unsupported('This X generic report supports standard unsegmented engagement and billing metrics; use native analytics for additional fields.',{field});if(args.include_targeting||args.include_creatives)return unsupported('Historical targeting and creative reconstruction is unavailable.');
  const metadata=unwrap(await this.execute(step('x','x_accounts_account_id_get',acct,{},{}),actor));const accountData=metadata?.data??metadata;const timezone=accountData.timezone;if(typeof timezone!=='string')throw new MirrorError('TIMEZONE_REQUIRED','The X account timezone must be returned before interpreting reporting dates.');
  let ids: string[]=[...new Set<string>(level==='campaign'?[...(args.campaign_ids??[]),...(args.comparison_target_ids??[])]:args.entity_ids??[])];if(!ids.length){if(level!=='campaign')throw new MirrorError('ENTITY_IDS_REQUIRED','Specify X entity_ids for adset/ad reports.');const campaigns=await this.execute(compileEntityRead('list_campaigns',{platform:'x',account_id:acct,limit:500}),actor);if(campaigns.truncated)throw new MirrorError('INCOMPLETE_REPORT','Campaign discovery was truncated; specify campaign_ids.');ids=responseRows(campaigns).map(r=>id(String(r.id)));}for(const value of ids)id(value);
  if(level!=='campaign'&&args.campaign_ids?.length)return unsupported('Use explicit entity_ids without campaign_ids for X child-level reporting; native analytics cannot validate both filters.');
  const start=zonedMidnight(range.since,timezone),end=zonedMidnight(new Date(Date.parse(range.until)+86400000).toISOString().slice(0,10),timezone);const calls=Math.ceil(ids.length/20)*Math.ceil((end-start)/(7*86400000));if(calls>100)throw new MirrorError('WORKFLOW_BOUND_EXCEEDED','Split this X report into smaller account/entity/date requests.',{requests:calls});
  const data:JsonObject[]=[];let requests=0;
  for(let at=start;at<end;at+=7*86400000)for(let offset=0;offset<ids.length;offset+=20){const stop=Math.min(end,at+7*86400000);const result=await this.execute(step('x','x_stats_accounts_account_id_get',acct,{}, {query:{entity:level==='campaign'?'CAMPAIGN':level==='adset'?'LINE_ITEM':'PROMOTED_TWEET',entity_ids:ids.slice(offset,offset+20).join(','),start_time:new Date(at).toISOString(),end_time:new Date(stop).toISOString(),granularity:'HOUR',metric_groups:'ENGAGEMENT,BILLING',placement:'ALL_ON_TWITTER'}}),actor);requests++;
   for(const row of responseRows(result))for(const segment of row.id_data??[]){if(segment.segment!==null&&segment.segment!==undefined)throw new MirrorError('UNEXPECTED_SEGMENT','Segmented X response cannot be normalized as an unsegmented report.');const m=segment.metrics??{};const lengths=Object.values(m).filter(Array.isArray).map(v=>v.length);if(lengths.some(n=>n!==(stop-at)/3600000))throw new MirrorError('REPORT_BUCKET_MISMATCH','X hourly metric arrays do not match the requested interval.');for(let hour=0;hour<(stop-at)/3600000;hour++){const micros=number(m.billed_charge_local_micro?.[hour]);data.push({id:String(row.id),date:localDate(at+hour*3600000,timezone),impressions:m.impressions?.[hour]??null,clicks:m.clicks?.[hour]??null,spend:micros===null?null:micros/1e6});}}
  }
  const granularity=args.granularity??'day';const groups=new Map<string,JsonObject>();for(const row of data){const date=granularity==='all'?null:granularity==='month'?row.date.slice(0,7)+'-01':row.date,key=stable([row.id,date]);const old=groups.get(key)??{id:row.id,date,impressions:0,clicks:0,spend:0};for(const field of ['impressions','clicks','spend'])old[field]=old[field]===null||row[field]===null?null:old[field]+Number(row[field]);groups.set(key,old);}
  return {...normalizeReport('x',[...groups.values()],args,accountData.currency??null),timezone,placement:'ALL_ON_TWITTER',requests,warnings:['X Audience Platform placement is excluded. This report covers ALL_ON_TWITTER only.','X conversion metrics were not requested and remain null. Missing hourly metrics remain null.']};
 }
}

export function restli(value:unknown):string{if(Array.isArray(value))return 'List('+value.map(restli).join(',')+')';if(value&&typeof value==='object')return '('+Object.entries(value).map(([k,v])=>{if(!/^[a-zA-Z][a-zA-Z0-9_.:-]*$/.test(k))throw new MirrorError('INVALID_RESTLI_FIELD','Invalid REST.li field.');return k+':'+restli(v);}).join(',')+')';if(typeof value==='string')return value.replace(/[(),:'%]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());if(typeof value==='number'&&Number.isFinite(value)||typeof value==='boolean')return String(value);throw new MirrorError('INVALID_RESTLI_VALUE','Unsupported REST.li value.');}
function localDate(at:number,zone:string){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(at));return ['year','month','day'].map(k=>parts.find(p=>p.type===k)!.value).join('-');}
export function zonedMidnight(date:string,zone:string,allowFractionalOffset=false):number {
 const wanted=Date.parse(date+'T00:00:00Z');let at=wanted;let format:Intl.DateTimeFormat;try{format=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});}catch{throw new MirrorError('INVALID_TIMEZONE','The account timezone is not recognized.');}
 for(let i=0;i<4;i++){const parts=format.formatToParts(at),v=(key:string)=>Number(parts.find(p=>p.type===key)!.value),actual=Date.UTC(v('year'),v('month')-1,v('day'),v('hour'),v('minute'),v('second'));if(actual===wanted){if(!allowFractionalOffset&&at%3600000!==0)throw new MirrorError('UNSUPPORTED_TIMEZONE_OFFSET','X analytics requires whole-hour boundaries; this account timezone has a fractional-hour offset.');return at;}at+=wanted-actual;}
 throw new MirrorError('AMBIGUOUS_DATE_BOUNDARY','The requested local midnight is skipped by a timezone transition; use explicit native analytics timestamps.');
}
