import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Media library and account media of an X Ads account, Ads API v12 (Creatives reference, "Media Library" and "Account
 * Media"; checked 2026-09-27).
 */
const registry=new Registry(),gateway='x_ads_native_action',account='acct1';
const actor={tenantId:'x-media-library',userId:'operator',role:'operator'},admin={...actor,role:'admin'};
const secret={accessToken:'synthetic-token',consumerKey:'synthetic-key',consumerSecret:'synthetic-secret',tokenSecret:'synthetic-token-secret'};
const actions={update:'x_accounts_account_id_media_library_media_key_put',remove:'x_accounts_account_id_media_library_media_key_delete',removeAsset:'x_accounts_account_id_account_media_account_media_id_delete'};
const copy=x=>structuredClone(x);
const image=(key,extra={})=>({media_key:key,media_type:'IMAGE',media_category:'TWEET_IMAGE',media_status:'TRANSCODE_COMPLETED',name:null,file_name:null,tweeted:false,deleted:false,...extra});
const video=(key,extra={})=>({media_key:key,media_type:'VIDEO',media_category:'AMPLIFY_VIDEO',media_status:'TRANSCODE_COMPLETED',name:null,file_name:null,title:null,description:null,poster_media_key:null,tweeted:false,deleted:false,...extra});
function setup(mode=''){
 const store=new Store(':memory:',Buffer.alloc(32,98).toString('base64'));
 store.putConnection(admin,{id:'x',tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic',scopes:[]},secret);
 const library={'3_100':image('3_100',{name:'Hero'}),'3_101':image('3_101',{name:'Spare',tweeted:true}),'3_102':image('3_102'),'3_103':image('3_103',{deleted:true}),'13_200':video('13_200',{name:'Trailer'}),'13_201':video('13_201',{name:'Teaser'}),'16_300':{...video('16_300'),media_type:'GIF',media_category:'TWEET_GIF'}};
 const assets={am1:{id:'am1',creative_type:'PREROLL',video_id:'13_200',media_url:null,deleted:false},am2:{id:'am2',creative_type:'PREROLL',video_id:'13_201',media_url:null,deleted:false},am3:{id:'am3',creative_type:'INTERSTITIAL',video_id:null,media_url:'https://pbs.twimg.com/ad_img/1/a.jpg',deleted:false}};
 const creatives={mc1:{id:'mc1',line_item_id:'line1',account_media_id:'am1',deleted:false},mc2:{id:'mc2',line_item_id:'line1',account_media_id:'am3',deleted:true}};
 const cards=[{id:'c1',card_uri:'card://1',name:'Hero card',card_type:'IMAGE_WEBSITE',components:[{type:'MEDIA',media_key:'3_100'},{type:'DETAILS',title:'Shop',destination:{type:'WEBSITE',url:'https://example.com'}}],deleted:false},{id:'c2',card_uri:'card://2',name:'Legacy',legacy:true,image_media_key:'3_101',deleted:false}];
 const calls=[];let writes=0;
 const transport=new NativeTransport(async(url,init)=>{
  const u=new URL(String(url)),method=init?.method??'GET',suffix=u.pathname.replace('/12/accounts/'+account,'');calls.push({method,path:u.pathname,query:Object.fromEntries(u.searchParams)});
  const reply=data=>Response.json({data:copy(data),request:{params:{account_id:account}},...(Array.isArray(data)?{next_cursor:null}:{})});
  const missing=()=>Response.json({errors:[{code:'NOT_FOUND',message:'Not found'}],request:{params:{}}},{status:404});
  if(method==='GET'){
   if(!suffix)return reply({id:account,name:'Account',deleted:false});
   let m=/^\/media_library\/(\w+)$/.exec(suffix);if(m)return library[m[1]]?reply(library[m[1]]):missing();
   m=/^\/account_media\/(\w+)$/.exec(suffix);if(m)return assets[m[1]]?reply(assets[m[1]]):missing();
   if(suffix==='/account_media')return reply(Object.values(assets).filter(a=>!a.deleted));
   if(suffix==='/media_creatives')return reply(Object.values(creatives).filter(c=>!c.deleted));
   if(suffix==='/cards')return reply(cards.filter(c=>!c.deleted&&(!c.legacy||u.searchParams.get('include_legacy_cards')==='true')));
   return missing();
  }
  writes++;const form=Object.fromEntries(new URLSearchParams(String(init.body??'')));
  let m=/^\/media_library\/(\w+)$/.exec(suffix);
  if(m&&method==='PUT'){const row={...library[m[1]],...form};if(mode!=='ignore')library[m[1]]=row;return reply(mode==='other'?{...row,media_key:'3_999'}:row);}
  if(m&&method==='DELETE'){const row={...library[m[1]],deleted:true};if(mode!=='ignore')delete library[m[1]];return reply(row);}
  m=/^\/account_media\/(\w+)$/.exec(suffix);
  if(m&&method==='DELETE'){const row={...assets[m[1]],deleted:true};if(mode!=='ignore')assets[m[1]]=row;return reply(row);}
  throw Error('Unexpected write '+method+' '+suffix);
 });
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const prepare=(action,payload,params)=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action,account_id:account,params,...(payload?{payload}:{})}},actor);
 const edit=(key,payload)=>prepare(actions.update,payload,{media_key:key});
 const remove=key=>prepare(actions.remove,undefined,{media_key:key});
 const removeAsset=id=>prepare(actions.removeAsset,undefined,{account_media_id:id});
 const execute=p=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,calls,library,assets,edit,remove,removeAsset,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};

