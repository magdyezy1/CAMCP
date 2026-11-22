import type {Store} from './store.js';
/**
 * The Operations projection of standalone reviewed writes (WRT-08, src/write-records.ts) in the store layer (ARC-02),
 * moved here verbatim; src/write-records.ts re-exports it.
 */
const withdrawnLegacy = (alias: string) =>
  `NOT EXISTS (SELECT 1 FROM documents c, json_each(c.data,'$.steps') s WHERE c.tenant_id=${alias}.tenant_id AND c.kind='campaign_run' AND json_extract(s.value,'$.review_id')=${alias}.id)
    AND NOT EXISTS (SELECT 1 FROM documents g, json_each(g.data,'$.parts') p WHERE g.tenant_id=${alias}.tenant_id AND g.kind='write_review_group' AND p.value=${alias}.id)`;
/**
 * The plan and the step of it that hold a review as the step's review (r25-field3-errors, lead review S2-2: the status of a plan step's rejected
 * review names the plan's recover_step), found by the query the maker-checker of src/write-review.ts uses (`held: true`); else the plan and the
 * step whose earlier attempt it was, which went on to another review (`held: false`, the re-review N3); undefined when no plan names it.
 */
export function planStepHolding(
  store: Store,
  tenant: string,
  reviewId: string,
): {plan: string; step: string; held: boolean} | undefined {
  const named = (row: {plan: string; step: string} | undefined, held: boolean) =>
      row && typeof row.step === 'string' ? {plan: row.plan, step: row.step, held} : undefined,
    holding = store.db
      .prepare(
        "SELECT c.id AS plan, json_extract(s.value,'$.id') AS step FROM documents c, json_each(c.data,'$.steps') s WHERE c.tenant_id=? AND c.kind='campaign_run' AND json_extract(s.value,'$.review_id')=? LIMIT 1",
      )
      .get(tenant, reviewId) as {plan: string; step: string} | undefined;
  if (holding) return named(holding, true);
  return named(
    store.db
      .prepare(
        "SELECT c.id AS plan, json_extract(s.value,'$.id') AS step FROM documents c, json_each(c.data,'$.steps') s, json_each(s.value,'$.previous_attempts') a WHERE c.tenant_id=? AND c.kind='campaign_run' AND json_extract(a.value,'$.review_id')=? LIMIT 1",
      )
      .get(tenant, reviewId) as {plan: string; step: string} | undefined,
    false,
  );
}
/** The group that lists a review as one of its parts, or undefined when it is no part of one (r25-field3-errors, the second re-review N3-b). */
export function groupOfPart(store: Store, tenant: string, partId: string): string | undefined {
  const row = store.db
    .prepare(
      "SELECT g.id AS id FROM documents g, json_each(g.data,'$.parts') p WHERE g.tenant_id=? AND g.kind='write_review_group' AND p.value=? LIMIT 1",
    )
    .get(tenant, partId) as {id: string} | undefined;
  return row?.id;
}
/**
 * The plan and the step that name a review, as the step's own review or through the group the review is a part of, and whether the step holds it
 * (`held`) or went on from it: what the maker-checker of a direct execute asks (CMP-05; r25-field3-errors, the lead's item 8). A plan's write group is the
 * step's review, and its parts are reviews of their own that no step names, so the lookup by the review id alone passed a direct execute of the group, or
 * of one of its parts, as no plan's. A review the step went on from (`held: false` in planStepHolding) is no longer the step's: a direct execute of it is
 * refused as a retired one, and the refusal names the step (the fourth check F1). Undefined when no plan names it.
 */
export function planStepNaming(
  store: Store,
  tenant: string,
  reviewId: string,
): {plan: string; step: string; held: boolean} | undefined {
  const own = planStepHolding(store, tenant, reviewId);
  if (own?.held) return own;
  const group = groupOfPart(store, tenant, reviewId),
    through = group ? planStepHolding(store, tenant, group) : undefined;
  return through?.held ? through : (own ?? through);
}
/**
 * The claim that says whether a review was sent, as the plan runner reads it, and the only way it does (r25-field3-errors, the third re-review N1-c, S1).
 * A review is claimed under its own key when it is executed. A write group is claimed under its own key only after its parts ran, and each part under
 * its own, so a crash or a deploy between the parts, a resume the deployment refused, or a part sent alone leaves a part sent and the group's key
 * free. A reader that looked at the group's key alone took such a group for one that was never sent, and the plan prepared it again and sent its first
 * part a second time (N1-b closed that on the group's own execute; three more readers were left: continue_as_new, recover_step after a resume
 * marked failed, and the group's "nothing of the group was sent" branch). So, for a group: the claim of the group's key when it holds one; else
 * `uncertain` when any of its parts holds a claim (that part may have reached the provider, and the status of each part says how it ended), except
 * that a group whose claimed parts were all refused as applied nothing keeps `rejected` (as its status reads it, `group_rejected`); else none. A
 * review that is no group reads at its own key, as it always did.
 */
