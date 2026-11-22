import type {Store} from './store.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {ownsRecord} from './actor-identity.js';
import {reviewSummary} from './review-summary.js';
import {optional} from './workspace-core.js';
import {workspaceOwner} from './spend-policy.js';
import {approvalStatus} from './write-approval.js';
import {writeClaim} from './job-repository.js';
import {providerCheckView, viewProviderErrors, withholdTriggers} from './provider-error-core.js';

/**
 * Standalone reviewed writes as retained work (WRT-08 Stage A). A review prepared directly through amcp_write, or from
 * the website, is a first-class record: it appears in Operations (kind `write`) and `amcp_write status` reads it back
 * without a provider request. Reviews a campaign plan prepares for its steps, and the parts of a group, belong to their
 * plan or group and are not listed on their own. Only metadata is projected: never the frozen request body, the people
 * of a personal-data review, provider receipts or error messages.
 */

/** Which caller prepared a review: the person directly, a campaign plan's step, or one part of a group. */
export type WriteOrigin = 'standalone' | 'plan' | 'group_part';
/**
 * A claim that stays pending this long counts as uncertain: a process that stopped while the request was in flight
 * leaves it pending forever. Longer than one transport timeout plus admission.
 */
export const pendingUncertainMs = 10 * 60000;
/** How long a reconciliation may be acted on (accepted, or replaced) before the provider must be read again. */
export const reconciliationFreshMs = 15 * 60000;
export const writeRecordPath = (id: string) => '/operations?write_id=' + encodeURIComponent(id);
// The Operations projection of standalone reviews is in the store layer (src/write-record-repository.ts, ARC-02).
export {writeFeedSQL} from './write-record-repository.js';
import {groupOfPart, planStepHolding} from './write-record-repository.js';

/** The verification statuses a write record shows as its own state. */
const verificationStates: Record<string, string> = {
  verified: 'verified',
  mismatch: 'mismatch',
  inconclusive: 'inconclusive',
  unverified: 'inconclusive',
  failed: 'failed',
  pending: 'verifying',
  unsupported: 'complete',
};
/**
 * One write record's state, from its claim, read-back and reconciliation. Uncertain, rejected, expired, unsubmitted and
 * not-sent reviews need a person; complete, verified, reconciled and superseded ones do not. A rejected review (CMP-04)
 * was refused by the provider without being applied: its key is retired, so it is corrected under a new review.
 */
export function writeRecordState(p: JsonObject, now = Date.now()): string {
  if (typeof p.superseded_by === 'string' && p.superseded_by) return 'superseded';
  if (p.claim_state === 'rejected') return 'rejected';
  if (p.claim_state === 'complete') {
    if (p.success === false || p.success === 0) return 'failed';
    if (typeof p.verification === 'string' && verificationStates[p.verification])
      return verificationStates[p.verification]!;
    return p.reconciled === true || p.reconciled === 1 ? 'reconciled' : 'complete';
  }
  if (p.claim_state === 'uncertain') return 'uncertain';
  if (p.claim_state === 'pending')
    return Number(p.claim_at) > 0 && now - Number(p.claim_at) >= pendingUncertainMs ? 'uncertain' : 'executing';
  // A write group (src/write-groups.ts) is claimed only after its parts ran, and each part under its own key: between the parts, or after a crash
  // between them, the group's own key has no claim while a part of it is sent. It is judged by its parts' claims (r25-field3-errors, the lead
  // re-review N1, the duplicate-write guard): a part claimed and not released may have reached the provider, so the group is never "unsubmitted" or
  // "expired" ("Nothing was submitted"), before its window ends or after it. A part still being sent makes it executing; otherwise the group did
  // not finish and its outcome was not recorded.
  if (!p.claim_state && Number(p.parts_claimed) > 0)
    return Number(p.parts_pending_at) > 0 && now - Number(p.parts_pending_at) < pendingUncertainMs
      ? 'executing'
      : 'uncertain';
  // r25-field3-errors (AMCP-03, M5-a): a review the provider rejected when it validated it at prepare was never claimed. It reads as the
  // rejected state, so the call it offers is the corrected prepare and never the execute it is refused at, and it stays so past its five
  // minutes (an expired review is prepared again as it was, which is the same rejected request). The website words `rejected` already.
  if (p.provider_check === 'provider_rejected') return 'rejected';
  if (!(Number(p.expires_at) > now)) return 'expired';
  if (p.journal_phase === 'not_sent') return 'not_sent';
  return 'unsubmitted';
}
/** What Operations offers for a write record: its status read, never a resubmission. */
export function writeHandoff(id: string): JsonObject {
  return {
    website_path: writeRecordPath(id),
    next_call: {tool: 'amcp_write', arguments: {action: 'status', review_id: id}},
    next_safe_action:
      'Inspect the original review and its claim. An uncertain write is reconciled with read-only lookups; it is never submitted again automatically.',
  };
}
const claimLabel = (state: unknown, phase: unknown) =>
  state === 'pending'
    ? 'claimed'
    : state === 'uncertain' || state === 'complete' || state === 'rejected'
      ? state
      : phase === 'not_sent'
        ? 'not_sent'
        : 'none';
