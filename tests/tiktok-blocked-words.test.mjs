import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Ad comment blocked words (API for Business v1.3, checked 2026-09-27): creating, replacing and deleting words, and export
 * tasks. Replies carry no word IDs, so the complete list is read before and after.
 */
const TIKTOK='32323232-3232-4323-8323-323232323232',gateway='tiktok_native_action',account='123',registry=new Registry();
const actions={create:'tiktok_blockedword_create',update:'tiktok_blockedword_update',remove:'tiktok_blockedword_delete',export:'tiktok_blockedword_task_create'};
const actor={tenantId:'tiktok-blocked-words',userId:'operator',role:'operator'},owner={...actor,role:'admin'},key=Buffer.alloc(32,91).toString('base64');
function fixture(mode=''){
 const store=new Store(':memory:',key),connection={id:TIKTOK,tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic TikTok',scopes:[]};
 store.putConnection(owner,connection,{accessToken:'synthetic'});
 const blocked=['hell','scam',...Array.from({length:3},(_,i)=>'word'+i)],tasks=new Map();
 let writes=0,n=0,next=500;const requests=[];
 const ok=data=>Response.json({code:0,message:'OK',request_id:'r'+ ++n,data});
 const transport=new NativeTransport(async(raw,init={})=>{
  const u=new URL(String(raw)),path=u.pathname.replace(/^\/open_api/,''),method=init.method??'GET',q=k=>u.searchParams.get(k);requests.push(method+' '+path+(q('page')?' p'+q('page'):''));
  if(method==='GET'){
   assert.equal(q('advertiser_id'),account);
   if(path==='/v1.3/blockedword/list/'){
    // Pages of two words: every page must be read.
    const page=Number(q('page')),size=mode==='small-pages'?2:Number(q('page_size')),total=Math.max(1,Math.ceil(blocked.length/size));
    return ok({list:blocked.slice((page-1)*size,page*size).map(bw_content=>({bw_content})),page_info:{page,page_size:size,total_number:blocked.length,total_page:total}});
   }
   if(path==='/v1.3/blockedword/task/check/')return ok({task_id:q('task_id'),status:tasks.get(q('task_id'))??'FAILED'});
   throw new Error('Unexpected TikTok read '+path);
  }
  const b=JSON.parse(init.body);writes++;
  if(mode==='error')return Response.json({code:40002,message:'Invalid word',request_id:'r'+ ++n,data:{}});
  if(path==='/v1.3/blockedword/create/'){if(mode!=='ignore')blocked.push(...b.blocked_words);return ok({});}
  if(path==='/v1.3/blockedword/update/'){if(mode!=='ignore'){blocked.splice(blocked.indexOf(b.old_word),1);blocked.push(b.new_word);}return ok(undefined);}
  if(path==='/v1.3/blockedword/delete/'){if(mode!=='ignore')for(const w of b.blocked_words){const i=blocked.indexOf(w);if(i>=0)blocked.splice(i,1);}return ok({});}
  if(path==='/v1.3/blockedword/task/create/'){const id=String(next++);tasks.set(id,mode==='running'?'RUNNING':'SUCCEED');return ok({task_id:id});}
  throw new Error('Unexpected TikTok request '+method+' '+path);
 });
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 const prepare=(action,payload)=>service.call('amcp_write',{action:'prepare',gateway,connection_id:TIKTOK,arguments:{action,account_id:account,payload:{advertiser_id:account,...payload}}},actor);
 const execute=p=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,blocked,tasks,requests,prepare,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};

test('words are blocked after reading every page, replaced and unblocked, each verified against the complete list; a replay sends nothing',async()=>{
 const f=fixture('small-pages');try{
  const c=ok(await f.prepare(actions.create,{blocked_words:['free money','bad TikTok']}));
  assert.deepEqual(f.requests.filter(r=>r.includes('/list/')),['GET /v1.3/blockedword/list/ p1','GET /v1.3/blockedword/list/ p2','GET /v1.3/blockedword/list/ p3']);
  assert.equal(c.data.creative_impact.scope,'blocked_words');assert.deepEqual(c.data.creative_impact.before,{count:5});assert.deepEqual(c.data.creative_impact.after,{count:7});
  ok(await f.execute(c));assert.equal(ok(await f.verify(c)).data.status,'verified');assert.equal((await f.execute(c)).data.replayed,true);assert.equal(f.writes(),1);
  const u=ok(await f.prepare(actions.update,{old_word:'hell',new_word:'heck'}));assert.match(u.data.creative_impact.effect,/become public/);
  ok(await f.execute(u));assert.ok(f.blocked.includes('heck')&&!f.blocked.includes('hell'));assert.equal(ok(await f.verify(u)).data.status,'verified');
  const d=ok(await f.prepare(actions.remove,{blocked_words:['scam']}));ok(await f.execute(d));assert.equal(f.blocked.includes('scam'),false);assert.equal(ok(await f.verify(d)).data.status,'verified');
  assert.equal(f.writes(),3);
 }finally{f.store.close();}
});

test('an export task is started and verifies once it succeeds; a running task is not yet verified',async()=>{
 const f=fixture();try{
  const e=ok(await f.prepare(actions.export,{lang:'EN'}));assert.match(e.data.creative_impact.effect,/nothing changes/);
  ok(await f.execute(e));assert.equal(ok(await f.verify(e)).data.status,'verified');
 }finally{f.store.close();}
 const g=fixture('running');try{
  const e=ok(await g.prepare(actions.export,{blocked_words:['hell']}));ok(await g.execute(e));assert.notEqual(ok(await g.verify(e)).data.status,'verified');
  g.tasks.set([...g.tasks.keys()][0],'SUCCEED');assert.equal(ok(await g.verify(e)).data.status,'verified');
 }finally{g.store.close();}
});

test('malformed requests are refused before any request; taken, unknown and too many words after reading',async()=>{
 const cases=[
  ['another advertiser',f=>f.prepare(actions.create,{advertiser_id:'999',blocked_words:['x']})],
  ['empty list',f=>f.prepare(actions.create,{blocked_words:[]})],
  ['long word',f=>f.prepare(actions.create,{blocked_words:['x'.repeat(31)]})],
  ['padded word',f=>f.prepare(actions.create,{blocked_words:[' spam']})],
  ['the same word twice',f=>f.prepare(actions.create,{blocked_words:['Spam','spam']})],
  ['another field',f=>f.prepare(actions.remove,{blocked_words:['hell'],lang:'EN'})],
  ['an unchanged replacement',f=>f.prepare(actions.update,{old_word:'hell',new_word:'HELL'})],
  ['an unknown export language',f=>f.prepare(actions.export,{lang:'FR'})]
 ];
 for(const [label,run] of cases){const f=fixture();try{const r=await run(f);assert.ok(['INVALID_TIKTOK_BLOCKED_WORD','ACCOUNT_SCOPE_MISMATCH'].includes(r.error?.code),label+': '+JSON.stringify(r).slice(0,300));assert.equal(f.requests.length,0,label);}finally{f.store.close();}}
 const f=fixture();try{
  assert.equal((await f.prepare(actions.create,{blocked_words:['SCAM']})).error?.code,'CONFIGURATION_EXISTS');
  assert.equal((await f.prepare(actions.update,{old_word:'nope',new_word:'fine'})).error?.code,'STATE_NOT_FOUND');
  assert.equal((await f.prepare(actions.update,{old_word:'hell',new_word:'scam'})).error?.code,'CONFIGURATION_EXISTS');
  assert.equal((await f.prepare(actions.remove,{blocked_words:['hell','nope']})).error?.code,'STATE_NOT_FOUND');
  for(let i=0;i<495;i++)f.blocked.push('filler'+i);
  assert.equal((await f.prepare(actions.create,{blocked_words:['one more']})).error?.code,'INVALID_TIKTOK_BLOCKED_WORD');
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('an error reply is never resubmitted, ignored writes are not verified, and the ledger lists all four writes',async()=>{
 const e=fixture('error');try{const p=ok(await e.prepare(actions.create,{blocked_words:['x']}));assert.equal((await e.execute(p)).success,false);assert.equal((await e.execute(p)).success,false);assert.equal(e.writes(),1);}finally{e.store.close();}
 const g=fixture('ignore');try{for(const p of [ok(await g.prepare(actions.create,{blocked_words:['x']})),ok(await g.prepare(actions.update,{old_word:'hell',new_word:'heck'})),ok(await g.prepare(actions.remove,{blocked_words:['scam']}))]){ok(await g.execute(p));assert.notEqual(ok(await g.verify(p)).data.status,'verified');}}finally{g.store.close();}
 for(const action of Object.values(actions)){const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&r.action===action);assert.equal(rows.length,1,action);assert.equal(rows[0].status,'reviewed_write_family',action);assert.equal(rows[0].family,'tiktok_blocked_words',action);}
});
