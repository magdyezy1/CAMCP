import {MirrorError} from './errors.js';
import {tiktokAudienceGetPath} from './tiktok-lookalikes.js';
import type {CompiledRequest,JsonObject} from './types.js';

/**
 * TikTok saved audiences (reusable targeting), per API for Business v1.3 "Create a Saved Audience", "Get details
 * of Saved Audiences" and the Enumerations appendix (checked 2026-09-26). A saved audience changes no ad group;
 * an ad group uses it only when created with saved_audience_id. At most 400 per advertiser. Deletion and the
 * example-only interest_keyword_language field are outside this contract.
 */
export const tiktokSavedAudiencePath='/v1.3/dmp/saved_audience/create/';
export const tiktokSavedAudienceListPath='/v1.3/dmp/saved_audience/list/';
export const tiktokSavedAudienceSource='https://business-api.tiktok.com/portal/docs/create-a-saved-audience/v1.3';
const keys=['advertiser_id','saved_audience_name','location_ids','gender','age_groups','languages','audience_ids','excluded_audience_ids','interest_category_ids','interest_keyword_ids','actions','operating_systems','min_android_version','min_ios_version','device_model_ids','network_types','carrier_ids','device_price_ranges'];
const idLists=['location_ids','audience_ids','excluded_audience_ids','interest_category_ids','interest_keyword_ids','device_model_ids','carrier_ids'];
const ages=['AGE_13_17','AGE_18_24','AGE_25_34','AGE_35_44','AGE_45_54','AGE_55_100'];
const networks=['WIFI','2G','3G','4G','5G'];
const sceneActions:Record<string,string[]>={VIDEO_RELATED:['WATCHED_TO_END','LIKED','COMMENTED','SHARED'],CREATOR_RELATED:['FOLLOWING','VIEW_HOMEPAGE'],HASHTAG_RELATED:['VIEW_HASHTAG']};
const obj=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const numeric=(v:unknown)=>typeof v==='string'&&/^[1-9][0-9]{0,31}$/.test(v);
const emoji=/\p{Extended_Pictographic}/u;
const sorted=(v:unknown)=>Array.isArray(v)?[...v].map(String).sort():v;

export const tiktokSavedAudienceKind=(p:CompiledRequest)=>p.gateway==='tiktok_native_action'&&p.method==='POST'&&p.path===tiktokSavedAudiencePath;

function invalid(field:string,message:string):never{
 throw new MirrorError('INVALID_TIKTOK_SAVED_AUDIENCE',message,{field});
}
function unique(field:string,v:unknown,test:(x:unknown)=>boolean,what:string,required=false,max=100):void{
 if(!Array.isArray(v)||(required&&!v.length)||v.length>max||!v.every(test)||new Set(v).size!==v.length)invalid(field,field+' must be '+(required?'a nonempty':'an')+' array of at most '+max+' unique '+what+'.');
}

