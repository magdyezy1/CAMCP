import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * DV360 YouTube video ad assets, Display & Video 360 API v4 (pinned Discovery document and "Create ad assets" of the
 * Demand Gen guide, checked 2026-09-27): create and bulk create.
 */
const gateway='dv360_native_action',registry=new Registry();
const actor={tenantId:'dv360-ad-assets',userId:'operator',role:'operator'},owner={...actor,role:'admin'};
const A='DV360_ADVERTISERS_AD_ASSETS_';
function fixture(){
 const store=new Store(':memory:',Buffer.alloc(32,83).toString('base64')),calls=[];
 store.putConnection(owner,{id:'dv360',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic DV360',scopes:['https://www.googleapis.com/auth/display-video']},{accessToken:'synthetic'});
 const assets=new Map([['801',{youtubeVideoId:'EXISTING001',entityStatus:'ENTITY_STATUS_ACTIVE'}],['802',{youtubeVideoId:'oldVideo_01',entityStatus:'ENTITY_STATUS_ARCHIVED'}]]);
 let writes=0,next=810,mode='';
 const shown=(id,a)=>({name:'advertisers/123/adAssets/'+id,adAssetId:id,adAssetType:'AD_ASSET_TYPE_YOUTUBE_VIDEO',youtubeVideoAsset:{youtubeVideoId:a.youtubeVideoId},entityStatus:a.entityStatus,...(a.attestation?{syntheticContentAttestationStatus:a.attestation}:{})});
 const make=a=>{const id=String(next++);assets.set(id,{youtubeVideoId:a.youtubeVideoAsset.youtubeVideoId,entityStatus:'ENTITY_STATUS_ACTIVE',...(mode!=='drop_attestation'&&a.syntheticContentAttestationStatus?{attestation:a.syntheticContentAttestationStatus}:{})});return shown(id,assets.get(id));};
 const transport=new NativeTransport(async(url,init)=>{
  const u=new URL(String(url)),path=u.pathname,method=init.method,body=init.body?JSON.parse(String(init.body)):undefined;calls.push({path,method});
  if(method==='GET'){
   if(path==='/v4/advertisers/123/adAssets'){const v=/youtubeVideoAsset\.youtubeVideoId="([^"]+)"/.exec(String(u.searchParams.get('filter')))?.[1];const rows=[...assets].filter(([,a])=>a.youtubeVideoId===v).map(([id,a])=>shown(id,a));return Response.json(rows.length?{adAssets:rows}:{});}
   const m=/^\/v4\/advertisers\/123\/adAssets\/(\d+)$/.exec(path);
   if(m&&assets.has(m[1]))return Response.json(shown(m[1],assets.get(m[1])));
   return Response.json({error:{code:404,message:'Not found',status:'NOT_FOUND'}},{status:404});
  }
  writes++;
  if(path==='/v4/advertisers/123/adAssets'){const a=make(body.adAsset);return Response.json(mode==='wrong_video'?{...a,youtubeVideoAsset:{youtubeVideoId:'otherVideo1'}}:a);}
  if(path==='/v4/advertisers/123/adAssets:bulkCreate'){const made=body.adAssets.map(make);return Response.json({adAssets:mode==='short'?made.slice(1):made});}
  throw new Error('Unexpected write '+method+' '+path);
 },async()=>{},30000,8*1024*1024,10000);
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const create=adAsset=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:A+'CREATE',params:{advertiserId:'123'},body:{adAsset}}},actor);
 const bulk=body=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:A+'BULK_CREATE',params:{advertiserId:'123'},body}},actor);
 const execute=(p,extra={})=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,...extra},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,calls,assets,create,bulk,execute,verify,writes:()=>writes,mode:m=>{mode=m;}};
}
const asset=(id,extra={})=>({adAssetType:'AD_ASSET_TYPE_YOUTUBE_VIDEO',youtubeVideoAsset:{youtubeVideoId:id},...extra});
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};

test('a YouTube video ad asset is created once without spending confirmation and verifies',async()=>{
 const f=fixture();try{
  const p=ok(await f.create(asset('SYNTHETIC01'))),impact=p.data.creative_impact;
  assert.equal(impact.scope,'ad_assets');assert.equal(impact.may_affect_serving,false);assert.deepEqual(impact.youtube_videos,[{youtube_video_id:'SYNTHETIC01',synthetic_content_attestation:null}]);
  ok(await f.execute(p));assert.equal(f.writes(),1);assert.equal(ok(await f.verify(p)).data.status,'verified');
  assert.equal((await f.execute(p)).data.replayed,true);assert.equal(f.writes(),1);
  // A video ID that happens to contain "bid" and "spend" is not a spending change.
  const q=ok(await f.create(asset('xbidspend01')));ok(await f.execute(q));assert.equal(ok(await f.verify(q)).data.status,'verified');
 }finally{f.store.close();}
});

