import {MirrorError} from './errors.js';
import {applyExecutionRisk} from './execution-risk.js';
import {writeEffects} from './write-effects.js';
import {
  approvalModes,
  assertTwoStepSession,
  spendPolicyKey,
  workspaceDefaultPolicyId,
  workspaceOwner,
} from './spend-policy.js';
import {sha256, stable} from './security.js';
import {optional} from './workspace-core.js';
import {principalOf} from './actor-identity.js';
import {reviewSummary} from './review-summary.js';
import type {Store} from './store.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';

/**
 * Human approval of reviewed executions (WRT-09, owner decisions P1 and P5). The acknowledgement flags an AI client
 * sends at execute (spend_change_confirmed, cap_override_confirmed, destructive_confirmed) record that the user
 * approved, but the user's approval reaches AMCP only through the client. Three owner controls add a person's own
 * approval on the AMCP website, outside the AI client:
 *
 * - `approval_mode` in the spending policy (account or workspace default; default `assistant_ack`, today's
 *   behaviour). `website_approval`: executing a review that changes spending, goes beyond an owner cap or deletes needs
 *   a signed-in member's approval of that exact review on the website. `distinct_approver`: that member must be another
 *   person than the one who prepared it, or the workspace owner.
 * - `require_destructive_confirmation` (the opt-in destructive_confirmed tier, P5): a review that deletes needs
 *   destructive_confirmed=true at execute, named in execute_requirements at prepare.
 * - Always (P5): only the workspace owner executes a review beyond a cap under `confirm`, or the owner approves it on
 *   the website first (CAP_OVERRIDE_OWNER_REQUIRED).
 *
 * An approval is a `write_approval` document keyed by the review (or group) id, bound to the review's fingerprint and
 * the approver, minted only by the website route (a session with CSRF and recent sign-in, never an MCP tool). The
 * review it names is executed at most once, so an approval is used at most once; one for another fingerprint, an
 * expired review or the preparer under `distinct_approver` is refused.
 */
export {approvalModes};
export type ApprovalMode = (typeof approvalModes)[number];
export type ApprovalClass = 'spend_affecting' | 'cap_override' | 'destructive';
/** The approval policy of an account: its own spending policy, otherwise the workspace default. */
export function reviewApprovalPolicy(
  store: Store,
  tenant: string,
  gateway: string,
  account: string,
): {approval_mode: ApprovalMode; require_destructive_confirmation: boolean; policy_id: string | null} {
  const read = (id: string) =>
    store.db
      .prepare("SELECT data FROM documents WHERE tenant_id=? AND kind='spend_policy' AND id=?")
      .get(tenant, id) as {data: string} | undefined;
  const accountKey = spendPolicyKey(gateway, account),
    own = read(accountKey),
    row = own ?? read(workspaceDefaultPolicyId),
    data = row ? (JSON.parse(row.data) as JsonObject) : {};
  return {
    approval_mode: approvalModes.includes(data.approval_mode) ? data.approval_mode : 'assistant_ack',
    require_destructive_confirmation: data.require_destructive_confirmation === true,
    policy_id: row ? (own ? accountKey : workspaceDefaultPolicyId) : null,
  };
}
/** The website page where a person approves a review or group. */
export const approvalPath = (reviewId: string) => '/operations?approve=' + encodeURIComponent(reviewId);
/** Whether the reviewed request deletes or removes, judged with its reviewed state as the deletion policy judges it. */
export function destructiveRequest(plan: CompiledRequest, state: unknown): boolean {
  const before = Array.isArray(state) ? state : [];
  return writeEffects(applyExecutionRisk(plan, before), before)?.destructive === true;
}
/** What in a review needs a person's approval under an approval mode. */
export function approvalClasses(acknowledgements: readonly unknown[], destructive: boolean): ApprovalClass[] {
  return [
    ...(acknowledgements.includes('spend_change_confirmed') ? (['spend_affecting'] as const) : []),
    ...(acknowledgements.includes('cap_override_confirmed') ? (['cap_override'] as const) : []),
    ...(destructive ? (['destructive'] as const) : []),
  ];
}
const approverText = (mode: ApprovalMode) =>
  mode === 'distinct_approver'
    ? 'Another member than the one who prepared it, or the workspace owner, approves it on the AMCP website.'
    : 'A signed-in member with write access approves it on the AMCP website.';
/**
 * What prepare says about approval (WRT-09, P5): undefined when nothing beyond the acknowledgements is needed. A review
 * beyond a cap prepared by anyone but the owner names the owner; an approval mode names its classes and approver.
 */
