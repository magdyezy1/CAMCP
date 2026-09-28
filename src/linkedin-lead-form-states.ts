import {MirrorError} from './errors.js';
import type {CompiledRequest,Connection,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';

/**
 * Publishing and archiving LinkedIn lead gen forms, per "Lead Syncing" (Updating Lead Forms, Updating Form Status;
 * li-lms-2026-09, checked 2026-09-27). POST /rest/leadForms/{id} with X-RestLi-Method PARTIAL_UPDATE and
 * {patch: {$set: {state}}} changes the status and answers 204. "Form status can be changed from PUBLISHED to ARCHIVED ...
 * the status change only affects whether the form and the associated creative gets served or not"; a DRAFT form is
 * published the same way. Content edits stay outside: the reference names the fields editable on published forms
 * (headline, description, legalDisclaimer, landingPageUrl, privacyPageUrl, thankYouMessage, thankYouPageCta) differently
 * from the form schema, so their patch paths would be guessed. The form is read before and after.
 */
type Read=CompiledRequest&{linkedinLeadFormStateRead?:string};
const gateway='linkedin_native_action',origin='https://api.linkedin.com',marker='AMCP_LINKEDIN_LEAD_FORM_STATE_READ';
const transitions:Record<string,string>={PUBLISHED:'DRAFT',ARCHIVED:'PUBLISHED'};
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_LINKEDIN_LEAD_FORM_STATE',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
const formOf=(p:CompiledRequest)=>/^\/rest\/leadForms\/([1-9][0-9]{0,18})$/.exec(p.path)?.[1];
export function linkedinLeadFormStateKind(p:CompiledRequest):boolean{
 return p.gateway===gateway&&p.method==='POST'&&!p.specialTransport&&(p.origin===undefined||p.origin===origin)&&!!formOf(p);
}
const target=(p:CompiledRequest)=>{const b=object(p.body)?p.body:{};return object(b.patch)&&object(b.patch.$set)?String(b.patch.$set.state):'';};
export function assertLinkedInLeadFormState(p:CompiledRequest):void{
 if(!linkedinLeadFormStateKind(p))return;
 if(!/^[1-9][0-9]{0,19}$/.test(p.accountId??''))invalid('Select the sponsored account that owns the form.');
 if(Object.keys(p.headers).some(k=>!['LinkedIn-Version','X-Restli-Protocol-Version','X-RestLi-Method'].includes(k))||p.headers['X-Restli-Protocol-Version']!=='2.0.0'||!/^20\d{4}$/.test(p.headers['LinkedIn-Version']??''))invalid('Use the native versioned REST.li 2.0 contract without other headers.');
 if(p.headers['X-RestLi-Method']?.toUpperCase()!=='PARTIAL_UPDATE')invalid('A form status change is a PARTIAL_UPDATE (X-RestLi-Method).');
 if(Object.keys(p.query).length)invalid('Form status changes take no query parameters.');
 const b=p.body;
 if(!object(b)||Object.keys(b).join()!=='patch'||!object(b.patch)||Object.keys(b.patch).join()!=='$set'||!object(b.patch.$set)||Object.keys(b.patch.$set).join()!=='state')invalid('Send {patch: {$set: {state}}}; editing form content is not available here.');
 if(!Object.hasOwn(transitions,target(p)))invalid('state is PUBLISHED (from DRAFT) or ARCHIVED (from PUBLISHED).');
}
export function assertLinkedInLeadFormStateScope(c:Connection):void{
 if(!c.scopes.includes('rw_ads'))fail('INSUFFICIENT_SCOPE','Reconnect LinkedIn with rw_ads to publish or archive lead forms.',{},403);
}
/** Publishing or archiving decides whether ads that use the form serve. */
export function linkedinLeadFormStateNeedsConfirmation(p:CompiledRequest):boolean{return linkedinLeadFormStateKind(p);}
function read(p:CompiledRequest):Read{
 const id=formOf(p)!;
 return {...p,action:marker,method:'GET',path:'/rest/leadForms/'+id,query:{},body:undefined,headers:{'LinkedIn-Version':p.headers['LinkedIn-Version']!,'X-Restli-Protocol-Version':'2.0.0'},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,linkedinLeadFormStateRead:id};
}
/** The status change after validation, and the server-built read of the same form for the selected account. */
export function authorizeLinkedInLeadFormState(p:CompiledRequest,c:Connection,selected:string):boolean{
 if(p.gateway!==gateway)return false;
 if(linkedinLeadFormStateKind(p)){assertLinkedInLeadFormState(p);assertLinkedInLeadFormStateScope(c);if(p.accountId!==selected)fail('ACCOUNT_SCOPE_MISMATCH','Select the sponsored account that owns the form.',{},403);return true;}
 const r=p as Read;
 if(p.action!==marker||!r.linkedinLeadFormStateRead||p.method!=='GET'||!p.readOnly||Object.keys(p.query).length||p.accountId!==selected||p.path!=='/rest/leadForms/'+r.linkedinLeadFormStateRead)return false;
 return true;
}
export function linkedinLeadFormStateSnapshots(p:CompiledRequest):Read[]{return [read(p)];}
export function isLinkedInLeadFormStateRead(p:CompiledRequest):p is Read{return p.gateway===gateway&&!!(p as Read).linkedinLeadFormStateRead;}
export async function readLinkedInLeadFormStates(p:CompiledRequest,fetch:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 const id=(p as Read).linkedinLeadFormStateRead;if(!id)return fetch(p);
 const r=await fetch(p),d=r.data;
 if(r.status!==200||!object(d)||d.serviceErrorCode!==undefined||typeof d.status==='number')unverified('LinkedIn did not return the lead form.');
 if(String(d.id)!==id)fail('STATE_TARGET_MISMATCH','LinkedIn returned a different lead form.',{},409);
 const owner=object(d.owner)?d.owner:{};
 return {status:200,headers:{},data:{id,name:typeof d.name==='string'?d.name:null,state:typeof d.state==='string'?d.state:null,owner:typeof owner.sponsoredAccount==='string'?owner.sponsoredAccount:Object.keys(owner).join()||null}};
}
export function validateLinkedInLeadFormStateRead(p:CompiledRequest,r:TransportResult):void{
 const d=r.data;if(!(p as Read).linkedinLeadFormStateRead||r.status!==200||!object(d)||typeof d.id!=='string')unverified('Missing verified lead form state.');
}
export function linkedinLeadFormStatePrerequisites(p:CompiledRequest,states:unknown[]):void{
 if(!linkedinLeadFormStateKind(p))return;
 const s=states[0];if(!object(s))unverified('Missing verified lead form state.');
 if(s.owner!=='urn:li:sponsoredAccount:'+p.accountId)fail('RESOURCE_SCOPE_REQUIRED','Lead form '+String(s.id)+' is not owned by the selected sponsored account.',{},403);
 const want=target(p),from=transitions[want]!;
 if(s.state===want)invalid('Lead form '+String(s.id)+' is already '+want+'.');
 if(s.state!==from)invalid('Lead form '+String(s.id)+' is '+String(s.state)+'; only a '+from+' form becomes '+want+'.');
}
export function linkedinLeadFormStateImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 if(!linkedinLeadFormStateKind(p))return;
 const first=state[0],s:JsonObject=object(first)?first:{},want=target(p);
 return {provider:'linkedin',scope:'lead_form',operation:want==='ARCHIVED'?'archive':'publish',form:{id:formOf(p),name:s.name??null,state:s.state??null},may_affect_serving:true,
  effect:want==='ARCHIVED'?'Archives the form: creatives that use it stop serving.':'Publishes the form, so creatives in live campaigns can use it.',
  verification:'Reads the form again and expects the new state.',source:'https://learn.microsoft.com/en-us/linkedin/marketing/lead-sync/leadsync?view=li-lms-2026-09'};
}
export function linkedinLeadFormStateOutcome(_p:CompiledRequest,r:TransportResult):boolean{return r.status===204||r.status===200&&(r.data===undefined||r.data===null||r.data===''||object(r.data)&&!Object.keys(r.data).length);}
export function linkedinLeadFormStateVerification(p:CompiledRequest):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 return [{read:read(p),expected:{state:target(p)},id:formOf(p)!}];
}
export function linkedinLeadFormStateObserved(_read:CompiledRequest,data:JsonObject):JsonObject{return data;}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const linkedinLeadFormStateFamily:ReviewedFamily={
 name:'linkedin_lead_form_states',
 files:['src/linkedin-lead-form-states.ts',['tests/linkedin-lead-form-states.test.mjs']],
 kind:linkedinLeadFormStateKind,
 assert:assertLinkedInLeadFormState,
 authorize:authorizeLinkedInLeadFormState,
 snapshots:linkedinLeadFormStateSnapshots,
 isRead:isLinkedInLeadFormStateRead,
 reader:readLinkedInLeadFormStates,
 validateState:validateLinkedInLeadFormStateRead,
 prerequisites:linkedinLeadFormStatePrerequisites,
 impact:linkedinLeadFormStateImpact,
 outcome:linkedinLeadFormStateOutcome,
 verification:linkedinLeadFormStateVerification,
 observed:linkedinLeadFormStateObserved,
 spendConfirmation:{needed:linkedinLeadFormStateNeedsConfirmation,message:'Publishing or archiving a lead form decides whether the creatives that use it serve. Review it and provide spend_change_confirmed=true.'},
 exemptFromSpendTextMatch:true,
};
