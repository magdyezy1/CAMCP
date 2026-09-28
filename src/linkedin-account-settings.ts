import {MirrorError} from './errors.js';
import type {CompiledRequest,Connection,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';

/**
 * LinkedIn ad account name and notification settings, per "Create and Manage Ad Accounts" (li-lms-2026-09, checked
 * 2026-09-28). "Ad Accounts can be updated through a partial update by patching the fields you want to change" (POST
 * /rest/adAccounts/{id}, X-RestLi-Method PARTIAL_UPDATE, 204). The schema lists name ("A label for the account") and five
 * notification switches (notifiedOnCampaignOptimization, notifiedOnCreativeApproval, notifiedOnCreativeRejection,
 * notifiedOnEndOfCampaign, notifiedOnNewFeaturesEnabled). status stays out (PENDING_DELETION deletes the account and
 * CANCELED is permanent), as do reference (the entity the account advertises for) and the immutable currency, type and
 * test fields.
 */
type Read=CompiledRequest&{linkedinAccountSettingsRead?:true};
const gateway='linkedin_native_action',origin='https://api.linkedin.com',nameMax=255;
const switches=['notifiedOnCampaignOptimization','notifiedOnCreativeApproval','notifiedOnCreativeRejection','notifiedOnEndOfCampaign','notifiedOnNewFeaturesEnabled'];
const editable=['name',...switches];
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_LINKEDIN_ACCOUNT_SETTING',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
export function linkedinAccountSettingsKind(p:CompiledRequest):boolean{
 return p.gateway===gateway&&p.method==='POST'&&!p.specialTransport&&(p.origin===undefined||p.origin===origin)&&/^\/rest\/adAccounts\/[^/]+$/.test(p.path);
}
const setOf=(p:CompiledRequest):JsonObject=>((p.body as JsonObject).patch as JsonObject).$set as JsonObject;
export function assertLinkedInAccountSettings(p:CompiledRequest):void{
 if(!linkedinAccountSettingsKind(p))return;
 if(!/^[1-9][0-9]{0,19}$/.test(p.accountId??'')||p.path.split('/')[3]!==p.accountId)invalid('The path names the selected sponsored account.');
 if(Object.keys(p.headers).some(k=>!['LinkedIn-Version','X-Restli-Protocol-Version','X-RestLi-Method'].includes(k))||p.headers['X-Restli-Protocol-Version']!=='2.0.0'||!/^20\d{4}$/.test(p.headers['LinkedIn-Version']??''))invalid('Use the native versioned REST.li 2.0 contract without other headers.');
 if(p.headers['X-RestLi-Method']?.toUpperCase()!=='PARTIAL_UPDATE')invalid('An account update is a PARTIAL_UPDATE (restli_method).');
 if(Object.keys(p.query).length)invalid('Account updates take no query parameters.');
 const b=p.body;
 if(!object(b)||Object.keys(b).join()!=='patch'||!object(b.patch)||Object.keys(b.patch).join()!=='$set'||!object(b.patch.$set))invalid('Send {patch: {$set: {...}}} with name and/or notification switches.');
 const set=setOf(p),extra=Object.keys(set).filter(k=>!editable.includes(k));
 if(!Object.keys(set).length||extra.length)invalid('An account update sets name and the notifiedOn switches'+(extra.length?', not '+extra.join(', '):'')+'. Status (deletion, cancellation), reference and the immutable currency, type and test fields stay out.');
 if(set.name!==undefined&&(typeof set.name!=='string'||!set.name.trim()||set.name!==set.name.trim()||[...set.name].length>nameMax||/[\u0000-\u001f\u007f]/.test(set.name)))invalid('name has 1–'+nameMax+' characters without leading or trailing spaces.');
 for(const k of switches)if(set[k]!==undefined&&typeof set[k]!=='boolean')invalid(k+' is true or false.');
}
export function assertLinkedInAccountSettingsScope(c:Connection,write=false):void{
 if(!c.scopes.some(s=>write?s==='rw_ads':['r_ads','rw_ads'].includes(s)))fail('INSUFFICIENT_SCOPE',write?'Account updates require rw_ads.':'Account reads require r_ads or rw_ads.',{},403);
}
/** The validated update and its marked read, for the selected sponsored account only. */
export function authorizeLinkedInAccountSettings(p:CompiledRequest,c:Connection,id:string):boolean{
 if(linkedinAccountSettingsKind(p)){assertLinkedInAccountSettings(p);assertLinkedInAccountSettingsScope(c,true);if(p.accountId!==id)fail('ACCOUNT_SCOPE_MISMATCH','Select the sponsored account to update.',{},403);return true;}
 if(p.gateway!==gateway||!(p as Read).linkedinAccountSettingsRead||p.method!=='GET'||!p.readOnly||Object.keys(p.query).length||p.path!=='/rest/adAccounts/'+id)return false;
 assertLinkedInAccountSettingsScope(c);return true;
}
const read=(p:CompiledRequest):Read=>({...p,action:'AMCP_LINKEDIN_ACCOUNT_READ',method:'GET',path:'/rest/adAccounts/'+p.accountId,query:{},body:undefined,headers:{'LinkedIn-Version':p.headers['LinkedIn-Version']!,'X-Restli-Protocol-Version':'2.0.0'},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,linkedinAccountSettingsRead:true});
export function linkedinAccountSettingsSnapshots(p:CompiledRequest):Read[]{return [read(p)];}
export function isLinkedInAccountSettingsRead(p:CompiledRequest):p is Read{return p.gateway===gateway&&!!(p as Read).linkedinAccountSettingsRead;}
/** The account's name, status and notification switches (not its serving statuses, which change on their own). */
export async function readLinkedInAccountSettings(p:CompiledRequest,request:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 if(!(p as Read).linkedinAccountSettingsRead)return request(p);
 const r=await request({...(p as Read),linkedinAccountSettingsRead:undefined} as Read),d=r.data;
 if(r.status!==200||!object(d)||d.serviceErrorCode!==undefined)unverified('LinkedIn did not return the ad account.');
 if(String(d.id)!==p.accountId)fail('STATE_TARGET_MISMATCH','LinkedIn returned another ad account.',{},409);
 return {status:200,headers:{},data:{account:{id:p.accountId,name:d.name??null,status:d.status??null,type:d.type??null,...Object.fromEntries(switches.map(k=>[k,typeof d[k]==='boolean'?d[k]:false]))}}};
}
export function validateLinkedInAccountSettingsState(p:CompiledRequest,r:TransportResult):void{
 const d=r.data;if(!(p as Read).linkedinAccountSettingsRead||r.status!==200||!object(d)||!object(d.account))unverified('Missing verified ad account state.');
}
export function linkedinAccountSettingsPrerequisites(p:CompiledRequest,states:unknown[]):void{
 if(!linkedinAccountSettingsKind(p))return;
 const s=states[0],a=object(s)&&object(s.account)?s.account:unverified('Missing verified ad account state.');
 if(['CANCELED','PENDING_DELETION','REMOVED'].includes(String(a.status)))invalid('The ad account is '+String(a.status)+'; its settings no longer change.');
 const set=setOf(p);
 if(Object.entries(set).every(([k,v])=>a[k]===v))invalid('The ad account already has these values.');
}
export function linkedinAccountSettingsImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 if(!linkedinAccountSettingsKind(p))return;
 const first=state[0],a=object(first)&&object(first.account)?first.account:{},set=setOf(p);
 return {provider:'linkedin',scope:'ad_account',operation:'update',account:{id:p.accountId,name:a.name??null,status:a.status??null},changes:set,may_affect_serving:false,
  effect:'Renames the account or changes which Campaign Manager notifications its contacts receive; campaigns, creatives and budgets are unchanged.',
  verification:'Reads the account again and compares the changed fields.',source:'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-accounts?view=li-lms-2026-09'};
}
export function linkedinAccountSettingsOutcome(_p:CompiledRequest,r:TransportResult):boolean{return r.status===204||r.status===200&&(r.data===undefined||r.data===null||r.data===''||object(r.data)&&!Object.keys(r.data).length);}
export function linkedinAccountSettingsVerification(p:CompiledRequest):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 return [{read:read(p),expected:{account:setOf(p)},id:'ad account '+p.accountId}];
}
export function linkedinAccountSettingsObserved(_read:CompiledRequest,data:JsonObject):JsonObject{return {account:object(data.account)?data.account:null};}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const linkedinAccountSettingsFamily:ReviewedFamily={
 name:'linkedin_account_settings',
 files:['src/linkedin-account-settings.ts',['tests/linkedin-account-settings.test.mjs']],
 kind:linkedinAccountSettingsKind,
 assert:assertLinkedInAccountSettings,
 authorize:authorizeLinkedInAccountSettings,
 snapshots:linkedinAccountSettingsSnapshots,
 isRead:isLinkedInAccountSettingsRead,
 reader:readLinkedInAccountSettings,
 validateState:validateLinkedInAccountSettingsState,
 prerequisites:linkedinAccountSettingsPrerequisites,
 impact:linkedinAccountSettingsImpact,
 outcome:linkedinAccountSettingsOutcome,
 verification:linkedinAccountSettingsVerification,
 observed:linkedinAccountSettingsObserved,
 exemptFromSpendTextMatch:true,
};
