import {MirrorError} from './errors.js';
import type {CompiledRequest,JsonObject} from './types.js';

/**
 * Snapchat audience segment metadata, per the official Audiences guides (customer lists, lookalikes, website
 * events) checked 2026-09-26: create customer-list containers and lookalikes, and rename or change retention of
 * existing segments. Segments start no delivery and spend nothing. Adding or removing users processes customer
 * data and stays unqualified. Pixel, mobile and engagement rule audiences stay unqualified until their read-back
 * shape is evidenced; engagement segments are documented as read-only for creation.
 */
const retentionMax:Record<string,number>={FIRST_PARTY:9999,LOOKALIKE:180,PIXEL:395};
const createKeys:Record<string,string[]>={FIRST_PARTY:['ad_account_id','name','description','source_type','retention_in_days'],LOOKALIKE:['ad_account_id','name','description','source_type','retention_in_days','creation_spec']};
const lookalikeTypes=['BALANCE','SIMILARITY','REACH'];
const obj=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const snapId=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9-]{1,64}$/.test(v);
const country=(v:unknown)=>typeof v==='string'&&/^[A-Za-z]{2}$/.test(v);
const pick=(o:JsonObject,keys:string[])=>Object.fromEntries(keys.filter(k=>o[k]!==undefined).map(k=>[k,o[k]]));

export const snapSegmentKind=(p:CompiledRequest)=>p.gateway==='snapchat_native_action'&&['POST','PUT'].includes(p.method)&&/^\/v1\/adaccounts\/[^/]+\/segments$/.test(p.path);

function invalid(index:number,field:string,message:string):never{
 throw new MirrorError('INVALID_SNAPCHAT_SEGMENT',message,{record:index,field});
}
function only(v:JsonObject,keys:string[],index:number,path:string){
 const extra=Object.keys(v).find(k=>!keys.includes(k));
 if(extra)invalid(index,path+extra,'"'+path+extra+'" is outside the qualified segment contract.');
}
function name(v:unknown,index:number){
 if(typeof v!=='string'||!v.trim())invalid(index,'name','name must be nonempty text.');
 if([...v].length>375)invalid(index,'name','name has a documented maximum of 375 characters.');
}
function description(v:unknown,index:number){if(v!==undefined&&typeof v!=='string')invalid(index,'description','description must be text.');}
function retention(v:unknown,type:string,index:number){
 const max=retentionMax[type]!;
 if(!Number.isSafeInteger(v)||(v as number)<1||(v as number)>max)invalid(index,'retention_in_days',type+' segments retain members for 1 to '+max+' days.');
}
const account=(plan:CompiledRequest)=>/^\/v1\/adaccounts\/([^/]+)\//.exec(plan.path)?.[1];

/** Validates every new segment before review; nothing here reads or contacts Snapchat. */
export function assertSnapSegments(plan:CompiledRequest,rows:unknown[]):void{
 rows.forEach((row,index)=>{
  if(!obj(row))invalid(index,'','Each segment must be an object.');
  const type=String(row.source_type);
  if(!createKeys[type])invalid(index,'source_type',type==='ENGAGEMENT'?'Snapchat documents ENGAGEMENT segments as read-only for creation.':'Qualified source_type values are FIRST_PARTY and LOOKALIKE. Pixel, mobile and engagement rule audiences need their own contract.');
  only(row,createKeys[type]!,index,'');
  if(row.ad_account_id!==account(plan))invalid(index,'ad_account_id','ad_account_id is required and must equal the selected ad account.');
  name(row.name,index);description(row.description,index);retention(row.retention_in_days,type,index);
  if(type!=='LOOKALIKE')return;
  const spec=row.creation_spec;
  if(!obj(spec))invalid(index,'creation_spec','A LOOKALIKE segment needs creation_spec.');
  only(spec,['seed_segment_id','type','countries','country'],index,'creation_spec/');
  if(!snapId(spec.seed_segment_id))invalid(index,'creation_spec/seed_segment_id','seed_segment_id must be a Snapchat segment ID.');
  if(spec.type!==undefined&&!lookalikeTypes.includes(spec.type))invalid(index,'creation_spec/type','type must be one of '+lookalikeTypes.join(', ')+'.');
  const list=spec.countries;
  if(list!==undefined&&(!Array.isArray(list)||!list.length||!list.every(country)||new Set(list.map(c=>c.toUpperCase())).size!==list.length))invalid(index,'creation_spec/countries','countries must list unique two-letter country codes.');
  if(spec.country!==undefined&&!country(spec.country))invalid(index,'creation_spec/country','country must be a two-letter country code.');
  if(list===undefined&&spec.country===undefined)invalid(index,'creation_spec/countries','A lookalike needs countries (or the deprecated country).');
  if(Array.isArray(list)&&spec.country!==undefined&&!list.some(c=>c.toUpperCase()===spec.country.toUpperCase()))invalid(index,'creation_spec/country','country must be one of countries when both are sent.');
 });
}

