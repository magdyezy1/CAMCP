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
 * review names the plan's recover_step), found by the query the maker-checker of src/write-review.ts uses; undefined when no step holds it.
 */
export function planStepHolding(
  store: Store,
  tenant: string,
  reviewId: string,
): {plan: string; step: string} | undefined {
  const held = store.db
    .prepare(
      "SELECT c.id AS plan, json_extract(s.value,'$.id') AS step FROM documents c, json_each(c.data,'$.steps') s WHERE c.tenant_id=? AND c.kind='campaign_run' AND json_extract(s.value,'$.review_id')=? LIMIT 1",
    )
    .get(tenant, reviewId) as {plan: string; step: string} | undefined;
  return held && typeof held.step === 'string' ? held : undefined;
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
