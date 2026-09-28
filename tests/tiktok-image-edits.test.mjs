import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Editing TikTok library images ("Edit an image", API for Business v1.3, checked 2026-09-28).
 */
const TIKTOK='38383838-3838-4383-8383-383838383838',gateway='tiktok_native_action',account='123',action='tiktok_creative_image_edit_get',registry=new Registry();
const actor={tenantId:'tiktok-image-edits',userId:'operator',role:'operator'},owner={...actor,role:'admin'},key=Buffer.alloc(32,105).toString('base64');
const img=n=>'ad-site-i18n-sg/2026092'+n+'5d0d5ff24f8b2e5a4e15b8ea';
function fixture(mode=''){
 const store=new Store(':memory:',key),connection={id:TIKTOK,tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic TikTok',scopes:[]};
 store.putConnection(owner,connection,{accessToken:'synthetic'});
 const images=new Map([[img(1),{file_name:'Spring hero.jpg',width:1200,height:628}],[img(2),{file_name:'Square card.jpg',width:640,height:640}],[img(3),{file_name:'Taken name.jpg',width:720,height:1280}]]);
 let writes=0,n=0,made=0;const requests=[];
 const ok=data=>Response.json({code:0,message:'OK',request_id:'r'+ ++n,data});
 const transport=new NativeTransport(async(raw,init={})=>{
  const u=new URL(String(raw)),path=u.pathname.replace(/^\/open_api/,''),method=init.method??'GET',q=k=>u.searchParams.get(k);requests.push(method+' '+path);
  if(method==='GET'&&path==='/v1.3/file/image/ad/search/'){
   assert.equal(q('advertiser_id'),account);const filter=JSON.parse(q('filtering'));
   const rows=[...images].filter(([id])=>filter.image_ids.includes(id)).map(([image_id,i])=>({image_id,material_id:'m'+image_id.length,format:'jpeg',image_url:'https://p16.example/'+Math.random(),displayable:true,size:22305,signature:'d96d4e822020e862ed43e1d0bd104fda',modify_time:new Date().toISOString(),...i}));
   return ok({list:rows,page_info:{page:1,page_size:20,total_number:rows.length,total_page:1}});
  }
  if(method==='POST'&&path==='/v1.3/creative/image/edit/'){
   const b=JSON.parse(init.body);writes++;assert.equal(b.advertiser_id,account);
   if(mode==='error')return Response.json({code:40002,message:'Image is being processed',request_id:'r'+ ++n,data:{}});
   const id='ad-site-i18n-sg/edited'+ ++made+'d0d5ff24f8b2e5a4e15b8ea',taken=[...images.values()].some(i=>i.file_name===b.image_name);
   const name=b.image_name===undefined?'edited_'+made+'.jpg':taken?b.image_name+'_1727481600123':b.image_name;
   const width=mode==='resized'?b.width+2:b.width;
   if(mode!=='ignore')images.set(id,{file_name:name,width,height:b.height});
   return ok({image_id:id,material_id:'m'+made,displayable:true,width,height:b.height,format:'jpeg',image_url:'https://p16.example/new',signature:'x',size:1,file_name:name});
  }
  throw new Error('Unexpected TikTok request '+method+' '+path);
 });
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 const prepare=payload=>service.call('amcp_write',{action:'prepare',gateway,connection_id:TIKTOK,arguments:{action,account_id:account,payload:{advertiser_id:account,...payload}}},actor);
 const execute=p=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,images,requests,prepare,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};

test('an image is cropped and padded into new library images that verify; a taken name verifies with TikTok\'s timestamp; a replay sends nothing',async()=>{
 const f=fixture();try{
  const crop=ok(await f.prepare({image_id:img(1),edit_method:'fix_size',width:640,height:640,image_name:'Spring hero square.jpg'}));
  assert.equal(crop.data.creative_impact.operation,'edit');assert.equal(crop.data.creative_impact.may_affect_serving,false);assert.equal(crop.data.creative_impact.original.width,1200);assert.match(crop.data.creative_impact.effect,/cropped/);
  ok(await f.execute(crop));assert.equal(ok(await f.verify(crop)).data.status,'verified');assert.equal((await f.execute(crop)).data.replayed,true);
  assert.deepEqual(f.images.get(img(1)),{file_name:'Spring hero.jpg',width:1200,height:628},'the source is unchanged');
  const pad=ok(await f.prepare({image_id:img(2),edit_method:'only_gauss_pad',width:1200,height:628}));assert.match(pad.data.creative_impact.effect,/Gaussian blur/);
  ok(await f.execute(pad));assert.equal(ok(await f.verify(pad)).data.status,'verified','without a name only the size is compared');
  const taken=ok(await f.prepare({image_id:img(1),width:720,height:1280,image_name:'Taken name.jpg'}));ok(await f.execute(taken));assert.equal(ok(await f.verify(taken)).data.status,'verified');
  assert.equal(f.writes(),3);
 }finally{f.store.close();}
});

test('malformed edits are refused before any request; unknown images and unchanged sizes after reading',async()=>{
 const cases=[
  ['an unknown field',{image_id:img(1),width:640,height:640,image_url:'https://example.com/a.jpg'},'INVALID_TIKTOK_IMAGE_EDIT'],
  ['no width',{image_id:img(1),height:640},'INVALID_TIKTOK_IMAGE_EDIT'],
  ['a zero height',{image_id:img(1),width:640,height:0},'INVALID_TIKTOK_IMAGE_EDIT'],
  ['a fractional width',{image_id:img(1),width:640.5,height:640},'INVALID_TIKTOK_IMAGE_EDIT'],
  ['an unknown method',{image_id:img(1),width:640,height:640,edit_method:'stretch'},'INVALID_TIKTOK_IMAGE_EDIT'],
  ['a padded name',{image_id:img(1),width:640,height:640,image_name:' Square.jpg'},'INVALID_TIKTOK_IMAGE_EDIT'],
  ['a 101-character name',{image_id:img(1),width:640,height:640,image_name:'x'.repeat(101)},'INVALID_TIKTOK_IMAGE_EDIT'],
  ['a path-like image ID',{image_id:'../secret',width:640,height:640},'INVALID_TIKTOK_IMAGE_EDIT'],
  ['another advertiser',{advertiser_id:'999',image_id:img(1),width:640,height:640},'ACCOUNT_SCOPE_MISMATCH']
 ];
 for(const [label,payload,code] of cases){const f=fixture();try{const r=await f.prepare(payload);assert.equal(r.error?.code,code,label+': '+JSON.stringify(r).slice(0,300));assert.equal(f.requests.length,0,label);}finally{f.store.close();}}
 const f=fixture();try{
  assert.equal((await f.prepare({image_id:img(9),width:640,height:640})).error?.code,'STATE_NOT_FOUND');
  assert.match((await f.prepare({image_id:img(2),width:640,height:640})).error?.message??'',/already 640×640/);
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('an error reply is never resubmitted, a missing or differently sized new image is not verified, and the ledger lists the row',async()=>{
 const e=fixture('error');try{const p=ok(await e.prepare({image_id:img(1),width:640,height:640}));assert.equal((await e.execute(p)).success,false);assert.equal((await e.execute(p)).success,false);assert.equal(e.writes(),1);}finally{e.store.close();}
 for(const mode of ['ignore','resized']){const g=fixture(mode);try{const p=ok(await g.prepare({image_id:img(1),width:640,height:640}));ok(await g.execute(p));assert.notEqual(ok(await g.verify(p)).data.status,'verified',mode);}finally{g.store.close();}}
 const row=actionContracts(registry).find(r=>r.gateway===gateway&&r.action===action);assert.equal(row?.status,'reviewed_write_family');assert.equal(row.family,'tiktok_image_edits');
});
