import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';

/**
 * Promoted products of Criteo auction line items, Retail Media API 2026-01 (pinned OpenAPI document and the "Promoted
 * Products" guide, checked 2026-09-26): append with bid overrides, delete, pause and unpause.
 */
const gateway='criteo_native_action',prefix='/2026-01/retail-media',registry=new Registry();
const actor={tenantId:'criteo-products',userId:'operator',role:'operator'},owner={...actor,role:'admin'};
const key=sku=>'p'+Buffer.from(sku,'utf8').toString('hex');
const line=(name,status)=>({campaignId:'456',targetRetailerId:'55',name,startDate:'2030-08-01T04:00:00+00:00',endDate:null,budget:500,monthlyPacing:null,dailyPacing:null,isAutoDailyPacing:false,bidStrategy:'manual',optimizationStrategy:'conversion',targetBid:0.5,maxBid:0,flightSchedule:null,keywordStrategy:'genericAndBranded',status,budgetSpent:0,budgetRemaining:500,createdAt:'2026-01-01T00:00:00+00:00',updatedAt:'2026-01-01T00:00:00+00:00'});
function fixture(){
 const store=new Store(':memory:',Buffer.alloc(32,67).toString('base64')),c={id:'criteo',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic Criteo',scopes:['RetailMedia_Accounts_Read','RetailMedia_Campaign_Read','RetailMedia_Campaign_Manage']};
 store.putConnection(owner,c,{accessToken:'synthetic'});
 // Catalog IDs are case-sensitive: sku-A and Sku-a are different products.
 const lines=new Map([
  ['789',{type:'auction',attributes:line('Active line','active'),products:[{id:'sku-A',bidOverride:0.7,status:'active'},{id:'Sku-a',bidOverride:0,status:'paused'},{id:'926097',bidOverride:null,status:'budgetHit'}]}],
  ['791',{type:'auction',attributes:line('Paused line','paused'),products:[{id:'only-one',bidOverride:null,status:'active'}]}],
  ['793',{type:'auction',attributes:line('Archived line','archived'),products:[{id:'old',bidOverride:null,status:'archived'}]}],
  ['794',{type:'preferred',attributes:line('Deal line','active'),products:[]}]
 ]);
 let writes=0,mode='';const calls=[];
 const page=rows=>({data:rows,metadata:{currentPageIndex:0,currentPageSize:2,totalItemsAcrossAllPages:rows.length,totalPages:1,nextPage:null,previousPage:null},errors:[],warnings:[]});
 const transport=new NativeTransport(async(url,init)=>{
  const u=new URL(String(url)),method=init.method;calls.push({path:u.pathname,method});
  if(method==='GET'){
   if(u.pathname===prefix+'/accounts')return Response.json(page([{id:'123',type:'RetailMediaAccount',attributes:{name:'Account',type:'demand',currency:'EUR',timeZone:'Europe/Paris'}}]));
   if(u.pathname===prefix+'/accounts/123/campaigns')return Response.json(page(u.searchParams.getAll('limitToId').filter(id=>id==='456').map(id=>({id,type:'RetailMediaCampaignV202301',attributes:{name:'Summer',accountId:'123',type:'auction',retailerId:null,budget:5000,status:'active'}}))));
   if(u.pathname===prefix+'/accounts/123/line-items'){const type=u.searchParams.get('limitToType')?.toLowerCase();return Response.json(page(u.searchParams.getAll('limitToId').filter(id=>lines.has(id)&&(!type||lines.get(id).type===type)).map(id=>{const l=lines.get(id);return {id,type:'RetailMediaLineItem',attributes:{campaignId:'456',targetRetailerId:'55',name:l.attributes.name,type:l.type,status:l.attributes.status,startDate:'2030-08-01',budget:500,budgetSpent:0}};})));}
   let m=/^\/2026-01\/retail-media\/auction-line-items\/(\d+)$/.exec(u.pathname);
   if(m)return Response.json({data:{id:m[1],type:'SponsoredProductsLineItem',attributes:lines.get(m[1]).attributes},errors:[],warnings:[]});
   m=/^\/2026-01\/retail-media\/line-items\/(\d+)\/products$/.exec(u.pathname);
   if(m){
    assert.equal(u.searchParams.get('fields'),'bidOverride,status');
    const limit=Number(u.searchParams.get('limit')),offset=Number(u.searchParams.get('offset'));
    let rows=lines.get(m[1]).products.map(p=>({id:p.id,type:'RetailMediaPromotedProduct',attributes:{bidOverride:p.bidOverride,status:p.status}}));
    if(mode==='many')rows=Array.from({length:1501},(_,i)=>({id:'bulk-'+i,type:'RetailMediaPromotedProduct',attributes:{bidOverride:null,status:'active'}}));
    const slice=rows.slice(offset,offset+limit);
    return Response.json({data:slice,meta:{offset,limit,count:rows.length,responseCount:slice.length},errors:[],warnings:[]});
   }
   throw new Error('Unexpected read '+u.pathname);
  }
  writes++;const m=/^\/2026-01\/retail-media\/line-items\/(\d+)\/products\/(append|delete|pause|unpause)$/.exec(u.pathname);if(!m)throw new Error('Unexpected write '+u.pathname);
  const l=lines.get(m[1]),body=JSON.parse(String(init.body));
  for(const r of body.data){
   const current=l.products.find(p=>p.id===r.id);
   if(m[2]==='append'){const bid=mode==='ignore'?undefined:r.attributes?.bidOverride;if(current){if(bid!==undefined)current.bidOverride=bid;}else l.products.push({id:r.id,bidOverride:bid??null,status:'active'});}
   if(m[2]==='delete')l.products=l.products.filter(p=>p.id!==r.id);
   if(m[2]==='pause'&&mode!=='ignore')current.status='paused';
   if(m[2]==='unpause')current.status='active';
  }
  return mode==='warning'?Response.json({warnings:[{code:'min-bid',detail:'Bid override below the product minimum bid'}],errors:[]}):new Response(null,{status:204});
 },async()=>{},30000,8*1024*1024,10000);
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const discover=(id,type='Auction')=>service.call(gateway,{operation:'criteo_line_item_ops',arguments:{action:'GET_LINE_ITEMS_BY_ACCOUNT_ID',account_id:'123',params:{limitToId:[id],limitToType:type,pageIndex:0,pageSize:2}}},actor);
 const prepare=(kind,lineItem,data)=>service.call('amcp_write',{action:'prepare',gateway,arguments:{operation:'criteo_catalog_ops',arguments:{action:kind.toUpperCase()+'_PROMOTED_PRODUCTS',account_id:'123',params:{'line-item-id':lineItem},payload:{data}}}},actor);
 const execute=(p,extra={})=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,...extra},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,calls,lines,discover,prepare,execute,verify,writes:()=>writes,mode:m=>{mode=m;}};
}
const ids=(...skus)=>skus.map(id=>({id,type:'RetailMediaPromotedProduct'}));
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};

