import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {Actor,JsonObject} from '../src/types.js';
const actor:Actor={tenantId:'synthetic-owner',userId:'operator',role:'operator'},admin:Actor={...actor,role:'admin'},gateway='meta_native_action';
const fb={name:'Existing Page post',object_story_id:'500_600'},ig={name:'Existing IG media',source_instagram_media_id:'777',instagram_user_id:'888'},story={name:'New Page story',object_story_spec:{page_id:'500',link_data:{link:'https://example.test/'}}};
function fixture(){
 const store=new Store(':memory:',Buffer.alloc(32,71).toString('base64')),connection={id:'selected-login',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic',scopes:['ads_management','pages_show_list','pages_read_engagement','instagram_basic']};store.putConnection(admin,connection,{accessToken:'synthetic-user-token'});
 const state:JsonObject={pages:[{id:'500',instagram_business_account:{id:'888'}}],instagram:[{id:'888'}],owner:'888',from:'500',caption:'Approved caption',message:'Approved post',counter:0,token:'synthetic-page-token',writes:0,reads:[]};let hook:((path:string)=>void)|undefined;
 const service=new MirrorService(new Registry(),store,new NativeTransport(async(url,init)=>{
  const u=new URL(String(url)),path=u.pathname;
  if(init?.method!=='GET'){state.writes++;assert.equal(path,'/v25.0/act_123/adcreatives');if(state.lose)throw Error('Synthetic lost response');return Response.json({id:'900'});}
  state.reads.push(path);hook?.(path);
  if(path==='/v25.0/act_123')return Response.json({id:'act_123',currency:'USD',account_status:1});
  if(path.endsWith('/promote_pages'))return Response.json({data:state.pages,...(state.paging?{paging:state.paging}:{})});
  if(path.endsWith('/instagram_accounts'))return Response.json({data:state.instagram});
  if(path==='/v25.0/500')return Response.json({id:'500',access_token:state.token,instagram_business_account:{id:'888'}});
  assert.equal(new Headers(init.headers).get('Authorization'),'Bearer '+state.token);
  if(path==='/v25.0/777')return Response.json({id:'777',owner:{id:state.owner},caption:state.caption,media_type:'VIDEO',media_product_type:'REELS',like_count:state.counter});
  if(path==='/v25.0/500_600')return Response.json({id:'500_600',from:{id:state.from},message:state.message,is_published:false,likes:state.counter});
  throw Error('Unexpected synthetic route '+path);
 }),undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const prepare=(payload:JsonObject)=>service.call('amcp_write',{action:'prepare',gateway,connection_id:connection.id,arguments:{action:'meta_creative_create',account_id:'123',payload}},actor);
 const execute=(r:JsonObject)=>service.call('amcp_write',{action:'execute',review_id:r.review_id,idempotency_key:r.idempotency_key,confirmed:true},actor);
 return {store,connection,state,service,prepare,execute,hook:(value:(path:string)=>void)=>hook=value};
}
const ok=(r:JsonObject)=>{assert.equal(r.success,true,JSON.stringify(r));return r.data;};

test('direct reviewed creatives reject foreign Page, Instagram, content owner and inconsistent sources',async()=>{
 for(const mode of ['page','instagram','owner','post','page_link','conflict']){const f=fixture();try{
  let payload:JsonObject=ig;if(mode==='page'){f.state.pages=[{id:'111'}];payload=fb;}if(mode==='instagram')f.state.instagram=[{id:'111'}];if(mode==='owner')f.state.owner='111';if(mode==='post'){f.state.from='111';payload=fb;}if(mode==='page_link')f.state.pages=[{id:'500',instagram_business_account:{id:'111'}}];if(mode==='conflict')payload={...story,object_story_id:'500_600'};
  const r=await f.prepare(payload);assert.equal(r.success,false,mode);assert.ok(['META_CREATIVE_IDENTITY_REQUIRED','ACCOUNT_SCOPE_MISMATCH','CREATIVE_IDENTITY_CONFLICT'].includes(r.error.code),JSON.stringify(r));assert.equal(f.state.writes,0);assert.equal(f.store.documents(actor.tenantId,'write_review').length,0);
 }finally{f.store.close();}}
});

test('alternate native source and actor fields cannot bypass the qualified ownership path',async()=>{
 const f=fixture();try{
  for(const extra of [{source_facebook_post_id:'111_222'},{instagram_permalink_url:'https://www.instagram.com/p/Synthetic/'},{actor_id:'111'},{branded_content:{sponsor_page_id:'111'}},{creative_sourcing_spec:{source:'foreign'}}]){
   const r=await f.prepare({...story,...extra});assert.equal(r.error.code,'WRITE_CONTRACT_UNAVAILABLE');assert.deepEqual(r.error.details.unsupported_fields,Object.keys(extra));
  }
  assert.equal(f.state.reads.length,0);assert.equal(f.state.writes,0);
 }finally{f.store.close();}
});

test('owned post and Instagram content execute once, with private tokens and counters excluded from state',async()=>{
 for(const payload of [fb,ig,story]){const f=fixture();try{
  const r=ok(await f.prepare(payload));assert.ok(r.state_reads.some((x:JsonObject)=>x.path.endsWith('/promote_pages')));assert.equal(JSON.stringify(r).includes(f.state.token),false);assert.equal(f.store.ownsResource(f.connection,'123','777'),false);
  f.state.token='synthetic-rotated-page-token';f.state.counter=123;f.state.pages.push({id:'501'});f.state.pages.reverse();
  ok(await f.execute(r));assert.equal(ok(await f.execute(r)).replayed,true);assert.equal(f.state.writes,1);assert.equal(f.store.ownsResource(f.connection,'123','900'),true);
  assert.equal(JSON.stringify(f.store.documents(actor.tenantId,'write_review')).includes(f.state.token),false);assert.equal(f.store.verifyAudit(),true);
 }finally{f.store.close();}}
});

test('content changes still conflict and revoked Page/IG authority cannot execute a frozen review',async()=>{
 for(const mode of ['caption','message','page','owner']){const f=fixture();try{
  const r=ok(await f.prepare(mode==='message'?fb:ig));if(mode==='caption')f.state.caption='Changed';if(mode==='message')f.state.message='Changed';if(mode==='page')f.state.pages=[];if(mode==='owner')f.state.owner='111';
  const result=await f.execute(r);assert.equal(result.success,false);assert.equal(f.state.writes,0);
  if(['caption','message'].includes(mode)){assert.equal(result.error.code,'STATE_CHANGED');assert.ok(result.error.details.changed_fields.some((s:string)=>s.includes(mode)));}else assert.ok(['META_CREATIVE_IDENTITY_REQUIRED','ACCOUNT_SCOPE_MISMATCH'].includes(result.error.code));
 }finally{f.store.close();}}
});

test('write grant revocation and reauthorization during private post checks stop all later requests',async()=>{
 for(const mode of ['write_grant','reauth','disabled']){const f=fixture();try{
  f.hook(path=>{if(path==='/v25.0/500')f.store.putConnection(admin,{...f.connection,...(mode==='write_grant'?{writeAccounts:[]}:mode==='disabled'?{enabled:false}:{})},{accessToken:mode==='reauth'?'synthetic-new-login':'synthetic-user-token'});});
  const result=await f.prepare(ig);assert.equal(result.success,false);assert.equal(result.error.code,mode==='write_grant'?'WRITE_ACCOUNT_FORBIDDEN':mode==='reauth'?'REAUTHORIZATION_REQUIRED':'CONNECTION_REQUIRED',JSON.stringify(result));assert.equal(f.state.reads.includes('/v25.0/777'),false);assert.equal(f.state.writes,0);
 }finally{f.store.close();}}
});

test('identity discovery refuses duplicate, malformed and incomplete collections without following next URLs',async()=>{
 for(const mode of ['duplicate','missing_cursor','loop','unknown_paging']){const f=fixture();try{
  if(mode==='duplicate')f.state.pages.push({...f.state.pages[0]});else f.state.paging={next:'https://attacker.invalid/?access_token=synthetic',...(mode==='loop'?{cursors:{after:'same'}}:mode==='unknown_paging'?{total_count:1}: {})};
  const result=await f.prepare(story);assert.equal(result.success,false);assert.equal(result.error.code,'META_CREATIVE_STATE_UNVERIFIED');assert.equal(f.state.writes,0);assert.ok(f.state.reads.length<=3);
 }finally{f.store.close();}}
});

test('duplicate account logins cannot supply identity access and missing content scopes remain explicit',async()=>{
 const f=fixture();try{
  f.store.putConnection(admin,{...f.connection,id:'other-login'},{accessToken:'synthetic-other'});f.state.pages=[];assert.equal((await f.prepare(story)).error.code,'META_CREATIVE_IDENTITY_REQUIRED');
  f.state.pages=[{id:'500',instagram_business_account:{id:'888'}}];f.store.putConnection(admin,{...f.connection,scopes:['ads_management']},{accessToken:'synthetic-user-token'});
  const result=await f.prepare(ig);assert.equal(result.error.code,'INSUFFICIENT_SCOPE');assert.ok(result.error.details.required_scopes.includes('instagram_basic'));assert.equal(f.state.writes,0);assert.equal(f.state.reads.includes('/v25.0/777'),false);
 }finally{f.store.close();}
});

test('additional identity reads preserve concurrent execution claims and never retry a lost creative response',async()=>{
 for(const lose of [false,true]){const f=fixture();try{
  const review=ok(await f.prepare(ig));f.state.lose=lose;
  const results=await Promise.all([f.execute(review),f.execute(review)]);assert.equal(f.state.writes,1);
  if(lose){assert.equal(results.every(r=>!r.success),true);assert.equal((await f.execute(review)).success,false);assert.equal(f.state.writes,1);}
  else{assert.ok(results.some(r=>r.success));assert.equal(ok(await f.execute(review)).replayed,true);assert.equal(f.state.writes,1);}
 }finally{f.store.close();}}
});
