import {MirrorError} from './errors.js';
import type {CompiledRequest,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Snapchat offer disclaimers, Marketing API v1 ("Offer Disclaimers", checked 2026-09-27). Ads in regulated verticals
 * (auto, pharma, financial services) show terms or disclaimers; an offer disclaimer of the ad account holds a name (up to
 * 255 characters), a render type (STATIC, with up to 5000 characters of text, or DYNAMIC, whose text comes from the product
 * catalog) and is created in the account and deleted; no update is documented.
 */
type Kind='create'|'delete';
type Read=CompiledRequest&{snapDisclaimerState?:{ids:string[]}};
const maxItems=20,maxListed=1000;
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9-]{1,64}$/.test(v);
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_SNAPCHAT_OFFER_DISCLAIMER',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
export function snapDisclaimerKind(p:CompiledRequest):Kind|undefined{
 if(p.gateway!=='snapchat_native_action'||p.specialTransport||p.origin&&p.origin!=='https://adsapi.snapchat.com')return;
 if(p.method==='POST'&&/^\/v1\/adaccounts\/[A-Za-z0-9-]{1,64}\/offer_disclaimers$/.test(p.path))return 'create';
 if(p.method==='DELETE'&&/^\/v1\/adaccounts\/[A-Za-z0-9-]{1,64}\/offer_disclaimers\/[A-Za-z0-9-]{1,64}$/.test(p.path))return 'delete';
 return;
}
const accountOf=(p:CompiledRequest)=>p.path.split('/')[3]!;
const rows=(p:CompiledRequest)=>((object(p.body)&&Array.isArray(p.body.offer_disclaimers)?p.body.offer_disclaimers:[]) as JsonObject[]);
export function assertSnapDisclaimers(p:CompiledRequest):void{
 const kind=snapDisclaimerKind(p);if(!kind)return;
 if(accountOf(p)!==p.accountId)fail('ACCOUNT_SCOPE_MISMATCH','The path must use the selected ad account.',{},403);
 if(Object.keys(p.query).length||Object.keys(p.headers).length)invalid('Offer disclaimer reviews take no query or header overrides.');
 if(kind==='delete'){if(p.body!==undefined&&!(object(p.body)&&!Object.keys(p.body).length))invalid('Deletion takes no body.');return;}
 const b=p.body;if(!object(b)||Object.keys(b).some(k=>k!=='offer_disclaimers')||!Array.isArray(b.offer_disclaimers)||!b.offer_disclaimers.length||b.offer_disclaimers.length>maxItems)invalid('Send {offer_disclaimers: [...]} with 1–'+maxItems+' disclaimers.');
 const names=new Set<string>();
 b.offer_disclaimers.forEach((d:unknown,i:number)=>{
  const at='offer_disclaimers['+i+']';
  if(!object(d)||Object.keys(d).some(k=>!['name','ad_account_id','disclaimer_text','disclaimer_render_type'].includes(k)))invalid(at+' takes name, ad_account_id, disclaimer_text and disclaimer_render_type.');
  if(d.ad_account_id!==p.accountId)invalid(at+'.ad_account_id is the selected ad account.');
  if(typeof d.name!=='string'||!d.name.trim()||d.name!==d.name.trim()||[...d.name].length>255||/[\u0000-\u001f]/.test(d.name))invalid(at+'.name has 1–255 characters without surrounding spaces or control characters.');
  if(names.has(d.name))invalid('Each disclaimer name appears once per request.');names.add(d.name);
  if(!['STATIC','DYNAMIC'].includes(d.disclaimer_render_type))invalid(at+'.disclaimer_render_type is STATIC or DYNAMIC.');
  if(d.disclaimer_render_type==='STATIC'&&(typeof d.disclaimer_text!=='string'||!d.disclaimer_text.trim()||[...d.disclaimer_text].length>5000||/[\u0000-\u0008\u000b-\u001f]/.test(d.disclaimer_text)))invalid(at+'.disclaimer_text is the disclaimer, up to 5000 characters, for a STATIC disclaimer.');
  if(d.disclaimer_render_type==='DYNAMIC'&&d.disclaimer_text!==undefined&&d.disclaimer_text!==null)invalid(at+': a DYNAMIC disclaimer takes its text from the catalog; send no disclaimer_text.');
 });
}
const read=(p:CompiledRequest,ids:string[]):Read=>({...p,action:'AMCP_SNAPCHAT_DISCLAIMER_READ',method:'GET',path:'/v1/adaccounts/'+accountOf(p)+'/offer_disclaimers',query:{limit:maxListed},body:undefined,headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,snapDisclaimerState:{ids}});
export function snapDisclaimerSnapshots(p:CompiledRequest):Read[]{return [read(p,snapDisclaimerKind(p)==='delete'?[p.path.split('/').at(-1)!]:[])];}
export function isSnapDisclaimerRead(p:CompiledRequest):p is Read{return p.gateway==='snapchat_native_action'&&!!(p as Read).snapDisclaimerState;}
/** Every offer disclaimer of the account, in one bounded page. */
export async function readSnapDisclaimers(p:CompiledRequest,fetch:(p:Read)=>Promise<TransportResult>):Promise<TransportResult>{
 const s=(p as Read).snapDisclaimerState;if(!s)return fetch(p);
 const r=await fetch({...(p as Read),snapDisclaimerState:undefined}),d=r.data;
 if(r.status!==200||!object(d)||String(d.request_status).toUpperCase()!=='SUCCESS'||!Array.isArray(d.offer_disclaimers))unverified('Snapchat did not return the offer disclaimers.');
 if(object(d.paging)&&d.paging.next_link||d.offer_disclaimers.length>=maxListed)unverified('The account has more offer disclaimers than one review reads ('+maxListed+').');
 const disclaimers:JsonObject={};
 for(const row of d.offer_disclaimers as unknown[]){
  const v=object(row)&&object(row.offer_disclaimer)?row.offer_disclaimer:undefined;
  if(!v||!uuid(v.id)||Object.hasOwn(disclaimers,v.id))unverified('An offer disclaimer row is malformed or repeated.');
  if(v!.ad_account_id!==undefined&&v!.ad_account_id!==accountOf(p))fail('STATE_TARGET_MISMATCH','Snapchat listed a disclaimer of another ad account.',{},409);
  disclaimers[v!.id]={name:v!.name??null,disclaimer_render_type:v!.disclaimer_render_type??null,disclaimer_text:v!.disclaimer_text??null};
 }
 return {status:200,headers:{},data:{ad_account_id:accountOf(p),disclaimers}};
}
export function validateSnapDisclaimerState(p:CompiledRequest,r:TransportResult):void{
 const d=r.data;if(!(p as Read).snapDisclaimerState||r.status!==200||!object(d)||d.ad_account_id!==accountOf(p)||!object(d.disclaimers))unverified('Missing verified offer disclaimer state.');
}
export function snapDisclaimerPrerequisites(p:CompiledRequest,states:unknown[]):void{
 const kind=snapDisclaimerKind(p);if(!kind)return;
 const s=states[0];if(!object(s)||!object(s.disclaimers))unverified('Missing verified offer disclaimer state.');
 if(kind==='delete'){const id=p.path.split('/').at(-1)!;if(!object(s.disclaimers[id]))fail('STATE_NOT_FOUND','Offer disclaimer '+id+' is not a disclaimer of this ad account.',{offer_disclaimer:id});return;}
 const taken=new Set(Object.values(s.disclaimers).map(v=>object(v)?String(v.name):''));
 for(const d of rows(p))if(taken.has(String(d.name)))fail('CONFIGURATION_EXISTS','The ad account already has an offer disclaimer named "'+String(d.name)+'".',{name:String(d.name)});
}
export function snapDisclaimerRemoves(p:CompiledRequest):boolean{return snapDisclaimerKind(p)==='delete';}
export function snapDisclaimerImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 const kind=snapDisclaimerKind(p);if(!kind)return;
 const first=state[0],s:JsonObject=object(first)&&object(first.disclaimers)?first.disclaimers:{};
 return {provider:'snapchat',scope:'offer_disclaimer',operation:kind,...(kind==='create'?{creating:rows(p)}:{deleting:{id:p.path.split('/').at(-1),...(object(s[p.path.split('/').at(-1)!])?s[p.path.split('/').at(-1)!] as JsonObject:{})}}),
  disclaimers_in_account:Object.keys(s).length,may_affect_serving:kind==='delete',
  effect:kind==='create'?'Creates disclaimers in the ad account; creatives show one only once they reference it.':'Deletes the disclaimer; creatives that reference it lose the required disclosure, which regulated ads may need to keep serving.',
  verification:kind==='create'?'Lists the disclaimers again and compares each one created.':'Lists the disclaimers again and expects this one to be gone.',
  source:'https://developers.snap.com/api/marketing-api/Ads-API/offer-disclaimers'};
}
export function snapDisclaimerOutcome(p:CompiledRequest,r:TransportResult):boolean{
 const kind=snapDisclaimerKind(p)!,d=r.data;
 if(r.status!==200||!object(d)||String(d.request_status).toUpperCase()!=='SUCCESS')return false;
 if(kind==='delete')return true;
 const out=d.offer_disclaimers;
 return Array.isArray(out)&&out.length===rows(p).length&&out.every((x:unknown)=>object(x)&&String(x.sub_request_status).toUpperCase()==='SUCCESS'&&object(x.offer_disclaimer)&&uuid(x.offer_disclaimer.id));
}
export function snapDisclaimerVerification(p:CompiledRequest,result:JsonObject):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const kind=snapDisclaimerKind(p)!,expected:JsonObject={};
 if(kind==='delete')expected[p.path.split('/').at(-1)!]={present:false};
 else rows(p).forEach((d,i)=>{
  const id=result.data?.offer_disclaimers?.[i]?.offer_disclaimer?.id;
  if(!uuid(id))fail('VERIFICATION_UNSUPPORTED','The receipt names no offer disclaimer to verify.');
  expected[id]={present:true,name:d.name,disclaimer_render_type:d.disclaimer_render_type,disclaimer_text:d.disclaimer_render_type==='STATIC'?d.disclaimer_text:null};
 });
 return [{read:read(p,Object.keys(expected)),expected:{disclaimers:expected},id:Object.keys(expected).join(',')}];
}
export function snapDisclaimerObserved(read:CompiledRequest,data:JsonObject):JsonObject{
 const found=object(data.disclaimers)?data.disclaimers:{},ids=(read as Read).snapDisclaimerState?.ids??[];
 return {disclaimers:Object.fromEntries(ids.map(id=>[id,object(found[id])?{present:true,...found[id]}:{present:false}]))};
}
