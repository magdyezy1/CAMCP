import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * Paused Upgraded Smart+ Instant Form lead generation ad groups (API for Business v1.3, checked 2026-09-26). They use
 * no pixel; TikTok reads them back with its own defaults (optimization_event FORM and attribution windows).
 */
const TIKTOK='28282828-2828-4282-8282-282828282828',gateway='tiktok_native_action',account='123';
const actor={tenantId:'tiktok-smart-plus-lead-adgroups',userId:'operator',role:'operator'},owner={...actor,role:'admin'},key=Buffer.alloc(32,87).toString('base64');
const lead=(extra={})=>({request_id:'820200300400',campaign_id:'85',operation_status:'DISABLE',adgroup_name:'Smart+ lead forms',promotion_type:'LEAD_GENERATION',promotion_target_type:'INSTANT_PAGE',optimization_goal:'LEAD_GENERATION',
 bid_type:'BID_TYPE_CUSTOM',conversion_bid_price:12.5,billing_event:'OCPM',targeting_optimization_mode:'AUTOMATIC',targeting_spec:{location_ids:['1562822'],spc_audience_age:'OVER_EIGHTEEN'},
 schedule_type:'SCHEDULE_START_END',schedule_start_time:'2026-10-01 00:00:00',schedule_end_time:'2026-10-31 00:00:00',placement_type:'PLACEMENT_TYPE_NORMAL',placements:['PLACEMENT_TIKTOK','PLACEMENT_GLOBAL_APP_BUNDLE'],...extra});
const campaigns={85:{campaign_id:'85',objective_type:'LEAD_GENERATION',budget_optimize_on:true,budget_mode:'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',budget:300,operation_status:'DISABLE',catalog_enabled:false,is_search_campaign:false},
 86:{campaign_id:'86',objective_type:'LEAD_GENERATION',budget_optimize_on:false,budget_mode:'BUDGET_MODE_INFINITE',budget:0,operation_status:'DISABLE',catalog_enabled:false,is_search_campaign:false},
 87:{campaign_id:'87',objective_type:'LEAD_GENERATION',budget_optimize_on:true,budget_mode:'BUDGET_MODE_TOTAL',budget:3000,operation_status:'DISABLE',catalog_enabled:false,is_search_campaign:false},
 80:{campaign_id:'80',objective_type:'WEB_CONVERSIONS',sales_destination:'WEBSITE',budget_optimize_on:true,budget_mode:'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',budget:500,operation_status:'DISABLE',catalog_enabled:false,is_search_campaign:false}};
