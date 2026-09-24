import {nativeAuthority} from './native-authority.js';
import {createHash,randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {MirrorError} from './errors.js';
import {Registry} from './catalog.js';
import {Store} from './store.js';
import {CredentialProvider} from './auth.js';
import {NativeTransport,type BinaryUpload,type TransportResult} from './transport.js';
import {ScopeGuard,normalizeAccount} from './scope.js';
import {validateState,writeOutcome} from './write-review.js';
import {normalizeSnapshot,reviewStateHash,changedStateFields} from './review-state.js';
import {downloadPrivateDrive,driveAccess} from './private-drive.js';
import {createMediaVariant,variantPresets,inspectMediaPlacement} from './media-variants.js';
import {downloadDriveMedia,mediaType,driveDownloadUrl} from './drive-media.js';
import {guardInput,sha256,stable} from './security.js';
import type {ExecutionPolicy} from './preflight.js';
import type {Actor,CompiledRequest,Connection,JsonObject} from './types.js';
import {mediaPlatforms} from './media-routing.js';
import {assertAccountWrite} from './write-access.js';
import {linkedinVersion} from './linkedin-version.js';
import {assertLinkedInOrganization} from './linkedin-posts.js';

const platforms=mediaPlatforms;
export const mediaTool={name:'amcp_media',description:'Import a public or selected private Google Drive file into a selected advertising account. prepare downloads and encrypts the exact file for a five-minute review; execute uploads those frozen bytes after explicit confirmation. Supports PNG/JPEG and MP4/MOV across Meta, TikTok, Snapchat, Google Ads, LinkedIn, X and DV360 (X/LinkedIn video: MP4). Google videos are uploaded as UNLISTED on the account Google-managed YouTube channel. Normal native media actions and platform_media_upload use this same server transfer; the MCP client never downloads bytes. status reads provider processing state; prepare_library reviews adding an X video to its account library once processing succeeds. Never publishes ads or posts. Uses operator role, account write grants and durable idempotency. Files up to the configured media limit (128 MiB by default) with lower platform image limits. Private files use a separate selected Google Drive connection. variant creates an encrypted, expiring preview with explicit contain/crop presets; prepare accepts variant_id. execute_async queues the frozen confirmed review; job_status shows durable progress. list returns account-scoped receipts. reuse requires a fresh provider availability check. inspect_eligibility checks source dimensions, duration and codec against a placement preset before any provider upload; it does not certify provider policy approval.',inputSchema:{type:'object',required:['action'],properties:{action:{type:'string',enum:['prepare','prepare_library','execute','resume','execute_async','job_status','status','recovery','cancel','variant','inspect_eligibility','list','reuse']},platform:{type:'string',enum:platforms},account_id:{type:'string'},connection_id:{type:'string'},drive_url:{type:'string'},drive_connection_id:{type:'string'},variant_id:{type:'string'},preset:{type:'string',enum:Object.keys(variantPresets)},fit:{type:'string',enum:['contain','crop']},reuse_existing:{type:'boolean'},asset_id:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100},name:{type:'string'},media_type:{type:'string',enum:['image','video']},expected_mime:{type:'string'},expected_size:{type:'integer',minimum:1},existing_media_id:{type:'string'},owner_urn:{type:'string'},review_id:{type:'string'},idempotency_key:{type:'string'},confirmed:{type:'boolean'}},additionalProperties:false}};
const fail=(code:string,message:string,details:JsonObject={}):never=>{throw new MirrorError(code,message,details);};
const responseId=(value:unknown,pattern=/^[A-Za-z0-9_-]+$/)=>{if(typeof value!=='string'||!pattern.test(value))fail('MEDIA_RESPONSE_INVALID','The provider did not return a valid media identifier.');return value as string;};
interface UploadPlan {platform:string;account_id:string;connection_id:string;name:string;mime:string;kind:'image'|'video';filename:string;size:number;sha256:string;read:CompiledRequest;source_drive?:{connection_id:string;url:string};existing_media_id?:string;owner_urn?:string;library_media?:{id:string;key:string;source_review_id:string}}
interface UploadResult {media_id:string;media_key?:string;ready:boolean;processing_status:string;library_id?:string;data?:unknown}