function claimRow(store: Store, tenant: string, id: string): JsonObject | undefined {
  return writeClaim(store, tenant, id);
}
/** The review (or group) a status, reconciliation or Operations link names, with the reader's right to it checked. */
export function retainedReview(store: Store, actor: Actor, reviewId: unknown): {review: JsonObject; group: boolean} {
  store.assertActorActive(actor);
  if (typeof reviewId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(reviewId))
    throw new MirrorError('INVALID_ARGUMENT', 'Send the review_id that prepare returned.', {field: 'review_id'});
  const group = optional(store, actor.tenantId, 'write_review_group', reviewId),
    review = group ?? optional(store, actor.tenantId, 'write_review', reviewId);
  if (!review) throw new MirrorError('NOT_FOUND', 'No reviewed write with this review_id in this workspace.', {}, 404);
  // The credential that prepared it, the same person, or an administrator with current access to its account.
  if (review.user_id !== actor.userId && !ownsRecord(actor, review) && actor.role !== 'admin')
    throw new MirrorError('FORBIDDEN', 'The review belongs to a different actor.', {}, 403);
  const gateway = review.plan?.gateway ?? review.gateway,
    account = review.plan?.accountId ?? review.account_id;
  if (typeof gateway !== 'string' || typeof account !== 'string' || typeof review.connection_id !== 'string')
    throw new MirrorError('NOT_FOUND', 'This review has no retained account scope.', {}, 404);
  store.resolveConnection(actor, gateway, account, review.connection_id);
  return {review, group: !!group};
}
/** A reconciliation record as it was before a supersede sealed it. */
const unsealed = (record: JsonObject): JsonObject => {
  const {superseded_by: _by, superseded_at: _at, ...kept} = record;
  return kept;
};
/**
 * Whether the supersede that names `replacementId` (R2.5 M2, lead re-review N4) is over: a review that replaces an uncertain write seals
 * it only while the replacement can still settle the matter, that is while the replacement is unexpired and unclaimed, or holds a claim
 * that is not rejected (pending, uncertain or complete: it may have made the object). It ended when the provider refused the
 * replacement without applying it (`rejected`: its key is retired), or when it has no claim and its window passed, or it is gone
 * (`expired`). Undefined while it is in force. A release of the replacement's claim by a refusal before dispatch (a pause, a rate
 * limit) does not end it: the replacement is unexpired, and executes again inside its window (lead decision, 2026-11-17).
 */
export function supersedeEnded(
  store: Store,
  tenant: string,
  replacementId: string,
  now = Date.now(),
): 'rejected' | 'expired' | undefined {
  const claim = writeClaim(store, tenant, replacementId);
  if (claim) return claim.state === 'rejected' ? 'rejected' : undefined;
  const replacement = optional(store, tenant, 'write_review', replacementId);
  return replacement && Number(replacement.expires_at) > now ? undefined : 'expired';
}
/** The replacement that sealed the review `oldId` and ended (why), or undefined while its supersede is in force, or when it has none. */
export function endedSeal(
  store: Store,
  tenant: string,
  oldId: string,
  now = Date.now(),
): {replacement: string; why: 'rejected' | 'expired'} | undefined {
  const by = optional(store, tenant, 'write_reconciliation', oldId)?.superseded_by,
    why = typeof by === 'string' && by ? supersedeEnded(store, tenant, by, now) : undefined;
  return typeof by === 'string' && why ? {replacement: by, why} : undefined;
}
/** The replacement a reconciliation record's supersede names while it is in force; undefined once it ended, or when there is none. */
export function supersededBy(
  store: Store,
  tenant: string,
  record: JsonObject | undefined,
  now = Date.now(),
): string | undefined {
  const by = record?.superseded_by;
  return typeof by === 'string' && by && !supersedeEnded(store, tenant, by, now) ? by : undefined;
}
/**
 * Lifts the supersede of the uncertain write `oldId` by `replacementId` (R2.5 M2, lead re-review N4), when the replacement was rejected
 * or expired with no claim: clears `superseded_by` from the old review's reconciliation, makes what it kept non-decisive
 * (`indeterminate`, with the reason: lead re-review 2, F1), audits why, and queues the old review's check again through `queue` (which
 * says whether it did). Runs in one transaction, so a caller that rejects the replacement lifts it in the same one. Returns whether
 * the record named that replacement.
 */
export function liftSupersede(
  store: Store,
  tenant: string,
  oldId: string,
  replacementId: string,
  why: 'rejected' | 'expired',
  queue?: () => boolean,
): boolean {
  return store.transaction(() => {
    const record = optional(store, tenant, 'write_reconciliation', oldId);
    if (!record || record.superseded_by !== replacementId) return false;
    const {id: _id, revision: _revision, ...rest} = unsealed(record),
      old = optional(store, tenant, 'write_review', oldId),
      open = ['uncertain', 'pending'].includes(String(writeClaim(store, tenant, oldId)?.state));
    // The record that comes back is the not-applied answer the replacement was prepared on, minutes old, and it settles nothing now:
    // the replacement was rejected (the provider's refusal is the strongest sign that the old write was applied) or never ran. It is
    // kept for display (`found`, `undated`) but is no longer decisive, so the check this lift queues reads the provider, a status
    // offers that check and not the replacement again, and a new replacement needs a fresh not-applied answer (lead re-review 2, F1).
    store.putDocument(tenant, 'write_reconciliation', oldId, {
      ...rest,
      classification: 'indeterminate',
      reason: why === 'rejected' ? 'replacement_rejected' : 'replacement_expired',
      updated_at: Date.now(),
    });
    store.appendAudit(tenant, oldId, {
      event: 'write_supersede_lifted',
      review_id: oldId,
      replacement_id: replacementId,
      reason: why,
      check_queued: open && queue ? queue() : false,
      gateway: old?.plan?.gateway,
      account_id: old?.plan?.accountId ?? null,
      connection_id: old?.connection_id,
    });
    return true;
  });
}
/**
 * What a write group's parts hold of claims (lead re-review N1): how many were claimed and not released (something may have been sent under their
 * own keys), and when the latest of those that are still pending was claimed. Empty for a review that is not a group.
 */
