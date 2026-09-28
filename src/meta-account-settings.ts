import {MirrorError} from './errors.js';
import type {CompiledRequest,Connection,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Meta ad account settings, Marketing API v25.0 "Ad Account" reference (Updating and Reading, checked 2026-09-27).
 * POST /act_{ad_account_id} updates the account; this contract writes its name, the default Digital Services Act payor and
 * beneficiary used for ads that reach the EU ("can be set to both of them or none of them ... To unset the values: pass
 * two empty strings at the same time") and is_notifications_enabled. Spend caps (read in the account's minor units but
 * written in standard units), end advertiser, media agency and partner (which "cannot be modified any more" once set),
 * agency declarations and business information stay outside. The account read is the state before and after.
 */
type State={fields:string[]};
type Read=CompiledRequest&{metaAccountState?:State};
const gateway='meta_native_action',action='meta_ad_account_id_create',nameMax=100,dsaMax=512;
const writable=['name','default_dsa_payor','default_dsa_beneficiary','is_notifications_enabled'];
const reasons:Record<string,string>={spend_cap:'spending caps',spend_cap_action:'spending caps',end_advertiser:'end advertiser (permanent once set)',media_agency:'media agency (permanent once set)',partner:'partner (permanent once set)',agency_client_declaration:'agency declarations',business_info:'business information',custom_audience_info:'shopping audience settings',attribution_spec:'deprecated attribution settings'};
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const account=(v:unknown)=>String(v??'').replace(/^act_/,'');
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_META_ACCOUNT_SETTING',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
export function metaAccountSettingsKind(p:CompiledRequest):boolean{
 return p.gateway===gateway&&p.method==='POST'&&!p.specialTransport&&(!p.origin||p.origin==='https://graph.facebook.com')&&p.action===action&&/^\/v25\.0\/act_[0-9]{1,32}$/.test(p.path);
}
const body=(p:CompiledRequest):JsonObject=>object(p.body)?p.body:{};
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&!!v.trim()&&v===v.trim()&&[...v].length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
export function assertMetaAccountSettings(p:CompiledRequest):void{
 if(!metaAccountSettingsKind(p))return;
 if(p.path.split('/')[2]!=='act_'+account(p.accountId))fail('ACCOUNT_SCOPE_MISMATCH','Update the selected ad account.',{},403);
 if(Object.keys(p.query).length||Object.keys(p.headers).length)invalid('Account updates take no query or header overrides.');
 const b=p.body;if(!object(b)||!Object.keys(b).length)invalid('Send name, default_dsa_payor with default_dsa_beneficiary, or is_notifications_enabled.');
 const outside=Object.keys(b).filter(k=>!writable.includes(k));
 if(outside.length)invalid('Not changed here: '+outside.map(k=>k+(reasons[k]?' ('+reasons[k]+')':'')).join(', ')+'.');
 if(b.name!==undefined&&!text(b.name,nameMax))invalid('name has 1–'+nameMax+' characters without surrounding spaces.');
 if(b.is_notifications_enabled!==undefined&&typeof b.is_notifications_enabled!=='boolean')invalid('is_notifications_enabled is true or false.');
 if((b.default_dsa_payor===undefined)!==(b.default_dsa_beneficiary===undefined))invalid('Send default_dsa_payor and default_dsa_beneficiary together; Meta keeps both or neither.');
 if(b.default_dsa_payor!==undefined){
  const unset=b.default_dsa_payor===''&&b.default_dsa_beneficiary==='';
  if(!unset&&(!text(b.default_dsa_payor,dsaMax)||!text(b.default_dsa_beneficiary,dsaMax)))invalid('default_dsa_payor and default_dsa_beneficiary name who pays and who benefits (1–'+dsaMax+' characters each), or are both "" to unset them.');
 }
}
export function assertMetaAccountScope(c:Connection,write=false):void{
 if(write?!c.scopes.includes('ads_management'):!c.scopes.some(s=>s==='ads_management'||s==='ads_read'))fail('INSUFFICIENT_SCOPE','Reconnect Meta with ads_management to change account settings.',{},403);
}
const accountRead=(p:CompiledRequest,s:State):Read=>({...p,action:'AMCP_META_ACCOUNT_READ',method:'GET',path:'/v25.0/act_'+account(p.accountId),query:{fields:'id,name,default_dsa_payor,default_dsa_beneficiary,is_notifications_enabled,account_status'},body:undefined,headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,metaAccountState:s});
export function metaAccountSettingsSnapshots(p:CompiledRequest):Read[]{return [accountRead(p,{fields:Object.keys(body(p)).sort()})];}
export function isMetaAccountSettingsRead(p:CompiledRequest):p is Read{return p.gateway===gateway&&!!(p as Read).metaAccountState;}
export async function readMetaAccountSettings(p:CompiledRequest,fetch:(p:Read)=>Promise<TransportResult>):Promise<TransportResult>{
 const s=(p as Read).metaAccountState;if(!s)return fetch(p as Read);
 const r=await fetch({...(p as Read),metaAccountState:undefined}),d=r.data;
 if(r.status!==200||!object(d)||d.error||account(d.id)!==account(p.accountId))unverified('Meta did not return the selected ad account.');
 return {status:200,headers:{},data:{id:'act_'+account(p.accountId),name:typeof d.name==='string'?d.name:null,default_dsa_payor:typeof d.default_dsa_payor==='string'?d.default_dsa_payor:'',default_dsa_beneficiary:typeof d.default_dsa_beneficiary==='string'?d.default_dsa_beneficiary:'',is_notifications_enabled:typeof d.is_notifications_enabled==='boolean'?d.is_notifications_enabled:null,account_status:d.account_status??null}};
}
export function validateMetaAccountSettingsState(p:CompiledRequest,r:TransportResult):void{
 const d=r.data;if(!(p as Read).metaAccountState||r.status!==200||!object(d)||typeof d.id!=='string')unverified('Missing verified account state.');
}
export function metaAccountSettingsPrerequisites(p:CompiledRequest,states:unknown[]):void{
 if(!metaAccountSettingsKind(p))return;
 const s=states[0];if(!object(s))unverified('Missing verified account state.');
 const b=body(p),same=Object.keys(b).filter(k=>s[k]===b[k]);
 if(same.length===Object.keys(b).length)invalid('The ad account already has these values.');
}
export function metaAccountSettingsImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 if(!metaAccountSettingsKind(p))return;
 const first=state[0],s:JsonObject=object(first)?first:{},b=body(p);
 const before=Object.fromEntries(Object.keys(b).map(k=>[k,s[k]??null]));
 return {provider:'meta',scope:'ad_account',operation:'update',before,after:b,may_affect_serving:false,
  effect:(b.default_dsa_payor!==undefined?(b.default_dsa_payor===''?'Removes the default payor and beneficiary; ad sets that reach the EU then need their own. ':'Sets the default payor and beneficiary shown on ads that reach the EU. '):'')+(b.name!==undefined?'Renames the ad account. ':'')+(b.is_notifications_enabled!==undefined?'Turns account notifications '+(b.is_notifications_enabled?'on':'off')+' for this login. ':'')+'Budgets, spending caps and delivery are unchanged.',
  verification:'Reads the ad account again and compares the fields written.',source:'https://developers.facebook.com/docs/marketing-api/reference/ad-account/'};
}
export function metaAccountSettingsOutcome(_p:CompiledRequest,r:TransportResult):boolean{return r.status===200&&object(r.data)&&!r.data.error&&r.data.success===true;}
export function metaAccountSettingsVerification(p:CompiledRequest):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 return [{read:accountRead(p,{fields:Object.keys(body(p)).sort()}),expected:{...body(p)},id:'act_'+account(p.accountId)}];
}
export function metaAccountSettingsObserved(_read:CompiledRequest,data:JsonObject):JsonObject{return data;}
