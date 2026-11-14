import type {Store} from './store.js';
import type {JsonObject} from './types.js';
import {reportRunFeedSQL, workbookScheduleFeedSQL} from './workbook-repository.js';
import {writeFeedSQL} from './write-record-repository.js';

/**
 * The Operations feed query (OPS-06, src/operations-feed.ts) in the store layer (ARC-02), moved here verbatim. It
 * projects only metadata in SQLite: never report rows, plan arguments, upload URLs, job inputs or results, encrypted
 * actor bindings, provider receipts or error messages. Every branch is bound to the one workspace.
 */
/** The document kinds the feed's first branch reads, in their order (each the record kind of an operation kind). */
export const feedDocumentKinds = [
  'campaign_run',
  'media_review',
  'overview_report',
  'overview_export',
  'overview_schedule',
  'report_incident',
];
/**
 * Monitor email notices whose delivery failed or ran out of attempts (OPS-06, owner decision D22). The email worker
 * records the outcome on the notice (delivery_state, delivery_error); a confirmed recovery clears it. Only the notice's
 * metadata is projected: never the recipient, the payload or a provider message.
 */
const noticeFeedSQL = `SELECT d.id, 'monitor_notice' AS kind, d.revision,
  coalesce(json_extract(d.data,'$.failed_at'),json_extract(d.data,'$.created_at'),0) AS at,
  json_object(
    'name',substr(coalesce(json_extract(m.data,'$.name'),json_extract(d.data,'$.monitor_id')),1,200),
    'user_id',json_extract(d.data,'$.user_id'),
    'state',json_extract(d.data,'$.state'),'expires_at',json_extract(d.data,'$.expires_at'),
    'scopes',json_array(json_object('platform',json_extract(m.data,'$.platform'),
      'connection_id',json_extract(m.data,'$.connection_id'),'account_id',json_extract(m.data,'$.account_id'))),
    'error_code',json_extract(d.data,'$.delivery_error'),
    'incident_id',json_extract(d.data,'$.incident_id'),'monitor_id',json_extract(d.data,'$.monitor_id')
  ) AS metadata
  FROM documents d
  LEFT JOIN documents m ON m.tenant_id=d.tenant_id AND m.kind='report_monitor' AND m.id=json_extract(d.data,'$.monitor_id')
  WHERE d.tenant_id=? AND d.kind='monitor_notice' AND json_extract(d.data,'$.delivery_state')='failed'
    AND coalesce(json_extract(d.data,'$.state'),'')<>'cancelled'`;
/**
 * Logins that need a person (OPS-06): the provider rejected the login (or it ended), AMCP keeps failing to renew it
 * (CON-02 credential health of the current login only), or an administrator turned the connection off. Connection
 * metadata only: label, gateway and accounts, never credentials.
 */
const connectionFeedSQL = `SELECT id, kind, revision, at, metadata FROM (SELECT c.id, 'connection' AS kind, coalesce(h.revision,1) AS revision,
  max(coalesce(json_extract(h.data,'$.updated_at'),0),coalesce(json_extract(c.data,'$.updated_at'),0)) AS at,
  json_object(
    'name',substr(coalesce(json_extract(c.data,'$.label'),c.id),1,200),
    'gateway',json_extract(c.data,'$.gateway'),'accounts',json_extract(c.data,'$.accounts'),
    'state',CASE WHEN json_extract(c.data,'$.enabled')=0 THEN 'disabled'
      WHEN h.id IS NULL OR coalesce(json_extract(h.data,'$.login_revision'),0)<>coalesce(json_extract(c.data,'$.loginRevision'),0)
        OR coalesce(json_extract(h.data,'$.login_id'),'')<>coalesce(json_extract(c.data,'$.loginId'),'') THEN 'healthy'
      WHEN json_extract(h.data,'$.state') IN ('reauthorization_required','refresh_failed') THEN json_extract(h.data,'$.state')
      WHEN json_extract(h.data,'$.login_expires_at')<=? THEN 'reauthorization_required'
      ELSE 'healthy' END,
    'error_code',json_extract(h.data,'$.last_failure.code')
  ) AS metadata
  FROM connections c
  LEFT JOIN documents h ON h.tenant_id=c.tenant_id AND h.kind='connection_health' AND h.id=c.id
  WHERE c.tenant_id=?) WHERE json_extract(metadata,'$.state')<>'healthy'`;

