import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {MirrorError} from './errors.js';
import {stable} from './security.js';
import {validateDiscoveryBody} from './discovery-body.js';
import type {CompiledRequest,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Demand Gen ad groups on Display & Video 360 API v4, per the pinned Discovery document (AdGroup, adGroups.create, patch
 * and delete) and the "Serve a Demand Gen ad" guide (checked 2026-09-27).
 * - Only Demand Gen ad groups can be written. They belong to a Demand Gen line item of the advertiser; the format and the
 *   line item cannot change.
 * - An ad group serves only while its line item, the ad group and an ad are all active; Google recommends creating ad
 *   groups paused.
 * - The line item sets the bid strategy type. An ad group may set only a value, for target CPA, CPC or ROAS strategies,
 *   in micros of the advertiser currency (1000000 is one unit, or 100% ROAS).
 * - Inventory control is required: a strategy (all Google inventory, or also the Display Network) or selected inventories.
 */
const origin='https://displayvideo.googleapis.com';
const collection=/^\/v4\/advertisers\/([1-9]\d*)\/adGroups$/,single=/^\/v4\/advertisers\/([1-9]\d*)\/adGroups\/([1-9]\d*)$/;
type Kind='create'|'patch'|'delete';
/** Writable fields; creation also sets the immutable lineItemId and adGroupFormat. */
export const dv360AdGroupFields=['displayName','entityStatus','adGroupInventoryControl','bidStrategy','targetingExpansion','productFeedData'];
const statuses=['ENTITY_STATUS_ACTIVE','ENTITY_STATUS_PAUSED'];
const strategies=['AD_GROUP_INVENTORY_STRATEGY_ALL_GOOGLE_AND_DISPLAY_NETWORK_INVENTORY','AD_GROUP_INVENTORY_STRATEGY_ALL_GOOGLE_INVENTORY'];
const inventories=['allowGoogleDisplayNetwork','allowYoutubeShorts','allowYoutubeStream','allowYoutubeFeed','allowGmail','allowDiscover'];
const valueTypes=['DEMAND_GEN_BIDDING_STRATEGY_TYPE_TARGET_CPA','DEMAND_GEN_BIDDING_STRATEGY_TYPE_TARGET_CPC','DEMAND_GEN_BIDDING_STRATEGY_TYPE_TARGET_ROAS'];
const matchTypes=['PRODUCT_MATCH_TYPE_ALL_PRODUCTS','PRODUCT_MATCH_TYPE_SPECIFIC_PRODUCTS','PRODUCT_MATCH_TYPE_CUSTOM_LABEL'];
const obj=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const micros=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,15}$/.test(v);
let schemas:Record<string,JsonObject>|undefined;
const models=()=>schemas??=JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../.mirror/VENDOR/dv360-v4.json',import.meta.url)),'utf8')).document.schemas as Record<string,JsonObject>;
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_DV360_AD_GROUP',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
function mismatch(message:string):never{return fail('STATE_TARGET_MISMATCH',message,{},409);}

export function dv360AdGroupKind(p:CompiledRequest):Kind|undefined{
 if(p.gateway!=='dv360_native_action'||p.origin!==undefined&&p.origin!==origin||p.specialTransport)return;
 if(p.method==='POST'&&collection.test(p.path))return 'create';
 if(p.method==='PATCH'&&single.test(p.path))return 'patch';
 if(p.method==='DELETE'&&single.test(p.path))return 'delete';
 return;
}
const advertiserOf=(p:CompiledRequest)=>p.path.split('/')[3]!;
const adGroupOf=(p:CompiledRequest)=>p.path.split('/')[5]!;
const mask=(p:CompiledRequest):string[]=>String(p.query.updateMask??'').split(',').map(s=>s.trim()).filter(Boolean);

