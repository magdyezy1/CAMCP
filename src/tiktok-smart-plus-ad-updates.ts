import {MirrorError} from './errors.js';
import {tiktokPortfolioGetPath,tiktokCtaPortfolioCheck} from './tiktok-cta-portfolios.js';
import {tiktokSmartPlusAdGetPath,assertSparkCreatives,assertLandingPages,assertAdConfiguration,assertUtmMatch,sparkReads,sparkPrerequisites,tiktokSmartPlusAdProjection} from './tiktok-smart-plus-ads.js';
import type {CompiledRequest,JsonObject} from './types.js';

/**
 * Edits of Upgraded Smart+ Spark Ads, per API for Business v1.3 "Update an Upgraded Smart+ Ad" (checked 2026-09-26):
 * incremental, except that creative_list is replaced in full, so posts left out are removed; ad_material_id is
 * allowlist-only and makes TikTok ignore creative_info; TRANSLATE_AND_DUB cannot change after creation. Status
 * changes use the Smart+ status family.
 */
export const tiktokSmartPlusAdUpdatePath='/v1.3/smart_plus/ad/update/';
const obj=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const numeric=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,31}$/.test(v);
const emoji=/\p{Extended_Pictographic}/u;
const width=(s:string)=>[...s].reduce((n,c)=>n+(/[぀-ヿ㐀-鿿豈-﫿가-힯]/.test(c)?2:1),0);
const editable=['ad_name','creative_list','landing_page_url_list','ad_configuration'],content=['creative_list','landing_page_url_list','ad_configuration'];

export const tiktokSmartPlusAdUpdateKind=(p:CompiledRequest)=>p.gateway==='tiktok_native_action'&&p.method==='POST'&&p.path===tiktokSmartPlusAdUpdatePath;

function invalid(field:string,message:string):never{
 throw new MirrorError('INVALID_TIKTOK_SMART_PLUS_AD',message,{field});
}

/** Validates the request before review; nothing here reads or contacts TikTok. */
export function assertTiktokSmartPlusAdUpdate(plan:CompiledRequest,body:JsonObject):void{
 const extra=Object.keys(body).find(k=>!['advertiser_id','smart_plus_ad_id',...editable].includes(k));
 if(extra)invalid(extra,'"'+extra+'" is outside the qualified Smart+ Spark Ad edit contract'+(extra==='operation_status'?'; pause or enable the ad through the Smart+ status family.':'.'));
 if(body.advertiser_id!==undefined&&String(body.advertiser_id)!==plan.accountId)invalid('advertiser_id','advertiser_id must equal the selected advertiser.');
 if(!numeric(body.smart_plus_ad_id))invalid('smart_plus_ad_id','smart_plus_ad_id must be the numeric ID of an Upgraded Smart+ ad.');
 if(!editable.some(k=>body[k]!==undefined))invalid('ad_name','Send at least one of ad_name, creative_list, landing_page_url_list and ad_configuration.');
 if(body.ad_name!==undefined&&(typeof body.ad_name!=='string'||!body.ad_name.trim()||width(body.ad_name)>512||emoji.test(body.ad_name)))invalid('ad_name','ad_name must be nonempty, at most 512 characters (Chinese and Japanese count twice) and without emoji.');
 if(body.creative_list!==undefined)assertSparkCreatives(body.creative_list);
 const url=body.landing_page_url_list!==undefined?assertLandingPages(body.landing_page_url_list):undefined;
 if(body.ad_configuration!==undefined)assertAdConfiguration(body.ad_configuration,url);
}