/** Validates the request before review; nothing here reads or contacts TikTok. */
export function assertTiktokSavedAudience(plan:CompiledRequest,body:JsonObject):void{
 const extra=Object.keys(body).find(k=>!keys.includes(k));
 if(extra)invalid(extra,'"'+extra+'" is outside the qualified saved audience contract.');
 if(body.advertiser_id!==undefined&&String(body.advertiser_id)!==plan.accountId)invalid('advertiser_id','advertiser_id must equal the selected advertiser.');
 const name=body.saved_audience_name;
 if(typeof name!=='string'||!name.trim()||[...name].length>512||emoji.test(name))invalid('saved_audience_name','saved_audience_name must be nonempty text of at most 512 characters without emoji.');
 unique('location_ids',body.location_ids,numeric,'numeric location IDs',true);
 for(const field of idLists.slice(1))if(body[field]!==undefined)unique(field,body[field],numeric,'numeric IDs');
 const excluded=new Set(body.excluded_audience_ids??[]);
 if(new Set([...(body.audience_ids??[]),...excluded]).size>100)invalid('audience_ids','Review at most 100 included and excluded audiences together.');
 if((body.audience_ids??[]).some((a:string)=>excluded.has(a)))invalid('excluded_audience_ids','An audience cannot be both included and excluded.');
 if(body.gender!==undefined&&!['GENDER_FEMALE','GENDER_MALE','GENDER_UNLIMITED'].includes(body.gender))invalid('gender','gender must be GENDER_FEMALE, GENDER_MALE or GENDER_UNLIMITED.');
 if(body.age_groups!==undefined)unique('age_groups',body.age_groups,v=>ages.includes(v as string),'age groups ('+ages.join(', ')+')',true,ages.length);
 if(body.languages!==undefined)unique('languages',body.languages,v=>typeof v==='string'&&/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,4})?$/.test(v),'language codes from /tool/language/');
 if(body.network_types!==undefined)unique('network_types',body.network_types,v=>networks.includes(v as string),'connection types ('+networks.join(', ')+')',true,networks.length);
 if(body.operating_systems!==undefined&&(!Array.isArray(body.operating_systems)||body.operating_systems.length!==1||!['ANDROID','IOS'].includes(body.operating_systems[0])))invalid('operating_systems','operating_systems takes exactly one of ANDROID and IOS.');
 for(const field of ['min_android_version','min_ios_version'])if(body[field]!==undefined&&(typeof body[field]!=='string'||!/^(?:NONE|[1-9][0-9]?\.[0-9]{1,2})$/.test(body[field])))invalid(field,field+' must be NONE or a version from /tool/os_version/.');
 const prices=body.device_price_ranges;
 if(prices!==undefined){
  if(body.device_model_ids!==undefined)invalid('device_price_ranges','Device models and device price ranges cannot be set together.');
  if(!Array.isArray(prices)||prices.length!==2||prices.some(v=>!Number.isSafeInteger(v)||v<0||v>10000||v%50!==0)||prices[0]>=prices[1])invalid('device_price_ranges','device_price_ranges is [lower, upper]: multiples of 50 from 0 to 10000, lower below upper.');
 }
 const actions=body.actions;
 if(actions!==undefined){
  if(!Array.isArray(actions)||!actions.length||actions.length>20)invalid('actions','actions must list 1 to 20 action objects.');
  actions.forEach((a:unknown,i:number)=>{
   const path='actions/'+i;
   if(!obj(a))invalid(path,'Each action must be an object.');
   const bad=Object.keys(a).find(k=>!['action_category_ids','action_scene','action_period','video_user_actions'].includes(k));if(bad)invalid(path+'/'+bad,'"'+bad+'" is outside the qualified action contract.');
   if(!Object.hasOwn(sceneActions,a.action_scene))invalid(path+'/action_scene','action_scene must be VIDEO_RELATED, CREATOR_RELATED or HASHTAG_RELATED.');
   unique(path+'/action_category_ids',a.action_category_ids,numeric,'numeric action category IDs',true);
   // TikTok stores 0 for creator and hashtag actions whatever is sent; requiring 0 keeps read-back exact.
   if(a.action_scene==='VIDEO_RELATED'?![0,7,15].includes(a.action_period):a.action_period!==0)invalid(path+'/action_period',a.action_scene==='VIDEO_RELATED'?'action_period must be 0, 7 or 15.':'action_period must be 0 for creator and hashtag actions.');
   unique(path+'/video_user_actions',a.video_user_actions,v=>sceneActions[a.action_scene]!.includes(v as string),a.action_scene+' actions ('+sceneActions[a.action_scene]!.join(', ')+')',true);
  });
 }
}

