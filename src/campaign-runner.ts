import {recipeContext,recipeInputs} from './recipe-context.js';
import {assertAccountWrite} from './write-access.js';
import {normalizeAccount} from './scope.js';
import {campaignRecipe,campaignRecipes} from './campaign-recipes.js';
import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import type {Actor,JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {audit,bad,field,fingerprint,noSecrets,obj,optional,pointer,read,tool,validate,writer,type ToolCall} from './workspace-core.js';
export const campaignTool=tool('amcp_campaign','Create a durable campaign dependency plan from a brief and explicit native steps. Apply approved profiles/templates. prepare_next resolves only verified predecessor outputs and returns the existing native review; execute_next consumes that exact review, automatically reads back the result, and resumes without duplicate writes. No fabricated IDs, implicit launch, or review bypass.', ['create','get','list','prepare_next','execute_next','verify','cancel','validate_provider','preflight','recover_step','reconcile_step','recipes','recipe_context','recipe_lookup','preview_recipe','create_from_recipe'],{id:field.id,name:field.id,brief:field.id,profile_id:field.id,template:field.id,variables:field.object,steps:{type:'array',items:{type:'object'},minItems:1,maxItems:50},review_id:field.id,idempotency_key:field.id,confirmed:field.bool,spend_change_confirmed:field.bool,expected_revision:field.integer,query:field.id,lookup_kind:{type:'string',enum:['country','language']},account_id:field.id,recipe:field.id,business:field.object,step_id:field.id,gateway:field.id,arguments:field.object,connection_id:field.id});
function substitute(v:any,variables:JsonObject):any{
 if(typeof v==='string')return v.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g,(_,key)=>{const value=pointer(variables,'/'+key.split('.').join('/'));if(typeof value!=='string'&&typeof value!=='number')bad('Template variables must be scalar.');return String(value);});
 if(Array.isArray(v))return v.map(x=>substitute(x,variables));return obj(v)?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,substitute(x,variables)])):v;
}
function references(v:any,results:Map<string,JsonObject>,deps:Set<string>):any{
 if(obj(v)&&Object.hasOwn(v,'$ref')){if(Object.keys(v).length!==1||typeof v.$ref!=='string')bad('Use {$ref:"step#/JSON/pointer"}.');const at=v.$ref.indexOf('#'),id=v.$ref.slice(0,at),path=v.$ref.slice(at+1);if(at<1||!deps.has(id))bad('A result reference must name a declared predecessor.');const result=results.get(id);if(!result)bad('The referenced step is not verified.','DEPENDENCY_PENDING');return structuredClone(pointer(result,path));}
 if(Array.isArray(v))return v.map(x=>references(x,results,deps));return obj(v)?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,references(x,results,deps)])):v;
}
const structure=(steps:JsonObject[])=>steps.map(s=>Object.fromEntries(['id','kind','gateway','connection_id','account_id','arguments','depends_on','description','expected_currency'].filter(k=>s[k]!==undefined).map(k=>[k,s[k]])));
const verificationStepStatus=(status:string)=>['verified','failed','mismatch'].includes(status)?status:'verifying';
/** While an earlier step only awaits read-back, the first step whose declared predecessors are all verified.
 * Failed, uncertain, mismatched or processing steps still stop the whole plan. */
