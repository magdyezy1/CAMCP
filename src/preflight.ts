import type {Actor,CompiledRequest,JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {googleTargetingKind} from './google-targeting-writes.js';
import {googleAssetLinkKind} from './google-asset-links.js';
import {microsoftAssociationWrite} from './microsoft-associations.js';
import {xPromotion} from './x-creative-writes.js';
export interface ExecutionPolicy {allowWrites:boolean;maxBudgetChange:number;requireBeforeState:boolean}
export const readOnlyPolicy:ExecutionPolicy={allowWrites:false,maxBudgetChange:0,requireBeforeState:true};
export function authorizeExecution(actor:Actor,plan:CompiledRequest,input:JsonObject,policy:ExecutionPolicy,verifiedBeforeState=false):void{
 if(plan.readOnly)return;
 if(!policy.allowWrites)throw new MirrorError('LIVE_WRITES_DISABLED','This deployment permits reads and dry-run previews only.',{},403);
 if(actor.role==='reader')throw new MirrorError('FORBIDDEN','Reader role cannot execute platform writes.',{},403);
 if(input.dry_run!==false)throw new MirrorError('DRY_RUN_REQUIRED','Live execution must explicitly set dry_run=false.');
 if(input.confirmed!==true)throw new MirrorError('CONFIRMATION_REQUIRED','Live writes require confirmed=true under production policy.');
 if(typeof input.idempotency_key!=='string'||!input.idempotency_key.trim())throw new MirrorError('IDEMPOTENCY_REQUIRED','Live writes require an idempotency_key.');
 if(policy.requireBeforeState&&!verifiedBeforeState)throw new MirrorError('WRITE_REVIEW_REQUIRED','Use amcp_write prepare and execute; caller-supplied before_state is not a verified snapshot.');
 if(xPromotion(plan)&&input.spend_change_confirmed!==true)throw new MirrorError('SPEND_CONFIRMATION_REQUIRED','X promotion may serve immediately. Review the parent delivery state and provide spend_change_confirmed=true.');
 if((googleAssetLinkKind(plan)||microsoftAssociationWrite(plan))&&input.spend_change_confirmed!==true)throw new MirrorError('SPEND_CONFIRMATION_REQUIRED','Asset associations change which creative can serve. Review the parent state and provide spend_change_confirmed=true.');
 if((googleTargetingKind(plan)||plan.gateway==='reddit_native_action')&&input.spend_change_confirmed!==true)throw new MirrorError('SPEND_CONFIRMATION_REQUIRED','Targeting, serving and shared-list changes require spend_change_confirmed=true.');
 const statusPatch=Array.isArray(plan.body)&&plan.body.some(op=>op&&/\/(status|intendedStatus|intended_status|entity_status|operation_status)$/.test(String(op.path))&&['ACTIVE','ENABLE','ENABLED'].includes(op.value));
 if((statusPatch||/budget|bid|spend|"(?:status|intendedStatus|intended_status|entity_status|entityStatus|operation_status)"\s*:\s*"(?:ACTIVE|ENABLE|ENABLED|ENTITY_STATUS_ACTIVE)"/i.test(JSON.stringify({query:plan.query,body:plan.body})))&&input.spend_change_confirmed!==true)throw new MirrorError('SPEND_CONFIRMATION_REQUIRED','Spend-affecting writes need spend_change_confirmed=true.');
}
