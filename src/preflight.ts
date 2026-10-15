import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {MirrorError, connectorReadOnly} from './errors.js';
import {numericStatusPaths, deliveryEditFields, namesSpendField} from './spend-effects.js';
import {familyOf} from './reviewed-families.js';
import {reviewedProviderJob} from './effect-class.js';
export interface ExecutionPolicy {
  allowWrites: boolean;
  /**
   * Not enforced, and never was: budget changes are limited by the owner spending policy (spend-policy.ts) and
   * confirmed through spend_change_confirmed. Accepted only so existing configurations keep compiling (F-23).
   */
  maxBudgetChange?: number;
  requireBeforeState: boolean;
  /**
   * The deployment owner's opt-in (AMCP_PROVIDER_VALIDATION=true, owner decision D18) to run provider validation
   * (amcp_campaign validate_provider) while live writes are off. It is a provider request that applies nothing but
   * uses write permission, so it always needs the account's write grant and is audited before it is sent.
   */
  providerValidation?: boolean;
  /**
   * The deployment owner's switch for provider report and export jobs (AMCP_PROVIDER_JOBS=true, RPT-06, owner decision
   * D18): a `provider_job` (src/effect-class.ts) creates a provider-side processing object and uses provider quota, but
   * changes no serving configuration or spend. With the switch on it is allowed while live writes are off, and a
   * reader may create one on an account with an explicit report-jobs grant (src/provider-jobs.ts). Off (the default),
   * report jobs stay reviewed writes exactly as before. Advertising writes are never affected.
   */
  providerJobs?: boolean;
}
export const readOnlyPolicy: ExecutionPolicy = {allowWrites: false, maxBudgetChange: 0, requireBeforeState: true};
/** True when the family decides its spending effect itself, so the budget/bid/spend field-name match does not apply. */
function exemptFromSpendTextMatch(plan: CompiledRequest): boolean {
  const exempt = familyOf(plan)?.exemptFromSpendTextMatch;
  return typeof exempt === 'function' ? exempt(plan) : !!exempt;
}
/** True when `plan` is a provider job the deployment owner's switch admits (RPT-06): never an advertising write. */
export function switchedProviderJob(plan: CompiledRequest, policy: ExecutionPolicy): boolean {
  return policy.providerJobs === true && reviewedProviderJob(plan);
}
/**
 * The refusal an execution without spend_change_confirmed gets, or undefined when the request needs no spending
 * acknowledgement. The one rule for both execute (authorizeExecution) and the effect taxonomy (spend_affecting).
 */
export function spendConfirmationError(plan: CompiledRequest): MirrorError | undefined {
  // Structural checks (spend-effects.ts) apply to every family and only ever add this confirmation.
  const numericStatus = numericStatusPaths(plan);
  if (numericStatus.length)
    return new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'A status given as a number cannot be shown to leave the entity paused. Name the status, or review the change and provide spend_change_confirmed=true.',
      {fields: numericStatus},
    );
  const delivery = deliveryEditFields(plan);
  if (delivery?.fields.length)
    return new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'This edit changes fields that decide what an existing ' +
        delivery.entity +
        ' serves, bids or spends: ' +
        delivery.fields.join(', ') +
        '. Review them against before_state and provide spend_change_confirmed=true.',
      {fields: delivery.fields},
    );
  const spend = familyOf(plan)?.spendConfirmation;
  if (spend?.needed(plan))
    return new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      typeof spend.message === 'function' ? spend.message(plan) : spend.message,
    );
  if (plan.gateway === 'reddit_native_action')
    return new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Targeting, serving and shared-list changes require spend_change_confirmed=true.',
    );
  const statusPatch =
    Array.isArray(plan.body) &&
    plan.body.some(
      op =>
        op &&
        /\/(status|intendedStatus|intended_status|entity_status|operation_status)$/.test(String(op.path)) &&
        ['ACTIVE', 'ENABLE', 'ENABLED'].includes(op.value),
    );
  // Segment effects are decided by the contract above. Native ENABLED denotes
  // an available definition. The rule reads field names, not content, so a keyword, lead form question, campaign name
  // or report metric containing "budget" is not a budget edit.
  if (!exemptFromSpendTextMatch(plan) && (statusPatch || namesSpendField(plan)))
    return new MirrorError('SPEND_CONFIRMATION_REQUIRED', 'Spend-affecting writes need spend_change_confirmed=true.');
  return undefined;
}
export function authorizeExecution(
  actor: Actor,
  plan: CompiledRequest,
  input: JsonObject,
  policy: ExecutionPolicy,
  verifiedBeforeState = false,
): void {
  if (plan.readOnly) return;
  // A provider job under the owner's switch (RPT-06) is allowed with writes off and for a reader; its account grant is
  // checked where the connection is resolved (WriteReviewService.access). Every other request keeps both refusals.
  const job = switchedProviderJob(plan, policy);
  if (!policy.allowWrites && !job)
    throw new MirrorError('LIVE_WRITES_DISABLED', 'This deployment permits reads and dry-run previews only.', {}, 403);
  if (actor.role === 'reader' && !job) throw connectorReadOnly(actor);
  if (input.dry_run !== false)
    throw new MirrorError('DRY_RUN_REQUIRED', 'Live execution must explicitly set dry_run=false.');
  if (input.confirmed !== true)
    throw new MirrorError('CONFIRMATION_REQUIRED', 'Live writes require confirmed=true under production policy.');
  if (typeof input.idempotency_key !== 'string' || !input.idempotency_key.trim())
    throw new MirrorError('IDEMPOTENCY_REQUIRED', 'Live writes require an idempotency_key.');
  if (policy.requireBeforeState && !verifiedBeforeState)
    throw new MirrorError(
      'WRITE_REVIEW_REQUIRED',
      'Use amcp_write prepare and execute; caller-supplied before_state is not a verified snapshot.',
    );
  const spend = spendConfirmationError(plan);
  if (spend && input.spend_change_confirmed !== true) throw spend;
}