function independentStep(run:JsonObject):string|undefined{
 if(run.steps.some((s:JsonObject)=>['uncertain','failed','mismatch','processing'].includes(s.status)))return undefined;
 const done=new Set(run.steps.filter((s:JsonObject)=>['verified','complete'].includes(s.status)).map((s:JsonObject)=>s.id));
 for(const status of ['executing','review_ready','pending']){const step=run.steps.find((s:JsonObject)=>s.status===status&&s.depends_on.every((d:string)=>done.has(d)));if(step)return step.id;}
 return undefined;
}
export class CampaignRunner{
 constructor(private store:Store,private call:ToolCall,private verifyWrite:(actor:Actor,id:string)=>Promise<JsonObject>,private providerValidation:(actor:Actor,input:JsonObject)=>Promise<JsonObject>,private preflight?:(actor:Actor,steps:JsonObject[])=>Promise<JsonObject>,private acceptsAccountId:(gateway:string,operation?:string)=>boolean=()=>true){}
 private owned(actor:Actor,id:string){const p=read(this.store,actor,'campaign_run',id);if(p.user_id!==actor.userId&&actor.role!=='admin')bad('Campaign plan belongs to another actor.','FORBIDDEN');if(p.plan_hash!==fingerprint(structure(p.steps)))bad('The saved plan failed its integrity check.','PLAN_CHANGED');return p;}
 private save(actor:Actor,run:JsonObject){const {id,revision,...data}=run;this.store.putDocument(actor.tenantId,'campaign_run',id,{...data,updated_at:Date.now()},revision);return this.owned(actor,id);}
 async handle(input:JsonObject,actor:Actor):Promise<JsonObject>{
  validate(input,Object.keys(campaignTool.inputSchema.properties),524288);this.store.assertActorActive(actor);
  if(input.action==='recipes')return {recipes:campaignRecipes};
  if(input.action==='recipe_lookup'){
   const query=String(input.query??'').trim();if(!/^[A-Za-z -]{2,60}$/.test(query)||!['country','language'].includes(input.lookup_kind))throw new MirrorError('INVALID_LOOKUP','Enter a country name/code or language name (2–60 letters).');
   this.store.resolveConnection(actor,'google_ads_native_action',input.account_id,input.connection_id);
   const country=input.lookup_kind==='country',gaql=country?"SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.country_code FROM geo_target_constant WHERE geo_target_constant.target_type = 'Country' AND "+(query.length===2?"geo_target_constant.country_code = '"+query.toUpperCase()+"'":"geo_target_constant.name LIKE '%"+query+"%'")+" LIMIT 100":"SELECT language_constant.id, language_constant.name, language_constant.code FROM language_constant LIMIT 1000";
   const out=await this.call('google_ads_native_action',{action:'google_ads_v23_google_ads_search',connection_id:input.connection_id,account_id:input.account_id,payload:{query:gaql}},actor);
   if(!out.success)throw new MirrorError(out.error.code,out.error.message,out.error.details);if(out.data.truncated)throw new MirrorError('INCOMPLETE_LOOKUP','This lookup is incomplete. Narrow the search.');
   const rows=out.data.data?.results;if(!Array.isArray(rows))throw new MirrorError('UPSTREAM_RESPONSE_INVALID','Google did not return targeting constants.');return {kind:input.lookup_kind,results:rows.map((r:JsonObject)=>country?r.geoTargetConstant:r.languageConstant).filter((r:JsonObject)=>r&&typeof r.id==='string'&&(country||String(r.name??'').toLowerCase().includes(query.toLowerCase())||String(r.code??'').toLowerCase()===query.toLowerCase())).slice(0,50).map((r:JsonObject)=>({id:r.id,name:r.name,code:r.code??r.countryCode})),provider_mutations:0};
  }
  if(input.action==='recipe_context')return recipeContext(this.store,actor,input.recipe,input.profile_id);
  if(['preview_recipe','create_from_recipe'].includes(input.action)){
   const context=recipeContext(this.store,actor,input.recipe,input.profile_id),{business,provenance}=recipeInputs(context,input.business??{});
   const missing=context.recipe.required.filter((k:string)=>business[k]===undefined||business[k]==='');
   if(input.action==='preview_recipe'&&missing.length)return {ready:false,missing_fields:missing,provenance,provider_mutations:0};
   const {recipe,...plan}=campaignRecipe(input.recipe,business);if(input.action==='preview_recipe')return {ready:true,plan,recipe,provenance,provider_mutations:0,meaning:'Local compilation. Run preflight before preparing mutations.'};
   writer(this.store,actor);const result=await this.handle({...plan,...(input.profile_id?{profile_id:input.profile_id}:{})},actor),run=this.owned(actor,result.id);run.recipe={...recipe,provenance};return this.save(actor,run);
  }
  if(input.action==='verify')return this.verifyWrite(actor,input.review_id);
  if(input.action==='validate_provider')return this.providerValidation(actor,input);
  if(input.action==='list')return {campaigns:this.store.documents(actor.tenantId,'campaign_run').filter(r=>r.user_id===actor.userId||actor.role==='admin').map(r=>({id:r.id,name:r.name,state:r.state,updated_at:r.updated_at,step_count:r.steps.length}))};
  if(input.action==='get'){const run=this.owned(actor,input.id);return {...run,execution_journal:run.steps.filter((s:JsonObject)=>s.review_id).map((s:JsonObject)=>({step_id:s.id,status:s.status,review_id:s.review_id,...this.store.operationJournal(actor.tenantId,s.review_id)}))};}
  writer(this.store,actor);
  if(input.action==='create'){
   if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100||typeof input.brief!=='string'||input.brief.length>12000)bad('Provide a campaign name and brief.');
   const profile=input.profile_id?read(this.store,actor,'client_profile',input.profile_id):undefined,variables={...(profile?.variables??{}),...(input.variables??{}),profile:profile??{}};noSecrets(variables);
   const raw=input.steps??profile?.templates?.[input.template];if(!Array.isArray(raw)||!raw.length||raw.length>50)bad('Provide 1–50 explicit steps, or choose an approved saved template.');const steps=substitute(raw,variables),seen=new Set<string>();
   for(const s of steps){validate(s,['id','kind','gateway','connection_id','account_id','arguments','depends_on','description','expected_currency']);const problems=[!/^[A-Za-z][A-Za-z0-9_-]{0,50}$/.test(s.id)&&'id must start with a letter (up to 51 letters, digits, _ or -)',seen.has(s.id)&&'id must be unique',!['write','media'].includes(s.kind)&&'kind must be "write" or "media"',s.kind==='write'&&typeof s.gateway!=='string'&&'a write step needs gateway, e.g. "snapchat_native_action"',!obj(s.arguments)&&'arguments must be the native tool input object',typeof s.connection_id!=='string'&&'connection_id is required',typeof s.account_id!=='string'&&'account_id is required',s.expected_currency!==undefined&&!/^[A-Z]{3}$/.test(s.expected_currency)&&'expected_currency must be an ISO code such as "USD", or omitted'].filter(Boolean);
     if(problems.length)bad('Step '+JSON.stringify(String(s.id??''))+': '+problems.join('; ')+'. Each step is {"id","kind":"write","gateway","connection_id","account_id","arguments":{"action","payload"},"depends_on":[earlier ids]}; later steps use results as {"$ref":"<step id>#/data/<JSON pointer>"}.');
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
  if(input.action==='reconcile_step'){
   const step=run.steps.find((s:JsonObject)=>s.id===input.step_id);if(!step?.review_id||!['executing','uncertain','failed','verifying','mismatch','processing'].includes(step.status))bad('Choose a submitted step requiring reconciliation.','RECOVERY_NOT_SAFE');
   const claim=this.store.db.prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?').get(actor.tenantId,step.review_id) as JsonObject|undefined;if(claim?.state!=='complete'||!claim.result)bad('No completed original receipt exists. Inspect provider state; reconciliation never submits a mutation.','RECOVERY_NOT_SAFE');
   const receipt=JSON.parse(claim.result);if(step.kind==='media'){const status=await this.call('amcp_media',{action:'status',review_id:step.review_id},actor);if(!status.success)throw new MirrorError(status.error.code,status.error.message,status.error.details);step.result={...receipt,...status.data};step.status=status.data.ready?'verified':'processing';}else{const verification=await this.verifyWrite(actor,step.review_id);step.result=receipt;step.verification=verification;step.status=verificationStepStatus(verification.status);if(step.status==='verified'&&verification.verified_resources)step.result={...step.result,verified_resources:verification.verified_resources};}
   this.store.assertActorActive(actor);delete step.error;run.state=run.steps.every((s:JsonObject)=>s.status==='verified')?'complete':step.status==='verified'?'in_progress':'attention';return this.save(actor,run);
  }
  if(input.action==='recover_step'){
   if(input.confirmed!==true)bad('Confirm recovery of the failed step.');const step=run.steps.find((s:JsonObject)=>s.id===input.step_id),blockedBeforeSubmission=step?.status==='pending'&&run.preflight?.checks?.some((c:JsonObject)=>c.step===step.id&&c.status==='blocked');if(!step||step.status!=='failed'&&!blockedBeforeSubmission)bad('Only a definitively failed or unsubmitted blocked step can be recovered. Unknown, verifying and mismatched outcomes require investigation.','RECOVERY_NOT_SAFE');
   const submitted=step.review_id?this.store.db.prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?').get(actor.tenantId,step.review_id) as JsonObject|undefined:undefined;if(submitted)bad('This step reached the provider or has an unknown outcome. Reconcile its existing resource; do not issue another create.','RECOVERY_NOT_SAFE');
   if(run.steps.some((s:JsonObject)=>s.depends_on.includes(step.id)&&s.status!=='pending'))bad('A dependent step has already progressed.');if(input.arguments){noSecrets(input.arguments);step.arguments=input.arguments;}step.previous_attempts=[...(step.previous_attempts??[]),{review_id:step.review_id,error:step.error,at:Date.now()}];for(const k of ['review','review_id','resolved','error','result','verification','submission'])delete step[k];step.status='pending';run.state='draft';run.plan_hash=fingerprint(structure(run.steps));delete run.preflight;return this.save(actor,run);
  }
  if(['prepare_next','execute_next'].includes(input.action))for(const s of run.steps.filter((s:JsonObject)=>!['verified','complete'].includes(s.status))){const gateway=s.kind==='media'?s.arguments.platform+'_native_action':s.gateway,c=this.store.resolveConnection(actor,gateway,s.account_id,s.connection_id);assertAccountWrite(this.store,c,normalizeAccount(gateway,s.account_id));}
  if(run.preflight?.status==='blocked'&&input.action!=='preflight')return {...run,blocked:true,missing_requirements:run.preflight.checks.filter((c:JsonObject)=>c.status==='blocked')};
  if(this.preflight&&(input.action==='preflight'||input.action==='prepare_next'&&!run.preflight)){
   run.preflight=await this.preflight(actor,run.steps);run=this.save(actor,run);if(input.action==='preflight'||run.preflight.status==='blocked')return {...run,blocked:run.preflight.status==='blocked',missing_requirements:run.preflight.checks.filter((c:JsonObject)=>c.status==='blocked')};
  }
  let next=run.steps.find((s:JsonObject)=>!['verified','complete'].includes(s.status));if(!next)return {...run,state:'complete'};
  if(['uncertain','failed','mismatch'].includes(next.status))return {...run,blocked:true,recovery:'Inspect the retained step and provider resources. Corrective writes need a new reviewed plan; successful steps will not be resubmitted.'};
  if(next.status==='processing'){
   const status=await this.call('amcp_media',{action:'status',review_id:next.review_id},actor);if(!status.success){next.error=status.error;next.status='failed';run.state='attention';return this.save(actor,run);}next.result=status.data;
   if(!status.data.ready&&!(status.data.processing_status==='succeeded'&&run.steps.some((s:JsonObject)=>s.kind==='media'&&s.arguments.action==='prepare_library'&&s.depends_on.includes(next.id))))return {...run,next_call:status.data.next_call,blocked_by:'media_processing'};next.status='verified';run=this.save(actor,run);return {...run,next_call:{tool:'amcp_campaign',arguments:{action:'prepare_next',id:run.id}}};
  }
  if(next.status==='verifying'){
   const v=await this.verifyWrite(actor,next.review_id);next.verification=v;next.status=verificationStepStatus(v.status);if(next.status==='verified'&&v.verified_resources)next.result={...next.result,verified_resources:v.verified_resources};run.state=run.steps.every((s:JsonObject)=>s.status==='verified')?'complete':next.status==='verified'?'in_progress':'attention';
   // A read-back that is still inconclusive or pending must not stall steps that do not depend on it.
   const other=next.status==='verifying'?independentStep(run):undefined;if(!other)return this.save(actor,run);
   run=this.save(actor,run);next=run.steps.find((s:JsonObject)=>s.id===other)!;
  }
  if(input.action==='prepare_next'){
   if(next.status==='executing')return {campaign_id:run.id,step_id:next.id,recovery:'Resume the original execution with the same idempotency key.',next_call:{tool:'amcp_campaign',arguments:{action:'execute_next',id:run.id,review_id:next.review_id,idempotency_key:next.review_id,confirmed:true}}};
   if(next.status==='review_ready'&&Date.parse(next.review.expires_at)>Date.now())return {campaign_id:run.id,step_id:next.id,review:next.review,next_call:{tool:'amcp_campaign',arguments:{action:'execute_next',id:run.id,review_id:next.review_id,idempotency_key:next.review_id,confirmed:true}}};
   if(next.depends_on.some((id:string)=>!['verified','complete'].includes(run.steps.find((s:JsonObject)=>s.id===id).status)))bad('Wait for predecessor verification.','DEPENDENCY_PENDING');
   const results=new Map<string,JsonObject>(run.steps.filter((s:JsonObject)=>s.status==='verified').map((s:JsonObject)=>[s.id,s.result]));
   const resolved=references(next.arguments,results,new Set(next.depends_on));let prepared:JsonObject;
   if(next.kind==='media')prepared=await this.call('amcp_media',resolved.action==='prepare_library'?{action:'prepare_library',review_id:resolved.review_id}:{...resolved,action:'prepare',account_id:next.account_id,connection_id:next.connection_id},actor);
   else{
    // DV360, Amazon and many delegated operations name the account with their own key and forbid account_id.
    if(this.acceptsAccountId(next.gateway,resolved.operation)){if(resolved.operation)resolved.arguments={...resolved.arguments,account_id:next.account_id};else Object.assign(resolved,{account_id:next.account_id});}prepared=await this.call('amcp_write',{action:'prepare',gateway:next.gateway,connection_id:next.connection_id,arguments:resolved},actor);}
   if(!prepared.success){next.status='failed';next.error=prepared.error;next.submission='not_submitted';run.state='attention';return {...this.save(actor,run),blocked:true,error:prepared.error,next_call:{tool:'amcp_campaign',arguments:{action:'recover_step',id:run.id,step_id:next.id,confirmed:true}}};}const review=prepared.data;if(review.reused===true){next.result=review;next.status='verified';run.state=run.steps.every((s:JsonObject)=>s.status==='verified')?'complete':'in_progress';return this.save(actor,run);}next.review_id=review.review_id;next.review=review;next.resolved=resolved;next.status='review_ready';run.state='awaiting_review';run=this.save(actor,run);// spend_change_confirmed is never pre-filled: execute_requirements says whether this step needs it, and the flag is the
   // user's acknowledgement of the reviewed spending effect, not a value to copy from a suggested call.
   return {campaign_id:run.id,step_id:next.id,review,revision:run.revision,execute_requirements:review.execute_requirements,next_call:{tool:'amcp_campaign',arguments:{action:'execute_next',id:run.id,review_id:review.review_id,idempotency_key:review.idempotency_key,confirmed:true},...(review.execute_requirements?.spend_change_confirmed===true?{add_after_user_approval:{spend_change_confirmed:true}}:{})}};
  }
  if(input.action!=='execute_next')bad('Unknown campaign action.');
  if(next.status!=='review_ready'&&next.status!=='executing'||input.review_id!==next.review_id||(input.idempotency_key??next.review_id)!==next.review_id||input.confirmed!==true)bad('Execute the exact returned review with confirmation.');
  // Persist the review reference before egress. A crash resumes with the same native idempotency key.
  next.status='executing';run.state='in_progress';run=this.save(actor,run);const step=run.steps.find((s:JsonObject)=>s.id===next.id)!;
  const result=await this.call('amcp_write',{action:'execute',review_id:step.review_id,idempotency_key:step.review_id,confirmed:true,...(step.kind==='write'?{spend_change_confirmed:input.spend_change_confirmed}: {})},actor);
  this.store.assertActorActive(actor);if(!result.success){step.error=result.error;// An expired review was refused before its idempotency claim, so nothing was submitted: prepare_next prepares it again.
   step.status=['WRITE_OUTCOME_UNCERTAIN','WRITE_PARTIAL_OR_FAILED','UPSTREAM_RESPONSE_INVALID'].includes(result.error?.code)?'uncertain':result.error?.code==='SPEND_CONFIRMATION_REQUIRED'?'review_ready':result.error?.code==='REVIEW_EXPIRED'?'pending':'failed';run.state='attention';return this.save(actor,run);}
  step.result=result.data;step.status=step.kind==='media'?(result.data.ready?'verified':'processing'):'verifying';
  if(step.kind==='write'){step.verification=await this.verifyWrite(actor,step.review_id);step.status=verificationStepStatus(step.verification.status);if(step.status==='verified'&&step.verification.verified_resources)step.result={...step.result,verified_resources:step.verification.verified_resources};}
  run.state=run.steps.every((s:JsonObject)=>s.status==='verified')?'complete':step.status==='verified'?'in_progress':'attention';run=this.save(actor,run);return {...run,next_call:run.state==='complete'?null:{tool:'amcp_campaign',arguments:{action:'prepare_next',id:run.id}},receipt:{verified:run.steps.filter((s:JsonObject)=>s.status==='verified').map((s:JsonObject)=>s.id),remaining:run.steps.filter((s:JsonObject)=>s.status!=='verified').map((s:JsonObject)=>({id:s.id,status:s.status}))}};
 }
}
