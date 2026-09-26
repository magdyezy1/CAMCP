import {MirrorError} from './errors.js';
import type {CompiledRequest,JsonObject} from './types.js';

/**
 * Meta native copies, per the Marketing API reference for Ad Campaign Group, Ad Campaign and Adgroup /copies
 * (checked 2026-09-26). Copies are always created PAUSED in the source's ad account. Campaign copies are shallow;
 * an ad set copy may include its ads within the documented synchronous limit of three. Parameter and creative
 * overrides, deep campaign copies and asynchronous batch copies stay outside this contract. Budgets a copy
 * duplicates are checked against the owner spending policy as new budgets.
 */
export type MetaCopyKind='campaign'|'adset'|'ad';
const kinds:Record<string,MetaCopyKind>={meta_campaign_id_copies_copy:'campaign',meta_ad_set_id_copies_copy:'adset',meta_ad_id_copies_copy:'ad'};
const allowed:Record<MetaCopyKind,string[]>={campaign:['deep_copy','status_option','rename_options'],adset:['campaign_id','deep_copy','status_option','rename_options','start_time','end_time'],ad:['adset_id','status_option','rename_options']};
// Fields that exist only on the node type the action names, so a mismatched source ID fails the read at Meta.
const sourceFields:Record<MetaCopyKind,string>={campaign:'id,account_id,name,status,objective,daily_budget,lifetime_budget',adset:'id,account_id,campaign_id,name,status,optimization_goal,daily_budget,lifetime_budget',ad:'id,account_id,campaign_id,adset_id,name,status'};
const targetFields:Record<string,string>={adset:'id,account_id,name,status,objective',ad:'id,account_id,campaign_id,name,status,optimization_goal'};
export const metaCopyChildLimit=3;
const numeric=(v:unknown)=>typeof v==='string'&&/^\d{1,32}$/.test(v);
const obj=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const version=(p:CompiledRequest)=>p.path.split('/')[1]!;
const sourceId=(p:CompiledRequest)=>p.path.split('/')[2]!;
const account=(v:unknown)=>String(v).replace(/^act_/,'');

export const metaCopyKind=(p:CompiledRequest):MetaCopyKind|undefined=>p.gateway==='meta_native_action'&&p.method==='POST'&&/^\/v[^/]+\/\d+\/copies$/.test(p.path)?kinds[p.action]:undefined;

function invalid(field:string,message:string):never{
 throw new MirrorError('INVALID_META_COPY',message,{field});
}

/** Validates the request before review; nothing here reads or contacts Meta. */
export function assertMetaCopy(plan:CompiledRequest,body:JsonObject):void{
 const kind=metaCopyKind(plan)!;
 const extra=Object.keys(body).find(k=>!allowed[kind].includes(k));
 if(extra)invalid(extra,'"'+extra+'" is outside the qualified '+kind+' copy contract.');
 if(body.status_option!=='PAUSED')invalid('status_option','Copies must be created with status_option PAUSED.');
 if(body.deep_copy!==undefined&&typeof body.deep_copy!=='boolean')invalid('deep_copy','deep_copy must be true or false.');
 if(kind==='campaign'&&body.deep_copy===true)invalid('deep_copy','Deep campaign copies are not qualified; copy the campaign, then its ad sets.');
 const target=kind==='adset'?'campaign_id':kind==='ad'?'adset_id':undefined;
 if(target&&body[target]!==undefined&&!numeric(body[target]))invalid(target,target+' must be a numeric Meta ID.');
 for(const field of ['start_time','end_time'])if(body[field]!==undefined&&(!Number.isSafeInteger(body[field])||body[field]<0))invalid(field,field+' must be a UTC UNIX timestamp in seconds.');
 if(body.end_time>0&&body.start_time!==undefined&&body.end_time<=body.start_time)invalid('end_time','end_time must be after start_time (or 0 for no end).');
 const rename=body.rename_options;
 if(rename!==undefined){
  if(!obj(rename))invalid('rename_options','rename_options must be an object.');
  const bad=Object.keys(rename).find(k=>!['rename_strategy','rename_prefix','rename_suffix'].includes(k));
  if(bad)invalid('rename_options/'+bad,'"rename_options/'+bad+'" is outside the documented rename options.');
  if(rename.rename_strategy!==undefined&&!['DEEP_RENAME','ONLY_TOP_LEVEL_RENAME','NO_RENAME'].includes(rename.rename_strategy))invalid('rename_options/rename_strategy','rename_strategy must be DEEP_RENAME, ONLY_TOP_LEVEL_RENAME or NO_RENAME.');
  for(const k of ['rename_prefix','rename_suffix'])if(rename[k]!==undefined&&(typeof rename[k]!=='string'||[...rename[k]].length>100))invalid('rename_options/'+k,k+' must be text of at most 100 characters.');
 }
}

