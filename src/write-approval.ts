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
import {doorPrincipal, principalOf, viaReviewerDoor} from './actor-identity.js';
import {reviewSummary} from './review-summary.js';
import {storedAccountOf} from './account-metadata.js';
import type {Store} from './store.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';

/**
 * Human approval of reviewed executions (WRT-09, owner decisions P1 and P5 of 2026-10-11). The acknowledgement flags an
 * AI client sends at execute (spend_change_confirmed, cap_override_confirmed, destructive_confirmed) record that the
 * user approved, but the user's approval reaches AMCP only through the client. A person's own approval on the AMCP
 * website, outside the AI client, comes in through one rule and two owner settings that are off by default:
 *
 * - Beyond a cap, the owner (P5, always on): only the workspace owner executes a review beyond a cap under `confirm`,
 *   or the owner approves it on the website first (CAP_OVERRIDE_OWNER_REQUIRED). Before P5 this was the opt-in
 *   `cap_override_owner_only`, and a member with write access executed beyond a cap with cap_override_confirmed alone;
 *   no policy turns the rule off.
 * - `approval_mode` in the spending policy (account or workspace default; default `assistant_ack`, today's
 *   behaviour). `website_approval`: executing a review that changes spending, goes beyond an owner cap or deletes needs
 *   a signed-in member's approval of that exact review on the website. `distinct_approver`: that member must be another
 *   person than the one who prepared it, or the workspace owner (P1's distinct approver for spending plans).
 * - `require_destructive_confirmation` (the opt-in destructive_confirmed tier, P5): a review that deletes needs
 *   destructive_confirmed=true at execute, named in execute_requirements at prepare.
 *
 * An approval is a `write_approval` document keyed by the review (or group) id, bound to the review's fingerprint and
 * the approver, minted only by the website route (a session with CSRF and recent sign-in, never an MCP tool). The
 * review it names is executed at most once, so an approval is used at most once; one for another fingerprint, an
 * expired review or the preparer under `distinct_approver` is refused.
 */
export {approvalModes};
export type ApprovalMode = (typeof approvalModes)[number];
export type ApprovalClass = 'spend_affecting' | 'cap_override' | 'destructive';
/** How strict an approval mode is, in the order approvalModes lists them; an unknown value counts as the default. */
const modeRank = (mode: unknown) => Math.max(0, approvalModes.indexOf(mode as ApprovalMode));
/**
 * The approval policy of an account: the stricter of its own spending policy and the workspace default, setting by
 * setting. Unlike caps, where an account's own policy replaces the default, an account policy saved for its caps never
 * drops the approval the owner set for every account: it can only add to it. `policy_id` names the policy that turned
 * the destructive tier on. A stored `cap_override_owner_only` is no longer read: the owner rule beyond a cap always
 * applies (P5).
 */
