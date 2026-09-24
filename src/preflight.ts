import {metaReportKind} from './meta-insights-jobs.js';
import {criteoReportKind} from './criteo-report-jobs.js';
import {placeActionKind} from './google-place-action-links.js';
import {businessNotificationKind} from './google-business-notifications.js';
import {businessAccessKind} from './google-business-access.js';
import {googleDismissalKind} from './google-recommendation-dismissal.js';
import {googleAccessKind} from './google-user-access.js';
import {keywordPlanKind} from './google-keyword-plan-writes.js';
import {linkedinConversionKind} from './linkedin-conversion-links.js';
import {linkedinRuleServing} from './linkedin-conversion-rules.js';
import {criteoTargetingKind} from './criteo-targeting-writes.js';
import type {Actor,CompiledRequest,JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {googleTargetingKind} from './google-targeting-writes.js';
import {googleAssetLinkKind} from './google-asset-links.js';
import {googleConfigurationServing} from './google-configuration-writes.js';
import {googleSegmentKind} from './google-custom-segments.js';
import {googleConversionGoalKind,googleConversionGoalServing} from './google-conversion-goals.js';
import {googleBiddingEventKind} from './google-bidding-events.js';
import {googlePortfolioKind,googlePortfolioServing} from './google-portfolio-strategies.js';
import {xDraftKind} from './x-draft-writes.js';
import {appleEntityServing} from './apple-entity-writes.js';
import {dv360ListAffectsServing} from './dv360-list-writes.js';
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
 if(linkedinConversionKind(plan)&&input.spend_change_confirmed!==true)throw new MirrorError('SPEND_CONFIRMATION_REQUIRED','Campaign conversion associations can affect optimization. Review the selected campaigns and conversion rules and confirm the spending impact.');
 if(linkedinRuleServing(plan)&&input.spend_change_confirmed!==true)throw new MirrorError('SPEND_CONFIRMATION_REQUIRED','Conversion-rule enablement, attribution and matching can affect optimization. Review every associated campaign and confirm this impact.');
 if(criteoTargetingKind(plan)&&input.spend_change_confirmed!==true)throw new MirrorError('SPEND_CONFIRMATION_REQUIRED','Criteo targeting can change delivery immediately. Review the complete scope and members and provide spend_change_confirmed=true.');
 if(appleEntityServing(plan)&&input.spend_change_confirmed!==true)throw new MirrorError('SPEND_CONFIRMATION_REQUIRED','Apple shared budgets, exclusions, creative edits and serving settings can affect existing campaigns. Provide spend_change_confirmed=true.');
 if(dv360ListAffectsServing(plan)&&input.spend_change_confirmed!==true)throw new MirrorError('SPEND_CONFIRMATION_REQUIRED','DV360 shared-list membership can change serving eligibility. Provide spend_change_confirmed=true.');
 if((googleAssetLinkKind(plan)||microsoftAssociationWrite(plan))&&input.spend_change_confirmed!==true)throw new MirrorError('SPEND_CONFIRMATION_REQUIRED','Asset associations change which creative can serve. Review the parent state and provide spend_change_confirmed=true.');
 if((googleTargetingKind(plan)||plan.gateway==='reddit_native_action')&&input.spend_change_confirmed!==true)throw new MirrorError('SPEND_CONFIRMATION_REQUIRED','Targeting, serving and shared-list changes require spend_change_confirmed=true.');
 if(googleConfigurationServing(plan)&&input.spend_change_confirmed!==true)throw new MirrorError('SPEND_CONFIRMATION_REQUIRED','Customizer, ad-parameter, segment, signal, exclusion and feed changes can affect existing ads. Review their impact and provide spend_change_confirmed=true.');
 if(googleConversionGoalServing(plan)&&input.spend_change_confirmed!==true)throw new MirrorError('SPEND_CONFIRMATION_REQUIRED','Goal edits, attachment, inheritance and removal can change optimization. Review affected campaigns and conversion definitions, then provide spend_change_confirmed=true.');
 if(googleBiddingEventKind(plan)&&input.spend_change_confirmed!==true)throw new MirrorError('SPEND_CONFIRMATION_REQUIRED','Seasonality adjustments and data exclusions can change bids, including after removal. Review the account timezone, scope and bidding impact, then provide spend_change_confirmed=true.');
 if(googlePortfolioServing(plan)&&input.spend_change_confirmed!==true)throw new MirrorError('SPEND_CONFIRMATION_REQUIRED','Portfolio target and bid-limit changes affect all associated campaigns. Review campaign membership, budgets and native units, then provide spend_change_confirmed=true.');
 const statusPatch=Array.isArray(plan.body)&&plan.body.some(op=>op&&/\/(status|intendedStatus|intended_status|entity_status|operation_status)$/.test(String(op.path))&&['ACTIVE','ENABLE','ENABLED'].includes(op.value));
 // Segment effects are decided by the contract above. Native ENABLED denotes
 // an available definition; a keyword containing "budget" is not a budget edit.
 if(!criteoReportKind(plan)&&!googlePortfolioKind(plan)&&!googleAccessKind(plan)&&!googleDismissalKind(plan)&&!businessAccessKind(plan)&&!businessNotificationKind(plan)&&!placeActionKind(plan)&&!metaReportKind(plan)&&!keywordPlanKind(plan)&&!googleSegmentKind(plan)&&!googleConversionGoalKind(plan)&&!xDraftKind(plan)&&(statusPatch||/budget|bid|spend|"(?:status|intendedStatus|intended_status|entity_status|entityStatus|operation_status)"\s*:\s*"(?:ACTIVE|ENABLE|ENABLED|ENTITY_STATUS_ACTIVE)"/i.test(JSON.stringify({query:plan.query,body:plan.body})))&&input.spend_change_confirmed!==true)throw new MirrorError('SPEND_CONFIRMATION_REQUIRED','Spend-affecting writes need spend_change_confirmed=true.');
}
