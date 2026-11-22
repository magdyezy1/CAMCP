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
 * The plan and the step that hold a review as the step's own review, or hold the group the review is a part of (r25-field3-errors, the lead's item 8):
 * what the maker-checker of a direct execute asks (CMP-05). A plan's write group is the step's review, and its parts are reviews of their own that no
 * step names, so the lookup by the review id alone passed a direct execute of the group, or of one of its parts, as no plan's. A review the step went
 * on from (`held: false` in planStepHolding) is no longer the step's and is not held.
 */
export function heldByPlanStep(
  store: Store,
  tenant: string,
  reviewId: string,
): {plan: string; step: string} | undefined {
  const own = planStepHolding(store, tenant, reviewId);
  if (own?.held) return {plan: own.plan, step: own.step};
  const group = groupOfPart(store, tenant, reviewId),
    through = group ? planStepHolding(store, tenant, group) : undefined;
  return through?.held ? {plan: through.plan, step: through.step} : undefined;
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