function inventory(v:unknown):void{
 if(!obj(v)||Object.keys(v).length!==1)invalid('adGroupInventoryControl sets either adGroupInventoryStrategy or selectedInventories.');
 if(v.adGroupInventoryStrategy!==undefined){if(!strategies.includes(v.adGroupInventoryStrategy))invalid('adGroupInventoryStrategy is '+strategies.join(' or ')+'.');return;}
 const s=v.selectedInventories;
 if(!obj(s)||Object.keys(s).some(k=>!inventories.includes(k))||Object.values(s).some(x=>typeof x!=='boolean')||!Object.values(s).some(x=>x===true))invalid('selectedInventories sets '+inventories.join(', ')+' as booleans, at least one true.');
}
function product(v:unknown):void{
 if(!obj(v)||Object.keys(v).some(k=>!['isFeedDisabled','productMatchType','productMatchDimensions'].includes(k)))invalid('productFeedData takes isFeedDisabled, productMatchType and productMatchDimensions.');
 if(v.isFeedDisabled!==undefined&&typeof v.isFeedDisabled!=='boolean')invalid('isFeedDisabled is a boolean.');
 if(v.productMatchType!==undefined&&!matchTypes.includes(v.productMatchType))invalid('productMatchType is '+matchTypes.join(', ')+'.');
 const dims=v.productMatchDimensions??[];
 if(!Array.isArray(dims)||dims.length>1000)invalid('productMatchDimensions lists up to 1000 dimensions.');
 const offers=dims.filter((d:JsonObject)=>obj(d)&&d.productOfferId!==undefined),labels=dims.filter((d:JsonObject)=>obj(d)&&d.customLabel!==undefined);
 if(offers.length+labels.length!==dims.length||dims.some((d:JsonObject)=>Object.keys(d).length!==1))invalid('Each product match dimension is a productOfferId or a customLabel.');
 if(v.productMatchType==='PRODUCT_MATCH_TYPE_SPECIFIC_PRODUCTS'&&(!offers.length||labels.length)||v.productMatchType==='PRODUCT_MATCH_TYPE_CUSTOM_LABEL'&&(!labels.length||offers.length)||v.productMatchType==='PRODUCT_MATCH_TYPE_ALL_PRODUCTS'&&dims.length)invalid('Specific products take product offer IDs, custom labels take custom labels, and all products take no dimensions.');
 if(new Set(dims.map((d:JsonObject)=>stable(d))).size!==dims.length)invalid('Product match dimensions must be distinct.');
}
function fields(a:JsonObject,present:string[]):void{
 if(present.includes('displayName')&&(typeof a.displayName!=='string'||!a.displayName.trim()||a.displayName!==a.displayName.trim()||Buffer.byteLength(a.displayName,'utf8')>255||/[\u0000-\u001f]/.test(a.displayName)))invalid('displayName is 1–255 UTF-8 bytes without surrounding spaces or control characters.');
 if(present.includes('entityStatus')&&!statuses.includes(a.entityStatus))invalid('entityStatus is ENTITY_STATUS_PAUSED or ENTITY_STATUS_ACTIVE.');
 if(present.includes('adGroupInventoryControl'))inventory(a.adGroupInventoryControl);
 if(present.includes('bidStrategy')){
  const b=a.bidStrategy;
  if(!obj(b)||Object.keys(b).length!==1||!obj(b.demandGenBid)||Object.keys(b.demandGenBid).some(k=>k!=='value')||!micros(b.demandGenBid.value))invalid('An ad group bidStrategy is {demandGenBid: {value}} with a positive value in micros as a string; the type comes from the line item.');
 }
 if(present.includes('targetingExpansion')){
  const t=a.targetingExpansion;
  if(!obj(t)||Object.keys(t).some(k=>!['enableOptimizedTargeting','excludeDemographicExpansion'].includes(k))||typeof t.enableOptimizedTargeting!=='boolean'||t.excludeDemographicExpansion!==undefined&&typeof t.excludeDemographicExpansion!=='boolean')invalid('targetingExpansion is {enableOptimizedTargeting, excludeDemographicExpansion} with booleans.');
 }
 if(present.includes('productFeedData'))product(a.productFeedData);
}
export function assertDV360AdGroup(p:CompiledRequest):void{
 const kind=dv360AdGroupKind(p);if(!kind)return;
 if(advertiserOf(p)!==p.accountId)fail('ACCOUNT_SCOPE_MISMATCH','The request must use the selected advertiser.',{},403);
 if(Object.keys(p.headers).length||Object.keys(p.query).some(k=>kind!=='patch'||k!=='updateMask'))invalid('Ad group requests take no query or header overrides'+(kind==='patch'?' besides updateMask':'')+'.');
 if(kind==='delete'){if(p.body!==undefined&&!(obj(p.body)&&!Object.keys(p.body).length))invalid('Deleting an ad group takes no body.');return;}
 const a=p.body;if(!obj(a))invalid('Provide the native AdGroup object.');
 const allowed=kind==='create'?[...dv360AdGroupFields,'lineItemId','adGroupFormat']:dv360AdGroupFields;
 const unknown=Object.keys(a).filter(k=>!allowed.includes(k));
 if(unknown.length)invalid('Unqualified ad group fields: '+unknown.join(', ')+'. IDs and names are assigned by DV360'+(kind==='patch'?', and the line item and format cannot change':'')+'.');
 validateDiscoveryBody('AdGroup',models(),a,kind==='create');
 if(kind==='create'){
  if(a.adGroupFormat!=='AD_GROUP_FORMAT_DEMAND_GEN')invalid('Only Demand Gen ad groups can be written: adGroupFormat is AD_GROUP_FORMAT_DEMAND_GEN.');
  if(typeof a.lineItemId!=='string'||!/^[1-9]\d*$/.test(a.lineItemId))invalid('lineItemId is the numeric ID of the Demand Gen line item, as a string.');
  const missing=['displayName','entityStatus','adGroupInventoryControl'].filter(k=>a[k]===undefined);
  if(missing.length)invalid('Creation needs '+missing.join(', ')+'.');
  fields(a,Object.keys(a));return;
 }
 const m=mask(p);
 if(!m.length||m.some(f=>!dv360AdGroupFields.includes(f))||new Set(m).size!==m.length)invalid('updateMask lists distinct top-level fields among '+dv360AdGroupFields.join(', ')+'.');
 const extra=Object.keys(a).filter(k=>!m.includes(k)),absent=m.filter(k=>a[k]===undefined);
 if(extra.length||absent.length)invalid('The body carries exactly the fields in updateMask'+(extra.length?'; not masked: '+extra.join(', '):'')+(absent.length?'; missing: '+absent.join(', '):'')+'.');
 fields(a,m);
}

