import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Compiler} from '../src/compiler.js';
import {googleLegacyCoverage,validateGoogleMessage} from '../src/google-legacy.js';
import {MirrorService,strictOptions} from '../src/service.js';
import {Store} from '../src/store.js';
import {NativeTransport} from '../src/transport.js';
const registry=new Registry(),compiler=new Compiler(registry),gateway='google_ads_native_action';
const compile=(action:string,payload:Record<string,unknown>)=>compiler.compile(gateway,{action,account_id:'111',payload},strictOptions);
test('legacy inventory classifies every captured alias exactly once without claiming behavior parity',()=>{
 const c=googleLegacyCoverage(),names=registry.catalogs.get(gateway)!.actions.filter(a=>!a.path).map(a=>a.name).sort();assert.equal(c.total,285);assert.equal(c.requestTypes,171);assert.deepEqual(c.entries.map(e=>e.action).sort(),names);assert.equal(c.exactBehaviorParityVerified,0);
});
test('legacy reads use explicit resources, safe filters, exact IDs and bounded GAQL',()=>{
 const p=compile('FETCH_CAMPAIGNS',{limit:5});assert.equal(p.path,'/v23/customers/111/googleAds:search');assert.equal(p.readOnly,true);assert.match((p.body as any).query,/FROM campaign LIMIT 5$/);
 const k=compile('FETCH_KEYWORDS',{campaign_id:'123'});assert.match((k.body as any).query,/negative = FALSE/);assert.throws(()=>compile('FETCH_KEYWORDS',{campaign_id:'1 OR 1=1'}),/decimal string/);
 assert.throws(()=>compile('FETCH_CAMPAIGN_INSIGHTS',{}),/date range/i);
 assert.throws(()=>compile('FETCH_CAMPAIGNS',{query:'SELECT campaign.id FROM customer'}),/FROM/);
 assert.throws(()=>compile('FETCH_CAMPAIGNS',{fields:['campaign.id; DELETE']}),/GAQL field/);
});
test('native protobuf validation and legacy campaign creation enforce shape and pause',()=>{
 const p=compile('CREATE_CAMPAIGN',{resource:{name:'Draft',advertising_channel_type:'SEARCH',campaign_budget:'customers/111/campaignBudgets/222'}});
 assert.equal(p.path,'/v23/customers/111/campaigns:mutate');assert.equal((p.body as any).operations[0].create.status,'PAUSED');assert.equal(p.readOnly,false);
 assert.throws(()=>compile('CREATE_CAMPAIGN',{resource:{name:'Draft',advertising_channel_type:'SEARCH',campaign_budget:'customers/222/campaignBudgets/3'}}),/different Google customer/);
 assert.throws(()=>compile('CREATE_CAMPAIGN',{resource:{name:'Draft',advertising_channel_type:'SEARCH',campaign_budget:'customers/111/campaignBudgets/3',unknown:true}}),/absent.*message/);
 assert.throws(()=>validateGoogleMessage('google.ads.googleads.v23.services.CampaignOperation',{create:{name:'a'},remove:'customers/111/campaigns/2'}),/oneof/);
});
test('legacy updates require explicit masks and preserve composite ad identity',()=>{
 const p=compile('UPDATE_CAMPAIGN',{entity_id:'222',resource:{name:'New'},update_mask:'name'});assert.equal((p.body as any).operations[0].update.resource_name,'customers/111/campaigns/222');
 assert.throws(()=>compile('UPDATE_CAMPAIGN',{entity_id:'222',resource:{name:'New'}}),/update_mask/);
 assert.throws(()=>compile('UPDATE_CAMPAIGN',{entity_id:'222',resource:{name:'New'},update_mask:'status'}),/included in update_mask/);
 const remove=compile('DELETE_AD',{ad_group_id:'222',ad_id:'333'});assert.equal((remove.body as any).operations[0].remove,'customers/111/adGroupAds/222~333');
 assert.throws(()=>compile('DELETE_AD',{entity_id:'333'}),/identity parts/);
 const status=compile('UPDATE_AD',{ad_group_id:'222',ad_id:'333',resource:{status:'PAUSED'},update_mask:'status'});assert.match(status.path,/adGroupAds:mutate$/);
 const creative=compile('UPDATE_AD',{ad_id:'333',resource:{final_urls:['https://example.com/']},update_mask:'final_urls'});assert.match(creative.path,/ads:mutate$/);
 assert.throws(()=>compile('UPDATE_AD',{ad_group_id:'222',ad_id:'333',resource:{status:'PAUSED',final_urls:['https://example.com/']},update_mask:'status,final_urls'}),/Split mixed/);
});
test('keyword adapters keep negatives at an explicitly chosen hierarchy',()=>{
 assert.throws(()=>compile('ADD_NEGATIVE_KEYWORDS',{keywords:[{text:'test',match_type:'EXACT'}]}),/explicit keyword scope/);
 const negative=compile('ADD_NEGATIVE_KEYWORDS',{scope:'campaign',campaign_id:'222',keywords:[{text:'test',match_type:'EXACT'}]});assert.match(negative.path,/campaignCriteria:mutate$/);assert.equal((negative.body as any).operations[0].create.negative,true);
 const positive=compile('ADD_KEYWORDS',{ad_group_id:'222',keywords:[{text:'test',match_type:'EXACT'}]});assert.equal((positive.body as any).operations[0].create.status,'PAUSED');
});
test('legacy MCP dry run completes through service without a token or vendor request',async()=>{
 const store=new Store(':memory:');let calls=0;try{const service=new MirrorService(registry,store,new NativeTransport((async()=>{calls++;throw Error('unexpected');}) as typeof fetch));
  const r=await service.call(gateway,{action:'CREATE_CAMPAIGN',account_id:'111',payload:{resource:{name:'Draft',advertising_channel_type:'SEARCH',campaign_budget:'customers/111/campaignBudgets/222'}},dry_run:true},{tenantId:'t',userId:'u',role:'reader'});
  assert.equal(r.success,true);assert.equal(r.data.executed,false);assert.equal(calls,0);assert.equal(r.data.request.evidence,'INDEPENDENT_DESIGN');
 }finally{store.close();}
});