function partClaims(
  store: Store,
  tenant: string,
  review: JsonObject,
): {parts_claimed?: number; parts_pending_at?: number} {
  if (!Array.isArray(review.parts)) return {};
  let claimed = 0,
    pendingAt = 0;
  for (const part of review.parts as string[]) {
    const claim = claimRow(store, tenant, part);
    if (!claim) continue;
    claimed++;
    if (claim.state === 'pending') pendingAt = Math.max(pendingAt, Number(claim.created_at) || 0);
  }
  return {parts_claimed: claimed, ...(pendingAt ? {parts_pending_at: pendingAt} : {})};
}
/** The state of one retained review, from the store alone. */
function recordState(store: Store, tenant: string, id: string, review: JsonObject, now: number) {
  const claim = claimRow(store, tenant, id),
    result = claim?.state === 'complete' && typeof claim.result === 'string' ? JSON.parse(claim.result) : undefined,
    journal = optional(store, tenant, 'operation_journal', id),
    verification = optional(store, tenant, 'write_verification', id),
    stored = optional(store, tenant, 'write_reconciliation', id),
    // A supersede whose replacement ended is not shown (a status lifts it, src/write-review.ts): only one in force seals the review.
    reconciliation = stored?.superseded_by && !supersededBy(store, tenant, stored, now) ? unsealed(stored) : stored;
  const parts = partClaims(store, tenant, review),
    state = writeRecordState(
      {
        claim_state: claim?.state,
        claim_at: claim?.created_at,
        success: result?.success,
        reconciled: result?.reconciled,
        verification: verification?.status,
        expires_at: review.expires_at,
        journal_phase: journal?.phase,
        provider_check: review.provider_check?.status,
        superseded_by: reconciliation?.superseded_by,
        ...parts,
      },
      now,
    );
  return {claim, result, journal, verification, reconciliation, state, parts_claimed: parts.parts_claimed};
}
/**
 * Who may settle an uncertain write's outcome (accept it as applied, or replace it): the credential that prepared it,
 * the same person through another client, or the workspace owner. An administrator may read any retained review of an
 * account they can access, but settling a colleague's write lets that colleague's dependent work continue, which is
 * no more than execute itself allows.
 */
export function mayResolve(store: Store, actor: Actor, review: JsonObject): boolean {
  return review.user_id === actor.userId || ownsRecord(actor, review) || workspaceOwner(store, actor);
}
/** The call that reads a retained review back: no provider request, and nothing is sent. */
const statusCall = (id: string): JsonObject => ({tool: 'amcp_write', arguments: {action: 'status', review_id: id}});
/** The call that executes a review once the user approves: the acknowledgements its execute asks for are added after that approval, never pre-filled. */
function executeCall(id: string, review: JsonObject): JsonObject {
  const flags = (Array.isArray(review.required_acknowledgements) ? review.required_acknowledgements : []).filter(
    (k: unknown) => typeof k === 'string' && k !== 'confirmed',
  );
  return {
    tool: 'amcp_write',
    arguments: {action: 'execute', review_id: id},
    add_after_user_approval: Object.fromEntries(['confirmed', ...flags].map((k: string) => [k, true])),
  };
}
/**
 * The call that executes the review a plan's step holds, through the plan, as the plan's prepare_next names it: execute_next with the exact review and its
 * key, and the acknowledgements its execute asks for added after the user approves (the lead's item 8).
 */
function planExecuteCall(plan: string, id: string, review: JsonObject): JsonObject {
  const flags = (Array.isArray(review.required_acknowledgements) ? review.required_acknowledgements : []).filter(
    (k: unknown) => typeof k === 'string' && k !== 'confirmed',
  );
  return {
    tool: 'amcp_campaign',
    arguments: {action: 'execute_next', id: plan, review_id: id, idempotency_key: id, confirmed: true},
    ...(flags.length ? {add_after_user_approval: Object.fromEntries(flags.map((k: string) => [k, true]))} : {}),
  };
}
/**
 * The call that prepares a review again from its original arguments, which only the credential that prepared it is shown: anyone else gets the call's
 * scope without the request body (WRT-08 privacy: request bodies are not shown to other members). Null for a review that kept no arguments.
 */
function prepareCall(review: JsonObject, actor: Actor): JsonObject | null {
  const input = review.prepare_input as JsonObject | undefined;
  if (!input) return null;
  if (review.user_id === actor.userId) return {tool: 'amcp_write', arguments: {action: 'prepare', ...input}};
  return {
    tool: 'amcp_write',
    arguments: {
      action: 'prepare',
      ...(typeof input.gateway === 'string' ? {gateway: input.gateway} : {}),
      ...(typeof input.connection_id === 'string' ? {connection_id: input.connection_id} : {}),
    },
    arguments_required: 'The original native arguments are shown only to the person who prepared this review.',
  };
}
/**
 * The call that moves a write record on from its state; execute never pre-fills an acknowledgement. An expired review
 * is prepared again from its original arguments only for the credential that prepared it: anyone else gets the call's
 * scope without the request body (WRT-08 privacy: request bodies are not shown to other members).
 */