/** Reads in a fixed order: source, then the target parent, then (ad set deep copy) the source's ads. */
export function metaCopySnapshots(plan:CompiledRequest):{path:string;query:JsonObject}[]{
 const kind=metaCopyKind(plan)!,body=plan.body as JsonObject,v='/'+version(plan)+'/',reads:{path:string;query:JsonObject}[]=[{path:v+sourceId(plan),query:{fields:sourceFields[kind]}}];
 const target=kind==='adset'?body.campaign_id:kind==='ad'?body.adset_id:undefined;
 if(typeof target==='string')reads.push({path:v+target,query:{fields:targetFields[kind]!}});
 if(kind==='adset'&&body.deep_copy===true)reads.push({path:v+sourceId(plan)+'/ads',query:{fields:'id,adset_id',limit:100}});
 return reads;
}
/** The source ad set's ads list is the only collection read; it must be one complete page of exact ads. */
export const metaCopyChildrenRead=(read:CompiledRequest)=>read.gateway==='meta_native_action'&&/^\/v[^/]+\/\d+\/ads$/.test(read.path)&&read.query.fields==='id,adset_id';

function layout(plan:CompiledRequest,state:unknown[]){
 const kind=metaCopyKind(plan)!,body=plan.body as JsonObject,hasTarget=typeof (kind==='adset'?body.campaign_id:kind==='ad'?body.adset_id:undefined)==='string';
 const at=(i:number)=>obj(state[i])?state[i] as JsonObject:undefined;
 return {kind,source:at(0),target:hasTarget?at(1):undefined,children:kind==='adset'&&body.deep_copy===true?(at(hasTarget?2:1)?.data as JsonObject[]|undefined):undefined};
}
const budgetFields=['daily_budget','lifetime_budget'];
const budgetAmounts=(row:JsonObject|undefined,path:string)=>budgetFields.filter(k=>row?.[k]!==undefined&&row[k]!==null&&String(row[k])!=='0').map(k=>{
 const text=String(row![k]);if(!/^\d{1,18}$/.test(text))throw new MirrorError('POLICY_BASELINE_REQUIRED','The source budget is not a finite native amount.',{field:path+'/'+k},409);
 return {path:path+'/'+k,key:k,amount:Number(text),decimal:text};
});

/** Owner spending policy sees every budget the copy duplicates as a newly created budget. */
export function metaCopyPolicyAmounts(plan:CompiledRequest,before:unknown){
 if(!metaCopyKind(plan))return;
 const {kind,source}=layout(plan,Array.isArray(before)?before:[]);
 return {creating:true,amounts:kind==='ad'?[]:budgetAmounts(source,'/copied_'+kind+'/'+sourceId(plan)),old:[]};
}

