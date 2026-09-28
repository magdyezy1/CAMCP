import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * TikTok asset library edits (API for Business v1.3, checked 2026-09-27): renaming images and videos and deleting
 * unused creative assets.
 */
const TIKTOK='37373737-3737-4373-8373-373737373737',gateway='tiktok_native_action',account='123',registry=new Registry();
const actions={image:'tiktok_file_image_ad_update',imageAlias:'tiktok_image_update',video:'tiktok_file_video_ad_update',videoAlias:'tiktok_video_update',delete:'tiktok_creative_asset_delete'};
const actor={tenantId:'tiktok-library-assets',userId:'operator',role:'operator'},owner={...actor,role:'admin'},key=Buffer.alloc(32,97).toString('base64');
const img=n=>'ad-site-i18n-sg/2026092'+n+'5d0d5ff24f8b2e5a4e15b8ea';
function fixture(mode=''){
 const store=new Store(':memory:',key),connection={id:TIKTOK,tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic TikTok',scopes:[]};
 store.putConnection(owner,connection,{accessToken:'synthetic'});
 const images=new Map([[img(1),'Spring hero.jpg'],[img(2),'Old banner.jpg'],[img(3),'Carousel card.jpg'],[img(4),'Smart+ image.jpg'],[img(5),'Taken name.jpg']]);
 const videos=new Map([['v10033g50000aaa1','Spring cut.mp4'],['v10033g50000aaa2','Old cut.mp4'],['v10033g50000aaa3','Running ad.mp4'],['v10033g50000aaa4','Smart+ video.mp4']]);
 const ads=[{ad_id:'401',video_id:'v10033g50000aaa3',image_ids:[img(3)]},{ad_id:'402',image_ids:[]}];
 const smartAds=[{smart_plus_ad_id:'451',creative_list:[{creative_info:{ad_format:'SINGLE_VIDEO',video_info:{video_id:'v10033g50000aaa4'},image_info:[{web_uri:img(4)}]}}]}];
 let writes=0,n=0;const requests=[];
 const ok=data=>Response.json({code:0,message:'OK',request_id:'r'+ ++n,data});
 const transport=new NativeTransport(async(raw,init={})=>{
  const u=new URL(String(raw)),path=u.pathname.replace(/^\/open_api/,''),method=init.method??'GET',q=k=>u.searchParams.get(k);requests.push(method+' '+path+(q('page')?' p'+q('page'):''));
  if(method==='GET'){
   assert.equal(q('advertiser_id'),account);
   const page=Number(q('page')||1),size=Number(q('page_size')||20),filter=q('filtering')?JSON.parse(q('filtering')):{};
   if(path==='/v1.3/file/image/ad/search/'){const rows=[...images].filter(([id])=>filter.image_ids.includes(id)).map(([image_id,file_name])=>({image_id,file_name,material_id:'m-'+image_id.length,format:'jpeg',image_url:'https://p16.example/'+Math.random(),displayable:true,width:1080,height:1920}));return ok({list:rows,page_info:{page,page_size:size,total_number:rows.length,total_page:1}});}
   if(path==='/v1.3/file/video/ad/search/'){const rows=[...videos].filter(([id])=>filter.video_ids.includes(id)).map(([video_id,file_name])=>({video_id,file_name,format:'mp4',preview_url:'https://v16.example/'+Math.random(),duration:12.5}));return ok({list:rows,page_info:{page,page_size:size,total_number:rows.length,total_page:1}});}
   if(path==='/v1.3/ad/get/')return ok({list:ads.map(a=>({advertiser_id:account,...a})),page_info:{page,page_size:size,total_number:ads.length,total_page:1}});
   if(path==='/v1.3/smart_plus/ad/get/')return ok({list:smartAds,page_info:{page,page_size:size,total_number:smartAds.length,total_page:1}});
   throw new Error('Unexpected TikTok read '+path);
  }
  const b=JSON.parse(init.body);writes++;
  if(mode==='error')return Response.json({code:40002,message:'Asset is being processed',request_id:'r'+ ++n,data:{}});
  if(mode==='ignore')return ok(path.endsWith('/delete/')?{failed_video_ids:[],failed_image_ids:[]}:{});
  const rename=(map,id)=>{const taken=[...map].some(([other,name])=>other!==id&&name===b.file_name);map.set(id,taken?b.file_name+'_1727481600123':b.file_name);};
  if(path==='/v1.3/file/image/ad/update/'){rename(images,b.image_id);return ok({});}
  if(path==='/v1.3/file/video/ad/update/'){rename(videos,b.video_id);return ok({});}
  if(path==='/v1.3/creative/asset/delete/'){
   if(mode==='partial')return ok({failed_video_ids:b.video_ids??[],failed_image_ids:[]});
   for(const id of b.image_ids??[])images.delete(id);for(const id of b.video_ids??[])videos.delete(id);return ok({failed_video_ids:[],failed_image_ids:[]});
  }
  throw new Error('Unexpected TikTok request '+method+' '+path);
 });
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 const prepare=(action,payload)=>service.call('amcp_write',{action:'prepare',gateway,connection_id:TIKTOK,arguments:{action,account_id:account,payload:{advertiser_id:account,...payload}}},actor);
 const execute=p=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,images,videos,requests,prepare,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};

test('an image and a video are renamed through both action names and verify; a taken name verifies with TikTok\'s timestamp; a replay sends nothing',async()=>{
 const f=fixture();try{
  const i=ok(await f.prepare(actions.image,{image_id:img(1),file_name:'Spring hero v2.jpg'}));assert.equal(i.data.creative_impact.operation,'rename');assert.equal(i.data.creative_impact.may_affect_serving,false);
  ok(await f.execute(i));assert.equal(f.images.get(img(1)),'Spring hero v2.jpg');assert.equal(ok(await f.verify(i)).data.status,'verified');
  assert.equal((await f.execute(i)).data.replayed,true);assert.equal(f.writes(),1);
  const v=ok(await f.prepare(actions.videoAlias,{video_id:'v10033g50000aaa1',file_name:'Spring cut 15s.mp4'}));ok(await f.execute(v));assert.equal(ok(await f.verify(v)).data.status,'verified');
  const t=ok(await f.prepare(actions.imageAlias,{image_id:img(2),file_name:'Taken name.jpg'}));ok(await f.execute(t));
  assert.equal(f.images.get(img(2)),'Taken name.jpg_1727481600123');assert.equal(ok(await f.verify(t)).data.status,'verified');
  const w=ok(await f.prepare(actions.video,{video_id:'v10033g50000aaa2',file_name:'Old cut v2.mp4'}));ok(await f.execute(w));assert.equal(ok(await f.verify(w)).data.status,'verified');
  assert.equal(f.writes(),4);
 }finally{f.store.close();}
});

test('unused images and videos are deleted and verify gone; assets an ad or an Upgraded Smart+ ad uses are refused; owner deletion rules apply',async()=>{
 const f=fixture();try{
  const d=ok(await f.prepare(actions.delete,{image_ids:[img(2),img(1)],video_ids:['v10033g50000aaa2']}));assert.equal(d.data.creative_impact.deleting.images.length,2);
  assert.ok(f.requests.includes('GET /v1.3/smart_plus/ad/get/ p1'),'Upgraded Smart+ ads are read');
  ok(await f.execute(d));assert.equal(f.images.has(img(1))||f.images.has(img(2))||f.videos.has('v10033g50000aaa2'),false);assert.equal(ok(await f.verify(d)).data.status,'verified');
  const used=await f.prepare(actions.delete,{image_ids:[img(3),img(4),img(5)],video_ids:['v10033g50000aaa3','v10033g50000aaa4']});assert.equal(used.error?.code,'ASSET_IN_USE');
  assert.deepEqual(used.error.details.in_use,{[img(3)]:['401'],[img(4)]:['451'],v10033g50000aaa3:['401'],v10033g50000aaa4:['451']});
  assert.equal((await f.prepare(actions.delete,{video_ids:['v10033g50000zzz9']})).error?.code,'STATE_NOT_FOUND');
  assert.equal(f.writes(),1);
 }finally{f.store.close();}
 const g=fixture();try{saveSpendPolicy(g.store,owner,{gateway,account_id:account,confirmed:true,policy:{allow_deletion:false}});assert.equal((await g.prepare(actions.delete,{image_ids:[img(1)]})).error?.code,'POLICY_DELETION_FORBIDDEN');ok(await g.prepare(actions.image,{image_id:img(1),file_name:'Renamed.jpg'}));}finally{g.store.close();}
});

test('malformed requests are refused before any request; unknown assets and unchanged names after reading',async()=>{
 const cases=[
  ['another advertiser',actions.image,{advertiser_id:'999',image_id:img(1),file_name:'X.jpg'}],
  ['101 characters',actions.image,{image_id:img(1),file_name:'x'.repeat(101)}],
  ['a leading space',actions.video,{video_id:'v10033g50000aaa1',file_name:' Spring.mp4'}],
  ['no name',actions.video,{video_id:'v10033g50000aaa1'}],
  ['a video ID with a slash',actions.video,{video_id:'v1/../x',file_name:'X.mp4'}],
  ['another field',actions.image,{image_id:img(1),file_name:'X.jpg',displayable:true}],
  ['nothing to delete',actions.delete,{}],
  ['an empty list',actions.delete,{image_ids:[]}],
  ['51 videos',actions.delete,{video_ids:Array.from({length:51},(_,i)=>'v10033g5000'+String(i).padStart(4,'0'))}],
  ['an image twice',actions.delete,{image_ids:[img(1),img(1)]}],
  ['a material ID list',actions.delete,{material_ids:['1']}]
 ];
 for(const [label,action,payload] of cases){const f=fixture();try{const r=await f.prepare(action,payload);assert.ok(['INVALID_TIKTOK_LIBRARY_ASSET','ACCOUNT_SCOPE_MISMATCH'].includes(r.error?.code),label+': '+JSON.stringify(r).slice(0,300));assert.equal(f.requests.length,0,label);}finally{f.store.close();}}
 const f=fixture();try{
  assert.equal((await f.prepare(actions.image,{image_id:img(9),file_name:'X.jpg'})).error?.code,'STATE_NOT_FOUND');
  assert.equal((await f.prepare(actions.video,{video_id:'v10033g50000aaa1',file_name:'Spring cut.mp4'})).error?.code,'INVALID_TIKTOK_LIBRARY_ASSET');
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('error and partial replies are never resubmitted, ignored edits are not verified, and the ledger lists the five rows',async()=>{
 const e=fixture('error');try{const p=ok(await e.prepare(actions.image,{image_id:img(1),file_name:'X.jpg'}));assert.equal((await e.execute(p)).success,false);assert.equal((await e.execute(p)).success,false);assert.equal(e.writes(),1);}finally{e.store.close();}
 const h=fixture('partial');try{const p=ok(await h.prepare(actions.delete,{image_ids:[img(1)],video_ids:['v10033g50000aaa1']}));assert.equal((await h.execute(p)).success,false);assert.equal((await h.execute(p)).success,false);assert.equal(h.writes(),1);}finally{h.store.close();}
 const g=fixture('ignore');try{for(const p of [ok(await g.prepare(actions.image,{image_id:img(1),file_name:'X.jpg'})),ok(await g.prepare(actions.delete,{video_ids:['v10033g50000aaa2']}))]){ok(await g.execute(p));assert.notEqual(ok(await g.verify(p)).data.status,'verified');}}finally{g.store.close();}
 const rows=actionContracts(registry).filter(r=>r.gateway===gateway);
 for(const action of Object.values(actions)){const row=rows.find(r=>r.action===action);assert.equal(row?.status,'reviewed_write_family',action);assert.equal(row.family,'tiktok_library_assets',action);}
});
