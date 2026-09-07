import {createHash,randomUUID} from 'node:crypto';
import {MirrorError} from './errors.js';
import {Registry} from './catalog.js';
import {Store} from './store.js';
import {CredentialProvider} from './auth.js';
import {NativeTransport,type BinaryUpload,type TransportResult} from './transport.js';
import {ScopeGuard,normalizeAccount} from './scope.js';
import {validateState,writeOutcome} from './write-review.js';
import {normalizeReviewState,reviewStateHash,changedStateFields} from './review-state.js';
import {downloadDriveMedia,mediaType} from './drive-media.js';
import {guardInput,sha256,stable} from './security.js';
import type {ExecutionPolicy} from './preflight.js';
import type {Actor,CompiledRequest,Connection,JsonObject} from './types.js';

const platforms=['meta','tiktok','snapchat','google_ads','linkedin','x_ads'];
export const mediaTool={name:'amcp_media',description:'Import a publicly downloadable Google Drive file into a selected advertising account. prepare downloads and encrypts the exact file for a five-minute review; execute uploads those frozen bytes after explicit confirmation. Supports PNG/JPEG and MP4/MOV (Google Ads: images only; X/LinkedIn video: MP4). status reads provider processing state; prepare_library reviews adding an X video to its account library once processing succeeds. Never publishes ads or posts. Uses operator role, account write grants and durable idempotency. Files up to 32 MiB with lower platform image limits. Private Drive files and folders are not supported.',inputSchema:{type:'object',required:['action'],properties:{action:{type:'string',enum:['prepare','prepare_library','execute','status','cancel']},platform:{type:'string',enum:platforms},account_id:{type:'string'},connection_id:{type:'string'},drive_url:{type:'string'},name:{type:'string'},review_id:{type:'string'},idempotency_key:{type:'string'},confirmed:{type:'boolean'}},additionalProperties:false}};
const fail=(code:string,message:string,details:JsonObject={}):never=>{throw new MirrorError(code,message,details);};
const responseId=(value:unknown,pattern=/^[A-Za-z0-9_-]+$/)=>{if(typeof value!=='string'||!pattern.test(value))fail('MEDIA_RESPONSE_INVALID','The provider did not return a valid media identifier.');return value as string;};
interface UploadPlan {platform:string;account_id:string;connection_id:string;name:string;mime:string;kind:'image'|'video';filename:string;size:number;sha256:string;read:CompiledRequest;library_media?:{id:string;key:string;source_review_id:string}}
interface UploadResult {media_id:string;media_key?:string;ready:boolean;processing_status:string;library_id?:string;data?:unknown}

