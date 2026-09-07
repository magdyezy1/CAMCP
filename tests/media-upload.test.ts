import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {downloadDriveMedia,driveDownloadUrl,MAX_MEDIA_BYTES} from '../src/drive-media.js';
import {sha256} from '../src/security.js';
import type {Actor,JsonObject} from '../src/types.js';
const key=Buffer.alloc(32,19).toString('base64'),actor:Actor={tenantId:'t',userId:'u',role:'operator'},admin:Actor={...actor,role:'admin'},registry=new Registry();
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const mp4=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(24)]),link='https://drive.google.com/file/d/abcdefghijklmno/view?usp=sharing';
function fixture(platform:string,kind='image',options:{pending?:boolean;failUpload?:boolean;badUrl?:boolean;finalizeObject?:boolean}={}){
 const store=new Store(':memory:',key),gateway=platform+'_native_action',c={id:'c',tenantId:'t',gateway,accounts:['123'],writeAccounts:['123'],label:'Synthetic',enabled:true,scopes:[]};
 store.putConnection(admin,c,{accessToken:'synthetic',developerToken:'synthetic',consumerKey:'synthetic',consumerSecret:'synthetic',tokenSecret:'synthetic'});
 const file=kind==='image'?png:mp4,calls:{path:string;method:string;body:any;headers:Headers}[]=[];let downloads=0,stateChanged=false;
 const transport=new NativeTransport((async(input,init)=>{
  const url=new URL(String(input)),path=url.pathname.replace('/open_api',''),method=init?.method??'GET',headers=new Headers(init?.headers),body=init?.body;
  calls.push({path,method,body,headers});
  if(url.hostname==='www.linkedin.com'){assert.equal(headers.get('authorization'),kind==='image'?'Bearer synthetic':null);assert.equal(headers.get('content-type'),kind==='image'?'image/png':'application/octet-stream');assert.equal(method,'PUT');assert.deepEqual(Buffer.from(body as Uint8Array),file);return new Response(null,{status:201,headers:{etag:'"part-1"'}});}
  if(method==='GET'||path.endsWith('/googleAds:search')){
   const extra={name:stateChanged?'Changed':'Account'};
   if(platform==='meta')return Response.json({id:'act_123',account_status:1,currency:'USD',...extra});
   if(platform==='snapchat')return Response.json({request_status:'SUCCESS',adaccounts:[{sub_request_status:'SUCCESS',adaccount:{id:'123',...extra}}]});
   if(platform==='tiktok')return Response.json({code:0,data:{list:[{advertiser_id:'123',...extra}]}});
   if(platform==='google_ads')return Response.json({results:[{customer:{id:'123',...extra}}]});
   if(platform==='linkedin')return Response.json({id:123,...extra});
   if(path==='/1.1/media/upload.json')return Response.json({media_id_string:'456',media_key:'13_456',processing_info:{state:'succeeded'}});
   return Response.json({data:{id:'123',...extra}});
  }
  if(options.failUpload&&path.endsWith('/upload'))throw Error('Lost upload response');
  if(body instanceof FormData){
   assert.equal(headers.has('content-type'),false);const field=platform==='meta'?'source':platform==='snapchat'?'file':platform==='tiktok'?kind+'_file':'media',blob=body.get(field) as Blob;
   assert.ok(blob instanceof Blob);assert.deepEqual(Buffer.from(await blob.arrayBuffer()),file);
   if(platform==='tiktok'){assert.equal(body.get('upload_type'),'UPLOAD_BY_FILE');assert.equal(body.get('advertiser_id'),'123');assert.match(String(body.get(kind+'_signature')),/^[a-f0-9]{32}$/);assert.equal(headers.get('Access-Token'),'synthetic');}
   if(platform==='x_ads')assert.match(headers.get('authorization')!,/^OAuth /);
  }
  if(platform==='meta')return kind==='image'?Response.json({images:{image:{hash:'hash456'}}}):Response.json({id:'456'});
  if(platform==='google_ads'){const data=JSON.parse(String(body));assert.equal(data.operations[0].create.imageAsset.data,png.toString('base64'));return Response.json({results:[{resourceName:'customers/123/assets/456'}]});}
  if(platform==='tiktok')return Response.json({code:0,data:kind==='image'?{image_id:'ad-site/456'}:[{video_id:'456'}]});
  if(platform==='snapchat'){
   if(path.endsWith('/media'))return Response.json({request_status:'SUCCESS',media:[{sub_request_status:'SUCCESS',media:{id:'456',ad_account_id:'123'}}]});
   return Response.json({request_status:'SUCCESS',result:{id:'456',ad_account_id:'123',media_status:'READY'}});
  }
  if(platform==='linkedin'){
   if(url.searchParams.get('action')==='finalizeUpload'){assert.deepEqual(JSON.parse(String(body)).finalizeUploadRequest.uploadedPartIds,['part-1']);return options.finalizeObject?Response.json({}):new Response(null,{status:200});}
   const request=JSON.parse(String(body));assert.equal(request.initializeUploadRequest.owner,'urn:li:sponsoredAccount:123');
   return Response.json({value:{[kind]:'urn:li:'+kind+':456',uploadToken:'',uploadUrl:options.badUrl?'https://attacker.invalid/upload':'https://www.linkedin.com/dms-uploads/456/image',uploadInstructions:[{uploadUrl:'https://www.linkedin.com/dms-uploads/456/video',firstByte:0,lastByte:4*1024*1024-1}]}});
  }
  if(path.endsWith('/media_library'))return Response.json({data:{media_key:kind==='image'?'3_456':'13_456'}});
  const command=body instanceof FormData?body.get('command'):new URLSearchParams(String(body)).get('command');
  if(command==='APPEND')return new Response(null,{status:204});
  return Response.json({media_id_string:'456',media_key:kind==='image'?'3_456':'13_456',...(command==='FINALIZE'&&options.pending?{processing_info:{state:'pending'}}:{})});
 }) as typeof fetch);
 const source:typeof fetch=async(input,init)=>{downloads++;assert.equal(new URL(String(input)).hostname,'drive.usercontent.google.com');assert.equal(init?.redirect,'manual');assert.equal(new Headers(init?.headers).has('authorization'),false);return new Response(new Uint8Array(file),{headers:{'Content-Type':'application/octet-stream'}});};
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0},source);
 const call=(input:JsonObject,a=actor)=>service.call('amcp_media',input,a);
 const prepare=()=>call({action:'prepare',platform,account_id:'123',drive_url:link,name:'Reviewed media'});
 return {store,c,calls,prepare,call,file,downloads:()=>downloads,change:()=>{stateChanged=true;},close:()=>store.close()};
}
for(const platform of ['meta','snapchat','tiktok','google_ads','linkedin','x_ads'])for(const kind of platform==='google_ads'?['image']:['image','video'])test(platform+' '+kind+' Drive prepare freezes bytes and reviewed execute performs the native upload once',async()=>{
 const f=fixture(platform,kind);try{
  const prepared=await f.prepare();assert.equal(prepared.success,true,JSON.stringify(prepared));const r=prepared.data;
  assert.equal(r.request.sha256,sha256(f.file));assert.equal(f.calls.length,1);assert.equal(f.downloads(),1);
  const staged=f.store.db.prepare('SELECT secret FROM media_staging').get() as {secret:string};assert.ok(staged.secret);assert.equal(staged.secret.includes(f.file.toString('base64')),false);
  const input={action:'execute',review_id:r.review_id,idempotency_key:r.idempotency_key,confirmed:true},out=await f.call(input);assert.equal(out.success,true,JSON.stringify(out));assert.ok(out.data.media_id);const count=f.calls.length;
  assert.equal((await f.call(input)).data.replayed,true);assert.equal(f.calls.length,count);assert.equal(f.downloads(),1);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM media_staging').get()!.n,0);
  if(platform==='snapchat')assert.equal(f.store.ownsResource(f.c,'123','media/456'),true);
 }finally{f.close();}
});