test('a bulk creation verifies every asset, including an AI attestation, and reuses the archived video',async()=>{
 const f=fixture();try{
  const p=ok(await f.bulk({adAssets:[asset('SYNTHETIC02',{syntheticContentAttestationStatus:'IS_SYNTHETIC'}),asset('oldVideo_01')]}));
  ok(await f.execute(p));const v=ok(await f.verify(p));assert.equal(v.data.status,'verified');assert.equal(v.data.checks.length,2);
  assert.equal([...f.assets.values()].filter(a=>a.youtubeVideoId==='oldVideo_01').length,2);
 }finally{f.store.close();}
});

test('malformed asset requests fail before any request',async()=>{
 for(const [label,kind,body,code] of [
  ['image asset','create',{adAssetType:'AD_ASSET_TYPE_IMAGE'}],
  ['short video ID','create',asset('EXISTING00')],
  ['video ID with a space','create',asset('EXISTING 01')],
  // Output-only fields are already refused by the pinned model.
  ['output-only ID','create',asset('SYNTHETIC01',{adAssetId:'5'}),'INVALID_VENDOR_BODY'],
  ['status','create',asset('SYNTHETIC01',{entityStatus:'ENTITY_STATUS_ACTIVE'}),'INVALID_VENDOR_BODY'],
  ['unknown attestation','create',asset('SYNTHETIC01',{syntheticContentAttestationStatus:'SYNTHETIC_CONTENT_ATTESTATION_STATUS_UNSPECIFIED'})],
  ['empty bulk','bulk',{adAssets:[]}],
  ['too many assets','bulk',{adAssets:Array.from({length:26},(_,i)=>asset(('video'+String(i).padStart(6,'0')).slice(0,11)))}],
  ['video twice','bulk',{adAssets:[asset('SYNTHETIC01'),asset('SYNTHETIC01')]}]
 ]){
  const f=fixture();try{const r=kind==='create'?await f.create(body):await f.bulk(body);assert.equal(r.error?.code,code??'INVALID_DV360_AD_ASSET',label+': '+JSON.stringify(r).slice(0,300));assert.equal(f.calls.length,0,label);}finally{f.store.close();}
 }
});

test('a video that is already an active asset is refused with the asset to reuse',async()=>{
 const f=fixture();try{
  const r=await f.bulk({adAssets:[asset('SYNTHETIC01'),asset('EXISTING001')]});
  assert.equal(r.error?.code,'CONFIGURATION_EXISTS');assert.deepEqual(r.error.details.assets,[{youtube_video_id:'EXISTING001',ad_asset_id:'801'}]);assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('receipts with another video or a missing asset are failures, and a lost attestation is inconclusive',async()=>{
 {const f=fixture();try{const p=ok(await f.create(asset('SYNTHETIC01')));f.mode('wrong_video');assert.equal((await f.execute(p)).success,false);assert.equal((await f.verify(p)).error?.code,'WRITE_PARTIAL_OR_FAILED');}finally{f.store.close();}}
 {const f=fixture();try{const p=ok(await f.bulk({adAssets:[asset('SYNTHETIC01'),asset('SYNTHETIC02')]}));f.mode('short');assert.equal((await f.execute(p)).success,false);assert.equal((await f.execute(p)).data.replayed,true);assert.equal(f.writes(),1);}finally{f.store.close();}}
 const f=fixture();try{
  const p=ok(await f.create(asset('SYNTHETIC01',{syntheticContentAttestationStatus:'NOT_SYNTHETIC'})));f.mode('drop_attestation');ok(await f.execute(p));
  const v=ok(await f.verify(p));assert.equal(v.data.status,'inconclusive');assert.deepEqual(v.data.checks[0].changed_fields,['/synthetic_content_attestation_status']);
 }finally{f.store.close();}
});

test('the ad asset model and methods match the pinned Discovery document',()=>{
 const doc=JSON.parse(readFileSync('.mirror/VENDOR/dv360-v4.json','utf8')).document,S=doc.schemas,m=doc.resources.advertisers.resources.adAssets.methods;
 assert.deepEqual([m.create.httpMethod,m.create.path,m.create.request.$ref],['POST','v4/advertisers/{+advertiserId}/adAssets','CreateAdAssetRequest']);
 assert.deepEqual([m.bulkCreate.httpMethod,m.bulkCreate.path,m.bulkCreate.request.$ref],['POST','v4/advertisers/{+advertiserId}/adAssets:bulkCreate','BulkCreateAdAssetsRequest']);
 assert.match(m.create.description,/AD_ASSET_TYPE_YOUTUBE_VIDEO/);assert.match(m.get.description,/AD_ASSET_TYPE_YOUTUBE_VIDEO/);
 assert.deepEqual(Object.keys(S.YoutubeVideoAsset.properties),['youtubeVideoId']);
 assert.deepEqual(S.AdAsset.properties.syntheticContentAttestationStatus.enum,['SYNTHETIC_CONTENT_ATTESTATION_STATUS_UNSPECIFIED','NOT_SYNTHETIC','IS_SYNTHETIC']);
 assert.match(m.list.parameters.filter.description,/youtubeVideoAsset\.youtubeVideoId/);
});