test('products are appended once after spending confirmation and verify, keeping case-sensitive IDs apart',async()=>{
 const f=fixture();try{
  ok(await f.discover('789'));
  const p=ok(await f.prepare('append','789',[{id:'new-1',type:'RetailMediaPromotedProduct'},{id:'NEW-1',type:'RetailMediaPromotedProduct',attributes:{id:'NEW-1',bidOverride:1.1}},{id:'sku-A',attributes:{bidOverride:0}}])),impact=p.data.creative_impact;
  assert.deepEqual(impact.added,['new-1','NEW-1']);assert.deepEqual(impact.bid_overrides,[{id:'sku-A',before:0.7,after:null}]);assert.equal(impact.products_before,3);assert.equal(impact.products_after,5);assert.equal(impact.currency,'EUR');assert.match(impact.effect,/active/);
  assert.equal((await f.execute(p)).error?.code,'SPEND_CONFIRMATION_REQUIRED');assert.equal(f.writes(),0);
  ok(await f.execute(p,{spend_change_confirmed:true}));assert.equal(f.writes(),1);
  const v=ok(await f.verify(p));assert.equal(v.data.status,'verified',JSON.stringify(v).slice(0,900));
  assert.equal((await f.execute(p,{spend_change_confirmed:true})).data.replayed,true);assert.equal(f.writes(),1);
  assert.deepEqual(f.lines.get('789').products.map(x=>[x.id,x.bidOverride]),[['sku-A',0],['Sku-a',0],['926097',null],['new-1',null],['NEW-1',1.1]]);
 }finally{f.store.close();}
});

