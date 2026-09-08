import {randomUUID} from 'node:crypto';
import type {Actor,CallOptions,CompiledRequest,JsonObject} from './types.js';
import {Registry} from './catalog.js';
import {Compiler} from './compiler.js';
import {Introspection} from './introspection.js';
import {Store} from './store.js';
import {CredentialProvider} from './auth.js';
import {NativeTransport} from './transport.js';
import {authorizeExecution,readOnlyPolicy,type ExecutionPolicy} from './preflight.js';
import {errorResult,MirrorError} from './errors.js';
import {redact} from './security.js';
import {paginate} from './pagination.js';
import {ScopeGuard} from './scope.js';
import {DelegatedNativeCompiler} from './delegated-native.js';
import {WorkflowEngine} from './workflows.js';
import {ReportingService,reportingOperations} from './reporting.js';
import {applyExecutionRisk} from './execution-risk.js';
import {projectResponse} from './projection.js';
import {WriteReviewService,writeTool} from './write-review.js';
import {validateAppleResponse} from './apple-native.js';
import {microsoftGateway,validateMicrosoftResponse} from './microsoft-native.js';
import {downloadReportArchive,parseMicrosoftReport,microsoftReportKey,microsoftReportPage} from './microsoft-report-download.js';
import {guidanceDiscovery} from './guidance.js';
import {WorkspaceService,workspaceTool} from './workspace.js';
import {CampaignRunner,campaignTool} from './campaign-runner.js';
import {DecisionReporting,decisionTool} from './decision-reporting.js';
import {WriteVerifier} from './write-verification.js';
import {validateProviderRequest} from './provider-validation.js';
import {MediaUploadService,mediaTool} from './media-upload.js';
import {nativeMediaInput,workflowMediaInput,mediaPreview,mediaNext,inspectDrive,mediaDiscovery,mediaInstructions} from './media-routing.js';
export const strictOptions:CallOptions={mode:'strict',flags:{}};
export class MirrorService {
 readonly compiler:Compiler;readonly introspection:Introspection;readonly credentials:CredentialProvider;
 readonly delegatedCompiler=new DelegatedNativeCompiler();
 listTools(){return [...this.registry.listTools(this.options).map(t=>({...t,...(mediaDiscovery(t.name)?{description:t.description+' '+mediaInstructions}:{})})),workspaceTool,campaignTool,decisionTool,...(this.policy.allowWrites?[writeTool,mediaTool]:[])];}
 constructor(readonly registry:Registry,readonly store:Store,readonly transport=new NativeTransport(),readonly options:CallOptions=strictOptions,readonly policy:ExecutionPolicy=readOnlyPolicy,private mediaFetcher:typeof fetch=fetch){this.compiler=new Compiler(registry);this.introspection=new Introspection(registry);this.credentials=new CredentialProvider(store);}
 async call(tool:string,input:JsonObject,actor:Actor):Promise<JsonObject>{
  const requestId=randomUUID(),start=Date.now();
  try{
   const call=(t:string,a:JsonObject,u:Actor)=>this.call(t,a,u);
   if(tool===workspaceTool.name)return this.wrap(await new WorkspaceService(this.store,this.registry,this.transport,this.credentials,call,this.policy.allowWrites).handle(input,actor),requestId,start);
   if(tool===campaignTool.name)return this.wrap(await new CampaignRunner(this.store,call,(a,id)=>this.verifyWrite(a,id), (a,i)=>validateProviderRequest(this,a,i)).handle(input,actor),requestId,start);
   if(tool===decisionTool.name)return this.wrap(await new DecisionReporting(this.store,async(t,a,u)=>{
    this.registry.validate(t,a,this.options);const p=this.registry.tools.get(t)?.mode==='delegated'?this.delegatedCompiler.compile(t,a):this.compiler.compile(t,a,this.options);
    if(!applyExecutionRisk(p).readOnly)throw new MirrorError('REPORT_READ_REQUIRED','Reporting accepts independently qualified native reads only.');
    return this.wrap(await this.runPlan(p,a.operation?a.arguments:a,u),requestId,start);
   }).handle(input,actor),requestId,start);
   if(tool===mediaTool.name)return this.wrap(mediaNext(await this.media().call(input,actor)),requestId,start);
   if(tool===writeTool.name){const result:any=await this.reviewed(input,actor);return {...this.wrap(result,requestId,start),...(result.success===false?{success:false,error:{code:'WRITE_PARTIAL_OR_FAILED',message:'Provider reported an incomplete or failed mutation; inspect the retained outcome before further action.'}}:{})};}
   this.registry.validate(tool,input,this.options);
   if(tool==='whathead_tool_help'){const help=this.registry.help(input,this.options),media=mediaDiscovery(input.gateway);return {...help,amcp_guidance:guidanceDiscovery,amcp_extensions:{gateways:[microsoftGateway]},...(media?{amcp_media_import:media}:{})};}
   if(input.action==='LIST_ACTIONS')return this.wrap(this.introspection.list(tool,input,this.options),requestId,start);
   if(input.action==='DESCRIBE_ACTION'){const description=this.introspection.describe(tool,input),media=mediaDiscovery(tool);return this.wrap({...description,amcp_write_inspection:{tool:'amcp_write',action:'inspect',gateway:tool,usage:'Supply the intended native arguments to check local review-contract support without provider calls. Media routes use amcp_media.'},...(media?{amcp_media_import:media}:{})},requestId,start);}
   if(this.registry.tools.get(tool)?.mode==='delegated')return this.wrap(await this.delegated(tool,input.operation,input.arguments??{},actor,requestId),requestId,start);
   const plan=this.compiler.compile(tool,input,this.options);
   const hasMediaSource=['drive_url','url','image_url','video_url','file_url','source'].some(k=>plan.body&&typeof plan.body==='object'&&(plan.body as JsonObject)[k]!==undefined);
   const media=input.dry_run===false||hasMediaSource?nativeMediaInput(plan,this.connectionId(input)):undefined;
   if(media)return this.wrap(input.dry_run===false?mediaNext(await this.media().call(media,actor)):mediaPreview(media),requestId,start);
   return this.wrap(await this.runPlan(plan,input,actor,requestId),requestId,start);
  }catch(e){const result=errorResult(e,requestId,Date.now()-start);this.store.appendAudit(actor.tenantId,requestId,{tool,input:redact(input),outcome:result});return result;}
 }
 private wrap(data:unknown,requestId:string,start:number){return {success:true,data,meta:{requestId,latencyMs:Date.now()-start}};}
 async verifyWrite(actor:Actor,id:string){return new WriteVerifier(this.store,this.registry,this.transport,this.credentials).verify(actor,id);}
 async verificationJob(tenant:string,kind:string,input:JsonObject){
  if(kind!=='write_verification')throw new MirrorError('UNKNOWN_JOB_KIND','No worker handles this job.');
  const actor=this.store.restoreJobActor(tenant,input.review_id,input.actor_binding);
  return this.verifyWrite(actor,input.review_id);
 }
 private media(){return new MediaUploadService(this.registry,this.store,this.transport,this.credentials,this.policy,this.mediaFetcher);}
 private connectionId(input:JsonObject,outer?:string){const ids=[outer,input.connection_id,input.connectionId].filter(v=>v!==undefined);if(ids.some(v=>typeof v!=='string'||v!==ids[0]))throw new MirrorError('CONFLICTING_PARAMETER','Connection ID aliases must identify the same connection.');return ids[0];}
 private async reviewed(input:JsonObject,actor:Actor):Promise<unknown>{
  for(const key of Object.keys(input))if(!Object.hasOwn(writeTool.inputSchema.properties,key))throw new MirrorError('INVALID_ARGUMENT','Unknown write-tool parameter.',{parameter:key});
  if(input.action==='execute'&&typeof input.review_id==='string'&&this.store.db.prepare('SELECT 1 FROM documents WHERE tenant_id=? AND kind=? AND id=?').get(actor.tenantId,'media_review',input.review_id)){
   if(input.gateway!==undefined||input.arguments!==undefined||input.connection_id!==undefined||input.spend_change_confirmed!==undefined)throw new MirrorError('INVALID_ARGUMENT','Media execution uses only its frozen review and confirmation.');
   return this.media().call(input,actor);
  }
  if(input.action==='prepare'&&typeof input.gateway==='string'&&input.arguments&&typeof input.arguments==='object'&&!Array.isArray(input.arguments)){
   const args=input.arguments;this.registry.validate(input.gateway,args,this.options);
   if(input.gateway==='whathead_native_action'&&args.operation==='platform_media_upload')return mediaNext(await this.media().call(workflowMediaInput(args.arguments,input.connection_id),actor));
   if(this.registry.tools.get(input.gateway)?.mode!=='delegated'){
    const plan=this.compiler.compile(input.gateway,args,this.options),media=nativeMediaInput(plan,this.connectionId(args,input.connection_id));
    if(media)return mediaNext(await this.media().call(media,actor));
   }
  }
  return new WriteReviewService(this.registry,this.compiler,this.store,this.transport,this.credentials,this.options,this.policy,this.delegatedCompiler).call(input,actor);
 }
 async runPlan(plan:CompiledRequest,input:JsonObject,actor:Actor,requestId:string=randomUUID()):Promise<unknown>{
  if(input.connection_id&&input.connectionId&&input.connection_id!==input.connectionId)throw new MirrorError('CONFLICTING_PARAMETER','Connection ID aliases must identify the same connection.',{},403);
  plan=applyExecutionRisk(plan);
  if(input.dry_run===true||!plan.readOnly&&input.dry_run!==false){const result={success:true,dry_run:true,action:plan.action,request:plan,executed:false};this.store.appendAudit(actor.tenantId,requestId,{event:'preview',request:plan,outcome:'not_executed'});return result;}
  authorizeExecution(actor,plan,input,this.policy);
  if(!plan.readOnly)throw new MirrorError('WRITE_REVIEW_REQUIRED','Use amcp_write prepare and execute for a reviewed mutation.');
  const connection=this.store.resolveConnection(actor,plan.gateway,plan.accountId,input.connection_id??input.connectionId);
  if(!plan.accountId&&connection.accounts.length!==1)throw new MirrorError('ACCOUNT_REQUIRED','Specify an account_id for this connection.');
  const scope=new ScopeGuard(this.registry,this.store);scope.authorize(plan,connection);
  const credentials=await this.credentials.get(connection);
  this.store.appendAudit(actor.tenantId,requestId,{event:'request_started',actor:actor.userId,request:plan});
  try{
   const fetchPage=async(p:CompiledRequest)=>{this.store.assertActorActive(actor);const current=this.store.resolveConnection(actor,p.gateway,p.accountId,connection.id);scope.authorize(p,current);const result=await this.transport.request(p,current,credentials),{data,status}=result;this.delegatedCompiler.validateResponse(p,data,status);validateAppleResponse(p,data);if(p.gateway===microsoftGateway)validateMicrosoftResponse(p,result);scope.observe(p,current,data);if(p.gateway===microsoftGateway&&p.reportDownload)return this.microsoftDownload(p,data as JsonObject,actor,current.id);return data;};
   const result=input.aggregate_pages||input.paginate||input.allPages?await paginate(plan,fetchPage,Number(input.max_pages??25)):{data:await fetchPage(plan),pages:1,truncated:false};
   const projected=projectResponse(result.data,plan.responseControls);
   const outcome={success:true,action:plan.action,dry_run:false,...result,data:projected.data,truncated:result.truncated||projected.truncated,...(projected.truncated?{response_truncated:true}:{})};
   this.store.appendAudit(actor.tenantId,requestId,{event:'request_completed',request:plan,outcome});return outcome;
  }catch(e){this.store.appendAudit(actor.tenantId,requestId,{event:'request_failed',request:plan,error:e instanceof MirrorError?{code:e.code,message:e.message,details:e.details}:{code:'INTERNAL_ERROR'}});throw e;}
 }
 private async microsoftDownload(plan:CompiledRequest,data:JsonObject,actor:Actor,connectionId:string){
  const access=()=>{this.store.assertActorActive(actor);const c=this.store.resolveConnection(actor,plan.gateway,plan.accountId,connectionId);new ScopeGuard(this.registry,this.store).authorize(plan,c);};access();
  const reportId=(plan.body as JsonObject).ReportRequestId,status=data.ReportRequestStatus,key=microsoftReportKey(connectionId,plan.accountId!,reportId);
  const next=(offset:number)=>({tool:microsoftGateway,arguments:{action:'PollGenerateReport',account_id:plan.accountId,connection_id:connectionId,payload:{ReportRequestId:reportId},download_report:true,offset,limit:plan.reportDownload!.limit}});
  if(status.Status==='Pending')return {report_request_id:reportId,status:'Pending',complete:false,next_call:next(plan.reportDownload!.offset)};
  if(status.Status==='Error')throw new MirrorError('REPORT_GENERATION_FAILED','Microsoft could not generate this report.',{},502);
  let stored:JsonObject;try{stored=this.store.document(actor.tenantId,'microsoft_report',key);}catch{throw new MirrorError('REPORT_METADATA_REQUIRED','Submit this report through AMCP again to record the original format and columns.');}
  if(stored.expires_at<=Date.now())throw new MirrorError('REPORT_EXPIRED','Submit a fresh Microsoft report.');
  let parsed=stored.parsed;
  if(!parsed){
   if(status.ReportDownloadUrl==null||status.ReportDownloadUrl==='')parsed={columns:stored.request.Columns,rows:[],row_count:0,metadata:{},potentially_incomplete:stored.request.ReturnOnlyCompleteData===true?false:null,values:'native_strings',format:stored.request.Format??'Csv',empty_reason:'provider_returned_no_download_url'};
   else{if(!['Csv','Tsv'].includes(stored.request.Format??'Csv'))throw new MirrorError('REPORT_FORMAT_UNSUPPORTED','Server parsing supports Csv and Tsv. Submit another report in one of those formats.');access();const bytes=await downloadReportArchive(status.ReportDownloadUrl,this.mediaFetcher===fetch?undefined:this.mediaFetcher);access();parsed=parseMicrosoftReport(bytes,stored.request,plan.accountId!);}
   this.store.putDocument(actor.tenantId,'microsoft_report',key,{...stored,parsed});
  }
  access();const {offset,limit}=plan.reportDownload!,rows=microsoftReportPage(parsed.rows,offset,limit),hasMore=offset+rows.length<parsed.row_count;
  return {...parsed,rows,status:'Success',report_request_id:reportId,download_complete:true,offset,limit,has_more:hasMore,...(hasMore?{next_call:next(offset+rows.length)}:{})};
 }
 private async delegated(gateway:string,operation:string,args:JsonObject,actor:Actor,requestId:string):Promise<unknown>{
  if(gateway==='whathead_native_action'&&operation==='inspect_google_drive_media'){this.store.assertActorActive(actor);return inspectDrive(args.link,this.mediaFetcher);}
  if(gateway==='whathead_native_action'&&operation==='platform_media_upload'){
   if(args.action==='FINALIZE_UPLOAD_SESSION'){
    if(Object.keys(args).some(k=>!['action','upload_session_id','idempotency_key','confirmed','dry_run'].includes(k)))throw new MirrorError('INVALID_ARGUMENT','Finalize uses only the frozen review.');
    if(args.dry_run!==false)return {dry_run:true,executed:false,next_call:{tool:'amcp_write',arguments:{action:'execute',review_id:args.upload_session_id,idempotency_key:args.idempotency_key,confirmed:true}}};
    return this.media().call({action:'execute',review_id:args.upload_session_id,idempotency_key:args.idempotency_key,confirmed:args.confirmed},actor);
   }
   const media=workflowMediaInput(args);return args.dry_run===false?mediaNext(await this.media().call(media,actor)):mediaPreview(media);
  }
  if(this.delegatedCompiler.isNativeOperation(gateway,operation))return this.runPlan(this.delegatedCompiler.compile(gateway,{operation,arguments:args}),args,actor,requestId);
  if(gateway==='whathead_native_action'&&reportingOperations.has(operation))return new ReportingService(this.store).handle(operation,args,actor);
  if(['get_workspace_context','list_accounts','list_workspace_assets'].includes(operation)){
   const connections=this.store.listConnections(actor.tenantId).filter(c=>c.enabled);
   if(operation==='get_workspace_context')return {workspace:{id:actor.tenantId},actor:{id:actor.userId,role:actor.role},connections:connections.map(c=>({id:c.id,platform:c.gateway,accounts:c.accounts,write_accounts:c.writeAccounts??[],is_default:c.isDefault===true})),live_writes_enabled:this.policy.allowWrites};
   if(operation==='list_accounts')return connections.filter(c=>!args.platform||c.gateway.startsWith(args.platform==='google'?'google_ads':String(args.platform))).flatMap(c=>c.accounts.map(id=>({id,platform:c.gateway,connection_id:c.id,name:c.label,source:'configured_binding',currency:null,timezone:null,write_enabled:this.policy.allowWrites&&actor.role!=='reader'&&c.writeAccounts?.includes(id)===true,is_default:c.isDefault===true})));
   return this.store.documents(actor.tenantId,'workspace_asset');
  }
  if(operation==='get_creative_generation_job')return this.store.job(actor.tenantId,String(args.job_id));
  if(gateway==='whathead_native_action')return new WorkflowEngine({registry:this.registry,store:this.store,runNative:async(g,input,a)=>this.runPlan(this.compiler.compile(g,input,this.options),input,a)}).handle(operation,args,actor);
  throw new MirrorError('WORKFLOW_ADAPTER_REQUIRED','This captured workflow still requires its independent implementation.',{gateway,operation});
 }
}
