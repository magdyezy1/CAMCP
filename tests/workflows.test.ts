import test from 'node:test';
import assert from 'node:assert/strict';
import {Compiler} from '../src/compiler.js';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService,strictOptions} from '../src/service.js';
import {NativeTransport,buildUrl} from '../src/transport.js';
import {compileEntityMutation,compileEntityRead,compileReport,normalizeReport,reportCsv,WorkflowEngine,zonedMidnight} from '../src/workflows.js';
const registry=new Registry(),compiler=new Compiler(registry);
const compile=(s:{gateway:string;input:Record<string,unknown>})=>compiler.compile(s.gateway,s.input,strictOptions);
test('generic campaign, child and ad creation resolves captured routes across Google, LinkedIn, X and DV360',()=>{
 const examples=[
  ['create_campaign',{platform:'google',account_id:'111',name:'Draft',platform_form_data:{advertising_channel_type:'SEARCH',campaign_budget:'customers/111/campaignBudgets/222'}}],
  ['create_campaign',{platform:'linkedin',account_id:'111',name:'Draft'}],
  ['create_campaign',{platform:'x',account_id:'111',name:'Draft',platform_form_data:{funding_instrument_id:'abc'}}],
  ['create_campaign',{platform:'dv360',account_id:'111',name:'Draft',platform_form_data:{campaignGoal:{campaignGoalType:'CAMPAIGN_GOAL_TYPE_BRAND_AWARENESS'}}}],
  ...['google','linkedin','x','dv360'].map(platform=>['create_adset',{platform,account_id:'111',parent_id:'222',payload:{name:'Child'}}]),
  ...['google','linkedin','x'].map(platform=>['create_ad',{platform,account_id:'111',parent_id:'222',payload:{name:'Ad'}}])
 ] as [string,Record<string,unknown>][];
 for(const [operation,args]of examples){const plan=compile(compileEntityMutation(operation,args));assert.equal(plan.readOnly,false);assert.ok(plan.path.includes('111'));}
});
test('entity reads and status mutations resolve against actual catalog templates',()=>{
 for(const platform of ['google','linkedin','x','dv360']){
  for(const operation of ['list_campaigns','fetch_campaign','fetch_adsets','fetch_ads']){
   const s=compileEntityRead(operation,{platform,account_id:'111',...(platform==='dv360'&&operation==='fetch_ads'?{}:{campaign_id:'222'}),...(operation==='fetch_ads'&&platform!=='dv360'?{adset_id:'333'}:{})});assert.equal(compile(s).readOnly,true);
  }
  const s=compileEntityMutation('update_entities',{platform,account_id:'111',entity_type:'campaign',entity_id:'222',updates:{name:'Renamed'}});assert.equal(compile(s).readOnly,false);
 }
});
test('generic report compilation preserves hierarchy, account filter and explicit dates',()=>{
 const args={account_id:'111',date_range:{since:'2026-08-01',until:'2026-08-31'},campaign_ids:['222'],level:'adset'};
 const g=compile(compileReport({...args,platform:'google'}));assert.match((g.body as any).query,/FROM ad_group/);assert.match((g.body as any).query,/campaign.id IN \(222\)/);
 const l=compile(compileReport({...args,platform:'linkedin'}));assert.equal(l.query.pivot,'CAMPAIGN');assert.equal(l.query.accounts,'List(urn:li:sponsoredAccount:111)');
 assert.throws(()=>compileReport({...args,platform:'google',date_range:{since:'2026-02-30',until:'2026-03-01'}}),/valid calendar/);
 assert.throws(()=>compileEntityMutation('create_ad',{platform:'meta',account_id:'111'}),/native gateway/);
});
test('report normalization retains nulls, currency, exact IDs and protects CSV formulas',()=>{
 const r=normalizeReport('google',[{customer:{currencyCode:'SAR'},campaign:{id:'1234567890123456789',name:'=HYPERLINK("bad")'},metrics:{impressions:'10',clicks:'0',costMicros:'2000000'}}],{account_id:'111',date_range:{since:'2026-08-01',until:'2026-08-31'}});
 assert.equal(r.rows[0].entity_id,'1234567890123456789');assert.equal(r.rows[0].spend,2);assert.equal(r.rows[0].currency,'SAR');assert.equal(r.rows[0].cpc,null);assert.equal(r.rows[0].conversions,null);assert.equal(r.totals,null);assert.ok(reportCsv(r.rows).includes("'=HYPERLINK"));
 assert.throws(()=>normalizeReport('google',[{metrics:{impressions:'9007199254740993'}}],{account_id:'111',date_range:{since:'2026-08-01',until:'2026-08-31'}}),/precision/);
});
test('generic mutation dry run passes through MCP service and central write gate',async()=>{
 const store=new Store(':memory:');let calls=0;try{const service=new MirrorService(registry,store,new NativeTransport((async()=>{calls++;throw Error('unexpected');}) as typeof fetch));
 const args={platform:'google',account_id:'111',entity_type:'campaign',entity_id:'222',updates:{name:'Draft'},dry_run:true};
 const response=await service.call('whathead_native_action',{operation:'update_entities',arguments:args},{tenantId:'t',userId:'r',role:'reader'});assert.equal(response.success,true);assert.equal(response.data.executed,false);
 const denied=await service.call('whathead_native_action',{operation:'update_entities',arguments:{...args,dry_run:false}},{tenantId:'t',userId:'r',role:'reader'});assert.equal(denied.error.code,'LIVE_WRITES_DISABLED');assert.equal(calls,0);
 }finally{store.close();}
});
test('X report date boundaries follow account timezone and reject fractional-hour APIs',()=>{
 assert.equal(zonedMidnight('2026-03-08','America/New_York'),Date.parse('2026-03-08T05:00:00Z'));
 assert.equal(zonedMidnight('2026-03-09','America/New_York'),Date.parse('2026-03-09T04:00:00Z'));
 assert.throws(()=>zonedMidnight('2026-08-01','Asia/Kolkata'),/fractional-hour/);
});
