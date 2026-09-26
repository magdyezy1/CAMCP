import {MirrorError} from './errors.js';
import {tiktokPortfolioGetPath,tiktokCtaPortfolioCheck} from './tiktok-cta-portfolios.js';
import type {CompiledRequest,JsonObject} from './types.js';

/**
 * Paused Upgraded Smart+ website conversion Spark Ads from existing TikTok posts, per API for Business v1.3 "Create an
 * Upgraded Smart+ Ad", "Upgraded Smart+ ad creative combinations by identity and ad type", "Create a regular Upgraded
 * Smart+ Web Campaign", "Get info about an identity", "Get info about TikTok posts" and "Get Upgraded Smart+ Ads"
 * (checked 2026-09-26). Non-Spark ads no longer run on the TikTok placement, Spark identities there need a dynamic CTA
 * portfolio, an ad group holds at most 30 ads, and the automatic creative switches default by allowlist status, so
 * this contract sets them explicitly. Uploads (Spark Ads Push), authorization-code posts and custom identities stay out.
 */
export const tiktokSmartPlusAdPath='/v1.3/smart_plus/ad/create/';
export const tiktokSmartPlusAdGetPath='/v1.3/smart_plus/ad/get/';
export const tiktokIdentityVideoInfoPath='/v1.3/identity/video/info/';
export const tiktokSmartPlusAdSource='https://business-api.tiktok.com/portal/docs/create-an-upgraded-smart-ad/v1.3';
const identityInfoPath='/v1.3/identity/info/';
const obj=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const numeric=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,31}$/.test(v);
const emoji=/\p{Extended_Pictographic}/u;
const width=(s:string)=>[...s].reduce((n,c)=>n+(/[぀-ヿ㐀-鿿豈-﫿가-힯]/.test(c)?2:1),0);
const order=(a:unknown,b:unknown)=>{const x=JSON.stringify(a),y=JSON.stringify(b);return x<y?-1:x>y?1:0;};
const maxCreatives=20,maxAds=30;
/** The post type each ad format uses. */
const formats:Record<string,string>={SINGLE_VIDEO:'VIDEO',CAROUSEL_ADS:'CAROUSEL'};
const enhancements=['TRANSLATE_AND_DUB','MUSIC_REFRESH','VIDEO_QUALITY','IMAGE_QUALITY','IMAGE_RESIZE'];
const topKeys=['advertiser_id','adgroup_id','ad_name','operation_status','creative_list','landing_page_url_list','ad_configuration'];
const configKeys=['call_to_action_id','creative_auto_add_toggle','creative_auto_enhancement_strategy_list','utm_params'];

export const tiktokSmartPlusAdKind=(p:CompiledRequest)=>p.gateway==='tiktok_native_action'&&p.method==='POST'&&p.path===tiktokSmartPlusAdPath;

function invalid(field:string,message:string):never{
 throw new MirrorError('INVALID_TIKTOK_SMART_PLUS_AD',message,{field});
}
const webUrl=(v:unknown):v is string=>{if(typeof v!=='string'||v.length>2048||/\s/.test(v))return false;try{const u=new URL(v);return ['http:','https:'].includes(u.protocol)&&!!u.hostname;}catch{return false;}};
const creatives=(b:JsonObject)=>(b.creative_list as JsonObject[]).map(c=>c.creative_info as JsonObject);
type Identity={type:string;id:string;bc?:string;items:string[]};
/** One entry per identity named by the creatives, with the posts it must own. */
function identities(b:JsonObject):Identity[]{
 const out=new Map<string,Identity>();
 for(const c of creatives(b)){
  const bc=c.identity_authorized_bc_id as string|undefined,key=c.identity_type+':'+c.identity_id+':'+(bc??'');
  const i=out.get(key)??{type:c.identity_type as string,id:c.identity_id as string,...(bc!==undefined?{bc}:{}),items:[]};i.items.push(c.tiktok_item_id as string);out.set(key,i);
 }
 return [...out.values()];
}