export function approvalNotice(
  store: Store,
  actor: Actor,
  plan: CompiledRequest,
  reviewId: string,
  acknowledgements: readonly unknown[],
  destructive: boolean,
): JsonObject | undefined {
  const policy = reviewApprovalPolicy(store, actor.tenantId, plan.gateway, plan.accountId ?? ''),
    classes = approvalClasses(acknowledgements, destructive),
    byMode = policy.approval_mode !== 'assistant_ack' && classes.length > 0,
    ownerCap = acknowledgements.includes('cap_override_confirmed') && !workspaceOwner(store, actor);
  if (!byMode && !ownerCap) return undefined;
  return {
    required: true,
    mode: policy.approval_mode,
    classes,
    ...(ownerCap ? {owner_required: 'cap_override'} : {}),
    approver: byMode
      ? approverText(policy.approval_mode)
      : 'Only the workspace owner executes a change beyond a spending cap, or approves it on the AMCP website first.',
    website_path: approvalPath(reviewId),
    meaning:
      'Execute is refused until a person approves this exact review on the AMCP website (open website_path); the approval is bound to this review’s fingerprint and expires with it. The acknowledgement flags are still needed.',
  };
}
/** A group's fingerprint for approval: its id and every part's own fingerprint, in order. */
function groupFingerprint(store: Store, tenant: string, group: JsonObject): string {
  const parts: string[] = Array.isArray(group.parts) ? group.parts : [];
  return sha256(
    stable({
      group: group.id,
      parts: parts.map(part => optional(store, tenant, 'write_review', part)?.fingerprint ?? null),
    }),
  );
}
/** The retained review or group a person approves, with the fingerprint an approval binds. */
function approvalSubject(store: Store, tenant: string, id: string) {
  const group = optional(store, tenant, 'write_review_group', id),
    review = group ?? optional(store, tenant, 'write_review', id);
  if (!review) throw new MirrorError('NOT_FOUND', 'No reviewed write with this review_id in this workspace.', {}, 404);
  const parts: JsonObject[] = group
    ? (group.parts as string[]).map(p => optional(store, tenant, 'write_review', p)).filter((p): p is JsonObject => !!p)
    : [review];
  const plan = parts[0]?.plan as CompiledRequest | undefined;
  if (!plan) throw new MirrorError('NOT_FOUND', 'This review has no retained request.', {}, 404);
  const acknowledgements = [
    ...new Set(parts.flatMap(p => (Array.isArray(p.required_acknowledgements) ? p.required_acknowledgements : []))),
  ];
  const destructive = parts.some(p => destructiveRequest(p.plan as CompiledRequest, p.state));
  return {
    id,
    review,
    group: !!group,
    plan,
    parts,
    acknowledgements,
    destructive,
    fingerprint: group ? groupFingerprint(store, tenant, group) : (review.fingerprint as string),
  };
}
/**
 * The approval that covers a review: its own, or its group's (a group is approved once for all its parts). `mismatch`
 * is true when an approval exists but is bound to another fingerprint (the review changed after it was approved).
 */
export function approvalFor(
  store: Store,
  tenant: string,
  reviewId: string,
): {approval?: JsonObject; subject: string; mismatch: boolean} {
  const row = store.db
    .prepare(
      "SELECT d.id FROM documents d, json_each(d.data,'$.parts') p WHERE d.tenant_id=? AND d.kind='write_review_group' AND p.value=? LIMIT 1",
    )
    .get(tenant, reviewId) as {id: string} | undefined;
  const subject = row?.id ?? reviewId,
    approval = optional(store, tenant, 'write_approval', subject);
  if (!approval) return {subject, mismatch: false};
  const expected = approvalSubject(store, tenant, subject).fingerprint;
  return approval.fingerprint === expected ? {approval, subject, mismatch: false} : {subject, mismatch: true};
}
const humanApprovalRequired = (subject: string, details: JsonObject, message: string) =>
  new MirrorError(
    'HUMAN_APPROVAL_REQUIRED',
    message,
    {
      ...details,
      review_id: subject,
      website_path: approvalPath(subject),
      submission: 'not_sent',
      next_call: {tool: 'amcp_write', arguments: {action: 'status', review_id: subject}},
    },
    403,
  );
/**
 * The execute-time checks (WRT-09, P5) a review must pass before anything is claimed or sent: the destructive tier's
 * acknowledgement, then a person's website approval when the account's approval mode needs one. Returns the approval
 * used, for the audit, or undefined.
 */
