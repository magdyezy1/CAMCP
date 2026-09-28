import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * TikTok audiences by rule (API for Business v1.3 "Create an audience by rule" and the Enumerations appendix, checked
 * 2026-09-27): website traffic, ad engagement and lead generation audiences.
 */
const TIKTOK='38383838-3838-4383-8383-383838383838',gateway='tiktok_native_action',account='123',registry=new Registry(),action='tiktok_dmp_custom_audience_rule_create';
const actor={tenantId:'tiktok-rule-audiences',userId:'operator',role:'operator'},owner={...actor,role:'admin'},key=Buffer.alloc(32,98).toString('base64');
const labels={PIXEL:'Website Audience',ENGAGEMENT:'Engagement Audience',LEAD_GENERATION:'Lead Generation'};
const rule=(value,days,sources,parameter_filters)=>({...(sources?{event_source_ids:sources}:{}),retention_days:days,filter_set:{operator:'OR',filters:[{field:'EVENT',operator:'EQ',value,...(parameter_filters?{parameter_filters}:{})}]}});
const website={custom_audience_name:'Buyers over 50 excluding refunds',audience_type:'PIXEL',retention_in_days:90,is_auto_refresh:false,rule_spec:{
 inclusion_rule_set:{operator:'OR',rules:[rule('COMPLETE PAYMENT',30,['7001'],[{field:'URL',operator:'CONTAINS',values:['/checkout']},{field:'VALUE',operator:'IS_GREATER_THAN',values:['50']}]),rule('PIXEL ADD TO CART',7,['7001','7002'])]},
 exclusion_rule_set:{operator:'OR',rules:[rule('PAGE BROWSE',180,['7001'],[{field:'URL',operator:'CONTAINS',values:['/refund']}])]}}};