function nextCall(
  id: string,
  review: JsonObject,
  state: string,
  actor: Actor,
  reconciliation?: JsonObject,
  resolvable = false,
  step?: PlanHolder,
  groupCall?: JsonObject | null,
): JsonObject | null {
  if (['unsubmitted', 'not_sent'].includes(state)) {
    // A review a plan's step holds, a group it holds and the parts of that group are executed through their plan, which applies its approvals and
    // checks (and, where the owner requires another approver, is the only way: the lead's item 8): the call is the plan's own, as prepare_next names it,
    // and a part names the step to read.
    if (step?.plan && step.step && step.held)
      return step.group
        ? {tool: 'amcp_campaign', arguments: {action: 'get', id: step.plan, step_id: step.step}}
        : planExecuteCall(step.plan, id, review);
    return executeCall(id, review);
  }
  // A review the provider refused, that is a step of a plan, is corrected in its plan (r25-field3-errors, lead review S2-2): the plan's
  // recover_step, which keeps the change under the plan's hash, its approval and its distinct-approver check. A standalone prepare of the
  // step's arguments would take it outside them. A review no step holds any longer is not offered a call: the plan's own step is the one to correct.
  if ((state === 'rejected' || state === 'expired') && step) {
    if (!step.plan || !step.step) return null;
    // A step that went on to another review is read, not amended through this one: its newer review is the plan's to show (the re-review N3). So is
    // the step of a part of a group, which says what became of the whole change (the second re-review, N3-b).
    if (!step.held || step.group)
      return {tool: 'amcp_campaign', arguments: {action: 'get', id: step.plan, step_id: step.step}};
    // An expired review was never sent: the plan prepares its step again, under its approvals and checks (N3-b).
    if (state === 'expired') return {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id: step.plan}};
    return {
      tool: 'amcp_campaign',
      arguments: {action: 'recover_step', id: step.plan, step_id: step.step, confirmed: true},
      kind: 'correction',
      correct:
        'Amend this step in its plan: change what the provider named (provider_check, or the error of the step) by a patch of those paths or by corrected arguments. Read the step with get and its step_id; the plan’s approval and checks still apply.',
    };
  }
  // An expired review, or one the provider refused without applying it (its key is retired, CMP-04), is prepared again.
  if (state === 'expired' || state === 'rejected') {
    const prepare = prepareCall(review, actor);
    if (!prepare) return null;
    // A review the provider rejected when it validated it (r25-field3-errors, AMCP-03): sent as it was, the same request is rejected
    // again, so the call says what to change first and that it is a correction, not an approval.
    const correction =
      review.provider_check?.status === 'provider_rejected'
        ? {
            kind: 'correction',
            correct:
              'Change what provider_check names (provider_errors and field_paths) in these arguments first: sent unchanged, the provider rejects this request again.',
          }
        : {};
    return {...prepare, ...correction};
  }
  // A write group in doubt is read part by part (lead re-review N1): its own reconcile is refused (each part is reconciled by its own review_id),
  // and a prepare of the whole would meet parts that may have been sent. The call is the one groupInDoubt chose: the status of the part to read, the
  // group's own execute when every part that was sent applied and its review is open, or the call of the part not sent.
  if (state === 'uncertain' && Array.isArray(review.parts)) return groupCall ?? null;
  if (state === 'uncertain') {
    // What the latest check found (the person's `reconcile`, or the worker's, R2.5 M2) decides which call is offered, and
    // only while it is fresh enough to act on. Accepting and replacing stay the person's acts: the call is offered, never made.
    const fresh =
      reconciliation &&
      !reconciliation.superseded_by &&
      !reconciliation.accepted_at &&
      Date.now() - Number(reconciliation.checked_at) <= reconciliationFreshMs;
    if (fresh && reconciliation.classification === 'appears_applied' && resolvable)
      return {
        tool: 'amcp_write',
        arguments: {action: 'reconcile', review_id: id, reconciliation_id: reconciliation.reconciliation_id},
        add_after_user_approval: {accept_applied: true},
      };
    // The original request is shown only to the credential that prepared it, as for an expired review.
    if (
      fresh &&
      reconciliation.classification === 'appears_not_applied' &&
      review.prepare_input &&
      review.user_id === actor.userId
    )
      return {
        tool: 'amcp_write',
        arguments: {action: 'prepare', ...review.prepare_input, supersedes_review_id: id},
        meaning:
          'A new review of the same request that replaces this one; it is reviewed and approved like any other. Nothing is prepared or sent for you.',
      };
    return {tool: 'amcp_write', arguments: {action: 'reconcile', review_id: id}};
  }
  if (state === 'executing') return {tool: 'amcp_write', arguments: {action: 'status', review_id: id}};
  if (['complete', 'reconciled', 'verified', 'verifying', 'mismatch', 'inconclusive'].includes(state))
    return {tool: 'amcp_campaign', arguments: {action: 'verify', review_id: id}};
  return null;
}
const guidance: Record<string, string> = {
  unsubmitted:
    'Prepared and not executed. Show the user the review; execute it only after they approve, before it expires.',
  not_sent:
    'An execute was refused before anything reached the provider and the claim was released. Execute the same review again inside its window once the cause clears.',
  expired: 'Nothing was submitted and the review expired. Prepare the same request again to review it.',
  rejected:
    'The provider refused this request without applying it. Its key is retired and never sent again: correct what the provider error named and prepare a new review (next_call).',
  // The same state for a review the provider rejected when it validated it at prepare (r25-field3-errors, AMCP-03): no key was ever used.
  validation_rejected:
    'The provider rejected this request when it validated it at prepare, so it was never claimed or sent, and this review is never executed. provider_check.provider_errors and field_paths name what to correct: change the request and prepare it again (next_call).',
  // The same two states for a review that is a step of a plan (S2-2): the correction is the plan's, and nothing is prepared outside it.
  plan_rejected:
    'The provider refused this request without applying it. It is a step of a plan: its key is retired and never sent again. Correct what the provider error named by amending the step in its plan (next_call, recover_step); the plan’s approval and checks still apply.',
  plan_validation_rejected:
    'The provider rejected this request when it validated it at prepare, so it was never claimed or sent, and this review is never executed. It is a step of a plan: provider_check.provider_errors and field_paths name what to correct; amend the step in its plan (next_call, recover_step).',
  // A rejected review of a plan's step that the step no longer holds (the re-review N3): it is never sent, and it is not the one to correct.
  plan_detached:
    'The provider refused this request, and this review is never sent. It was a step of a plan, and that step holds a newer review now: read the step in its plan (next_call) and correct it there; nothing is prepared outside the plan.',
  plan_orphaned:
    'The provider refused this request, and this review is never sent. It was a step of a plan, but no plan holds it any longer, so no call is offered: read the plan that prepared it (amcp_campaign get) and correct the step there; nothing is prepared outside the plan.',
  // The same three for a review that expired unsent, and the part of a plan's group (the second re-review, N3-b): a review a plan holds is prepared
  // again by the plan, never by a prepare outside it.
  plan_expired:
    'Nothing was submitted and this review expired. It is a step of a plan: the plan prepares it again (next_call, prepare_next), under its approvals and checks; nothing is prepared outside the plan.',
  plan_expired_detached:
    'Nothing was submitted and this review expired. It was a step of a plan, and that step holds a newer review now: read the step in its plan (next_call); nothing is prepared outside the plan.',
  plan_expired_orphaned:
    'Nothing was submitted and this review expired. It was a step of a plan, but no plan holds it any longer, so no call is offered: read the plan that prepared it (amcp_campaign get); nothing is prepared outside the plan.',
  plan_part_rejected:
    'The provider refused this part of a group without applying it, and its key is retired. The group is a step of a plan: read the step in its plan (next_call), which says what to do; nothing is prepared outside the plan.',
  plan_part_expired:
    'Nothing of this part of a group was submitted and its review expired. The group is a step of a plan: read the step in its plan (next_call), which says what to do; nothing is prepared outside the plan.',
  // A review a plan holds that was not sent (the lead's item 8): the plan executes it, never a direct execute, which skips the plan's approvals and is
  // refused where the owner requires another person to approve a plan that changes spending.
  plan_unsubmitted:
    'Prepared and not executed. It is a step of a plan: execute it through the plan (next_call, execute_next) after the user approves and before it expires, which applies the plan’s approvals and checks. A direct amcp_write execute is refused where the owner requires another person’s approval of a plan that changes spending.',
  plan_not_sent:
    'Nothing reached the provider. It is a step of a plan: execute the same review through the plan again (next_call, execute_next) before it expires.',
  plan_part_unsubmitted:
    'Prepared and not executed. This is a part of a write group that a plan’s step holds: the group is executed once, through its plan, never part by part. Read the step in its plan (next_call), which names the call that executes it.',
  plan_part_not_sent:
    'Nothing of this part reached the provider. It is a part of a write group that a plan’s step holds, which is executed through its plan: read the step in its plan (next_call).',
  executing: 'The request is being sent now. Read this status again in a moment; never execute it twice.',
  // A write group in doubt (lead re-review N1): a part was claimed under its own key, so part of the change may have reached the provider.
  group_uncertain:
    'Part of this change was sent under its parts’ own keys and the group has no recorded outcome, so it may have reached the provider. Nothing is prepared or sent again for you: read amcp_write status of each part (parts lists their states and the call), reconcile the parts that need it, check the provider before any new change, and never prepare the same change again.',
  // The same group when every part that was sent was refused by the provider without being applied (the second re-review, S4-c).
  group_rejected:
    'The provider refused a part of this change without applying it, and no other part was sent, so nothing of this change was applied. The refused part’s key is retired and this review is never executed. Read amcp_write status of the refused part for the rows the provider named (next_call); correcting the request is a new reviewed write.',
  // The same group when every part that was sent applied (the second re-review, choices 2 and 3).
  group_resumable:
    'Part of this change was sent and applied under its parts’ own keys, and this review is still open. Execute it again after the user approves (next_call): the parts already applied are replayed, never sent twice, and only the parts not sent are sent. Never prepare the same change again.',
  group_unsent:
    'Part of this change was applied under its parts’ own keys, and the group itself can no longer be executed (its review ended, or it stopped), so each part not sent is sent on its own: parts lists the call of each, its own records prepared and approved like any other review. The applied parts are never sent again; never prepare the whole change again.',
  group_in_plan:
    'Part of this change was applied under its parts’ own keys. It is a step of a plan: read the step in its plan (next_call), which resumes it under the plan’s approvals and checks. The applied parts are never sent again, nothing is prepared outside the plan, and never prepare the same change again.',
  uncertain:
    'The request may have reached the provider and its outcome was not recorded. It is never sent again. Reconcile it with read-only lookups (next_call), or check the provider directly, before any new change.',
  failed: 'The provider reported a failed or partial outcome. Inspect the retained receipt before any correction.',
  complete: 'Applied. Read it back to verify (next_call).',
  reconciled:
    'Accepted as applied after a read-only reconciliation. Read it back to verify (next_call); it is never sent again.',
  verified: 'Applied and read back.',
  verifying: 'Applied; the read-back is still settling. Verify again shortly.',
  mismatch: 'Applied, but the provider holds different values. A correction is a new reviewed write.',
  inconclusive: 'Applied; the read-back could not settle. Verify again or inspect the provider.',
  superseded:
    'Reconciled as not applied and replaced by a new review. This review is never sent; follow the replacement.',
};
/** A stored millisecond time in the ISO form every other time in a status uses. */
const iso = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? new Date(v).toISOString() : (v ?? null));
/**
 * What a status shows of a reconciliation (the person's, or the worker's automatic check, R2.5 M2): its id, what it found,
 * why, when, and for the worker's, which attempt it was and when it looks again, or that its attempts ran out. Closed
 * tokens, times and the observed IDs of an applied create only: never the provider's receipt or its text.
 */