/** Stateless checks for PUT /v1/adaccounts/{id}/segments; retention limits need the current source type. */
export function assertSnapSegmentUpdates(plan:CompiledRequest,rows:unknown[]):void{
 rows.forEach((row,index)=>{
  if(!obj(row))invalid(index,'','Each segment update must be an object.');
  only(row,['id','ad_account_id','name','description','retention_in_days'],index,'');
  if(!snapId(row.id))invalid(index,'id','Each update needs the exact segment id.');
  if(row.ad_account_id!==undefined&&row.ad_account_id!==account(plan))invalid(index,'ad_account_id','ad_account_id must equal the selected ad account.');
  name(row.name,index);description(row.description,index);
  if(!Number.isSafeInteger(row.retention_in_days))invalid(index,'retention_in_days','retention_in_days is required on every update.');
 });
}

/** Seeds are read before review and again before execution; each read requires existing ownership. */
export function snapSegmentDependencyPaths(plan:CompiledRequest):string[]{
 if(plan.gateway!=='snapchat_native_action'||plan.method!=='POST'||!/\/segments$/.test(plan.path))return [];
 const rows=obj(plan.body)&&Array.isArray(plan.body.segments)?plan.body.segments:[];
 return [...new Set<string>(rows.map((r:JsonObject)=>r?.creation_spec?.seed_segment_id).filter(snapId).map((id:string)=>'/v1/segments/'+id))];
}

const current=(state:unknown[],id:string)=>state.flatMap(s=>obj(s)&&Array.isArray(s.segments)?s.segments:[]).map((r:JsonObject)=>r?.segment).find((r:JsonObject)=>r?.id===id);

/**
 * Snapchat documents name and retention as required on update and description as optional; like other
 * Snapchat PUTs an omitted field may reset, so an existing description must be restated or replaced.
 */
export function snapSegmentImpact(plan:CompiledRequest,state:unknown[]):JsonObject{
 const rows=(plan.body as JsonObject).segments as JsonObject[],changes:JsonObject[]=[];
 rows.forEach((row,index)=>{
  const before=current(state,row.id);
  if(!obj(before)||before.ad_account_id!==plan.accountId)throw new MirrorError('STATE_TARGET_MISMATCH','A segment update requires the segment to belong to the selected ad account.',{segment_id:row.id});
  const type=String(before.source_type);
  if(!retentionMax[type])invalid(index,'retention_in_days','Retention limits for '+type+' segments are not documented; this contract updates FIRST_PARTY, LOOKALIKE and PIXEL segments.');
  retention(row.retention_in_days,type,index);
  if(typeof before.description==='string'&&before.description&&row.description===undefined)throw new MirrorError('INCOMPLETE_SNAPCHAT_SEGMENT_UPDATE','Restate the current description or send its replacement; Snapchat PUT can reset omitted fields.',{record:index,field:'description'});
  changes.push({segment_id:row.id,source_type:type,retention_before:before.retention_in_days??null,retention_after:row.retention_in_days});
 });
 return {provider:'snapchat',effect:'Renames or changes retention of existing audience segments. Ad squads targeting a segment use the changed audience; a shorter retention drops members outside the new window.',segments:changes,may_affect_serving:changes.some(c=>c.retention_before!==c.retention_after),source:'https://developers.snap.com/marketing-api/Ads-API/audience-creation/customer-lists'};
}

/** Audience size and processing status change without any edit; they are not review evidence for this contract. */
export function snapSegmentState(row:unknown):unknown{
 if(!obj(row))return row;
 const {approximate_number_users,targetable_status,upload_status,status,...configuration}=row;
 return configuration;
}

/** Segment configuration AMCP sent, as Snapchat reads it back: countries sorted, provider status fields dropped. */
export function snapSegmentProjection(row:unknown):unknown{
 if(!obj(row))return row;
 const out=pick(row,['id','ad_account_id','name','description','source_type','retention_in_days']),spec=row.creation_spec;
 if(obj(spec)){
  const countries=Array.isArray(spec.countries)?spec.countries:typeof spec.country==='string'?[spec.country]:undefined;
  out.creation_spec={...pick(spec,['seed_segment_id','type']),...(countries?{countries:countries.map(c=>String(c).toUpperCase()).sort()}:{})};
 }
 return out;
}
