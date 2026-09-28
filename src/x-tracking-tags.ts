import {MirrorError} from './errors.js';
import type {CompiledRequest,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';

/**
 * Tracking tags of X Ads line items, Ads API v12 (Campaign Management reference, "Tracking Tags"; docs.x.com copy read on
 * 2026-09-24 and rechecked 2026-09-27). POST associates a partner tag (IMPRESSION_TAG or CLICK_TRACKER) with a line item,
 * PUT replaces the URL of a tag and DELETE disassociates it. X documents the URL only as the one "provided by the tracking
 * partner", so AMCP checks its form and leaves partner acceptance to X.
 */
type Kind='create'|'update'|'delete';
type State={lineItemId?:string;tagId?:string};
type Read=CompiledRequest&{xTrackingTagState?:State};
const gateway='x_ads_native_action',nativeId=/^[a-z0-9]{1,32}$/,tagTypes=['IMPRESSION_TAG','CLICK_TRACKER'];
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_X_TRACKING_TAG',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
export function xTrackingTagKind(p:CompiledRequest):Kind|undefined{
 if(p.gateway!==gateway||p.specialTransport)return;
 if(p.method==='POST'&&/^\/12\/accounts\/[a-z0-9]{1,32}\/tracking_tags$/.test(p.path))return 'create';
 if(['PUT','DELETE'].includes(p.method)&&/^\/12\/accounts\/[a-z0-9]{1,32}\/tracking_tags\/[a-z0-9]{1,32}$/.test(p.path))return p.method==='PUT'?'update':'delete';
 return;
}
const account=(p:CompiledRequest)=>p.path.split('/')[3]!,tagOf=(p:CompiledRequest)=>p.path.split('/')[5]!;
const body=(p:CompiledRequest):JsonObject=>object(p.body)?p.body:{};
function trackingUrl(v:unknown):string{
 if(typeof v!=='string'||v.length>2048||/[\s\u0000-\u001f\u007f]/.test(v))invalid('tracking_tag_url is the partner URL: at most 2048 characters without spaces or control characters.');
 let u:URL;try{u=new URL(v as string);}catch{return invalid('tracking_tag_url must be an absolute URL.');}
 if(u.protocol!=='https:'||!u.hostname.includes('.')||u.username||u.password)invalid('tracking_tag_url must be an https URL of the tracking partner, without credentials.');
 return v as string;
}
export function assertXTrackingTag(p:CompiledRequest):void{
 const kind=xTrackingTagKind(p);if(!kind)return;
 if(account(p)!==p.accountId)fail('ACCOUNT_SCOPE_MISMATCH','The request must use the selected account.',{},403);
 if(Object.keys(p.query).length||Object.keys(p.headers??{}).length)invalid('Tracking tag writes take their parameters in the body, without query or header overrides.');
 const b=p.body===undefined?{}:p.body;if(!object(b))invalid('Provide the native tracking tag parameters.');
 const allowed=kind==='create'?['line_item_id','tracking_tag_type','tracking_tag_url']:kind==='update'?['tracking_tag_url']:[];
 const extra=Object.keys(b).filter(k=>!allowed.includes(k));if(extra.length)invalid((kind==='update'&&extra.some(k=>['line_item_id','tracking_tag_type'].includes(k))?'Only the URL of a tag changes; create a new tag for another line item or type. ':'')+'Unqualified fields: '+extra.join(', ')+'.');
 if(kind==='create'){
  if(typeof b.line_item_id!=='string'||!nativeId.test(b.line_item_id))invalid('line_item_id is the native ID of a line item of the selected account.');
  if(!tagTypes.includes(b.tracking_tag_type))invalid('tracking_tag_type is IMPRESSION_TAG or CLICK_TRACKER.');
 }
 if(kind!=='delete')trackingUrl(b.tracking_tag_url);
}
function read(p:CompiledRequest,path:string,query:JsonObject={}):Read{return {...p,action:'AMCP_X_TRACKING_TAG_READ',method:'GET',path:'/12/accounts/'+account(p)+path,query,body:undefined,headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,xTrackingTagState:undefined};}
const stateRead=(p:CompiledRequest,state:State):Read=>({...read(p,''),xTrackingTagState:state});
/** One marked read of the account; the reader adds the tag, its line item and the line item's tags. */
export function xTrackingTagSnapshots(p:CompiledRequest):Read[]{
 return [stateRead(p,xTrackingTagKind(p)==='create'?{lineItemId:String(body(p).line_item_id)}:{tagId:tagOf(p)})];
}
export function isXTrackingTagRead(p:CompiledRequest):p is Read{return p.gateway===gateway&&!!(p as Read).xTrackingTagState;}
const tagView=(t:JsonObject)=>({id:String(t.id),lineItemId:String(t.line_item_id),type:t.tracking_tag_type??null,url:t.tracking_tag_url??null,deleted:t.deleted===true});
export async function readXTrackingTags(p:CompiledRequest,send:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 const s=(p as Read).xTrackingTagState;if(!s)return send(p);
 let requests=0;
 const get=async(q:Read)=>{if(++requests>8)unverified('Tracking tag reads exceeded their bound.');const r=await send(q),d=r.data;if(r.status!==200||!object(d)||Array.isArray(d.errors)&&d.errors.length)unverified('X returned a failed or unrecognized read.');return d as JsonObject;};
 const acct=await get(read(p,''));if(!object(acct.data)||String(acct.data.id)!==account(p))unverified('X returned another account.');
 let tag:JsonObject|null=null,lineItemId=s.lineItemId;
 if(s.tagId){
  const d=(await get(read(p,'/tracking_tags/'+s.tagId,{with_deleted:true}))).data;
  if(!object(d)||String(d.id)!==s.tagId||!nativeId.test(String(d.line_item_id)))fail('STATE_TARGET_MISMATCH','Tracking tag '+s.tagId+' is not a tracking tag of the selected account.',{tracking_tag_id:s.tagId},409);
  tag=tagView(d);lineItemId=String(d.line_item_id);
 }
 const l=(await get(read(p,'/line_items/'+lineItemId,{with_deleted:true}))).data;
 if(!object(l)||String(l.id)!==lineItemId)fail('STATE_TARGET_MISMATCH','Line item '+lineItemId+' is not a line item of the selected account.',{line_item_id:lineItemId!},409);
 const listed=await get(read(p,'/tracking_tags',{line_item_ids:lineItemId,count:1000}));
 if(!Array.isArray(listed.data)||listed.next_cursor)unverified('The tracking tags of line item '+lineItemId+' are incomplete.');
 const tags:JsonObject={};
 for(const row of listed.data as unknown[]){if(!object(row)||!nativeId.test(String(row.id))||String(row.line_item_id)!==lineItemId||Object.hasOwn(tags,String(row.id)))unverified('A tracking tag row is foreign, malformed or repeated.');if(row.deleted!==true){const v=tagView(row);tags['t'+v.id]={type:v.type,url:v.url};}}
 return {status:200,headers:{},data:{accountId:account(p),line:{id:lineItemId,campaignId:l.campaign_id??null,name:l.name??null,status:l.entity_status??null,deleted:l.deleted===true},tag,tags}};
}
export function validateXTrackingTagState(p:CompiledRequest,r:TransportResult):void{
 const s=(p as Read).xTrackingTagState,d=r.data;
 if(!s||r.status!==200||!object(d)||!object(d.line)||!object(d.tags)||!!s.tagId!==object(d.tag))unverified('Missing verified tracking tag state.');
}
export function xTrackingTagPrerequisites(p:CompiledRequest,states:unknown[]):void{
 const kind=xTrackingTagKind(p);if(!kind)return;
 const s=states[0];if(!object(s)||!object(s.line)||!object(s.tags))unverified('Missing verified tracking tag state.');
 if(s.line.deleted===true)invalid('Line item '+s.line.id+' is deleted.');
 const b=body(p);
 if(kind==='create'){
  const same=Object.entries(s.tags).find(([,t])=>object(t)&&t.type===b.tracking_tag_type&&t.url===b.tracking_tag_url);
  if(same)fail('CONFIGURATION_EXISTS','Line item '+s.line.id+' already has this '+String(b.tracking_tag_type)+' as tracking tag '+same[0].slice(1)+'.',{tracking_tag_id:same[0].slice(1)});
  return;
 }
 const tag=s.tag;if(!object(tag)||tag.deleted===true)invalid('Tracking tag '+tagOf(p)+' is deleted.');
 if(kind==='update'&&tag.url===b.tracking_tag_url)invalid('Tracking tag '+tagOf(p)+' already has this URL.');
}
export function xTrackingTagImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 const kind=xTrackingTagKind(p);if(!kind)return;
 const first=state[0],s:JsonObject=object(first)?first:{},b=body(p),tag=object(s.tag)?s.tag:null;
 const type=kind==='create'?b.tracking_tag_type:tag?.type;
 return {provider:'x',scope:'tracking_tag',operation:kind,line_item:object(s.line)?s.line:null,before:tag,after:kind==='delete'?null:{type,url:b.tracking_tag_url},may_affect_serving:false,
  effect:(kind==='delete'?'Removes the partner tracker from the line item.':'Makes every ad of the line item call the partner URL')+(type==='CLICK_TRACKER'?' on each click; a broken click tracker can break the way to the landing page.':kind==='delete'?'':' on each impression.')+' Delivery and budgets do not change.',
  verification:kind==='delete'?'Reads the tag again and checks that it is deleted.':'Reads the tag again: its line item, type and URL.',
  source:'https://docs.x.com/x-ads-api/campaign-management/reference'};
}
export function xTrackingTagOutcome(p:CompiledRequest,r:TransportResult):boolean{
 const kind=xTrackingTagKind(p)!,d=r.data,t=object(d)&&object(d.data)?d.data:undefined,b=body(p);
 if(![200,201].includes(r.status)||!t||!nativeId.test(String(t.id))||Array.isArray((d as JsonObject).errors)&&(d as JsonObject).errors.length)return false;
 if(kind==='create')return t.line_item_id===b.line_item_id&&t.tracking_tag_type===b.tracking_tag_type&&t.tracking_tag_url===b.tracking_tag_url&&t.deleted!==true;
 if(kind==='update')return t.id===tagOf(p)&&t.tracking_tag_url===b.tracking_tag_url&&t.deleted!==true;
 return t.id===tagOf(p)&&t.deleted===true;
}
export function xTrackingTagVerification(p:CompiledRequest,result:JsonObject,before:unknown[]):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const kind=xTrackingTagKind(p)!,created=result.data?.data?.id,id=kind==='create'?created:tagOf(p);
 if(typeof id!=='string'||!nativeId.test(id))fail('VERIFICATION_UNSUPPORTED','The receipt names no tracking tag to verify.');
 const first=before[0],prior=object(first)&&object(first.tag)?first.tag:{},b=body(p);
 const expected=kind==='delete'?{id,deleted:true}:{id,lineItemId:kind==='create'?b.line_item_id:prior.lineItemId,type:kind==='create'?b.tracking_tag_type:prior.type,url:b.tracking_tag_url,deleted:false};
 return [{read:stateRead(p,{tagId:id}),expected:{tag:expected},id:'tracking tag '+id}];
}
export function xTrackingTagObserved(_read:CompiledRequest,data:JsonObject):JsonObject{return {tag:object(data.tag)?data.tag:null};}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const xTrackingTagFamily:ReviewedFamily={
 name:'x_tracking_tags',
 files:['src/x-tracking-tags.ts',['tests/x-tracking-tags.test.mjs']],
 kind:xTrackingTagKind,
 assert:assertXTrackingTag,
 snapshots:xTrackingTagSnapshots,
 isRead:isXTrackingTagRead,
 reader:readXTrackingTags,
 validateState:validateXTrackingTagState,
 prerequisites:xTrackingTagPrerequisites,
 impact:xTrackingTagImpact,
 outcome:xTrackingTagOutcome,
 verification:xTrackingTagVerification,
 observed:xTrackingTagObserved,
 exemptFromSpendTextMatch:true,
};