export function reviewApprovalPolicy(
  store: Store,
  tenant: string,
  gateway: string,
  account: string,
): {
  approval_mode: ApprovalMode;
  require_destructive_confirmation: boolean;
  policy_id: string | null;
} {
  const read = (id: string) => {
    const row = store.db
      .prepare("SELECT data FROM documents WHERE tenant_id=? AND kind='spend_policy' AND id=?")
      .get(tenant, id) as {data: string} | undefined;
    return row ? (JSON.parse(row.data) as JsonObject) : undefined;
  };
  const accountKey = spendPolicyKey(gateway, account),
    policies: [string, JsonObject | undefined][] = [
      [accountKey, read(accountKey)],
      [workspaceDefaultPolicyId, read(workspaceDefaultPolicyId)],
    ],
    mode = policies
      .map(([, p]) => p?.approval_mode)
      .reduce<ApprovalMode>((a, b) => (modeRank(b) > modeRank(a) ? b : a), 'assistant_ack'),
    destructive = policies.find(([, p]) => p?.require_destructive_confirmation === true);
  return {
    approval_mode: mode,
    require_destructive_confirmation: !!destructive,
    policy_id: destructive?.[0] ?? null,
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
const ownerCapText =
  'Only the workspace owner executes a change beyond a spending cap, or approves it on the AMCP website first.';
/**
 * What prepare says about approval (WRT-09, P5): undefined when nothing beyond the acknowledgements is needed. A review
 * beyond a cap prepared by anyone but the owner names the owner (P5); an approval mode names its classes and approver.
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
    approver: [...(byMode ? [approverText(policy.approval_mode)] : []), ...(ownerCap ? [ownerCapText] : [])].join(' '),
    website_path: approvalPath(reviewId),
    meaning:
      'Execute is refused until a person approves this exact review on the AMCP website (open website_path); the approval is bound to this review’s fingerprint and expires with it. The acknowledgement flags are still needed.',
  };
}
/** The id a person approves for a review: its group's when it is a part of one (a group is approved once, as a whole). */
function approvalSubjectId(store: Store, tenant: string, reviewId: string): string {
  const row = store.db
    .prepare(
      "SELECT d.id FROM documents d, json_each(d.data,'$.parts') p WHERE d.tenant_id=? AND d.kind='write_review_group' AND p.value=? LIMIT 1",
    )
    .get(tenant, reviewId) as {id: string} | undefined;
  return row?.id ?? reviewId;
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
  const listed = (r: JsonObject | undefined): unknown[] =>
    Array.isArray(r?.required_acknowledgements) ? r.required_acknowledgements : [];
  // A group's own acknowledgements include a cap only its parts together cross (write-groups.ts).
  const acknowledgements = [...new Set([...listed(group), ...parts.flatMap(listed)])];
  const destructive = parts.some(p => destructiveRequest(p.plan as CompiledRequest, p.state));
  const claimed = (key: unknown) =>
    typeof key === 'string' &&
    !!store.db.prepare('SELECT 1 FROM idempotency WHERE tenant_id=? AND key=?').get(tenant, key);
  return {
    id,
    review,
    group: !!group,
    plan,
    parts,
    acknowledgements,
    destructive,
    fingerprint: group ? groupFingerprint(store, tenant, group) : (review.fingerprint as string),
    // Claimed: being sent, sent or settled (a group by its own record or any part's claim). A refusal before anything
    // was sent releases its claim (D12), so such a review can still be approved and executed.
    executed: claimed(id) || (!!group && parts.some(p => claimed(p.id))),
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
  const subject = approvalSubjectId(store, tenant, reviewId),
    approval = optional(store, tenant, 'write_approval', subject);
  if (!approval) return {subject, mismatch: false};
  const expected = approvalSubject(store, tenant, subject).fingerprint;
  return approval.fingerprint === expected ? {approval, subject, mismatch: false} : {subject, mismatch: true};
}
/**
 * What `amcp_write status` says about a review's website approval (WRT-09): undefined when it needs none, otherwise
 * whether a person has approved this exact review and where. It reads AMCP alone.
 */
export function approvalStatus(store: Store, actor: Actor, reviewId: string): JsonObject | undefined {
  const subject = approvalSubjectId(store, actor.tenantId, reviewId);
  let s: ReturnType<typeof approvalSubject>;
  try {
    s = approvalSubject(store, actor.tenantId, subject);
  } catch {
    return undefined;
  }
  const policy = reviewApprovalPolicy(store, actor.tenantId, s.plan.gateway, s.plan.accountId ?? ''),
    classes = approvalClasses(s.acknowledgements, s.destructive),
    byMode = policy.approval_mode !== 'assistant_ack' && classes.length > 0,
    // As at prepare (P5): the owner executes a change beyond a cap without an approval, and anyone else needs the
    // owner's.
    ownerCap = s.acknowledgements.includes('cap_override_confirmed') && !workspaceOwner(store, actor);
  if (!byMode && !ownerCap) return undefined;
  const found = optional(store, actor.tenantId, 'write_approval', subject),
    current = found?.fingerprint === s.fingerprint ? found : undefined;
  return {
    mode: policy.approval_mode,
    classes,
    ...(ownerCap ? {owner_required: 'cap_override'} : {}),
    approved: !!current,
    ...(current ? {approver_is_owner: current.approver_is_owner === true, approved_at: iso(current.approved_at)} : {}),
    ...(found && !current ? {approval_fingerprint_mismatch: true} : {}),
    website_path: approvalPath(subject),
  };
}
const iso = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? new Date(v).toISOString() : null);
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
  return modeApproval(
    store,
    actor,
    reviewId,
    policy.approval_mode,
    approvalClasses(acknowledgements, destructive),
    review.principal ?? review.user_id,
  );
}
/**
 * A group's own check before its first part is sent (WRT-09): its approval mode applies to what the parts do together,
 * a cap only the whole group crosses now included, which no part's own check sees. Returns the approval used, or
 * undefined.
 */
export function assertGroupApproval(
  store: Store,
  actor: Actor,
  groupId: string,
  capExceeded: boolean,
): JsonObject | undefined {
  const s = approvalSubject(store, actor.tenantId, groupId),
    policy = reviewApprovalPolicy(store, actor.tenantId, s.plan.gateway, s.plan.accountId ?? ''),
    acknowledgements = capExceeded ? [...s.acknowledgements, 'cap_override_confirmed'] : s.acknowledgements;
  return modeApproval(
    store,
    actor,
    groupId,
    policy.approval_mode,
    approvalClasses(acknowledgements, s.destructive),
    s.review.principal ?? s.review.user_id,
  );
}
/** The website approval an approval mode needs for these classes: present, of this exact review, by an eligible person. */
function modeApproval(
  store: Store,
  actor: Actor,
  reviewId: string,
  mode: ApprovalMode,
  classes: ApprovalClass[],
  preparer: unknown,
): JsonObject | undefined {
  if (mode === 'assistant_ack' || !classes.length) return undefined;
  const found = approvalFor(store, actor.tenantId, reviewId);
  if (found.mismatch)
    throw humanApprovalRequired(
      found.subject,
      {mode, classes, reason: 'approval_fingerprint_mismatch'},
      'The website approval of this review is bound to another request: the review changed after it was approved. Nothing was sent; a person approves this exact review on the AMCP website.',
    );
  const approval = found.approval;
  if (!approval)
    throw humanApprovalRequired(
      found.subject,
      {mode, classes},
      'The owner requires a person’s approval on the AMCP website before this change is executed. Nothing was sent. Ask a member to open website_path and approve this exact review, then execute it again.',
    );
  if (mode === 'distinct_approver' && approval.approver_is_owner !== true && approval.approver_principal === preparer)
    throw humanApprovalRequired(
      found.subject,
      {mode, classes, reason: 'approver_prepared_it'},
      'The owner requires the approval of another member than the one who prepared this review. Nothing was sent.',
    );
  // A door sign-in, and every key approved from one, is the same principal: AMCP cannot tell which person prepared the
  // review, so another member's own sign-in may be that same person. Only the owner's approval is distinct then.
  if (mode === 'distinct_approver' && approval.approver_is_owner !== true && unidentifiedPreparer(preparer))
    throw humanApprovalRequired(
      found.subject,
      {mode, classes, reason: 'preparer_unidentified'},
      'This review was prepared through a shared administrator sign-in or a key approved from one, which AMCP cannot tie to one person, so only the workspace owner’s approval counts. Nothing was sent.',
    );
  return approval;
}
/**
 * Whether a review's preparer is a person AMCP can tell apart from the members who approve: a door sign-in and every
 * key approved from a door are one principal (src/actor-identity.ts), and a review without a recorded preparer is
 * treated the same way.
 */
const unidentifiedPreparer = (preparer: unknown) =>
  typeof preparer !== 'string' || !preparer || principalOf({userId: preparer}) === doorPrincipal;
/**
 * The P5 rule (owner decision of 2026-10-11, always on): only the workspace owner executes a change beyond a spending
 * cap under `confirm`, or the owner approved this exact review on the website. Before P5 the acknowledgement alone let
 * a member with write access execute beyond a cap unless the owner opted in (`cap_override_owner_only`). Checked with
 * the caps exceeded now, before anything is claimed or sent. `named`: prepare already named the cap; a cap crossed only
 * since (another change used the day's allowance) is not one the owner could approve for this review, so it is
 * prepared again. `plan` names the account the review belongs to (kept for callers; the rule is the same everywhere).
 */
export function assertCapOverrideOwner(
  store: Store,
  actor: Actor,
  _plan: Pick<CompiledRequest, 'gateway' | 'accountId'>,
  exceeded: JsonObject[],
  reviewId: string,
  named = true,
): void {
  if (!exceeded.length || workspaceOwner(store, actor)) return;
  const found = approvalFor(store, actor.tenantId, reviewId);
  if (found.approval?.approver_is_owner === true) return;
  if (!named)
    throw new MirrorError(
      'CAP_OVERRIDE_OWNER_REQUIRED',
      'This change now goes beyond a spending cap it did not cross when it was prepared, and only the workspace owner executes a change beyond a cap. Nothing was sent. Prepare it again: the new review names the cap, and the owner executes it or approves it on the AMCP website.',
      {review_id: found.subject, exceeded, prepare_again: true, submission: 'not_sent'},
      403,
    );
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
/** Who may see and approve reviews: active members and reviewers with write-capable access. */
function assertApprover(store: Store, actor: Actor): void {
  store.assertActorActive(actor);
  if (actor.role === 'reader' || actor.membershipRole === 'viewer')
    throw new MirrorError('FORBIDDEN', 'Only a member who can approve changes may open or approve reviews.', {}, 403);
}
/** A member's name for the approval page, when the workspace keeps one; the person's ID otherwise. */
function personName(store: Store, tenant: string, principal: unknown): string | null {
  if (typeof principal !== 'string' || !principal) return null;
  const users = !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='amcp_users'").get(),
    row = users
      ? (store.db
          .prepare(
            'SELECT u.name AS name FROM workspace_memberships m JOIN amcp_users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.user_id=? AND m.active=1',
          )
          .get(tenant, principal) as {name?: unknown} | undefined)
      : undefined;
  return typeof row?.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 200) : null;
}
/** Whether the page names a person as a reviewer: the door's person in the reviewers' own test workspace, which only the
 * reviewers' door reaches, rather than the door's ID (owner decision, 2026-10-31). */
function shownAsReviewer(actor: Actor, principal: unknown): boolean {
  return principal === doorPrincipal && viaReviewerDoor(actor);
}
/**
 * A review or group as a person sees it before approving (website). Nothing is sent; the request body is not shown. A
 * part of a group opens its group, which is approved as a whole.
 */
export function approvalView(store: Store, actor: Actor, reviewId: unknown): JsonObject {
  assertApprover(store, actor);
  if (typeof reviewId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(reviewId))
    throw new MirrorError('INVALID_ARGUMENT', 'Send the review_id that prepare returned.', {field: 'review_id'});
  const id = approvalSubjectId(store, actor.tenantId, reviewId),
    s = approvalSubject(store, actor.tenantId, id);
  store.resolveConnection(actor, s.plan.gateway, s.plan.accountId, s.review.connection_id);
  const policy = reviewApprovalPolicy(store, actor.tenantId, s.plan.gateway, s.plan.accountId ?? ''),
    classes = approvalClasses(s.acknowledgements, s.destructive),
    byMode = policy.approval_mode !== 'assistant_ack' && classes.length > 0,
    // Beyond a cap the owner's approval is needed (P5): the owner executes it, or approves it here for another member.
    capOwner = s.acknowledgements.includes('cap_override_confirmed'),
    owner = workspaceOwner(store, actor),
    found = optional(store, actor.tenantId, 'write_approval', id),
    current = found?.fingerprint === s.fingerprint ? found : undefined,
    context = s.review.approval_context ?? s.parts[0]?.approval_context,
    preparedBy = s.review.principal ?? s.review.user_id ?? null,
    // Whether the approval given meets the owner's approval mode now (the mode may have changed since it was given).
    // Under distinct_approver a review prepared through a door counts only the owner's approval (unidentifiedPreparer).
    meetsMode =
      !!current &&
      (policy.approval_mode !== 'distinct_approver' ||
        current.approver_is_owner === true ||
        (current.approver_principal !== preparedBy && !unidentifiedPreparer(preparedBy)));
  const refusal = approvalRefusal(actor, s, policy.approval_mode, byMode, capOwner, owner, current, meetsMode);
  return {
    review_id: id,
    group: s.group,
    ...(s.group
      ? {
          parts: s.parts.length,
          records: Array.isArray(s.review.records)
            ? s.review.records.reduce((a: number, n: unknown) => a + (typeof n === 'number' ? n : 0), 0)
            : null,
        }
      : {}),
    gateway: s.plan.gateway,
    account_id: s.plan.accountId ?? null,
    connection_id: s.review.connection_id,
    action: s.plan.action,
    summary: reviewSummary(
      s.plan,
      Array.isArray(s.parts[0]?.state) ? s.parts[0]!.state : [],
      storedAccountOf(store, actor, s.plan.gateway, s.plan.accountId, s.review.connection_id),
    ),
    reasons: Array.isArray(context?.reasons) ? context.reasons : [],
    effects: context?.effects ?? null,
    prepared_by: preparedBy,
    prepared_by_name: personName(store, actor.tenantId, preparedBy),
    ...(shownAsReviewer(actor, preparedBy) ? {prepared_by_kind: 'reviewer'} : {}),
    prepared_at: typeof s.review.created_at === 'number' ? new Date(s.review.created_at).toISOString() : null,
    expires_at: new Date(Number(s.review.expires_at)).toISOString(),
    fingerprint: s.fingerprint,
    mode: policy.approval_mode,
    classes,
    owner_required: capOwner,
    approval: current
      ? {
          approver: current.approver_principal,
          approver_name: personName(store, actor.tenantId, current.approver_principal),
          ...(shownAsReviewer(actor, current.approver_principal) ? {approver_kind: 'reviewer'} : {}),
          approver_is_owner: current.approver_is_owner === true,
          approved_at: current.approved_at,
        }
      : null,
    // Whether a member other than the owner still cannot execute it: no approval yet, one that no longer meets the mode,
    // or, beyond a cap, a member's approval where the owner's is needed.
    approval_pending: (byMode && !meetsMode) || (capOwner && current?.approver_is_owner !== true),
    may_approve: !refusal,
    ...(refusal ? {refusal} : {}),
    network_requests: 0,
  };
}
function approvalRefusal(
  actor: Actor,
  s: ReturnType<typeof approvalSubject>,
  mode: ApprovalMode,
  byMode: boolean,
  capOwner: boolean,
  owner: boolean,
  current: JsonObject | undefined,
  meetsMode: boolean,
): JsonObject | undefined {
  if (s.executed) return {code: 'REVIEW_ALREADY_EXECUTED', message: 'This review was already executed.'};
  if (Number(s.review.expires_at) <= Date.now())
    return {code: 'REVIEW_EXPIRED', message: 'This review expired. Prepare it again and approve the new review.'};
  if (!byMode && !capOwner)
    return {
      code: 'APPROVAL_NOT_REQUIRED',
      message: 'This review needs no approval on the website: the user’s acknowledgements in the AI client suffice.',
    };
  // One approval of each review. It is replaced only when it no longer meets the owner's approval mode (the mode changed
  // since it was given), or by the owner's own where a change beyond a cap needs the owner.
  if (meetsMode && (current?.approver_is_owner === true || !owner || !capOwner))
    return {code: 'REVIEW_ALREADY_APPROVED', message: 'This review is already approved.'};
  if (!byMode && capOwner && !owner)
    return {code: 'OWNER_REQUIRED', message: 'Only the workspace owner approves a change beyond a spending cap.'};
  if (mode === 'distinct_approver' && !owner && principalOf(actor) === (s.review.principal ?? s.review.user_id))
    return {
      code: 'DISTINCT_APPROVER_REQUIRED',
      message: 'Another member than the one who prepared this review approves it, or the workspace owner.',
    };
  if (mode === 'distinct_approver' && !owner && unidentifiedPreparer(s.review.principal ?? s.review.user_id))
    return {
      code: 'DISTINCT_APPROVER_REQUIRED',
      message:
        'This review was prepared through a shared administrator sign-in or a key approved from one, so only the workspace owner approves it.',
    };
  return undefined;
}
/**
 * A person approves a review or group on the website (WRT-09): bound to the fingerprint the page showed, to the
 * approver and to the review's window. Checked and recorded in one transaction; audited; nothing is sent to any
 * provider.
 */
export function approveReview(store: Store, actor: Actor, reviewId: unknown, input: JsonObject): JsonObject {
  assertApprover(store, actor);
  assertTwoStepSession(actor, 'approve_review');
  if (input.confirmed !== true)
    throw new MirrorError('APPROVAL_CONFIRMATION_REQUIRED', 'Confirm that you approve this exact review.', {}, 400);
  return store.transaction(() => {
    const view = approvalView(store, actor, reviewId);
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
        {review_id: view.review_id},
        view.refusal.code === 'APPROVAL_NOT_REQUIRED' ? 400 : 409,
      );
    const owner = workspaceOwner(store, actor),
      approval = {
        review_id: view.review_id,
        fingerprint: view.fingerprint,
        approver: actor.userId,
        approver_principal: principalOf(actor),
        approver_is_owner: owner,
        approved_at: Date.now(),
        expires_at: Date.parse(view.expires_at),
        classes: view.classes,
      };
    store.putDocument(actor.tenantId, 'write_approval', view.review_id, approval);
    store.appendAudit(actor.tenantId, view.review_id, {
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
      approval: {
        approver: approval.approver_principal,
        approver_name: personName(store, actor.tenantId, approval.approver_principal),
        ...(shownAsReviewer(actor, approval.approver_principal) ? {approver_kind: 'reviewer'} : {}),
        approver_is_owner: owner,
        approved_at: approval.approved_at,
      },
      approval_pending: view.owner_required === true && !owner,
      may_approve: false,
    };
  });
}
