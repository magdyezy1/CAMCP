import {nativeAuthority} from './native-authority.js';
import {MirrorService} from './service.js';
import {MirrorError} from './errors.js';
import {ScopeGuard} from './scope.js';
import {assertWriteShape} from './write-review.js';
import {audit,fingerprint,validate,writer} from './workspace-core.js';
import type {Actor,JsonObject} from './types.js';
// Native validate_only is a distinct provider operation. It does not create a review or permit execute.
export async function validateProviderRequest(service:MirrorService,actor:Actor,input:JsonObject):Promise<JsonObject>{
 writer(service.store,actor);
 if(input.gateway!=='google_ads_native_action')return {status:'unsupported',executed:false,reason:'Only reviewed Google Ads mutate contracts have a qualified provider validation path.'};
 const args=input.arguments;validate(args??{},Object.keys(service.registry.tools.get(input.gateway)!.inputSchema.properties??{}));
 service.registry.validate(input.gateway,args,service.options);const plan=service.compiler.compile(input.gateway,args,service.options);assertWriteShape(plan);
 if(plan.method!=='POST'||!/^\/v23\/customers\/\d+\/[A-Za-z]+:mutate$/.test(plan.path))throw new MirrorError('PROVIDER_VALIDATION_UNSUPPORTED','Select a supported Google Ads mutate request.');
 const c=service.store.resolveConnection(actor,plan.gateway,plan.accountId,input.connection_id??args.connection_id);new ScopeGuard(service.registry,service.store).authorize(plan,c);
 const body:JsonObject={...(plan.body as JsonObject),validate_only:true};delete body.validateOnly;
 const request={...plan,body},auth=await service.credentials.get(c);service.store.assertActorActive(actor);const current=service.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);
 const access=nativeAuthority(service.store,service.registry,actor,request,current,auth);const response=await service.transport.request(request,access(),auth,undefined,{beforeAttempt:access});access();service.store.assertActorActive(actor);service.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);
 if(response.status>=300||(response.data as JsonObject)?.error||(response.data as JsonObject)?.partialFailureError)throw new MirrorError('PROVIDER_VALIDATION_FAILED','Provider rejected validation.',{response:response.data});
 const receipt={status:'provider_validated',gateway:plan.gateway,account_id:plan.accountId,connection_id:c.id,action:plan.action,request_hash:fingerprint(plan),checked_at:Date.now(),executed:false,objects_created:false,limitation:'Provider validation does not prove a subsequent write will succeed. Prepare and review again before execution.'};
 service.store.putDocument(actor.tenantId,'provider_validation',receipt.request_hash,receipt);audit(service.store,actor,'provider_validated',receipt);return receipt;
}
