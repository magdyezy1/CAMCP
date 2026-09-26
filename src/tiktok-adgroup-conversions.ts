import {MirrorError} from './errors.js';
import {tiktokConversionGetPath} from './tiktok-custom-conversions.js';
import type {CompiledRequest,JsonObject} from './types.js';

/**
 * A manual ad group can optimize for a pixel custom conversion. Per API for Business v1.3 "Create an ad group"
 * (checked 2026-09-26), `custom_conversion_id` is valid only with the conversion's pixel, optimization goal CONVERT,
 * the conversion's own `optimization_event`, and an activity status of ACTIVE or NO_RECENT_ACTIVITY. "Update an
 * ad group" returns the field but does not accept it.
 */
const obj=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,31}$/.test(v);
const eligible=['ACTIVE','NO_RECENT_ACTIVITY'];

function invalid(field:string,message:string):never{
 throw new MirrorError('INVALID_TIKTOK_CUSTOM_CONVERSION',message,{field});
}

/** The custom conversion an ad group create names, after checking the fields TikTok requires alongside it. */
export function tiktokAdgroupConversion(plan:CompiledRequest):{id:string;pixel:string}|undefined{
 if(plan.gateway!=='tiktok_native_action'||plan.method!=='POST'||!obj(plan.body)||plan.body.custom_conversion_id===undefined)return;
 const b=plan.body;
 if(plan.path==='/v1.3/adgroup/update/')invalid('custom_conversion_id','/adgroup/update/ does not accept custom_conversion_id; create a new ad group to optimize for a custom conversion.');
 if(plan.path!=='/v1.3/adgroup/create/')return;
 if(!id(b.custom_conversion_id))invalid('custom_conversion_id','custom_conversion_id must be a numeric custom conversion ID.');
 if(b.app_id!==undefined||b.app_config!==undefined)invalid('custom_conversion_id','Custom conversions on app event sources are not qualified.');
 if(!id(b.pixel_id))invalid('pixel_id','Send the pixel_id the custom conversion belongs to.');
 if(b.optimization_goal!=='CONVERT')invalid('optimization_goal','A pixel custom conversion needs optimization_goal CONVERT.');
 if(typeof b.optimization_event!=='string')invalid('optimization_event','Send the optimization_event the custom conversion is based on.');
 return {id:b.custom_conversion_id,pixel:b.pixel_id};
}
/** Review state for the referenced conversion: its identity, pixel, event and whether TikTok accepts it now. */
export function tiktokConversionEligibility(data:JsonObject):JsonObject{
 const d=obj(data)?data:{};
 return {custom_conversion_id:d.custom_conversion_id===undefined?null:String(d.custom_conversion_id),event_source_id:d.event_source_id===undefined?null:String(d.event_source_id),optimization_event:d.optimization_event??null,eligible:typeof d.eligible==='boolean'?d.eligible:eligible.includes(d.activity_status)};
}
export function tiktokAdgroupConversionRead(plan:CompiledRequest):{path:string;query:JsonObject;action:string}|undefined{
 const c=tiktokAdgroupConversion(plan);
 return c&&{path:tiktokConversionGetPath,query:{advertiser_id:plan.accountId,custom_conversion_id:c.id,event_source_type:'PIXEL',event_source_id:c.pixel},action:'tiktok_custom_conversion_get'};
}
/** Checked against the state read before review and again before execution. */
export function tiktokAdgroupConversionPrerequisites(plan:CompiledRequest,values:unknown[]):void{
 const c=tiktokAdgroupConversion(plan);if(!c)return;
 const row=values.map(v=>obj(v)&&obj(v.data)?v.data:undefined).find(d=>d?.custom_conversion_id===c.id&&Object.hasOwn(d,'eligible'));
 if(!row)throw new MirrorError('STATE_TARGET_MISMATCH','The custom conversion was not returned for this pixel.',{custom_conversion_id:c.id,pixel_id:c.pixel});
 const b=plan.body as JsonObject;
 if(row.event_source_id!==c.pixel)invalid('pixel_id','Custom conversion '+c.id+' belongs to pixel '+row.event_source_id+', not '+c.pixel+'.');
 if(row.optimization_event!==b.optimization_event)invalid('optimization_event','The ad group optimization_event must be the custom conversion\'s event, '+row.optimization_event+'.');
 if(row.eligible!==true)invalid('custom_conversion_id','Custom conversion '+c.id+' has no qualifying pixel activity yet; TikTok accepts it only when its status is ACTIVE or NO_RECENT_ACTIVITY.');
}
