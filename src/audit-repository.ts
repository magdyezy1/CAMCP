import type {Store} from './store.js';
import type {JsonObject} from './types.js';
import {providerById} from './provider-adapters.js';

/**
 * Reads of a workspace's audit records in the store layer (ARC-02), moved here verbatim from src/audit-history.ts,
 * src/review-friction.ts and src/legacy-alias-usage.ts. The audit is append-only (Store.appendAudit); every read is
 * bound to one workspace and projects bounded metadata only.
 */
const stringField = (path: string, limit = 201) => `CASE
 WHEN json_type(a.event,'${path}') IS NULL OR json_type(a.event,'${path}')='null' THEN NULL
 WHEN json_type(a.event,'${path}')='text' THEN substr(json_extract(a.event,'${path}'),1,${limit})
 ELSE json('{"invalid":true}') END`;
// Never materialize an audit event, provider body, result or receipt in JavaScript for discovery.
const projection = `SELECT a.seq,a.created_at,substr(a.request_id,1,201) AS request_id,json_object(
 'event',${stringField('$.event', 101)},'actor',${stringField('$.actor', 201)},
 'platform',${stringField('$.platform', 81)},
 'gateways',json_array(${stringField('$.gateway', 101)},${stringField('$.request.gateway', 101)}),
 'accounts',json_array(${stringField('$.account_id')},${stringField('$.request.accountId')},${stringField('$.request.account_id')}),
 'connections',json_array(${stringField('$.connection_id')},${stringField('$.request.connection_id')}),
 'action',${stringField('$.request.action', 201)},'error_code',${stringField('$.error.code', 101)},
 'complete',CASE WHEN json_type(a.event,'$.complete') IN ('true','false') THEN json_extract(a.event,'$.complete') END,
 'vendor_writes',CASE WHEN json_type(a.event,'$.vendor_writes')='integer' THEN json_extract(a.event,'$.vendor_writes') END
) AS metadata FROM audit a WHERE a.tenant_id=? AND a.seq<=? AND a.seq<? ORDER BY a.seq DESC LIMIT 501`;
const boundedJson = (path: string, bytes: number) => `CASE WHEN json_type(event,'${path}') IN ('object','array')
 AND length(CAST(json_extract(event,'${path}') AS BLOB))<=${bytes} THEN json_extract(event,'${path}') END`;
const detailsQuery = `SELECT ${boundedJson('$.error', 16384)} AS error,
 ${boundedJson('$.diagnostics', 65536)} AS diagnostics,
 substr(json_extract(event,'$.request.method'),1,8) AS method,
 substr(json_extract(event,'$.request.path'),1,501) AS path FROM audit WHERE tenant_id=? AND seq=?`;
/** Up to 501 audit records' metadata at or below `ceiling` and below `before`, newest first. */
export function auditPage(store: Store, tenant: string, ceiling: number, before: number): JsonObject[] {
  return store.sql().prepare(projection).all(tenant, ceiling, before) as JsonObject[];
}
/** One audit record's bounded error, diagnostics, request method and path. */
export function auditDetails(store: Store, tenant: string, seq: number): JsonObject {
  return store.sql().prepare(detailsQuery).get(tenant, seq) as JsonObject;
}
/** The workspace's newest audit sequence number (0 when it has none). */
export function newestAuditSeq(store: Store, tenant: string): number {
  return (
    store.sql().prepare('SELECT coalesce(max(seq),0) AS seq FROM audit WHERE tenant_id=?').get(tenant) as JsonObject
  ).seq as number;
}
/**
 * Up to `limit` reviewed-write and media-review audit events (request id, event, time) between `since` and `now`, oldest
 * first: the events of a write's review and of an amcp_write call, and those a media review leaves (the review prepared,
 * the upload sent or left incomplete) and the refusals of an amcp_media call (L6-11, R25 M1).
 */
export function writeAuditEvents(
  store: Store,
  tenant: string,
  since: number,
  now: number,
  limit: number,
): {request_id: string; event: string; created_at: number}[] {
  return store
    .sql()
    .prepare(
      `SELECT request_id, event, created_at FROM audit WHERE tenant_id=? AND created_at>=? AND created_at<=?
        AND (instr(event,'"event":"write_')>0 OR instr(event,'"tool":"amcp_write"')>0
          OR instr(event,'"event":"media_prepared"')>0 OR instr(event,'"event":"media_library_prepared"')>0
          OR instr(event,'"event":"media_uploaded"')>0 OR instr(event,'"event":"media_upload_incomplete"')>0
          OR instr(event,'"tool":"amcp_media"')>0) ORDER BY seq LIMIT ?`,
    )
    .all(tenant, since, now, limit) as {request_id: string; event: string; created_at: number}[];
}
/**
 * The refusals of a changed state (STATE_CHANGED of amcp_write or amcp_media) among a workspace's newest `scan` audit
 * rows between `since` and `now`: at most `limit` of them (request id, event, time), newest first. The scan is bounded by
 * rows, not by the window alone, so a refusal never reads a busy workspace's whole audit (R25 M1, L5-04).
 */
export function stateChangedRefusals(
  store: Store,
  tenant: string,
  since: number,
  now: number,
  scan: number,
  limit: number,
): {request_id: string; event: string; created_at: number}[] {
  return store
    .sql()
    .prepare(
      `SELECT request_id, event, created_at FROM (
         SELECT seq, request_id, event, created_at FROM audit
          WHERE tenant_id=? AND created_at>=? AND created_at<=? ORDER BY seq DESC LIMIT ?)
        WHERE instr(event,'"code":"STATE_CHANGED"')>0
          AND (instr(event,'"tool":"amcp_write"')>0 OR instr(event,'"tool":"amcp_media"')>0)
        ORDER BY seq DESC LIMIT ?`,
    )
    .all(tenant, since, now, scan, limit) as {request_id: string; event: string; created_at: number}[];
}
// ARC-01 (wave 4c round 6, the shared tables): Google Ads' gateway, from the adapter registry, is bound to the query
// below where the query named it.
const googleAdsGateway = providerById('google')!.gateway;
/** Up to `limit` Google Ads requests since `since` (request id and planned action), oldest first. */
export function googleAdsRequestActions(
  store: Store,
  tenant: string,
  since: number,
  limit: number,
): {request_id: string; action: unknown}[] {
  return store
    .sql()
    .prepare(
      "SELECT request_id, json_extract(event,'$.request.action') AS action FROM audit WHERE tenant_id=? AND created_at>=? AND instr(event,?)>0 AND json_extract(event,'$.request.gateway')=? ORDER BY seq LIMIT ?",
    )
    .all(tenant, since, googleAdsGateway, googleAdsGateway, limit) as {request_id: string; action: unknown}[];
}
