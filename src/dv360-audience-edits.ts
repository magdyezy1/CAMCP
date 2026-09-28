import {MirrorError} from './errors.js';
import type {CompiledRequest,Connection,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';

/**
 * Renaming and re-describing advertiser-owned customer match audiences on Display & Video 360 API v4, per the pinned
 * Discovery document (firstPartyAndPartnerAudiences patch and get; FirstPartyAndPartnerAudience; checked 2026-09-28).
 * PATCH /v4/firstPartyAndPartnerAudiences/{id}?advertiserId=&updateMask= "Updates an existing FirstPartyAndPartnerAudience.
 * Only supported for the following audience_type: CUSTOMER_MATCH_CONTACT_INFO, CUSTOMER_MATCH_DEVICE_ID"; "Updates are only
 * supported for the following fields: displayName, description, membershipDurationDays"; advertiserId is "The ID of the
 * owner advertiser". membershipDurationDays stays out: it sets how long uploaded customers remain members. Members
 * (editCustomerMatchMembers) are customer data and stay out too.
 */
type State={audience:string};
type Read=CompiledRequest&{dv360AudienceEditState?:State};
const gateway='dv360_native_action',origin='https://displayvideo.googleapis.com',oauthScope='https://www.googleapis.com/auth/display-video';
const types=['CUSTOMER_MATCH_CONTACT_INFO','CUSTOMER_MATCH_DEVICE_ID'],editable=['displayName','description'],descriptionMax=1000;
const obj=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_DV360_AUDIENCE_EDIT',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
export function dv360AudienceEditKind(p:CompiledRequest):boolean{
 return p.gateway===gateway&&p.method==='PATCH'&&!p.specialTransport&&(p.origin===undefined||p.origin===origin)&&/^\/v4\/firstPartyAndPartnerAudiences\/[^/]+$/.test(p.path);
}
const audienceOf=(p:CompiledRequest)=>p.path.split('/')[3]!;
const body=(p:CompiledRequest):JsonObject=>obj(p.body)?p.body:{};
const maskOf=(p:CompiledRequest)=>String(p.query.updateMask??'').split(',');
export function assertDV360AudienceEdit(p:CompiledRequest):void{
 if(!dv360AudienceEditKind(p))return;
 if(!id(audienceOf(p)))invalid('The path names one audience by its numeric ID.');
 if(Object.keys(p.headers??{}).length)invalid('Audience edits take no header overrides.');
 if(Object.keys(p.query).some(k=>!['advertiserId','updateMask'].includes(k))||typeof p.query.updateMask!=='string')invalid('An audience edit takes advertiserId and updateMask in the query and nothing else.');
 if(p.query.advertiserId!==p.accountId||!id(p.query.advertiserId))fail('ACCOUNT_SCOPE_MISMATCH','advertiserId must be the selected advertiser, the owner of the audience.',{},403);
 const mask=maskOf(p);
 if(!mask.length||mask.some(f=>!editable.includes(f))||new Set(mask).size!==mask.length)invalid('updateMask lists displayName, description or both; membershipDurationDays stays out (it decides how long uploaded customers remain members).');
 const b=p.body;if(!obj(b))invalid('Provide the FirstPartyAndPartnerAudience body.');
 if(Object.keys(b).some(k=>!mask.includes(k))||mask.some(k=>!Object.hasOwn(b,k)))invalid('The body carries exactly the fields named in updateMask.');
 if(b.displayName!==undefined&&(typeof b.displayName!=='string'||!b.displayName.trim()||b.displayName!==b.displayName.trim()||Buffer.byteLength(b.displayName,'utf8')>240||/[\u0000-\u001f\u007f]/.test(b.displayName)))invalid('displayName has 1–240 bytes of UTF-8 without surrounding spaces or control characters.');
 if(b.description!==undefined&&(typeof b.description!=='string'||[...b.description].length>descriptionMax||/[\u0000-\u0008\u000b-\u001f\u007f]/.test(b.description)))invalid('description is text of at most '+descriptionMax+' characters.');
}
export function assertDV360AudienceEditScope(c:Connection):void{if(!c.scopes.includes(oauthScope))fail('INSUFFICIENT_SCOPE','Reconnect the selected DV360 connection with display-video scope.',{},403);}
/** The validated edit names the selected advertiser as owner; audience reads are authorized by the audience read rule. */
export function authorizeDV360AudienceEdit(p:CompiledRequest,c:Connection,account:string):boolean{
 if(!dv360AudienceEditKind(p))return false;
 assertDV360AudienceEdit(p);if(p.accountId!==account)fail('ACCOUNT_SCOPE_MISMATCH','advertiserId must be the selected advertiser.',{},403);assertDV360AudienceEditScope(c);return true;
}
const read=(p:CompiledRequest,state:State):Read=>({...p,action:'DV360_FIRST_PARTY_AND_PARTNER_AUDIENCES_GET',method:'GET',path:'/v4/firstPartyAndPartnerAudiences/'+state.audience,query:{advertiserId:p.accountId!},body:undefined,headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,dv360AudienceEditState:state});
export function dv360AudienceEditSnapshots(p:CompiledRequest):Read[]{return [read(p,{audience:audienceOf(p)})];}
export function isDV360AudienceEditRead(p:CompiledRequest):p is Read{return p.gateway===gateway&&!!(p as Read).dv360AudienceEditState;}
const notFound=(e:unknown)=>e instanceof MirrorError&&(e.status===404||e.code==='NOT_FOUND');
/** The audience as the advertiser reads it: type, first- or third-party, name and description (not its changing sizes). */
export async function readDV360AudienceEdits(p:CompiledRequest,request:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 const s=(p as Read).dv360AudienceEditState;if(!s)return request(p);
 let d:unknown;
 try{const r=await request({...(p as Read),dv360AudienceEditState:undefined} as Read);if(r.status!==200)unverified('DV360 did not return the audience.');d=r.data;}
 catch(e){if(notFound(e))return {status:200,headers:{},data:{audience:{present:false,id:s.audience}}};throw e;}
 if(!obj(d)||String(d.firstPartyAndPartnerAudienceId)!==s.audience)fail('STATE_TARGET_MISMATCH','DV360 returned another audience than '+s.audience+'.',{},409);
 return {status:200,headers:{},data:{audience:{present:true,id:s.audience,displayName:d.displayName??null,description:d.description??null,audienceType:d.audienceType??null,firstPartyAndPartnerAudienceType:d.firstPartyAndPartnerAudienceType??null,audienceSource:d.audienceSource??null}}};
}
export function validateDV360AudienceEditState(p:CompiledRequest,r:TransportResult):void{
 const d=r.data;if(!(p as Read).dv360AudienceEditState||r.status!==200||!obj(d)||!obj(d.audience)||typeof d.audience.present!=='boolean')unverified('Missing verified audience state.');
}
export function dv360AudienceEditPrerequisites(p:CompiledRequest,states:unknown[]):void{
 if(!dv360AudienceEditKind(p))return;
 const s=states[0],a=obj(s)&&obj(s.audience)?s.audience:unverified('Missing verified audience state.');
 if(a.present!==true)fail('STATE_NOT_FOUND','Audience '+audienceOf(p)+' is not an audience the selected advertiser can read.',{audience_id:audienceOf(p)},404);
 if(!types.includes(String(a.audienceType)))invalid('Audience '+audienceOf(p)+' is '+String(a.audienceType)+'; DV360 edits only customer match audiences ('+types.join(', ')+').');
 const b=body(p);
 if(b.description!==undefined&&a.firstPartyAndPartnerAudienceType!=='TYPE_FIRST_PARTY')invalid('A description applies only to first-party audiences.');
 if(Object.entries(b).every(([k,v])=>a[k]===v))invalid('Audience '+audienceOf(p)+' already has these values.');
}
export function dv360AudienceEditImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 if(!dv360AudienceEditKind(p))return;
 const first=state[0],a=obj(first)&&obj(first.audience)?first.audience:{};
 return {provider:'dv360',scope:'customer_match_audience',operation:'update',audience:{id:audienceOf(p),displayName:a.displayName??null,description:a.description??null,audienceType:a.audienceType??null},changes:body(p),may_affect_serving:false,
  effect:'Renames or re-describes the audience; its members and the line items that target it are unchanged.',
  verification:'Reads the audience again as the advertiser and compares the changed fields.',source:'https://developers.google.com/display-video/api/reference/rest/v4/firstPartyAndPartnerAudiences/patch'};
}
export function dv360AudienceEditOutcome(p:CompiledRequest,r:TransportResult):boolean{
 const d=r.data;return r.status===200&&obj(d)&&String(d.firstPartyAndPartnerAudienceId)===audienceOf(p);
}
export function dv360AudienceEditVerification(p:CompiledRequest):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 return [{read:read(p,{audience:audienceOf(p)}),expected:{audience:{present:true,...body(p)}},id:'audience '+audienceOf(p)}];
}
export function dv360AudienceEditObserved(_read:CompiledRequest,data:JsonObject):JsonObject{
 const a=obj(data.audience)?data.audience:{};
 return {audience:a.present===true?{present:true,displayName:a.displayName??null,description:a.description??null}:{present:false}};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const dv360AudienceEditFamily:ReviewedFamily={
 name:'dv360_audience_edits',
 files:['src/dv360-audience-edits.ts',['tests/dv360-audience-edits.test.mjs']],
 kind:dv360AudienceEditKind,
 assert:assertDV360AudienceEdit,
 authorize:authorizeDV360AudienceEdit,
 snapshots:dv360AudienceEditSnapshots,
 isRead:isDV360AudienceEditRead,
 reader:readDV360AudienceEdits,
 validateState:validateDV360AudienceEditState,
 prerequisites:dv360AudienceEditPrerequisites,
 impact:dv360AudienceEditImpact,
 outcome:dv360AudienceEditOutcome,
 verification:dv360AudienceEditVerification,
 observed:dv360AudienceEditObserved,
 exemptFromSpendTextMatch:true,
};
