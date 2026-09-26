import {MirrorError} from './errors.js';
import type {CompiledRequest,JsonObject} from './types.js';

/**
 * Snapchat planning reads, per the Marketing API "Audience Insights" (POST /v1/adaccounts/{id}/targeting_insights) and the
 * "Reach and Frequency Guide" forecasting request (POST /v1/adaccounts/{id}/reserved_forecasting), checked 2026-09-26.
 * Both return estimates and create nothing, although they use POST and the captured catalog names them "create". The
 * forecast is the ad squad Snapchat would book: placement, targeting, REACH_AND_FREQUENCY delivery, dates between 12 hours
 * and 365 days ahead, the goal of its type and a frequency cap.
 */
const route=/^\/v1\/adaccounts\/([^/]+)\/(targeting_insights|reserved_forecasting)$/;
const dimensions=['demo','geo','device','interest','engagement','aggregated'],maxBytes=64*1024,hour=3600000;
const forecastKeys=['placement_v2','targeting','delivery_constraint','start_time','end_time','type','optimization_goal','cap_and_exclusion_config'];
const goals:Record<string,string>={SNAP_ADS:'VIDEO_VIEWS',LENS:'USES'};
const obj=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
function invalid(message:string):never{throw new MirrorError('INVALID_SNAPCHAT_PLANNING_READ',message);}
export function snapchatPlanningRoute(p:CompiledRequest):'insights'|'forecast'|undefined{
 if(p.gateway!=='snapchat_native_action'||p.method!=='POST'||p.specialTransport||p.origin!==undefined&&p.origin!=='https://adsapi.snapchat.com')return;
 const m=route.exec(p.path);return m?(m[2]==='targeting_insights'?'insights':'forecast'):undefined;
}
function time(value:unknown,field:string):number{const t=typeof value==='string'?Date.parse(value):NaN;if(!Number.isFinite(t)||!/T\d{2}:\d{2}/.test(String(value)))invalid(field+' must be an ISO-8601 date-time with a time zone.');return t;}
export function validateSnapchatPlanningRead(p:CompiledRequest,now=Date.now()):void{
 const kind=snapchatPlanningRoute(p);if(!kind)return;
 if(!p.accountId||route.exec(p.path)![1]!==p.accountId)throw new MirrorError('ACCOUNT_SCOPE_MISMATCH','The planning read must use the selected ad account.',{},403);
 if(Object.keys(p.headers).length)invalid('Planning reads take no header overrides.');
 const b=p.body;if(!obj(b))invalid('Provide the native JSON request object.');
 if(Buffer.byteLength(JSON.stringify(b))>maxBytes)invalid('The request exceeds AMCP\'s 64 KiB bound for planning reads.');
 if(kind==='insights'){
  if(Object.keys(p.query).some(k=>k!=='dimension_category')||p.query.dimension_category!==undefined&&!dimensions.includes(String(p.query.dimension_category)))invalid('The only query parameter is dimension_category: demo, geo, device, interest, engagement or aggregated.');
  if(Object.keys(b).length!==2||!obj(b.base_spec)||!obj(b.targeting_spec))invalid('Audience insights compare a targeting_spec with a base_spec; send exactly those two targeting specs.');
  return;
 }
 if(Object.keys(p.query).length)invalid('A forecast takes no query parameters.');
 if(Object.keys(b).some(k=>!forecastKeys.includes(k)))invalid('A forecast takes only the ad squad attributes '+forecastKeys.join(', ')+'.');
 if(!obj(b.placement_v2)||!obj(b.targeting)||!obj(b.cap_and_exclusion_config))invalid('A forecast needs placement_v2, targeting and cap_and_exclusion_config objects.');
 if(b.delivery_constraint!=='REACH_AND_FREQUENCY')invalid('delivery_constraint must be REACH_AND_FREQUENCY.');
 if(b.type!==undefined&&!goals[b.type])invalid('type must be SNAP_ADS or LENS.');
 if(b.optimization_goal!==(b.type===undefined?b.optimization_goal:goals[b.type])||!Object.values(goals).includes(b.optimization_goal))invalid('optimization_goal must be VIDEO_VIEWS for SNAP_ADS or USES for LENS.');
 const start=time(b.start_time,'start_time'),end=time(b.end_time,'end_time');
 if(start<now+12*hour||start>now+365*24*hour)invalid('Reach and frequency bookings start between 12 hours and 365 days from now.');
 if(end<=start)invalid('end_time must be after start_time.');
}
/** Compiler hook: a valid planning request is a read and never a reviewed mutation. */
export function snapchatPlanningPlan(p:CompiledRequest):CompiledRequest{
 const kind=snapchatPlanningRoute(p);if(!kind)return p;validateSnapchatPlanningRead(p);
 return {...p,readOnly:true,destructive:false,requiresConfirmation:false,warnings:[...p.warnings,kind==='insights'?'Audience insights are Snapchat estimates of the target audience against a reference audience; they create and change nothing.':'The reach and frequency curve is a Snapchat forecast for an unbooked ad squad; it books, creates and reserves nothing.']};
}
