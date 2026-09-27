import {MirrorError} from './errors.js';
import type {CompiledRequest,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Custom audiences of an X Ads account, Ads API v12 (Audiences reference, "Custom Audiences"; docs.x.com copy read on
 * 2026-09-27). POST creates a placeholder audience from a name ("Unique name value must be used") and an optional
 * description, PUT changes either, DELETE deletes the audience. Users are added separately (customer data, outside this
 * contract). GET .../:custom_audience_id/targeted lists "active or all line items and campaigns that target" the audience;
 * AMCP refuses to delete an audience that any line item still targets. X states no length limits: AMCP keeps names to 255
 * characters (the length name search accepts) and descriptions to 1000.
 */
type Kind='create'|'update'|'delete';
type State={audienceId?:string;names?:string[];targeted?:boolean;optional?:boolean};
type Read=CompiledRequest&{xAudienceState?:State};
const gateway='x_ads_native_action',nativeId=/^[a-z0-9]{1,32}$/;
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_X_CUSTOM_AUDIENCE',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
export function xAudienceKind(p:CompiledRequest):Kind|undefined{
 if(p.gateway!==gateway||p.specialTransport)return;
 if(p.method==='POST'&&/^\/12\/accounts\/[a-z0-9]{1,32}\/custom_audiences$/.test(p.path))return 'create';
 if(['PUT','DELETE'].includes(p.method)&&/^\/12\/accounts\/[a-z0-9]{1,32}\/custom_audiences\/[a-z0-9]{1,32}$/.test(p.path))return p.method==='PUT'?'update':'delete';
 return;
}
const account=(p:CompiledRequest)=>p.path.split('/')[3]!,audienceOf=(p:CompiledRequest)=>p.path.split('/')[5]!;
const body=(p:CompiledRequest):JsonObject=>object(p.body)?p.body:{};
const fold=(v:unknown)=>String(v).toLocaleLowerCase('en-US');
export function assertXAudience(p:CompiledRequest):void{
 const kind=xAudienceKind(p);if(!kind)return;
 if(account(p)!==p.accountId)fail('ACCOUNT_SCOPE_MISMATCH','The request must use the selected account.',{},403);
 if(Object.keys(p.query).length||Object.keys(p.headers??{}).length)invalid('Custom audience writes take their parameters in the body, without query or header overrides.');
 if(kind==='delete'){if(p.body!==undefined&&!(object(p.body)&&!Object.keys(p.body).length))invalid('A deletion takes no body.');return;}
 const b=p.body;if(!object(b))invalid('Provide the native custom audience parameters.');
 const extra=Object.keys(b).filter(k=>!['name','description'].includes(k));
 if(extra.length)invalid((extra.some(k=>['users','user_identifier','audience_type','permission_level'].includes(k))?'Users, types and sharing are outside this contract. ':'')+'Unqualified fields: '+extra.join(', ')+'.');
 if(kind==='create'&&b.name===undefined)invalid('A custom audience needs a name.');
 if(kind==='update'&&b.name===undefined&&b.description===undefined)invalid('Send name, description or both.');
 if(b.name!==undefined&&(typeof b.name!=='string'||!b.name.trim()||b.name!==b.name.trim()||[...b.name].length>255||/[\u0000-\u001f\u007f]/.test(b.name)))invalid('name has 1–255 characters without surrounding spaces or control characters.');
 if(b.description!==undefined&&(typeof b.description!=='string'||[...b.description].length>1000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(b.description)))invalid('description has at most 1000 characters without control characters.');
}
function read(p:CompiledRequest,path:string,query:JsonObject={}):Read{return {...p,action:'AMCP_X_CUSTOM_AUDIENCE_READ',method:'GET',path:'/12/accounts/'+account(p)+path,query,body:undefined,headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,xAudienceState:undefined};}
const stateRead=(p:CompiledRequest,state:State):Read=>({...read(p,''),xAudienceState:state});
/** One marked read of the account; the reader adds the audience, same-name audiences and, for deletions, what targets it. */
export function xAudienceSnapshots(p:CompiledRequest):Read[]{
 const kind=xAudienceKind(p)!,name=body(p).name;
 return [stateRead(p,{...(kind!=='create'?{audienceId:audienceOf(p)}:{}),...(typeof name==='string'?{names:[name]}:{}),...(kind==='delete'?{targeted:true}:{})})];
}
export function isXAudienceRead(p:CompiledRequest):p is Read{return p.gateway===gateway&&!!(p as Read).xAudienceState;}
const notFound=(e:unknown)=>e instanceof MirrorError&&e.code==='UPSTREAM_ERROR'&&e.status===404;
const view=(a:JsonObject,accountId:string)=>({present:true,id:String(a.id),name:a.name??null,description:a.description??null,type:a.audience_type??null,size:a.audience_size??null,targetable:a.targetable??null,owned:a.is_owner===true||a.owner_account_id===accountId,permission:a.permission_level??null,deleted:a.deleted===true,gone:a.deleted===true});
export async function readXAudience(p:CompiledRequest,send:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 const s=(p as Read).xAudienceState;if(!s)return send(p);
 let requests=0;
 const get=async(q:Read)=>{if(++requests>16)unverified('Custom audience reads exceeded their bound.');const r=await send(q),d=r.data;if(r.status!==200||!object(d)||Array.isArray(d.errors)&&d.errors.length)unverified('X returned a failed or unrecognized read.');return d as JsonObject;};
 const acct=await get(read(p,''));if(!object(acct.data)||String(acct.data.id)!==account(p))unverified('X returned another account.');
 const out:JsonObject={accountId:account(p)};
 if(s.audienceId){
  let a:unknown;
  try{a=(await get(read(p,'/custom_audiences/'+s.audienceId,{with_deleted:true}))).data;}
  catch(e){if(!notFound(e))throw e;if(!s.optional)fail('STATE_NOT_FOUND','Custom audience '+s.audienceId+' is not an audience of the selected account.',{custom_audience_id:s.audienceId},404);a=null;}
  if(a===null)out.audience={present:false,id:s.audienceId,gone:true};
  else{if(!object(a)||String(a.id)!==s.audienceId)fail('STATE_TARGET_MISMATCH','X returned another audience for '+s.audienceId+'.',{custom_audience_id:s.audienceId},409);out.audience=view(a,account(p));}
 }
 if(s.names){
  const same:JsonObject[]=[];
  for(const name of s.names){
   let cursor:string|undefined;
   for(let page=0;;page++){
    if(page>=3)unverified('Too many audiences start with the name "'+name+'" to check it.');
    const listed=await get(read(p,'/custom_audiences',{q:name,count:1000,...(cursor?{cursor}:{})}));
    if(!Array.isArray(listed.data))unverified('X did not list the custom audiences.');
    for(const row of listed.data as unknown[]){if(!object(row)||!nativeId.test(String(row.id)))unverified('A custom audience row is malformed.');if(row.deleted!==true&&fold(row.name)===fold(name))same.push({id:String(row.id),name:row.name??null});}
    if(!listed.next_cursor)break;if(typeof listed.next_cursor!=='string'||listed.next_cursor===cursor)unverified('Custom audience pagination is repeated or malformed.');cursor=listed.next_cursor;
   }
  }
  out.sameName=same;
 }
 if(s.targeted){
  const lines:string[]=[];let cursor:string|undefined;
  for(let page=0;;page++){
   if(page>=5)unverified('Too many line items target the audience to list them.');
   const listed=await get(read(p,'/custom_audiences/'+s.audienceId+'/targeted',{with_active:false,...(cursor?{cursor}:{})}));
   if(!Array.isArray(listed.data))unverified('X did not list what targets the audience.');
   for(const row of listed.data as unknown[]){
    if(!object(row))unverified('A targeted row is malformed.');
    const items=Array.isArray(row.line_items)?row.line_items:[];
    for(const item of items as unknown[])lines.push(object(item)?String(item.id??item.line_item_id):String(item));
   }
   if(!listed.next_cursor)break;if(typeof listed.next_cursor!=='string'||listed.next_cursor===cursor)unverified('Targeted pagination is repeated or malformed.');cursor=listed.next_cursor;
  }
  out.targetedBy=[...new Set(lines)].sort();
 }
 return {status:200,headers:{},data:out};
}
export function validateXAudienceState(p:CompiledRequest,r:TransportResult):void{
 const s=(p as Read).xAudienceState,d=r.data;
 if(!s||r.status!==200||!object(d)||!!s.audienceId!==object(d.audience)||!!s.names!==Array.isArray(d.sameName)||!!s.targeted!==Array.isArray(d.targetedBy))unverified('Missing verified custom audience state.');
}
export function xAudiencePrerequisites(p:CompiledRequest,states:unknown[]):void{
 const kind=xAudienceKind(p);if(!kind)return;
 const s=states[0];if(!object(s))unverified('Missing verified custom audience state.');
 const b=body(p);
 if(kind!=='create'){
  const a=s.audience;if(!object(a)||a.present!==true)unverified('Missing verified custom audience state.');
  if(a.deleted===true)invalid('Custom audience '+audienceOf(p)+' is deleted.');
  if(a.owned!==true||a.permission!==null&&a.permission!=='READ_WRITE')fail('ACCOUNT_SCOPE_MISMATCH','Custom audience '+audienceOf(p)+' is shared with this account; only its owner changes it.',{custom_audience_id:audienceOf(p)},403);
  if(kind==='delete'){
   const lines=Array.isArray(s.targetedBy)?s.targetedBy as string[]:undefined;if(!lines)unverified('Missing verified audience targeting.');
   if(lines.length)fail('AUDIENCE_IN_USE','Custom audience '+audienceOf(p)+' is targeted by line items '+lines.join(', ')+'; remove it from their targeting first.',{line_items:lines},409);
   return;
  }
  if((b.name===undefined||b.name===a.name)&&(b.description===undefined||b.description===(a.description??'')||b.description===a.description))invalid('Custom audience '+audienceOf(p)+' already has these values.');
 }
 if(typeof b.name==='string'){
  const same=(Array.isArray(s.sameName)?s.sameName as JsonObject[]:[]).find(x=>x.id!==(kind==='update'?audienceOf(p):undefined));
  if(same)fail('CONFIGURATION_EXISTS','The account already has a custom audience named "'+String(same.name)+'" ('+String(same.id)+').',{custom_audience_id:String(same.id)});
 }
}
export function xAudienceImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 const kind=xAudienceKind(p);if(!kind)return;
 const first=state[0],s:JsonObject=object(first)?first:{},a=object(s.audience)?s.audience:null;
 return {provider:'x',scope:'custom_audience',operation:kind,before:a,after:kind==='delete'?null:body(p),targeted_by_line_items:Array.isArray(s.targetedBy)?s.targetedBy:null,may_affect_serving:false,
  effect:kind==='create'?'Creates an empty placeholder audience; users are added separately and nothing targets it yet.':kind==='update'?'Renames or redescribes the audience; its users and targeting do not change.':'Deletes the audience; no line item targets it.',
  verification:kind==='delete'?'Reads the audience again and expects it to be deleted or gone.':'Reads the audience again and compares its name and description.',
  source:'https://docs.x.com/x-ads-api/audiences/reference'};
}
export function xAudienceOutcome(p:CompiledRequest,r:TransportResult):boolean{
 const kind=xAudienceKind(p)!,d=r.data,t=object(d)&&object(d.data)?d.data:undefined,b=body(p);
 if(![200,201].includes(r.status)||!t||!nativeId.test(String(t.id))||Array.isArray((d as JsonObject).errors)&&(d as JsonObject).errors.length)return false;
 if(kind==='delete')return String(t.id)===audienceOf(p)&&t.deleted===true;
 if(kind==='update'&&String(t.id)!==audienceOf(p))return false;
 if(kind==='create'&&t.is_owner===false)return false;
 return t.deleted!==true&&(b.name===undefined||t.name===b.name)&&(b.description===undefined||(t.description??'')===b.description);
}
export function xAudienceVerification(p:CompiledRequest,result:JsonObject):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const kind=xAudienceKind(p)!,id=kind==='create'?String(result.data?.data?.id??''):audienceOf(p),b=body(p);
 if(!nativeId.test(id))fail('VERIFICATION_UNSUPPORTED','The receipt names no custom audience to verify.');
 const expected:JsonObject=kind==='delete'?{gone:true}:{gone:false,...(b.name!==undefined?{name:b.name}:{}),...(b.description!==undefined?{description:b.description}:{})};
 return [{read:stateRead(p,{audienceId:id,optional:true}),expected:{audience:expected},id:'custom audience '+id}];
}
export function xAudienceObserved(_read:CompiledRequest,data:JsonObject):JsonObject{
 const a=object(data.audience)?data.audience:null;
 return {audience:a&&a.present===true?{...a,description:a.description??''}:a};
}
