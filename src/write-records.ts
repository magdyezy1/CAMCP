import type {Store} from './store.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {ownsRecord} from './actor-identity.js';
import {reviewSummary} from './review-summary.js';
import {optional} from './workspace-core.js';
import {workspaceOwner} from './spend-policy.js';

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
export const writeRecordPath = (id: string) => '/operations?write_id=' + encodeURIComponent(id);
const withdrawnLegacy = (alias: string) =>
  `NOT EXISTS (SELECT 1 FROM documents c, json_each(c.data,'$.steps') s WHERE c.tenant_id=${alias}.tenant_id AND c.kind='campaign_run' AND json_extract(s.value,'$.review_id')=${alias}.id)
    AND NOT EXISTS (SELECT 1 FROM documents g, json_each(g.data,'$.parts') p WHERE g.tenant_id=${alias}.tenant_id AND g.kind='write_review_group' AND p.value=${alias}.id)`;
/**
 * The Operations projection of standalone reviews and groups. A review kept before reviews recorded their origin is
 * listed only while its outcome is uncertain and no plan step or group names it.
 */
export const writeFeedSQL = `SELECT d.id, 'write_review' AS kind, d.revision,
  max(coalesce(json_extract(d.data,'$.created_at'),json_extract(d.data,'$.expires_at')-300000,0),coalesce(i.created_at,0),
    coalesce(json_extract(o.data,'$.updated_at'),0),coalesce(json_extract(v.data,'$.checked_at'),0),
    coalesce(json_extract(r.data,'$.updated_at'),0)) AS at,
  json_object(
    'name',substr(coalesce(json_extract(d.data,'$.plan.action'),json_extract(d.data,'$.prepare_input.arguments.action'),
      json_extract(d.data,'$.prepare_input.arguments.operation'),d.id),1,200),
    'user_id',json_extract(d.data,'$.user_id'),'principal',json_extract(d.data,'$.principal'),
    'scopes',json_array(json_object('gateway',coalesce(json_extract(d.data,'$.plan.gateway'),json_extract(d.data,'$.gateway')),
      'connection_id',json_extract(d.data,'$.connection_id'),
      'account_id',coalesce(json_extract(d.data,'$.plan.accountId'),json_extract(d.data,'$.account_id')))),
    'claim_state',i.state,'claim_at',i.created_at,
    'success',CASE WHEN i.state='complete' AND json_valid(i.result) THEN json_extract(i.result,'$.success') END,
    'reconciled',CASE WHEN i.state='complete' AND json_valid(i.result) THEN json_extract(i.result,'$.reconciled') END,
    'verification',json_extract(v.data,'$.status'),
    'expires_at',json_extract(d.data,'$.expires_at'),
    'journal_phase',json_extract(o.data,'$.phase'),
    'error_code',CASE WHEN json_extract(o.data,'$.phase')='not_sent' THEN substr(json_extract(o.data,'$.events[#-1].code'),1,101) END,
    'superseded_by',json_extract(r.data,'$.superseded_by'),
    'group',CASE WHEN d.kind='write_review_group' THEN 1 ELSE 0 END
  ) AS metadata
  FROM documents d
  LEFT JOIN idempotency i ON i.tenant_id=d.tenant_id AND i.key=d.id
  LEFT JOIN documents o ON o.tenant_id=d.tenant_id AND o.kind='operation_journal' AND o.id=d.id
  LEFT JOIN documents v ON v.tenant_id=d.tenant_id AND v.kind='write_verification' AND v.id=d.id
  LEFT JOIN documents r ON r.tenant_id=d.tenant_id AND r.kind='write_reconciliation' AND r.id=d.id
  WHERE d.tenant_id=? AND d.kind IN ('write_review','write_review_group')
    AND (json_extract(d.data,'$.origin')='standalone'
      OR (json_extract(d.data,'$.origin') IS NULL AND d.kind='write_review' AND i.state='uncertain' AND ${withdrawnLegacy('d')}))`;

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
 * One write record's state, from its claim, read-back and reconciliation. Uncertain, expired, unsubmitted and not-sent
 * reviews need a person; complete, verified, reconciled and superseded ones do not.
 */
export function writeRecordState(p: JsonObject, now = Date.now()): string {
  if (typeof p.superseded_by === 'string' && p.superseded_by) return 'superseded';
  if (p.claim_state === 'complete') {
    if (p.success === false || p.success === 0) return 'failed';
    if (typeof p.verification === 'string' && verificationStates[p.verification])
      return verificationStates[p.verification]!;
    return p.reconciled === true || p.reconciled === 1 ? 'reconciled' : 'complete';
  }
  if (p.claim_state === 'uncertain') return 'uncertain';
  if (p.claim_state === 'pending')
    return Number(p.claim_at) > 0 && now - Number(p.claim_at) >= pendingUncertainMs ? 'uncertain' : 'executing';
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
    : state === 'uncertain' || state === 'complete'
      ? state
      : phase === 'not_sent'
        ? 'not_sent'
        : 'none';
function claimRow(store: Store, tenant: string, id: string): JsonObject | undefined {
  return store.db
    .prepare('SELECT state,result,created_at FROM idempotency WHERE tenant_id=? AND key=?')
    .get(tenant, id) as JsonObject | undefined;
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
/** The state of one retained review, from the store alone. */
function recordState(store: Store, tenant: string, id: string, review: JsonObject, now: number) {
  const claim = claimRow(store, tenant, id),
    result = claim?.state === 'complete' && typeof claim.result === 'string' ? JSON.parse(claim.result) : undefined,
    journal = optional(store, tenant, 'operation_journal', id),
    verification = optional(store, tenant, 'write_verification', id),
    reconciliation = optional(store, tenant, 'write_reconciliation', id);
  const state = writeRecordState(
    {
      claim_state: claim?.state,
      claim_at: claim?.created_at,
      success: result?.success,
      reconciled: result?.reconciled,
      verification: verification?.status,
      expires_at: review.expires_at,
      journal_phase: journal?.phase,
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
function nextCall(id: string, review: JsonObject, state: string, actor: Actor): JsonObject | null {
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
  if (state === 'expired') {
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
  if (state === 'uncertain') return {tool: 'amcp_write', arguments: {action: 'reconcile', review_id: id}};
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
  const call = nextCall(id, review, s.state, actor);
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
    reconciliation: s.reconciliation
      ? {
          reconciliation_id: s.reconciliation.reconciliation_id,
          classification: s.reconciliation.classification,
          checked_at: iso(s.reconciliation.checked_at),
          ...(s.reconciliation.accepted_at ? {accepted_at: iso(s.reconciliation.accepted_at)} : {}),
          ...(s.reconciliation.superseded_by ? {superseded_by: s.reconciliation.superseded_by} : {}),
        }
      : null,
    ...(review.supersedes_uncertain ? {supersedes_uncertain: review.supersedes_uncertain} : {}),
    required_acknowledgements: review.required_acknowledgements ?? null,
    suggested_reads: (Array.isArray(review.reads) ? review.reads : []).slice(0, 20).map((r: CompiledRequest) => ({
      method: r.method,
      path: r.path,
    })),
    next_safe_action: guidance[s.state] ?? 'Inspect the retained review before any action.',
    // Whether this reader may settle the outcome (accept_applied, or a replacement): the website shows the action then.
    may_resolve: mayResolve(store, actor, review),
    next_call: call,
    website_path: writeRecordPath(id),
    network_requests: 0,
    automatic_retry_of_mutation: false,
  };
}