type Scope={adGroupId?:string;lineItemId?:string;optional?:boolean};
const read=(p:CompiledRequest,path:string):CompiledRequest=>({...p,action:'AMCP_DV360_AD_GROUP_READ',method:'GET',path,query:{},body:undefined,headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,queryArrayEncoding:undefined,dv360AdGroupState:undefined});
/** One marked read of the advertiser; the reader below adds the ad group and its line item. Ad group targeting reads it too. */
export const dv360AdGroupStateRead=(p:CompiledRequest,scope:Scope):CompiledRequest=>({...read(p,'/v4/advertisers/'+advertiserOf(p)),dv360AdGroupState:scope});
export function dv360AdGroupReads(p:CompiledRequest):CompiledRequest[]{
 return [dv360AdGroupStateRead(p,dv360AdGroupKind(p)==='create'?{lineItemId:String((p.body as JsonObject).lineItemId)}:{adGroupId:adGroupOf(p)})];
}
export function isDV360AdGroupRead(p:CompiledRequest):boolean{return p.gateway==='dv360_native_action'&&!!p.dv360AdGroupState;}

function body(r:TransportResult,what:string):JsonObject{
 if(r.status!==200||!obj(r.data)||r.data.error)unverified('DV360 did not return the '+what+'.');
 return r.data;
}
/** One normalized form of an ad group: unset optional settings as null, sorted product dimensions, no output-only fields. */
function adGroupState(d:JsonObject,advertiser:string,id:string):JsonObject{
 if(String(d.advertiserId)!==advertiser||String(d.adGroupId)!==id||d.name!=='advertisers/'+advertiser+'/adGroups/'+id)mismatch('DV360 returned a different ad group.');
 if(d.adGroupFormat!=='AD_GROUP_FORMAT_DEMAND_GEN')invalid('Ad group '+id+' is '+String(d.adGroupFormat)+'; only Demand Gen ad groups can be written.');
 const t=obj(d.targetingExpansion)?d.targetingExpansion:undefined,f=obj(d.productFeedData)?d.productFeedData:undefined,inv=obj(d.adGroupInventoryControl)?d.adGroupInventoryControl:undefined;
 const selected=inv&&obj(inv.selectedInventories)?Object.fromEntries(inventories.map(k=>[k,inv.selectedInventories[k]===true])):undefined;
 return {adGroupId:id,lineItemId:String(d.lineItemId),displayName:d.displayName??null,entityStatus:d.entityStatus??null,
  adGroupInventoryControl:inv?(inv.adGroupInventoryStrategy?{adGroupInventoryStrategy:inv.adGroupInventoryStrategy}:{selectedInventories:selected}):null,
  bidValue:obj(d.bidStrategy)&&obj(d.bidStrategy.demandGenBid)&&micros(String(d.bidStrategy.demandGenBid.value??''))?String(d.bidStrategy.demandGenBid.value):null,
  targetingExpansion:t?{enableOptimizedTargeting:t.enableOptimizedTargeting===true,excludeDemographicExpansion:t.excludeDemographicExpansion===true}:null,
  productFeedData:f?{isFeedDisabled:f.isFeedDisabled===true,productMatchType:f.productMatchType??null,productMatchDimensions:(Array.isArray(f.productMatchDimensions)?f.productMatchDimensions:[]).map((x:JsonObject)=>stable(x)).sort()}:null};
}
/**
 * Three reads: the advertiser (currency), the ad group when one is named (absent after a verified deletion), and its line
 * item, which must be a Demand Gen line item of the advertiser.
 */
