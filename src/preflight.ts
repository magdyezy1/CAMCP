import type {Actor,CompiledRequest,JsonObject} from './types.js';
import {MirrorError} from './errors.js';
export interface ExecutionPolicy {allowWrites:boolean;maxBudgetChange:number;requireBeforeState:boolean}
export const readOnlyPolicy:ExecutionPolicy={allowWrites:false,maxBudgetChange:0,requireBeforeState:true};
export function authorizeExecution(actor:Actor,plan:CompiledRequest,input:JsonObject,policy:ExecutionPolicy):void{
 if(plan.readOnly)return;
 if(!policy.allowWrites)throw new MirrorError('LIVE_WRITES_DISABLED','This deployment permits reads and dry-run previews only.',{},403);
 if(actor.role==='reader')throw new MirrorError('FORBIDDEN','Reader role cannot execute platform writes.',{},403);
 if(input.dry_run!==false)throw new MirrorError('DRY_RUN_REQUIRED','Live execution must explicitly set dry_run=false.');
 if(input.confirmed!==true)throw new MirrorError('CONFIRMATION_REQUIRED','Live writes require confirmed=true under production policy.');
 if(typeof input.idempotency_key!=='string'||!input.idempotency_key.trim())throw new MirrorError('IDEMPOTENCY_REQUIRED','Live writes require an idempotency_key.');
 if(policy.requireBeforeState&&input.before_state===undefined)throw new MirrorError('BEFORE_STATE_REQUIRED','A verified before-state must be recorded before executing a mutation.');
 if(/create|_post$/.test(plan.action)&&plan.body){
  const encoded=JSON.stringify(plan.body);if(/"(?:status|operation_status)"\s*:\s*"(?:ACTIVE|ENABLE|ENABLED)"/i.test(encoded))throw new MirrorError('PAUSED_CREATION_REQUIRED','New advertising objects must be created paused.');
 }
 if(/budget|bid|spend/.test(JSON.stringify(plan.body??{}).toLowerCase())&&input.spend_change_confirmed!==true)throw new MirrorError('SPEND_CONFIRMATION_REQUIRED','Spend-affecting writes need spend_change_confirmed=true.');
}