function reconciliationView(r: JsonObject): JsonObject {
  return {
    reconciliation_id: r.reconciliation_id,
    classification: r.classification,
    ...(typeof r.reason === 'string' ? {reason: r.reason} : {}),
    ...(typeof r.read_error === 'string' ? {read_error: r.read_error} : {}),
    checked_at: iso(r.checked_at),
    ...(r.automatic === true
      ? {
          automatic: true,
          attempts: r.attempts,
          ...(typeof r.next_check_at === 'number' ? {next_check_at: iso(r.next_check_at)} : {}),
          ...(r.checks_exhausted === true ? {checks_exhausted: true} : {}),
        }
      : {}),
    ...(r.classification === 'appears_applied' && Array.isArray(r.observed_ids) ? {observed_ids: r.observed_ids} : {}),
    ...(r.accepted_at ? {accepted_at: iso(r.accepted_at)} : {}),
    ...(r.superseded_by ? {superseded_by: r.superseded_by} : {}),
  };
}
/**
 * A rejected or expired review a plan holds (S2-2, the re-review N3, the second re-review N3-b): the plan and the step that name it, whether the step
 * holds it as its review now (`held`: the plan's own call is named for it) or went on to another (the step is named to be read), and neither when the
 * review is a plan's (its origin says so) that no plan names any longer. `group`: the review is a part of the group the step holds, so the step is
 * read and not amended through the part.
 */