test('an image is renamed and a video and a GIF get a title, description and poster, each verified; a replay sends nothing',async()=>{
 const x=setup();try{
  const p=ok(await x.edit('3_101',{name:'Spring hero'}));assert.equal(p.data.creative_impact.scope,'media_library');assert.equal(p.data.creative_impact.before.name,'Spare');
  ok(await x.execute(p));assert.equal(x.library['3_101'].name,'Spring hero');assert.equal(ok(await x.verify(p)).data.status,'verified');assert.equal((await x.execute(p)).data.replayed,true);assert.equal(x.writes(),1);
  const v=ok(await x.edit('13_201',{title:'Teaser cut',description:'Thirty seconds',poster_media_key:'3_102',file_name:'teaser.mp4'}));ok(await x.execute(v));assert.equal(x.library['13_201'].poster_media_key,'3_102');assert.equal(ok(await x.verify(v)).data.status,'verified');
  const g=ok(await x.edit('16_300',{title:'Loop'}));ok(await x.execute(g));assert.equal(ok(await x.verify(g)).data.status,'verified');
 }finally{x.store.close();}
});

test('unused media and account media are deleted and verify gone; media still used by cards or media creatives is refused',async()=>{
 const x=setup();try{
  const d=ok(await x.remove('13_201'));assert.deepEqual(d.data.creative_impact.usage,{accountMedia:['am2'],mediaCreatives:[],cards:[]});
  ok(await x.execute(d));assert.equal(x.library['13_201'],undefined);assert.equal(ok(await x.verify(d)).data.status,'verified');
  const a=ok(await x.removeAsset('am3'));ok(await x.execute(a));assert.equal(x.assets.am3.deleted,true);assert.equal(ok(await x.verify(a)).data.status,'verified');
  const card=await x.remove('3_100');assert.equal(card.error?.code,'MEDIA_IN_USE');assert.match(card.error?.message??'',/card card:\/\/1/);
  assert.equal((await x.remove('3_101')).error?.code,'MEDIA_IN_USE');
  const video=await x.remove('13_200');assert.equal(video.error?.code,'MEDIA_IN_USE');assert.match(video.error?.message??'',/media creative mc1/);
  assert.equal((await x.removeAsset('am1')).error?.code,'MEDIA_IN_USE');
  assert.equal(x.writes(),2);
 }finally{x.store.close();}
 const owner=setup();try{saveSpendPolicy(owner.store,admin,{gateway,account_id:account,confirmed:true,policy:{allow_deletion:false}});assert.equal((await owner.remove('13_201')).error?.code,'POLICY_DELETION_FORBIDDEN');assert.equal((await owner.removeAsset('am3')).error?.code,'POLICY_DELETION_FORBIDDEN');ok(await owner.edit('3_101',{name:'Kept'}));}finally{owner.store.close();}
});

