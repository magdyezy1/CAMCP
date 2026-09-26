import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * Paused Upgraded Smart+ website-conversion ad groups (API for Business v1.3, checked 2026-09-26). TikTok enables
 * new ad groups by default, ignores ad group budgets under campaign budget optimization, silently ignores targeting
 * fields that do not match the targeting mode, and reads targeting back with defaults added.
 */
const TIKTOK='20202020-2020-4202-8202-202020202020',gateway='tiktok_native_action',account='123';
const actor={tenantId:'tiktok-smart-plus-adgroups',userId:'operator',role:'operator'},owner={...actor,role:'admin'},key=Buffer.alloc(32,77).toString('base64');
const adgroup=(extra={},spec)=>({request_id:'810200300400',campaign_id:'80',operation_status:'DISABLE',adgroup_name:'Smart+ KSA signups',promotion_type:'WEBSITE',optimization_goal:'CONVERT',pixel_id:'7001',optimization_event:'ON_WEB_REGISTER',
 bid_type:'BID_TYPE_NO_BID',billing_event:'OCPM',targeting_optimization_mode:'AUTOMATIC',targeting_spec:spec??{location_ids:['102358','290557'],spc_audience_age:'OVER_EIGHTEEN',languages:['ar','en'],excluded_audience_ids:['501']},
 schedule_type:'SCHEDULE_FROM_NOW',schedule_start_time:'2026-10-01 00:00:00',...extra});
const manual=(extra={})=>adgroup({campaign_id:'81',targeting_optimization_mode:'MANUAL',budget_mode:'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',budget:120,custom_conversion_id:'8800001',bid_type:'BID_TYPE_CUSTOM',conversion_bid_price:35.5,
 placement_type:'PLACEMENT_TYPE_NORMAL',placements:['PLACEMENT_TIKTOK','PLACEMENT_PANGLE'],click_attribution_window:'SEVEN_DAYS',view_attribution_window:'ONE_DAY',dayparting:'1'.repeat(336),...extra},
 {location_ids:['102358'],age_groups:['AGE_25_34','AGE_35_44'],gender:'GENDER_UNLIMITED',audience_ids:['500'],interest_category_ids:['14','16'],operating_systems:['ANDROID'],device_price_ranges:[0,1000],
  actions:[{action_scene:'VIDEO_RELATED',action_period:7,action_category_ids:['2'],video_user_actions:['LIKED','SHARED']}]});
const campaigns={80:{campaign_id:'80',campaign_name:'CBO web',objective_type:'WEB_CONVERSIONS',sales_destination:'WEBSITE',budget_optimize_on:true,budget_mode:'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',budget:500,operation_status:'DISABLE',catalog_enabled:false,is_search_campaign:false},
 81:{campaign_id:'81',campaign_name:'Ad group budgets web',objective_type:'WEB_CONVERSIONS',sales_destination:'WEBSITE',budget_optimize_on:false,budget_mode:'BUDGET_MODE_INFINITE',budget:0,operation_status:'DISABLE',catalog_enabled:false,is_search_campaign:false},
 82:{campaign_id:'82',campaign_name:'Daily limit web',objective_type:'WEB_CONVERSIONS',sales_destination:'WEBSITE',budget_optimize_on:false,budget_mode:'BUDGET_MODE_DAY',budget:900,operation_status:'DISABLE',catalog_enabled:false,is_search_campaign:false},
 83:{campaign_id:'83',campaign_name:'Leads',objective_type:'LEAD_GENERATION',budget_optimize_on:true,budget_mode:'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',budget:300,operation_status:'DISABLE'},
 84:{campaign_id:'84',campaign_name:'Catalog web',objective_type:'WEB_CONVERSIONS',sales_destination:'WEBSITE',catalog_enabled:true,budget_optimize_on:true,budget_mode:'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',budget:300,operation_status:'DISABLE'}};