test('pausing, unpausing and deleting verify without spending confirmation where they only reduce delivery, and the last product stays',async()=>{
 const f=fixture();try{
  ok(await f.discover('789'));ok(await f.discover('791'));
  const pause=ok(await f.prepare('pause','789',ids('sku-A')));ok(await f.execute(pause));assert.equal(ok(await f.verify(pause)).data.status,'verified');
  const unpause=ok(await f.prepare('unpause','789',ids('Sku-a')));assert.equal((await f.execute(unpause)).error?.code,'SPEND_CONFIRMATION_REQUIRED');ok(await f.execute(unpause,{spend_change_confirmed:true}));assert.equal(ok(await f.verify(unpause)).data.status,'verified');
  const del=ok(await f.prepare('delete','789',ids('926097')));assert.deepEqual(del.data.creative_impact.removed,['926097']);ok(await f.execute(del));assert.equal(ok(await f.verify(del)).data.status,'verified');
  assert.deepEqual(f.lines.get('789').products.map(x=>[x.id,x.status]),[['sku-A','paused'],['Sku-a','active']]);
  const last=await f.prepare('delete','791',ids('only-one'));assert.equal(last.error?.code,'INVALID_CRITEO_PROMOTED_PRODUCTS');assert.match(last.error.message,/at least one product/);
  assert.equal(f.writes(),3);
 }finally{f.store.close();}
});

test('malformed product requests fail before any request',async()=>{
 for(const [label,kind,data] of [
  ['no products','append',[]],
  ['too many products','append',Array.from({length:501},(_,i)=>({id:'s'+i}))],
  ['duplicate product','append',ids('a','a')],
  ['control character','append',[{id:'a\u0007'}]],
  ['long product ID','append',[{id:'x'.repeat(501)}]],
  ['surrounding spaces','append',[{id:' a'}]],
  ['wrong type','append',[{id:'a',type:'Product'}]],
  ['status on append','append',[{id:'a',attributes:{status:'paused'}}]],
  ['mismatched attribute ID','append',[{id:'a',attributes:{id:'b'}}]],
  ['negative bid override','append',[{id:'a',attributes:{bidOverride:-1}}]],
  ['text bid override','append',[{id:'a',attributes:{bidOverride:'0.5'}}]],
  ['attributes on delete','delete',[{id:'a',attributes:{id:'a'}}]],
  ['bid override on pause','pause',[{id:'a',attributes:{bidOverride:1}}]],
  ['unknown product key','unpause',[{id:'a',status:'active'}]]
 ]){
  const f=fixture();try{const r=await f.prepare(kind,'789',data);assert.equal(r.error?.code,'INVALID_CRITEO_PROMOTED_PRODUCTS',label+': '+JSON.stringify(r).slice(0,300));assert.equal(f.calls.length,0,label);}finally{f.store.close();}
 }
 const f=fixture();try{assert.match((await f.prepare('append','789',[{id:'a',attributes:{status:'paused'}}])).error.message,/pause or unpause/);}finally{f.store.close();}
});

