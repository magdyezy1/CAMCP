import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {CredentialProvider} from '../src/auth.js';
import {NativeTransport} from '../src/transport.js';
import {downloadPrivateDrive,driveGateway} from '../src/private-drive.js';
import {createMediaVariant,runMediaProcess,inspectMediaPlacement} from '../src/media-variants.js';
import {PlatformOAuth,platform} from '../server/platform-oauth.js';
import {WebStore} from '../server/web-store.js';
import {AssetDiscovery} from '../server/asset-discovery.js';
import type {Actor,JsonObject} from '../src/types.js';
const key=Buffer.alloc(32,24).toString('base64'),actor:Actor={tenantId:'media-test',userId:'operator',role:'operator'},admin:Actor={...actor,role:'admin'},fileId='abcdefghijklmno',url='https://drive.google.com/file/d/'+fileId+'/view',png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV5sAAAAASUVORK5CYII=','base64');
function setup(){const store=new Store(':memory:',key),c={id:'drive',tenantId:actor.tenantId,gateway:driveGateway,accounts:[fileId],enabled:true,label:'Private Drive',scopes:['https://www.googleapis.com/auth/drive.readonly']};store.putConnection(admin,c,{accessToken:'synthetic-drive'});return {store,c};}
const response=(value:unknown)=>new Response(JSON.stringify(value));
test('private Drive download pins metadata and bytes to the same selected file and never redirects credentials',async()=>{
 const {store}=setup(),calls:JsonObject[]=[];try{const fetcher:typeof fetch=async(u,i)=>{calls.push({url:String(u),headers:i!.headers,redirect:i!.redirect});return new URL(String(u)).searchParams.get('alt')==='media'?new Response(png):response({id:fileId,size:String(png.length),mimeType:'image/png',capabilities:{canDownload:true}});};const file=await downloadPrivateDrive(store,new CredentialProvider(store),actor,'drive',url,fetcher);assert.deepEqual(file.bytes,png);assert.equal(calls.length,2);for(const c of calls){assert.equal(new URL(c.url).origin,'https://www.googleapis.com');assert.equal(c.redirect,'error');assert.equal(c.headers.Authorization,'Bearer synthetic-drive');}}
 finally{store.close();}
});
test('private file access, download restrictions, changed bytes and mid-flight revocation fail closed',async()=>{
 const {store,c}=setup();try{let calls=0;const fetcher:typeof fetch=async()=>{calls++;return response({id:fileId,size:String(png.length),mimeType:'image/png',capabilities:{canDownload:false}});};const credentials=new CredentialProvider(store);
  await assert.rejects(downloadPrivateDrive(store,credentials,actor,'drive',url.replace(fileId,'inaccessible99'),fetcher));assert.equal(calls,0);
  await assert.rejects(downloadPrivateDrive(store,credentials,actor,'drive',url,fetcher),{code:'DRIVE_DOWNLOAD_FORBIDDEN'});assert.equal(calls,1);
  await assert.rejects(downloadPrivateDrive(store,credentials,actor,'drive',url,async u=>new URL(String(u)).searchParams.get('alt')==='media'?new Response(png):response({id:fileId,size:'1',mimeType:'image/png',capabilities:{canDownload:true}})),{code:'MEDIA_CHANGED'});
  await assert.rejects(downloadPrivateDrive(store,credentials,actor,'drive',url,async()=>{store.putConnection(admin,{...c,enabled:false},store.credentials(actor.tenantId,'drive'));return response({id:fileId,size:String(png.length),mimeType:'image/png',capabilities:{canDownload:true}});}));
 }finally{store.close();}
});
test('Drive OAuth uses PKCE and separate read-only scopes, and discovery selects only downloadable media',async()=>{
 const {store,c}=setup();try{const web=new WebStore(store,{origin:'https://amcp.shop',masterKey:key,adminPassword:'synthetic-long-password',tenantId:actor.tenantId}),session=web.signIn('synthetic-long-password','127.0.0.1'),oauth=new PlatformOAuth(web,{AMCP_DRIVE_CLIENT_ID:'synthetic-client',AMCP_DRIVE_CLIENT_SECRET:'synthetic-secret'},async()=>response({access_token:'synthetic-new',refresh_token:'synthetic-refresh',expires_in:3600}),true),start=await oauth.start(session,'drive'),authorize=new URL(start.url);assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');assert.equal(authorize.searchParams.get('scope'),'https://www.googleapis.com/auth/drive.readonly');const pending=web.consumeOAuth(session,'drive',authorize.searchParams.get('state')!);assert.equal(pending.requestedWriteAccess,false);const exchanged=await oauth.exchange('drive',pending,{code:'synthetic-code'});assert.equal(exchanged.credentials.refreshToken,'synthetic-refresh');assert.equal(platform('drive').reviewedWrites,false);
  const discovery=new AssetDiscovery(store,async()=>response({files:[{id:fileId,name:'Allowed',capabilities:{canDownload:true}},{id:'deniedfile123',name:'Denied',capabilities:{canDownload:false}}]}));assert.deepEqual((await discovery.sync(c)).groups[0]!.assets.map(a=>a.id),[fileId]);
 }finally{store.close();}
});
test('private server import shares the review gate, deduplicates receipts and never sends Drive credentials to Meta',async()=>{
 const {store}=setup();try{store.putConnection(admin,{id:'meta',tenantId:actor.tenantId,gateway:'meta_native_action',accounts:['123'],writeAccounts:['123'],enabled:true,label:'Meta',scopes:['ads_management']},{accessToken:'synthetic-meta'});let uploads=0,downloads=0;
  const mediaFetcher:typeof fetch=async u=>{downloads++;return new URL(String(u)).searchParams.get('alt')==='media'?new Response(png):response({id:fileId,size:String(png.length),mimeType:'image/png',capabilities:{canDownload:true}});};
  const transport=new NativeTransport(async(_u,i)=>{assert.ok(!JSON.stringify(i?.headers).includes('synthetic-drive'));if(i?.method==='GET'&&String(_u).includes('/adimages'))return response({data:[{hash:'synthetic_hash'}]});if(i?.method==='GET')return response({id:'act_123',account_status:1,currency:'USD'});uploads++;return response({images:{one:{hash:'synthetic_hash'}}});});
  const s=new MirrorService(new Registry(),store,transport,undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true},mediaFetcher),args={action:'prepare',platform:'meta',account_id:'123',connection_id:'meta',drive_connection_id:'drive',drive_url:url};
  const p=await s.call('amcp_media',args,actor);assert.equal(p.success,true,JSON.stringify(p));assert.equal(uploads,0);assert.equal(downloads,2);assert.ok(!JSON.stringify(store.db.prepare('SELECT secret FROM media_staging').all()).includes(png.toString('base64')));
  const execute=await s.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);assert.equal(execute.success,true,JSON.stringify(execute));assert.equal(uploads,1);
  const reuse=await s.call('amcp_media',{...args,reuse_existing:true},actor);assert.equal(reuse.data.reused,true);assert.equal(reuse.data.executed,false);assert.equal(uploads,1);assert.equal((await s.call('amcp_media',{action:'list'},{...actor,tenantId:'other'})).data.assets.length,0);
 }finally{store.close();}
});
test('variant rejects unsupported presets and reports unavailable conversion tools without spawning a shell',async()=>{
 await assert.rejects(createMediaVariant(png,'arbitrary;command'),{code:'INVALID_VARIANT'});await assert.rejects(runMediaProcess('amcp-intentionally-missing-ffmpeg',[]),{code:'MEDIA_PROCESSOR_UNAVAILABLE'});
});
test('a uniquely selected private Drive connection is automatic, and revocation blocks a pending upload',async()=>{
 const {store,c}=setup();try{store.putConnection(admin,{id:'meta',tenantId:actor.tenantId,gateway:'meta_native_action',accounts:['123'],writeAccounts:['123'],enabled:true,label:'Meta',scopes:['ads_management']},{accessToken:'synthetic-meta'});let uploads=0;
  const transport=new NativeTransport(async(_u,i)=>{if(i?.method!=='GET')uploads++;return response({id:'act_123',account_status:1,currency:'USD'});});
  const s=new MirrorService(new Registry(),store,transport,undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true},async u=>new URL(String(u)).searchParams.get('alt')==='media'?new Response(png):response({id:fileId,size:String(png.length),mimeType:'image/png',capabilities:{canDownload:true}}));
  const prepared=await s.call('amcp_media',{action:'prepare',platform:'meta',account_id:'123',connection_id:'meta',drive_url:url},actor);assert.equal(prepared.success,true,JSON.stringify(prepared));assert.equal(prepared.data.request.source_drive.connection_id,'drive');
  store.putConnection(admin,{...c,enabled:false},store.credentials(actor.tenantId,'drive'));const result=await s.call('amcp_write',{action:'execute',review_id:prepared.data.review_id,idempotency_key:prepared.data.idempotency_key,confirmed:true},actor);assert.equal(result.success,false);assert.equal(uploads,0);
 }finally{store.close();}
});
test('real FFmpeg converts image and video variants with fixed dimensions; malformed media never yields a preview',async t=>{
 const ffmpeg=process.env.AMCP_FFMPEG_PATH??'ffmpeg',ffprobe=process.env.AMCP_FFPROBE_PATH??'ffprobe';
 try{await runMediaProcess(ffmpeg,['-version']);await runMediaProcess(ffprobe,['-version']);}catch(e){if(process.env.AMCP_REQUIRE_FFMPEG==='true')throw e;t.skip('FFmpeg is required in release CI and Docker; this local host has no configured FFmpeg.');return;}
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'amcp-media-test-'));try{
  const input=path.join(dir,'source.png');await runMediaProcess(ffmpeg,['-v','error','-f','lavfi','-i','color=c=blue:s=64x32','-frames:v','1','-threads','1',input]);const square=await createMediaVariant(await fs.readFile(input),'square','contain');assert.equal(square.width,1080);assert.equal(square.height,1080);assert.equal(square.mime,'image/png');assert.equal((await inspectMediaPlacement(square.bytes,'square')).eligible_for_preset,true);assert.equal((await inspectMediaPlacement(square.bytes,'vertical')).eligible_for_preset,false);
  const video=path.join(dir,'source.mp4');await runMediaProcess(ffmpeg,['-v','error','-f','lavfi','-i','color=c=blue:s=64x32:r=5','-t','1','-c:v','libx264','-pix_fmt','yuv420p',video]);const vertical=await createMediaVariant(await fs.readFile(video),'vertical','crop');assert.equal(vertical.height,1920);assert.equal(vertical.mime,'video/mp4');assert.equal(vertical.fit,'crop');const eligible=await inspectMediaPlacement(vertical.bytes,'vertical');assert.equal(eligible.eligible_for_preset,true);assert.equal(eligible.provider_approved,false);
  await assert.rejects(createMediaVariant(Buffer.from([137,80,78,71,13,10,26,10]),'square'),{code:'MEDIA_CONVERSION_FAILED'});
 }finally{if(path.dirname(dir)!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('amcp-media-test-'))throw Error('Unsafe test directory');await fs.rm(dir,{recursive:true,force:true});}
});
