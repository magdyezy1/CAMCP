import {MirrorError} from './errors.js';
import type {CompiledRequest,Connection,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';

/**
 * LinkedIn Audience Network publisher lists, per "Manage Audience Restrictions" of the Marketing API (li-lms-2025-10 to
 * li-lms-2026-09, checked 2026-09-27). POST /rest/adPublisherRestrictions registers an uploaded block or allow list
 * ({dataId: media URN of the CSV, entity: sponsored account URN, fileName, type BLOCKLIST (default) or ALLOWLIST}; the new
 * ID is in the location header). PUT /rest/adAccountTrustPreferences/{account} upserts the account-level lists
 * ({offsiteAccountPreferences: {publisherRestrictionFiles: {include, exclude}}} of adPublisherFile URNs; 204): with an
 * allowlist "only ads on these domains/apps will be served", with a blocklist "ads will not be served on these
 * domains/apps". The finder q=entity lists the account's files and GET on the preferences path reads them back.
 */
type Kind='restriction'|'preferences';
type State={kind:Kind};
type Read=CompiledRequest&{linkedinPublisherState?:State;linkedinPublisherPage?:true};
const gateway='linkedin_native_action',origin='https://api.linkedin.com',maxFiles=100,pageSize=100,maxPages=10;
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const numeric=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0?String(v):typeof v==='string'&&/^[1-9][0-9]{0,19}$/.test(v)?v:undefined;
const fileUrn=(v:unknown):v is string=>typeof v==='string'&&/^urn:li:adPublisherFile:[1-9][0-9]{0,19}$/.test(v);
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_LINKEDIN_PUBLISHER_RESTRICTION',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
const account=(p:CompiledRequest)=>{if(!/^[1-9][0-9]{0,19}$/.test(p.accountId??''))invalid('Select one sponsored account.');return p.accountId!;};
const accountUrn=(p:CompiledRequest)=>'urn:li:sponsoredAccount:'+account(p);
export function linkedinPublisherKind(p:CompiledRequest):Kind|undefined{
 if(p.gateway!==gateway||p.specialTransport||p.origin!==undefined&&p.origin!==origin)return;
 if(p.method==='POST'&&p.path==='/rest/adPublisherRestrictions')return 'restriction';
 if(p.method==='PUT'&&/^\/rest\/adAccountTrustPreferences\/[^/]+$/.test(p.path))return 'preferences';
 return;
}
const lists=(p:CompiledRequest)=>{const f=(p.body as JsonObject).offsiteAccountPreferences.publisherRestrictionFiles as JsonObject;return {include:[...f.include as string[]].sort(),exclude:[...f.exclude as string[]].sort()};};
export function assertLinkedInPublisher(p:CompiledRequest):void{
 const kind=linkedinPublisherKind(p);if(!kind)return;
 account(p);
 const method=p.headers['X-RestLi-Method']?.toUpperCase();
 if(Object.keys(p.headers).some(k=>!['LinkedIn-Version','X-Restli-Protocol-Version','X-RestLi-Method'].includes(k))||p.headers['X-Restli-Protocol-Version']!=='2.0.0'||!/^20\d{4}$/.test(p.headers['LinkedIn-Version']??''))invalid('Use the native versioned REST.li 2.0 contract without other headers.');
 if(method!==undefined&&method!==(kind==='restriction'?'CREATE':'UPDATE'))invalid(kind==='restriction'?'Registering a list is a CREATE.':'Account trust preferences are replaced with an UPDATE (PUT).');
 if(Object.keys(p.query).length)invalid(kind==='restriction'?'Registering a list takes no query; upload and download URL actions are outside this contract.':'Account trust preferences take no query parameters.');
 const b=p.body;if(!object(b))invalid('Provide the native body.');
 if(kind==='restriction'){
  if(Object.keys(b).some(k=>!['dataId','entity','fileName','type'].includes(k)))invalid('A publisher list takes dataId, entity, fileName and type.');
  if(typeof b.dataId!=='string'||!/^urn:li:media:\/[A-Za-z0-9_-]{8,512}\.csv$/.test(b.dataId))invalid('dataId is the media URN of the uploaded CSV, such as urn:li:media:/AAUQ...csv, from the location header of the upload.');
  if(b.entity!==accountUrn(p))invalid('entity is the selected sponsored account URN.');
  if(typeof b.fileName!=='string'||!b.fileName.trim()||b.fileName!==b.fileName.trim()||[...b.fileName].length>255||/[\u0000-\u001f]/.test(b.fileName))invalid('fileName has 1–255 characters without surrounding spaces or control characters.');
  if(b.type!==undefined&&!['BLOCKLIST','ALLOWLIST'].includes(b.type as string))invalid('type is BLOCKLIST (the default) or ALLOWLIST.');
  return;
 }
 if(p.path.split('/').at(-1)!==account(p))invalid('The path names the selected sponsored account.');
 const o=b.offsiteAccountPreferences,f=object(o)?o.publisherRestrictionFiles:undefined;
 if(Object.keys(b).some(k=>k!=='offsiteAccountPreferences')||!object(o)||Object.keys(o).some(k=>k!=='publisherRestrictionFiles')||!object(f)||Object.keys(f).sort().join()!=='exclude,include')invalid('Send {offsiteAccountPreferences: {publisherRestrictionFiles: {include: [...], exclude: [...]}}} with both lists, empty when unused; the PUT replaces them.');
 const all:string[]=[];
 for(const k of ['include','exclude']){const v=f[k];if(!Array.isArray(v)||v.length>maxFiles||v.some(x=>!fileUrn(x))||new Set(v).size!==v.length)invalid(k+' lists at most '+maxFiles+' different urn:li:adPublisherFile URNs.');all.push(...v as string[]);}
 if(new Set(all).size!==all.length)invalid('A publisher file is either allowed or blocked, not both.');
}
export function assertLinkedInPublisherScope(c:Connection,write=false):void{
 if(!c.scopes.some(s=>write?s==='rw_ads':['r_ads','rw_ads'].includes(s)))fail('INSUFFICIENT_SCOPE',write?'Publisher list writes require rw_ads.':'Publisher list reads require r_ads or rw_ads.',{},403);
}
function read(p:CompiledRequest,path:string,query:JsonObject={}):Read{return {...p,action:'AMCP_LINKEDIN_PUBLISHER_READ',method:'GET',path,query,body:undefined,headers:{'LinkedIn-Version':p.headers['LinkedIn-Version']!,'X-Restli-Protocol-Version':'2.0.0'},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,linkedinPublisherState:undefined,linkedinPublisherPage:true};}
const stateRead=(p:CompiledRequest,state:State):Read=>({...read(p,'/rest/adAccounts/'+account(p)),linkedinPublisherState:state});
export function linkedinPublisherSnapshots(p:CompiledRequest):Read[]{return [stateRead(p,{kind:linkedinPublisherKind(p)!})];}
export function isLinkedInPublisherRead(p:CompiledRequest):p is Read{return !!(p as Read).linkedinPublisherState;}
/** Writes after validation; server-built reads of the account, its publisher lists and its trust preferences. */
export function authorizeLinkedInPublisher(p:CompiledRequest,c:Connection,id:string):boolean{
 if(linkedinPublisherKind(p)){assertLinkedInPublisher(p);assertLinkedInPublisherScope(c,true);return true;}
 const internal=p as Read;if(p.gateway!==gateway||!internal.linkedinPublisherPage||p.action!=='AMCP_LINKEDIN_PUBLISHER_READ'||p.method!=='GET'||!p.readOnly||p.body!==undefined)return false;
 assertLinkedInPublisherScope(c);
 const q=Object.keys(p.query);
 if(!q.length&&(p.path==='/rest/adAccounts/'+id||p.path==='/rest/adAccountTrustPreferences/'+id))return true;
 if(p.path==='/rest/adPublisherRestrictions'&&p.query.q==='entity'&&p.query.entity==='urn:li:sponsoredAccount:'+id&&q.every(k=>['q','entity','start','count'].includes(k)))return true;
 return fail('RESOURCE_SCOPE_REQUIRED','Unqualified internal publisher list read.',{},403);
}
const notFound=(e:unknown)=>e instanceof MirrorError&&(e.status===404||e.code==='NOT_FOUND');
// Processing status changes on its own; only the preferences check needs it, so only that state carries it.
const view=(f:JsonObject,status:boolean)=>({id:numeric(f.id)??null,fileName:f.fileName??null,type:f.type??'BLOCKLIST',dataId:f.dataId??null,...(status?{status:f.status??null}:{})});
export async function readLinkedInPublisher(p:CompiledRequest,request:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 const s=(p as Read).linkedinPublisherState;if(!s)return request(p);
 const ok=(r:TransportResult,label:string)=>{if(r.status!==200||!object(r.data))unverified('LinkedIn did not return the '+label+'.');return r.data as JsonObject;};
 const a=ok(await request({...(p as Read),linkedinPublisherState:undefined} as Read),'ad account');
 if(numeric(a.id)!==account(p))unverified('LinkedIn returned another ad account.');
 const urn=accountUrn(p),files:JsonObject={};
 for(let page=0;;page++){
  if(page>=maxPages)unverified('The account has more publisher lists than one review reads ('+maxPages*pageSize+').');
  const d=ok(await request(read(p,'/rest/adPublisherRestrictions',{q:'entity',entity:urn,start:page*pageSize,count:pageSize})),'publisher lists of the account');
  const rows=Array.isArray(d.elements)?(d.elements as unknown[]):unverified('LinkedIn did not list the publisher lists.');
  for(const row of rows){
   if(!object(row)||!numeric(row.id))unverified('A publisher list row is malformed.');
   if(row.entity!==undefined&&row.entity!==urn)fail('STATE_TARGET_MISMATCH','LinkedIn listed a publisher list of another account.',{},409);
   files['f'+numeric(row.id)]=view(row,s.kind==='preferences');
  }
  const total=object(d.paging)&&typeof d.paging.total==='number'?d.paging.total:undefined;
  if(rows.length<pageSize||total!==undefined&&(page+1)*pageSize>=total)break;
 }
 const out:JsonObject={account:{id:account(p),status:a.status??null},files};
 if(s.kind==='preferences'){
  let prefs:JsonObject|null=null;
  try{prefs=ok(await request(read(p,'/rest/adAccountTrustPreferences/'+account(p))),'account trust preferences');}catch(e){if(!notFound(e))throw e;}
  const f=prefs&&object(prefs.offsiteAccountPreferences)&&object(prefs.offsiteAccountPreferences.publisherRestrictionFiles)?prefs.offsiteAccountPreferences.publisherRestrictionFiles as JsonObject:{};
  const list=(v:unknown)=>Array.isArray(v)?[...v].map(String).sort():[];
  out.preferences={present:!!prefs,include:list(f.include),exclude:list(f.exclude)};
 }
 return {status:200,headers:{},data:out};
}
export function validateLinkedInPublisherState(p:CompiledRequest,r:TransportResult):void{
 const s=(p as Read).linkedinPublisherState,d=r.data;
 if(!s||r.status!==200||!object(d)||!object(d.account)||!object(d.files)||(s.kind==='preferences')!==object(d.preferences))unverified('Missing verified publisher list state.');
}
export function linkedinPublisherPrerequisites(p:CompiledRequest,states:unknown[]):void{
 const kind=linkedinPublisherKind(p);if(!kind)return;
 const s=states[0];if(!object(s)||!object(s.files))unverified('Missing verified publisher list state.');
 const files=s.files as JsonObject;
 if(kind==='restriction'){
  const b=p.body as JsonObject,taken=Object.values(files).find(f=>object(f)&&f.dataId===b.dataId);
  if(taken)fail('CONFIGURATION_EXISTS','The uploaded file is already registered as publisher list '+String((taken as JsonObject).id)+'.',{publisher_restriction_id:String((taken as JsonObject).id)});
  return;
 }
 const want=lists(p);
 for(const [k,type] of [['include','ALLOWLIST'],['exclude','BLOCKLIST']] as const)for(const u of want[k]){
  const f=files['f'+u.split(':').at(-1)];
  if(!object(f))fail('STATE_NOT_FOUND','Publisher list '+u+' is not a list of the selected account.',{publisher_file:u});
  if(f.type!==type)invalid('Publisher list '+u+' is a '+String(f.type)+'; '+k+' takes '+type+' files.');
  if(String(f.status).toUpperCase()!=='SUCCESS')invalid('Publisher list '+u+' is '+String(f.status)+'; only processed (SUCCESS) lists apply.');
 }
 const before=s.preferences as JsonObject;
 if(object(before)&&JSON.stringify(before.include)===JSON.stringify(want.include)&&JSON.stringify(before.exclude)===JSON.stringify(want.exclude))invalid('The account already has these publisher lists.');
}
export function linkedinPublisherImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 const kind=linkedinPublisherKind(p);if(!kind)return;
 const first=state[0],s:JsonObject=object(first)?first:{};
 if(kind==='restriction'){const b=p.body as JsonObject;return {provider:'linkedin',scope:'publisher_restriction',operation:'create',creating:{fileName:b.fileName,type:b.type??'BLOCKLIST',dataId:b.dataId},may_affect_serving:false,
  effect:'Registers the uploaded list for the account; it changes nothing until campaigns or the account trust preferences name it.',verification:'Lists the account\'s publisher lists again and compares the new one.',source:'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/manage-audience-restrictions'};}
 const want=lists(p);
 return {provider:'linkedin',scope:'account_trust_preferences',operation:'replace',before:s.preferences??null,after:want,may_affect_serving:true,
  effect:(want.include.length?'Only the allowlisted domains and apps serve this account\'s offsite ads':'No account allowlist applies')+(want.exclude.length?'; blocklisted domains and apps never serve them':'; no account blocklist applies')+'. Campaign-level lists are unchanged.',
  verification:'Reads the account trust preferences again and compares both lists.',source:'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/manage-audience-restrictions'};
}
const createdId=(r:{headers?:unknown;data?:unknown})=>{const h=object(r.headers)?r.headers:{};return numeric(String(h['x-restli-id']??''))??/\/adPublisherRestrictions\/([1-9][0-9]{0,19})$/.exec(String(h.location??''))?.[1]??(object(r.data)?numeric(r.data.id):undefined);};
export function linkedinPublisherOutcome(p:CompiledRequest,r:TransportResult):boolean{
 if(linkedinPublisherKind(p)==='preferences')return r.status===204||r.status===200;
 return r.status===201&&!!createdId(r);
}
export function linkedinPublisherVerification(p:CompiledRequest,result:JsonObject):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 if(linkedinPublisherKind(p)==='preferences'){const want=lists(p);return [{read:stateRead(p,{kind:'preferences'}),expected:{preferences:{present:true,...want}},id:'account '+account(p)+' trust preferences'}];}
 const id=createdId(result as {headers?:unknown;data?:unknown});
 if(!id)fail('VERIFICATION_UNSUPPORTED','The receipt names no publisher list to verify.');
 const b=p.body as JsonObject;
 return [{read:stateRead(p,{kind:'restriction'}),expected:{files:{['f'+id]:{id,fileName:b.fileName,type:b.type??'BLOCKLIST',dataId:b.dataId}}},id:'publisher list '+id}];
}
export function linkedinPublisherObserved(_read:CompiledRequest,data:JsonObject):JsonObject{return {files:object(data.files)?data.files:{},...(object(data.preferences)?{preferences:data.preferences}:{})};}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const linkedinPublisherFamily:ReviewedFamily={
 name:'linkedin_publisher_restrictions',
 files:['src/linkedin-publisher-restrictions.ts',['tests/linkedin-publisher-restrictions.test.mjs']],
 kind:linkedinPublisherKind,
 assert:assertLinkedInPublisher,
 authorize:authorizeLinkedInPublisher,
 snapshots:linkedinPublisherSnapshots,
 isRead:isLinkedInPublisherRead,
 reader:readLinkedInPublisher,
 validateState:validateLinkedInPublisherState,
 prerequisites:linkedinPublisherPrerequisites,
 impact:linkedinPublisherImpact,
 outcome:linkedinPublisherOutcome,
 verification:linkedinPublisherVerification,
 observed:linkedinPublisherObserved,
 exemptFromSpendTextMatch:true,
};