export class MediaUploadService {
 private executionContext=new AsyncLocalStorage<number>();
 constructor(private registry:Registry,private store:Store,private transport:NativeTransport,private credentials:CredentialProvider,private policy:ExecutionPolicy,private fetcher:typeof fetch=fetch){}
 private access(actor:Actor,platform:string,account:string,connectionId?:string):Connection{
  this.store.assertActorActive(actor);
  if(!this.policy.allowWrites)fail('LIVE_WRITES_DISABLED','Reviewed media uploads are disabled in this deployment.');
  if(actor.role==='reader')throw new MirrorError('FORBIDDEN','An operator connector is required for media uploads.',{},403);
  const gateway=platform+'_native_action',c=this.store.resolveConnection(actor,gateway,account,connectionId);
  assertAccountWrite(this.store,c,account);
  return c;
 }
 private accountRead(platform:string,account:string):CompiledRequest{
  const p:CompiledRequest={gateway:platform+'_native_action',accountId:account,action:'AMCP_MEDIA_ACCOUNT_READ',method:'GET',path:'',query:{},headers:{},readOnly:true,destructive:false,requiresConfirmation:false,evidence:'AMCP media upload account contract',warnings:[]};
  switch(platform){
   case 'meta':p.path='/v25.0/act_'+account;p.query={fields:'id,account_status,currency'};break;
   case 'snapchat':p.path='/v1/adaccounts/'+account;break;
   case 'tiktok':p.path='/v1.3/advertiser/info/';p.query={advertiser_ids:[account]};break;
   case 'google_ads':p.path='/v23/customers/'+account+'/googleAds:search';p.method='POST';p.body={query:'SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1'};break;
   case 'linkedin':p.path='/rest/adAccounts/'+account;p.headers={'LinkedIn-Version':linkedinVersion(),'X-Restli-Protocol-Version':'2.0.0'};break;
   case 'x_ads':p.path='/12/accounts/'+account;break;
   case 'dv360':p.path='/v4/advertisers/'+account;break;
   default:fail('MEDIA_PLATFORM_UNSUPPORTED','Select a supported media platform.');
  }return p;
 }
 private async state(actor:Actor,p:UploadPlan):Promise<unknown>{
  if(p.source_drive)driveAccess(this.store,actor,p.source_drive.connection_id,p.source_drive.url);
  const c=this.access(actor,p.platform,p.account_id,p.connection_id);new ScopeGuard(this.registry,this.store).authorize(p.read,c);
  this.ownerScope(p,c);
  const auth=await this.credentials.get(c),current=this.access(actor,p.platform,p.account_id,p.connection_id);new ScopeGuard(this.registry,this.store).authorize(p.read,current);this.ownerScope(p,current);
  const access=nativeAuthority(this.store,this.registry,actor,p.read,current,auth,()=>{const c=this.access(actor,p.platform,p.account_id,p.connection_id);this.ownerScope(p,c);if(p.source_drive)driveAccess(this.store,actor,p.source_drive.connection_id,p.source_drive.url);});const r=await this.transport.request(p.read,access(),auth,undefined,{beforeAttempt:access});access();validateState(p.read,r);return normalizeSnapshot(p.read,r.data);
 }
 private ownerScope(p:UploadPlan,c:Connection){
  if(p.platform==='linkedin'&&p.kind==='video'&&!/^urn:li:(?:organization|person):[A-Za-z0-9_-]+$/.test(p.owner_urn??''))fail('LINKEDIN_VIDEO_OWNER_REQUIRED','Prepare LinkedIn video with an explicit organization/person owner and its exact binding.');
  if(p.owner_urn?.startsWith('urn:li:organization:'))assertLinkedInOrganization(c,p.account_id,p.owner_urn);
  if(p.owner_urn&&p.owner_urn!=='urn:li:sponsoredAccount:'+p.account_id){const [,kind,id]=/^urn:li:([^:]+):(.+)$/.exec(p.owner_urn)!;new ScopeGuard(this.registry,this.store).authorize({...p.read,path:'/rest/'+(kind==='organization'?'organizations':kind==='person'?'people':'adAccounts')+'/'+id},c);}
 }
 private async source(input:JsonObject,actor:Actor,stageId:string){
  const sink=this.store.mediaSink(actor.tenantId,stageId,()=>this.store.assertActorActive(actor));
  if(input.variant_id){if(input.drive_url||input.drive_connection_id)fail('INVALID_ARGUMENT','Choose a source URL or variant, not both.');const v=this.variant(actor,input.variant_id),bytes=this.store.stagedMedia(actor.tenantId,v.id);if(sha256(bytes)!==v.sha256)fail('MEDIA_CHANGED','Variant integrity check failed.');return {bytes,...mediaType(bytes),source_drive:v.drive_connection_id?{connection_id:v.drive_connection_id,url:v.drive_url}:undefined};}
  let selected=input.drive_connection_id;
  if(!selected){const id=driveDownloadUrl(input.drive_url).searchParams.get('id')!,matches=this.store.listConnections(actor.tenantId).filter(c=>c.gateway==='google_drive_native_action'&&c.enabled&&c.accounts.includes(id)),defaults=matches.filter(c=>c.isDefault);
   if(matches.length>1&&defaults.length!==1)fail('DRIVE_CONNECTION_REQUIRED','This file is selected in multiple Drive logins; choose drive_connection_id.');selected=matches.length===1?matches[0]!.id:defaults[0]?.id;
  }
  return selected?{...await downloadPrivateDrive(this.store,this.credentials,actor,selected,input.drive_url,this.fetcher,sink),source_drive:{connection_id:selected,url:input.drive_url}}:{...await downloadDriveMedia(input.drive_url,this.fetcher,sink),source_drive:undefined};
 }
 variant(actor:Actor,id:string){
  this.store.assertActorActive(actor);const v=this.store.document(actor.tenantId,'media_variant',id);if(v.user_id!==actor.userId&&actor.role!=='admin')fail('FORBIDDEN','The media preview belongs to another actor.');
  if(v.expires_at<=Date.now())fail('REVIEW_EXPIRED','The preview expired. Create another variant.');if(v.drive_connection_id)driveAccess(this.store,actor,v.drive_connection_id,v.drive_url);return v;
 }
 private assets(actor:Actor,input:JsonObject){return this.store.documents(actor.tenantId,'workspace_asset').filter(a=>{if(!a.platform||!a.connection_id||!a.account_id)return false;try{this.store.resolveConnection(actor,a.platform+'_native_action',a.account_id,a.connection_id);return (!input.platform||a.platform===input.platform)&&(!input.connection_id||a.connection_id===input.connection_id)&&(!input.account_id||a.account_id===normalizeAccount(a.platform+'_native_action',input.account_id));}catch{return false;}});}
 private recoveryRecord(actor:Actor,review:JsonObject){
  const p=review.plan as UploadPlan,claim=this.store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get(actor.tenantId,review.id) as JsonObject|undefined,session=this.store.uploadSession(actor.tenantId,review.id),progress=Object.fromEntries(['media_id','resource_name','bytes_confirmed','total_bytes','finalization_started','updated_at'].filter(k=>review.progress?.[k]!==undefined).map(k=>[k,review.progress[k]]));
  return {review_id:review.id,idempotency_key:review.id,fingerprint:review.fingerprint,state_hash:review.state_hash,request:Object.fromEntries(['platform','account_id','connection_id','name','mime','kind','filename','size','sha256','existing_media_id','owner_urn','library_media'].filter(k=>p[k as keyof UploadPlan]!==undefined).map(k=>[k,p[k as keyof UploadPlan]])),journal:this.store.operationJournal(actor.tenantId,review.id),progress,state:claim?.state??(review.job_id?'queued':'unsubmitted'),job_id:review.job_id??null,resume_available:!!claim&&claim.state!=='complete'&&p.platform==='google_ads'&&p.kind==='video'&&!!session&&!session.finalization_started&&review.expires_at>Date.now(),can_execute:!claim&&!review.job_id&&review.expires_at>Date.now(),expires_at:review.expires_at};
 }
 private async reuse(actor:Actor,asset:JsonObject){
  const review=this.store.document(actor.tenantId,'media_review',asset.review_id),plan=review.plan as UploadPlan;
  this.access(actor,plan.platform,plan.account_id,plan.connection_id);
  const fresh=await this.status(actor,plan,asset);
  if(fresh.status_source!=='provider')fail('MEDIA_AVAILABILITY_UNVERIFIED','This provider has no qualified availability lookup for this media type. Prepare a reviewed fresh upload instead.',{platform:plan.platform,media_id:asset.media_id});
  if(fresh.ready!==true)fail('MEDIA_NOT_READY','The provider has not confirmed that this media is ready.',{media_id:asset.media_id,processing_status:fresh.processing_status});
  return {...fresh,reused:true,executed:false,availability_source:'provider',availability_checked_at:Date.now()};
 }
 async call(input:JsonObject,actor:Actor):Promise<JsonObject>{
  this.store.assertActorActive(actor);if(!['prepare','variant','inspect_eligibility','execute','resume'].includes(input.action))return this.handle(input,actor);
  const lease=this.store.mediaAdmission(actor.tenantId),lock='media-execution:'+actor.tenantId+':'+input.review_id,lockOwner=randomUUID();const executing=['execute','resume'].includes(input.action);if(executing&&!this.store.acquireLock(lock,lockOwner,300000)){lease.release();throw new MirrorError('MEDIA_UPLOAD_BUSY','This frozen upload is already executing.',{},409,true);}let lost=false;const timer=setInterval(()=>{try{lease.check();}catch{lost=true;}},15000);timer.unref();
  this.store.bindActorCheck(actor,()=>{if(lost)throw new MirrorError('MEDIA_ADMISSION_LOST','This operation lost its byte reservation.');});
  try{const result=await this.handle(input,actor);this.store.assertActorActive(actor);return result;}finally{clearInterval(timer);lease.release();if(executing)this.store.releaseLock(lock,lockOwner);}
 }
 private async handle(input:JsonObject,actor:Actor):Promise<JsonObject>{
  guardInput(input);for(const key of Object.keys(input))if(!Object.hasOwn(mediaTool.inputSchema.properties,key))fail('INVALID_ARGUMENT','Unknown media parameter.',{parameter:key});
  this.store.assertActorActive(actor);
  if(input.action==='list'){
   const offset=input.offset??0,limit=input.limit??50;if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)fail('INVALID_ARGUMENT','Invalid media pagination.');const assets=this.assets(actor,input);
   const reviews=this.store.documents(actor.tenantId,'media_review').filter(r=>r.user_id===actor.userId).filter(r=>{const p=r.plan;try{this.access(actor,p.platform,p.account_id,p.connection_id);return (!input.platform||p.platform===input.platform)&&(!input.connection_id||p.connection_id===input.connection_id)&&(!input.account_id||p.account_id===normalizeAccount(p.platform+'_native_action',input.account_id));}catch{return false;}}).map(r=>this.recoveryRecord(actor,r)).filter(r=>r.state!=='complete'&&(r.expires_at>Date.now()||['pending','uncertain'].includes(r.state))).sort((a,b)=>b.expires_at-a.expires_at);
   return {assets:assets.slice(offset,offset+limit),total:assets.length,has_more:offset+limit<assets.length,recovery_reviews:reviews.slice(offset,offset+limit),recovery_total:reviews.length,recovery_has_more:offset+limit<reviews.length,variants:this.store.documents(actor.tenantId,'media_variant').filter(v=>(v.user_id===actor.userId||actor.role==='admin')&&v.expires_at>Date.now()).filter(v=>{try{this.variant(actor,v.id);return true;}catch{return false;}}).map(({drive_url,...v})=>v),presets:variantPresets};
  }
  if(input.action==='reuse'){const asset=this.assets(actor,input).find(a=>a.id===input.asset_id);if(!asset)fail('MEDIA_NOT_READY','Select an upload receipt in an accessible account.');return this.reuse(actor,asset!);}
  if(input.action==='inspect_eligibility'){if(actor.role==='reader')fail('FORBIDDEN','An operator is required to stage media.');const id=randomUUID();this.store.reserveMedia(actor.tenantId,id,Date.now()+300000);try{const file=await this.source(input,actor,id);return {...await inspectMediaPlacement(file.bytes,input.preset),sha256:sha256(file.bytes),size_bytes:file.bytes.length,executed:false};}finally{this.store.removeStagedMedia(actor.tenantId,id);}}
  if(input.action==='variant'){
   if(actor.role==='reader')fail('FORBIDDEN','An operator is required to stage media.');if(typeof input.drive_url!=='string'||input.variant_id)fail('INVALID_ARGUMENT','Provide the original Drive file URL.');
   const id=randomUUID(),expires=Date.now()+300000;this.store.reserveMedia(actor.tenantId,id,expires);
   try{const file=await this.source(input,actor,id),converted=await createMediaVariant(file.bytes,input.preset,input.fit),{bytes,...metadata}=converted;this.store.assertActorActive(actor);if(input.drive_connection_id)driveAccess(this.store,actor,input.drive_connection_id,input.drive_url);this.store.stageMedia(actor.tenantId,id,bytes);
    const record={...metadata,user_id:actor.userId,drive_url:input.drive_url,drive_connection_id:file.source_drive?.connection_id??null,sha256:sha256(bytes),source_sha256:sha256(file.bytes),size:bytes.length,expires_at:expires,preview_url:'/api/media/variants/'+id+'/preview'};this.store.putDocument(actor.tenantId,'media_variant',id,record);return {...record,id,variant_id:id,executed:false,client_download_required:false};
   }catch(e){this.store.removeStagedMedia(actor.tenantId,id);throw e;}
  }
  if(input.action==='prepare'){
   if(!platforms.includes(input.platform)||typeof input.account_id!=='string'||typeof input.drive_url!=='string'&&typeof input.variant_id!=='string')fail('INVALID_ARGUMENT','prepare requires platform, account_id and drive_url.');
   if(input.review_id!==undefined||input.idempotency_key!==undefined||input.confirmed!==undefined)fail('INVALID_ARGUMENT','Preparation cannot execute an upload.');
   const account=normalizeAccount(input.platform+'_native_action',input.account_id);if(!/^[A-Za-z0-9_-]+$/.test(account))fail('INVALID_ARGUMENT','Invalid account ID.');
   const c=this.access(actor,input.platform,account,input.connection_id),reviewId=randomUUID(),expires=Date.now()+300000;
   if(input.platform==='linkedin'&&typeof input.owner_urn==='string'&&input.owner_urn.startsWith('urn:li:organization:'))assertLinkedInOrganization(c,account,input.owner_urn);
   if(input.platform==='linkedin'&&input.media_type==='video'&&!/^urn:li:(?:organization|person):[A-Za-z0-9_-]+$/.test(input.owner_urn??''))fail('LINKEDIN_VIDEO_OWNER_REQUIRED','LinkedIn video upload requires an explicitly bound organization or person owner; a sponsoredAccount URN is not a video owner.');
   if(input.name!==undefined&&(typeof input.name!=='string'||!input.name.trim()||input.name.length>80||/[\x00-\x1f\/\\]/.test(input.name)))fail('INVALID_ARGUMENT','Use a media name of 1–80 characters without paths or control characters.');
   this.store.reserveMedia(actor.tenantId,reviewId,expires);
   try{
    const file=await this.source(input,actor,reviewId);
    if(input.preset){const eligibility=await inspectMediaPlacement(file.bytes,input.preset);if(!eligibility.eligible_for_preset)fail('MEDIA_PLACEMENT_MISMATCH','The source does not meet the selected placement preset.',eligibility);}
    if(input.media_type!==undefined&&input.media_type!==file.kind||input.expected_mime!==undefined&&input.expected_mime!==file.mime||input.expected_size!==undefined&&input.expected_size!==file.bytes.length)fail('MEDIA_TYPE_MISMATCH','The downloaded file does not match the declared type, MIME type or size.',{actual_type:file.kind,actual_mime:file.mime,actual_size:file.bytes.length});
    if(['x_ads','linkedin'].includes(input.platform)&&file.mime==='video/quicktime')fail('MEDIA_TYPE_UNSUPPORTED','Use MP4 video for X and LinkedIn.');
    if(input.platform==='linkedin'&&file.kind==='video'&&!/^urn:li:(?:organization|person):[A-Za-z0-9_-]+$/.test(input.owner_urn??''))fail('LINKEDIN_VIDEO_OWNER_REQUIRED','Specify the organization/person owner and its administrator resource binding for this LinkedIn video.');
    const imageLimit=input.platform==='google_ads'?5*1024*1024:input.platform==='meta'?30*1024*1024:input.platform==='linkedin'?20*1024*1024:input.platform==='dv360'?10*1024*1024:5*1024*1024;
    if(file.kind==='image'&&file.bytes.length>imageLimit)fail('MEDIA_TOO_LARGE','Image exceeds the platform import limit.',{maximum_bytes:imageLimit});
    const name=input.name?.trim()??'AMCP media',p:UploadPlan={platform:input.platform,account_id:account,connection_id:c.id,name,mime:file.mime,kind:file.kind,filename:name+'.'+file.extension,size:file.bytes.length,sha256:sha256(file.bytes),read:this.accountRead(input.platform,account),...(file.source_drive?{source_drive:file.source_drive}:{})};
    if(input.existing_media_id!==undefined){
     if(p.platform!=='snapchat'||typeof input.existing_media_id!=='string'||!/^[-\w]+$/.test(input.existing_media_id))fail('INVALID_ARGUMENT','existing_media_id identifies an existing Snapchat media allocation.');
     p.existing_media_id=input.existing_media_id;p.read={...p.read,path:'/v1/media/'+p.existing_media_id};new ScopeGuard(this.registry,this.store).authorize(p.read,c);
    }
    if(input.owner_urn!==undefined){
     if(p.platform!=='linkedin'||typeof input.owner_urn!=='string'||!/^urn:li:(?:sponsoredAccount|organization|person):[A-Za-z0-9_-]+$/.test(input.owner_urn))fail('INVALID_ARGUMENT','owner_urn requires a LinkedIn account, organization or person URN.');
     if(input.owner_urn!=='urn:li:sponsoredAccount:'+account){const [,kind,owner]=/^urn:li:([^:]+):(.+)$/.exec(input.owner_urn)!;new ScopeGuard(this.registry,this.store).authorize({...p.read,path:'/rest/'+(kind==='organization'?'organizations':kind==='person'?'people':'adAccounts')+'/'+owner},c);}
     p.owner_urn=input.owner_urn;
    }
    if(p.platform==='dv360'&&Buffer.byteLength(p.filename)>240)fail('INVALID_ARGUMENT','DV360 filenames must fit in 240 UTF-8 bytes.');
    const matches=this.assets(actor,{platform:p.platform,account_id:p.account_id,connection_id:p.connection_id}).filter(a=>a.sha256===p.sha256&&a.ready===true&&(a.owner_urn??null)===(p.owner_urn??(p.platform==='linkedin'?'urn:li:sponsoredAccount:'+p.account_id:null)));
    if(input.reuse_existing===true&&matches.length){const reused=await this.reuse(actor,matches[0]!);this.store.removeStagedMedia(actor.tenantId,reviewId);return reused;}
    const state=await this.state(actor,p),stateHash=reviewStateHash(state),fingerprint=sha256(stable({tenant:actor.tenantId,user:actor.userId,plan:p}));
    this.access(actor,p.platform,account,c.id);this.store.stageMedia(actor.tenantId,reviewId,file.bytes);
    this.store.putDocument(actor.tenantId,'media_review',reviewId,{user_id:actor.userId,plan:p,state,state_hash:stateHash,fingerprint,expires_at:expires});
    this.store.appendAudit(actor.tenantId,reviewId,{event:'media_prepared',plan:p,fingerprint,state_hash:stateHash});
    return {success:true,executed:false,review_id:reviewId,upload_session_id:reviewId,idempotency_key:reviewId,expires_at:new Date(expires).toISOString(),request:p,before_state:state,state_hash:stateHash,fingerprint,matching_assets:matches.map(a=>({asset_id:a.id,media_id:a.media_id,sha256:a.sha256})),confirmation_required:true,steps:['Upload the reviewed file to '+p.platform,...(p.platform==='google_ads'&&p.kind==='video'?['Create an UNLISTED video on the Google-managed YouTube channel for this advertising account']:[]),...(p.platform==='x_ads'?['Register it in the selected account media library']:[])]};
   }catch(e){this.store.removeStagedMedia(actor.tenantId,reviewId);throw e;}
  }
  if(!['prepare_library','execute','resume','execute_async','job_status','status','recovery','cancel'].includes(input.action)||typeof input.review_id!=='string')fail('INVALID_ARGUMENT','Use prepare, execute, status or cancel with a review_id.');
  if(['platform','account_id','connection_id','drive_url','name','media_type','expected_mime','expected_size','existing_media_id','owner_urn','drive_connection_id','variant_id','preset','fit','reuse_existing','asset_id','offset','limit'].some(k=>input[k]!==undefined))fail('INVALID_ARGUMENT','This action uses the frozen media review.');
  const review=this.store.document(actor.tenantId,'media_review',input.review_id),p=review.plan as UploadPlan;
  if(review.user_id!==actor.userId)throw new MirrorError('FORBIDDEN','This media review belongs to another actor.',{},403);
  this.access(actor,p.platform,p.account_id,p.connection_id);
  const fingerprint=sha256(stable({tenant:actor.tenantId,user:actor.userId,plan:p}));if(fingerprint!==review.fingerprint)fail('REVIEW_CHANGED','Media review failed its integrity check.');
  const previous=this.store.db.prepare('SELECT state,result,fingerprint FROM idempotency WHERE tenant_id=? AND key=?').get(actor.tenantId,input.review_id) as JsonObject|undefined;
  if(input.action==='prepare_library')return this.prepareLibrary(actor,p,review,input.review_id,previous);
  if(input.action==='job_status'){if(!review.job_id)fail('NOT_FOUND','No background upload was queued for this review.');const job=this.store.job(actor.tenantId,review.job_id);return {review_id:input.review_id,job_id:job.id,state:job.state,error:job.error,result:job.result,progress:review.progress??{},journal:this.store.operationJournal(actor.tenantId,input.review_id),expires_at:review.expires_at};}
  if(input.action==='cancel'){
   if(previous)fail('UPLOAD_ALREADY_SUBMITTED','An upload already submitted cannot be cancelled locally.');
   if(review.job_id)this.store.db.prepare("UPDATE jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE tenant_id=? AND id=? AND state IN ('queued','running')").run(actor.tenantId,review.job_id);this.store.removeStagedMedia(actor.tenantId,input.review_id);this.store.putDocument(actor.tenantId,'media_review',input.review_id,{...review,expires_at:0});return {success:true,cancelled:true};
  }
  if(input.action==='recovery')return this.recoveryRecord(actor,review);
  if(input.action==='status'){
   const receipt=previous?.result?JSON.parse(previous.result):undefined;
   if(previous?.state!=='complete'||!receipt?.media_id)fail('MEDIA_NOT_UPLOADED','There is no completed upload receipt for this review.');
   return this.status(actor,p,receipt);
  }
  if(input.confirmed!==true||input.idempotency_key!==input.review_id)fail('CONFIRMATION_REQUIRED','Use the returned review_id and idempotency_key with confirmed:true.');
  const resumable=this.store.uploadSession(actor.tenantId,input.review_id),resuming=input.action==='resume';if(resuming&&(!previous||p.platform!=='google_ads'||p.kind!=='video'||!resumable||resumable.finalization_started))fail('RECOVERY_NOT_SAFE','Only a retained Google upload that has never attempted finalization can resume within its original review. Inspect other uncertain outcomes.');
  if(previous){if(previous.fingerprint!==fingerprint)fail('IDEMPOTENCY_CONFLICT','This key is bound to a different request.');if(previous.state==='complete')return {...JSON.parse(previous.result),replayed:true};if(!resuming)fail('WRITE_OUTCOME_UNCERTAIN','This upload was already submitted. Inspect its allocated media; never reupload with a new key automatically.');}
  if(review.expires_at<=Date.now())fail('REVIEW_EXPIRED','Prepare and review the media again.');
  if(input.action==='execute_async'){return this.store.transaction(()=>{const current=this.store.document(actor.tenantId,'media_review',input.review_id);if(current.job_id)return {review_id:input.review_id,job_id:current.job_id,state:this.store.job(actor.tenantId,current.job_id).state};const jobId=this.store.enqueue(actor.tenantId,'media_upload',{review_id:input.review_id});this.store.putDocument(actor.tenantId,'media_review',input.review_id,{...current,job_id:jobId,actor_binding:this.store.bindJobActor(actor,'media-job:'+input.review_id)});return {review_id:input.review_id,job_id:jobId,state:'queued',expires_at:new Date(review.expires_at).toISOString(),next_call:{tool:'amcp_media',arguments:{action:'job_status',review_id:input.review_id}}};});}
  const bytes=p.library_media?Buffer.alloc(0):this.store.stagedMedia(actor.tenantId,input.review_id);if(!p.library_media&&(bytes.length!==p.size||sha256(bytes)!==p.sha256||mediaType(bytes).mime!==p.mime))fail('REVIEW_CHANGED','The staged media failed its integrity check.');
  const expectedState=normalizeSnapshot(p.read,review.state),current=await this.state(actor,p),actual=reviewStateHash(current),expected=reviewStateHash(expectedState);
  if(actual!==expected)fail('STATE_CHANGED','Provider configuration changed. Prepare a new media review.',{expected_state_hash:expected,actual_state_hash:actual,changed_fields:changedStateFields(expectedState,current)});
  if(review.expires_at<=Date.now())fail('REVIEW_EXPIRED','Media review expired during verification.');
  const claim=resuming?{fresh:true}:this.store.claim(actor.tenantId,input.review_id,fingerprint);if(!claim.fresh)return {...(claim.result as JsonObject),replayed:true};
  let allocated:JsonObject={};
  const record=(data:JsonObject)=>{if(data.session){this.store.saveUploadSession(actor.tenantId,input.review_id,data.session,review.expires_at);delete data.session;}if(data.finalization_started){const session=this.store.uploadSession(actor.tenantId,input.review_id);if(session)this.store.saveUploadSession(actor.tenantId,input.review_id,{...session,finalization_started:true},review.expires_at);}allocated={...allocated,...data};const current=this.store.document(actor.tenantId,'media_review',input.review_id);this.store.putDocument(actor.tenantId,'media_review',input.review_id,{...current,progress:{...allocated,updated_at:Date.now()}});this.store.journal(actor.tenantId,input.review_id,data.bytes_confirmed!==undefined?'transferring':'allocated',allocated);this.store.appendAudit(actor.tenantId,input.review_id,{event:'media_allocated',...allocated});};
  let receipt:JsonObject;
  try{
   const out=await this.executionContext.run(review.expires_at,()=>this.upload(actor,p,bytes,record,resuming?resumable:undefined));
   receipt={success:true,executed:true,...out,...this.references(p,out),ready:false,status_source:'upload_receipt',handoff_status:'pending_verification',review_id:input.review_id,fingerprint,sha256:p.sha256,platform:p.platform,account_id:p.account_id,connection_id:p.connection_id,media_type:p.kind,client_download_required:false,next_call:{tool:'amcp_media',arguments:{action:'status',review_id:input.review_id}}};
   this.store.transaction(()=>{this.store.complete(actor.tenantId,input.review_id,receipt);this.store.putDocument(actor.tenantId,'workspace_asset',input.review_id,{...receipt,name:p.name,mime_type:p.mime,size_bytes:p.size,source:'server_drive_import',upload_session_id:input.review_id});this.store.removeStagedMedia(actor.tenantId,input.review_id);this.store.appendAudit(actor.tenantId,input.review_id,{event:'media_uploaded',receipt});});
  }catch(e){this.store.uncertain(actor.tenantId,input.review_id);const retained=this.store.uploadSession(actor.tenantId,input.review_id);if(!retained||retained.finalization_started)this.store.removeStagedMedia(actor.tenantId,input.review_id);const error=e instanceof MirrorError?e:new MirrorError('WRITE_OUTCOME_UNCERTAIN','Upload did not complete. Inspect the allocated media before any retry.',{},502);this.store.appendAudit(actor.tenantId,input.review_id,{event:'media_upload_incomplete',code:error.code,...allocated});throw new MirrorError(error.code,error.message,{...error.details,...allocated,review_id:input.review_id,retry_safe:false},error.status,false);}
  // Commit the mutation receipt before this fallible read. A processing/read failure
  // must never turn a completed upload into an uncertain, repeatable mutation.
  try{const checked=await this.status(actor,p,receipt);return {...checked,executed:true};}
  catch(e){
   this.access(actor,p.platform,p.account_id,p.connection_id);
   const failed=e instanceof MirrorError&&e.code==='MEDIA_PROCESSING_FAILED',out={...receipt,ready:false,handoff_status:failed?'processing_failed':'inconclusive',...(failed?{processing_failed:true,next_call:undefined}:{}),verification_error:{code:e instanceof MirrorError?e.code:'MEDIA_VERIFICATION_FAILED',retry_safe:false},automatic_retry_of_upload:false};
   if(!failed)this.store.putDocument(actor.tenantId,'workspace_asset',input.review_id,{...this.store.document(actor.tenantId,'workspace_asset',input.review_id),...out});
   return out;
  }
 }
 private async send(actor:Actor,p:UploadPlan,path:string,body?:JsonObject,options:{method?:string;query?:JsonObject;origin?:string;upload?:BinaryUpload;readOnly?:boolean;headers?:Record<string,string>}={}):Promise<TransportResult>{
  if(!options.readOnly&&p.source_drive)driveAccess(this.store,actor,p.source_drive.connection_id,p.source_drive.url);
  const c=this.access(actor,p.platform,p.account_id,p.connection_id),auth=await this.credentials.get(c),current=this.access(actor,p.platform,p.account_id,p.connection_id);
  this.ownerScope(p,current);if(p.existing_media_id)new ScopeGuard(this.registry,this.store).authorize(p.read,current);
  if(!options.readOnly&&this.executionContext.getStore()!==undefined&&this.executionContext.getStore()!<=Date.now())fail('REVIEW_EXPIRED','Media review expired before the next upload step.');
  const plan:CompiledRequest={...p.read,action:'AMCP_REVIEWED_MEDIA',method:options.method??'POST',path,body,query:options.query??{},headers:{...p.read.headers,...options.headers},origin:options.origin,readOnly:options.readOnly??false};
  const access=nativeAuthority(this.store,this.registry,actor,p.read,current,auth,()=>{const c=this.access(actor,p.platform,p.account_id,p.connection_id);this.ownerScope(p,c);if(!options.readOnly&&p.source_drive)driveAccess(this.store,actor,p.source_drive.connection_id,p.source_drive.url);if(!options.readOnly&&this.executionContext.getStore()!==undefined&&this.executionContext.getStore()!<=Date.now())fail('REVIEW_EXPIRED','Media review expired before the next upload step.');});const response=await this.transport.request(plan,access(),auth,options.upload,{beforeAttempt:access});if(plan.readOnly)access();
  const emptyFinalize=p.platform==='linkedin'&&path==='/rest/videos'&&options.query?.action==='finalizeUpload'&&[200,204].includes(response.status)&&response.data!==null&&typeof response.data==='object'&&!Array.isArray(response.data)&&Object.keys(response.data).length===0;
  const googleStart=p.platform==='google_ads'&&path.startsWith('/resumable/upload/')&&response.status===200&&response.headers['x-goog-upload-url'];
  if(!options.readOnly&&!emptyFinalize&&!googleStart&&response.data!==null&&writeOutcome(response).success!==true)fail('MEDIA_RESPONSE_INVALID','Provider did not confirm this upload step.');return response;
 }
 private async upload(actor:Actor,p:UploadPlan,bytes:Buffer,record:(v:JsonObject)=>void,session?:JsonObject):Promise<UploadResult>{
  const binary=(field:string,part=bytes):BinaryUpload=>({field,bytes:part,filename:p.filename,mime:p.mime});
  const send=async(path:string,body?:JsonObject,options?:Parameters<MediaUploadService['send']>[4])=>this.send(actor,p,path,body,options);
  if(p.library_media)return this.attachLibrary(actor,p,p.library_media.id,p.library_media.key);
  if(p.platform==='meta'){
   const r=await send('/v25.0/act_'+p.account_id+'/'+(p.kind==='image'?'adimages':'advideos'),p.kind==='image'?{bytes:bytes.toString('base64'),name:p.name}:{title:p.name},{...(p.kind==='video'?{upload:binary('source')}:{})}),d=r.data as JsonObject;
   const images=d.images&&Object.values(d.images) as JsonObject[],id=p.kind==='video'?responseId(d.id,/^\d+$/):images?.length===1?responseId(images[0]!.hash):fail('MEDIA_RESPONSE_INVALID','Meta did not return one uploaded image hash.');
   record({media_id:id});if(p.kind==='video')this.store.rememberResource(this.access(actor,p.platform,p.account_id,p.connection_id),p.account_id,id);return {media_id:id,ready:p.kind==='image',processing_status:p.kind==='image'?'AVAILABLE':'PROCESSING'};
  }
  if(p.platform==='google_ads'){
   if(p.kind==='video'){
    const started=session?{headers:{'x-goog-upload-url':session.url,'x-goog-upload-chunk-granularity':session.granularity}}:await send('/resumable/upload/v23/customers/'+p.account_id+'/youTubeVideoUploads:create',{customerId:p.account_id,youTubeVideoUpload:{videoTitle:p.name,videoDescription:'',videoPrivacy:'UNLISTED'}},{headers:{'X-Goog-Upload-Protocol':'resumable','X-Goog-Upload-Command':'start','X-Goog-Upload-Header-Content-Length':String(bytes.length)}});
    record({upload_session_created:true,session:session??{url:started.headers['x-goog-upload-url'],granularity:started.headers['x-goog-upload-chunk-granularity']??'262144'}});
    const c=this.access(actor,p.platform,p.account_id,p.connection_id),auth=await this.credentials.get(c);this.access(actor,p.platform,p.account_id,p.connection_id);
    const access=nativeAuthority(this.store,this.registry,actor,p.read,c,auth,()=>{this.access(actor,p.platform,p.account_id,p.connection_id);if(p.source_drive)driveAccess(this.store,actor,p.source_drive.connection_id,p.source_drive.url);if(this.executionContext.getStore()!<=Date.now())fail('REVIEW_EXPIRED','The media review expired before the next chunk.');});access();
    const finished=await this.transport.uploadGoogleVideo(started.headers['x-goog-upload-url']??'',bytes,auth.accessToken??'',{resume:!!session,beforeFinalize:()=>record({finalization_started:true}),granularity:started.headers['x-goog-upload-chunk-granularity']?Number(started.headers['x-goog-upload-chunk-granularity']):undefined,beforeChunk:access,progress:n=>record({bytes_confirmed:n,total_bytes:bytes.length})});
    const id=responseId((finished.data as JsonObject)?.resourceName,new RegExp('^customers/'+p.account_id+'/youTubeVideoUploads/[A-Za-z0-9_-]+$'));record({media_id:id});return {media_id:id,ready:false,processing_status:'UPLOADED'};
   }
   const d=(await send('/v23/customers/'+p.account_id+'/assets:mutate',{operations:[{create:{name:p.name,type:'IMAGE',imageAsset:{data:bytes.toString('base64')}}}],partialFailure:false})).data as JsonObject;
   const id=responseId(d.results?.length===1?d.results[0].resourceName:undefined,new RegExp('^customers/'+p.account_id+'/assets/[0-9]+$'));record({media_id:id});return {media_id:id,ready:true,processing_status:'AVAILABLE'};
  }
  if(p.platform==='tiktok'){
   const kind=p.kind,body={advertiser_id:p.account_id,upload_type:'UPLOAD_BY_FILE',file_name:p.filename,[kind+'_signature']:createHash('md5').update(bytes).digest('hex')};
   const d=(await send('/v1.3/file/'+kind+'/ad/upload/',body,{upload:binary(kind+'_file')})).data as JsonObject;
   const data=Array.isArray(d.data)?d.data.length===1?d.data[0]:{}:d.data;
   if(d.code!==0)fail('MEDIA_RESPONSE_INVALID','TikTok upload failed.');const id=responseId(data?.[kind+'_id'],/^[A-Za-z0-9_\/-]{1,512}$/);record({media_id:id});return {media_id:id,ready:true,processing_status:'UPLOADED'};
  }
  if(p.platform==='dv360'){
   const d=(await send('/upload/v4/advertisers/'+p.account_id+'/assets',{filename:p.filename},{query:{uploadType:'multipart'},upload:{...binary('media'),format:'related'}})).data as JsonObject;
   const id=responseId(d.asset?.mediaId,/^\d+$/);record({media_id:id});return {media_id:id,ready:true,processing_status:'UPLOADED',data:{asset:d.asset}};
  }
  if(p.platform==='snapchat'){
   const path='/v1/adaccounts/'+p.account_id+'/media',body={media:[{name:p.name,type:p.kind.toUpperCase(),ad_account_id:p.account_id}]};
   let id=p.existing_media_id;
   if(!id){const created=(await send(path,body)).data as JsonObject,row=created.media?.length===1?created.media[0]:undefined;
    if(String(created.request_status).toUpperCase()!=='SUCCESS'||String(row?.sub_request_status).toUpperCase()!=='SUCCESS'||row.media.ad_account_id!==p.account_id)fail('MEDIA_RESPONSE_INVALID','Snapchat did not confirm the account-bound media allocation.');id=responseId(row.media.id);}
   record({media_id:id});
   const c=this.access(actor,p.platform,p.account_id,p.connection_id);this.store.rememberResource(c,p.account_id,'media/'+id);
   const d=(await send('/v1/media/'+id+'/upload',{}, {upload:binary('file')})).data as JsonObject;
   if(String(d.request_status).toUpperCase()!=='SUCCESS'||d.result?.id!==id||d.result?.ad_account_id!==p.account_id)fail('MEDIA_RESPONSE_INVALID','Snapchat did not confirm this media upload.');
   return {media_id:id,ready:d.result.media_status==='READY',processing_status:d.result.media_status??'PROCESSING'};
  }
  if(p.platform==='linkedin'){
   const kind=p.kind==='image'?'images':'videos',request={owner:p.owner_urn??'urn:li:sponsoredAccount:'+p.account_id,mediaLibraryMetadata:{associatedAccount:'urn:li:sponsoredAccount:'+p.account_id,assetName:p.name},...(p.kind==='video'?{fileSizeBytes:p.size,uploadCaptions:false,uploadThumbnail:false}:{})};
   const d=(await send('/rest/'+kind,{initializeUploadRequest:request},{query:{action:'initializeUpload'}})).data as JsonObject,v=d.value,id=responseId(v?.[p.kind],new RegExp('^urn:li:'+p.kind+':[A-Za-z0-9_-]+$'));record({media_id:id});
   const instructions=p.kind==='image'?[{uploadUrl:v.uploadUrl,firstByte:0,lastByte:bytes.length-1}]:v.uploadInstructions;
   if(!Array.isArray(instructions)||!instructions.length||instructions.length>32)fail('MEDIA_RESPONSE_INVALID','LinkedIn returned invalid upload instructions.');
   let offset=0;for(const part of instructions){if(part.firstByte!==offset||!Number.isSafeInteger(part.lastByte)||part.lastByte<offset||part.firstByte>=bytes.length)fail('MEDIA_RESPONSE_INVALID','LinkedIn upload byte ranges do not cover the reviewed file.');offset=Math.min(part.lastByte+1,bytes.length);}
   if(offset!==bytes.length)fail('MEDIA_RESPONSE_INVALID','LinkedIn upload ranges omit file bytes.');
   const ids:string[]=[];for(const part of instructions){const c=this.access(actor,p.platform,p.account_id,p.connection_id),token=p.kind==='image'?(await this.credentials.get(c)).accessToken:undefined;this.access(actor,p.platform,p.account_id,p.connection_id);if(this.executionContext.getStore()!==undefined&&this.executionContext.getStore()!<=Date.now())fail('REVIEW_EXPIRED','Media review expired before the next upload step.');const etag=await this.transport.uploadLinkedIn(part.uploadUrl,bytes.subarray(part.firstByte,part.lastByte+1),p.mime,token);if(p.kind==='video'){if(!etag)fail('MEDIA_RESPONSE_INVALID','LinkedIn upload did not return its part identifier.');ids.push(etag!);}}
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
  responseId(key,/^[0-9]+_[0-9]+$/);
  const library=(await this.send(actor,p,'/12/accounts/'+p.account_id+'/media_library',{media_key:key,name:p.name,file_name:p.filename})).data as JsonObject;
  const libraryId=responseId(library.data?.media_key,/^[0-9]+_[0-9]+$/);
  if(libraryId!==key||libraryId.split('_').at(-1)!==id||library.data.deleted===true)fail('MEDIA_RESPONSE_INVALID','X registered a different or deleted media identifier.');
  const ready=library.data.media_status==='TRANSCODE_COMPLETED';
  return {media_id:id,media_key:libraryId,library_id:libraryId,ready,processing_status:library.data.media_status??'UNKNOWN'};
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
  receipt={...receipt};delete receipt.next_call;
  const finish=(out:JsonObject)=>{
   out.availability_checked_at=Date.now();out.handoff_status=out.ready===true&&out.status_source==='provider'?'verified':'pending_processing';
   const failed=['ERROR','FAILED','PROCESSING_FAILED','REJECTED'].includes(String(out.processing_status).toUpperCase());
   if(failed){delete out.next_call;out.ready=false;out.processing_failed=true;out.handoff_status='processing_failed';}
   this.store.putDocument(actor.tenantId,'workspace_asset',receipt.review_id,{...out,name:p.name,media_type:p.kind,mime_type:p.mime,size_bytes:p.size,source:'server_drive_import',upload_session_id:receipt.review_id});
   if(failed)fail('MEDIA_PROCESSING_FAILED','The platform rejected media processing. Inspect the retained upload before preparing a replacement.',{media_id:receipt.media_id,review_id:receipt.review_id,processing_status:out.processing_status,retry_safe:false});
   return out;
  };
  const poll={tool:'amcp_media',arguments:{action:'status',review_id:receipt.review_id}};
  let r:TransportResult;
  if(p.platform==='x_ads'&&receipt.library_id){
   const key=responseId(receipt.library_id,/^[0-9]+_[0-9]+$/),d=(await this.send(actor,p,'/12/accounts/'+p.account_id+'/media_library/'+key,undefined,{method:'GET',readOnly:true})).data as JsonObject;
   if(d.data?.media_key!==key||d.data.deleted===true||d.data.account_id!==undefined&&d.data.account_id!==p.account_id)fail('MEDIA_NOT_AVAILABLE','The exact registered X media is no longer accessible in the selected account.');
   const ready=d.data.media_status==='TRANSCODE_COMPLETED';return finish({...receipt,executed:false,ready,processing_status:d.data.media_status??'UNKNOWN',status_source:'provider',...(!ready?{next_call:poll}:{})});
  }
  if(p.platform==='meta'&&p.kind==='image'){
   const hash=responseId(receipt.media_id);const d=(await this.send(actor,p,'/v25.0/act_'+p.account_id+'/adimages',undefined,{method:'GET',readOnly:true,query:{hashes:[hash],fields:'hash',limit:100}})).data as JsonObject;
   if(!Array.isArray(d.data)||!d.data.some((image:JsonObject)=>image.hash===hash))fail('MEDIA_NOT_AVAILABLE','The uploaded image is no longer accessible in the selected Meta account.');
   return finish({...receipt,ready:true,executed:false,status_source:'provider',processing_status:'AVAILABLE',availability_checked_at:Date.now()});
  }
  if(p.platform==='google_ads'&&p.kind==='image'){
   const resource=responseId(receipt.media_id,new RegExp('^customers/'+p.account_id+'/assets/[0-9]+$')),d=(await this.send(actor,p,'/v23/customers/'+p.account_id+'/googleAds:search',{query:"SELECT asset.resource_name, asset.type FROM asset WHERE asset.resource_name = '"+resource+"'"},{readOnly:true})).data as JsonObject;
   if(d.results?.length!==1||d.results[0].asset?.resourceName!==resource||d.results[0].asset.type!=='IMAGE')fail('MEDIA_NOT_AVAILABLE','The uploaded image asset is no longer accessible.');
   return finish({...receipt,ready:true,executed:false,status_source:'provider',processing_status:'AVAILABLE',availability_checked_at:Date.now()});
  }
  if(p.platform==='tiktok'){
   const id=responseId(receipt.media_id,/^[A-Za-z0-9_\/-]{1,512}$/),d=(await this.send(actor,p,'/v1.3/file/'+p.kind+'/ad/info/',undefined,{method:'GET',readOnly:true,query:{advertiser_id:p.account_id,[p.kind+'_ids']:[id]}})).data as JsonObject;
   if(d.code!==0||!Array.isArray(d.data?.list)||!d.data.list.some((v:JsonObject)=>v[p.kind+'_id']===id))fail('MEDIA_NOT_AVAILABLE','The uploaded file is no longer accessible in the selected TikTok account.');
   return finish({...receipt,ready:true,executed:false,status_source:'provider',processing_status:'AVAILABLE',availability_checked_at:Date.now()});
  }
  if(p.platform==='google_ads'&&p.kind==='video'){
   const resource=responseId(receipt.media_id,new RegExp('^customers/'+p.account_id+'/youTubeVideoUploads/[A-Za-z0-9_-]+$'));
   r=await this.send(actor,p,'/v23/customers/'+p.account_id+'/googleAds:search',{query:"SELECT you_tube_video_upload.resource_name, you_tube_video_upload.video_id, you_tube_video_upload.state FROM you_tube_video_upload WHERE you_tube_video_upload.resource_name = '"+resource+"'"},{readOnly:true});
   const d=r.data as JsonObject,v=d.results?.length===1?d.results[0].youTubeVideoUpload:undefined;
   if(!v||v.resourceName!==resource)fail('MEDIA_RESPONSE_INVALID','Google did not return the exact uploaded video.');
   const ready=v.state==='PROCESSED';if(ready)responseId(v.videoId,/^[A-Za-z0-9_-]{11}$/);
   const assetCall={tool:'amcp_write',arguments:{action:'prepare',gateway:'google_ads_native_action',connection_id:p.connection_id,arguments:{action:'google_ads_v23_asset_mutate_assets',account_id:p.account_id,payload:{operations:[{create:{name:p.name,type:'YOUTUBE_VIDEO',youtubeVideoAsset:{youtubeVideoId:v.videoId}}}]}}}};
   return finish({...receipt,executed:false,ready,processing_status:v.state,status_source:'provider',...(ready?{video_id:v.videoId,youtube_video_id:v.videoId,next_call:assetCall}:{next_call:poll})});
  }
  if(p.platform==='snapchat')r=await this.send(actor,p,'/v1/media/'+receipt.media_id,undefined,{method:'GET',readOnly:true});
  else if(p.platform==='meta'&&p.kind==='video')r=await this.send(actor,p,'/v25.0/'+receipt.media_id,undefined,{method:'GET',readOnly:true,query:{fields:'id,status'}});
  else if(p.platform==='linkedin')r=await this.send(actor,p,'/rest/'+(p.kind==='image'?'images':'videos')+'/'+encodeURIComponent(receipt.media_id),undefined,{method:'GET',readOnly:true});
  else if(p.platform==='x_ads'&&p.kind==='video')r=await this.send(actor,p,'/1.1/media/upload.json',undefined,{method:'GET',readOnly:true,origin:'https://upload.x.com',query:{command:'STATUS',media_id:receipt.media_id}});
  else return {...receipt,executed:false,status_source:'upload_receipt'};
  const d=r.data as JsonObject,state=p.platform==='meta'?d.status?.video_status:p.platform==='linkedin'?d.status:p.platform==='x_ads'?d.processing_info?.state:d.media?.[0]?.media?.media_status;
  const id=p.platform==='x_ads'?d.media_id_string:p.platform==='snapchat'?d.media?.[0]?.media?.id:d.id;
  if(id!==receipt.media_id||p.platform==='snapchat'&&(d.request_status!=='SUCCESS'||d.media?.length!==1||d.media[0].sub_request_status!=='SUCCESS'||d.media[0].media.ad_account_id!==p.account_id)||p.platform==='linkedin'&&(d.owner!==(p.owner_urn??'urn:li:sponsoredAccount:'+p.account_id)||d.mediaLibraryMetadata?.associatedAccount!==undefined&&d.mediaLibraryMetadata.associatedAccount!=='urn:li:sponsoredAccount:'+p.account_id))fail('MEDIA_RESPONSE_INVALID','The platform did not return the exact uploaded media in the selected account.');
  const ready=['ready','AVAILABLE','succeeded','READY'].includes(state),out={...receipt,executed:false,ready,...(p.platform==='linkedin'?{owner_urn:d.owner}:{}),...(p.platform==='x_ads'?{data:{media_id_string:d.media_id_string,media_key:d.media_key,processing_info:{state:d.processing_info?.state}}}:{}),processing_status:state??'UNKNOWN',status_source:'provider',...(!ready?{next_call:poll}:{}),...(p.platform==='x_ads'&&ready&&!receipt.library_id?{ready:false,next_call:{tool:'amcp_media',arguments:{action:'prepare_library',review_id:receipt.review_id}}}:{})};
  return finish(out);
 }
 private references(p:UploadPlan,out:UploadResult):JsonObject {
  const id=out.media_id;
  if(p.platform==='meta')return p.kind==='image'?{image_hash:id,meta_image_hash:id,creative_reference:{object_story_spec:{page_id:'<required Page ID>',link_data:{image_hash:id,link:'<required destination URL>'}}},required_inputs:['Page ID with advertising permission','Destination URL for a website creative']}:{video_id:id,meta_video_id:id};
  if(p.platform==='tiktok')return {[p.kind+'_id']:id,['tiktok_'+p.kind+'_id']:id};
  if(p.platform==='google_ads')return p.kind==='image'?{google_asset_resource_name:id,uploaded_asset:{resource_name:id}}:{google_video_upload_resource_name:id,video_privacy:'UNLISTED',channel:'Google-managed channel associated with the advertising account'};
  if(p.platform==='snapchat')return {snapchat_media_id:id,creative_reference:{top_snap_media_id:id}};
  if(p.platform==='linkedin')return {linkedin_media_urn:id,[p.kind]:id,owner_urn:p.owner_urn??'urn:li:sponsoredAccount:'+p.account_id};
  if(p.platform==='dv360')return {dv360_media_id:id,asset:out.data&&(out.data as JsonObject).asset};
  return {x_media_key:out.media_key??id};
 }
}