test('malformed media edits and deletions are refused before any request',async()=>{
 const cases=[
  ['empty edit',x=>x.edit('3_101',{})],
  ['unknown field',x=>x.edit('3_101',{name:'A',media_category:'TWEET_IMAGE'})],
  ['media key in body',x=>x.edit('3_101',{media_key:'3_102'})],
  ['long name',x=>x.edit('3_101',{name:'n'.repeat(101)})],
  ['long file name',x=>x.edit('3_101',{file_name:'f'.repeat(256)})],
  ['long title',x=>x.edit('13_201',{title:'t'.repeat(71)})],
  ['long description',x=>x.edit('13_201',{description:'d'.repeat(201)})],
  ['control character',x=>x.edit('3_101',{name:'A\u0007B'})],
  ['surrounding spaces',x=>x.edit('3_101',{name:' Hero '})],
  ['poster key',x=>x.edit('13_201',{poster_media_key:'poster'})],
  ['non-string name',x=>x.edit('3_101',{name:7})],
  ['malformed media key',x=>x.edit('hero',{name:'Hero'})],
  ['malformed key on deletion',x=>x.remove('3_x1')]
 ];
 for(const [label,run] of cases){const x=setup();try{const r=await run(x);assert.equal(r.error?.code,'INVALID_X_MEDIA_LIBRARY',label+': '+JSON.stringify(r).slice(0,300));assert.equal(x.calls.length,0,label);}finally{x.store.close();}}
});

test('video fields on images, unusable posters, unchanged values, deleted media and unknown media are refused after reading, without writes',async()=>{
 const x=setup();try{
  assert.match((await x.edit('3_101',{title:'Hero'})).error?.message??'',/apply to videos and GIFs/);
  assert.match((await x.edit('13_201',{poster_media_key:'13_200'})).error?.message??'',/ready image/);
  assert.match((await x.edit('13_201',{poster_media_key:'3_103'})).error?.message??'',/ready image/);
  assert.match((await x.edit('13_201',{name:'Teaser'})).error?.message??'',/already has these values/);
  assert.match((await x.edit('3_103',{name:'Back'})).error?.message??'',/3_103 is deleted/);
  assert.equal((await x.edit('3_999',{name:'Unknown'})).error?.code,'STATE_NOT_FOUND');
  assert.equal((await x.remove('3_999')).error?.code,'STATE_NOT_FOUND');
  assert.equal((await x.removeAsset('am9')).error?.code,'STATE_NOT_FOUND');
  assert.equal(x.writes(),0);
 }finally{x.store.close();}
});

test('a receipt for other media is never resubmitted, an ignored deletion is not verified, and the ledger lists the three writes',async()=>{
 const other=setup('other');try{const p=ok(await other.edit('3_101',{name:'Other'}));assert.equal((await other.execute(p)).success,false);assert.equal((await other.execute(p)).success,false);assert.equal(other.writes(),1);}finally{other.store.close();}
 const ignored=setup('ignore');try{for(const p of [ok(await ignored.remove('13_201')),ok(await ignored.removeAsset('am3'))]){ok(await ignored.execute(p));assert.notEqual(ok(await ignored.verify(p)).data.status,'verified');}}finally{ignored.store.close();}
 for(const action of Object.values(actions)){const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&r.action===action);assert.equal(rows.length,1,action);assert.equal(rows[0].status,'reviewed_write_family',action);assert.equal(rows[0].family,'x_media_library',action);}
});
