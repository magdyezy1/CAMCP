import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * DV360 Demand Gen image ad assets through the reviewed media upload (pinned Discovery document: adAssets.upload, and
 * "Create ad assets" and "Create a Demand Gen ad" of the Demand Gen guide, checked 2026-09-27).
 */
const gateway='dv360_native_action',registry=new Registry();
const actor={tenantId:'dv360-image-ad-assets',userId:'operator',role:'operator'},owner={...actor,role:'admin'};
const link='https://drive.google.com/file/d/abcdefghijklmno/view?usp=sharing';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const mp4=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(24)]);
const large=size=>Buffer.concat([png.subarray(0,8),Buffer.alloc(size-8,1)]);
const account={name:'advertisers/123',advertiserId:'123',displayName:'Synthetic advertiser',entityStatus:'ENTITY_STATUS_ACTIVE'};
function fixture(file=png,mode=''){
 const store=new Store(':memory:',Buffer.alloc(32,85).toString('base64')),calls=[];let downloads=0;
 store.putConnection(owner,{id:'dv360',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic DV360',scopes:['https://www.googleapis.com/auth/display-video']},{accessToken:'synthetic'});
 store.putConnection(owner,{id:'meta',tenantId:actor.tenantId,gateway:'meta_native_action',accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic Meta',scopes:[]},{accessToken:'synthetic'});
 const transport=new NativeTransport(async(url,init)=>{
  const u=new URL(String(url)),path=u.pathname,method=init?.method??'GET',headers=new Headers(init?.headers),raw=init?.body?Buffer.from(init.body):undefined;
  const metadata=raw?JSON.parse(/application\/json; charset=UTF-8\r\n\r\n(\{.*?\})\r\n--/s.exec(raw.toString('latin1'))?.[1]??'null'):undefined;
  calls.push({path,method,query:Object.fromEntries(u.searchParams),type:headers.get('content-type'),metadata,bytes:raw});
  if(method==='GET'&&path==='/v4/advertisers/123')return Response.json(account);
  if(method==='POST'&&path==='/upload/v4/advertisers/123/adAssets:uploadAdAsset'){
   const a={name:'advertisers/123/adAssets/901',adAssetId:'901',adAssetType:'AD_ASSET_TYPE_IMAGE',entityStatus:'ENTITY_STATUS_ACTIVE',...(metadata.syntheticContentAttestationStatus?{syntheticContentAttestationStatus:metadata.syntheticContentAttestationStatus}:{})};
   if(mode==='video')return Response.json({adAsset:{...a,adAssetType:'AD_ASSET_TYPE_YOUTUBE_VIDEO',youtubeVideoAsset:{youtubeVideoId:'SYNTHETIC01'}}});
   if(mode==='other_advertiser')return Response.json({adAsset:{...a,name:'advertisers/999/adAssets/901'}});
   if(mode==='other_label')return Response.json({adAsset:{...a,syntheticContentAttestationStatus:'NOT_SYNTHETIC'}});
   if(mode==='no_id')return Response.json({});
   return Response.json({adAsset:a});
  }
  if(method==='POST'&&path==='/upload/v4/advertisers/123/assets')return Response.json({asset:{mediaId:'456',content:'advertiser-assets/456'}});
  throw new Error('Unexpected '+method+' '+path);
 });
 const source=async(input,init)=>{downloads++;assert.equal(new URL(String(input)).hostname,'drive.usercontent.google.com');assert.equal(init?.redirect,'manual');return new Response(new Uint8Array(file),{headers:{'Content-Type':'application/octet-stream'}});};
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0},source);
 const media=input=>service.call('amcp_media',input,actor);
 const prepare=(extra={})=>media({action:'prepare',platform:'dv360',account_id:'123',drive_url:link,name:'Hero image',dv360_target:'ad_asset',...extra});
 const execute=p=>media({action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true});
 const uploads=()=>calls.filter(c=>c.method==='POST');
 return {store,service,calls,uploads,media,prepare,execute,downloads:()=>downloads,close:()=>store.close()};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};

test('an image ad asset is reviewed, uploaded once as AD_ASSET_TYPE_IMAGE with its AI label, and returns the assetId for Demand Gen ads',async()=>{
 const f=fixture();try{
  const p=ok(await f.prepare({synthetic_content:'IS_SYNTHETIC'}));
  assert.equal(p.data.request.dv360_target,'ad_asset');assert.equal(p.data.request.synthetic_content,'IS_SYNTHETIC');assert.equal(p.data.request.filename,'Hero image.png');
  assert.equal(f.uploads().length,0);assert.equal(f.downloads(),1);
  const out=ok(await f.execute(p)),[u]=f.uploads();
  assert.equal(u.path,'/upload/v4/advertisers/123/adAssets:uploadAdAsset');assert.deepEqual(u.query,{uploadType:'multipart'});assert.match(u.type,/^multipart\/related; boundary=amcp_/);
  assert.deepEqual(u.metadata,{filename:'Hero image.png',adAssetType:'AD_ASSET_TYPE_IMAGE',syntheticContentAttestationStatus:'IS_SYNTHETIC'});assert.ok(u.bytes.includes(png));
  assert.equal(out.data.dv360_ad_asset_id,'901');assert.deepEqual(out.data.creative_reference,{assetId:'901'});assert.equal(out.data.dv360_target,'ad_asset');
  assert.deepEqual(out.data.ad_asset,{adAssetId:'901',adAssetType:'AD_ASSET_TYPE_IMAGE',entityStatus:'ENTITY_STATUS_ACTIVE',syntheticContentAttestationStatus:'IS_SYNTHETIC'});
  assert.equal(out.data.status_source,'upload_receipt');assert.equal(out.data.ready,false);
  const count=f.calls.length;assert.equal((await f.execute(p)).data.replayed,true);assert.equal(f.calls.length,count);assert.equal(f.uploads().length,1);
  const listed=ok(await f.media({action:'list',platform:'dv360',account_id:'123'}));assert.equal(JSON.stringify(listed.data).includes('"dv360_ad_asset_id":"901"'),true);
 }finally{f.close();}
});

test('the native DV360_ADVERTISERS_AD_ASSETS_UPLOAD route prepares the same reviewed image ad asset upload; the shared workflow keeps its captured schema',async()=>{
 const f=fixture();try{
  const prepared=ok(await f.service.call('amcp_write',{action:'prepare',gateway,arguments:{action:'DV360_ADVERTISERS_AD_ASSETS_UPLOAD',pathParams:{advertiserId:'123'},payload:{url:link,filename:'Hero image',adAssetType:'AD_ASSET_TYPE_IMAGE',syntheticContentAttestationStatus:'NOT_SYNTHETIC'}}},actor));
  assert.equal(prepared.data.request.dv360_target,'ad_asset');assert.equal(prepared.data.request.synthetic_content,'NOT_SYNTHETIC');assert.equal(prepared.data.client_download_required,false);assert.equal(f.uploads().length,0);
  const next=prepared.data.next_call;assert.equal(next.tool,'amcp_write');const out=ok(await f.service.call(next.tool,next.arguments,actor));
  assert.equal(out.data.dv360_ad_asset_id,'901');assert.equal(f.uploads()[0].path,'/upload/v4/advertisers/123/adAssets:uploadAdAsset');assert.equal(f.uploads()[0].metadata.syntheticContentAttestationStatus,'NOT_SYNTHETIC');
  // platform_media_upload validates against its captured operation schema, which has no ad asset target: use amcp_media or the native route.
  const workflow=await f.service.call('amcp_native_action',{operation:'platform_media_upload',arguments:{action:'UPLOAD_FROM_URL',platform:'dv360',account_id:'123',url:link,media_type:'image',dv360_target:'ad_asset',dry_run:false}},actor);
  assert.equal(workflow.error?.code,'INVALID_ARGUMENT');assert.equal(f.uploads().length,1);
 }finally{f.close();}
});

test('image ad asset requests that cannot be uploaded are refused before any download or upload',async()=>{
 const f=fixture();try{
  const code=r=>r.error?.code;
  assert.equal(code(await f.media({action:'prepare',platform:'meta',account_id:'123',drive_url:link,dv360_target:'ad_asset'})),'INVALID_ARGUMENT');
  assert.equal(code(await f.prepare({dv360_target:'image'})),'INVALID_ARGUMENT');
  assert.equal(code(await f.prepare({dv360_target:undefined,synthetic_content:'IS_SYNTHETIC'})),'INVALID_ARGUMENT');
  assert.equal(code(await f.prepare({synthetic_content:'SYNTHETIC_CONTENT_ATTESTATION_STATUS_UNSPECIFIED'})),'INVALID_ARGUMENT');
  assert.equal(code(await f.prepare({media_type:'video'})),'MEDIA_TYPE_UNSUPPORTED');
  const native=payload=>f.service.call('amcp_write',{action:'prepare',gateway,arguments:{action:'DV360_ADVERTISERS_AD_ASSETS_UPLOAD',pathParams:{advertiserId:'123'},payload:{url:link,...payload}}},actor);
  assert.equal(code(await native({adAssetType:'AD_ASSET_TYPE_YOUTUBE_VIDEO'})),'INVALID_ARGUMENT');
  assert.equal(code(await native({syntheticContentAttestationStatus:'SYNTHETIC_CONTENT_ATTESTATION_STATUS_UNSPECIFIED'})),'INVALID_ARGUMENT');
  assert.equal(code(await native({youtubeVideoAsset:{youtubeVideoId:'SYNTHETIC01'}})),'UNSUPPORTED_MEDIA_PARAMETER');
  assert.equal(code(await native({media_type:'video'})),'MEDIA_TYPE_MISMATCH');
  assert.equal(f.downloads(),0);assert.equal(f.calls.length,0);
  const p=ok(await f.prepare());
  assert.equal(code(await f.media({action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,dv360_target:'creative_asset'})),'INVALID_ARGUMENT');
  assert.equal(f.uploads().length,0);
 }finally{f.close();}
 const video=fixture(mp4);try{assert.equal((await video.prepare()).error?.code,'MEDIA_TYPE_UNSUPPORTED');assert.equal(video.downloads(),1);assert.equal(video.uploads().length,0);}finally{video.close();}
 // Demand Gen images are limited to 5120 KB; DV360 creative assets keep the 10 MB import limit.
 const big=fixture(large(5120*1024+1));try{
  const r=await big.prepare();assert.equal(r.error?.code,'MEDIA_TOO_LARGE');assert.equal(r.error.details.maximum_bytes,5120*1024);
  ok(await big.prepare({dv360_target:'creative_asset'}));assert.equal(big.uploads().length,0);
 }finally{big.close();}
 const edge=fixture(large(5120*1024));try{ok(await edge.prepare());}finally{edge.close();}
});

test('a receipt for a video asset, another advertiser or another AI label is a failure and is never uploaded again',async()=>{
 for(const mode of ['video','other_advertiser','other_label','no_id']){
  const f=fixture(png,mode);try{
   const p=ok(await f.prepare({synthetic_content:'IS_SYNTHETIC'})),out=await f.execute(p);
   assert.equal(out.error?.code,'MEDIA_RESPONSE_INVALID',mode);assert.equal(out.error.details.retry_safe,false,mode);
   if(mode!=='no_id')assert.equal(out.error.details.media_id,'901',mode);
   assert.equal((await f.execute(p)).error?.code,'WRITE_OUTCOME_UNCERTAIN',mode);assert.equal(f.uploads().length,1,mode);
  }finally{f.close();}
 }
});

test('DV360 creative asset uploads keep their route and receipt without an ad asset target',async()=>{
 const f=fixture();try{
  const p=ok(await f.prepare({dv360_target:'creative_asset'}));assert.equal(p.data.request.dv360_target,undefined);
  const out=ok(await f.execute(p));assert.equal(f.uploads()[0].path,'/upload/v4/advertisers/123/assets');assert.deepEqual(f.uploads()[0].metadata,{filename:'Hero image.png'});
  assert.equal(out.data.dv360_media_id,'456');assert.equal(out.data.dv360_ad_asset_id,undefined);assert.equal(out.data.creative_reference,undefined);
 }finally{f.close();}
});

test('the upload method matches the pinned Discovery document, and the ledger routes it to the media workflow',()=>{
 const doc=JSON.parse(readFileSync('.mirror/VENDOR/dv360-v4.json','utf8')).document,S=doc.schemas,m=doc.resources.advertisers.resources.adAssets.methods;
 assert.equal(m.upload.httpMethod,'POST');assert.equal(m.upload.path,'v4/advertisers/{+advertiserId}/adAssets:uploadAdAsset');
 assert.deepEqual(m.upload.mediaUpload.protocols,{simple:{multipart:true,path:'/upload/v4/advertisers/{+advertiserId}/adAssets:uploadAdAsset'}});
 assert.match(m.upload.description,/Only supports the uploading of assets with the AdAssetType `AD_ASSET_TYPE_IMAGE`/);
 assert.deepEqual(Object.keys(S.UploadAdAssetRequest.properties).sort(),['adAssetType','filename','syntheticContentAttestationStatus']);
 assert.match(S.UploadAdAssetRequest.properties.filename.description,/maximum size of 240 bytes/);assert.equal(S.UploadAdAssetResponse.properties.adAsset.$ref,'AdAsset');
 assert.deepEqual(S.UploadAdAssetRequest.properties.syntheticContentAttestationStatus.enum,['SYNTHETIC_CONTENT_ATTESTATION_STATUS_UNSPECIFIED','NOT_SYNTHETIC','IS_SYNTHETIC']);
 // The API reads back only YouTube video assets, so an uploaded image is evidenced by its receipt.
 for(const n of ['get','list'])assert.match(m[n].description,/Only supports the retrieval of assets of AdAssetType `AD_ASSET_TYPE_YOUTUBE_VIDEO`/);
 assert.deepEqual(m.upload.scopes,['https://www.googleapis.com/auth/display-video']);
 const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&r.action==='DV360_ADVERTISERS_AD_ASSETS_UPLOAD');
 assert.equal(rows.length,1);assert.equal(rows[0].status,'media_workflow');assert.equal(rows[0].implementation,'src/media-upload.ts');
});