export class MediaUploadService {
 private executionDeadline?:number;
 constructor(private registry:Registry,private store:Store,private transport:NativeTransport,private credentials:CredentialProvider,private policy:ExecutionPolicy,private fetcher:typeof fetch=fetch){}
 private access(actor:Actor,platform:string,account:string,connectionId?:string):Connection{
  this.store.assertActorActive(actor);
  if(!this.policy.allowWrites)fail('LIVE_WRITES_DISABLED','Reviewed media uploads are disabled in this deployment.');
  if(actor.role==='reader')throw new MirrorError('FORBIDDEN','An operator connector is required for media uploads.',{},403);
  const gateway=platform+'_native_action',c=this.store.resolveConnection(actor,gateway,account,connectionId);
  if(!c.writeAccounts?.some(id=>normalizeAccount(gateway,id)===account))throw new MirrorError('WRITE_ACCOUNT_FORBIDDEN','This account has no write grant.',{},403);
  return c;
 }
 private accountRead(platform:string,account:string):CompiledRequest{
  const p:CompiledRequest={gateway:platform+'_native_action',accountId:account,action:'AMCP_MEDIA_ACCOUNT_READ',method:'GET',path:'',query:{},headers:{},readOnly:true,destructive:false,requiresConfirmation:false,evidence:'AMCP media upload account contract',warnings:[]};
  switch(platform){
   case 'meta':p.path='/v25.0/act_'+account;p.query={fields:'id,account_status,currency'};break;
   case 'snapchat':p.path='/v1/adaccounts/'+account;break;
   case 'tiktok':p.path='/v1.3/advertiser/info/';p.query={advertiser_ids:[account]};break;
   case 'google_ads':p.path='/v23/customers/'+account+'/googleAds:search';p.method='POST';p.body={query:'SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1'};break;
   case 'linkedin':p.path='/rest/adAccounts/'+account;p.headers={'LinkedIn-Version':this.registry.catalogs.get(p.gateway)?.api_version??'202605','X-Restli-Protocol-Version':'2.0.0'};break;
   case 'x_ads':p.path='/12/accounts/'+account;break;
   default:fail('MEDIA_PLATFORM_UNSUPPORTED','Select a supported media platform.');
  }return p;
 }
 private async state(actor:Actor,p:UploadPlan):Promise<unknown>{
  const c=this.access(actor,p.platform,p.account_id,p.connection_id);new ScopeGuard(this.registry,this.store).authorize(p.read,c);
  const auth=await this.credentials.get(c);this.access(actor,p.platform,p.account_id,p.connection_id);
  const r=await this.transport.request(p.read,c,auth);validateState(p.read,r);return normalizeReviewState(r.data);
 }
 async call(input:JsonObject,actor:Actor):Promise<JsonObject>{
  guardInput(input);for(const key of Object.keys(input))if(!Object.hasOwn(mediaTool.inputSchema.properties,key))fail('INVALID_ARGUMENT','Unknown media parameter.',{parameter:key});
  if(input.action==='prepare'){
   if(!platforms.includes(input.platform)||typeof input.account_id!=='string'||typeof input.drive_url!=='string')fail('INVALID_ARGUMENT','prepare requires platform, account_id and drive_url.');
   if(input.review_id!==undefined||input.idempotency_key!==undefined||input.confirmed!==undefined)fail('INVALID_ARGUMENT','Preparation cannot execute an upload.');
   const account=normalizeAccount(input.platform+'_native_action',input.account_id);if(!/^[A-Za-z0-9_-]+$/.test(account))fail('INVALID_ARGUMENT','Invalid account ID.');
   const c=this.access(actor,input.platform,account,input.connection_id),reviewId=randomUUID(),expires=Date.now()+300000;
   if(input.name!==undefined&&(typeof input.name!=='string'||!input.name.trim()||input.name.length>80||/[\x00-\x1f\/\\]/.test(input.name)))fail('INVALID_ARGUMENT','Use a media name of 1–80 characters without paths or control characters.');
   this.store.reserveMedia(actor.tenantId,reviewId,expires);
   try{
    const file=await downloadDriveMedia(input.drive_url,this.fetcher);
    if(input.platform==='google_ads'&&file.kind==='video')fail('MEDIA_TYPE_UNSUPPORTED','Google Ads video assets reference YouTube video IDs. Upload the video to YouTube first; this importer supports Google Ads images.');
    if(['x_ads','linkedin'].includes(input.platform)&&file.mime==='video/quicktime')fail('MEDIA_TYPE_UNSUPPORTED','Use MP4 video for X and LinkedIn.');
    const imageLimit=input.platform==='google_ads'?5*1024*1024:input.platform==='meta'?30*1024*1024:input.platform==='linkedin'?20*1024*1024:5*1024*1024;
    if(file.kind==='image'&&file.bytes.length>imageLimit)fail('MEDIA_TOO_LARGE','Image exceeds the platform import limit.',{maximum_bytes:imageLimit});
    const name=input.name?.trim()??'AMCP media',p:UploadPlan={platform:input.platform,account_id:account,connection_id:c.id,name,mime:file.mime,kind:file.kind,filename:name+'.'+file.extension,size:file.bytes.length,sha256:sha256(file.bytes),read:this.accountRead(input.platform,account)};
    const state=await this.state(actor,p),stateHash=reviewStateHash(state),fingerprint=sha256(stable({tenant:actor.tenantId,user:actor.userId,plan:p}));
    this.access(actor,p.platform,account,c.id);this.store.stageMedia(actor.tenantId,reviewId,file.bytes);
    this.store.putDocument(actor.tenantId,'media_review',reviewId,{user_id:actor.userId,plan:p,state,state_hash:stateHash,fingerprint,expires_at:expires});
    this.store.appendAudit(actor.tenantId,reviewId,{event:'media_prepared',plan:p,fingerprint,state_hash:stateHash});
    return {success:true,executed:false,review_id:reviewId,idempotency_key:reviewId,expires_at:new Date(expires).toISOString(),request:p,before_state:state,state_hash:stateHash,fingerprint,confirmation_required:true,steps:['Upload the reviewed file to '+p.platform,...(p.platform==='x_ads'?['Register it in the selected account media library']:[])]};
   }catch(e){this.store.removeStagedMedia(actor.tenantId,reviewId);throw e;}
  }
  if(!['prepare_library','execute','status','cancel'].includes(input.action)||typeof input.review_id!=='string')fail('INVALID_ARGUMENT','Use prepare, execute, status or cancel with a review_id.');
  if(['platform','account_id','connection_id','drive_url','name'].some(k=>input[k]!==undefined))fail('INVALID_ARGUMENT','This action uses the frozen media review.');
  const review=this.store.document(actor.tenantId,'media_review',input.review_id),p=review.plan as UploadPlan;
  if(review.user_id!==actor.userId)throw new MirrorError('FORBIDDEN','This media review belongs to another actor.',{},403);
  this.access(actor,p.platform,p.account_id,p.connection_id);
  const fingerprint=sha256(stable({tenant:actor.tenantId,user:actor.userId,plan:p}));if(fingerprint!==review.fingerprint)fail('REVIEW_CHANGED','Media review failed its integrity check.');
  const previous=this.store.db.prepare('SELECT state,result,fingerprint FROM idempotency WHERE tenant_id=? AND key=?').get(actor.tenantId,input.review_id) as JsonObject|undefined;
  if(input.action==='prepare_library')return this.prepareLibrary(actor,p,review,input.review_id,previous);
  if(input.action==='cancel'){
   if(previous)fail('UPLOAD_ALREADY_SUBMITTED','An upload already submitted cannot be cancelled locally.');
   this.store.removeStagedMedia(actor.tenantId,input.review_id);this.store.putDocument(actor.tenantId,'media_review',input.review_id,{...review,expires_at:0});return {success:true,cancelled:true};
  }
  if(input.action==='status'){
   const receipt=previous?.result?JSON.parse(previous.result):undefined;
   if(previous?.state!=='complete'||!receipt?.media_id)fail('MEDIA_NOT_UPLOADED','There is no completed upload receipt for this review.');
   return this.status(actor,p,receipt);
  }
  if(input.confirmed!==true||input.idempotency_key!==input.review_id)fail('CONFIRMATION_REQUIRED','Use the returned review_id and idempotency_key with confirmed:true.');
  if(previous){if(previous.fingerprint!==fingerprint)fail('IDEMPOTENCY_CONFLICT','This key is bound to a different request.');if(previous.state==='complete')return {...JSON.parse(previous.result),replayed:true};fail('WRITE_OUTCOME_UNCERTAIN','This upload was already submitted. Inspect its allocated media; never reupload with a new key automatically.');}
  if(review.expires_at<=Date.now())fail('REVIEW_EXPIRED','Prepare and review the media again.');
  const bytes=p.library_media?Buffer.alloc(0):this.store.stagedMedia(actor.tenantId,input.review_id);if(!p.library_media&&(bytes.length!==p.size||sha256(bytes)!==p.sha256||mediaType(bytes).mime!==p.mime))fail('REVIEW_CHANGED','The staged media failed its integrity check.');
  const current=await this.state(actor,p),actual=reviewStateHash(current),expected=reviewStateHash(review.state);
  if(actual!==expected)fail('STATE_CHANGED','Provider configuration changed. Prepare a new media review.',{expected_state_hash:expected,actual_state_hash:actual,changed_fields:changedStateFields(review.state,current)});
  if(review.expires_at<=Date.now())fail('REVIEW_EXPIRED','Media review expired during verification.');
  const claim=this.store.claim(actor.tenantId,input.review_id,fingerprint);if(!claim.fresh)return {...(claim.result as JsonObject),replayed:true};
  let allocated:JsonObject={};
  const record=(data:JsonObject)=>{allocated={...allocated,...data};this.store.appendAudit(actor.tenantId,input.review_id,{event:'media_allocated',...allocated});};
  try{
   this.executionDeadline=review.expires_at;
   const out=await this.upload(actor,p,bytes,record),receipt={success:true,executed:true,...out,review_id:input.review_id,fingerprint,sha256:p.sha256,platform:p.platform,account_id:p.account_id};
   this.store.transaction(()=>{this.store.complete(actor.tenantId,input.review_id,receipt);this.store.removeStagedMedia(actor.tenantId,input.review_id);this.store.appendAudit(actor.tenantId,input.review_id,{event:'media_uploaded',receipt});});return receipt;
  }catch(e){this.store.uncertain(actor.tenantId,input.review_id);this.store.removeStagedMedia(actor.tenantId,input.review_id);const error=e instanceof MirrorError?e:new MirrorError('WRITE_OUTCOME_UNCERTAIN','Upload did not complete. Inspect the allocated media before any retry.',{},502);this.store.appendAudit(actor.tenantId,input.review_id,{event:'media_upload_incomplete',code:error.code,...allocated});throw new MirrorError(error.code,error.message,{...error.details,...allocated,review_id:input.review_id,retry_safe:false},error.status,false);}
 }
 private async send(actor:Actor,p:UploadPlan,path:string,body?:JsonObject,options:{method?:string;query?:JsonObject;origin?:string;upload?:BinaryUpload;readOnly?:boolean}={}):Promise<TransportResult>{
  const c=this.access(actor,p.platform,p.account_id,p.connection_id),auth=await this.credentials.get(c);this.access(actor,p.platform,p.account_id,p.connection_id);
  if(!options.readOnly&&this.executionDeadline!==undefined&&this.executionDeadline<=Date.now())fail('REVIEW_EXPIRED','Media review expired before the next upload step.');
  const plan:CompiledRequest={...p.read,action:'AMCP_REVIEWED_MEDIA',method:options.method??'POST',path,body,query:options.query??{},origin:options.origin,readOnly:options.readOnly??false};
  const response=await this.transport.request(plan,c,auth,options.upload);
  const emptyFinalize=p.platform==='linkedin'&&path==='/rest/videos'&&options.query?.action==='finalizeUpload'&&[200,204].includes(response.status)&&response.data!==null&&typeof response.data==='object'&&!Array.isArray(response.data)&&Object.keys(response.data).length===0;
  if(!emptyFinalize&&response.data!==null&&writeOutcome(response).success!==true)fail('MEDIA_RESPONSE_INVALID','Provider did not confirm this upload step.');return response;
 }
 private async upload(actor:Actor,p:UploadPlan,bytes:Buffer,record:(v:JsonObject)=>void):Promise<UploadResult>{
  const binary=(field:string,part=bytes):BinaryUpload=>({field,bytes:part,filename:p.filename,mime:p.mime});
  const send=async(path:string,body?:JsonObject,options?:Parameters<MediaUploadService['send']>[4])=>this.send(actor,p,path,body,options);
  if(p.library_media)return this.attachLibrary(actor,p,p.library_media.id,p.library_media.key);
  if(p.platform==='meta'){
   const r=await send('/v25.0/act_'+p.account_id+'/'+(p.kind==='image'?'adimages':'advideos'),p.kind==='image'?{bytes:bytes.toString('base64'),name:p.name}:{title:p.name},{...(p.kind==='video'?{upload:binary('source')}:{})}),d=r.data as JsonObject;
   const images=d.images&&Object.values(d.images) as JsonObject[],id=p.kind==='video'?responseId(d.id,/^\d+$/):images?.length===1?responseId(images[0]!.hash):fail('MEDIA_RESPONSE_INVALID','Meta did not return one uploaded image hash.');
   record({media_id:id});return {media_id:id,ready:p.kind==='image',processing_status:p.kind==='image'?'AVAILABLE':'PROCESSING'};
  }
  if(p.platform==='google_ads'){
   const d=(await send('/v23/customers/'+p.account_id+'/assets:mutate',{operations:[{create:{name:p.name,type:'IMAGE',imageAsset:{data:bytes.toString('base64')}}}],partialFailure:false})).data as JsonObject;
   const id=responseId(d.results?.length===1?d.results[0].resourceName:undefined,new RegExp('^customers/'+p.account_id+'/assets/[0-9]+$'));record({media_id:id});return {media_id:id,ready:true,processing_status:'AVAILABLE'};
  }
  if(p.platform==='tiktok'){
   const kind=p.kind,body={advertiser_id:p.account_id,upload_type:'UPLOAD_BY_FILE',file_name:p.filename,[kind+'_signature']:createHash('md5').update(bytes).digest('hex')};
   const d=(await send('/v1.3/file/'+kind+'/ad/upload/',body,{upload:binary(kind+'_file')})).data as JsonObject;
   const data=Array.isArray(d.data)?d.data.length===1?d.data[0]:{}:d.data;
   if(d.code!==0)fail('MEDIA_RESPONSE_INVALID','TikTok upload failed.');const id=responseId(data?.[kind+'_id'],/^[A-Za-z0-9_\/-]{1,512}$/);record({media_id:id});return {media_id:id,ready:true,processing_status:'UPLOADED'};
  }
  if(p.platform==='snapchat'){
   const path='/v1/adaccounts/'+p.account_id+'/media',body={media:[{name:p.name,type:p.kind.toUpperCase(),ad_account_id:p.account_id}]};
   const created=(await send(path,body)).data as JsonObject,row=created.media?.length===1?created.media[0]:undefined;
   if(String(created.request_status).toUpperCase()!=='SUCCESS'||String(row?.sub_request_status).toUpperCase()!=='SUCCESS'||row.media.ad_account_id!==p.account_id)fail('MEDIA_RESPONSE_INVALID','Snapchat did not confirm the account-bound media allocation.');
   const id=responseId(row.media.id);record({media_id:id});
   const c=this.access(actor,p.platform,p.account_id,p.connection_id);this.store.rememberResource(c,p.account_id,'media/'+id);
   const d=(await send('/v1/media/'+id+'/upload',{}, {upload:binary('file')})).data as JsonObject;
   if(String(d.request_status).toUpperCase()!=='SUCCESS'||d.result?.id!==id||d.result?.ad_account_id!==p.account_id)fail('MEDIA_RESPONSE_INVALID','Snapchat did not confirm this media upload.');
   return {media_id:id,ready:d.result.media_status==='READY',processing_status:d.result.media_status??'PROCESSING'};
  }
  if(p.platform==='linkedin'){
   const kind=p.kind==='image'?'images':'videos',request={owner:'urn:li:sponsoredAccount:'+p.account_id,mediaLibraryMetadata:{associatedAccount:'urn:li:sponsoredAccount:'+p.account_id,assetName:p.name},...(p.kind==='video'?{fileSizeBytes:p.size,uploadCaptions:false,uploadThumbnail:false}:{})};
   const d=(await send('/rest/'+kind,{initializeUploadRequest:request},{query:{action:'initializeUpload'}})).data as JsonObject,v=d.value,id=responseId(v?.[p.kind],new RegExp('^urn:li:'+p.kind+':[A-Za-z0-9_-]+$'));record({media_id:id});
   const instructions=p.kind==='image'?[{uploadUrl:v.uploadUrl,firstByte:0,lastByte:bytes.length-1}]:v.uploadInstructions;
   if(!Array.isArray(instructions)||!instructions.length||instructions.length>32)fail('MEDIA_RESPONSE_INVALID','LinkedIn returned invalid upload instructions.');
   let offset=0;for(const part of instructions){if(part.firstByte!==offset||!Number.isSafeInteger(part.lastByte)||part.lastByte<offset||part.firstByte>=bytes.length)fail('MEDIA_RESPONSE_INVALID','LinkedIn upload byte ranges do not cover the reviewed file.');offset=Math.min(part.lastByte+1,bytes.length);}
   if(offset!==bytes.length)fail('MEDIA_RESPONSE_INVALID','LinkedIn upload ranges omit file bytes.');
   const ids:string[]=[];for(const part of instructions){const c=this.access(actor,p.platform,p.account_id,p.connection_id),token=p.kind==='image'?(await this.credentials.get(c)).accessToken:undefined;this.access(actor,p.platform,p.account_id,p.connection_id);if(this.executionDeadline!==undefined&&this.executionDeadline<=Date.now())fail('REVIEW_EXPIRED','Media review expired before the next upload step.');const etag=await this.transport.uploadLinkedIn(part.uploadUrl,bytes.subarray(part.firstByte,part.lastByte+1),p.mime,token);if(p.kind==='video'){if(!etag)fail('MEDIA_RESPONSE_INVALID','LinkedIn upload did not return its part identifier.');ids.push(etag!);}}
   if(p.kind==='video'){if(typeof v.uploadToken!=='string')fail('MEDIA_RESPONSE_INVALID','LinkedIn did not return its upload token.');await send('/rest/videos',{finalizeUploadRequest:{video:id,uploadToken:v.uploadToken,uploadedPartIds:ids}},{query:{action:'finalizeUpload'}});}
   return {media_id:id,ready:false,processing_status:'PROCESSING'};
  }
  if(p.platform==='x_ads'){
   const origin='https://upload.x.com',path='/1.1/media/upload.json',category=p.kind==='image'?'tweet_image':'amplify_video';
   let d:JsonObject;
   if(p.kind==='image')d=(await send(path,{media_category:category},{origin,upload:binary('media')})).data as JsonObject;
   else {
    d=(await send(path,{command:'INIT',total_bytes:bytes.length,media_type:p.mime,media_category:category},{origin})).data as JsonObject;
    const id=responseId(d.media_id_string,/^\d+$/);record({media_id:id});
    for(let offset=0,index=0;offset<bytes.length;offset+=4*1024*1024,index++)await send(path,{command:'APPEND',media_id:id,segment_index:index},{origin,upload:binary('media',bytes.subarray(offset,offset+4*1024*1024))});
    d=(await send(path,{command:'FINALIZE',media_id:id},{origin})).data as JsonObject;
    if(d.media_id_string!==id)fail('MEDIA_RESPONSE_INVALID','X finalized a different media identifier.');
   }
   const id=responseId(d.media_id_string,/^\d+$/);record({media_id:id});
   // Processing may outlive this MCP request. status reports readiness without
   // issuing a hidden library write or retrying the upload.
   const processing=d.processing_info?.state??'succeeded';if(processing==='failed')fail('MEDIA_PROCESSING_FAILED','X rejected processing of the uploaded media.');
   if(processing!=='succeeded')return {media_id:id,media_key:d.media_key,ready:false,processing_status:processing};
   return this.attachLibrary(actor,p,id,d.media_key??id);
  }
  return fail('MEDIA_PLATFORM_UNSUPPORTED','Unsupported upload platform.');
 }
 private async attachLibrary(actor:Actor,p:UploadPlan,id:string,key:string):Promise<UploadResult>{
  const library=(await this.send(actor,p,'/12/accounts/'+p.account_id+'/media_library',{media_key:key,media_category:p.kind==='image'?'TWEET_IMAGE':'AMPLIFY_VIDEO',name:p.name,file_name:p.filename})).data as JsonObject;
  const libraryId=responseId(library.data?.media_key,/^(?:[0-9]+_)?[0-9]+$/);
  if(libraryId.split('_').at(-1)!==id)fail('MEDIA_RESPONSE_INVALID','X registered a different media identifier.');
  return {media_id:id,media_key:libraryId,library_id:libraryId,ready:true,processing_status:'AVAILABLE'};
 }
 private async prepareLibrary(actor:Actor,p:UploadPlan,source:JsonObject,sourceId:string,previous?:JsonObject):Promise<JsonObject>{
  if(p.platform!=='x_ads'||p.kind!=='video'||p.library_media||previous?.state!=='complete')fail('MEDIA_NOT_UPLOADED','This action requires a completed X video upload.');
  const receipt=JSON.parse(previous!.result);if(receipt.library_id)return {...receipt,executed:false,already_in_library:true};
  const pending=source.library_review_id?this.store.document(actor.tenantId,'media_review',source.library_review_id):undefined;
  const view=(r:JsonObject,id:string)=>({success:true,executed:false,review_id:id,idempotency_key:id,expires_at:new Date(r.expires_at).toISOString(),request:r.plan,before_state:r.state,state_hash:r.state_hash,fingerprint:r.fingerprint,confirmation_required:true});
  if(pending){
   const claimed=this.store.db.prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?').get(actor.tenantId,source.library_review_id) as JsonObject|undefined;
   if(claimed){if(claimed.state==='complete')return {...JSON.parse(claimed.result),executed:false,already_in_library:true};fail('WRITE_OUTCOME_UNCERTAIN','A library attachment was already submitted. Inspect the account library.');}
   if(pending.expires_at>Date.now())return view(pending,source.library_review_id);
  }
  const status=await this.status(actor,p,receipt),data=status.data;
  if(data?.media_id_string!==receipt.media_id||data.processing_info?.state!=='succeeded')fail('MEDIA_NOT_READY','The X video is still processing or failed processing. Check status before preparing the library attachment.');
  const plan:UploadPlan={...p,library_media:{id:receipt.media_id,key:responseId(data.media_key??receipt.media_id,/^(?:[0-9]+_)?[0-9]+$/),source_review_id:sourceId}},state=await this.state(actor,plan),id=randomUUID();
  const review={user_id:actor.userId,plan,state,state_hash:reviewStateHash(state),fingerprint:sha256(stable({tenant:actor.tenantId,user:actor.userId,plan})),expires_at:Date.now()+300000};
  this.store.transaction(()=>{
   // Do not replace a concurrently prepared review after the asynchronous reads.
   const current=this.store.document(actor.tenantId,'media_review',sourceId);
   if(current.library_review_id!==source.library_review_id)fail('LIBRARY_REVIEW_EXISTS','A library review was just prepared. Call prepare_library again to retrieve it.');
   this.store.putDocument(actor.tenantId,'media_review',id,review);
   this.store.putDocument(actor.tenantId,'media_review',sourceId,{...source,library_review_id:id});
   this.store.appendAudit(actor.tenantId,id,{event:'media_library_prepared',source_review_id:sourceId,plan});
  });return view(review,id);
 }
 private async status(actor:Actor,p:UploadPlan,receipt:JsonObject):Promise<JsonObject>{
  let r:TransportResult;
  if(p.platform==='snapchat')r=await this.send(actor,p,'/v1/media/'+receipt.media_id,undefined,{method:'GET',readOnly:true});
  else if(p.platform==='meta'&&p.kind==='video')r=await this.send(actor,p,'/v25.0/'+receipt.media_id,undefined,{method:'GET',readOnly:true,query:{fields:'id,status'}});
  else if(p.platform==='linkedin')r=await this.send(actor,p,'/rest/'+(p.kind==='image'?'images':'videos')+'/'+encodeURIComponent(receipt.media_id),undefined,{method:'GET',readOnly:true});
  else if(p.platform==='x_ads'&&p.kind==='video')r=await this.send(actor,p,'/1.1/media/upload.json',undefined,{method:'GET',readOnly:true,origin:'https://upload.x.com',query:{command:'STATUS',media_id:receipt.media_id}});
  else return {...receipt,executed:false,status_source:'upload_receipt'};
  return {success:true,executed:false,media_id:receipt.media_id,platform:p.platform,data:r.data,status_source:'provider'};
 }
}
