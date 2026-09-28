import {MirrorError} from './errors.js';
import type {CompiledRequest,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';

/**
 * Deleting TikTok saved audiences and custom identities, per API for Business v1.3 "Delete Saved Audiences", "Get details
 * of Saved Audiences", "Delete an identity" and "Get the identity list" (checked 2026-09-27). Up to 100 saved audiences
 * go in one request; "If you have already applied a Saved Audience to an ad group, then you can only delete the Saved
 * Audience when the ad group has been deleted". Only CUSTOMIZED_USER identities can be deleted ("If you want to edit an
 * identity, you need to first delete the identity"). Replies carry code 0 and no data, so the review reads the audiences
 * or identities with the ad groups or ads that use them, and verification reads them again.
 */
type Kind='saved_audience'|'identity';
type State={kind:Kind;ids:string[];usage:boolean};
type Read=CompiledRequest&{tiktokDeletionState?:State};
export const tiktokDeletionPaths={saved_audience:'/v1.3/dmp/saved_audience/delete/',identity:'/v1.3/identity/delete/'};
const gateway='tiktok_native_action',maxAudiences=100,identityPageSize=100,maxIdentityPages=10,usagePageSize=1000,maxUsagePages=10;
const obj=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const numeric=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,31}$/.test(v),identityId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_TIKTOK_DELETION',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
export function tiktokDeletionKind(p:CompiledRequest):Kind|undefined{
 if(p.gateway!==gateway||p.method!=='POST'||p.specialTransport)return;
 return (Object.entries(tiktokDeletionPaths).find(([,path])=>path===p.path)?.[0]) as Kind|undefined;
}
const body=(p:CompiledRequest):JsonObject=>obj(p.body)?p.body:{};
const idsOf=(p:CompiledRequest)=>tiktokDeletionKind(p)==='identity'?[String(body(p).identity_id)]:[...body(p).saved_audience_ids as string[]].sort();
export function assertTiktokDeletion(p:CompiledRequest):void{
 const kind=tiktokDeletionKind(p);if(!kind)return;
 if(Object.keys(p.query).length)invalid('Deletions take no query parameters.');
 const b=p.body,allowed=kind==='identity'?['advertiser_id','identity_id','identity_type']:['advertiser_id','saved_audience_ids'];
 if(!obj(b)||Object.keys(b).some(k=>!allowed.includes(k)))invalid('This request takes '+allowed.join(', ')+'.');
 if(String(b.advertiser_id)!==p.accountId)fail('ACCOUNT_SCOPE_MISMATCH','advertiser_id must be the selected advertiser.',{},403);
 if(kind==='identity'){
  if(b.identity_type!=='CUSTOMIZED_USER')invalid('identity_type is CUSTOMIZED_USER; TikTok deletes only custom identities.');
  if(!identityId(b.identity_id))invalid('identity_id names the custom identity to delete.');
  return;
 }
 const ids=b.saved_audience_ids;
 if(!Array.isArray(ids)||!ids.length||ids.length>maxAudiences||ids.some(x=>!numeric(x))||new Set(ids).size!==ids.length)invalid('saved_audience_ids lists 1–'+maxAudiences+' different numeric saved audience IDs.');
}
const read=(p:CompiledRequest,action:string,path:string,query:JsonObject,state?:State):Read=>({...p,action,method:'GET',path,query:{advertiser_id:p.accountId,...query},body:undefined,headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,tiktokDeletionState:state});
function stateRead(p:CompiledRequest,state:State):Read{
 return state.kind==='identity'?read(p,'tiktok_identity_get','/v1.3/identity/get/',{identity_type:'CUSTOMIZED_USER',page:1,page_size:identityPageSize},state)
  :read(p,'tiktok_dmp_saved_audience_list_get','/v1.3/dmp/saved_audience/list/',{saved_audience_ids:state.ids},state);
}
export function tiktokDeletionSnapshots(p:CompiledRequest):Read[]{return [stateRead(p,{kind:tiktokDeletionKind(p)!,ids:idsOf(p),usage:true})];}
export function isTiktokDeletionRead(p:CompiledRequest):p is Read{return p.gateway===gateway&&!!(p as Read).tiktokDeletionState;}
function ok(r:TransportResult,label:string):JsonObject{const d=r.data;if(r.status!==200||!obj(d)||d.code!==0||!obj(d.data))unverified('TikTok did not return the '+label+'.');return (d as JsonObject).data;}
async function pages(first:Read,key:string,label:string,max:number,request:(p:CompiledRequest)=>Promise<TransportResult>):Promise<JsonObject[]>{
 const out:JsonObject[]=[];let total=1;
 for(let page=1;page<=total;page++){
  if(page>max)unverified('The advertiser has more '+label+' than one review reads.');
  const d=ok(await request({...first,tiktokDeletionState:undefined,query:{...first.query,page}} as Read),label);
  if(d[key]!==undefined&&!Array.isArray(d[key]))unverified('TikTok did not list the '+label+'.');
  const n=Number(obj(d.page_info)?d.page_info.total_page??1:1);if(!Number.isInteger(n)||n<0)unverified('TikTok returned an invalid page count.');
  if(page===1)total=Math.max(n,1);
  for(const row of (d[key]??[]) as unknown[]){if(!obj(row))unverified('A row of the '+label+' is malformed.');out.push(row as JsonObject);}
 }
 return out;
}
/** The named audiences or identities, and the ad groups or ads that use them. */
export async function readTiktokDeletions(p:CompiledRequest,request:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 const s=(p as Read).tiktokDeletionState;if(!s)return request(p);
 const present:JsonObject={};
 if(s.kind==='saved_audience'){
  const d=ok(await request({...(p as Read),tiktokDeletionState:undefined} as Read),'saved audiences');
  if(d.saved_audiences!==undefined&&!Array.isArray(d.saved_audiences))unverified('TikTok did not list the saved audiences.');
  for(const a of (d.saved_audiences??[]) as unknown[]){if(!obj(a)||!numeric(String(a.saved_audience_id)))unverified('A saved audience row is malformed.');const id=String(a.saved_audience_id);if(s.ids.includes(id))present['a'+id]={present:true,id,name:a.saved_audience_name??null};}
 }else{
  for(const i of await pages(p as Read,'identity_list','identities',maxIdentityPages,request)){const id=String(i.identity_id);if(s.ids.includes(id)&&i.identity_type==='CUSTOMIZED_USER')present['a'+id]={present:true,id,name:i.display_name??null};}
 }
 for(const id of s.ids)if(!Object.hasOwn(present,'a'+id))present['a'+id]={present:false,id};
 const out:JsonObject={kind:s.kind,items:present};
 if(s.usage){
  const users=s.kind==='saved_audience'?await pages(read(p,'tiktok_adgroup_get','/v1.3/adgroup/get/',{page:1,page_size:usagePageSize}),'list','ad groups',maxUsagePages,request)
   :await pages(read(p,'tiktok_ad_get','/v1.3/ad/get/',{page:1,page_size:usagePageSize}),'list','ads',maxUsagePages,request);
  const used:JsonObject={};
  for(const id of s.ids)used['a'+id]=users.filter(u=>s.kind==='saved_audience'?String(u.saved_audience_id??'')===id:String(u.identity_id??'')===id&&u.identity_type==='CUSTOMIZED_USER').map(u=>s.kind==='saved_audience'?String(u.adgroup_id):String(u.ad_id)).sort();
  out.used_by=used;
 }
 return {status:200,headers:{},data:out};
}
export function validateTiktokDeletionState(p:CompiledRequest,r:TransportResult):void{
 const s=(p as Read).tiktokDeletionState,d=r.data;
 if(!s||r.status!==200||!obj(d)||!obj(d.items)||s.usage!==obj(d.used_by))unverified('Missing verified deletion state.');
}
export function tiktokDeletionPrerequisites(p:CompiledRequest,states:unknown[]):void{
 const kind=tiktokDeletionKind(p);if(!kind)return;
 const s=states[0];if(!obj(s)||!obj(s.items)||!obj(s.used_by))unverified('Missing verified deletion state.');
 const label=kind==='identity'?'custom identity':'saved audience';
 const missing=idsOf(p).filter(id=>!obj((s.items as JsonObject)['a'+id])||((s.items as JsonObject)['a'+id] as JsonObject).present!==true);
 if(missing.length)fail('STATE_NOT_FOUND','Not a '+label+' of the selected advertiser: '+missing.join(', ')+'.',{ids:missing});
 const used=Object.fromEntries(idsOf(p).map(id=>[id,((s.used_by as JsonObject)['a'+id]??[]) as string[]]).filter(([,u])=>(u as string[]).length));
 if(Object.keys(used).length)fail(kind==='identity'?'IDENTITY_IN_USE':'AUDIENCE_IN_USE',kind==='identity'?'Ads '+Object.values(used).flat().join(', ')+' use the custom identity; delete or change those ads first.':'Ad groups '+Object.values(used).flat().join(', ')+' use saved audiences '+Object.keys(used).join(', ')+'; TikTok deletes a saved audience only after its ad groups are deleted.',{in_use:used},409);
}
export function tiktokDeletionImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 const kind=tiktokDeletionKind(p);if(!kind)return;
 const first=state[0],s:JsonObject=obj(first)?first:{},items:JsonObject=obj(s.items)?s.items:{};
 return {provider:'tiktok',scope:kind==='identity'?'custom_identity':'saved_audiences',operation:'delete',deleting:idsOf(p).map(id=>items['a'+id]??{id}),may_affect_serving:false,
  effect:kind==='identity'?'Deletes the custom identity; no ad of the advertiser uses it. Editing an identity means creating a new one.':'Deletes the saved audiences; no ad group of the advertiser uses them.',
  verification:'Reads the '+(kind==='identity'?'custom identities':'saved audiences')+' again and expects the deleted ones to be gone.',source:kind==='identity'?'https://business-api.tiktok.com/portal/docs?id=1759155939236865':'https://business-api.tiktok.com/portal/docs?id=1780154666312706'};
}
export function tiktokDeletionOutcome(_p:CompiledRequest,r:TransportResult):boolean{return r.status===200&&obj(r.data)&&r.data.code===0;}
export function tiktokDeletionVerification(p:CompiledRequest):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const ids=idsOf(p);
 return [{read:stateRead(p,{kind:tiktokDeletionKind(p)!,ids,usage:false}),expected:{items:Object.fromEntries(ids.map(id=>['a'+id,{present:false}]))},id:ids.join(',')}];
}
export function tiktokDeletionObserved(_read:CompiledRequest,data:JsonObject):JsonObject{return {items:obj(data.items)?data.items:{}};}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokDeletionFamily:ReviewedFamily={
 name:'tiktok_deletions',
 files:['src/tiktok-deletions.ts',['tests/tiktok-deletions.test.mjs']],
 kind:tiktokDeletionKind,
 assert:assertTiktokDeletion,
 snapshots:tiktokDeletionSnapshots,
 isRead:isTiktokDeletionRead,
 reader:readTiktokDeletions,
 validateState:validateTiktokDeletionState,
 prerequisites:tiktokDeletionPrerequisites,
 impact:tiktokDeletionImpact,
 outcome:tiktokDeletionOutcome,
 verification:tiktokDeletionVerification,
 observed:tiktokDeletionObserved,
 exemptFromSpendTextMatch:true,
};
