import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import type {Actor,JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {audit,bad,field,fingerprint,noSecrets,obj,optional,pointer,read,tool,validate,writer,type ToolCall} from './workspace-core.js';
export const campaignTool=tool('amcp_campaign','Create a durable campaign dependency plan from a brief and explicit native steps. Apply approved profiles/templates. prepare_next resolves only verified predecessor outputs and returns the existing native review; execute_next consumes that exact review, automatically reads back the result, and resumes without duplicate writes. No fabricated IDs, implicit launch, or review bypass.', ['create','get','list','prepare_next','execute_next','verify','cancel','validate_provider'],{id:field.id,name:field.id,brief:field.id,profile_id:field.id,template:field.id,variables:field.object,steps:{type:'array',items:{type:'object'},minItems:1,maxItems:50},review_id:field.id,idempotency_key:field.id,confirmed:field.bool,spend_change_confirmed:field.bool,expected_revision:field.integer,gateway:field.id,arguments:field.object,connection_id:field.id});
function substitute(v:any,variables:JsonObject):any{
 if(typeof v==='string')return v.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g,(_,key)=>{const value=pointer(variables,'/'+key.split('.').join('/'));if(typeof value!=='string'&&typeof value!=='number')bad('Template variables must be scalar.');return String(value);});
 if(Array.isArray(v))return v.map(x=>substitute(x,variables));return obj(v)?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,substitute(x,variables)])):v;
}
function references(v:any,results:Map<string,JsonObject>,deps:Set<string>):any{
 if(obj(v)&&Object.hasOwn(v,'$ref')){if(Object.keys(v).length!==1||typeof v.$ref!=='string')bad('Use {$ref:"step#/JSON/pointer"}.');const at=v.$ref.indexOf('#'),id=v.$ref.slice(0,at),path=v.$ref.slice(at+1);if(at<1||!deps.has(id))bad('A result reference must name a declared predecessor.');const result=results.get(id);if(!result)bad('The referenced step is not verified.','DEPENDENCY_PENDING');return structuredClone(pointer(result,path));}
 if(Array.isArray(v))return v.map(x=>references(x,results,deps));return obj(v)?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,references(x,results,deps)])):v;
}
const structure=(steps:JsonObject[])=>steps.map(s=>Object.fromEntries(['id','kind','gateway','connection_id','account_id','arguments','depends_on','description'].filter(k=>s[k]!==undefined).map(k=>[k,s[k]])));
export class CampaignRunner{
 constructor(private store:Store,private call:ToolCall,private verifyWrite:(actor:Actor,id:string)=>Promise<JsonObject>,private providerValidation:(actor:Actor,input:JsonObject)=>Promise<JsonObject>){}
 private owned(actor:Actor,id:string){const p=read(this.store,actor,'campaign_run',id);if(p.user_id!==actor.userId&&actor.role!=='admin')bad('Campaign plan belongs to another actor.','FORBIDDEN');if(p.plan_hash!==fingerprint(structure(p.steps)))bad('The saved plan failed its integrity check.','PLAN_CHANGED');return p;}
 private save(actor:Actor,run:JsonObject){const {id,revision,...data}=run;this.store.putDocument(actor.tenantId,'campaign_run',id,{...data,updated_at:Date.now()},revision);return this.owned(actor,id);}
 async handle(input:JsonObject,actor:Actor):Promise<JsonObject>{
  validate(input,Object.keys(campaignTool.inputSchema.properties),524288);this.store.assertActorActive(actor);
  if(input.action==='verify')return this.verifyWrite(actor,input.review_id);
  if(input.action==='validate_provider')return this.providerValidation(actor,input);
  if(input.action==='list')return {campaigns:this.store.documents(actor.tenantId,'campaign_run').filter(r=>r.user_id===actor.userId||actor.role==='admin').map(r=>({id:r.id,name:r.name,state:r.state,updated_at:r.updated_at,step_count:r.steps.length}))};
  if(input.action==='get')return this.owned(actor,input.id);
  writer(this.store,actor);
  if(input.action==='create'){
   if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100||typeof input.brief!=='string'||input.brief.length>12000)bad('Provide a campaign name and brief.');
   const profile=input.profile_id?read(this.store,actor,'client_profile',input.profile_id):undefined,variables={...(profile?.variables??{}),...(input.variables??{}),profile:profile??{}};noSecrets(variables);
   const raw=input.steps??profile?.templates?.[input.template];if(!Array.isArray(raw)||!raw.length||raw.length>50)bad('Provide 1–50 explicit steps, or choose an approved saved template.');const steps=substitute(raw,variables),seen=new Set<string>();
   for(const s of steps){validate(s,['id','kind','gateway','connection_id','account_id','arguments','depends_on','description']);if(!/^[A-Za-z][A-Za-z0-9_-]{0,50}$/.test(s.id)||seen.has(s.id)||!['write','media'].includes(s.kind)||!obj(s.arguments)||typeof s.connection_id!=='string'||typeof s.account_id!=='string')bad('Each step needs a unique ID, kind, arguments and explicit connection/account.');
    const deps=s.depends_on??[];if(!Array.isArray(deps)||new Set(deps).size!==deps.length||deps.some(d=>!seen.has(d)))bad('Dependencies must refer to earlier steps.');seen.add(s.id);noSecrets(s.arguments);
    const gateway=s.kind==='media'?s.arguments.platform+'_native_action':s.gateway;this.store.resolveConnection(actor,gateway,s.account_id,s.connection_id);
    if(s.kind==='media'&&(s.arguments.action!==undefined&&!['prepare','prepare_library'].includes(s.arguments.action)||s.arguments.confirmed!==undefined||s.arguments.idempotency_key!==undefined))bad('Media steps contain preparation inputs only.');
    s.depends_on=deps;s.status='pending';
   }
   if(this.store.documents(actor.tenantId,'campaign_run').length>=500)bad('Limit reached: 500 saved campaign plans.');
   const id=randomUUID(),run={name:input.name,brief:input.brief,user_id:actor.userId,profile_id:profile?.id??null,profile_revision:profile?.revision??null,variables,steps,state:'draft',created_at:Date.now(),updated_at:Date.now(),plan_hash:fingerprint(structure(steps)),approval:'Each resolved native request uses prepare → review → execute. Creation remains paused.'};this.store.putDocument(actor.tenantId,'campaign_run',id,run);audit(this.store,actor,'campaign_plan_created',{id,name:run.name,plan_hash:run.plan_hash});return this.owned(actor,id);
  }
  let run=this.owned(actor,input.id);if(input.expected_revision!==undefined&&input.expected_revision!==run.revision)bad('Reload the current campaign plan.','REVISION_CONFLICT');
  if(input.action==='cancel'){if(input.confirmed!==true)bad('Confirm cancellation.');run.state='cancelled';run=this.save(actor,run);return {...run,notice:'Already created provider resources remain intact.'};}
  if(run.state==='cancelled')bad('This campaign plan was cancelled.');
  const next=run.steps.find((s:JsonObject)=>!['verified','complete'].includes(s.status));if(!next)return {...run,state:'complete'};
  if(['uncertain','failed','mismatch'].includes(next.status))return {...run,blocked:true,recovery:'Inspect the retained step and provider resources. Corrective writes need a new reviewed plan; successful steps will not be resubmitted.'};
  if(next.status==='processing'){
   const status=await this.call('amcp_media',{action:'status',review_id:next.review_id},actor);if(!status.success){next.error=status.error;next.status='failed';run.state='attention';return this.save(actor,run);}next.result=status.data;
   if(!status.data.ready&&!(status.data.processing_status==='succeeded'&&run.steps.some((s:JsonObject)=>s.kind==='media'&&s.arguments.action==='prepare_library'&&s.depends_on.includes(next.id))))return {...run,next_call:status.data.next_call,blocked_by:'media_processing'};next.status='verified';run=this.save(actor,run);return {...run,next_call:{tool:'amcp_campaign',arguments:{action:'prepare_next',id:run.id}}};
  }
  if(next.status==='verifying'){
   const v=await this.verifyWrite(actor,next.review_id);next.verification=v;next.status=v.status==='verified'?'verified':v.status==='mismatch'?'mismatch':'verifying';run.state=run.steps.every((s:JsonObject)=>s.status==='verified')?'complete':next.status==='verified'?'in_progress':'attention';return this.save(actor,run);
  }
  if(input.action==='prepare_next'){
   if(next.status==='executing')return {campaign_id:run.id,step_id:next.id,recovery:'Resume the original execution with the same idempotency key.',next_call:{tool:'amcp_campaign',arguments:{action:'execute_next',id:run.id,review_id:next.review_id,idempotency_key:next.review_id,confirmed:true}}};
   if(next.status==='review_ready'&&Date.parse(next.review.expires_at)>Date.now())return {campaign_id:run.id,step_id:next.id,review:next.review,next_call:{tool:'amcp_campaign',arguments:{action:'execute_next',id:run.id,review_id:next.review_id,idempotency_key:next.review_id,confirmed:true}}};
   if(next.depends_on.some((id:string)=>!['verified','complete'].includes(run.steps.find((s:JsonObject)=>s.id===id).status)))bad('Wait for predecessor verification.','DEPENDENCY_PENDING');
   const results=new Map<string,JsonObject>(run.steps.filter((s:JsonObject)=>s.status==='verified').map((s:JsonObject)=>[s.id,s.result]));
   const resolved=references(next.arguments,results,new Set(next.depends_on));let prepared:JsonObject;
   if(next.kind==='media')prepared=await this.call('amcp_media',resolved.action==='prepare_library'?{action:'prepare_library',review_id:resolved.review_id}:{...resolved,action:'prepare',account_id:next.account_id,connection_id:next.connection_id},actor);
   else{if(resolved.operation)resolved.arguments={...resolved.arguments,account_id:next.account_id,connection_id:next.connection_id};else Object.assign(resolved,{account_id:next.account_id,connection_id:next.connection_id});prepared=await this.call('amcp_write',{action:'prepare',gateway:next.gateway,connection_id:next.connection_id,arguments:resolved},actor);}
   if(!prepared.success)return {...run,blocked:true,error:prepared.error};const review=prepared.data;if(review.reused===true){next.result=review;next.status='verified';run.state=run.steps.every((s:JsonObject)=>s.status==='verified')?'complete':'in_progress';return this.save(actor,run);}next.review_id=review.review_id;next.review=review;next.resolved=resolved;next.status='review_ready';run.state='awaiting_review';run=this.save(actor,run);return {campaign_id:run.id,step_id:next.id,review,revision:run.revision,next_call:{tool:'amcp_campaign',arguments:{action:'execute_next',id:run.id,review_id:review.review_id,idempotency_key:review.idempotency_key,confirmed:true,spend_change_confirmed:true}}};
  }
  if(input.action!=='execute_next')bad('Unknown campaign action.');
  if(next.status!=='review_ready'&&next.status!=='executing'||input.review_id!==next.review_id||input.idempotency_key!==next.review_id||input.confirmed!==true)bad('Execute the exact returned review with confirmation.');
  // Persist the review reference before egress. A crash resumes with the same native idempotency key.
  next.status='executing';run.state='in_progress';run=this.save(actor,run);const step=run.steps.find((s:JsonObject)=>s.id===next.id)!;
  const result=await this.call('amcp_write',{action:'execute',review_id:step.review_id,idempotency_key:step.review_id,confirmed:true,...(step.kind==='write'?{spend_change_confirmed:input.spend_change_confirmed}: {})},actor);
  this.store.assertActorActive(actor);if(!result.success){step.error=result.error;step.status=['WRITE_OUTCOME_UNCERTAIN','WRITE_PARTIAL_OR_FAILED','UPSTREAM_RESPONSE_INVALID'].includes(result.error?.code)?'uncertain':result.error?.code==='SPEND_CONFIRMATION_REQUIRED'?'review_ready':'failed';run.state='attention';return this.save(actor,run);}
  step.result=result.data;step.status=step.kind==='media'?(result.data.ready?'verified':'processing'):'verifying';
  if(step.kind==='write'){step.verification=await this.verifyWrite(actor,step.review_id);step.status=step.verification.status==='verified'?'verified':step.verification.status==='mismatch'?'mismatch':'verifying';}
  run.state=run.steps.every((s:JsonObject)=>s.status==='verified')?'complete':step.status==='verified'?'in_progress':'attention';run=this.save(actor,run);return {...run,next_call:run.state==='complete'?null:{tool:'amcp_campaign',arguments:{action:'prepare_next',id:run.id}},receipt:{verified:run.steps.filter((s:JsonObject)=>s.status==='verified').map((s:JsonObject)=>s.id),remaining:run.steps.filter((s:JsonObject)=>s.status!=='verified').map((s:JsonObject)=>({id:s.id,status:s.status}))}};
 }
}