export function assertExecutionApproval(
  store: Store,
  actor: Actor,
  review: JsonObject,
  reviewId: string,
  input: JsonObject,
): JsonObject | undefined {
  const plan = review.plan as CompiledRequest,
    policy = reviewApprovalPolicy(store, actor.tenantId, plan.gateway, plan.accountId ?? ''),
    acknowledgements: unknown[] = Array.isArray(review.required_acknowledgements)
      ? review.required_acknowledgements
      : [],
    destructive = destructiveRequest(plan, review.state);
  // The owner's tier applies to reviews prepared before it was turned on too: the deletion is named at execute.
  if (
    (acknowledgements.includes('destructive_confirmed') || (policy.require_destructive_confirmation && destructive)) &&
    input.destructive_confirmed !== true
  )
    throw new MirrorError(
      'DESTRUCTIVE_CONFIRMATION_REQUIRED',
      'The owner requires an explicit acknowledgement before anything is deleted on this account. Nothing was sent. Show the user what this review deletes, and execute again with destructive_confirmed=true once they approve.',
      {review_id: reviewId, policy_id: policy.policy_id, submission: 'not_sent'},
    );
  const classes = approvalClasses(acknowledgements, destructive);
  if (policy.approval_mode === 'assistant_ack' || !classes.length) return undefined;
  const found = approvalFor(store, actor.tenantId, reviewId);
  if (found.mismatch)
    throw humanApprovalRequired(
      found.subject,
      {mode: policy.approval_mode, classes, reason: 'approval_fingerprint_mismatch'},
      'The website approval of this review is bound to another request: the review changed after it was approved. Nothing was sent; a person approves this exact review on the AMCP website.',
    );
  const approval = found.approval;
  if (!approval)
    throw humanApprovalRequired(
      found.subject,
      {mode: policy.approval_mode, classes},
      'The owner requires a person’s approval on the AMCP website before this change is executed. Nothing was sent. Ask a member to open website_path and approve this exact review, then execute it again.',
    );
  if (
    policy.approval_mode === 'distinct_approver' &&
    approval.approver_is_owner !== true &&
    approval.approver_principal === (review.principal ?? review.user_id)
  )
    throw humanApprovalRequired(
      found.subject,
      {mode: policy.approval_mode, classes, reason: 'approver_prepared_it'},
      'The owner requires the approval of another member than the one who prepared this review. Nothing was sent.',
    );
  return approval;
}
/**
 * The P5 rule: only the workspace owner executes a change beyond a spending cap under `confirm`, or the owner approved
 * this exact review on the website. Checked with the caps exceeded now, before anything is claimed or sent.
 */