/** Validates the request before review; nothing here reads or contacts TikTok. */
export function assertTiktokSmartPlusAd(plan:CompiledRequest,body:JsonObject):void{
 const extra=Object.keys(body).find(k=>!topKeys.includes(k));
 if(extra)invalid(extra,'"'+extra+'" is outside the qualified Smart+ Spark Ad contract'+(extra==='ad_text_list'?'; Spark Ads from existing posts use the post text.':extra==='call_to_action_list'?'; Spark Ads use a dynamic CTA through ad_configuration.call_to_action_id.':'.'));
 if(body.advertiser_id!==undefined&&String(body.advertiser_id)!==plan.accountId)invalid('advertiser_id','advertiser_id must equal the selected advertiser.');
 if(!numeric(body.adgroup_id))invalid('adgroup_id','adgroup_id must be the numeric ID of an Upgraded Smart+ ad group.');
 if(body.operation_status!=='DISABLE')invalid('operation_status','Create Smart+ ads paused: set operation_status to DISABLE (TikTok defaults to ENABLE).');
 if(typeof body.ad_name!=='string'||!body.ad_name.trim()||width(body.ad_name)>512||emoji.test(body.ad_name))invalid('ad_name','ad_name must be nonempty, at most 512 characters (Chinese and Japanese count twice) and without emoji.');
 const list=body.creative_list;
 if(!Array.isArray(list)||!list.length||list.length>maxCreatives)invalid('creative_list','creative_list must hold 1-'+maxCreatives+' existing TikTok posts.');
 const items=new Set<string>();
 list.forEach((c:unknown,i:number)=>{
  const at='creative_list['+i+'].creative_info';
  if(!obj(c)||Object.keys(c).some(k=>k!=='creative_info')||!obj(c.creative_info))invalid('creative_list['+i+']','Each creative is {creative_info:{...}} naming one existing TikTok post.');
  const ci=c.creative_info,key=Object.keys(ci).find(k=>!['ad_format','tiktok_item_id','identity_type','identity_id','identity_authorized_bc_id'].includes(k));
  if(key)invalid(at+'.'+key,'"'+key+'" is outside Spark Ads from existing posts; uploads (Spark Ads Push) and custom identities are not qualified.');
  if(typeof ci.ad_format!=='string'||!Object.hasOwn(formats,ci.ad_format))invalid(at+'.ad_format','ad_format must be SINGLE_VIDEO for a video post or CAROUSEL_ADS for a photo post.');
  if(!numeric(ci.tiktok_item_id))invalid(at+'.tiktok_item_id','tiktok_item_id must be the numeric ID of an existing TikTok post.');
  if(items.has(ci.tiktok_item_id))invalid(at+'.tiktok_item_id','Post '+ci.tiktok_item_id+' appears more than once.');items.add(ci.tiktok_item_id);
  if(ci.identity_type!=='TT_USER'&&ci.identity_type!=='BC_AUTH_TT')invalid(at+'.identity_type','identity_type must be TT_USER or BC_AUTH_TT; authorization-code posts and custom identities are not qualified.');
  if(typeof ci.identity_id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(ci.identity_id))invalid(at+'.identity_id','identity_id must be the TikTok account identity that owns the post.');
  if((ci.identity_type==='BC_AUTH_TT')!==(ci.identity_authorized_bc_id!==undefined)||ci.identity_authorized_bc_id!==undefined&&!numeric(ci.identity_authorized_bc_id))invalid(at+'.identity_authorized_bc_id','identity_authorized_bc_id is the Business Center ID, required for BC_AUTH_TT and only for it.');
 });
 const pages=body.landing_page_url_list;
 if(!Array.isArray(pages)||pages.length!==1||!obj(pages[0])||Object.keys(pages[0]).some(k=>k!=='landing_page_url')||!webUrl(pages[0].landing_page_url))invalid('landing_page_url_list','landing_page_url_list must hold exactly one {landing_page_url} with an http or https URL.');
 const ac=body.ad_configuration;
 if(!obj(ac))invalid('ad_configuration','ad_configuration must set call_to_action_id and both automatic creative switches.');
 const akey=Object.keys(ac).find(k=>!configKeys.includes(k));
 if(akey)invalid('ad_configuration.'+akey,'"'+akey+'" is outside the qualified Smart+ Spark Ad contract.');
 if(!numeric(ac.call_to_action_id))invalid('ad_configuration.call_to_action_id','Spark Ads on TikTok need a dynamic CTA: set call_to_action_id to a CTA portfolio ID.');
 if(typeof ac.creative_auto_add_toggle!=='boolean')invalid('ad_configuration.creative_auto_add_toggle','Set creative_auto_add_toggle to true or false; its default depends on allowlist status.');
 const e=ac.creative_auto_enhancement_strategy_list;
 if(!Array.isArray(e)||!e.every(v=>enhancements.includes(v))||new Set(e).size!==e.length)invalid('ad_configuration.creative_auto_enhancement_strategy_list','Set creative_auto_enhancement_strategy_list to a list, possibly empty, of '+enhancements.join(', ')+'; its default depends on allowlist status.');
 if(ac.utm_params!==undefined){
  const u=ac.utm_params,query=new URL(pages[0].landing_page_url as string).searchParams,sent=[...query.entries()].map(([key,value])=>key+'='+value).sort();
  if(!Array.isArray(u)||!u.length||u.length>14||!u.every(p=>obj(p)&&Object.keys(p).every(k=>k==='key'||k==='value')&&typeof p.key==='string'&&p.key.trim()!==''&&[...p.key].length<=100&&typeof p.value==='string'&&[...p.value].length<=600))invalid('ad_configuration.utm_params','utm_params holds 1-14 {key,value} pairs (keys up to 100 characters, values up to 600).');
  if(JSON.stringify(u.map((p:JsonObject)=>p.key+'='+p.value).sort())!==JSON.stringify(sent))invalid('ad_configuration.utm_params','utm_params only record the parameters already in landing_page_url, exactly; TikTok does not append them.');
 }
}

