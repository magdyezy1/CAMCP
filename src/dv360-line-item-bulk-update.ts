import {MirrorError} from './errors.js';
import type {CompiledRequest,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {assertDV360WriteScope} from './dv360-scope.js';

/**
 * Bulk status and EU political advertising updates of DV360 line items, per the pinned Display & Video 360 API v4 Discovery
 * document (advertisers.lineItems.bulkUpdate, BulkUpdateLineItemsRequest and Response, LineItem.entityStatus and
 * containsEuPoliticalAds; checked 2026-09-27). updateMask supports only entityStatus and containsEuPoliticalAds. A line item
 * cannot return to draft; an active line item spends only while its insertion order is active. YouTube & Partners line
 * items cannot be updated through the API, and the request must not run concurrently with other updates of the same line
 * items. The response lists updated, skipped (no change) and failed line items.
 */
type Read=CompiledRequest&{dv360BulkLineItemState?:{lineItemIds:string[]}};
const origin='https://displayvideo.googleapis.com',route=/^\/v4\/advertisers\/([1-9]\d*)\/lineItems:bulkUpdate$/,maxLineItems=100;
const statuses=['ENTITY_STATUS_ACTIVE','ENTITY_STATUS_PAUSED','ENTITY_STATUS_ARCHIVED'],euValues=['CONTAINS_EU_POLITICAL_ADVERTISING','DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING'],fields=['entityStatus','containsEuPoliticalAds'];
const youtube=/^LINE_ITEM_TYPE_YOUTUBE_AND_PARTNERS/;
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const list=(v:unknown):unknown[]=>Array.isArray(v)?v:[];
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_DV360_LINE_ITEM_BULK',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
const advertiserOf=(p:CompiledRequest)=>route.exec(p.path)![1]!;
const mask=(p:CompiledRequest):string[]=>String(obj(p.body).updateMask??'').split(',').map(s=>s.trim()).filter(Boolean);
function obj(v:unknown):JsonObject{return object(v)?v:{};}
export function dv360LineItemBulkKind(p:CompiledRequest):boolean{
 return p.gateway==='dv360_native_action'&&p.method==='POST'&&!p.specialTransport&&(p.origin===undefined||p.origin===origin)&&route.test(p.path);
}
const ids=(p:CompiledRequest)=>list(obj(p.body).lineItemIds).map(String);
export function assertDV360LineItemBulk(p:CompiledRequest):void{
 if(!dv360LineItemBulkKind(p))return;
 if(advertiserOf(p)!==p.accountId)fail('ACCOUNT_SCOPE_MISMATCH','The request must use the selected advertiser.',{},403);
 if(Object.keys(p.query).length||Object.keys(p.headers??{}).length)invalid('Bulk line item updates take no query parameters or header overrides.');
 const b=p.body;if(!object(b))invalid('Provide the native BulkUpdateLineItemsRequest.');
 const extra=Object.keys(b).filter(k=>!['lineItemIds','targetLineItem','updateMask'].includes(k));if(extra.length)invalid('Unqualified fields: '+extra.join(', ')+'.');
 const l=b.lineItemIds;
 if(!Array.isArray(l)||!l.length||l.length>maxLineItems||l.some(x=>typeof x!=='string'||!/^[1-9]\d*$/.test(x))||new Set(l).size!==l.length)invalid('lineItemIds lists 1–'+maxLineItems+' distinct line items of the advertiser as decimal strings.');
 const m=mask(p);
 if(!m.length||m.some(f=>!fields.includes(f))||new Set(m).size!==m.length)invalid('updateMask lists entityStatus, containsEuPoliticalAds or both; DV360 supports no other bulk fields.');
 const t=b.targetLineItem;if(!object(t))invalid('targetLineItem holds the new values.');
 const sent=Object.keys(t);if(sent.some(k=>!m.includes(k))||m.some(k=>t[k]===undefined))invalid('targetLineItem carries exactly the fields in updateMask.');
 if(t.entityStatus!==undefined&&!statuses.includes(t.entityStatus))invalid('entityStatus is ENTITY_STATUS_ACTIVE, ENTITY_STATUS_PAUSED or ENTITY_STATUS_ARCHIVED; a line item cannot return to draft.');
 if(t.containsEuPoliticalAds!==undefined&&!euValues.includes(t.containsEuPoliticalAds))invalid('containsEuPoliticalAds is CONTAINS_EU_POLITICAL_ADVERTISING or DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING.');
}
function read(p:CompiledRequest,path:string):Read{return {...p,action:'AMCP_DV360_LINE_ITEM_BULK_READ',method:'GET',path,query:{},body:undefined,headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,queryArrayEncoding:undefined,dv360BulkLineItemState:undefined};}
/** One marked read of the advertiser; the reader adds each line item and its insertion order. */
export function dv360LineItemBulkSnapshots(p:CompiledRequest):Read[]{return [{...read(p,'/v4/advertisers/'+advertiserOf(p)),dv360BulkLineItemState:{lineItemIds:[...ids(p)].sort()}}];}
export function isDV360LineItemBulkRead(p:CompiledRequest):p is Read{return p.gateway==='dv360_native_action'&&!!(p as Read).dv360BulkLineItemState;}
export async function readDV360LineItemBulk(p:CompiledRequest,fetch:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 const s=(p as Read).dv360BulkLineItemState;if(!s)return fetch(p);
 const advertiser=p.path.split('/')[3]!;
 const get=async(path:string)=>{const r=await fetch(read(p,path)),d=r.data;if(r.status!==200||!object(d)||d.error)unverified('DV360 did not return '+path+'.');return d as JsonObject;};
 const adv=await get('/v4/advertisers/'+advertiser);if(String(adv.advertiserId)!==advertiser)unverified('DV360 returned another advertiser.');
 const lineItems:JsonObject={},orders:JsonObject={};
 for(const id of s.lineItemIds){
  const d=await get('/v4/advertisers/'+advertiser+'/lineItems/'+id);
  if(String(d.advertiserId)!==advertiser||String(d.lineItemId)!==id)fail('STATE_TARGET_MISMATCH','Line item '+id+' is not a line item of the selected advertiser.',{line_item_id:id},409);
  const io=String(d.insertionOrderId??'');
  lineItems[id]={lineItemId:id,insertionOrderId:io,displayName:d.displayName??null,lineItemType:d.lineItemType??null,entityStatus:d.entityStatus??null,containsEuPoliticalAds:d.containsEuPoliticalAds??null};
  if(io&&!Object.hasOwn(orders,io)){const o=await get('/v4/advertisers/'+advertiser+'/insertionOrders/'+io);orders[io]={insertionOrderId:io,entityStatus:o.entityStatus??null};}
 }
 return {status:200,headers:{},data:{advertiserId:advertiser,lineItems,insertionOrders:orders}};
}
export function validateDV360LineItemBulkState(p:CompiledRequest,r:TransportResult):void{
 const d=r.data,s=(p as Read).dv360BulkLineItemState;
 if(!s||r.status!==200||!object(d)||!object(d.lineItems)||s.lineItemIds.some(id=>!object((d.lineItems as JsonObject)[id])))unverified('Missing verified line item state.');
}
export function dv360LineItemBulkPrerequisites(p:CompiledRequest,states:unknown[]):void{
 if(!dv360LineItemBulkKind(p))return;
 const s=states[0];if(!object(s)||!object(s.lineItems))unverified('Missing verified line item state.');
 const t=obj(obj(p.body).targetLineItem);let changes=0;
 for(const id of ids(p)){
  const li=obj(s.lineItems[id]);
  if(youtube.test(String(li.lineItemType)))invalid('Line item '+id+' is '+li.lineItemType+'; YouTube & Partners line items cannot be updated through the API.');
  if(li.entityStatus==='ENTITY_STATUS_ARCHIVED'&&t.entityStatus!=='ENTITY_STATUS_ARCHIVED')invalid('Line item '+id+' is archived.');
  if(Object.entries(t).some(([k,v])=>li[k]!==v))changes++;
 }
 if(!changes)invalid('Every line item already has these values.');
}
/** Setting a line item active lets it spend once its insertion order is active. */
export function dv360LineItemBulkNeedsConfirmation(p:CompiledRequest):boolean{return dv360LineItemBulkKind(p)&&obj(obj(p.body).targetLineItem).entityStatus==='ENTITY_STATUS_ACTIVE';}
export function dv360LineItemBulkImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 if(!dv360LineItemBulkKind(p))return;
 const first=state[0],s:JsonObject=object(first)?first:{},lines=obj(s.lineItems),orders=obj(s.insertionOrders),t=obj(obj(p.body).targetLineItem);
 const rows=ids(p).map(id=>{const li=obj(lines[id]),io=obj(orders[String(li.insertionOrderId)]);return {line_item_id:id,display_name:li.displayName??null,before:{entity_status:li.entityStatus??null,contains_eu_political_ads:li.containsEuPoliticalAds??null},insertion_order_status:io.entityStatus??null,unchanged:Object.entries(t).every(([k,v])=>li[k]===v)};});
 const activating=t.entityStatus==='ENTITY_STATUS_ACTIVE';
 return {provider:'dv360',scope:'line_item_bulk_update',line_items:rows,after:{entity_status:t.entityStatus??'(unchanged)',contains_eu_political_ads:t.containsEuPoliticalAds??'(unchanged)'},may_affect_serving:t.entityStatus!==undefined,
  effect:activating?'The line items can spend at once where their insertion order is active, and once it becomes active otherwise.':t.entityStatus==='ENTITY_STATUS_ARCHIVED'?'The line items stop serving and are archived.':t.entityStatus==='ENTITY_STATUS_PAUSED'?'The line items stop serving.':'Changes only the EU political advertising declaration.',
  bulk_semantics:'DV360 reports updated, skipped (already set) and failed line items; a failure of one does not undo the others, and AMCP never resubmits a partial outcome.',
  verification:'Reads every line item again and compares the updated fields.',source:'https://developers.google.com/display-video/api/reference/rest/v4/advertisers.lineItems/bulkUpdate'};
}
export function dv360LineItemBulkOutcome(p:CompiledRequest,r:TransportResult):boolean{
 const d=r.data;if(r.status!==200||!object(d)||d.error)return false;
 const done=[...list(d.updatedLineItemIds),...list(d.skippedLineItemIds)].map(String).sort();
 return !list(d.failedLineItemIds).length&&!list(d.errors).length&&JSON.stringify(done)===JSON.stringify([...ids(p)].sort());
}
export function dv360LineItemBulkVerification(p:CompiledRequest):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const t=obj(obj(p.body).targetLineItem),read=dv360LineItemBulkSnapshots(p)[0]!;
 return [{read,expected:{lineItems:Object.fromEntries(ids(p).map(id=>[id,{...t}]))},id:'lineItems '+ids(p).join(',')}];
}
export function dv360LineItemBulkObserved(_read:CompiledRequest,data:JsonObject):JsonObject{
 return {lineItems:Object.fromEntries(Object.entries(obj(data.lineItems)).map(([id,li])=>[id,{entityStatus:obj(li).entityStatus??null,containsEuPoliticalAds:obj(li).containsEuPoliticalAds??null}]))};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const dv360LineItemBulkFamily:ReviewedFamily={
 name:'dv360_line_item_bulk_update',
 files:['src/dv360-line-item-bulk-update.ts',['tests/dv360-line-item-bulk-update.test.mjs']],
 kind:dv360LineItemBulkKind,
 assert:assertDV360LineItemBulk,
 scope:assertDV360WriteScope,
 snapshots:dv360LineItemBulkSnapshots,
 isRead:isDV360LineItemBulkRead,
 reader:readDV360LineItemBulk,
 validateState:validateDV360LineItemBulkState,
 prerequisites:dv360LineItemBulkPrerequisites,
 impact:dv360LineItemBulkImpact,
 outcome:dv360LineItemBulkOutcome,
 verification:dv360LineItemBulkVerification,
 observed:dv360LineItemBulkObserved,
 spendConfirmation:{needed:dv360LineItemBulkNeedsConfirmation,message:'Active line items spend once their insertion order is active. Review the line items and provide spend_change_confirmed=true.'},
 exemptFromSpendTextMatch:true,
};