type PlanHolder = {plan?: string; step?: string; held: boolean; group?: boolean};
/**
 * The plan and the step that hold a rejected or expired review: the plan's own call is named for it, never a prepare outside the plan, its hash, its
 * approval and its distinct-approver check (S2-2, N3-b); undefined for any other review. A part of a group is a plan's when its group is held by a step.
 * A review not yet sent (unsubmitted, or not sent) is a plan's while its step holds it, or holds the group it is a part of: the plan executes it (the
 * lead's item 8); one the step went on from is no longer the plan's to execute, and is as any other.
 */
function planStep(store: Store, tenant: string, id: string, review: JsonObject, state: string): PlanHolder | undefined {
  const unsent = ['unsubmitted', 'not_sent'].includes(state);
  if (!(unsent || ['rejected', 'expired'].includes(state)) || review.origin === 'standalone') return undefined;
  if (review.origin === 'group_part') {
    const group = groupOfPart(store, tenant, id),
      held = group ? planStepHolding(store, tenant, group) : undefined;
    return held && (!unsent || held.held) ? {...held, group: true} : undefined;
  }
  // A review kept before reviews recorded their origin has none: it is a plan's when a plan names it (lead re-review N3).
  const found = planStepHolding(store, tenant, id);
  if (unsent) return found?.held ? found : undefined;
  return found ?? (review.origin === 'plan' ? {held: false} : undefined);
}
/** The refusal a rejected claim's journal recorded: its code, HTTP status and rows; undefined when it recorded none of them. */
function lastError(journal: JsonObject): JsonObject | undefined {
  const event: JsonObject = Array.isArray(journal.events) ? (journal.events.at(-1) ?? {}) : {},
    error = {
      ...(typeof event.code === 'string' ? {code: event.code} : {}),
      ...(typeof event.http_status === 'number' ? {http_status: event.http_status} : {}),
      ...viewProviderErrors(event),
    };
  return Object.keys(error).length ? error : undefined;
}
/** The state of one part of a write group, from the store alone (a step view pages the parts with their states: lead re-review N2). */
export function writePartState(store: Store, tenant: string, id: string, now = Date.now()): string {
  return String(partSummary(store, tenant, id, now).state);
}
/** Whether a part's state says something of it was sent (it holds a claim): not an unsent, released, expired or unknown one. */
const partSent = (state: unknown) => !['unsubmitted', 'not_sent', 'expired', 'unknown'].includes(String(state));
function partSummary(store: Store, tenant: string, id: string, now: number): JsonObject {
  const review = optional(store, tenant, 'write_review', id);
  if (!review) return {review_id: id, state: 'unknown'};
  return {review_id: id, state: recordState(store, tenant, id, review, now).state};
}
/** The states a part settles in once it was applied: its receipt is complete, whatever its read-back found (a mismatch or an unsettled read-back is still an applied write). */
const appliedStates = ['complete', 'reconciled', 'verified', 'verifying', 'mismatch', 'inconclusive'];
/** A group's execute refuses a group whose window ends within this long (src/write-groups.ts): a status offers it only while it can be executed. */
const groupExecuteMarginMs = 5000;
/** What a status of a write group in doubt offers: the call, the sentence that explains it and the call of each part that is sent on its own. */
interface GroupDoubt {
  key: string;
  call: JsonObject | null;
  partCalls: Map<string, JsonObject>;
}
/**
 * A write group in doubt, because a part was sent under its own key and the group has no recorded outcome, as one status says what to do
 * (r25-field3-errors, the second re-review, choices 2 and 3). A part that holds a claim in any other state than applied (pending, uncertain, rejected,
 * a failed receipt) is read, never executed again. When every part that was sent applied: while the group's review is open and its own key holds no
 * claim, its execute resumes it (each applied part replays and is never sent twice, the parts not sent are sent once, after the user approves);
 * otherwise each part not sent is sent on its own, with the prepare of its own records, never the whole group's. A group that a plan's step holds is
 * read in its plan: neither its own execute nor a prepare outside the plan keeps the plan's approvals and checks.
 */