// Resolve interdependent SQL fragments on first use, after module initialization; retain one immutable query.
// The plan branch of `scopes` wraps its scalar subquery in json(): SQLite 3.54 does not keep a subquery's JSON subtype, so
// the enclosing json_object would quote the array as a string.
let cachedQuery: string | undefined;
const query = () =>
  (cachedQuery ??= `WITH feed AS (
  SELECT d.id, d.kind, d.revision,
    max(coalesce(json_extract(d.data,'$.updated_at'),0), coalesce(json_extract(d.data,'$.completed_at'),0),
      coalesce(json_extract(d.data,'$.created_at'),0), coalesce(j.updated_at,0), coalesce(i.created_at,0),
      coalesce(json_extract(o.data,'$.updated_at'),0),
      CASE WHEN d.kind='media_review' THEN coalesce(json_extract(d.data,'$.expires_at')-300000,0) ELSE 0 END) AS at,
    json_object(
      'name', CASE d.kind WHEN 'media_review' THEN json_extract(d.data,'$.plan.name')
        WHEN 'report_incident' THEN json_extract(d.data,'$.monitor_name')
        WHEN 'overview_export' THEN json_extract(r.data,'$.config.name')
        ELSE coalesce(json_extract(d.data,'$.name'),json_extract(d.data,'$.config.name')) END,
      'user_id',json_extract(d.data,'$.user_id'),'principal',json_extract(d.data,'$.principal'),
      'state', CASE d.kind WHEN 'media_review' THEN coalesce(CASE WHEN i.state IN ('uncertain','complete') THEN i.state END,j.state,i.state,
        CASE WHEN json_extract(d.data,'$.expires_at')<=? THEN 'expired' ELSE 'unsubmitted' END)
        WHEN 'overview_export' THEN CASE WHEN j.state='complete' AND json_extract(d.data,'$.state') IN ('superseded','skipped')
          THEN json_extract(d.data,'$.state') ELSE coalesce(j.state,json_extract(d.data,'$.state'),'unknown') END
        WHEN 'overview_schedule' THEN CASE WHEN json_extract(d.data,'$.error.code') IS NOT NULL THEN 'failed'
          WHEN json_extract(d.data,'$.is_active') AND json_extract(d.data,'$.schedule_warning.code') IS NOT NULL THEN 'attention'
          WHEN json_extract(d.data,'$.is_active') AND json_extract(d.data,'$.last_delivery.state') IN ('failed','retrying') THEN 'attention'
          WHEN json_extract(d.data,'$.is_active') THEN 'active' ELSE 'paused' END
        WHEN 'overview_report' THEN CASE WHEN j.state IN ('failed','cancelled') THEN j.state ELSE coalesce(json_extract(d.data,'$.state'),j.state,'unknown') END
        ELSE json_extract(d.data,'$.state') END,
      'scopes', CASE d.kind
        WHEN 'campaign_run' THEN json((SELECT json_group_array(json_object('gateway',
          CASE WHEN json_extract(s.value,'$.kind')='media' THEN json_extract(s.value,'$.arguments.platform')||'_native_action'
            ELSE json_extract(s.value,'$.gateway') END,
          'connection_id',json_extract(s.value,'$.connection_id'),'account_id',json_extract(s.value,'$.account_id')))
          FROM json_each(d.data,'$.steps') s))
        WHEN 'media_review' THEN json_array(json_object('gateway',json_extract(d.data,'$.plan.platform')||'_native_action',
          'connection_id',json_extract(d.data,'$.plan.connection_id'),'account_id',json_extract(d.data,'$.plan.account_id')))
        WHEN 'report_incident' THEN json_array(json_object('platform',json_extract(d.data,'$.platform'),
          'connection_id',json_extract(d.data,'$.connection_id'),'account_id',json_extract(d.data,'$.account_id')))
        WHEN 'overview_export' THEN json_extract(r.data,'$.config.sources')
        ELSE json_extract(d.data,'$.config.sources') END,
      'error_code',coalesce(CASE WHEN json_valid(j.error) THEN json_extract(j.error,'$.code') END,json_extract(d.data,'$.error.code'),json_extract(d.data,'$.schedule_warning.code'),
        CASE WHEN d.kind='overview_schedule' AND json_extract(d.data,'$.last_delivery.state') IN ('failed','retrying') THEN json_extract(d.data,'$.last_delivery.error_code') END),
      'job_id',j.id,'report_id',json_extract(d.data,'$.report_id'),'view_id',json_extract(d.data,'$.view_id'),
      'snoozed_until',json_extract(d.data,'$.snoozed_until'), 'next_run_at',json_extract(d.data,'$.next_run_at'),
      'superseded_by_version',json_extract(d.data,'$.superseded_by_version')
    ) AS metadata
  FROM documents d
  LEFT JOIN jobs j ON j.tenant_id=d.tenant_id AND j.id=json_extract(d.data,'$.job_id')
  LEFT JOIN idempotency i ON d.kind='media_review' AND i.tenant_id=d.tenant_id AND i.key=d.id
  LEFT JOIN documents r ON d.kind='overview_export' AND r.tenant_id=d.tenant_id AND r.kind='overview_report' AND r.id=json_extract(d.data,'$.report_id')
  LEFT JOIN documents o ON d.kind='media_review' AND o.tenant_id=d.tenant_id AND o.kind='operation_journal' AND o.id=d.id
  WHERE d.tenant_id=? AND d.kind IN (${feedDocumentKinds.map(() => '?').join(',')})
  UNION ALL ${reportRunFeedSQL}
  UNION ALL ${workbookScheduleFeedSQL}
  UNION ALL ${writeFeedSQL}
  UNION ALL ${noticeFeedSQL}
  UNION ALL ${connectionFeedSQL}
) SELECT * FROM feed WHERE (? IS NULL OR kind=?)
  AND (? IS NULL OR at<? OR (at=? AND (kind>? OR (kind=? AND id>?))))
  ORDER BY at DESC,kind,id LIMIT 501`);

/**
 * Up to 501 feed rows of one workspace at `at`, newest first, optionally of one feed kind and after a cursor position
 * (its time, kind and id).
 */
export function operationsFeedRows(
  store: Store,
  tenant: string,
  at: number,
  selectedKind: string | null,
  after: {at: number; kind: string; id: string} | null,
): JsonObject[] {
  return store
    .sql()
    .prepare(query())
    .all(
      at,
      tenant,
      ...feedDocumentKinds,
      tenant,
      tenant,
      tenant,
      // Notices of the tenant; connections, with the time a login that cannot renew itself ends.
      tenant,
      at,
      tenant,
      selectedKind,
      selectedKind,
      after?.at ?? null,
      after?.at ?? null,
      after?.at ?? null,
      after?.kind ?? null,
      after?.kind ?? null,
      after?.id ?? null,
    ) as JsonObject[];
}
