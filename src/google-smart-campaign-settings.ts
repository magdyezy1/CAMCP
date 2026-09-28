import {MirrorError} from './errors.js';
import {googleJson,assertGoogleAdsScope} from './google-contracts.js';
import type {CompiledRequest,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';

/**
 * Smart campaign settings, Google Ads API v23 (pinned Discovery document: SmartCampaignSettingService.
 * MutateSmartCampaignSettings, SmartCampaignSettingOperation and SmartCampaignSetting; checked 2026-09-27). Each Smart
 * campaign has one setting, customers/{customer}/smartCampaignSettings/{campaign}, holding what its ads show: the phone
 * number, the landing page (a final URL, or a Business Profile optimized for ads), the advertising language, and the
 * business (a name, or a Business Profile location). The landing page and the business are each one choice of two.
 */
type Read=CompiledRequest&{googleSmartState?:{settings:string[]}};
const top=['phoneNumber','advertisingLanguageCode','finalUrl','adOptimizedBusinessProfileSetting','businessName','businessProfileLocation'];
const leaves:Record<string,string[]>={phoneNumber:['phoneNumber','countryCode'],adOptimizedBusinessProfileSetting:['includeLeadForm']};
const maxOperations=10;
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_GOOGLE_SMART_CAMPAIGN_SETTING',message);}
function unverified(message:string):never{return fail('SMART_CAMPAIGN_STATE_UNVERIFIED',message,{},502);}
const account=(p:CompiledRequest)=>{const id=p.accountId?.replaceAll('-','');if(!id||!/^\d+$/.test(id))invalid('Select one Google Ads customer.');return id!;};
export function googleSmartKind(p:CompiledRequest):boolean{
 return p.gateway==='google_ads_native_action'&&p.method==='POST'&&!p.specialTransport&&(!p.origin||p.origin==='https://googleads.googleapis.com')&&/^\/v23\/customers\/\d+\/smartCampaignSettings:mutate$/.test(p.path);
}
const operations=(p:CompiledRequest)=>(googleJson(p.body).operations??[]) as JsonObject[];
/** The dotted fields an update mask names: whole top-level fields expand to their leaves. */
function masked(v:unknown,at:string):string[]{
 const mask=typeof v==='string'?v.split(',').map(s=>s.trim()).filter(Boolean):[];
 const known=top.flatMap(f=>leaves[f]?[f,...leaves[f]!.map(l=>f+'.'+l)]:[f]);
 if(!mask.length||new Set(mask).size!==mask.length||mask.some(f=>!known.includes(f)))invalid(at+'.updateMask lists fields among '+top.join(', ')+' (or phoneNumber.phoneNumber, phoneNumber.countryCode, adOptimizedBusinessProfileSetting.includeLeadForm).');
 return mask.flatMap(f=>leaves[f]?leaves[f]!.map(l=>f+'.'+l):[f]);
}
function value(u:JsonObject,f:string):unknown{const [a,b]=f.split('.') as [string,string|undefined];return b?(object(u[a])?u[a][b]:undefined):u[a];}
export function assertGoogleSmart(p:CompiledRequest):void{
 if(!googleSmartKind(p))return;
 const id=account(p);
 if(p.path.split('/')[3]!==id)fail('ACCOUNT_SCOPE_MISMATCH','The path must use the selected customer.',{},403);
 if(Object.keys(p.query).length||Object.keys(p.headers).length)invalid('Smart campaign setting reviews take no query or header overrides.');
 const b=googleJson(p.body);
 if(!object(b)||Object.keys(b).some(k=>!['operations','partialFailure','validateOnly','responseContentType'].includes(k)))invalid('Send {operations} only.');
 if(b.partialFailure!==undefined&&b.partialFailure!==false)invalid('partialFailure must be false: every operation is applied, or none.');
 if(b.validateOnly!==undefined&&b.validateOnly!==false)invalid('validateOnly must be false; inspect the review instead.');
 if(!Array.isArray(b.operations)||!b.operations.length||b.operations.length>maxOperations)invalid('Send 1–'+maxOperations+' operations.');
 const seen=new Set<string>();
 (b.operations as unknown[]).forEach((op,i)=>{
  const at='operations['+i+']';
  if(!object(op)||Object.keys(op).some(k=>!['update','updateMask'].includes(k))||!object(op.update))invalid(at+' is {update, updateMask}: each Smart campaign has one setting, which is only updated.');
  const u=op.update,fields=masked(op.updateMask,at);
  if(typeof u.resourceName!=='string'||!new RegExp('^customers/'+id+'/smartCampaignSettings/[1-9][0-9]*$').test(u.resourceName))invalid(at+'.update.resourceName is customers/'+id+'/smartCampaignSettings/{campaign}.');
  if(seen.has(u.resourceName))invalid('Each setting appears once.');seen.add(u.resourceName);
  const tops=new Set(fields.map(f=>f.split('.')[0]!)),extra=Object.keys(u).filter(k=>k!=='resourceName'&&!tops.has(k));
  if(extra.length)invalid(at+'.update carries exactly the fields in updateMask; not masked: '+extra.join(', ')+'.');
  if(tops.has('finalUrl')&&tops.has('adOptimizedBusinessProfileSetting'))invalid(at+': the landing page is a final URL or a Business Profile optimized for ads, not both.');
  if(tops.has('businessName')&&tops.has('businessProfileLocation'))invalid(at+': the business is a name or a Business Profile location, not both.');
  for(const f of fields){
   const v=value(u,f);if(v===undefined)invalid(at+': '+f+' is named in updateMask but not sent.');
   if(f==='finalUrl'&&(typeof v!=='string'||!/^https?:\/\/[^\s]+$/.test(v)||[...v].length>2048))invalid(at+'.update.finalUrl is an http(s) URL of up to 2048 characters.');
   if(f==='phoneNumber.phoneNumber'&&(typeof v!=='string'||!/^\+?[0-9(][0-9 ()-]{3,28}[0-9]$/.test(v)))invalid(at+'.update.phoneNumber.phoneNumber is a phone number of digits, spaces, dashes and parentheses.');
   if(f==='phoneNumber.countryCode'&&(typeof v!=='string'||!/^[A-Z]{2}$/.test(v)))invalid(at+'.update.phoneNumber.countryCode is a two-letter country code, such as US.');
   if(f==='advertisingLanguageCode'&&(typeof v!=='string'||!/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(v)))invalid(at+'.update.advertisingLanguageCode is a language code, such as en or zh-TW.');
   if(f==='adOptimizedBusinessProfileSetting.includeLeadForm'&&typeof v!=='boolean')invalid(at+'.update.adOptimizedBusinessProfileSetting.includeLeadForm is a boolean.');
   if(f==='businessName'&&(typeof v!=='string'||!v.trim()||v!==v.trim()||[...v].length>255||/[\u0000-\u001f]/.test(v)))invalid(at+'.update.businessName has 1–255 characters without surrounding spaces or control characters.');
   if(f==='businessProfileLocation'&&(typeof v!=='string'||!/^locations\/[0-9]+$/.test(v)))invalid(at+'.update.businessProfileLocation is locations/{location}.');
  }
 });
}
const quote=(v:string[])=>v.map(n=>"'"+n+"'").join(', ');
function read(p:CompiledRequest,names:string[]):Read{return {...p,action:'AMCP_GOOGLE_SMART_READ',method:'POST',path:'/v23/customers/'+account(p)+'/googleAds:search',body:{query:'SELECT smart_campaign_setting.resource_name, smart_campaign_setting.campaign, smart_campaign_setting.phone_number.phone_number, smart_campaign_setting.phone_number.country_code, smart_campaign_setting.final_url, smart_campaign_setting.advertising_language_code, smart_campaign_setting.business_name, smart_campaign_setting.business_profile_location, smart_campaign_setting.ad_optimized_business_profile_setting.include_lead_form, campaign.status, campaign.advertising_channel_type FROM smart_campaign_setting WHERE smart_campaign_setting.resource_name IN ('+quote(names)+')'},query:{},headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,googleSmartState:undefined};}
const settingsOf=(p:CompiledRequest)=>operations(p).map(op=>String(op.update.resourceName)).sort();
export function googleSmartSnapshots(p:CompiledRequest):Read[]{const names=settingsOf(p);return [{...read(p,names),googleSmartState:{settings:names}}];}
export function isGoogleSmartRead(p:CompiledRequest):p is Read{return !!(p as Read).googleSmartState;}
/** Each setting named, in dotted form, with its campaign's status and channel. */
export async function readGoogleSmart(p:CompiledRequest,send:(p:Read)=>Promise<TransportResult>):Promise<TransportResult>{
 const s=(p as Read).googleSmartState;if(!s)return send(p);
 const r=await send({...(p as Read),googleSmartState:undefined}),d=r.data;
 if(r.status!==200||!object(d)||d.results!==undefined&&!Array.isArray(d.results)||d.nextPageToken)unverified('Google returned a failed, paged or unrecognized search response.');
 const settings:JsonObject={};
 for(const row of (d.results??[]) as unknown[]){
  const v=object(row)&&object(row.smartCampaignSetting)?row.smartCampaignSetting:undefined,c=object(row)&&object(row.campaign)?row.campaign:{};
  if(!v||!s.settings.includes(String(v.resourceName))||Object.hasOwn(settings,String(v.resourceName)))unverified('A Smart campaign setting row is foreign, malformed or repeated.');
  const phone=object(v!.phoneNumber)?v!.phoneNumber:{},profile=object(v!.adOptimizedBusinessProfileSetting)?v!.adOptimizedBusinessProfileSetting:null;
  settings[String(v!.resourceName)]={campaignStatus:c.status??null,channel:c.advertisingChannelType??null,'phoneNumber.phoneNumber':phone.phoneNumber??null,'phoneNumber.countryCode':phone.countryCode??null,
   finalUrl:v!.finalUrl??null,advertisingLanguageCode:v!.advertisingLanguageCode??null,businessName:v!.businessName??null,businessProfileLocation:v!.businessProfileLocation??null,
   'adOptimizedBusinessProfileSetting.includeLeadForm':profile?profile.includeLeadForm===true:null};
 }
 return {status:200,headers:{},data:{customer:{id:account(p)},settings}};
}
export function validateGoogleSmartState(p:CompiledRequest,r:TransportResult):void{
 const d=r.data;if(!(p as Read).googleSmartState||r.status!==200||!object(d)||!object(d.customer)||d.customer.id!==account(p)||!object(d.settings))unverified('Complete Smart campaign setting state is missing.');
}
/** Every field each operation writes, dotted. */
function writes(p:CompiledRequest):Record<string,Record<string,unknown>>{
 return Object.fromEntries(operations(p).map((op,i)=>[String(op.update.resourceName),Object.fromEntries(masked(op.updateMask,'operations['+i+']').map(f=>[f,value(op.update,f)]))]));
}
export function googleSmartPrerequisites(p:CompiledRequest,states:unknown[]):void{
 if(!googleSmartKind(p))return;
 const s=states[0];if(!object(s)||!object(s.settings))unverified('Complete Smart campaign setting state is missing.');
 for(const [name,w] of Object.entries(writes(p))){
  const current=s.settings[name];
  if(!object(current))fail('STATE_TARGET_MISMATCH','Setting '+name+' is not a Smart campaign setting of the selected customer.',{setting:name},409);
  if(current.channel!=='SMART')invalid('Campaign '+name.split('/').at(-1)+' is '+String(current.channel)+'; only Smart campaigns have these settings.');
  if(current.campaignStatus==='REMOVED')invalid('Campaign '+name.split('/').at(-1)+' is removed.');
  if(Object.entries(w).every(([f,v])=>current[f]===v))invalid('Setting '+name+' already has these values.');
 }
}
export function googleSmartImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 if(!googleSmartKind(p))return;
 const first=state[0],s:JsonObject=object(first)&&object(first.settings)?first.settings:{};
 const changes=Object.entries(writes(p)).map(([name,w])=>({setting:name,fields:Object.fromEntries(Object.entries(w).map(([f,v])=>[f,{from:object(s[name])?s[name][f]??null:null,to:v}]))}));
 return {provider:'google',scope:'smart_campaign_setting',changes,may_affect_serving:true,
  effect:'Changes what the Smart campaign ads show and where they lead: phone number, landing page, language or business.',
  verification:'Reads the settings again and compares every field written.',
  source:'https://developers.google.com/google-ads/api/docs/smart-campaigns/overview'};
}
export function googleSmartOutcome(p:CompiledRequest,r:TransportResult):boolean{
 const d=r.data,names=operations(p).map(op=>String(op.update.resourceName));
 if(r.status!==200||!object(d)||d.partialFailureError!==undefined&&d.partialFailureError!==null||!Array.isArray(d.results)||d.results.length!==names.length)return false;
 return names.every((n,i)=>object(d.results[i])&&d.results[i].resourceName===n);
}
export function googleSmartVerification(p:CompiledRequest):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const names=settingsOf(p),probe:Read={...read(p,names),googleSmartState:{settings:names}};
 return [{read:probe,expected:{settings:writes(p)},id:names.join(',')}];
}
export function googleSmartObserved(read:CompiledRequest,data:JsonObject):JsonObject{
 const found=object(data.settings)?data.settings:{},names=(read as Read).googleSmartState?.settings??[];
 return {settings:Object.fromEntries(names.map(n=>[n,object(found[n])?found[n]:{present:false}]))};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleSmartFamily:ReviewedFamily={
 name:'google_smart_campaign_settings',
 files:['src/google-smart-campaign-settings.ts',['tests/google-smart-campaign-settings.test.mjs']],
 kind:googleSmartKind,
 assert:assertGoogleSmart,
 scope:assertGoogleAdsScope,
 snapshots:googleSmartSnapshots,
 isRead:isGoogleSmartRead,
 reader:readGoogleSmart,
 validateState:validateGoogleSmartState,
 prerequisites:googleSmartPrerequisites,
 impact:googleSmartImpact,
 outcome:googleSmartOutcome,
 verification:googleSmartVerification,
 observed:googleSmartObserved,
 exemptFromSpendTextMatch:true,
};
