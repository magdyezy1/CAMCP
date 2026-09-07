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
import {MediaUploadService,mediaTool} from './media-upload.js';
export const strictOptions:CallOptions={mode:'strict',flags:{}};
export class MirrorService {
 readonly compiler:Compiler;readonly introspection:Introspection;readonly credentials:CredentialProvider;
 readonly delegatedCompiler=new DelegatedNativeCompiler();
 listTools(){return [...this.registry.listTools(this.options),...(this.policy.allowWrites?[writeTool,mediaTool]:[])];}
 constructor(readonly registry:Registry,readonly store:Store,readonly transport=new NativeTransport(),readonly options:CallOptions=strictOptions,readonly policy:ExecutionPolicy=readOnlyPolicy,private mediaFetcher:typeof fetch=fetch){this.compiler=new Compiler(registry);this.introspection=new Introspection(registry);this.credentials=new CredentialProvider(store);}
 async call(tool:string,input:JsonObject,actor:Actor):Promise<JsonObject>{
  const requestId=randomUUID(),start=Date.now();
  try{
   if(tool===mediaTool.name)return this.wrap(await new MediaUploadService(this.registry,this.store,this.transport,this.credentials,this.policy,this.mediaFetcher).call(input,actor),requestId,start);
   if(tool===writeTool.name){const result:any=await new WriteReviewService(this.registry,this.compiler,this.store,this.transport,this.credentials,this.options,this.policy,this.delegatedCompiler).call(input,actor);return {...this.wrap(result,requestId,start),...(result.success===false?{success:false,error:{code:'WRITE_PARTIAL_OR_FAILED',message:'Provider reported an incomplete or failed mutation; inspect the retained outcome before further action.'}}:{})};}
   this.registry.validate(tool,input,this.options);
   if(tool==='whathead_tool_help')return this.registry.help(input,this.options);
   if(input.action==='LIST_ACTIONS')return this.wrap(this.introspection.list(tool,input,this.options),requestId,start);
   if(input.action==='DESCRIBE_ACTION')return this.wrap(this.introspection.describe(tool,input),requestId,start);
   if(this.registry.tools.get(tool)?.mode==='delegated')return this.wrap(await this.delegated(tool,input.operation,input.arguments??{},actor,requestId),requestId,start);
   const plan=this.compiler.compile(tool,input,this.options);
   return this.wrap(await this.runPlan(plan,input,actor,requestId),requestId,start);
  }catch(e){const result=errorResult(e,requestId,Date.now()-start);this.store.appendAudit(actor.tenantId,requestId,{tool,input:redact(input),outcome:result});return result;}
 }
 private wrap(data:unknown,requestId:string,start:number){return {success:true,data,meta:{requestId,latencyMs:Date.now()-start}};}
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
   const fetchPage=async(p:CompiledRequest)=>{this.store.assertActorActive(actor);const current=this.store.resolveConnection(actor,p.gateway,p.accountId,connection.id);scope.authorize(p,current);const {data,status}=await this.transport.request(p,current,credentials);this.delegatedCompiler.validateResponse(p,data,status);validateAppleResponse(p,data);scope.observe(p,current,data);return data;};
   const result=input.aggregate_pages||input.paginate||input.allPages?await paginate(plan,fetchPage,Number(input.max_pages??25)):{data:await fetchPage(plan),pages:1,truncated:false};
   const projected=projectResponse(result.data,plan.responseControls);
   const outcome={success:true,action:plan.action,dry_run:false,...result,data:projected.data,truncated:result.truncated||projected.truncated,...(projected.truncated?{response_truncated:true}:{})};
   this.store.appendAudit(actor.tenantId,requestId,{event:'request_completed',request:plan,outcome});return outcome;
  }catch(e){this.store.appendAudit(actor.tenantId,requestId,{event:'request_failed',request:plan,error:e instanceof MirrorError?{code:e.code,message:e.message,details:e.details}:{code:'INTERNAL_ERROR'}});throw e;}
 }
 private async delegated(gateway:string,operation:string,args:JsonObject,actor:Actor,requestId:string):Promise<unknown>{
  if(this.delegatedCompiler.isNativeOperation(gateway,operation))return this.runPlan(this.delegatedCompiler.compile(gateway,{operation,arguments:args}),args,actor,requestId);
  if(gateway==='whathead_native_action'&&reportingOperations.has(operation))return new ReportingService(this.store).handle(operation,args,actor);
  if(['get_workspace_context','list_accounts','list_workspace_assets'].includes(operation)){
   const connections=this.store.listConnections(actor.tenantId).filter(c=>c.enabled);
   if(operation==='get_workspace_context')return {workspace:{id:actor.tenantId},actor:{id:actor.userId,role:actor.role},connections:connections.map(c=>({id:c.id,platform:c.gateway,accounts:c.accounts})),live_writes_enabled:this.policy.allowWrites};
   if(operation==='list_accounts')return connections.filter(c=>!args.platform||c.gateway.startsWith(args.platform==='google'?'google_ads':String(args.platform))).flatMap(c=>c.accounts.map(id=>({id,platform:c.gateway,connection_id:c.id,name:c.label,source:'configured_binding',currency:null,timezone:null})));
   return this.store.documents(actor.tenantId,'workspace_asset');
  }
  if(operation==='get_creative_generation_job')return this.store.job(actor.tenantId,String(args.job_id));
  if(gateway==='whathead_native_action')return new WorkflowEngine({registry:this.registry,store:this.store,runNative:async(g,input,a)=>this.runPlan(this.compiler.compile(g,input,this.options),input,a)}).handle(operation,args,actor);
  throw new MirrorError('WORKFLOW_ADAPTER_REQUIRED','This captured workflow still requires its independent implementation.',{gateway,operation});
 }
}