test('the review refuses unlisted line items, unknown products, wrong states, unchanged bids, archived or preferred line items and oversized lists',async()=>{
 const f=fixture();try{
  assert.equal((await f.prepare('pause','789',ids('sku-A'))).error?.code,'RESOURCE_SCOPE_REQUIRED');assert.equal(f.calls.length,0);
  ok(await f.discover('789'));ok(await f.discover('793'));ok(await f.discover('794','Preferred'));
  assert.match((await f.prepare('pause','789',ids('Sku-a'))).error?.message??'',/Only active products can be paused: Sku-a/);
  assert.match((await f.prepare('unpause','789',ids('sku-A','926097'))).error?.message??'',/Only paused products can be unpaused: sku-A, 926097/);
  const missing=await f.prepare('delete','789',ids('nope','SKU-A'));assert.equal(missing.error?.code,'STATE_TARGET_MISMATCH');assert.deepEqual(missing.error.details.product_ids,['nope','SKU-A']);
  assert.equal((await f.prepare('append','789',[{id:'sku-A'}])).error?.code,'CONFIGURATION_EXISTS');
  assert.match((await f.prepare('append','789',[{id:'sku-A',attributes:{bidOverride:0.7}}])).error?.message??'',/already has this bid override/);
  assert.match((await f.prepare('append','793',ids('new'))).error?.message??'',/archived/);
  assert.equal((await f.prepare('append','794',ids('new'))).error?.code,'STATE_TARGET_MISMATCH');
  f.mode('many');assert.equal((await f.prepare('append','789',ids('new'))).error?.code,'INCOMPLETE_STATE');
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('owner policies: new or unpaused products count as serving unless the line item is paused, and deletion is a deletion',async()=>{
 const f=fixture();try{
  ok(await f.discover('789'));ok(await f.discover('791'));
  saveSpendPolicy(f.store,owner,{gateway,account_id:'123',confirmed:true,policy:{allow_deletion:false,allow_activation:false}});
  assert.equal((await f.prepare('append','789',ids('new'))).error?.code,'POLICY_ACTIVATION_FORBIDDEN');
  assert.equal((await f.prepare('unpause','789',ids('Sku-a'))).error?.code,'POLICY_ACTIVATION_FORBIDDEN');
  ok(await f.prepare('append','791',ids('new')));
  ok(await f.prepare('append','789',[{id:'sku-A',attributes:{bidOverride:0.9}}]));
  ok(await f.prepare('pause','789',ids('sku-A')));
  assert.equal((await f.prepare('delete','789',ids('926097'))).error?.code,'POLICY_DELETION_FORBIDDEN');
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('a response with warnings is not resubmitted, a changed product list stops execution, and ignored changes are inconclusive',async()=>{
 {const f=fixture();try{
  ok(await f.discover('789'));const p=ok(await f.prepare('append','789',ids('new')));f.mode('warning');
  assert.equal((await f.execute(p,{spend_change_confirmed:true})).success,false);assert.equal((await f.execute(p,{spend_change_confirmed:true})).data.replayed,true);assert.equal(f.writes(),1);
  assert.equal((await f.verify(p)).error?.code,'WRITE_PARTIAL_OR_FAILED');
 }finally{f.store.close();}}
 const f=fixture();try{
  ok(await f.discover('789'));
  const p=ok(await f.prepare('append','789',ids('new')));f.lines.get('789').products.push({id:'added-elsewhere',bidOverride:null,status:'active'});
  assert.equal((await f.execute(p,{spend_change_confirmed:true})).error?.code,'STATE_CHANGED');assert.equal(f.writes(),0);
  // Sku-a is already paused: a pause of sku-A that Criteo ignores must not pass as the other product.
  const pause=ok(await f.prepare('pause','789',ids('sku-A')));f.mode('ignore');ok(await f.execute(pause));
  const v=ok(await f.verify(pause));assert.equal(v.data.status,'inconclusive');assert.deepEqual(v.data.checks[0].changed_fields,['/products/'+key('sku-A')+'/status']);
  const bid=ok(await f.prepare('append','789',[{id:'926097',attributes:{bidOverride:0.8}}]));ok(await f.execute(bid,{spend_change_confirmed:true}));
  const w=ok(await f.verify(bid));assert.equal(w.data.status,'inconclusive');assert.deepEqual(w.data.checks[0].changed_fields,['/products/'+key('926097')+'/bid_override']);
 }finally{f.store.close();}
});

test('a product ID that mentions a bid, budget or spend is not a spending change',async()=>{
 const f=fixture();try{
  f.lines.get('789').products.push({id:'budget-bid-spend',bidOverride:null,status:'active'});
  ok(await f.discover('789'));
  const p=ok(await f.prepare('pause','789',ids('budget-bid-spend')));ok(await f.execute(p));assert.equal(ok(await f.verify(p)).data.status,'verified');
 }finally{f.store.close();}
});

test('the product routes and request model match the pinned document',()=>{
 const doc=JSON.parse(readFileSync('.mirror/VENDOR/criteo-retail-2026-01.json','utf8')).document,schemas=doc.components.schemas;
 for(const kind of ['append','delete','pause','unpause']){
  const op=doc.paths[prefix+'/line-items/{line-item-id}/products/'+kind].post;
  assert.deepEqual(op.security,[{oauth:['RetailMedia_Campaign_Manage']}]);assert.ok(op.responses['204']);
  assert.equal(op.requestBody.content['application/json'].schema.$ref,'#/components/schemas/PromotedProductResourceCollectionInput');
 }
 assert.equal(schemas.PromotedProductResource.additionalProperties,false);assert.deepEqual(Object.keys(schemas.PromotedProductResource.properties).sort(),['attributes','id','type']);
 assert.deepEqual(Object.keys(schemas.PromotedProduct.properties).sort(),['bidOverride','id','status']);
 assert.deepEqual(schemas.LineItemProductStatus.enum,['unknown','active','paused']);
 const read=doc.paths[prefix+'/line-items/{line-item-id}/products'].get;assert.deepEqual(read.parameters.map(p=>p.name).sort(),['fields','limit','line-item-id','offset']);
 const routes=JSON.parse(readFileSync('generated/vendor-routes.json','utf8')).routes.filter(r=>r.gateway===gateway&&/_PROMOTED_PRODUCTS$/.test(r.action)&&r.method==='POST');
 assert.deepEqual(routes.map(r=>[r.operation,r.action,r.path]).sort(),['APPEND','DELETE','PAUSE','UNPAUSE'].map(k=>['criteo_catalog_ops',k+'_PROMOTED_PRODUCTS',prefix+'/line-items/{line-item-id}/products/'+k.toLowerCase()]));
});