function groupInDoubt(
  store: Store,
  actor: Actor,
  id: string,
  review: JsonObject,
  rows: JsonObject[],
  ownClaim: boolean,
  now: number,
): GroupDoubt {
  const sent = rows.filter(p => partSent(p.state)),
    unsent = rows.filter(p => !partSent(p.state)),
    // The part to read: one in doubt first, then one that did not apply (rejected or a failed receipt), then the first that was sent.
    toRead =
      sent.find(p => ['uncertain', 'executing'].includes(String(p.state))) ??
      sent.find(p => !appliedStates.includes(String(p.state))) ??
      sent[0],
    applied = sent.length > 0 && sent.every(p => appliedStates.includes(String(p.state))),
    none = new Map<string, JsonObject>();
  if (applied) {
    const held = planStepHolding(store, actor.tenantId, id);
    if (held)
      return {
        key: 'group_in_plan',
        call: {tool: 'amcp_campaign', arguments: {action: 'get', id: held.plan, step_id: held.step}},
        partCalls: none,
      };
    if (!ownClaim && Number(review.expires_at) > now + groupExecuteMarginMs)
      return {key: 'group_resumable', call: executeCall(id, review), partCalls: none};
    const calls = new Map<string, JsonObject>();
    for (const p of unsent) {
      const part = optional(store, actor.tenantId, 'write_review', String(p.review_id)),
        call = !part
          ? null
          : Number(part.expires_at) > now + groupExecuteMarginMs
            ? executeCall(String(p.review_id), part)
            : prepareCall(part, actor);
      if (call) calls.set(String(p.review_id), call);
    }
    if (calls.size) return {key: 'group_unsent', call: calls.values().next().value!, partCalls: calls};
  }
  const read = toRead ? statusCall(String(toRead.review_id)) : null;
  // Every part that was sent was refused by the provider without being applied (S4-c): it is still a case for a person, but nothing of the change was
  // applied, so it is not said to have reached the provider. The rows the provider named are in the status of the part.
  if (sent.length > 0 && sent.every(p => p.state === 'rejected'))
    return {key: 'group_rejected', call: read, partCalls: none};
  return {key: 'group_uncertain', call: read, partCalls: none};
}
/**
 * `amcp_write status`: a retained review read back from AMCP alone (zero provider requests). Returns what the review
 * does, its claim, receipt, read-back and reconciliation, the review's own state reads as read-only lookups, and the
 * one call that moves it on. Secrets and people are never returned, and a request body only to the credential that
 * prepared it (its expired review's prepare call).
 */