function fixture(mode=''){
 const store=new Store(':memory:',key),connection={id:TIKTOK,tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic TikTok',scopes:[]};
 store.putConnection(owner,connection,{accessToken:'synthetic'});
 const pixels=[{pixel_id:'7001',pixel_name:'Store pixel',pixel_code:'CABC1'},{pixel_id:'7002',pixel_name:'Blog pixel',pixel_code:'CABC2'}];
 const adgroups=new Map([['301',{adgroup_name:'Prospecting'}],['302',{adgroup_name:'Retargeting'}]]);
 const audiences=new Map();let next=801,writes=0,n=0;const requests=[];
 const ok=data=>Response.json({code:0,message:'OK',request_id:'r'+ ++n,data});
 const transport=new NativeTransport(async(raw,init={})=>{
  const u=new URL(String(raw)),path=u.pathname.replace(/^\/open_api/,''),method=init.method??'GET',q=k=>u.searchParams.get(k);requests.push(method+' '+path+(q('page')?' p'+q('page'):''));
  if(method==='GET'){
   const page=Number(q('page')||1),size=Number(q('page_size')||20);
   if(path==='/v1.3/advertiser/info/'){assert.deepEqual(JSON.parse(q('advertiser_ids')),[account]);return ok({list:[{advertiser_id:account,name:'Synthetic advertiser',status:'STATUS_ENABLE'}]});}
   assert.equal(q('advertiser_id'),account);
   if(path==='/v1.3/pixel/list/'){const served=1,rows=pixels.slice((page-1)*served,page*served);return ok({pixels:rows,page_info:{page,page_size:served,total_number:pixels.length,total_page:Math.ceil(pixels.length/served)}});}
   if(path==='/v1.3/adgroup/get/'){const ids=JSON.parse(q('filtering')).adgroup_ids,rows=[...adgroups].filter(([id])=>ids.includes(id)).map(([adgroup_id,g])=>({advertiser_id:account,adgroup_id,...g}));return ok({list:rows,page_info:{page,page_size:size,total_number:rows.length,total_page:1}});}
   if(path==='/v1.3/dmp/custom_audience/get/'){const ids=JSON.parse(q('custom_audience_ids'));return ok({list:[...audiences].filter(([id])=>ids.includes(id)).map(([audience_id,a])=>({audience_history:[],audience_details:{audience_id,...a,is_valid:false,is_creator:true,shared:false,cover_num:0,rule:'{"inclusions": null, "exclusions": null}'}}))});}
   throw new Error('Unexpected TikTok read '+path);
  }
  const b=JSON.parse(init.body);writes++;
  if(mode==='error')return Response.json({code:40002,message:'Audience rules are invalid',request_id:'r'+ ++n,data:{}});
  if(mode==='noid')return ok({});
  if(path==='/v1.3/dmp/custom_audience/rule/create/'){
   const id=String(next++);
   if(mode!=='ignore')audiences.set(id,{name:b.custom_audience_name,type:labels[b.audience_type],audience_sub_type:b.audience_sub_type??'NORMAL',...(b.audience_type==='LEAD_GENERATION'?{}:{is_auto_refresh:b.is_auto_refresh??true})});
   return ok({custom_audience_id:id});
  }
  throw new Error('Unexpected TikTok request '+method+' '+path);
 });
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 const prepare=payload=>service.call('amcp_write',{action:'prepare',gateway,connection_id:TIKTOK,arguments:{action,account_id:account,payload:{advertiser_id:account,...payload}}},actor);
 const execute=p=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,audiences,requests,prepare,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};

test('a website audience of recent buyers excluding refund visitors is created from paged pixels and verifies; a replay sends nothing',async()=>{
 const f=fixture();try{
  const p=ok(await f.prepare(website));assert.equal(p.data.creative_impact.operation,'create');assert.deepEqual(p.data.creative_impact.sources.map(s=>s.id),['7001','7002']);
  assert.equal(p.data.creative_impact.may_affect_serving,false);assert.ok(f.requests.includes('GET /v1.3/pixel/list/ p2'),'the pixel list is paged');
  ok(await f.execute(p));assert.equal(f.audiences.get('801').type,'Website Audience');assert.equal(f.audiences.get('801').is_auto_refresh,false);
  assert.equal(ok(await f.verify(p)).data.status,'verified');assert.equal((await f.execute(p)).data.replayed,true);assert.equal(f.writes(),1);
 }finally{f.store.close();}
});

test('engagement audiences of named or all ad groups and a Reach & Frequency lead audience are created and verify',async()=>{
 const f=fixture();try{
  const named=ok(await f.prepare({custom_audience_name:'Watched 6s',audience_type:'ENGAGEMENT',rule_spec:{inclusion_rule_set:{operator:'OR',rules:[rule('PLAY 6S',14,['302','301'])]}}}));
  assert.deepEqual(named.data.creative_impact.sources.map(s=>s.id),['301','302']);ok(await f.execute(named));assert.equal(ok(await f.verify(named)).data.status,'verified');
  const all=ok(await f.prepare({custom_audience_name:'Clicked any ad',audience_type:'ENGAGEMENT',rule_spec:{inclusion_rule_set:{operator:'OR',rules:[rule('CLICK',30)]}}}));
  assert.equal(all.data.creative_impact.sources,'all ad groups');assert.ok(f.requests.includes('GET /v1.3/advertiser/info/'),'without sources the advertiser is read');
  ok(await f.execute(all));assert.equal(ok(await f.verify(all)).data.status,'verified');
  const lead=ok(await f.prepare({custom_audience_name:'Form submitters',audience_type:'LEAD_GENERATION',audience_sub_type:'REACH_FREQUENCY',rule_spec:{inclusion_rule_set:{operator:'OR',rules:[rule('LEAD GENERATION FORM SUBMISSION',60)]}}}));
  ok(await f.execute(lead));assert.equal(f.audiences.get('803').audience_sub_type,'REACH_FREQUENCY');assert.equal(ok(await f.verify(lead)).data.status,'verified');
  assert.equal(f.writes(),3);
 }finally{f.store.close();}
});

test('malformed audiences are refused before any request; pixels and ad groups of another advertiser after reading',async()=>{
 const base={custom_audience_name:'Visitors',audience_type:'PIXEL',rule_spec:{inclusion_rule_set:{operator:'OR',rules:[rule('PAGE BROWSE',30,['7001'])]}}};
 const withRule=r=>({...base,rule_spec:{inclusion_rule_set:{operator:'OR',rules:[r]}}});
 const cases=[
  ['another advertiser',{...base,advertiser_id:'999'}],
  ['an app audience',{...base,audience_type:'APP'}],
  ['an identity',{...base,identity_id:'id-1',identity_type:'TT_USER'}],
  ['129 characters',{...base,custom_audience_name:'x'.repeat(129)}],
  ['no retention',{...base,retention_in_days:0}],
  ['a 45-day lookback',withRule(rule('PAGE BROWSE',45,['7001']))],
  ['an engagement value',withRule(rule('PLAY 2S',30,['7001']))],
  ['the example value outside the enumeration',withRule(rule('PIXEL COMPLETE PAYMENT',30,['7001']))],
  ['a website audience without pixels',withRule(rule('PAGE BROWSE',30))],
  ['a lead audience with sources',{...base,audience_type:'LEAD_GENERATION',rule_spec:{inclusion_rule_set:{operator:'OR',rules:[rule('FORM VIEW',30,['7001'])]}}}],
  ['parameter filters on engagement',{...base,audience_type:'ENGAGEMENT',rule_spec:{inclusion_rule_set:{operator:'OR',rules:[rule('CLICK',30,undefined,[{field:'URL',operator:'CONTAINS',values:['x']}])]}}}],
  ['two URL filters',withRule(rule('PAGE BROWSE',30,['7001'],[{field:'URL',operator:'CONTAINS',values:['a']},{field:'URL',operator:'CONTAINS',values:['b']}]))],
  ['a comparison on a URL',withRule(rule('PAGE BROWSE',30,['7001'],[{field:'URL',operator:'IS_GREATER_THAN',values:['5']}]))],
  ['a comparison with text',withRule(rule('PAGE BROWSE',30,['7001'],[{field:'PRICE',operator:'IS_LESS_THAN',values:['cheap']}]))],
  ['two filters in a rule',withRule({event_source_ids:['7001'],retention_days:30,filter_set:{operator:'OR',filters:[{field:'EVENT',operator:'EQ',value:'PAGE BROWSE'},{field:'EVENT',operator:'EQ',value:'CONTACT'}]}})],
  ['AND between rules',{...base,rule_spec:{inclusion_rule_set:{operator:'AND',rules:[rule('PAGE BROWSE',30,['7001'])]}}}],
  ['eleven rules',{...base,rule_spec:{inclusion_rule_set:{operator:'OR',rules:Array.from({length:11},()=>rule('PAGE BROWSE',30,['7001']))}}}],
  ['an unknown rule field',withRule({...rule('PAGE BROWSE',30,['7001']),frequency:2})]
 ];
 for(const [label,payload] of cases){const f=fixture();try{const r=await f.prepare(JSON.parse(JSON.stringify(payload)));assert.ok(['INVALID_TIKTOK_RULE_AUDIENCE','ACCOUNT_SCOPE_MISMATCH'].includes(r.error?.code),label+': '+JSON.stringify(r).slice(0,300));assert.equal(f.requests.length,0,label);}finally{f.store.close();}}
 const f=fixture();try{
  assert.equal((await f.prepare(withRule(rule('PAGE BROWSE',30,['7001','7999'])))).error?.code,'STATE_NOT_FOUND');
  assert.equal((await f.prepare({...base,audience_type:'ENGAGEMENT',rule_spec:{inclusion_rule_set:{operator:'OR',rules:[rule('CLICK',30,['301','399'])]}}})).error?.code,'STATE_NOT_FOUND');
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('error replies and receipts without an audience are never resubmitted, an ignored creation is not verified, and the ledger lists the row',async()=>{
 for(const mode of ['error','noid']){const e=fixture(mode);try{const p=ok(await e.prepare(website));assert.equal((await e.execute(p)).success,false,mode);assert.equal((await e.execute(p)).success,false,mode);assert.equal(e.writes(),1,mode);}finally{e.store.close();}}
 const g=fixture('ignore');try{const p=ok(await g.prepare(website));ok(await g.execute(p));assert.notEqual(ok(await g.verify(p)).data.status,'verified');}finally{g.store.close();}
 const row=actionContracts(registry).find(r=>r.gateway===gateway&&r.action===action);assert.equal(row?.status,'reviewed_write_family');assert.equal(row.family,'tiktok_rule_audiences');
});
