import type {Actor,CompiledRequest,JsonObject} from './types.js';
import type {MirrorService} from './service.js';
import {MirrorError} from './errors.js';
import {applyExecutionRisk} from './execution-risk.js';
import {guardInput} from './security.js';

export interface ReadProbe {gateway:string;arguments:JsonObject}
export interface PreparedReadProbe {gateway:string;plan:CompiledRequest;input:JsonObject}
export function prepareReadProbes(service:MirrorService,probes:unknown):PreparedReadProbe[]{
 guardInput(probes);
 if(!Array.isArray(probes)||probes.length===0||probes.length>50)throw new MirrorError('INVALID_PROBES','Provide 1 to 50 explicit native read probes.');
 return probes.map((probe:ReadProbe)=>{
  if(!probe||typeof probe.gateway!=='string'||!probe.arguments||typeof probe.arguments!=='object'||Array.isArray(probe.arguments))throw new MirrorError('INVALID_PROBES','Each probe requires gateway and arguments.');
  const definition=service.registry.tools.get(probe.gateway);if(!definition||probe.gateway==='amcp_tool_help'||probe.gateway==='amcp_platform_workspace')throw new MirrorError('INVALID_PROBES','Probes must name native platform gateways.');
  service.registry.validate(probe.gateway,probe.arguments,service.options);
  const delegated=definition.mode==='delegated';
  const plan=applyExecutionRisk(delegated?service.delegatedCompiler.compile(probe.gateway,probe.arguments):service.compiler.compile(probe.gateway,probe.arguments,service.options));
  if(!plan.readOnly||!plan.accountId)throw new MirrorError('READ_PROBE_FORBIDDEN','Every probe must be an independently classified read with an explicit account binding.');
  const input=structuredClone(delegated?probe.arguments.arguments:probe.arguments);
  return {gateway:probe.gateway,plan,input};
 });
}

export async function verifyReads(service:MirrorService,probes:PreparedReadProbe[],actor:Actor,live=false):Promise<JsonObject>{
 // Validate the complete batch before any request, including prepared plans passed
 // by an embedding caller. Central service scope checks still run on execution.
 if(actor.role!=='reader')throw new MirrorError('READER_REQUIRED','Read verification runs with a reader actor.');
 if(probes.some(p=>!applyExecutionRisk(p.plan).readOnly||!p.plan.accountId))throw new MirrorError('READ_PROBE_FORBIDDEN','A prepared probe is not an explicit account-scoped read.');
 const results=[];
 for(const probe of probes){
  const started=Date.now();
  try{
   const result=await service.runPlan(probe.plan,{...probe.input,dry_run:!live,aggregate_pages:false,paginate:false,allPages:false},actor) as JsonObject;
   results.push({gateway:probe.gateway,action:probe.plan.action,account_id:probe.plan.accountId,success:result.success===true,executed:live,latency_ms:Date.now()-started,...(!live?{request:result.request}:{pages:result.pages})});
  }catch(e){results.push({gateway:probe.gateway,action:probe.plan.action,account_id:probe.plan.accountId,success:false,executed:live?null:false,latency_ms:Date.now()-started,error:e instanceof MirrorError?{code:e.code,message:e.message}:{code:'VERIFICATION_FAILED',message:'Read verification failed.'}});}
 }
 return {mode:live?'live_mirror_read':'local_preview',production_ready:false,success:results.every(r=>r.success),results};
}
