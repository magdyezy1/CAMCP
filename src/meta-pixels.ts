import {MirrorError} from './errors.js';
import type {CompiledRequest,Connection,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';

/**
 * Meta pixels of an ad account, Marketing API v25.0 ("Ad Account Adspixels" and "Ad Pixel" references, checked
 * 2026-09-27). POST /act_{ad_account_id}/adspixels creates a pixel with a name (Meta answers 6200 "A pixel already exists
 * for this account" or 6202 "More than one pixel exist for this account" when it will not); POST /{ads_pixel_id} updates
 * one. Only the name changes here: advanced matching, data use, first-party cookie and server event settings concern
 * customer data and stay outside. A pixel belongs to a business (owner_business) or to none yet; only pixels of the ad
 * account's own business, or of none, are renamed. The account's pixel list is the read before and after.
 */
type Kind='create'|'rename';
type State={kind:Kind;pixel?:string;created?:string};
type Read=CompiledRequest&{metaPixelState?:State};
const gateway='meta_native_action',nameMax=100,pageLimit=100,maxPages=5;
const actions:Record<string,Kind>={meta_ad_account_id_adspixels_create:'create',meta_pixel_id_update:'rename'};
const customerData=['automatic_matching_fields','enable_automatic_matching','data_use_setting','first_party_cookie_status','server_events_business_ids'];
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const numeric=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,31}$/.test(v);
const account=(v:unknown)=>String(v??'').replace(/^act_/,'');
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_META_PIXEL',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
export function metaPixelKind(p:CompiledRequest):Kind|undefined{
 if(p.gateway!==gateway||p.method!=='POST'||p.specialTransport||p.origin&&p.origin!=='https://graph.facebook.com')return;
 const k=actions[p.action];if(!k)return;
 if(k==='create'&&/^\/v25\.0\/act_[0-9]{1,32}\/adspixels$/.test(p.path))return k;
 if(k==='rename'&&/^\/v25\.0\/[1-9][0-9]{0,31}$/.test(p.path))return k;
}
const pixelOf=(p:CompiledRequest)=>p.path.split('/')[2]!;
export function assertMetaPixel(p:CompiledRequest):void{
 const kind=metaPixelKind(p);if(!kind)return;
 if(!numeric(account(p.accountId)))invalid('Select one Meta ad account.');
 if(kind==='create'&&p.path.split('/')[2]!=='act_'+account(p.accountId))fail('ACCOUNT_SCOPE_MISMATCH','Create the pixel in the selected ad account.',{},403);
 if(Object.keys(p.query).length||Object.keys(p.headers).length)invalid('Pixel writes take no query or header overrides.');
 const b=p.body;if(!object(b))invalid('Send a native object body.');
 const data=Object.keys(b).filter(k=>customerData.includes(k));
 if(data.length)invalid('Advanced matching, data use, first-party cookie and server event settings ('+data.join(', ')+') concern customer data and are not changed here.');
 const extra=Object.keys(b).filter(k=>k!=='name');if(extra.length)invalid('A pixel '+kind+' takes only name, not '+extra.join(', ')+'.');
 const n=b.name;
 if(typeof n!=='string'||!n.trim()||n!==n.trim()||[...n].length>nameMax||/[\u0000-\u001f\u007f]/.test(n))invalid('name has 1–'+nameMax+' characters without surrounding spaces or control characters.');
}
/** Connections created before ads_management was granted cannot change pixels. */
export function assertMetaPixelScope(c:Connection,write=false):void{
 if(write?!c.scopes.includes('ads_management'):!c.scopes.some(s=>s==='ads_management'||s==='ads_read'))fail('INSUFFICIENT_SCOPE','Reconnect Meta with ads_management to create or rename pixels.',{},403);
}
/** The rename writes to /{ads_pixel_id}; the review proves the pixel is listed for the selected ad account. */
export function authorizeMetaPixel(p:CompiledRequest,_c:Connection,selected:string):boolean{
 if(metaPixelKind(p)!=='rename')return false;
 assertMetaPixel(p);if(account(p.accountId)!==selected)fail('ACCOUNT_SCOPE_MISMATCH','Select the ad account that lists this pixel.',{},403);return true;
}
const read=(p:CompiledRequest,path:string,query:JsonObject,state?:State):Read=>({...p,action:'AMCP_META_PIXEL_READ',method:'GET',path,query,body:undefined,headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,metaPixelState:state});
const accountRead=(p:CompiledRequest,s:State)=>read(p,'/v25.0/act_'+account(p.accountId),{fields:'id,business'},s);
export function metaPixelSnapshots(p:CompiledRequest):Read[]{const kind=metaPixelKind(p)!;return [accountRead(p,{kind,...(kind==='rename'?{pixel:pixelOf(p)}:{})})];}
export function isMetaPixelRead(p:CompiledRequest):p is Read{return p.gateway===gateway&&!!(p as Read).metaPixelState;}
/** The ad account's business and every pixel it lists, as id, name and owner business. */
export async function readMetaPixels(p:CompiledRequest,fetch:(p:Read)=>Promise<TransportResult>):Promise<TransportResult>{
 const s=(p as Read).metaPixelState;if(!s)return fetch(p as Read);
 const a=await fetch({...(p as Read),metaPixelState:undefined}),ad=a.data;
 if(a.status!==200||!object(ad)||ad.error||account(ad.id)!==account(p.accountId))unverified('Meta did not return the selected ad account.');
 const business=object(ad.business)&&numeric(String(ad.business.id))?String(ad.business.id):null;
 const pixels:JsonObject[]=[],seen=new Set<string>();let after:string|undefined;
 for(let page=0;;page++){
  if(page>=maxPages)unverified('The ad account lists more pixels than one review reads.');
  const r=await fetch(read(p,'/v25.0/act_'+account(p.accountId)+'/adspixels',{fields:'id,name,owner_business',limit:pageLimit,...(after?{after}:{})})),d=r.data;
  if(r.status!==200||!object(d)||d.error||!Array.isArray(d.data))unverified('Meta did not list the pixels of the ad account.');
  for(const x of d.data as unknown[]){
   if(!object(x)||!numeric(String(x.id))||seen.has(String(x.id)))unverified('A pixel row is malformed or repeated.');seen.add(String(x.id));
   pixels.push({id:String(x.id),name:typeof x.name==='string'?x.name:null,owner_business:object(x.owner_business)&&x.owner_business.id!==undefined?String(x.owner_business.id):null});
  }
  const next=object(d.paging)&&object(d.paging.cursors)&&d.paging.next?d.paging.cursors.after:undefined;
  if(!next)break;if(typeof next!=='string'||next===after)unverified('Pixel pagination is repeated or malformed.');after=next;
 }
 pixels.sort((x,y)=>String(x.id).localeCompare(String(y.id)));
 return {status:200,headers:{},data:{business,pixels}};
}
export function validateMetaPixelState(p:CompiledRequest,r:TransportResult):void{
 const d=r.data;if(!(p as Read).metaPixelState||r.status!==200||!object(d)||!Array.isArray(d.pixels)||!('business' in d))unverified('Missing verified pixel state.');
}
export function metaPixelPrerequisites(p:CompiledRequest,states:unknown[]):void{
 const kind=metaPixelKind(p);if(!kind)return;
 const s=states[0];if(!object(s)||!Array.isArray(s.pixels))unverified('Missing verified pixel state.');
 if(kind==='create')return;
 const id=pixelOf(p),row=(s.pixels as JsonObject[]).find(x=>x.id===id);
 if(!row)fail('STATE_NOT_FOUND','Pixel '+id+' is not listed for the selected ad account.',{pixel_id:id});
 if(row.owner_business!==null&&row.owner_business!==s.business)fail('STATE_TARGET_MISMATCH','Pixel '+id+' belongs to another business; only its owner renames it.',{pixel_id:id,owner_business:String(row.owner_business)},409);
 if(row.name===(p.body as JsonObject).name)invalid('Pixel '+id+' is already named "'+String((p.body as JsonObject).name)+'".');
}
export function metaPixelImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 const kind=metaPixelKind(p);if(!kind)return;
 const first=state[0],s:JsonObject=object(first)?first:{},pixels=Array.isArray(s.pixels)?s.pixels as JsonObject[]:[];
 return {provider:'meta',scope:'pixel',operation:kind,name:(p.body as JsonObject).name,...(kind==='rename'?{pixel:pixels.find(x=>x.id===pixelOf(p))??{id:pixelOf(p)}}:{listed_pixels:pixels.length}),may_affect_serving:false,
  effect:kind==='create'?'Creates a pixel for the ad account. It measures nothing until its code is installed on a website; Meta refuses a second pixel created this way (error 6200).':'Renames the pixel; its code, events, matching and data settings are unchanged.',
  verification:'Lists the pixels of the ad account again and compares the name.',source:'https://developers.facebook.com/docs/marketing-api/reference/ads-pixel/'};
}
export function metaPixelOutcome(p:CompiledRequest,r:TransportResult):boolean{
 if(r.status!==200||!object(r.data)||r.data.error)return false;
 return metaPixelKind(p)==='create'?numeric(String(r.data.id)):r.data.success===true;
}
export function metaPixelVerification(p:CompiledRequest,result:JsonObject):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const kind=metaPixelKind(p)!,id=kind==='create'?String(result.data?.id??''):pixelOf(p);
 if(!numeric(id))fail('VERIFICATION_UNSUPPORTED','The creation receipt has no pixel ID.');
 return [{read:accountRead(p,{kind,created:id}),expected:{pixel:{present:true,name:(p.body as JsonObject).name}},id}];
}
export function metaPixelObserved(read:CompiledRequest,data:JsonObject):JsonObject{
 const id=(read as Read).metaPixelState?.created,row=(Array.isArray(data.pixels)?data.pixels as JsonObject[]:[]).find(x=>x.id===id);
 return {pixel:row?{present:true,name:row.name,owner_business:row.owner_business}:{present:false}};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const metaPixelFamily:ReviewedFamily={
 name:'meta_pixels',
 files:['src/meta-pixels.ts',['tests/meta-pixels.test.mjs']],
 kind:metaPixelKind,
 assert:assertMetaPixel,
 scope:assertMetaPixelScope,
 authorize:authorizeMetaPixel,
 snapshots:metaPixelSnapshots,
 isRead:isMetaPixelRead,
 reader:readMetaPixels,
 validateState:validateMetaPixelState,
 prerequisites:metaPixelPrerequisites,
 impact:metaPixelImpact,
 outcome:metaPixelOutcome,
 verification:metaPixelVerification,
 observed:metaPixelObserved,
 exemptFromSpendTextMatch:true,
};