export function writeStatus(store: Store, actor: Actor, reviewId: unknown): JsonObject {
  const {review, group} = retainedReview(store, actor, reviewId),
    id = review.id as string,
    now = Date.now(),
    s = recordState(store, actor.tenantId, id, review, now),
    plan = review.plan as CompiledRequest | undefined;
  // A group in doubt names the state of each part, and for each part that was claimed the call that reads it (lead re-review N1); a part not sent has
  // the call that sends it on its own only when the group cannot be resumed by its own execute (the second re-review, choice 3).
  const inDoubt = group && ['uncertain', 'executing'].includes(s.state),
    rows: JsonObject[] | undefined = group
      ? (review.parts as string[]).map((part, i) => ({part: i + 1, ...partSummary(store, actor.tenantId, part, now)}))
      : undefined,
    doubt =
      group && s.state === 'uncertain' ? groupInDoubt(store, actor, id, review, rows!, !!s.claim, now) : undefined,
    parts: JsonObject[] | undefined = rows?.map(row => {
      const own = doubt?.partCalls.get(String(row.review_id));
      return {
        ...row,
        ...(inDoubt && partSent(row.state) ? {next_call: statusCall(String(row.review_id))} : {}),
        ...(own ? {next_call: own} : {}),
      };
    });
  // A rejected review of a plan's step: the plan and the step that name it, if any (S2-2, and the re-review N3 for one the step no longer holds).
  const planHolder = planStep(store, actor.tenantId, id, review, s.state),
    resolvable = mayResolve(store, actor, review),
    call = nextCall(id, review, s.state, actor, s.reconciliation, resolvable, planHolder, doubt?.call),
    // WRT-09: whether a person has approved this review on the website, while it can still be executed.
    approval = s.state === 'unsubmitted' || s.state === 'not_sent' ? approvalStatus(store, actor, id) : undefined,
    // A review the provider rejected at validate-only (r25-field3-errors, AMCP-03): never claimed, so the state is rejected without a key.
    validationRejected = s.state === 'rejected' && !s.claim && review.provider_check?.status === 'provider_rejected',
    // The check at prepare as this reader sees it: a reader other than the preparer is not shown the request's own text (a trigger, S3-3).
    checkView = review.provider_check ? providerCheckView(review.provider_check) : undefined,
    shownCheck = checkView && review.user_id !== actor.userId ? withholdTriggers(checkView) : checkView;
  store.assertActorActive(actor);
  return {
    record_kind: group ? 'write_review_group' : 'write_review',
    review_id: id,
    state: s.state,
    origin: review.origin ?? null,
    gateway: plan?.gateway ?? review.gateway,
    account_id: plan?.accountId ?? review.account_id,
    connection_id: review.connection_id,
    ...(plan
      ? {
          action: plan.action,
          request: {method: plan.method, path: plan.path},
          summary: reviewSummary(plan, Array.isArray(review.state) ? review.state : []),
        }
      : {action: review.prepare_input?.arguments?.action ?? null, records: review.records ?? null, parts}),
    fingerprint: review.fingerprint ?? null,
    prepared_at: typeof review.created_at === 'number' ? new Date(review.created_at).toISOString() : null,
    expires_at: new Date(review.expires_at).toISOString(),
    claim: {
      state: claimLabel(s.claim?.state, s.journal?.phase),
      ...(group && !s.claim && Number(s.parts_claimed) > 0 ? {parts_claimed: s.parts_claimed} : {}),
      ...(s.claim ? {claimed_at: new Date(Number(s.claim.created_at)).toISOString()} : {}),
      ...(s.journal ? {phase: s.journal.phase, updated_at: iso(s.journal.updated_at)} : {}),
      ...(s.journal?.phase === 'not_sent' && typeof s.journal.events?.at(-1)?.code === 'string'
        ? {code: s.journal.events.at(-1).code}
        : {}),
    },
    receipt: s.result
      ? {
          success: s.result.success ?? null,
          outcome: s.result.outcome ?? null,
          ...(s.result.reconciled === true
            ? {reconciled: true, reconciliation_id: s.result.reconciliation_id, observed_ids: s.result.observed_ids}
            : {}),
          replayed_by_execute: true,
        }
      : null,
    verification: s.verification ? {status: s.verification.status, checked_at: iso(s.verification.checked_at)} : null,
    reconciliation: s.reconciliation ? reconciliationView(s.reconciliation) : null,
    ...(review.supersedes_uncertain ? {supersedes_uncertain: review.supersedes_uncertain} : {}),
    required_acknowledgements: review.required_acknowledgements ?? null,
    ...(approval ? {approval} : {}),
    // What the provider's check at prepare came to, with the rows and paths of a rejection and never the provider's answer or its sentence
    // (r25-field3-errors, AMCP-03): a record shows no provider text beyond closed-set tokens and the caller's own words.
    ...(shownCheck ? {provider_check: shownCheck} : {}),
    // The refusal a claim ended with, from its journal (r25-field3-errors, AMCP-03): its code, the HTTP status and the rows the provider named
    // (at most five, tokens only), where the status said only that the provider refused.
    ...(s.state === 'rejected' && s.journal?.phase === 'rejected' && lastError(s.journal)
      ? {last_error: lastError(s.journal)}
      : {}),
    suggested_reads: (Array.isArray(review.reads) ? review.reads : []).slice(0, 20).map((r: CompiledRequest) => ({
      method: r.method,
      path: r.path,
    })),
    next_safe_action:
      guidance[
        doubt
          ? doubt.key
          : planHolder
            ? planHolder.group
              ? 'plan_part_' + s.state
              : planHolder.held
                ? 'plan_' + (validationRejected ? 'validation_rejected' : s.state)
                : (s.state === 'expired' ? 'plan_expired_' : 'plan_') + (planHolder.plan ? 'detached' : 'orphaned')
            : validationRejected
              ? 'validation_rejected'
              : s.state
      ] ??
      guidance[validationRejected ? 'validation_rejected' : s.state] ??
      'Inspect the retained review before any action.',
    // Whether this reader may settle the outcome (accept_applied, or a replacement): the website shows the action then.
    may_resolve: resolvable,
    next_call: call,
    website_path: writeRecordPath(id),
    network_requests: 0,
    automatic_retry_of_mutation: false,
  };
}
