import type {Store} from './store.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {ownsRecord} from './actor-identity.js';
import {reviewSummary} from './review-summary.js';
import {optional} from './workspace-core.js';
import {workspaceOwner} from './spend-policy.js';
import {approvalStatus} from './write-approval.js';
import {writeClaim} from './job-repository.js';
import {providerCheckView} from './provider-error-core.js';

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
/** The state of one retained review, from the store alone. */
function recordState(store: Store, tenant: string, id: string, review: JsonObject, now: number) {
  const claim = claimRow(store, tenant, id),
    result = claim?.state === 'complete' && typeof claim.result === 'string' ? JSON.parse(claim.result) : undefined,
    journal = optional(store, tenant, 'operation_journal', id),
    verification = optional(store, tenant, 'write_verification', id),
    stored = optional(store, tenant, 'write_reconciliation', id),
    // A supersede whose replacement ended is not shown (a status lifts it, src/write-review.ts): only one in force seals the review.
    reconciliation = stored?.superseded_by && !supersededBy(store, tenant, stored, now) ? unsealed(stored) : stored;
  const state = writeRecordState(
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
    },
    now,
  );
  return {claim, result, journal, verification, reconciliation, state};
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
): JsonObject | null {
  if (['unsubmitted', 'not_sent'].includes(state)) {
    const flags = (Array.isArray(review.required_acknowledgements) ? review.required_acknowledgements : []).filter(
      (k: unknown) => typeof k === 'string' && k !== 'confirmed',
    );
    return {
      tool: 'amcp_write',
      arguments: {action: 'execute', review_id: id},
      add_after_user_approval: Object.fromEntries(['confirmed', ...flags].map((k: string) => [k, true])),
    };
  }
  // An expired review, or one the provider refused without applying it (its key is retired, CMP-04), is prepared again.
  if (state === 'expired' || state === 'rejected') {
    const input = review.prepare_input as JsonObject | undefined;
    if (!input) return null;
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
    if (review.user_id === actor.userId)
      return {tool: 'amcp_write', arguments: {action: 'prepare', ...input}, ...correction};
    return {
      tool: 'amcp_write',
      arguments: {
        action: 'prepare',
        ...(typeof input.gateway === 'string' ? {gateway: input.gateway} : {}),
        ...(typeof input.connection_id === 'string' ? {connection_id: input.connection_id} : {}),
      },
      arguments_required: 'The original native arguments are shown only to the person who prepared this review.',
      ...correction,
    };
  }
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
  executing: 'The request is being sent now. Read this status again in a moment; never execute it twice.',
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
function partSummary(store: Store, tenant: string, id: string, now: number): JsonObject {
  const review = optional(store, tenant, 'write_review', id);
  if (!review) return {review_id: id, state: 'unknown'};
  return {review_id: id, state: recordState(store, tenant, id, review, now).state};
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
  const parts = group
    ? (review.parts as string[]).map((part, i) => ({part: i + 1, ...partSummary(store, actor.tenantId, part, now)}))
    : undefined;
  const resolvable = mayResolve(store, actor, review),
    call = nextCall(id, review, s.state, actor, s.reconciliation, resolvable),
    // WRT-09: whether a person has approved this review on the website, while it can still be executed.
    approval = s.state === 'unsubmitted' || s.state === 'not_sent' ? approvalStatus(store, actor, id) : undefined,
    // A review the provider rejected at validate-only (r25-field3-errors, AMCP-03): never claimed, so the state is rejected without a key.
    validationRejected = s.state === 'rejected' && !s.claim && review.provider_check?.status === 'provider_rejected';
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
    ...(review.provider_check ? {provider_check: providerCheckView(review.provider_check)} : {}),
    suggested_reads: (Array.isArray(review.reads) ? review.reads : []).slice(0, 20).map((r: CompiledRequest) => ({
      method: r.method,
      path: r.path,
    })),
    next_safe_action:
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