export function reviewClaim(
  store: Store,
  tenant: string,
  reviewId: string,
): {state: string; result: string | null; created_at: number} | undefined {
  const own = store.db
    .prepare('SELECT state,result,created_at FROM idempotency WHERE tenant_id=? AND key=?')
    .get(tenant, reviewId) as {state: string; result: string | null; created_at: number} | undefined;
  if (own) return own;
  const parts = store.db
    .prepare(
      "SELECT i.state AS state, i.created_at AS created_at FROM documents g, json_each(g.data,'$.parts') p JOIN idempotency i ON i.tenant_id=g.tenant_id AND i.key=p.value WHERE g.tenant_id=? AND g.kind='write_review_group' AND g.id=? ORDER BY i.created_at",
    )
    .all(tenant, reviewId) as {state: string; created_at: number}[];
  if (!parts.length) return undefined;
  return {
    state: parts.every(part => part.state === 'rejected') ? 'rejected' : 'uncertain',
    result: null,
    created_at: parts[0]!.created_at,
  };
}
/** How far a write group got: its own claim, and each part in order with whether it holds a claim and, if it does, whether its receipt says it applied. */
export interface GroupProgress {
  /** The state of the group's own claim: undefined (never run to its end), `uncertain` (it stopped part-way), or another. */
  key: string | undefined;
  parts: {id: string; sent: boolean; applied: boolean}[];
}
/**
 * How far a write group got, from the claims of its parts and of its own key (r25-field3-errors, the third re-review P4); undefined when there is no such
 * group. A part is sent when it holds a claim, and applied when that claim is complete and its receipt did not report a failure; a part that holds none was
 * never sent (a refusal before dispatch released its claim, or it was never reached).
 */
export function groupProgress(store: Store, tenant: string, groupId: string): GroupProgress | undefined {
  const rows = store.db
    .prepare(
      "SELECT p.value AS id, i.state AS state, CASE WHEN json_valid(i.result) THEN json_extract(i.result,'$.success') END AS success FROM documents g, json_each(g.data,'$.parts') p LEFT JOIN idempotency i ON i.tenant_id=g.tenant_id AND i.key=p.value WHERE g.tenant_id=? AND g.kind='write_review_group' AND g.id=? ORDER BY p.key",
    )
    .all(tenant, groupId) as {id: string; state: string | null; success: number | string | null}[];
  if (!rows.length) return undefined;
  const key = store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get(tenant, groupId) as
    {state: string} | undefined;
  return {
    key: key?.state,
    parts: rows.map(row => ({
      id: row.id,
      sent: row.state !== null,
      applied: row.state === 'complete' && row.success !== 0 && row.success !== 'false',
    })),
  };
}
/**
 * Whether a write group that stopped part-way can be finished by sending the parts not sent (the third re-review P4): at least one part was sent and at least
 * one was not, every part that was sent applied (a part that is pending, uncertain, rejected or whose receipt failed is read, never sent over), and the group's
 * own key is free or was claimed uncertain by the stop. It says nothing of the review windows.
 */
export function groupResumable(progress: GroupProgress | undefined): boolean {
  return (
    !!progress &&
    progress.parts.some(part => part.sent) &&
    progress.parts.some(part => !part.sent) &&
    progress.parts.every(part => !part.sent || part.applied) &&
    (progress.key === undefined || progress.key === 'uncertain')
  );
}
/** What a campaign plan writes on a review it went on from (`retireReview`). */
export interface Retirement {
  plan_id: string;
  step_id: string;
  /** Why: the step was amended (recover_step), prepared again while the review was open (prepare_next), or the plan was cancelled or continued as another. */
  reason: 'amended' | 'replaced' | 'cancelled' | 'continued';
}
/**
 * A review a campaign plan has gone on from, retired by the plan (r25-field3-errors, the third re-review P2 and C1, S1). A step goes on from an unclaimed
 * review when recover_step amends it, when prepare_next prepares it again while the review is still open, and when the plan is cancelled or continued as
 * another plan. Nothing retired the review: it stayed valid for its five minutes, its status named a direct `amcp_write execute`, and that execute skipped
 * the plan's approvals (the distinct-approver check, or the plan's own approval once an amendment moved its hash) and, with the amended step's own review,
 * made a second object. The mark is written on the review (`retired`: the plan, the step, why and when), and for a group on each of its parts too, so the
 * parts are as retired as the group. A review that holds a claim, and a group any part of which holds one, is never marked: it was sent (or may have
 * been), its receipt replays, and the plan does not go on from it. The one exception is a group whose only claims are its parts' refusals (a refused part
 * applied nothing and its key is retired: reviewClaim reads such a group rejected): it is marked with the parts that hold no claim, which would otherwise
 * stay executable beside the plan's amended step, and the refused parts are left as they are. The check and the marks are one transaction (the store's
 * transactions begin immediate), so a claim taken meanwhile is seen. Returns whether the review was marked; false for a review that holds a claim, or that is
 * none.
 */
