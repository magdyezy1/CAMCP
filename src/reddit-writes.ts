import type {CompiledRequest,JsonObject,Connection} from './types.js';
import type {TransportResult} from './transport.js';
import {MirrorError} from './errors.js';
const kinds=['campaigns','ad_groups','ads','saved_audiences'];
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
function fail(message:string):never{throw new MirrorError('INVALID_REDDIT_MUTATION',message);}
const identifier=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
export function redditWriteKind(plan:CompiledRequest){
 if(plan.gateway!=='reddit_native_action')return;
 const create=/^\/api\/v3\/ad_accounts\/([^/]+)\/(campaigns|ad_groups|ads|saved_audiences)$/.exec(plan.path),update=/^\/api\/v3\/(campaigns|ad_groups|ads|saved_audiences)\/([^/]+)$/.exec(plan.path);
 if(plan.method==='POST'&&create)return {kind:create[2]!,create:true};if(plan.method==='PATCH'&&update)return {kind:update[1]!,create:false,target:update[2]!};
}
export function assertRedditWrite(plan:CompiledRequest){
 const route=redditWriteKind(plan);if(!route)throw new MirrorError('WRITE_CONTRACT_UNAVAILABLE','Reddit execution supports reviewed campaign, ad-group, existing-post ad and saved Reddit-audience creates/updates.');
 if(Object.keys(plan.query).length||plan.specialTransport||Object.keys(plan.headers).length)fail('Only native JSON bodies are qualified for Reddit write reviews.');
 const b=plan.body;if(!object(b)||Object.keys(b).some(k=>k!=='data')||!object(b.data)||!Object.keys(b.data).length)fail('Use the native {data:{...}} request body.');const d=b.data;
 const readOnly=['id','created_at','modified_at','updated_at','effective_status','delivery_status','post_url','preview_url','rejection_reason','campaign_objective_type','is_max'];
 if(Object.keys(d).some(k=>readOnly.includes(k)))fail('Do not submit server-derived or read-only entity fields.');
 if(d.ad_account_id!==undefined&&d.ad_account_id!==plan.accountId)fail('ad_account_id must match the selected account.');
 if(d.type!==undefined&&!(route.kind==='ad_groups'&&d.type==='MANUAL'||route.kind==='ads'&&d.type==='UNSPECIFIED'||route.kind==='saved_audiences'&&d.type==='REDDIT_AUDIENCE'))fail('Reddit Max and customer-list audience workflows need additional contracts.');
 if(route.create){
  if(typeof d.name!=='string'||!d.name.trim())fail('New resources require a name.');
  if(route.kind==='saved_audiences'){if(d.type!=='REDDIT_AUDIENCE'||!object(d.targeting))fail('Saved-audience creation requires type REDDIT_AUDIENCE and native targeting.');}
  else if(d.configured_status!=='PAUSED')throw new MirrorError('PAUSED_CREATION_REQUIRED','New Reddit serving entities must use configured_status: PAUSED.');
  if(route.kind==='ad_groups'&&!identifier(d.campaign_id))fail('Ad groups require an existing campaign_id.');
  if(route.kind==='ads'&&(!identifier(d.ad_group_id)||!identifier(d.post_id)))fail('Reviewed ad creation requires an existing ad_group_id and post_id. Media/Reddit Max templates are separate, unqualified workflows.');
  if((route.kind==='ad_groups'||route.kind==='campaigns'&&d.is_campaign_budget_optimization===true)&&!identifier(d.conversion_pixel_id))fail('Reddit requires conversion_pixel_id for ad groups and CBO campaigns.');
 }else{
  if(d.campaign_id!==undefined||d.ad_group_id!==undefined||d.type!==undefined)fail('A review cannot change an existing resource parent or type.');
  if(route.kind==='saved_audiences'){
   if(Object.keys(d).some(k=>!['name','targeting','status'].includes(k))||d.status!==undefined&&d.status!=='DELETED')fail('Saved-audience updates support name/targeting or status DELETED.');
  }
 }
 if(d.configured_status!==undefined&&!['ACTIVE','PAUSED','ARCHIVED','DELETED'].includes(d.configured_status))fail('Use a documented configured_status.');
 for(const k of ['bid_value','goal_value','spend_cap'])if(d[k]!==undefined&&d[k]!==null&&(!Number.isSafeInteger(d[k])||d[k]<0))fail(k+' must use a nonnegative safe integer in native provider units.');
 for(const k of ['campaign_id','ad_group_id','post_id','profile_id','saved_audience_id','funding_instrument_id','conversion_pixel_id'])if(d[k]!==undefined&&d[k]!==null&&!identifier(d[k]))fail(k+' must be an existing native identifier.');
}
export function assertRedditWriteScopes(connection:Connection){
 if(!['adsread','adsedit'].every(s=>connection.scopes.includes(s)))throw new MirrorError('INSUFFICIENT_SCOPE','Reddit review and execution require adsread and adsedit on the selected connection.',{},403);
}
export function redditSnapshots(plan:CompiledRequest):CompiledRequest[]{
 const route=redditWriteKind(plan)!,d=(plan.body as JsonObject).data;
 const read=(path:string):CompiledRequest=>({...plan,action:'AMCP_STATE_READ',path,method:'GET',body:undefined,query:{},headers:{},readOnly:true,destructive:false,requiresConfirmation:false});
 const reads=[read('/api/v3/ad_accounts/'+plan.accountId)];if(!route.create)reads.push(read(plan.path));
 const parents:Record<string,string>={campaign_id:'campaigns',ad_group_id:'ad_groups',post_id:'posts',profile_id:'profiles',saved_audience_id:'saved_audiences'};
 for(const [field,kind]of Object.entries(parents))if(d[field])reads.push(read('/api/v3/'+kind+'/'+d[field]));
 if(d.funding_instrument_id)reads.push({...read('/api/v3/ad_accounts/'+plan.accountId+'/funding_instruments'),query:{funding_instrument_ids:d.funding_instrument_id,mode:'ALL'}});
 return reads;
}
export function validateRedditState(plan:CompiledRequest,result:TransportResult){
 const target=plan.path.split('/').at(-1),kind=plan.path.split('/').at(-2),d=(result.data as JsonObject)?.data;
 if(target==='funding_instruments'){
  if(result.status!==200||!Array.isArray(d)||d.length!==1||d[0]?.id!==plan.query.funding_instrument_ids||d[0]?.ad_account_id!==undefined&&d[0].ad_account_id!==plan.accountId)throw new MirrorError('STATE_TARGET_MISMATCH','Reddit did not return the selected account funding instrument.',{},502);
  return;
 }
 if(result.status!==200||!object(d)||d.id!==target||d.ad_account_id!==undefined&&d.ad_account_id!==plan.accountId||kind==='ad_accounts'&&d.id!==plan.accountId)throw new MirrorError('STATE_TARGET_MISMATCH','Reddit did not return the exact scoped resource.',{},502);
 if(kinds.includes(kind!)&&d.ad_account_id!==plan.accountId)throw new MirrorError('STATE_TARGET_MISMATCH','Reddit state must confirm the resource account.',{},502);
 if(kind==='saved_audiences'&&d.type!=='REDDIT_AUDIENCE')throw new MirrorError('WRITE_CONTRACT_UNAVAILABLE','Only saved Reddit targeting audiences are qualified. Customer-list and retargeting ingestion remain separate.');
 if(d.type==='AUTOMATED'||d.type==='DYNAMIC_CREATIVE_AD_TEMPLATE'||d.is_max===true)throw new MirrorError('WRITE_CONTRACT_UNAVAILABLE','Reddit Max state is outside the reviewed contract.');
}
export function redditOutcome(plan:CompiledRequest,result:TransportResult){
 const route=redditWriteKind(plan),d=(result.data as JsonObject)?.data,b=(plan.body as JsonObject)?.data;if(!route||result.status!==(route.create?201:200)||!object(d)||!identifier(d.id)||d.ad_account_id!==plan.accountId)return false;
 if(!route.create&&d.id!==route.target)return false;
 for(const field of ['campaign_id','ad_group_id','post_id'])if(b[field]!==undefined&&d[field]!==b[field])return false;
 return b.configured_status===undefined||d.configured_status===b.configured_status;
}