export async function readDV360AdGroups(p:CompiledRequest,fetch:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 const scope=p.dv360AdGroupState;if(!scope)return fetch(p);
 const advertiser=advertiserOf(p);
 const a=body(await fetch({...p,dv360AdGroupState:undefined}),'advertiser');
 if(String(a.advertiserId)!==advertiser||a.name!=='advertisers/'+advertiser)mismatch('DV360 returned a different advertiser.');
 const currency=obj(a.generalConfig)&&typeof a.generalConfig.currencyCode==='string'?a.generalConfig.currencyCode:null;
 let adGroup:JsonObject|null=null,lineItemId=scope.lineItemId;
 if(scope.adGroupId){
  let r:TransportResult|undefined;
  try{r=await fetch(read(p,'/v4/advertisers/'+advertiser+'/adGroups/'+scope.adGroupId));}
  catch(e){if(!(scope.optional&&e instanceof MirrorError&&(e.status===404||e.code==='NOT_FOUND')))throw e;}
  if(r){adGroup=adGroupState(body(r,'ad group'),advertiser,scope.adGroupId);if(lineItemId&&adGroup.lineItemId!==lineItemId)mismatch('Ad group '+scope.adGroupId+' belongs to another line item.');lineItemId=adGroup.lineItemId as string;}
 }
 let lineItem:JsonObject|null=null;
 if(lineItemId){
  const l=body(await fetch(read(p,'/v4/advertisers/'+advertiser+'/lineItems/'+lineItemId)),'line item');
  if(String(l.advertiserId)!==advertiser||String(l.lineItemId)!==lineItemId)mismatch('DV360 returned a different line item.');
  if(l.lineItemType!=='LINE_ITEM_TYPE_DEMAND_GEN')invalid('Line item '+lineItemId+' is '+String(l.lineItemType)+'; Demand Gen ad groups belong to LINE_ITEM_TYPE_DEMAND_GEN line items.');
  const bid=obj(l.bidStrategy)&&obj(l.bidStrategy.demandGenBid)?l.bidStrategy.demandGenBid:{};
  lineItem={lineItemId,insertionOrderId:String(l.insertionOrderId??''),displayName:l.displayName??null,entityStatus:l.entityStatus??null,bidStrategyType:bid.type??null,bidValue:micros(String(bid.value??''))?String(bid.value):null,geoLanguageTargetingEnabled:obj(l.demandGenSettings)&&l.demandGenSettings.geoLanguageTargetingEnabled===true};
 }
 return {status:200,headers:{},data:{advertiserId:advertiser,currency,adGroup,lineItem}};
}
export function validateDV360AdGroupState(read:CompiledRequest,r:TransportResult):void{
 const d=r.data,s=read.dv360AdGroupState;
 if(r.status!==200||!obj(d)||d.advertiserId!==advertiserOf(read))unverified('Missing verified DV360 ad group state.');
 // An ad group is absent only in a read that allows it (after a deletion); a present ad group or a named line item needs its line item.
 if(s?.adGroupId&&!s.optional&&!obj(d.adGroup)||(obj(d.adGroup)||s?.lineItemId)&&!obj(d.lineItem))unverified('Missing verified DV360 ad group state.');
}
export function dv360AdGroupReviewState(d:JsonObject):JsonObject{return {currency:d.currency??null,adGroup:d.adGroup??null,lineItem:d.lineItem??null};}