type Read={path:string;query:JsonObject;action:string};
export function tiktokSmartPlusAdUpdateReads(plan:CompiledRequest):Read[]{
 const b=plan.body as JsonObject,id=plan.accountId;
 const reads:Read[]=[{path:tiktokSmartPlusAdGetPath,query:{advertiser_id:id,filtering:{smart_plus_ad_ids:[b.smart_plus_ad_id]},page_size:100},action:'tiktok_smart_plus_ad_get'}];
 if(b.creative_list!==undefined)reads.push(...sparkReads(id,b.creative_list as JsonObject[]));
 if(obj(b.ad_configuration))reads.push({path:tiktokPortfolioGetPath,query:{advertiser_id:id,creative_portfolio_id:b.ad_configuration.call_to_action_id},action:'tiktok_creative_portfolio_get'});
 return reads;
}
const adOf=(plan:CompiledRequest,values:unknown[])=>values.flatMap(v=>obj(v)&&obj(v.data)&&Array.isArray(v.data.list)?v.data.list:[]).find((r:JsonObject)=>String(r?.smart_plus_ad_id)===(plan.body as JsonObject).smart_plus_ad_id) as JsonObject|undefined;
const postsOf=(row:JsonObject)=>(Array.isArray(row.creative_list)?row.creative_list:[]).map((c:JsonObject)=>obj(c)&&obj(c.creative_info)?c.creative_info:{}) as JsonObject[];
/** An ad this contract edits beyond its name: existing-post Spark creatives, one landing page and a CTA portfolio, as the create contract makes them. */
const sparkAd=(row:JsonObject)=>{const posts=postsOf(row);return posts.length>0&&posts.every(ci=>typeof ci.tiktok_item_id==='string'&&ci.tiktok_item_id!==''&&['TT_USER','BC_AUTH_TT'].includes(ci.identity_type))&&Array.isArray(row.landing_page_url_list)&&row.landing_page_url_list.length===1&&obj(row.ad_configuration)&&!!row.ad_configuration.call_to_action_id;};
/** Checked against the state read before review and again before execution. */
export function tiktokSmartPlusAdUpdatePrerequisites(plan:CompiledRequest,values:unknown[]):void{
 if(!tiktokSmartPlusAdUpdateKind(plan))return;
 const b=plan.body as JsonObject,row=adOf(plan,values),ad=b.smart_plus_ad_id;
 if(!row)throw new MirrorError('STATE_TARGET_MISMATCH','Smart+ ad '+ad+' was not returned for the selected advertiser.',{smart_plus_ad_id:ad});
 if(row.operation_status==='FROZEN')invalid('smart_plus_ad_id','Smart+ ad '+ad+' is terminated (FROZEN).');
 if(!content.some(k=>b[k]!==undefined))return;
 if(!sparkAd(row))invalid('smart_plus_ad_id','Smart+ ad '+ad+' is not an ad from existing TikTok posts with one landing page and a CTA portfolio; only its name can be edited under this contract.');
 if(b.creative_list!==undefined)sparkPrerequisites(b.creative_list as JsonObject[],values.map(v=>obj(v)&&obj(v.data)?v.data:undefined).filter((d):d is JsonObject=>!!d));
 const current=row.ad_configuration as JsonObject;
 if(obj(b.ad_configuration)){
  tiktokCtaPortfolioCheck(b.ad_configuration.call_to_action_id as string,values,'ad_configuration.call_to_action_id');
  const had=Array.isArray(current.creative_auto_enhancement_strategy_list)&&current.creative_auto_enhancement_strategy_list.includes('TRANSLATE_AND_DUB'),wants=(b.ad_configuration.creative_auto_enhancement_strategy_list as string[]).includes('TRANSLATE_AND_DUB');
  if(had!==wants)invalid('ad_configuration.creative_auto_enhancement_strategy_list','TRANSLATE_AND_DUB cannot be added or removed after creation; ad '+ad+' '+(had?'includes':'excludes')+' it.');
  if(Array.isArray(current.utm_params)&&current.utm_params.length&&b.ad_configuration.utm_params===undefined)invalid('ad_configuration.utm_params','Restate utm_params: ad '+ad+' has them, and a new ad_configuration could clear them.');
 }
 // The UTM parameters in effect must still repeat the landing page in effect.
 const url=(b.landing_page_url_list as JsonObject[]|undefined)?.[0]?.landing_page_url??(row.landing_page_url_list as JsonObject[])[0]?.landing_page_url;
 const utm=obj(b.ad_configuration)?b.ad_configuration.utm_params:current.utm_params;
 if(typeof url==='string'&&Array.isArray(utm)&&utm.length)assertUtmMatch(utm,url);
}
export function tiktokSmartPlusAdUpdateImpact(plan:CompiledRequest,state:unknown[],override:boolean):JsonObject{
 const b=plan.body as JsonObject,row=adOf(plan,state)??{},changes:JsonObject={},before=postsOf(row).map(ci=>String(ci.tiktok_item_id));
 let removed:string[]=[];
 if(b.ad_name!==undefined)changes.ad_name={before:row.ad_name??null,after:b.ad_name};
 if(b.creative_list!==undefined){
  const after=(b.creative_list as JsonObject[]).map(c=>(c.creative_info as JsonObject).tiktok_item_id as string);removed=before.filter(i=>!after.includes(i));
  changes.creative_list={kept:after.filter(i=>before.includes(i)),added:after.filter(i=>!before.includes(i)),removed};
 }
 if(b.landing_page_url_list!==undefined)changes.landing_page_url={before:(row.landing_page_url_list as JsonObject[]|undefined)?.[0]?.landing_page_url??null,after:(b.landing_page_url_list as JsonObject[])[0]!.landing_page_url};
 if(obj(b.ad_configuration)){const current=obj(row.ad_configuration)?row.ad_configuration:{};changes.ad_configuration=Object.fromEntries(Object.keys(b.ad_configuration).map(k=>[k,{before:current[k]??null,after:(b.ad_configuration as JsonObject)[k]}]));}
 const live=row.operation_status==='ENABLE',edits=content.some(k=>b[k]!==undefined);
 if(live&&removed.length&&!override)throw new MirrorError('CREATIVE_EDIT_CONFIRMATION_REQUIRED','This edit removes '+removed.length+' post(s) from enabled ad '+b.smart_plus_ad_id+': '+removed.join(', ')+'. Review the list and prepare again with creative_edit_confirmed=true.',{smart_plus_ad_id:b.smart_plus_ad_id,removed});
 return {provider:'tiktok',scope:'smart_plus_ad_edits',may_affect_serving:live&&edits,
  effect:!edits?'Renames the ad; delivery is unchanged.':live?'Changes an enabled ad; TikTok reviews the modifications (AD_STATUS_DELIVERY_AND_REAUDIT) before they deliver, and removed posts stop delivering in this ad.':'Changes a paused ad; nothing delivers until it is enabled.',
  ad:{smart_plus_ad_id:b.smart_plus_ad_id,adgroup_id:row.adgroup_id??null,operation_status:row.operation_status??null},changes,creative_edit_confirmed:override,
  source:'https://business-api.tiktok.com/portal/docs/update-an-upgraded-smart-ad/v1.3'};
}
export function tiktokSmartPlusAdUpdateVerification(plan:CompiledRequest){
 const b=plan.body as JsonObject,id=b.smart_plus_ad_id as string,expected:JsonObject={smart_plus_ad_id:id};
 if(b.ad_name!==undefined)expected.ad_name=b.ad_name;
 Object.assign(expected,tiktokSmartPlusAdProjection(Object.fromEntries(content.filter(k=>b[k]!==undefined).map(k=>[k,b[k]]))));
 return [{path:tiktokSmartPlusAdGetPath,query:{advertiser_id:plan.accountId,filtering:{smart_plus_ad_ids:[id]},page_size:100},expected,id}];
}