function fixture(){
 const store=new Store(':memory:',key),connection={id:TIKTOK,tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic TikTok',scopes:[]};
 store.putConnection(owner,connection,{accessToken:'synthetic'});
 const groups=new Map(),requests=[],writes=[];let n=0,mode='';
 const ok=data=>Response.json({code:0,message:'OK',request_id:'r'+ ++n,data});
 const transport=new NativeTransport(async(raw,init={})=>{
  const url=new URL(String(raw)),path=url.pathname.replace(/^\/open_api/,''),method=init.method??'GET';requests.push(method+' '+path);
  const filter=()=>JSON.parse(url.searchParams.get('filtering'));
  if(method==='GET'&&path==='/v1.3/advertiser/info/')return ok({list:[{advertiser_id:account,name:'Synthetic advertiser',currency:'SAR',status:'STATUS_ENABLE'}]});
  if(method==='GET'&&path==='/v1.3/smart_plus/campaign/get/'){const list=filter().campaign_ids.filter(id=>campaigns[id]).map(id=>structuredClone(campaigns[id]));return ok({list,page_info:{page:1,page_size:100,total_number:list.length,total_page:1}});}
  if(method==='POST'&&path==='/v1.3/smart_plus/adgroup/create/'){
   const b=JSON.parse(init.body);writes.push(b);const {advertiser_id,request_id,...stored}=b;
   // TikTok's documented read-back for Instant Form ad groups adds a form event, attribution defaults and targeting defaults.
   const read={...stored,adgroup_id:'9200000000000001',optimization_event:'FORM',click_attribution_window:'SEVEN_DAYS',view_attribution_window:'ONE_DAY',attribution_event_count:'ONCE',
    targeting_spec:{brand_safety_type:'EXPANDED_INVENTORY',gender:'GENDER_UNLIMITED',...b.targeting_spec},placements:b.placements?[...b.placements].reverse():undefined,budget_mode:b.budget_mode??'BUDGET_MODE_INFINITE',budget:b.budget??0};
   groups.set(read.adgroup_id,read);
   if(mode==='lost')throw new Error('Synthetic accepted response lost');
   return ok(structuredClone(read));
  }
  if(method==='GET'&&path==='/v1.3/smart_plus/adgroup/get/'){const list=filter().adgroup_ids.filter(id=>groups.has(id)).map(id=>structuredClone(groups.get(id)));return ok({list,page_info:{page:1,page_size:100,total_number:list.length,total_page:1}});}
  throw new Error('Unexpected TikTok request '+method+' '+path);
 });
 const service=new MirrorService(new Registry(),store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 const call=(tool,input)=>service.call(tool,input,actor);
 const prepare=payload=>call('amcp_write',{action:'prepare',gateway,connection_id:TIKTOK,arguments:{action:'tiktok_smart_plus_adgroup_create',account_id:account,payload}});
 const execute=(id,extra={spend_change_confirmed:true})=>call('amcp_write',{action:'execute',review_id:id,idempotency_key:id,confirmed:true,...extra});
 const verify=id=>call('amcp_campaign',{action:'verify',review_id:id});
 return {store,requests,writes,prepare,execute,verify,mode:v=>{mode=v;}};
}

test('an Instant Form lead generation ad group reads its advertiser and campaign but no pixel, is created paused once and verifies despite TikTok defaults',async()=>{
 const f=fixture();try{
  const p=await f.prepare(lead());assert.equal(p.success,true,JSON.stringify(p).slice(0,500));
  assert.deepEqual(p.data.state_reads.map(r=>r.path),['/v1.3/advertiser/info/','/v1.3/smart_plus/campaign/get/'],'no pixel read');
  assert.match(p.data.creative_impact.effect,/Instant Form lead generation ad group/);assert.equal(p.data.creative_impact.adgroup.pixel,null);
  assert.equal((await f.execute(p.data.review_id,{})).error?.code,'SPEND_CONFIRMATION_REQUIRED');
  assert.equal((await f.execute(p.data.review_id)).success,true);assert.equal(f.writes.length,1);
  const v=await f.verify(p.data.review_id);assert.equal(v.data.status,'verified',JSON.stringify(v).slice(0,600));
  assert.equal((await f.execute(p.data.review_id)).data.replayed,true);assert.equal(f.writes.length,1);
 }finally{f.store.close();}
});

test('lead and website fields stay apart, before any request',async()=>{
 const f=fixture();try{
  const cases={'no target type':[lead({promotion_target_type:undefined}),'promotion_target_type'],'website target':[lead({promotion_target_type:'EXTERNAL_WEBSITE'}),'promotion_target_type'],'conversion goal':[lead({optimization_goal:'CONVERT'}),'promotion_target_type'],
   'pixel':[lead({pixel_id:'7001'}),'pixel_id'],'form event':[lead({optimization_event:'FORM'}),'optimization_event'],'attribution window':[lead({click_attribution_window:'SEVEN_DAYS',view_attribution_window:'ONE_DAY'}),'click_attribution_window'],
   'unknown placement':[lead({placements:['PLACEMENT_TIKTOK','PLACEMENT_UNKNOWN']}),'placements']};
  for(const [label,[payload,field]] of Object.entries(cases)){const r=await f.prepare(JSON.parse(JSON.stringify(payload)));assert.equal(r.error?.code,'INVALID_TIKTOK_SMART_PLUS_ADGROUP',label+': '+JSON.stringify(r.error??r.data).slice(0,300));assert.equal(r.error.details?.field,field,label);}
  const web=await f.prepare({...lead(),promotion_type:'WEBSITE',optimization_goal:'CONVERT',pixel_id:'7001',optimization_event:'ON_WEB_REGISTER',campaign_id:'80'});assert.equal(web.error?.code,'INVALID_TIKTOK_SMART_PLUS_ADGROUP');assert.equal(web.error.details?.field,'promotion_target_type');
  assert.equal(f.requests.length,0);
 }finally{f.store.close();}
});

test('the campaign must be a lead generation campaign and a target CPA needs a daily budget',async()=>{
 const f=fixture();try{
  for(const [payload,message] of [[lead({campaign_id:'80'}),/not a lead generation campaign/],[lead({campaign_id:'87'}),/target CPA/],[lead({budget_mode:'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',budget:50}),/campaign budget optimization/],[lead({campaign_id:'86'}),/needs budget_mode and budget/]]){
   const r=await f.prepare(payload);assert.equal(r.error?.code,'INVALID_TIKTOK_SMART_PLUS_ADGROUP',JSON.stringify(r.error));assert.match(r.error.message,message);
  }
  const own=await f.prepare(lead({campaign_id:'86',budget_mode:'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',budget:50}));assert.equal(own.success,true,JSON.stringify(own).slice(0,400));
  const maxDelivery=await f.prepare(lead({campaign_id:'87',bid_type:'BID_TYPE_NO_BID',conversion_bid_price:undefined}));assert.equal(maxDelivery.success,true,JSON.stringify(maxDelivery).slice(0,400));
  assert.equal(f.writes.length,0);
 }finally{f.store.close();}
});

test('a lost lead ad group response is never resubmitted',async()=>{
 const f=fixture();try{
  const p=await f.prepare(lead());f.mode('lost');assert.equal((await f.execute(p.data.review_id)).error?.code,'WRITE_OUTCOME_UNCERTAIN');f.mode('');
  assert.equal((await f.execute(p.data.review_id)).error?.code,'WRITE_OUTCOME_UNCERTAIN');assert.equal(f.writes.length,1);
 }finally{f.store.close();}
});
