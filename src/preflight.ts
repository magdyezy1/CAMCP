import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {MirrorError, connectorReadOnly} from './errors.js';
import {numericStatusPaths, deliveryEditFields, namesSpendField} from './spend-effects.js';
import {familyOf} from './reviewed-families.js';
export interface ExecutionPolicy {
  allowWrites: boolean;
  /**
   * Not enforced, and never was: budget changes are limited by the owner spending policy (spend-policy.ts) and
   * confirmed through spend_change_confirmed. Accepted only so existing configurations keep compiling (F-23).
   */
  maxBudgetChange?: number;
  requireBeforeState: boolean;
}
export const readOnlyPolicy: ExecutionPolicy = {allowWrites: false, maxBudgetChange: 0, requireBeforeState: true};
/** True when the family decides its spending effect itself, so the budget/bid/spend field-name match does not apply. */
function exemptFromSpendTextMatch(plan: CompiledRequest): boolean {
  const exempt = familyOf(plan)?.exemptFromSpendTextMatch;
  return typeof exempt === 'function' ? exempt(plan) : !!exempt;
}
export function authorizeExecution(
  actor: Actor,
  plan: CompiledRequest,
  input: JsonObject,
  policy: ExecutionPolicy,
  verifiedBeforeState = false,
): void {
  if (plan.readOnly) return;
  if (!policy.allowWrites)
    throw new MirrorError('LIVE_WRITES_DISABLED', 'This deployment permits reads and dry-run previews only.', {}, 403);
  if (actor.role === 'reader') throw connectorReadOnly(actor);
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
  // Structural checks (spend-effects.ts) apply to every family and only ever add this confirmation.
  const numericStatus = numericStatusPaths(plan);
  if (numericStatus.length && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'A status given as a number cannot be shown to leave the entity paused. Name the status, or review the change and provide spend_change_confirmed=true.',
      {fields: numericStatus},
    );
  const delivery = deliveryEditFields(plan);
  if (delivery?.fields.length && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'This edit changes fields that decide what an existing ' +
        delivery.entity +
        ' serves, bids or spends: ' +
        delivery.fields.join(', ') +
        '. Review them against before_state and provide spend_change_confirmed=true.',
      {fields: delivery.fields},
    );
  const spend = familyOf(plan)?.spendConfirmation;
  if (spend?.needed(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      typeof spend.message === 'function' ? spend.message(plan) : spend.message,
    );
  if (plan.gateway === 'reddit_native_action' && input.spend_change_confirmed !== true)
    throw new MirrorError(
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
  if (
    !exemptFromSpendTextMatch(plan) &&
    (statusPatch || namesSpendField(plan)) &&
    input.spend_change_confirmed !== true
  )
    throw new MirrorError('SPEND_CONFIRMATION_REQUIRED', 'Spend-affecting writes need spend_change_confirmed=true.');
}