const pixels={7001:{pixel_id:'7001',pixel_code:'C7001',pixel_name:'Site pixel',asset_ownership:{ownership_status:true}},7005:{pixel_id:'7005',pixel_code:'C7005',pixel_name:'Agency pixel',asset_ownership:{ownership_status:false,asset_relation_status:'SHARED'}},
 7006:{pixel_id:'7006',pixel_code:'C7006',pixel_name:'Old pixel',asset_ownership:{ownership_status:false,asset_relation_status:'UNBOUND'}}};
const conversions={8800001:{custom_conversion_id:'8800001',event_source_type:'PIXEL',event_source_id:'7001',optimization_event:'ON_WEB_REGISTER',name:'Signup',rules:[],activity_status:'ACTIVE'},
 8800002:{custom_conversion_id:'8800002',event_source_type:'PIXEL',event_source_id:'7001',optimization_event:'ON_WEB_REGISTER',name:'New signup',rules:[],activity_status:'WAITING_FOR_ACTIVITY'}};
const audiences={500:{audience_id:'500',type:'Customer File',is_creator:true,is_valid:true,cover_num:5000},501:{audience_id:'501',type:'Engagement',is_creator:true,is_valid:true,cover_num:800},502:{audience_id:'502',type:'Customer File',is_creator:false,is_valid:true,cover_num:4000}};
function fixture({readDrift}={}){
 const store=new Store(':memory:',key),connection={id:TIKTOK,tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic TikTok',scopes:[]};
 store.putConnection(owner,connection,{accessToken:'synthetic'});
 const groups=new Map(),requests=[],writes=[];let n=0,mode='';
 const ok=data=>Response.json({code:0,message:'OK',request_id:'r'+ ++n,data});
 const transport=new NativeTransport(async(raw,init={})=>{
  const url=new URL(String(raw)),path=url.pathname.replace(/^\/open_api/,''),method=init.method??'GET',q=k=>url.searchParams.get(k);requests.push(method+' '+path);
  const filter=()=>JSON.parse(q('filtering'));
  if(method==='GET'&&path==='/v1.3/advertiser/info/')return ok({list:[{advertiser_id:account,name:'Synthetic advertiser',currency:'SAR',timezone:'Asia/Riyadh',status:'STATUS_ENABLE'}]});
  if(method==='GET'&&path==='/v1.3/smart_plus/campaign/get/'){const list=filter().campaign_ids.filter(id=>campaigns[id]).map(id=>structuredClone(campaigns[id]));return ok({list,page_info:{page:1,page_size:100,total_number:list.length,total_page:1}});}
  if(method==='GET'&&path==='/v1.3/pixel/list/'){const p=pixels[q('pixel_id')];return ok({pixels:p?[structuredClone(p)]:[],page_info:{page:1,page_size:10,total_number:p?1:0,total_page:1}});}
  if(method==='GET'&&path==='/v1.3/custom_conversion/get/'){const c=conversions[q('custom_conversion_id')];if(!c||c.event_source_id!==q('event_source_id'))return Response.json({code:40001,message:'Not found',request_id:'r'+ ++n,data:{}});return ok(structuredClone(c));}
  if(method==='GET'&&path==='/v1.3/dmp/custom_audience/get/'){const ids=JSON.parse(q('custom_audience_ids'));return ok({list:ids.filter(id=>audiences[id]).map(id=>({audience_details:{...audiences[id]},audience_history:[]}))});}
  if(method==='POST'&&path==='/v1.3/smart_plus/adgroup/create/'){
   const b=JSON.parse(init.body);writes.push(b);const {advertiser_id,request_id,...stored}=b;const spec=structuredClone(b.targeting_spec);
   // TikTok returns targeting with defaults, lists in its own order and price ranges in steps of 50.
   const read={...stored,adgroup_id:'9100000000000001',campaign_name:campaigns[b.campaign_id]?.campaign_name,targeting_optimization_mode:b.targeting_optimization_mode??'AUTOMATIC',
    targeting_spec:{brand_safety_type:'STANDARD_INVENTORY',spending_power:'ALL',...spec,location_ids:[...spec.location_ids].reverse(),...(spec.device_price_ranges?{device_price_ranges:Array.from({length:(spec.device_price_ranges[1]-spec.device_price_ranges[0])/50+1},(_,i)=>spec.device_price_ranges[0]+i*50)}:{})},
    ...(b.placements?{placements:[...b.placements].reverse()}:{placement_type:b.placement_type??'PLACEMENT_TYPE_AUTOMATIC',placements:['PLACEMENT_TIKTOK']}),budget_mode:b.budget_mode??'BUDGET_MODE_INFINITE',budget:b.budget??0,
    pacing:'PACING_MODE_SMOOTH',create_time:'2026-09-26 14:00:00',modify_time:'2026-09-26 14:00:00'};
   groups.set(read.adgroup_id,read);
   if(mode==='lost')throw new Error('Synthetic accepted response lost');
   return mode==='error'?Response.json({code:40002,message:'Invalid location',request_id:'r'+ ++n,data:{}}):ok(structuredClone(read));
  }
  if(method==='GET'&&path==='/v1.3/smart_plus/adgroup/get/'){const list=filter().adgroup_ids.filter(id=>groups.has(id)).map(id=>readDrift?readDrift(structuredClone(groups.get(id))):structuredClone(groups.get(id)));return ok({list,page_info:{page:1,page_size:100,total_number:list.length,total_page:1}});}
  throw new Error('Unexpected TikTok request '+method+' '+path);
 });
 const start=()=>new MirrorService(new Registry(),store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 let service=start();
 const call=(tool,input)=>service.call(tool,input,actor);
 const args=(payload,action='tiktok_smart_plus_adgroup_create')=>({action,account_id:account,payload});
 const prepare=payload=>call('amcp_write',{action:'prepare',gateway,connection_id:TIKTOK,arguments:args(payload)});
 const execute=(id,extra={spend_change_confirmed:true})=>call('amcp_write',{action:'execute',review_id:id,idempotency_key:id,confirmed:true,...extra});
 const verify=id=>call('amcp_campaign',{action:'verify',review_id:id});
 return {store,groups,requests,writes,call,args,prepare,execute,verify,mode:v=>{mode=v;},restart:()=>{service=start();}};
}

test('paused Smart+ ad group creation is a reviewed TikTok family; ad appeals stay blocked',async()=>{
 const f=fixture();try{
  const r=await f.call('amcp_write',{action:'inspect',gateway,connection_id:TIKTOK,arguments:f.args(adgroup())});assert.equal(r.data.review_contract_supported,true,JSON.stringify(r));
  const u=await f.call('amcp_write',{action:'inspect',gateway,connection_id:TIKTOK,arguments:f.args({smart_plus_ad_id:'9200000000000001'},'tiktok_smart_plus_ad_appeal')});
  assert.notEqual(u.data?.review_contract_supported,true,JSON.stringify(u));assert.equal(f.requests.length,0);
 }finally{f.store.close();}
});

test('only documented paused website conversion ad groups are accepted, before any request',async()=>{
 const f=fixture();try{
  const drop=k=>{const v=adgroup();delete v[k];return v;},spec=s=>adgroup({},{location_ids:['102358'],...s});
  const cases={'no request_id':drop('request_id'),'enabled':adgroup({operation_status:'ENABLE'}),'default status':drop('operation_status'),'app promotion':adgroup({promotion_type:'APP_ANDROID'}),'click goal':adgroup({optimization_goal:'CLICK'}),
   'no pixel':drop('pixel_id'),'page view':adgroup({optimization_event:'PAGE_VIEW'}),'cost cap without price':adgroup({bid_type:'BID_TYPE_CUSTOM'}),'price without cost cap':adgroup({conversion_bid_price:10}),'CPC billing':adgroup({billing_event:'CPC'}),
   'click window alone':adgroup({click_attribution_window:'SEVEN_DAYS'}),'mini game window':adgroup({click_attribution_window:'THIRTY_DAYS',view_attribution_window:'ONE_DAY'}),
   'manual field in automatic':spec({age_groups:['AGE_25_34']}),'suggestions in manual':adgroup({targeting_optimization_mode:'MANUAL',suggestion_audience_enabled:true}),'all ages':spec({spc_audience_age:'ALL'}),
   'teen targeting':adgroup({targeting_optimization_mode:'MANUAL'},{location_ids:['102358'],age_groups:['AGE_13_17']}),'zip codes':spec({zipcode_ids:['1']}),'no locations':adgroup({},{languages:['en']}),
   'budget without mode':adgroup({budget:100}),'lifetime from now':adgroup({budget_mode:'BUDGET_MODE_TOTAL',budget:1000}),'start format':adgroup({schedule_start_time:'2026-10-01T00:00:00Z'}),
   'end before start':adgroup({schedule_type:'SCHEDULE_START_END',schedule_end_time:'2026-09-30 00:00:00'}),'end with from now':adgroup({schedule_end_time:'2026-12-01 00:00:00'}),'dayparting length':adgroup({dayparting:'1'.repeat(335)}),
   'placements with automatic':adgroup({placements:['PLACEMENT_TIKTOK']}),'global bundle':adgroup({placement_type:'PLACEMENT_TYPE_NORMAL',placements:['PLACEMENT_GLOBAL_APP_BUNDLE']}),'deep funnel':adgroup({deep_funnel_optimization_status:'ON'})};
  for(const [name,payload] of Object.entries(cases)){const r=await f.prepare(payload);assert.equal(r.error?.code,'INVALID_TIKTOK_SMART_PLUS_ADGROUP',name+': '+JSON.stringify(r.error??r.data).slice(0,300));}
  assert.equal(f.requests.length,0);
 }finally{f.store.close();}
});

test('an automatic-targeting ad group in a campaign-budget campaign is created once and verifies',async()=>{
 const f=fixture();try{
  const p=await f.prepare(adgroup());assert.equal(p.success,true,JSON.stringify(p));
  assert.deepEqual(p.data.state_reads.map(r=>r.path),['/v1.3/advertiser/info/','/v1.3/smart_plus/campaign/get/','/v1.3/pixel/list/','/v1.3/dmp/custom_audience/get/']);
  const impact=p.data.creative_impact;assert.equal(impact.scope,'smart_plus_adgroups');assert.equal(impact.may_affect_serving,false);assert.match(impact.adgroup.budget,/campaign budget/);
  assert.equal((await f.execute(p.data.review_id,{})).error?.code,'SPEND_CONFIRMATION_REQUIRED');assert.equal(f.writes.length,0);
  const done=await f.execute(p.data.review_id);assert.equal(done.success,true,JSON.stringify(done));
  assert.equal(f.writes.length,1);const {advertiser_id,...sent}=f.writes[0];assert.deepEqual(sent,adgroup());
  const v=await f.verify(p.data.review_id);assert.equal(v.data.status,'verified',JSON.stringify(v));assert.equal(v.data.checks[0].resource_id,'9100000000000001');
  assert.equal((await f.execute(p.data.review_id)).data.replayed,true);assert.equal(f.writes.length,1);
 }finally{f.store.close();}
});

test('a manual-targeting ad group with its own budget, cost cap, custom conversion and selected placements verifies',async()=>{
 const f=fixture();try{
  const p=await f.prepare(manual());assert.equal(p.success,true,JSON.stringify(p));
  assert.ok(p.data.state_reads.some(r=>r.path==='/v1.3/custom_conversion/get/'));
  assert.deepEqual(p.data.creative_impact.adgroup.budget,{mode:'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',amount:120});
  assert.equal((await f.execute(p.data.review_id)).success,true);
  const v=await f.verify(p.data.review_id);assert.equal(v.data.status,'verified',JSON.stringify(v));
 }finally{f.store.close();}
});

test('campaign budgets, schedules, pixels, custom conversions and audiences are checked before any write',async()=>{
 const f=fixture();try{
  const cases=[['budget under campaign budget',adgroup({budget_mode:'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',budget:100}),'INVALID_TIKTOK_SMART_PLUS_ADGROUP',/ignores ad group budgets/],
   ['no budget without campaign budget',adgroup({campaign_id:'81'}),'INVALID_TIKTOK_SMART_PLUS_ADGROUP',/needs budget_mode/],
   ['lifetime under daily limit',adgroup({campaign_id:'82',budget_mode:'BUDGET_MODE_TOTAL',budget:900,schedule_type:'SCHEDULE_START_END',schedule_end_time:'2026-12-01 00:00:00'}),'INVALID_TIKTOK_SMART_PLUS_ADGROUP',/DYNAMIC_DAILY/],
   ['lead campaign',adgroup({campaign_id:'83'}),'INVALID_TIKTOK_SMART_PLUS_ADGROUP',/website conversion campaign/],['catalog campaign',adgroup({campaign_id:'84'}),'INVALID_TIKTOK_SMART_PLUS_ADGROUP',/website conversion campaign/],
   ['missing campaign',adgroup({campaign_id:'89'}),'STATE_TARGET_MISMATCH',/./],['unbound pixel',adgroup({pixel_id:'7006'}),'INVALID_TIKTOK_SMART_PLUS_ADGROUP',/unbound/],['missing pixel',adgroup({pixel_id:'7009'}),'STATE_TARGET_MISMATCH',/./],
   ['waiting conversion',adgroup({custom_conversion_id:'8800002'}),'INVALID_TIKTOK_SMART_PLUS_ADGROUP',/ACTIVE or NO_RECENT_ACTIVITY/],['conversion event',adgroup({custom_conversion_id:'8800001',optimization_event:'SHOPPING'}),'INVALID_TIKTOK_SMART_PLUS_ADGROUP',/optimization_event/],
   ['shared audience',adgroup({},{location_ids:['102358'],excluded_audience_ids:['502']}),'INVALID_TIKTOK_SMART_PLUS_ADGROUP',/shared/]];
  for(const [name,payload,code,pattern] of cases){const r=await f.prepare(payload);assert.equal(r.error?.code,code,name+' '+JSON.stringify(r).slice(0,300));assert.match(r.error.message,pattern,name);}
  const shared=await f.prepare(adgroup({pixel_id:'7005'},{location_ids:['102358']}));assert.equal(shared.success,true,'a shared pixel can be used: '+JSON.stringify(shared));assert.equal(shared.data.creative_impact.adgroup.pixel.owned,false);
  assert.equal(f.writes.length,0);
 }finally{f.store.close();}
});

test('a drifted read-back is inconclusive; rejected or lost creations are never resubmitted',async()=>{
 for(const [name,drift,field] of [['enabled',r=>({...r,operation_status:'ENABLE'}),'/operation_status'],['locations',r=>({...r,targeting_spec:{...r.targeting_spec,location_ids:['102358']}}),'/targeting_spec/location_ids']]){
  const f=fixture({readDrift:drift});try{
   const p=await f.prepare(adgroup());await f.execute(p.data.review_id);const v=await f.verify(p.data.review_id);
   assert.equal(v.data.status,'inconclusive',name+' '+JSON.stringify(v));assert.deepEqual(v.data.checks[0].changed_fields,[field],name);
  }finally{f.store.close();}
 }
 for(const [mode,first,again] of [['error','PLATFORM_ERROR','WRITE_OUTCOME_UNCERTAIN'],['lost','WRITE_OUTCOME_UNCERTAIN','WRITE_OUTCOME_UNCERTAIN']]){const f=fixture();try{
  const p=await f.prepare(adgroup());f.mode(mode);assert.equal((await f.execute(p.data.review_id)).error?.code,first,mode);f.mode('');f.restart();
  assert.equal((await f.execute(p.data.review_id)).error?.code,again,mode);assert.equal(f.writes.length,1,mode);
 }finally{f.store.close();}}
 const g=fixture();try{
  const p=await g.prepare(adgroup());const results=await Promise.all([g.execute(p.data.review_id),g.execute(p.data.review_id)]);
  assert.ok(results.some(r=>r.success));assert.equal(g.writes.length,1);g.restart();assert.equal((await g.execute(p.data.review_id)).data.replayed,true);
 }finally{g.store.close();}
});
