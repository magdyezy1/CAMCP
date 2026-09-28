import {MirrorError} from './errors.js';
import type {CompiledRequest,Connection,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';

/**
 * Registering uploaded custom bidding scripts and rules on Display & Video 360 API v4, per the pinned Discovery document
 * (customBiddingAlgorithms.scripts.create and .rules.create, list and get; checked 2026-09-27).
 * - A script or rules file is uploaded first (customBiddingAlgorithms.uploadScript or uploadRules returns a reference and
 *   media.upload takes the bytes; both outside this contract). POST .../scripts with {script: {resourceName:
 *   "customBiddingAlgorithms/{id}/scriptRef/{ref}"}} or POST .../rules with {rules: {resourceName:
 *   "customBiddingAlgorithms/{id}/rulesRef/{ref}"}} registers it; the reply carries the new ID and a state (scripts
 *   PENDING, ACCEPTED or REJECTED; rules ACCEPTED or REJECTED).
 * - "Requests creating a custom bidding script under an algorithm assigned to a line item will return an error", as do
 *   rules; scripts need a SCRIPT_BASED algorithm and rules a RULE_BASED one.
 */
type Kind='script'|'rules';
type State={kind:Kind;algorithmId:string};
type Read=CompiledRequest&{dv360BiddingFileState?:State};
const gateway='dv360_native_action',origin='https://displayvideo.googleapis.com',oauthScope='https://www.googleapis.com/auth/display-video',pageSize=200,maxPages=5;
const obj=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_DV360_CUSTOM_BIDDING_FILE',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
function denied(message:string):never{return fail('RESOURCE_SCOPE_REQUIRED',message,{},403);}
export function dv360BiddingFileKind(p:CompiledRequest):Kind|undefined{
 if(p.gateway!==gateway||p.origin!==undefined&&p.origin!==origin||p.specialTransport||p.method!=='POST')return;
 const m=/^\/v4\/customBiddingAlgorithms\/[^/]+\/(scripts|rules)$/.exec(p.path);
 return m?m[1]==='scripts'?'script':'rules':undefined;
}
const algorithmOf=(p:CompiledRequest)=>p.path.split('/')[3]!;
const field=(k:Kind)=>k==='script'?'script':'rules',refKind=(k:Kind)=>k==='script'?'scriptRef':'rulesRef',type=(k:Kind)=>k==='script'?'SCRIPT_BASED':'RULE_BASED';
const refOf=(p:CompiledRequest)=>String(((p.body as JsonObject)[field(dv360BiddingFileKind(p)!)] as JsonObject).resourceName);
const advertiserOf=(p:CompiledRequest)=>String(p.query.advertiserId);
export function assertDV360BiddingFile(p:CompiledRequest):void{
 const kind=dv360BiddingFileKind(p);if(!kind)return;
 if(!id(algorithmOf(p)))invalid('The path names a custom bidding algorithm ID.');
 if(Object.keys(p.headers??{}).length)invalid('Custom bidding file registrations take no header overrides.');
 if(Object.keys(p.query).some(k=>k!=='advertiserId')||!id(p.query.advertiserId))fail('ACCOUNT_SCOPE_MISMATCH','Name the selected advertiser in advertiserId; partner-owned algorithms are outside this contract.',{},403);
 if(p.accountId!==undefined&&p.accountId!==p.query.advertiserId)fail('ACCOUNT_SCOPE_MISMATCH','advertiserId must be the selected advertiser.',{},403);
 const b=p.body,f=field(kind),ref=obj(b)?b[f]:undefined;
 if(!obj(b)||Object.keys(b).some(k=>k!==f)||!obj(ref)||Object.keys(ref).some(k=>k!=='resourceName'))invalid('Send {'+f+': {resourceName}} with the reference returned by '+(kind==='script'?'uploadScript':'uploadRules')+'; other fields are output only.');
 if(typeof ref.resourceName!=='string'||!new RegExp('^customBiddingAlgorithms/'+algorithmOf(p)+'/'+refKind(kind)+'/[A-Za-z0-9_.-]{1,256}$').test(ref.resourceName))invalid(f+'.resourceName is customBiddingAlgorithms/'+algorithmOf(p)+'/'+refKind(kind)+'/{ref_id}, the uploaded file of this algorithm.');
}
export function assertDV360BiddingFileScope(c:Connection):void{if(!c.scopes.includes(oauthScope))fail('INSUFFICIENT_SCOPE','Reconnect the selected DV360 connection with display-video scope.',{},403);}
const read=(p:CompiledRequest,path:string,query:JsonObject):Read=>({...p,action:'AMCP_DV360_CUSTOM_BIDDING_FILE_READ',method:'GET',path,query,body:undefined,headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,dv360BiddingFileState:undefined});
const stateRead=(p:CompiledRequest,s:State):Read=>({...read(p,'/v4/customBiddingAlgorithms/'+s.algorithmId,{advertiserId:advertiserOf(p)}),dv360BiddingFileState:s});
export function dv360BiddingFileSnapshots(p:CompiledRequest):Read[]{return [stateRead(p,{kind:dv360BiddingFileKind(p)!,algorithmId:algorithmOf(p)})];}
export function isDV360BiddingFileRead(p:CompiledRequest):p is Read{return p.gateway===gateway&&!!(p as Read).dv360BiddingFileState;}
/** Writes after validation; internal reads name the selected advertiser as accessor, never a partner. */
export function authorizeDV360BiddingFile(p:CompiledRequest,c:Connection,account:string):boolean{
 if(p.gateway!==gateway||p.origin!==undefined&&p.origin!==origin||p.specialTransport)return false;
 if(dv360BiddingFileKind(p)){assertDV360BiddingFile(p);if(p.query.advertiserId!==account)fail('ACCOUNT_SCOPE_MISMATCH','advertiserId must be the selected advertiser.',{},403);assertDV360BiddingFileScope(c);return true;}
 if(p.action!=='AMCP_DV360_CUSTOM_BIDDING_FILE_READ'||p.method!=='GET'||!p.readOnly||p.body!==undefined)return false;
 if(!/^\/v4\/customBiddingAlgorithms\/[1-9]\d{0,18}(?:\/(?:scripts|rules))?$/.test(p.path))denied('Unqualified internal custom bidding file read.');
 if(p.query.advertiserId!==account||Object.keys(p.query).some(k=>!['advertiserId','pageSize','pageToken'].includes(k)))denied('Custom bidding file reads name the selected advertiser in advertiserId.');
 assertDV360BiddingFileScope(c);return true;
}
function payload(r:TransportResult,label:string):JsonObject{if(r.status!==200||!obj(r.data))unverified('DV360 did not return the '+label+'.');return r.data as JsonObject;}
// Processing state and the active flag change on their own; the checks need only the file references.
const fileView=(k:Kind,f:JsonObject)=>({id:String(k==='script'?f.customBiddingScriptId:f.customBiddingAlgorithmRulesId),resourceName:obj(f[field(k)])?(f[field(k)] as JsonObject).resourceName??null:null});
export async function readDV360BiddingFiles(p:CompiledRequest,fetch:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 const s=(p as Read).dv360BiddingFileState;if(!s)return fetch(p);
 const advertiser=advertiserOf(p);
 let g:JsonObject|undefined;
 try{g=payload(await fetch({...(p as Read),dv360BiddingFileState:undefined} as Read),'custom bidding algorithm');}
 catch(e){if(!(e instanceof MirrorError&&(e.status===404||e.code==='NOT_FOUND')))throw e;}
 if(!g)return {status:200,headers:{},data:{algorithm:{present:false,customBiddingAlgorithmId:s.algorithmId},files:{}}};
 if(String(g.customBiddingAlgorithmId)!==s.algorithmId)fail('STATE_TARGET_MISMATCH','DV360 returned a different custom bidding algorithm.',{},409);
 const algorithm={present:true,customBiddingAlgorithmId:s.algorithmId,advertiserId:g.advertiserId===undefined?null:String(g.advertiserId),partnerId:g.partnerId===undefined?null:String(g.partnerId),customBiddingAlgorithmType:g.customBiddingAlgorithmType??null,entityStatus:g.entityStatus??null};
 const files:JsonObject={},key=s.kind==='script'?'customBiddingScripts':'customBiddingRules',path='/v4/customBiddingAlgorithms/'+s.algorithmId+'/'+(s.kind==='script'?'scripts':'rules');
 let token:string|undefined;
 for(let page=0;;page++){
  if(page>=maxPages)unverified('The algorithm has more '+(s.kind==='script'?'scripts':'rules')+' than one review reads ('+maxPages*pageSize+').');
  const d=payload(await fetch(read(p,path,{advertiserId:advertiser,pageSize,...(token?{pageToken:token}:{})})),'algorithm '+(s.kind==='script'?'scripts':'rules'));
  const rows=d[key]===undefined?[]:Array.isArray(d[key])?d[key] as unknown[]:unverified('DV360 did not list the algorithm files.');
  for(const r of rows){if(!obj(r))unverified('An algorithm file row is malformed.');const v=fileView(s.kind,r);if(!id(v.id))unverified('An algorithm file row has no ID.');files['f'+v.id]=v;}
  token=typeof d.nextPageToken==='string'&&d.nextPageToken?d.nextPageToken:undefined;if(!token)break;
 }
 return {status:200,headers:{},data:{algorithm,files}};
}
export function validateDV360BiddingFileState(p:CompiledRequest,r:TransportResult):void{
 const s=(p as Read).dv360BiddingFileState,d=r.data;
 if(!s||r.status!==200||!obj(d)||!obj(d.algorithm)||!obj(d.files))unverified('Missing verified custom bidding file state.');
}
export function dv360BiddingFilePrerequisites(p:CompiledRequest,states:unknown[]):void{
 const kind=dv360BiddingFileKind(p);if(!kind)return;
 const s=states[0];if(!obj(s)||!obj(s.algorithm)||!obj(s.files))unverified('Missing verified custom bidding file state.');
 const g=s.algorithm as JsonObject;
 if(g.present!==true)fail('STATE_NOT_FOUND','Custom bidding algorithm '+algorithmOf(p)+' is not accessible to advertiser '+advertiserOf(p)+'.',{custom_bidding_algorithm_id:algorithmOf(p)},404);
 if(g.advertiserId!==advertiserOf(p))fail('ACCOUNT_SCOPE_MISMATCH','Custom bidding algorithm '+algorithmOf(p)+' is owned by '+(g.partnerId?'partner '+String(g.partnerId):'another advertiser')+'; only its owner adds files.',{custom_bidding_algorithm_id:algorithmOf(p)},403);
 if(g.customBiddingAlgorithmType!==type(kind))invalid('Custom bidding algorithm '+algorithmOf(p)+' is '+String(g.customBiddingAlgorithmType)+'; '+(kind==='script'?'scripts':'rules')+' need a '+type(kind)+' algorithm.');
 if(g.entityStatus==='ENTITY_STATUS_ARCHIVED')invalid('Custom bidding algorithm '+algorithmOf(p)+' is archived.');
 const taken=Object.values(s.files as JsonObject).find(f=>obj(f)&&f.resourceName===refOf(p));
 if(taken)fail('CONFIGURATION_EXISTS','The uploaded file is already registered as '+(kind==='script'?'script ':'rules ')+String((taken as JsonObject).id)+'.',{id:String((taken as JsonObject).id)});
}
export function dv360BiddingFileImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 const kind=dv360BiddingFileKind(p);if(!kind)return;
 const first=state[0],s:JsonObject=obj(first)?first:{};
 return {provider:'dv360',scope:kind==='script'?'custom_bidding_script':'custom_bidding_rules',operation:'create',algorithm:obj(s.algorithm)?s.algorithm:null,registering:refOf(p),may_affect_serving:false,
  effect:'Registers the uploaded '+(kind==='script'?'script':'rules')+' for the algorithm; DV360 checks it and, once accepted, scores with the newest accepted file. DV360 refuses this for an algorithm a line item uses, so no line item bids differently at once.',
  verification:'Lists the algorithm\'s '+(kind==='script'?'scripts':'rules')+' again and finds the new one with its file reference.',source:'https://developers.google.com/display-video/api/reference/rest/v4/customBiddingAlgorithms'};
}
const createdId=(k:Kind,d:unknown)=>obj(d)?String(k==='script'?d.customBiddingScriptId:d.customBiddingAlgorithmRulesId):'';
export function dv360BiddingFileOutcome(p:CompiledRequest,r:TransportResult):boolean{
 const kind=dv360BiddingFileKind(p)!,d=r.data;
 return r.status===200&&obj(d)&&id(createdId(kind,d))&&String(d.customBiddingAlgorithmId)===algorithmOf(p)&&obj(d[field(kind)])&&(d[field(kind)] as JsonObject).resourceName===refOf(p);
}
export function dv360BiddingFileVerification(p:CompiledRequest,result:JsonObject):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const kind=dv360BiddingFileKind(p)!,created=createdId(kind,result.data);
 if(!id(created))fail('VERIFICATION_UNSUPPORTED','The receipt names no '+(kind==='script'?'script':'rules')+' to verify.');
 return [{read:stateRead(p,{kind,algorithmId:algorithmOf(p)}),expected:{files:{['f'+created]:{id:created,resourceName:refOf(p)}}},id:(kind==='script'?'script ':'rules ')+created}];
}
export function dv360BiddingFileObserved(_read:CompiledRequest,data:JsonObject):JsonObject{return {files:obj(data.files)?data.files:{}};}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const dv360BiddingFileFamily:ReviewedFamily={
 name:'dv360_custom_bidding_files',
 files:['src/dv360-custom-bidding-files.ts',['tests/dv360-custom-bidding-files.test.mjs']],
 kind:dv360BiddingFileKind,
 assert:assertDV360BiddingFile,
 authorize:authorizeDV360BiddingFile,
 snapshots:dv360BiddingFileSnapshots,
 isRead:isDV360BiddingFileRead,
 reader:readDV360BiddingFiles,
 validateState:validateDV360BiddingFileState,
 prerequisites:dv360BiddingFilePrerequisites,
 impact:dv360BiddingFileImpact,
 outcome:dv360BiddingFileOutcome,
 verification:dv360BiddingFileVerification,
 observed:dv360BiddingFileObserved,
 exemptFromSpendTextMatch:true,
};