/** The ad group as the request leaves it, in the normalized form above. */
function after(plan:CompiledRequest,before:JsonObject|null):JsonObject{
 const a=plan.body as JsonObject,kind=dv360AdGroupKind(plan),out:JsonObject=before?{...before}:{adGroupId:null,lineItemId:a.lineItemId,displayName:null,entityStatus:null,adGroupInventoryControl:null,bidValue:null,targetingExpansion:null,productFeedData:null};
 const set=kind==='create'?Object.keys(a):mask(plan);
 for(const f of set){
  if(f==='bidStrategy')out.bidValue=a.bidStrategy.demandGenBid.value;
  else if(f==='targetingExpansion')out.targetingExpansion={enableOptimizedTargeting:a.targetingExpansion.enableOptimizedTargeting,excludeDemographicExpansion:a.targetingExpansion.excludeDemographicExpansion===true};
  else if(f==='productFeedData')out.productFeedData={isFeedDisabled:a.productFeedData.isFeedDisabled===true,productMatchType:a.productFeedData.productMatchType??null,productMatchDimensions:(a.productFeedData.productMatchDimensions??[]).map((x:JsonObject)=>stable(x)).sort()};
  else if(f==='adGroupInventoryControl')out.adGroupInventoryControl=a.adGroupInventoryControl.adGroupInventoryStrategy?{adGroupInventoryStrategy:a.adGroupInventoryControl.adGroupInventoryStrategy}:{selectedInventories:Object.fromEntries(inventories.map(k=>[k,a.adGroupInventoryControl.selectedInventories[k]===true]))};
  else if(dv360AdGroupFields.includes(f))out[f]=a[f];
 }
 return out;
}
export function validateDV360AdGroupPrerequisites(plan:CompiledRequest,states:unknown[]):void{
 const kind=dv360AdGroupKind(plan);if(!kind)return;
 const s=states[0];if(!obj(s)||!obj(s.lineItem))unverified('Missing verified DV360 ad group state.');
 if(s.lineItem.entityStatus==='ENTITY_STATUS_ARCHIVED')invalid('Line item '+s.lineItem.lineItemId+' is archived.');
 if(kind!=='create'&&!obj(s.adGroup))unverified('Missing verified DV360 ad group state.');
 if(kind==='delete')return;
 const a=plan.body as JsonObject,sets=kind==='create'?Object.keys(a):mask(plan);
 if(sets.includes('bidStrategy')&&!valueTypes.includes(s.lineItem.bidStrategyType))invalid('Line item '+s.lineItem.lineItemId+' uses '+String(s.lineItem.bidStrategyType)+'; an ad group bid value applies only to target CPA, CPC or ROAS strategies.');
 if(obj(s.adGroup)&&s.adGroup.entityStatus==='ENTITY_STATUS_ARCHIVED')invalid('Ad group '+s.adGroup.adGroupId+' is archived.');
 if(kind==='patch'&&stable(after(plan,s.adGroup as JsonObject))===stable(s.adGroup))invalid('Ad group '+adGroupOf(plan)+' already matches this request.');
}
/** An active ad group or a new bid value needs spending confirmation; the DV360 owner rule counts an active status as activation. */
export function dv360AdGroupNeedsConfirmation(plan:CompiledRequest):boolean{
 const kind=dv360AdGroupKind(plan);if(kind!=='create'&&kind!=='patch')return false;
 const a=obj(plan.body)?plan.body:{};
 return a.entityStatus==='ENTITY_STATUS_ACTIVE'||a.bidStrategy!==undefined;
}
export function dv360AdGroupImpact(plan:CompiledRequest,state:unknown[]):JsonObject|undefined{
 const kind=dv360AdGroupKind(plan);if(!kind)return;
 const first=state[0],s:JsonObject=obj(first)?first:{},before=obj(s.adGroup)?s.adGroup:null,line=obj(s.lineItem)?s.lineItem:null;
 const result=kind==='delete'?null:after(plan,before),active=result?.entityStatus==='ENTITY_STATUS_ACTIVE';
 return {provider:'dv360',scope:'demand_gen_ad_group',operation:kind,currency:s.currency??null,line_item:line,before,after:result,may_affect_serving:kind==='delete'||active||before?.entityStatus==='ENTITY_STATUS_ACTIVE',
  effect:kind==='delete'?'Deletes the Demand Gen ad group and stops everything it serves.':active?'The ad group bids once its line item and an ad are active'+(line?.entityStatus==='ENTITY_STATUS_ACTIVE'?' (the line item is active).':'.'):'The ad group stays paused; it serves nothing until it is set to active.',
  units:'An ad group bid value is in micros of the advertiser currency (1000000 is one unit), or a ROAS value where 1000000 is 100%.',
  verification:kind==='delete'?'Reads the ad group again and expects it to be gone.':'Reads the ad group again and compares every setting the request sets.',
  source:'https://developers.google.com/display-video/api/guides/tasks/serve-demand-gen-ad/create-dg-ad-group'};
}
export function dv360AdGroupOutcome(plan:CompiledRequest,r:TransportResult):boolean{
 const kind=dv360AdGroupKind(plan)!,d=r.data;
 if(r.status!==200)return false;
 if(kind==='delete')return d==null||obj(d)&&!Object.keys(d).length;
 if(!obj(d)||d.error||String(d.advertiserId)!==advertiserOf(plan)||!/^[1-9]\d*$/.test(String(d.adGroupId??''))||d.adGroupFormat!=='AD_GROUP_FORMAT_DEMAND_GEN')return false;
 return kind==='create'?String(d.lineItemId)===String((plan.body as JsonObject).lineItemId):String(d.adGroupId)===adGroupOf(plan);
}
export function dv360AdGroupVerification(plan:CompiledRequest,result:JsonObject,before:unknown[]):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const kind=dv360AdGroupKind(plan)!,first=before[0],prior=obj(first)&&obj(first.adGroup)?first.adGroup:null;
 const id=kind==='create'?String(result.data?.adGroupId??''):adGroupOf(plan);
 if(!/^[1-9]\d*$/.test(id))fail('VERIFICATION_UNSUPPORTED','The receipt names no ad group to verify.');
 const expected=kind==='delete'?null:{...after(plan,prior),adGroupId:id};
 return [{read:dv360AdGroupStateRead(plan,{adGroupId:id,optional:kind==='delete'}),expected:{adGroup:expected},id:'Demand Gen ad group '+id}];
}
export function dv360AdGroupObserved(_read:CompiledRequest,data:JsonObject):JsonObject{return {adGroup:obj(data.adGroup)?data.adGroup:null};}