test('X asynchronous processing requires a fresh reviewed library attachment without reuploading bytes',async()=>{
 const f=fixture('x_ads','video',{pending:true});try{
  const first=(await f.prepare()).data;const out=await f.call({action:'execute',review_id:first.review_id,idempotency_key:first.review_id,confirmed:true});assert.equal(out.success,true,JSON.stringify(out));assert.equal(out.data.ready,false);assert.equal(f.calls.some(c=>c.path.endsWith('/media_library')),false);
  const ready=await f.call({action:'prepare_library',review_id:first.review_id});assert.equal(ready.success,true,JSON.stringify(ready));const r=ready.data;
  assert.notEqual(r.review_id,first.review_id);assert.equal((await f.call({action:'prepare_library',review_id:first.review_id})).data.review_id,r.review_id);
  const result=await f.call({action:'execute',review_id:r.review_id,idempotency_key:r.review_id,confirmed:true});assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.data.library_id,'13_456');assert.equal(f.downloads(),1);
  assert.equal((await f.call({action:'prepare_library',review_id:first.review_id})).data.already_in_library,true);
 }finally{f.close();}
});

test('LinkedIn also accepts the documented empty JSON video-finalize success envelope',async()=>{
 const f=fixture('linkedin','video',{finalizeObject:true});try{const prepared=await f.prepare();assert.equal(prepared.success,true);const r=prepared.data;
  const result=await f.call({action:'execute',review_id:r.review_id,idempotency_key:r.review_id,confirmed:true});assert.equal(result.success,true,JSON.stringify(result));
 }finally{f.close();}
});

