import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * Dynamic call-to-action portfolios (API for Business v1.3, checked 2026-09-26): groups of recommended CTAs, and
 * manual ads that name a portfolio through call_to_action_id. TikTok reads CTA text back in its own form ("learn_more").
 */
const TIKTOK='22222222-2222-4222-8222-222222222222',gateway='tiktok_native_action',account='123';
const actor={tenantId:'tiktok-cta-portfolios',userId:'operator',role:'operator'},owner={...actor,role:'admin'},key=Buffer.alloc(32,79).toString('base64');
const groups=()=>[{asset_content:'Learn more',asset_ids:['201781','201535']},{asset_content:'Shop now',asset_ids:['201902','201404']}];
const portfolio=(extra={})=>({advertiser_id:account,creative_portfolio_type:'CTA',portfolio_content:groups(),...extra});
const creative=(extra={})=>({ad_name:'Dynamic CTA ad',operation_status:'DISABLE',ad_format:'SINGLE_VIDEO',video_id:'v10',identity_type:'TT_USER',identity_id:'7000000000000000001',ad_text:'Synthetic text',landing_page_url:'https://example.test/',...extra});
function fixture({readBack}={}){
 const store=new Store(':memory:',key),connection={id:TIKTOK,tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic TikTok',scopes:[]};
 store.putConnection(owner,connection,{accessToken:'synthetic'});
 // 700 is a CTA portfolio read back as documented (no ID or type, TikTok's CTA keys); 701 is a display card; 702 reads back empty.
 const portfolios={700:{portfolio_content:[{asset_ids:['201902','201404'],asset_content:'download_now'}]},701:{creative_portfolio_id:'701',creative_portfolio_type:'CARD',portfolio_content:[{card_type:'IMAGE',image_id:'img-1'}]},702:{}};
 const requests=[],writes=[],ads={};let n=0,mode='';
 const ok=data=>Response.json({code:0,message:'OK',request_id:'r'+ ++n,data});
 const transport=new NativeTransport(async(raw,init={})=>{
  const url=new URL(String(raw)),path=url.pathname.replace(/^\/open_api/,''),method=init.method??'GET';requests.push(method+' '+path);
  if(method==='GET'&&path==='/v1.3/advertiser/info/')return ok({list:[{advertiser_id:account,name:'Synthetic advertiser',status:'STATUS_ENABLE'}]});
  if(method==='GET'&&path==='/v1.3/creative/portfolio/get/'){
   const p=portfolios[url.searchParams.get('creative_portfolio_id')];
   return p?ok(readBack?readBack(structuredClone(p)):structuredClone(p)):Response.json({code:40002,message:'Creative portfolio does not exist',request_id:'r'+ ++n,data:{}});
  }
  if(method==='POST'&&path==='/v1.3/creative/portfolio/create/'){
   const b=JSON.parse(init.body);writes.push(b);const id=String(9100+writes.length);
   // TikTok stores its own CTA keys and returns groups and IDs in its own order.
   portfolios[id]={portfolio_content:b.portfolio_content.map(g=>({asset_ids:[...g.asset_ids].reverse(),asset_content:g.asset_content.toLowerCase().replaceAll(' ','_')})).reverse()};
   if(mode==='lost')throw new Error('Synthetic accepted response lost');
   return mode==='error'?Response.json({code:40002,message:'Invalid CTA asset',request_id:'r'+ ++n,data:{}}):ok({creative_portfolio_id:id});
  }
  if(method==='GET'&&path==='/v1.3/adgroup/get/')return ok({list:[{adgroup_id:'200',advertiser_id:account,operation_status:'DISABLE'}]});
  if(method==='GET'&&path==='/v1.3/ad/get/'){const ids=JSON.parse(url.searchParams.get('filtering')).ad_ids;return ok({list:ids.filter(id=>ads[id]).map(id=>structuredClone(ads[id]))});}
  if(method==='POST'&&path==='/v1.3/ad/create/'){const b=JSON.parse(init.body);writes.push(b);ads['400']={...b.creatives[0],adgroup_id:b.adgroup_id,advertiser_id:account,ad_id:'400'};return ok({ad_ids:['400']});}
  throw new Error('Unexpected TikTok request '+method+' '+path);
 });
 const start=()=>new MirrorService(new Registry(),store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 let service=start();
 const call=(tool,input)=>service.call(tool,input,actor);
 const args=(payload,action='tiktok_creative_portfolio_create')=>({action,account_id:account,payload});
 const prepare=(payload,action)=>call('amcp_write',{action:'prepare',gateway,connection_id:TIKTOK,arguments:args(payload,action)});
 const execute=(id,extra={})=>call('amcp_write',{action:'execute',review_id:id,idempotency_key:id,confirmed:true,...extra});
 const verify=id=>call('amcp_campaign',{action:'verify',review_id:id});
 return {store,portfolios,requests,writes,call,args,prepare,execute,verify,mode:v=>{mode=v;},restart:()=>{service=start();}};
}

test('CTA portfolio creation is a reviewed TikTok family under both action names',async()=>{
 const f=fixture();try{
  for(const action of ['tiktok_creative_portfolio_create','tiktok_cta_portfolio_create']){const r=await f.call('amcp_write',{action:'inspect',gateway,connection_id:TIKTOK,arguments:f.args(portfolio(),action)});assert.equal(r.data.review_contract_supported,true,action+' '+JSON.stringify(r));}
  assert.equal(f.requests.length,0);
 }finally{f.store.close();}
});

test('only documented CTA groups are accepted, before any request',async()=>{
 const f=fixture();try{
  const g=(asset_content,asset_ids)=>({asset_content,asset_ids});
  const cases={'no type':[{advertiser_id:account,portfolio_content:groups()},'creative_portfolio_type'],'display card':[{advertiser_id:account,creative_portfolio_type:'CARD',portfolio_content:[{card_type:'IMAGE',image_id:'img-1'}]},'creative_portfolio_type'],
   'sticker field':[portfolio({sticker_param:{sticker_type:'COUNTDOWN'}}),'sticker_param'],'no groups':[portfolio({portfolio_content:[]}),'portfolio_content'],
   'too many groups':[portfolio({portfolio_content:Array.from({length:21},(_,i)=>g('CTA '+i,[String(202000+i)]))}),'portfolio_content'],'card field in a group':[portfolio({portfolio_content:[{...g('Learn more',['201781']),image_id:'img-1'}]}),'portfolio_content[0].image_id'],
   'blank text':[portfolio({portfolio_content:[g(' ',['201781'])]}),'portfolio_content[0].asset_content'],'numeric IDs':[portfolio({portfolio_content:[g('Learn more',[201781])]}),'portfolio_content[0].asset_ids'],'text ID':[portfolio({portfolio_content:[g('Learn more',['learn'])]}),'portfolio_content[0].asset_ids'],
   'no IDs':[portfolio({portfolio_content:[g('Learn more',[])]}),'portfolio_content[0].asset_ids'],'repeated ID':[portfolio({portfolio_content:[g('Learn more',['201781','201781'])]}),'portfolio_content[0].asset_ids'],
   'ID in two groups':[portfolio({portfolio_content:[g('Learn more',['201781']),g('Shop now',['201781'])]}),'portfolio_content[1].asset_ids'],'repeated text':[portfolio({portfolio_content:[g('Learn more',['201781']),g('learn_more',['201535'])]}),'portfolio_content[1].asset_content']};
  for(const [name,[payload,field]] of Object.entries(cases)){const r=await f.prepare(payload);assert.equal(r.error?.code,'INVALID_TIKTOK_CTA_PORTFOLIO',name+': '+JSON.stringify(r.error??r.data).slice(0,300));assert.equal(r.error.details?.field,field,name);}
  assert.equal((await f.prepare(portfolio({advertiser_id:'999'}))).error?.code,'ACCOUNT_SCOPE_MISMATCH');
  assert.equal(f.requests.length,0);
 }finally{f.store.close();}
});

test('a CTA portfolio reads only the advertiser, needs no spending confirmation, is created once and verifies against TikTok CTA keys',async()=>{
 const f=fixture();try{
  const p=await f.prepare(portfolio());assert.equal(p.success,true,JSON.stringify(p));
  assert.deepEqual(p.data.state_reads.map(r=>r.path),['/v1.3/advertiser/info/']);
  assert.equal(p.data.creative_impact.may_affect_serving,false);assert.deepEqual(p.data.creative_impact.portfolio.groups,[{asset_content:'Learn more',cta_ids:2},{asset_content:'Shop now',cta_ids:2}]);
  const x=await f.execute(p.data.review_id);assert.equal(x.success,true,JSON.stringify(x));assert.deepEqual(f.writes,[portfolio()]);
  const v=await f.verify(p.data.review_id);assert.equal(v.data.status,'verified',JSON.stringify(v));
  assert.equal((await f.execute(p.data.review_id)).data.replayed,true);assert.equal(f.writes.length,1);
 }finally{f.store.close();}
});

test('a read-back that lost a CTA or is not a CTA portfolio is inconclusive',async()=>{
 for(const [readBack,field] of [[p=>({...p,portfolio_content:p.portfolio_content.map((g,i)=>i===0?{...g,asset_ids:g.asset_ids.slice(1)}:g)}),'/portfolio_content'],[p=>({...p,creative_portfolio_type:'CARD'}),'/cta_portfolio']]){
  const f=fixture({readBack});try{
   const p=await f.prepare(portfolio());assert.equal((await f.execute(p.data.review_id)).success,true);
   const v=await f.verify(p.data.review_id);assert.equal(v.data.status,'inconclusive',JSON.stringify(v));assert.deepEqual(v.data.checks[0].changed_fields,[field]);
  }finally{f.store.close();}
 }
});

test('rejected or lost portfolio creations are never resubmitted; concurrent executions submit once',async()=>{
 for(const [mode,first,again] of [['error','PLATFORM_ERROR','WRITE_OUTCOME_UNCERTAIN'],['lost','WRITE_OUTCOME_UNCERTAIN','WRITE_OUTCOME_UNCERTAIN']]){const f=fixture();try{
  const p=await f.prepare(portfolio());f.mode(mode);assert.equal((await f.execute(p.data.review_id)).error?.code,first,mode);f.mode('');f.restart();
  assert.equal((await f.execute(p.data.review_id)).error?.code,again,mode);assert.equal(f.writes.length,1,mode);
 }finally{f.store.close();}}
 const g=fixture();try{
  const p=await g.prepare(portfolio());const results=await Promise.all([g.execute(p.data.review_id),g.execute(p.data.review_id)]);
  assert.ok(results.some(r=>r.success));assert.equal(g.writes.length,1);g.restart();assert.equal((await g.execute(p.data.review_id)).data.replayed,true);
 }finally{g.store.close();}
});

test('manual ads that name a CTA portfolio must reference an existing CTA portfolio in the advertiser',async()=>{
 const f=fixture();try{
  const ad=(extra,action='tiktok_ad_create')=>f.prepare({advertiser_id:account,adgroup_id:'200',creatives:[creative(extra)]},action);
  for(const [extra,field] of [[{call_to_action_id:'700',call_to_action:'LEARN_MORE'},'creatives[0].call_to_action'],[{call_to_action_id:'learn'},'creatives[0].call_to_action_id']]){
   const r=await ad(extra);assert.equal(r.error?.code,'INVALID_TIKTOK_CTA_PORTFOLIO',JSON.stringify(r.error));assert.equal(r.error.details?.field,field);
  }
  const update=await f.prepare({advertiser_id:account,adgroup_id:'200',creatives:[{ad_id:'400',...creative({call_to_action_id:'700',call_to_action:'LEARN_MORE'})}]},'tiktok_ad_update');
  assert.equal(update.error?.code,'INVALID_TIKTOK_CTA_PORTFOLIO',JSON.stringify(update.error));assert.equal(f.requests.length,0,'refused before any request');
  const card=await ad({call_to_action_id:'701'});assert.equal(card.error?.code,'INVALID_TIKTOK_CTA_PORTFOLIO',JSON.stringify(card));assert.match(card.error.message,/CARD portfolio/);
  assert.equal((await ad({call_to_action_id:'799'})).error?.code,'PLATFORM_ERROR','TikTok reports a missing portfolio');
  assert.equal((await ad({call_to_action_id:'702'})).error?.code,'STATE_TARGET_MISMATCH');assert.equal(f.writes.length,0);
  const p=await ad({call_to_action_id:'700'});assert.equal(p.success,true,JSON.stringify(p));
  assert.deepEqual(p.data.state_reads.map(r=>r.path),['/v1.3/advertiser/info/','/v1.3/adgroup/get/','/v1.3/creative/portfolio/get/']);
  assert.equal((await f.execute(p.data.review_id)).success,true);assert.equal(f.writes.at(-1).creatives[0].call_to_action_id,'700');
  assert.equal((await f.verify(p.data.review_id)).data.status,'verified');
  // The portfolio is read again before execution: a portfolio deleted after review stops the ad.
  const later=await ad({call_to_action_id:'700',ad_name:'Second ad'});assert.equal(later.success,true);delete f.portfolios[700];
  const writes=f.writes.length;assert.equal((await f.execute(later.data.review_id)).error?.code,'PLATFORM_ERROR');assert.equal(f.writes.length,writes);
 }finally{f.store.close();}
});