/** Account, type and size checks against the fresh reads, at review and again at execution. */
export function metaCopyImpact(plan:CompiledRequest,state:unknown[]):JsonObject{
 const {kind,source,target,children}=layout(plan,state),selected=account(plan.accountId);
 if(!source||String(source.id)!==sourceId(plan)||account(source.account_id)!==selected)throw new MirrorError('STATE_TARGET_MISMATCH','The copy source must belong to the selected ad account.',{source_id:sourceId(plan)});
 if(target&&account(target.account_id)!==selected)throw new MirrorError('STATE_TARGET_MISMATCH','The copy target must belong to the selected ad account.',{target_id:target.id});
 if(children){
  if(children.some(c=>!numeric(c?.id)||String(c.adset_id)!==sourceId(plan)))throw new MirrorError('STATE_TARGET_MISMATCH','The source ad list must contain only this ad set\'s ads.',{source_id:sourceId(plan)});
  if(children.length>metaCopyChildLimit)throw new MirrorError('META_COPY_TOO_LARGE','Meta copies at most '+metaCopyChildLimit+' child ads synchronously; this ad set has '+children.length+'. Copy the ad set without ads, then copy the ads.',{children:children.length,limit:metaCopyChildLimit});
 }
 const parent=kind==='adset'?{campaign_id:target?String(target.id):String(source.campaign_id)}:kind==='ad'?{adset_id:target?String(target.id):String(source.adset_id)}:{};
 return {provider:'meta',effect:'Creates a paused copy of an existing '+(kind==='adset'?'ad set':kind)+(children?.length?' and its '+children.length+' ads':'')+'. Nothing is delivered until the copies are activated separately.',source:{id:sourceId(plan),name:source.name??null,type:kind},...parent,copies_expected:1+(children?.length??0),budgets_copied:budgetAmounts(source,'').map(b=>({field:b.key,amount:b.decimal})),may_activate:false,source_docs:'https://developers.facebook.com/docs/marketing-api/reference/'+(kind==='campaign'?'ad-campaign-group':kind==='adset'?'ad-campaign':'adgroup')+'/copies/'};
}

/** Every returned ID is numeric; the top-level key names the copied type. */
export function metaCopyOutcome(plan:CompiledRequest,d:JsonObject):boolean{
 const kind=metaCopyKind(plan)!;
 if(!numeric(d['copied_'+kind+'_id']))return false;
 if(d.ad_object_ids===undefined)return kind==='ad';
 return Array.isArray(d.ad_object_ids)&&d.ad_object_ids.every((o:JsonObject)=>obj(o)&&typeof o.ad_object_type==='string'&&numeric(o.source_id)&&numeric(o.copied_id));
}

/** Copied delivery objects this login may read and verify: the top-level copy and any copied ads. */
export function metaCopiedIds(plan:CompiledRequest,d:JsonObject):string[]{
 const kind=metaCopyKind(plan);if(!kind||!metaCopyOutcome(plan,d))return [];
 const ids=[String(d['copied_'+kind+'_id'])];
 for(const o of Array.isArray(d.ad_object_ids)?d.ad_object_ids:[])if(['campaign','ad_set','ad'].includes(o.ad_object_type))ids.push(String(o.copied_id));
 return [...new Set(ids)];
}

/**
 * Reads every copied delivery object and expects the selected account, PAUSED and the right parent. An ad set
 * copy that returns fewer copied ads than the source had is incomplete, not verified.
 */
export function metaCopyVerification(plan:CompiledRequest,result:JsonObject,before:unknown[]):{path:string;query:JsonObject;expected:JsonObject;id:string}[]{
 const kind=metaCopyKind(plan)!,d=obj(result.data)?result.data:{},v='/'+version(plan)+'/';
 if(!metaCopyOutcome(plan,d))return [];
 const {source,target,children}=layout(plan,before),top=String(d['copied_'+kind+'_id']),selected=account(plan.accountId);
 const parent:JsonObject=kind==='adset'?{campaign_id:target?String(target.id):String(source?.campaign_id)}:kind==='ad'?{adset_id:target?String(target.id):String(source?.adset_id)}:{};
 const items:{path:string;query:JsonObject;expected:JsonObject;id:string}[]=[{path:v+top,query:{fields:['id','account_id','status',...Object.keys(parent)].join(',')},expected:{id:top,account_id:selected,status:'PAUSED',...parent},id:top}];
 if(children){
  const copies=(d.ad_object_ids as JsonObject[]|undefined??[]).filter(o=>o.ad_object_type==='ad');
  const missing=children.filter(c=>!copies.some(o=>String(o.source_id)===String(c.id)));
  if(missing.length)throw new MirrorError('META_COPY_INCOMPLETE','Meta returned no copy for '+missing.length+' of the source ad set\'s ads.',{missing_source_ad_ids:missing.map(c=>String(c.id))});
  for(const o of copies)items.push({path:v+String(o.copied_id),query:{fields:'id,account_id,status,adset_id'},expected:{id:String(o.copied_id),account_id:selected,status:'PAUSED',adset_id:top},id:String(o.copied_id)});
 }
 return items;
}