/** Referenced custom audiences are read so the review can confirm the advertiser owns them. */
export function tiktokSavedAudienceAudiences(plan:CompiledRequest):string[]{
 const b=plan.body as JsonObject;return [...new Set<string>([...(b.audience_ids??[]),...(b.excluded_audience_ids??[])])].sort();
}
/** Against the normalized review state: every referenced audience is this advertiser's own and available. */
export function tiktokSavedAudienceImpact(plan:CompiledRequest,state:unknown[]):JsonObject{
 const b=plan.body as JsonObject,wanted=tiktokSavedAudienceAudiences(plan);
 const rows=state.flatMap(s=>obj(s)&&obj(s.data)&&Array.isArray(s.data.list)?s.data.list:[]).map((r:JsonObject)=>r?.audience_details).filter(obj) as JsonObject[];
 for(const audience of wanted){
  const a=rows.find(r=>String(r.audience_id)===audience);
  if(!a)throw new MirrorError('STATE_TARGET_MISMATCH','Audience '+audience+' was not returned for the selected advertiser.',{audience_id:audience});
  if(a.is_creator!==true)invalid('audience_ids','Audience '+audience+' is shared with this advertiser, not owned by it; saved audiences are qualified with owned audiences only.');
  if(a.is_valid!==true)invalid('audience_ids','Audience '+audience+' is not available yet; TikTok can take up to 48 hours to prepare an audience.');
 }
 return {provider:'tiktok',scope:'saved_audiences',may_affect_serving:false,
  effect:'Creates a reusable saved audience. No ad group changes; an ad group uses it only when created with saved_audience_id in its own review.',
  saved_audience:{name:b.saved_audience_name,locations:(b.location_ids as string[]).length,included_audiences:(b.audience_ids??[]).length,excluded_audiences:(b.excluded_audience_ids??[]).length,
   targeting:keys.filter(k=>!['advertiser_id','saved_audience_name','location_ids','audience_ids','excluded_audience_ids'].includes(k)&&b[k]!==undefined)},
  limit:'TikTok allows 400 saved audiences per advertiser; the list read does not page, so TikTok enforces the limit.',
  source:tiktokSavedAudienceSource};
}

/**
 * The targeting configuration in comparable form: ID lists as sets, price ranges as [lowest, highest] (the list
 * read expands a sent [0, 1000] into every step of 50), actions as a set. Only fields present are projected, and
 * verification compares only the fields that were sent.
 */
export function tiktokSavedAudienceProjection(v:unknown):JsonObject{
 if(!obj(v))return {};
 const out:JsonObject={};
 for(const key of ['saved_audience_id',...keys]){
  if(key==='advertiser_id'||v[key]===undefined)continue;
  const value=v[key];
  if(idLists.includes(key)||['age_groups','languages','network_types','operating_systems'].includes(key))out[key]=sorted(value);
  else if(key==='device_price_ranges')out[key]=Array.isArray(value)&&value.length?[Math.min(...value),Math.max(...value)]:value;
  else if(key==='actions')out[key]=Array.isArray(value)?value.filter(obj).map(a=>({action_scene:a.action_scene,action_period:a.action_period,action_category_ids:sorted(a.action_category_ids),video_user_actions:sorted(a.video_user_actions)})).sort((x,y)=>JSON.stringify(x)<JSON.stringify(y)?-1:1):value;
  else out[key]=value;
 }
 return out;
}
export function tiktokSavedAudienceVerification(plan:CompiledRequest,result:JsonObject):{path:string;query:JsonObject;expected:JsonObject;id:string}[]{
 const id=result.data?.data?.saved_audience_id,b=plan.body as JsonObject;
 if(!numeric(id))throw new MirrorError('VERIFICATION_UNSUPPORTED','The creation receipt has no saved audience ID.');
 return [{path:tiktokSavedAudienceListPath,query:{advertiser_id:plan.accountId,saved_audience_ids:[id]},expected:tiktokSavedAudienceProjection({...b,saved_audience_id:id}),id}];
}
export const tiktokSavedAudienceRead=(p:CompiledRequest)=>p.gateway==='tiktok_native_action'&&p.path===tiktokSavedAudienceListPath;
/** The list read with an ID filter must return exactly the requested saved audience. */
export function validateTiktokSavedAudienceState(read:CompiledRequest,data:JsonObject,sameIds:(actual:unknown[],expected:unknown[])=>void):boolean{
 if(read.path!==tiktokSavedAudienceListPath)return false;
 if(data.code!==0||!Array.isArray(data.data?.saved_audiences))throw new MirrorError('STATE_READ_FAILED','TikTok saved audience details must confirm success and list saved audiences.');
 sameIds(data.data.saved_audiences.map((r:JsonObject)=>r?.saved_audience_id),read.query.saved_audience_ids as unknown[]);return true;
}
export const tiktokSavedAudienceDependencyPath=tiktokAudienceGetPath;
