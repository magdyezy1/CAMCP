import {MirrorError} from './errors.js';
import type {CompiledRequest,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {assertDV360WriteScope} from './dv360-scope.js';

/**
 * Settings of the selected DV360 advertiser, Display & Video 360 API v4 (pinned Discovery document: advertisers.patch,
 * Advertiser, AdvertiserGeneralConfig, AdvertiserTargetingConfig, IntegrationDetails and AdAsset; checked 2026-09-27).
 * - entityStatus "controls whether or not insertion orders and line items of the advertiser can spend their budgets and
 *   bid on inventory"; SCHEDULED_FOR_DELETION deletes the advertiser after 30 days and is not written here.
 * - domainUrl is the primary website, "with no path or query string"; defaultLogoAssetId is an uploaded ad asset and
 *   defaultBusinessName the name YouTube and Demand Gen ads use when an ad names none.
 * - containsEuPoliticalAds set to DOES_NOT_CONTAIN also declares new line items, and existing undeclared ones within a day.
 * - Billing, ad server, currency, partner, data access and the consent flags (Prisma, video data sharing, About this Ad)
 *   are outside this contract.
 */
type Read=CompiledRequest&{dv360AdvertiserState?:{logo?:string}};
const fields=['displayName','entityStatus','generalConfig.domainUrl','defaultBusinessName','defaultLogoAssetId','integrationDetails.integrationCode','servingConfig.exemptTvFromViewabilityTargeting','containsEuPoliticalAds'];
const statuses=['ENTITY_STATUS_ACTIVE','ENTITY_STATUS_PAUSED'],declarations=['CONTAINS_EU_POLITICAL_ADVERTISING','DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING'];
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_DV360_ADVERTISER_SETTING',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
export function dv360AdvertiserKind(p:CompiledRequest):boolean{
 return p.gateway==='dv360_native_action'&&p.method==='PATCH'&&!p.specialTransport&&(p.origin===undefined||p.origin==='https://displayvideo.googleapis.com')&&/^\/v4\/advertisers\/[1-9]\d{0,18}$/.test(p.path);
}
const advertiserOf=(p:CompiledRequest)=>p.path.split('/')[3]!;
const mask=(p:CompiledRequest):string[]=>String(p.query.updateMask??'').split(',').map(s=>s.trim()).filter(Boolean);
function value(b:JsonObject,f:string):unknown{const [a,c]=f.split('.') as [string,string|undefined];return c?(object(b[a])?b[a][c]:undefined):b[a];}
/** Every field the request writes, dotted. */
function writes(p:CompiledRequest):Record<string,unknown>{const b=object(p.body)?p.body:{};return Object.fromEntries(mask(p).map(f=>[f,value(b,f)]));}
export function assertDV360Advertiser(p:CompiledRequest):void{
 if(!dv360AdvertiserKind(p))return;
 if(advertiserOf(p)!==p.accountId)fail('ACCOUNT_SCOPE_MISMATCH','The request must use the selected advertiser.',{},403);
 if(Object.keys(p.headers).length||Object.keys(p.query).some(k=>k!=='updateMask'))invalid('Advertiser updates take updateMask and no other query or header overrides.');
 const m=mask(p);
 if(!m.length||new Set(m).size!==m.length||m.some(f=>!fields.includes(f)))invalid('updateMask lists fields among '+fields.join(', ')+'; billing, ad server, currency, partner, data access and consent settings are outside this contract.');
 const b=p.body;if(!object(b))invalid('Provide the native Advertiser object.');
 const tops=new Set(m.map(f=>f.split('.')[0]!));
 for(const [k,v] of Object.entries(b)){
  if(!tops.has(k))invalid('The body carries exactly the fields in updateMask; not masked: '+k+'.');
  if(object(v)){const extra=Object.keys(v).filter(c=>!m.includes(k+'.'+c));if(extra.length)invalid('The body carries exactly the fields in updateMask; not masked: '+extra.map(c=>k+'.'+c).join(', ')+'.');}
 }
 for(const [f,v] of Object.entries(writes(p))){
  if(v===undefined)invalid(f+' is named in updateMask but not sent.');
  if(f==='displayName'&&(typeof v!=='string'||!v.trim()||v!==v.trim()||Buffer.byteLength(v,'utf8')>240||/[\u0000-\u001f]/.test(v)))invalid('displayName is 1–240 UTF-8 bytes without surrounding spaces or control characters.');
  if(f==='entityStatus'&&!statuses.includes(String(v)))invalid('entityStatus is ENTITY_STATUS_ACTIVE or ENTITY_STATUS_PAUSED; scheduling the advertiser for deletion is outside this contract.');
  if(f==='generalConfig.domainUrl'&&(typeof v!=='string'||!/^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?\/?$/.test(v)))invalid('generalConfig.domainUrl is http:// or https:// and a domain, with no path or query string.');
  if(f==='defaultBusinessName'&&(typeof v!=='string'||v!==v.trim()||[...v].length>255||/[\u0000-\u001f]/.test(v)))invalid('defaultBusinessName is text of up to 255 characters without surrounding spaces or control characters; "" clears it.');
  if(f==='defaultLogoAssetId'&&(typeof v!=='string'||!/^[1-9]\d{0,18}$/.test(v)))invalid('defaultLogoAssetId is the numeric ID of an image ad asset of the advertiser, as a string.');
  if(f==='integrationDetails.integrationCode'&&(typeof v!=='string'||[...v].length>500||/[\u0000-\u001f]/.test(v)))invalid('integrationDetails.integrationCode is text of up to 500 characters.');
  if(f==='servingConfig.exemptTvFromViewabilityTargeting'&&typeof v!=='boolean')invalid('servingConfig.exemptTvFromViewabilityTargeting is a boolean.');
  if(f==='containsEuPoliticalAds'&&!declarations.includes(String(v)))invalid('containsEuPoliticalAds is CONTAINS_EU_POLITICAL_ADVERTISING or DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING.');
 }
}
const read=(p:CompiledRequest,path:string):Read=>({...p,action:'AMCP_DV360_ADVERTISER_READ',method:'GET',path,query:{},body:undefined,headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,queryArrayEncoding:undefined,dv360AdvertiserState:undefined});
export function dv360AdvertiserSnapshots(p:CompiledRequest):Read[]{
 const logo=writes(p).defaultLogoAssetId;
 return [{...read(p,'/v4/advertisers/'+advertiserOf(p)),dv360AdvertiserState:typeof logo==='string'?{logo}:{}}];
}
export function isDV360AdvertiserRead(p:CompiledRequest):p is Read{return p.gateway==='dv360_native_action'&&!!(p as Read).dv360AdvertiserState;}
function body(r:TransportResult,what:string):JsonObject{if(r.status!==200||!object(r.data)||r.data.error)unverified('DV360 did not return the '+what+'.');return r.data;}
/** The advertiser's settings, dotted, and the logo asset when one is named. */
export async function readDV360Advertiser(p:CompiledRequest,fetch:(p:Read)=>Promise<TransportResult>):Promise<TransportResult>{
 const s=(p as Read).dv360AdvertiserState;if(!s)return fetch(p);
 const advertiser=advertiserOf(p),a=body(await fetch({...(p as Read),dv360AdvertiserState:undefined}),'advertiser');
 if(String(a.advertiserId)!==advertiser||a.name!=='advertisers/'+advertiser)fail('STATE_TARGET_MISMATCH','DV360 returned a different advertiser.',{},409);
 const settings:JsonObject=Object.fromEntries(fields.map(f=>[f,value(a,f)??null]));
 settings['servingConfig.exemptTvFromViewabilityTargeting']=object(a.servingConfig)?a.servingConfig.exemptTvFromViewabilityTargeting===true:false;
 settings['integrationDetails.integrationCode']=object(a.integrationDetails)?a.integrationDetails.integrationCode??'':'';
 settings.defaultBusinessName=a.defaultBusinessName??'';
 let logo:JsonObject|null=null;
 if(s.logo){
  let r:TransportResult|undefined;
  try{r=await fetch(read(p,'/v4/advertisers/'+advertiser+'/adAssets/'+s.logo));}catch(e){if(!(e instanceof MirrorError&&(e.status===404||e.code==='NOT_FOUND')))throw e;}
  if(r){const x=body(r,'logo asset');if(String(x.adAssetId)===s.logo)logo={adAssetId:s.logo,adAssetType:x.adAssetType??null,entityStatus:x.entityStatus??null};}
 }
 return {status:200,headers:{},data:{advertiserId:advertiser,partnerId:String(a.partnerId??''),currency:object(a.generalConfig)?a.generalConfig.currencyCode??null:null,settings,logo}};
}
export function validateDV360AdvertiserState(p:CompiledRequest,r:TransportResult):void{
 const d=r.data;if(!(p as Read).dv360AdvertiserState||r.status!==200||!object(d)||d.advertiserId!==advertiserOf(p)||!object(d.settings))unverified('Missing verified DV360 advertiser state.');
}
export function dv360AdvertiserPrerequisites(p:CompiledRequest,states:unknown[]):void{
 if(!dv360AdvertiserKind(p))return;
 const s=states[0];if(!object(s)||!object(s.settings))unverified('Missing verified DV360 advertiser state.');
 const w=writes(p);
 if(Object.entries(w).every(([f,v])=>s.settings[f]===v))invalid('Advertiser '+advertiserOf(p)+' already has these settings.');
 if(s.settings.entityStatus==='ENTITY_STATUS_SCHEDULED_FOR_DELETION'||s.settings.entityStatus==='ENTITY_STATUS_ARCHIVED')invalid('Advertiser '+advertiserOf(p)+' is '+String(s.settings.entityStatus)+'.');
 if(typeof w.defaultLogoAssetId==='string'){
  const logo=s.logo;
  if(!object(logo))fail('STATE_NOT_FOUND','Ad asset '+w.defaultLogoAssetId+' is not an ad asset of advertiser '+advertiserOf(p)+'; upload it with advertisers.adAssets.upload first.',{ad_asset:w.defaultLogoAssetId});
  if(logo.adAssetType!=='AD_ASSET_TYPE_IMAGE'||logo.entityStatus!=='ENTITY_STATUS_ACTIVE')invalid('Ad asset '+w.defaultLogoAssetId+' is '+String(logo.adAssetType)+' and '+String(logo.entityStatus)+'; the default logo is an active image asset.');
 }
}
/** Activating the advertiser lets its insertion orders and line items spend again. */
export function dv360AdvertiserActivates(p:CompiledRequest):boolean{return dv360AdvertiserKind(p)&&writes(p).entityStatus==='ENTITY_STATUS_ACTIVE';}
export function dv360AdvertiserImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 if(!dv360AdvertiserKind(p))return;
 const first=state[0],s:JsonObject=object(first)&&object(first.settings)?first.settings:{},w=writes(p);
 const changes=Object.fromEntries(Object.entries(w).map(([f,v])=>[f,{from:s[f]??null,to:v}]));
 return {provider:'dv360',scope:'advertiser_settings',advertiser:advertiserOf(p),changes,may_affect_serving:'entityStatus' in w||'servingConfig.exemptTvFromViewabilityTargeting' in w||'containsEuPoliticalAds' in w,
  effect:['entityStatus' in w?(w.entityStatus==='ENTITY_STATUS_ACTIVE'?'Every insertion order and line item of the advertiser may spend and bid again.':'Every insertion order and line item of the advertiser stops spending and bidding.'):'','containsEuPoliticalAds' in w?'The declaration also applies to new line items, and DV360 sets it on undeclared existing line items within a day.':'','servingConfig.exemptTvFromViewabilityTargeting' in w?'Connected TV devices are '+(w['servingConfig.exemptTvFromViewabilityTargeting']?'':'no longer ')+'exempt from viewability targeting for all video line items.':''].filter(Boolean).join(' ')||'Changes the advertiser settings shown to publishers and in ads.',
  verification:'Reads the advertiser again and compares every field written.',
  source:'https://developers.google.com/display-video/api/reference/rest/v4/advertisers/patch'};
}
export function dv360AdvertiserOutcome(p:CompiledRequest,r:TransportResult):boolean{
 const d=r.data;return r.status===200&&object(d)&&!d.error&&String(d.advertiserId)===advertiserOf(p)&&d.name==='advertisers/'+advertiserOf(p);
}
export function dv360AdvertiserVerification(p:CompiledRequest):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const probe:Read={...read(p,'/v4/advertisers/'+advertiserOf(p)),dv360AdvertiserState:{}};
 return [{read:probe,expected:{settings:writes(p)},id:'advertisers/'+advertiserOf(p)}];
}
export function dv360AdvertiserObserved(_read:CompiledRequest,data:JsonObject):JsonObject{return {settings:object(data.settings)?data.settings:null};}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const dv360AdvertiserFamily:ReviewedFamily={
 name:'dv360_advertiser_settings',
 files:['src/dv360-advertiser-settings.ts',['tests/dv360-advertiser-settings.test.mjs']],
 kind:dv360AdvertiserKind,
 assert:assertDV360Advertiser,
 scope:assertDV360WriteScope,
 snapshots:dv360AdvertiserSnapshots,
 isRead:isDV360AdvertiserRead,
 reader:readDV360Advertiser,
 validateState:validateDV360AdvertiserState,
 prerequisites:dv360AdvertiserPrerequisites,
 impact:dv360AdvertiserImpact,
 outcome:dv360AdvertiserOutcome,
 verification:dv360AdvertiserVerification,
 observed:dv360AdvertiserObserved,
 spendConfirmation:{needed:dv360AdvertiserActivates,message:'An active advertiser lets every insertion order and line item under it spend and bid again. Review it and provide spend_change_confirmed=true.'},
 exemptFromSpendTextMatch:true,
 activates:dv360AdvertiserActivates,
};
