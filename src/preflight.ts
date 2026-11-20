import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {MirrorError, connectorReadOnly} from './errors.js';
import {numericStatusPaths, deliveryEditFields, namesSpendField} from './spend-effects.js';
import {familyOf} from './reviewed-families.js';
import {reviewedProviderJob} from './effect-class.js';
import {providerOf} from './provider-adapters.js';
import {providerHooks} from './provider-hooks.js';
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
   * The deployment runs the provider's validate-only check at prepare, for the providers that declare it (Google Ads:
   * `validation.byDefault`), unless the call sends `provider_check: false`; R2.5 M3, L2-12 (the lead's decision on Q2,
   * 2026-11-17). Set by the production runtime (server/runtime.ts) and by nothing else: it is not an environment flag.
   * A policy that leaves it out keeps what it always had, the check only for `provider_check: true`, so every test that
   * builds its own policy is unchanged. It adds one provider request to a prepare (one per part of a group), and never
   * removes a gate: a rejection still blocks execute, and a check that cannot run does not refuse the prepare.
   */
  providerCheckByDefault?: boolean;
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
 *
 * `state` is the review's state (the snapshots it read), which only a review holds: prepare passes the one it read, and execute the one it
 * froze and, after the state check, the one it read again. With it, a provider may find that a create can start no spend because its
 * parent reads PAUSED (`writes.pausedChildCreation`, the owner's decision of 2026-11-19), and the request asks for nothing. Without it
 * (inspect, the effect class of a bare plan, a plan's local compile) the rule fails closed and asks, as it always did, so a caller that
 * has no state keeps the state-free form. The provider's answer only ever removes the confirmation of a create; the structural checks
 * before it (a numeric status, an edit of an existing object) are not asked about it, and no other rule is changed.
 */
export function spendConfirmationError(plan: CompiledRequest, state?: readonly unknown[]): MirrorError | undefined {
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
  // The owner's decision of 2026-11-19 (R2.5 field fix r25-field-pausedspend): children created under a parent the review reads PAUSED can
  // start no spend. Only when a state is given; the provider decides, and answers true only for a request that holds creates alone.
  if (state !== undefined && providerHooks(plan.gateway)?.writes?.pausedChildCreation?.(plan, state)) return undefined;
  const spend = familyOf(plan)?.spendConfirmation;
  if (spend?.needed(plan))
    return new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      typeof spend.message === 'function' ? spend.message(plan) : spend.message,
    );
  // A provider whose every write changes what serves (Reddit: targeting, serving and shared lists).
  if (providerOf(plan.gateway)?.everyWriteConfirmsSpend)
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
  state?: readonly unknown[],
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
  const spend = spendConfirmationError(plan, state);
  if (spend && input.spend_change_confirmed !== true) throw spend;
}
