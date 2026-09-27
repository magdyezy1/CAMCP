import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {CompiledRequest,Connection,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Creating custom conversions in a Meta ad account, Marketing API v25.0 ("Ad Account Customconversions" reference,
 * Creating; checked 2026-09-27): POST act_{ad_account_id}/customconversions with a required `name` and optional `rule`
 * ("Only count an event as a custom conversion if it fulfills this rule"), `event_source_id` (a pixel, offline event set
 * and so on), `custom_event_type`, `default_conversion_value`, `description`, `advanced_rule` and `action_source_type`;
 * it answers the new ID. Updating and deleting are not available on that edge.
 * AMCP asks for an explicit rule on a pixel of the account, keeps names unique among the account's custom conversions and
 * leaves advanced (multi-source) rules outside the contract.
 */
type Read=CompiledRequest&{metaConversionState?:{name?:string;pixel?:string;id?:string}};
const gateway='meta_native_action',maxPages=5;
const eventTypes=['ADD_PAYMENT_INFO','ADD_TO_CART','ADD_TO_WISHLIST','COMPLETE_REGISTRATION','CONTENT_VIEW','INITIATED_CHECKOUT','LEAD','PURCHASE','SEARCH','CONTACT','CUSTOMIZE_PRODUCT','DONATE','FIND_LOCATION','SCHEDULE','START_TRIAL','SUBMIT_APPLICATION','SUBSCRIBE','LISTING_INTERACTION','FACEBOOK_SELECTED','OTHER'];
const sources=['app','chat','email','other','phone_call','physical_store','system_generated','website','business_messaging'];
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const numeric=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,31}$/.test(v);
const account=(v:unknown)=>String(v??'').replace(/^act_/,'');
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_META_CUSTOM_CONVERSION',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
export function metaConversionKind(p:CompiledRequest):'create'|undefined{
 if(p.gateway!==gateway||p.origin&&p.origin!=='https://graph.facebook.com'||p.specialTransport)return;
 return p.method==='POST'&&/^\/v25\.0\/act_[1-9][0-9]{0,31}\/customconversions$/.test(p.path)?'create':undefined;
}
const body=(p:CompiledRequest):JsonObject=>object(p.body)?p.body:{};
/** The rule as Meta takes it: a JSON object in a string. */
function parsedRule(v:unknown):JsonObject{
 if(typeof v!=='string'||!v.trim()||v.length>4000)invalid('rule is a JSON object in a string of up to 4000 characters, for example {"url":{"i_contains":"thank-you"}}.');
 let r:unknown;try{r=JSON.parse(v as string);}catch{return invalid('rule is not valid JSON.');}
 if(!object(r)||!Object.keys(r).length)invalid('rule is a non-empty JSON object.');
 return r as JsonObject;
}
export function assertMetaConversion(p:CompiledRequest):void{
 if(!metaConversionKind(p))return;
 if(account(p.path.split('/')[2])!==account(p.accountId))fail('ACCOUNT_SCOPE_MISMATCH','The path must use the selected ad account.',{},403);
 if(Object.keys(p.query).length||Object.keys(p.headers).length)invalid('Custom conversion creation takes its fields in the body, without query or header overrides.');
 const b=p.body;if(!object(b))invalid('Send the custom conversion fields.');
 const extra=Object.keys(b).filter(k=>!['name','rule','event_source_id','custom_event_type','default_conversion_value','description','action_source_type'].includes(k));
 if(extra.length)invalid((extra.includes('advanced_rule')?'Advanced multi-source rules are outside this contract. ':'')+'Unqualified fields: '+extra.join(', ')+'.');
 if(typeof b.name!=='string'||!b.name.trim()||b.name!==b.name.trim()||[...b.name].length>100||/[\u0000-\u001f]/.test(b.name))invalid('name has 1–100 characters without surrounding spaces or control characters.');
 if(!numeric(String(b.event_source_id??''))||typeof b.event_source_id!=='string'&&typeof b.event_source_id!=='number')invalid('event_source_id is the ID of a pixel of the ad account.');
 parsedRule(b.rule);
 if(b.custom_event_type!==undefined&&!eventTypes.includes(b.custom_event_type))invalid('custom_event_type is one of '+eventTypes.join(', ')+'.');
 if(b.default_conversion_value!==undefined&&(typeof b.default_conversion_value!=='number'||!Number.isFinite(b.default_conversion_value)||b.default_conversion_value<0||b.default_conversion_value>1e9))invalid('default_conversion_value is a number from 0 in the account currency.');
 if(b.description!==undefined&&(typeof b.description!=='string'||[...b.description].length>1000||/[\u0000-\u0008\u000b-\u001f]/.test(b.description)))invalid('description is text of up to 1000 characters.');
 if(b.action_source_type!==undefined&&!sources.includes(b.action_source_type))invalid('action_source_type is one of '+sources.join(', ')+'.');
}
export function assertMetaConversionScope(c:Connection,write=false):void{
 if(write?!c.scopes.includes('ads_management'):!c.scopes.some(s=>s==='ads_management'||s==='ads_read'))fail('INSUFFICIENT_SCOPE','Reconnect Meta with ads_management to create custom conversions.',{},403);
}
const read=(p:CompiledRequest,path:string,query:JsonObject,state?:Read['metaConversionState']):Read=>({...p,action:'AMCP_META_CONVERSION_READ',method:'GET',path:'/v25.0/act_'+account(p.accountId)+path,query,body:undefined,headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,metaConversionState:state});
const listFields='id,name,custom_event_type,rule,default_conversion_value,description,is_archived,pixel{id}';
export function metaConversionSnapshots(p:CompiledRequest):Read[]{const b=body(p);return [read(p,'/customconversions',{fields:listFields,limit:500},{name:String(b.name),pixel:String(b.event_source_id)})];}
export function isMetaConversionRead(p:CompiledRequest):p is Read{return p.gateway===gateway&&!!(p as Read).metaConversionState;}
const view=(c:JsonObject)=>({id:String(c.id),name:c.name??null,custom_event_type:c.custom_event_type??null,rule:typeof c.rule==='string'?(()=>{try{return stable(JSON.parse(c.rule as string));}catch{return c.rule;}})():null,default_conversion_value:c.default_conversion_value===undefined?null:Number(c.default_conversion_value),description:c.description??null,pixel:object(c.pixel)?String(c.pixel.id):null,archived:c.is_archived===true});
/** Every custom conversion of the account in bounded pages, and the account's pixels for a creation. */
export async function readMetaConversions(p:CompiledRequest,fetch:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 const s=(p as Read).metaConversionState;if(!s)return fetch(p);
 const all=async(first:Read,label:string)=>{
  const rows:JsonObject[]=[];let q:Read=first;
  for(let page=0;;page++){
   if(page>=maxPages)unverified('The ad account has more '+label+' than one review reads.');
   const r=await fetch(q),d=r.data;if(r.status!==200||!object(d)||!Array.isArray(d.data))unverified('Meta did not list the '+label+'.');
   for(const row of d.data as unknown[])if(object(row))rows.push(row);
   const after=object(d.paging)&&object(d.paging.cursors)?d.paging.cursors.after:undefined;
   if(!(object(d.paging)&&d.paging.next)||typeof after!=='string')return rows;
   q={...q,query:{...q.query,after}};
  }
 };
 const conversions=(await all({...(p as Read),metaConversionState:undefined} as Read,'custom conversions')).map(view);
 const out:JsonObject={account_id:account(p.accountId),conversions:Object.fromEntries(conversions.map(c=>['c'+c.id,c]))};
 if(s.pixel){const pixels=await all(read(p,'/adspixels',{fields:'id,name',limit:100}),'pixels');out.pixels=pixels.map(x=>String(x.id)).sort();}
 return {status:200,headers:{},data:out};
}
export function validateMetaConversionState(p:CompiledRequest,r:TransportResult):void{
 const s=(p as Read).metaConversionState,d=r.data;
 if(!s||r.status!==200||!object(d)||!object(d.conversions)||!!s.pixel!==Array.isArray(d.pixels))unverified('Missing verified custom conversion state.');
}
export function metaConversionPrerequisites(p:CompiledRequest,states:unknown[]):void{
 if(!metaConversionKind(p))return;
 const s=states[0];if(!object(s)||!object(s.conversions)||!Array.isArray(s.pixels))unverified('Missing verified custom conversion state.');
 const b=body(p);
 if(!(s.pixels as string[]).includes(String(b.event_source_id)))fail('STATE_NOT_FOUND','Pixel '+String(b.event_source_id)+' is not a pixel of the selected ad account.',{event_source_id:String(b.event_source_id)});
 const same=Object.values(s.conversions).find(c=>object(c)&&c.archived!==true&&String(c.name).toLowerCase()===String(b.name).toLowerCase());
 if(object(same))fail('CONFIGURATION_EXISTS','The ad account already has a custom conversion named "'+String(same.name)+'" ('+String(same.id)+').',{custom_conversion_id:String(same.id)});
}
export function metaConversionImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 if(!metaConversionKind(p))return;
 const first=state[0],s:JsonObject=object(first)?first:{},b=body(p);
 return {provider:'meta',scope:'custom_conversion',operation:'create',creating:{...b,rule:parsedRule(b.rule)},existing:object(s.conversions)?Object.keys(s.conversions).length:null,may_affect_serving:false,
  effect:'Creates a custom conversion on pixel '+String(b.event_source_id)+'; ad sets optimize for it and reports count it only once they name it. Meta does not offer updates or deletion on this edge.',
  verification:'Lists the custom conversions again and compares the new one.',source:'https://developers.facebook.com/docs/marketing-api/reference/ad-account/customconversions/'};
}
export function metaConversionOutcome(_p:CompiledRequest,r:TransportResult):boolean{return r.status===200&&object(r.data)&&numeric(String(r.data.id??''));}
export function metaConversionVerification(p:CompiledRequest,result:JsonObject):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const id=String(result.data?.id??''),b=body(p);if(!numeric(id))fail('VERIFICATION_UNSUPPORTED','The receipt names no custom conversion to verify.');
 const expected:JsonObject={id,name:b.name,rule:stable(parsedRule(b.rule)),pixel:String(b.event_source_id),archived:false,...(b.custom_event_type!==undefined?{custom_event_type:b.custom_event_type}:{}),...(b.default_conversion_value!==undefined?{default_conversion_value:b.default_conversion_value}:{}),...(b.description!==undefined?{description:b.description}:{})};
 return [{read:read(p,'/customconversions',{fields:listFields,limit:500},{id}),expected:{conversion:expected},id:'custom conversion '+id}];
}
export function metaConversionObserved(read:CompiledRequest,data:JsonObject):JsonObject{
 const id=(read as Read).metaConversionState?.id,c=object(data.conversions)&&id?data.conversions['c'+id]:undefined;
 return {conversion:object(c)?c:{present:false}};
}