test('media reviews enforce confirmation, actor, configuration, revocation, expiry, tamper and cancellation',async()=>{
 for(const reason of ['confirm','actor','state','revoke','expire','tamper','cancel']){
  const f=fixture('snapchat');try{
   const r=(await f.prepare()).data,input={action:'execute',review_id:r.review_id,idempotency_key:r.review_id,confirmed:reason!=='confirm'};
   if(reason==='state')f.change();
   if(reason==='revoke')f.store.putConnection(admin,{...f.c,writeAccounts:[]},{accessToken:'synthetic'});
   if(reason==='expire'){const review=f.store.document('t','media_review',r.review_id);f.store.putDocument('t','media_review',r.review_id,{...review,expires_at:0});}
   if(reason==='tamper')f.store.stageMedia('t',r.review_id,Buffer.concat([png,Buffer.from('different')]));
   if(reason==='cancel')assert.equal((await f.call({action:'cancel',review_id:r.review_id})).data.cancelled,true);
   const result=await f.call(input,reason==='actor'?{...actor,userId:'other'}:actor);assert.equal(result.success,false,reason);assert.equal(f.calls.filter(c=>c.method!=='GET').length,0,reason);
   if(reason==='state'){assert.equal(result.error.code,'STATE_CHANGED');assert.deepEqual(result.error.details.changed_fields,['$["adaccounts"][0]["adaccount"]["name"]']);}
  }finally{f.close();}
 }
 const f=fixture('meta');try{assert.equal((await f.call({action:'prepare',platform:'meta',account_id:'123',drive_url:link},{...actor,role:'reader'})).error.code,'FORBIDDEN');assert.equal(f.downloads(),0);}finally{f.close();}
});

test('lost uploads retain allocated IDs and block retries; signed URLs cannot redirect binaries to unapproved hosts',async()=>{
 const f=fixture('snapchat','image',{failUpload:true});try{const r=(await f.prepare()).data,input={action:'execute',review_id:r.review_id,idempotency_key:r.review_id,confirmed:true},out=await f.call(input);assert.equal(out.error.details.media_id,'456');assert.equal(out.error.details.retry_safe,false);const n=f.calls.length;assert.equal((await f.call(input)).error.code,'WRITE_OUTCOME_UNCERTAIN');assert.equal(f.calls.length,n);}finally{f.close();}
 const li=fixture('linkedin','image',{badUrl:true});try{const r=(await li.prepare()).data,out=await li.call({action:'execute',review_id:r.review_id,idempotency_key:r.review_id,confirmed:true});assert.equal(out.error.code,'UNAPPROVED_UPLOAD_URL');assert.equal(li.calls.some(c=>c.method==='PUT'),false);}finally{li.close();}
});

test('Drive URL parser and download guard reject arbitrary hosts, folders, redirects, HTML and oversized streams',async()=>{
 for(const url of ['http://drive.google.com/file/d/abcdefghijklmno/view','https://drive.google.com.attacker.invalid/file/d/abcdefghijklmno/view','https://user:pass@drive.google.com/file/d/abcdefghijklmno/view','https://drive.google.com/drive/folders/abcdefghijklmno','https://127.0.0.1/file'])assert.throws(()=>driveDownloadUrl(url));
 assert.equal(driveDownloadUrl('https://drive.google.com/open?id=abcdefghijklmno&resourcekey=resource-key-123').searchParams.get('resourcekey'),'resource-key-123');
 for(const response of [new Response('<html>Login</html>',{headers:{'Content-Type':'text/html'}}),new Response(null,{status:302,headers:{Location:'http://169.254.169.254/latest/meta-data/'}}),new Response('x',{headers:{'Content-Length':String(MAX_MEDIA_BYTES+1)}}),new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(MAX_MEDIA_BYTES));controller.enqueue(new Uint8Array(1));controller.close();}}))]){
  let requests=0;await assert.rejects(()=>downloadDriveMedia(link,async()=>{requests++;return response;}));assert.equal(requests,1);
 }
 const f=fixture('google_ads','video');try{assert.equal((await f.prepare()).error.code,'MEDIA_TYPE_UNSUPPORTED');assert.equal(f.calls.length,0);}finally{f.close();}
});

test('encrypted staging limits concurrent preparations and scopes blobs by tenant',async()=>{
 const f=fixture('meta');try{
  const one=await f.prepare(),two=await f.prepare();assert.equal(two.success,true);assert.equal((await f.prepare()).error.code,'MEDIA_STAGING_FULL');assert.equal(f.downloads(),2);
  assert.throws(()=>f.store.stagedMedia('other',one.data.review_id));await f.call({action:'cancel',review_id:one.data.review_id});assert.equal((await f.prepare()).success,true);
 }finally{f.close();}
});