type Read={path:string;query:JsonObject;action:string};
export function tiktokSmartPlusAdReads(plan:CompiledRequest):Read[]{
 const b=plan.body as JsonObject,id=plan.accountId,filtering={adgroup_ids:[b.adgroup_id]};
 const reads:Read[]=[{path:'/v1.3/smart_plus/adgroup/get/',query:{advertiser_id:id,filtering,page_size:100},action:'tiktok_smart_plus_adgroup_get'},
  {path:tiktokSmartPlusAdGetPath,query:{advertiser_id:id,filtering,page_size:100},action:'tiktok_smart_plus_ad_get'}];
 for(const i of identities(b)){
  const who={advertiser_id:id,identity_type:i.type,identity_id:i.id,...(i.bc!==undefined?{identity_authorized_bc_id:i.bc}:{})};
  reads.push({path:identityInfoPath,query:who,action:'tiktok_identity_info_get'},{path:tiktokIdentityVideoInfoPath,query:{...who,item_ids:[...i.items].sort()},action:'tiktok_identity_video_info_get'});
 }
 reads.push({path:tiktokPortfolioGetPath,query:{advertiser_id:id,creative_portfolio_id:(b.ad_configuration as JsonObject).call_to_action_id},action:'tiktok_creative_portfolio_get'});
 return reads;
}
/** The ads of one ad group, read to count them; the status family reads ads by their own IDs instead. */
const adgroupAdsRead=(read:CompiledRequest)=>read.gateway==='tiktok_native_action'&&read.path===tiktokSmartPlusAdGetPath&&obj(read.query.filtering)&&Array.isArray(read.query.filtering.adgroup_ids)&&read.query.filtering.smart_plus_ad_ids===undefined;
export function validateTiktokSmartPlusAdState(read:CompiledRequest,data:JsonObject,sameIds:(actual:unknown[],expected:unknown[])=>void):boolean{
 if(adgroupAdsRead(read)){
  const list=data.data?.list,total=data.data?.page_info?.total_number,group=String((read.query.filtering as JsonObject).adgroup_ids[0]);
  if(data.code!==0||!Array.isArray(list)||list.some((r:JsonObject)=>String(r?.adgroup_id)!==group)||total!==undefined&&total!==list.length)throw new MirrorError('STATE_READ_FAILED','TikTok must return every ad of the ad group on one page.');
  return true;
 }
 if(read.gateway==='tiktok_native_action'&&read.path===tiktokIdentityVideoInfoPath){
  if(data.code!==0||!Array.isArray(data.data?.video_details))throw new MirrorError('STATE_READ_FAILED','TikTok post state must confirm success and contain video_details.');
  sameIds(data.data.video_details.map((r:JsonObject)=>r?.item_id),read.query.item_ids as unknown[]);return true;
 }
 return false;
}
/** Review state without signed media URLs, which change on every read, so an unchanged post or identity compares equal. */
export function tiktokSmartPlusAdState(read:CompiledRequest,d:JsonObject):JsonObject|undefined{
 if(adgroupAdsRead(read)){
  if(obj(d.data)&&obj(d.data.adgroup_ads))return {data:{adgroup_ads:d.data.adgroup_ads}};
  if(!Array.isArray(d.data?.list))return;
  return {data:{adgroup_ads:{adgroup_id:String((read.query.filtering as JsonObject).adgroup_ids[0]),smart_plus_ad_ids:d.data.list.map((r:JsonObject)=>String(r?.smart_plus_ad_id)).sort()}}};
 }
 if(read.gateway==='tiktok_native_action'&&read.path===identityInfoPath&&obj(d.data?.identity_info)){
  const i=d.data.identity_info;
  return {data:{identity_info:{identity_id:i.identity_id??null,identity_type:i.identity_type??null,identity_authorized_bc_id:i.identity_authorized_bc_id??null,available_status:i.available_status??null,can_pull_video:i.can_pull_video??null,is_gpppa:i.is_gpppa??null}}};
 }
 if(read.gateway==='tiktok_native_action'&&read.path===tiktokIdentityVideoInfoPath&&Array.isArray(d.data?.video_details)){
  return {data:{identity_type:String(read.query.identity_type),identity_id:String(read.query.identity_id),video_details:d.data.video_details.map((r:JsonObject)=>({item_id:String(r?.item_id),item_type:r?.item_type??null,status:r?.status??null})).sort(order)}};
 }
}
/** Checked against the state read before review and again before execution. */
export function tiktokSmartPlusAdPrerequisites(plan:CompiledRequest,values:unknown[]):void{
 if(!tiktokSmartPlusAdKind(plan))return;
 const b=plan.body as JsonObject,data=values.map(v=>obj(v)&&obj(v.data)?v.data:undefined).filter((d):d is JsonObject=>!!d);
 const group=data.flatMap(d=>Array.isArray(d.list)?d.list:[]).find((r:JsonObject)=>String(r?.adgroup_id)===b.adgroup_id&&Object.hasOwn(r,'promotion_type')) as JsonObject|undefined;
 if(!group)throw new MirrorError('STATE_TARGET_MISMATCH','Smart+ ad group '+b.adgroup_id+' was not returned for the selected advertiser.',{adgroup_id:b.adgroup_id});
 if(group.promotion_type!=='WEBSITE'||group.optimization_goal!=='CONVERT')invalid('adgroup_id','Ad group '+b.adgroup_id+' is not a website conversion ad group (promotion_type WEBSITE with optimization_goal CONVERT).');
 if(group.placement_type==='PLACEMENT_TYPE_NORMAL'&&!(Array.isArray(group.placements)&&group.placements.includes('PLACEMENT_TIKTOK')))invalid('adgroup_id','Ad group '+b.adgroup_id+' excludes the TikTok placement; the Spark Ads in this contract deliver on TikTok.');
 const ads=data.find(d=>obj(d.adgroup_ads))?.adgroup_ads as JsonObject|undefined;
 if(!ads)throw new MirrorError('STATE_READ_FAILED','The ads of ad group '+b.adgroup_id+' were not read.');
 if((ads.smart_plus_ad_ids as string[]).length>=maxAds)invalid('adgroup_id','Ad group '+b.adgroup_id+' already has '+(ads.smart_plus_ad_ids as string[]).length+' ads; an Upgraded Smart+ ad group holds at most '+maxAds+'.');
 for(const i of identities(b)){
  const info=data.map(d=>d.identity_info).find((r:JsonObject)=>obj(r)&&String(r.identity_id)===i.id&&r.identity_type===i.type) as JsonObject|undefined,field='creative_list.identity_id';
  if(!info)throw new MirrorError('STATE_TARGET_MISMATCH','Identity '+i.id+' ('+i.type+') was not returned for the selected advertiser.',{identity_id:i.id});
  if(i.bc!==undefined&&String(info.identity_authorized_bc_id)!==i.bc)invalid(field,'Identity '+i.id+' belongs to Business Center '+info.identity_authorized_bc_id+', not '+i.bc+'.');
  if(info.available_status!=='AVAILABLE')invalid(field,'Identity '+i.id+' is not available ('+(info.available_status??'no status')+').');
  if(info.can_pull_video!==true)invalid(field,'Identity '+i.id+' cannot use its existing posts in ads (can_pull_video is not true).');
  if(info.is_gpppa===true)invalid(field,'Identity '+i.id+' is a government, politician or political party account, which cannot run Spark Ads.');
  const posts=data.find(d=>d.identity_id===i.id&&d.identity_type===i.type&&Array.isArray(d.video_details))?.video_details as JsonObject[]|undefined;
  for(const c of creatives(b).filter(c=>c.identity_id===i.id&&c.identity_type===i.type)){
   const post=posts?.find(p=>p.item_id===c.tiktok_item_id);
   if(!post)throw new MirrorError('STATE_TARGET_MISMATCH','Post '+c.tiktok_item_id+' was not returned for identity '+i.id+'.',{tiktok_item_id:c.tiktok_item_id});
   if(post.item_type!==formats[c.ad_format as string])invalid('creative_list.ad_format','Post '+c.tiktok_item_id+' is a '+(post.item_type??'unknown')+' post; '+c.ad_format+' needs a '+formats[c.ad_format as string]+' post.');
  }
 }
 tiktokCtaPortfolioCheck((b.ad_configuration as JsonObject).call_to_action_id as string,values,'ad_configuration.call_to_action_id');
}
export function tiktokSmartPlusAdImpact(plan:CompiledRequest,state:unknown[]):JsonObject{
 const b=plan.body as JsonObject,ac=b.ad_configuration as JsonObject,data=state.map(v=>obj(v)&&obj(v.data)?v.data:undefined);
 const group=data.flatMap(d=>Array.isArray(d?.list)?d.list:[]).find((r:JsonObject)=>String(r?.adgroup_id)===b.adgroup_id) as JsonObject|undefined;
 const existing=(data.find(d=>obj(d?.adgroup_ads))?.adgroup_ads as JsonObject|undefined)?.smart_plus_ad_ids as string[]|undefined;
 return {provider:'tiktok',scope:'smart_plus_ads',may_affect_serving:false,
  effect:'Creates a paused Upgraded Smart+ ad from '+creatives(b).length+' existing TikTok post(s); nothing delivers until the ad is enabled.',
  ad_group:{adgroup_id:b.adgroup_id,operation_status:group?.operation_status??null,placement_type:group?.placement_type??null,existing_ads:existing?.length??null,limit:maxAds},
  creatives:creatives(b).map(c=>({tiktok_item_id:c.tiktok_item_id,ad_format:c.ad_format,identity_type:c.identity_type,identity_id:c.identity_id})),
  landing_page_url:(b.landing_page_url_list as JsonObject[])[0]!.landing_page_url,call_to_action_id:ac.call_to_action_id,
  automatic_creative:{creative_auto_add_toggle:ac.creative_auto_add_toggle,creative_auto_enhancement_strategy_list:ac.creative_auto_enhancement_strategy_list,fixed_after_creation:'TRANSLATE_AND_DUB cannot be added or removed later ('+((ac.creative_auto_enhancement_strategy_list as string[]).includes('TRANSLATE_AND_DUB')?'included':'excluded')+').'},source:tiktokSmartPlusAdSource};
}
export const tiktokSmartPlusAdId=(d:JsonObject)=>obj(d.data)&&numeric(d.data.smart_plus_ad_id)?d.data.smart_plus_ad_id:undefined;
const blank=(v:unknown)=>v===undefined||v===null||v===''?null:String(v);
/** The ad in comparable form: selected posts, landing pages and UTM parameters as sets. Other fields stay for status checks. */
export function tiktokSmartPlusAdProjection(row:unknown):JsonObject|undefined{
 if(!obj(row))return;
 const out:JsonObject={...row};
 if(Array.isArray(row.creative_list))out.creative_list=row.creative_list.map((c:JsonObject)=>{const ci=obj(c)&&obj(c.creative_info)?c.creative_info:{};return {ad_format:ci.ad_format??null,tiktok_item_id:blank(ci.tiktok_item_id),identity_type:ci.identity_type??null,identity_id:blank(ci.identity_id),identity_authorized_bc_id:blank(ci.identity_authorized_bc_id)};}).sort(order);
 if(Array.isArray(row.landing_page_url_list))out.landing_page_url_list=row.landing_page_url_list.map((p:JsonObject)=>obj(p)?p.landing_page_url??null:null).sort();
 if(obj(row.ad_configuration)){
  const ac:JsonObject={...row.ad_configuration};
  if(Array.isArray(ac.creative_auto_enhancement_strategy_list))ac.creative_auto_enhancement_strategy_list=[...ac.creative_auto_enhancement_strategy_list].sort();
  if(Array.isArray(ac.utm_params))ac.utm_params=ac.utm_params.map((p:JsonObject)=>({key:p?.key??null,value:p?.value??null})).sort(order);
  if(ac.call_to_action_id!==undefined)ac.call_to_action_id=blank(ac.call_to_action_id);
  out.ad_configuration=ac;
 }
 return out;
}
export function tiktokSmartPlusAdVerification(plan:CompiledRequest,result:JsonObject){
 const id=tiktokSmartPlusAdId(obj(result.data)?result.data:{}),b=plan.body as JsonObject;
 if(!id)throw new MirrorError('VERIFICATION_UNSUPPORTED','The creation receipt has no Smart+ ad ID.');
 const sent=tiktokSmartPlusAdProjection({creative_list:b.creative_list,landing_page_url_list:b.landing_page_url_list,ad_configuration:b.ad_configuration})!;
 const expected:JsonObject={smart_plus_ad_id:id,adgroup_id:b.adgroup_id,ad_name:b.ad_name,operation_status:'DISABLE',...sent};
 return [{path:tiktokSmartPlusAdGetPath,query:{advertiser_id:plan.accountId,filtering:{smart_plus_ad_ids:[id]},page_size:100},expected,id}];
}
