import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const owner='urn:li:organization:500',fileId='abcdefghijklmno',link='https://drive.google.com/file/d/'+fileId+'/view',size=5*1024*1024,partSize=4*1024*1024;
function fixture({withdraw='none',at='part',lost=false,expired=false}={}){
 const store=new Store(':memory:',Buffer.alloc(32,57).toString('base64')),actor={tenantId:'t',userId:'u',role:'admin'};
 const connection={id:'login',tenantId:'t',gateway:'linkedin_native_action',accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic',scopes:[],resourceBindings:[{accountId:'123',pathPrefix:'/rest/organizations/500'}]};
 const drive={id:'drive',tenantId:'t',gateway:'google_drive_native_action',accounts:[fileId],enabled:true,label:'Synthetic Drive',scopes:['https://www.googleapis.com/auth/drive.readonly']};
 const credentials={accessToken:'synthetic'},bytes=Buffer.alloc(size);bytes.write('ftypisom',4);
 store.putConnection(actor,connection,credentials);store.putConnection(actor,drive,{accessToken:'synthetic-drive'});
 let initializations=0,parts=0,finalizations=0;
 function change(){
  if(withdraw==='organization')store.putConnection(actor,{...connection,resourceBindings:[]},credentials);
  if(withdraw==='drive')store.putConnection(actor,{...drive,enabled:false},{accessToken:'synthetic-drive'});
  if(withdraw==='login')store.putConnection(actor,connection,{accessToken:'replacement'});
  if(withdraw==='account')store.putConnection(actor,{...connection,writeAccounts:[]},credentials);
 }
 const transport=new NativeTransport(async(raw,init)=>{
  const url=new URL(String(raw));
  if(url.pathname==='/rest/adAccounts/123')return Response.json({id:123,name:'Synthetic account'});
  if(url.hostname==='www.linkedin.com'){
   parts++;assert.equal(new Headers(init.headers).has('authorization'),false);
   assert.deepEqual(Buffer.from(init.body),bytes.subarray((parts-1)*partSize,Math.min(parts*partSize,size)));
   if(at==='part'&&parts===1||at==='lastpart'&&parts===2)change();
   if(lost&&parts===1)throw Error('Synthetic lost part receipt');
   return new Response(null,{status:201,headers:{etag:'"private-part-'+parts+'"'}});
  }
  if(url.searchParams.get('action')==='initializeUpload'){
   initializations++;if(at==='initialize')change();
   return Response.json({value:{video:'urn:li:video:456',uploadToken:'private-upload-token',uploadUrlsExpireAt:Date.now()+(expired?-1000:60000),uploadInstructions:[
    {firstByte:0,lastByte:partSize-1,uploadUrl:'https://www.linkedin.com/dms-uploads/456/1?signature=private-one'},
    {firstByte:partSize,lastByte:size-1,uploadUrl:'https://www.linkedin.com/dms-uploads/456/2?signature=private-two'}
   ]}});
  }
  if(url.searchParams.get('action')==='finalizeUpload'){
   finalizations++;assert.deepEqual(JSON.parse(init.body).finalizeUploadRequest,{video:'urn:li:video:456',uploadToken:'private-upload-token',uploadedPartIds:['private-part-1','private-part-2']});
   if(at==='finalize')change();return new Response(null,{status:200});
  }
  if(url.pathname.startsWith('/rest/videos/'))return Response.json({id:'urn:li:video:456',owner,status:'AVAILABLE'});
  assert.fail('Unexpected synthetic route '+url.pathname);
 });
 const service=new MirrorService(new Registry(),store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0},async raw=>new URL(String(raw)).searchParams.get('alt')==='media'?new Response(bytes):Response.json({id:fileId,size:String(size),mimeType:'video/mp4',capabilities:{canDownload:true}}));
 const call=args=>service.call('amcp_media',args,actor);
 return {store,actor,call,counts:()=>({initializations,parts,finalizations}),prepare:()=>call({action:'prepare',platform:'linkedin',account_id:'123',connection_id:'login',drive_connection_id:'drive',drive_url:link,owner_urn:owner})};
}
for(const withdraw of ['organization','drive','login','account'])for(const at of ['initialize','part'])test('LinkedIn stops transfer after '+withdraw+' withdrawal during '+at,async()=>{
 const f=fixture({withdraw,at});try{
  const p=await f.prepare();assert.equal(p.success,true,JSON.stringify(p));const args={action:'execute',review_id:p.data.review_id,idempotency_key:p.data.review_id,confirmed:true};
  const result=await f.call(args);assert.equal(result.success,false);assert.equal(f.counts().parts,at==='initialize'?0:1);assert.equal(f.counts().finalizations,0);
  assert.equal(f.store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get('t',p.data.review_id).state,'uncertain');
  const retained=f.store.uploadSession('t',p.data.review_id);assert.equal(retained.media_id,'urn:li:video:456');assert.deepEqual(retained.uploaded_part_ids,at==='initialize'?[]:['private-part-1']);
  assert.equal(JSON.stringify(result).includes('private-'),false);
  const before=f.counts();await f.call(args);assert.deepEqual(f.counts(),before);
 }finally{f.store.close();}
});
for(const withdraw of ['organization','drive','login','account'])test('LinkedIn retains both accepted parts when '+withdraw+' changes before finalization',async()=>{
 const f=fixture({withdraw,at:'lastpart'});try{
  const p=await f.prepare(),args={action:'execute',review_id:p.data.review_id,idempotency_key:p.data.review_id,confirmed:true},result=await f.call(args);
  assert.equal(result.success,false);assert.deepEqual(f.counts(),{initializations:1,parts:2,finalizations:0});
  assert.deepEqual(f.store.uploadSession('t',p.data.review_id).uploaded_part_ids,['private-part-1','private-part-2']);
  assert.equal(f.store.uploadSession('t',p.data.review_id).finalization_started,false);
 }finally{f.store.close();}
});
for(const withdraw of ['organization','login','account'])test('LinkedIn keeps the accepted finalization receipt after '+withdraw+' withdrawal',async()=>{
 const f=fixture({withdraw,at:'finalize'});try{
  const p=await f.prepare(),args={action:'execute',review_id:p.data.review_id,idempotency_key:p.data.review_id,confirmed:true};await f.call(args);
  const stored=f.store.db.prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?').get('t',p.data.review_id);
  assert.equal(stored.state,'complete');assert.equal(JSON.parse(stored.result).media_id,'urn:li:video:456');
  await f.call(args);assert.deepEqual(f.counts(),{initializations:1,parts:2,finalizations:1});
 }finally{f.store.close();}
});
test('LinkedIn expired upload instructions preserve allocation and send no bytes',async()=>{
 const f=fixture({expired:true});try{
  const p=await f.prepare(),result=await f.call({action:'execute',review_id:p.data.review_id,idempotency_key:p.data.review_id,confirmed:true});
  assert.equal(result.error.code,'MEDIA_UPLOAD_URL_EXPIRED');assert.deepEqual(f.counts(),{initializations:1,parts:0,finalizations:0});
  assert.equal(f.store.uploadSession('t',p.data.review_id).media_id,'urn:li:video:456');
 }finally{f.store.close();}
});
test('LinkedIn stores ordered part receipts encrypted and finalizes once',async()=>{
 const f=fixture();try{
  const p=await f.prepare(),args={action:'execute',review_id:p.data.review_id,idempotency_key:p.data.review_id,confirmed:true},result=await f.call(args);assert.equal(result.success,true,JSON.stringify(result));
  const session=f.store.uploadSession('t',p.data.review_id);assert.deepEqual(session.uploaded_part_ids,['private-part-1','private-part-2']);assert.equal(session.finalization_started,true);
  const raw=f.store.db.prepare("SELECT data FROM documents WHERE tenant_id=? AND kind='upload_session' AND id=?").get('t',p.data.review_id).data;assert.equal(raw.includes('private-'),false);
  const recovery=await f.call({action:'recovery',review_id:p.data.review_id});assert.equal(JSON.stringify(recovery).includes('private-'),false);assert.equal(recovery.data.progress.bytes_confirmed,size);
  assert.equal((await f.call(args)).data.replayed,true);assert.deepEqual(f.counts(),{initializations:1,parts:2,finalizations:1});
 }finally{f.store.close();}
});
test('LinkedIn lost part receipt retains allocation and never retries the binary PUT',async()=>{
 const f=fixture({lost:true});try{
  const p=await f.prepare(),args={action:'execute',review_id:p.data.review_id,idempotency_key:p.data.review_id,confirmed:true},result=await f.call(args);assert.equal(result.success,false);assert.equal(result.error.code,'WRITE_OUTCOME_UNCERTAIN');
  assert.deepEqual(f.store.uploadSession('t',p.data.review_id).uploaded_part_ids,[]);await f.call(args);assert.deepEqual(f.counts(),{initializations:1,parts:1,finalizations:0});
 }finally{f.store.close();}
});