export function assertCapOverrideOwner(store: Store, actor: Actor, exceeded: JsonObject[], reviewId: string): void {
  if (!exceeded.length || workspaceOwner(store, actor)) return;
  const found = approvalFor(store, actor.tenantId, reviewId);
  if (found.approval?.approver_is_owner === true) return;
  throw new MirrorError(
    'CAP_OVERRIDE_OWNER_REQUIRED',
    'Only the workspace owner executes a change beyond a spending cap the owner set. Nothing was sent. The owner executes this review, or approves it on the AMCP website first (website_path); then execute it again with cap_override_confirmed=true.',
    {
      review_id: found.subject,
      exceeded,
      website_path: approvalPath(found.subject),
      submission: 'not_sent',
    },
    403,
  );
}
/** Who may see and approve reviews on the website: an active member who can change things, never a test account. */
function assertApprover(store: Store, actor: Actor): void {
  store.assertActorActive(actor);
  if (actor.role === 'reader' || actor.membershipRole === 'viewer' || actor.testAccount === true)
    throw new MirrorError('FORBIDDEN', 'Only a member who can approve changes may open or approve reviews.', {}, 403);
}
/** A review or group as a person sees it before approving (website). Nothing is sent; the request body is not shown. */
export function approvalView(store: Store, actor: Actor, reviewId: unknown): JsonObject {
  assertApprover(store, actor);
  if (typeof reviewId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(reviewId))
    throw new MirrorError('INVALID_ARGUMENT', 'Send the review_id that prepare returned.', {field: 'review_id'});
  const s = approvalSubject(store, actor.tenantId, reviewId);
  store.resolveConnection(actor, s.plan.gateway, s.plan.accountId, s.review.connection_id);
  const policy = reviewApprovalPolicy(store, actor.tenantId, s.plan.gateway, s.plan.accountId ?? ''),
    classes = approvalClasses(s.acknowledgements, s.destructive),
    byMode = policy.approval_mode !== 'assistant_ack' && classes.length > 0,
    capOwner = s.acknowledgements.includes('cap_override_confirmed'),
    owner = workspaceOwner(store, actor),
    found = optional(store, actor.tenantId, 'write_approval', reviewId),
    executed = !!store.db
      .prepare('SELECT 1 FROM idempotency WHERE tenant_id=? AND key=?')
      .get(actor.tenantId, s.group ? s.parts[0]?.id : reviewId);
  const refusal = approvalRefusal(store, actor, s, policy.approval_mode, byMode, capOwner, owner, executed);
  return {
    review_id: reviewId,
    group: s.group,
    ...(s.group ? {parts: s.parts.length} : {}),
    gateway: s.plan.gateway,
    account_id: s.plan.accountId ?? null,
    connection_id: s.review.connection_id,
    action: s.plan.action,
    summary: reviewSummary(s.plan, Array.isArray(s.parts[0]?.state) ? s.parts[0]!.state : []),
    reasons: s.parts[0]?.approval_context?.reasons ?? [],
    effects: s.parts[0]?.approval_context?.effects ?? null,
    prepared_by: s.review.principal ?? s.review.user_id ?? null,
    prepared_at: typeof s.review.created_at === 'number' ? new Date(s.review.created_at).toISOString() : null,
    expires_at: new Date(Number(s.review.expires_at)).toISOString(),
    fingerprint: s.fingerprint,
    mode: policy.approval_mode,
    classes,
    owner_required: capOwner,
    approval:
      found && found.fingerprint === s.fingerprint
        ? {
            approver: found.approver_principal,
            approver_is_owner: found.approver_is_owner,
            approved_at: found.approved_at,
          }
        : null,
    may_approve: !refusal,
    ...(refusal ? {refusal} : {}),
    network_requests: 0,
  };
}
function approvalRefusal(
  store: Store,
  actor: Actor,
  s: ReturnType<typeof approvalSubject>,
  mode: ApprovalMode,
  byMode: boolean,
  capOwner: boolean,
  owner: boolean,
  executed: boolean,
): JsonObject | undefined {
  if (executed) return {code: 'REVIEW_ALREADY_EXECUTED', message: 'This review was already executed.'};
  if (Number(s.review.expires_at) <= Date.now())
    return {code: 'REVIEW_EXPIRED', message: 'This review expired. Prepare it again and approve the new review.'};
  if (!byMode && !capOwner)
    return {
      code: 'APPROVAL_NOT_REQUIRED',
      message: 'This review needs no approval on the website: the user’s acknowledgements in the AI client suffice.',
    };
  if (!byMode && capOwner && !owner)
    return {code: 'OWNER_REQUIRED', message: 'Only the workspace owner approves a change beyond a spending cap.'};
  if (mode === 'distinct_approver' && !owner && principalOf(actor) === (s.review.principal ?? s.review.user_id))
    return {
      code: 'DISTINCT_APPROVER_REQUIRED',
      message: 'Another member than the one who prepared this review approves it, or the workspace owner.',
    };
  return undefined;
}
/**
 * A person approves a review or group on the website (WRT-09): bound to the fingerprint the page showed, to the
 * approver and to the review's window. Audited; nothing is sent to any provider.
 */
export function approveReview(store: Store, actor: Actor, reviewId: unknown, input: JsonObject): JsonObject {
  assertApprover(store, actor);
  assertTwoStepSession(actor, 'approve_review');
  const view = approvalView(store, actor, reviewId);
  if (input.confirmed !== true)
    throw new MirrorError('APPROVAL_CONFIRMATION_REQUIRED', 'Confirm that you approve this exact review.', {}, 400);
  if (input.fingerprint !== view.fingerprint)
    throw new MirrorError(
      'REVIEW_CHANGED',
      'This review is not the one shown: its fingerprint differs. Open it again and approve what you see.',
      {},
      409,
    );
  if (!view.may_approve)
    throw new MirrorError(
      view.refusal.code,
      view.refusal.message,
      {review_id: reviewId},
      view.refusal.code === 'APPROVAL_NOT_REQUIRED' ? 400 : 409,
    );
  const owner = workspaceOwner(store, actor),
    approval = {
      review_id: reviewId,
      fingerprint: view.fingerprint,
      approver: actor.userId,
      approver_principal: principalOf(actor),
      approver_is_owner: owner,
      approved_at: Date.now(),
      expires_at: Date.parse(view.expires_at),
      classes: view.classes,
    };
  store.putDocument(actor.tenantId, 'write_approval', reviewId as string, approval);
  store.appendAudit(actor.tenantId, reviewId as string, {
    event: 'write_approved',
    approver: actor.userId,
    approver_is_owner: owner,
    fingerprint: view.fingerprint,
    classes: view.classes,
    gateway: view.gateway,
    account_id: view.account_id,
    connection_id: view.connection_id,
    vendor_writes: 0,
  });
  return {
    ...view,
    approval: {approver: approval.approver_principal, approver_is_owner: owner, approved_at: approval.approved_at},
    may_approve: false,
  };
}