export function retireReview(store: Store, tenant: string, reviewId: string, by: Retirement): boolean {
  const mark = JSON.stringify({...by, at: Date.now()}),
    set = "UPDATE documents SET data=json_set(data,'$.retired',json(?)),revision=revision+1 WHERE tenant_id=? AND ";
  return store.transaction(() => {
    const claim = reviewClaim(store, tenant, reviewId),
      group = !!store.db
        .prepare("SELECT 1 FROM documents WHERE tenant_id=? AND kind='write_review_group' AND id=?")
        .get(tenant, reviewId);
    if (claim && !(group && claim.state === 'rejected')) return false;
    const own =
      Number(
        store.db.prepare(set + "kind IN ('write_review','write_review_group') AND id=?").run(mark, tenant, reviewId)
          .changes,
      ) > 0;
    store.db
      .prepare(
        set +
          "kind='write_review' AND id IN (SELECT p.value FROM documents g, json_each(g.data,'$.parts') p WHERE g.tenant_id=? AND g.kind='write_review_group' AND g.id=?) AND NOT EXISTS (SELECT 1 FROM idempotency i WHERE i.tenant_id=documents.tenant_id AND i.key=documents.id)",
      )
      .run(mark, tenant, tenant, reviewId);
    return own;
  });
}
/**
 * The Operations projection of standalone reviews and groups. A review kept before reviews recorded their origin is
 * listed only while its outcome is uncertain and no plan step or group names it. A group carries how many of its parts hold a claim
 * (`parts_claimed`) and when the latest pending one was made (`parts_pending_at`): the group's own key is claimed only after its parts ran, so
 * the state is judged by them (src/write-records.ts writeRecordState; r25-field3-errors, the lead re-review N1).
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
    'provider_check',json_extract(d.data,'$.provider_check.status'),
    'error_code',CASE WHEN json_extract(o.data,'$.phase')='not_sent' THEN substr(json_extract(o.data,'$.events[#-1].code'),1,101)
      WHEN json_extract(d.data,'$.provider_check.status')='provider_rejected' AND i.state IS NULL THEN 'PROVIDER_VALIDATION_FAILED' END,
    'superseded_by',json_extract(r.data,'$.superseded_by'),
    'reconciliation',json_extract(r.data,'$.classification'),
    'reconciliation_automatic',json_extract(r.data,'$.automatic'),
    'group',CASE WHEN d.kind='write_review_group' THEN 1 ELSE 0 END,
    'parts_claimed',CASE WHEN d.kind='write_review_group' THEN (SELECT count(*) FROM json_each(d.data,'$.parts') p
      JOIN idempotency pi ON pi.tenant_id=d.tenant_id AND pi.key=p.value) END,
    'parts_pending_at',CASE WHEN d.kind='write_review_group' THEN (SELECT max(pi.created_at) FROM json_each(d.data,'$.parts') p
      JOIN idempotency pi ON pi.tenant_id=d.tenant_id AND pi.key=p.value WHERE pi.state='pending') END
  ) AS metadata
  FROM documents d
  LEFT JOIN idempotency i ON i.tenant_id=d.tenant_id AND i.key=d.id
  LEFT JOIN documents o ON o.tenant_id=d.tenant_id AND o.kind='operation_journal' AND o.id=d.id
  LEFT JOIN documents v ON v.tenant_id=d.tenant_id AND v.kind='write_verification' AND v.id=d.id
  LEFT JOIN documents r ON r.tenant_id=d.tenant_id AND r.kind='write_reconciliation' AND r.id=d.id
  WHERE d.tenant_id=? AND d.kind IN ('write_review','write_review_group')
    AND (json_extract(d.data,'$.origin')='standalone'
      OR (json_extract(d.data,'$.origin') IS NULL AND d.kind='write_review' AND i.state='uncertain' AND ${withdrawnLegacy('d')}))`;
