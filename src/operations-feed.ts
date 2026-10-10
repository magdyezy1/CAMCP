import {operationKinds, operationStates} from './operation-types.js';
export {operationKinds, operationStates} from './operation-types.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {ownsRecord} from './actor-identity.js';
import {MirrorError} from './errors.js';
import {bad, fingerprint} from './workspace-core.js';
import {reportPlatforms} from './report-metrics.js';
import {assertAccountWrite} from './write-access.js';
import {normalizeAccount} from './scope.js';
import {incidentAttention} from './report-monitors.js';
import {reportRunFeedSQL, reportRunScope} from './report-runs.js';
import {workbookScheduleFeedSQL} from './workbook-schedules.js';
import {writeFeedSQL, writeHandoff, writeRecordState} from './write-records.js';

const documentKinds = [
  'campaign_run',
  'media_review',
  'overview_report',
  'overview_export',
  'overview_schedule',
  'report_incident',
];
const scanLimit = 500;
// In operationKinds order: each feed kind is the record kind of the operation kind at the same index.
const feedKinds = [...documentKinds, 'workbook_report', 'workbook_schedule', 'write_review'];

// Project only metadata in SQLite. Never load report rows, plan arguments, upload URLs, job inputs/results,
// encrypted actor bindings, provider receipts or error messages into an operations response.
// Resolve interdependent SQL fragments on first use, after module initialization; retain one immutable query.
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
        WHEN 'campaign_run' THEN (SELECT json_group_array(json_object('gateway',
          CASE WHEN json_extract(s.value,'$.kind')='media' THEN json_extract(s.value,'$.arguments.platform')||'_native_action'
            ELSE json_extract(s.value,'$.gateway') END,
          'connection_id',json_extract(s.value,'$.connection_id'),'account_id',json_extract(s.value,'$.account_id')))
          FROM json_each(d.data,'$.steps') s)
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
  WHERE d.tenant_id=? AND d.kind IN (${documentKinds.map(() => '?').join(',')})
  UNION ALL ${reportRunFeedSQL}
  UNION ALL ${workbookScheduleFeedSQL}
  UNION ALL ${writeFeedSQL}
) SELECT * FROM feed WHERE (? IS NULL OR kind=?)
  AND (? IS NULL OR at<? OR (at=? AND (kind>? OR (kind=? AND id>?))))
  ORDER BY at DESC,kind,id LIMIT 501`);

function category(kind: string, state: string) {
  if (
    [
      'uncertain',
      'failed',
      'partial',
      'blocked',
      'attention',
      'mismatch',
      'inconclusive',
      'awaiting_review',
      'review_ready',
      'unsubmitted',
      'expired',
      'unknown',
      'prepared',
      'not_sent',
    ].includes(state)
  )
    return 'attention';
  if (kind === 'write') return ['executing', 'verifying'].includes(state) ? 'active' : 'complete';
  if (kind === 'incident')
    return state === 'resolved'
      ? 'complete'
      : state === 'snoozed' || state === 'acknowledged' || state === 'superseded'
        ? 'deferred'
        : 'attention';
  if (['complete', 'cancelled', 'verified', 'delivered'].includes(state)) return 'complete';
  // A finished export that wrote nothing (a newer snapshot holds the tab, or policy skipped it) needs no action.
  if (kind === 'export' && ['superseded', 'skipped'].includes(state)) return 'complete';
  if (['paused', 'snoozed'].includes(state)) return 'deferred';
  return 'active';
}
function handoff(kind: string, id: string, p: JsonObject) {
  const encoded = encodeURIComponent(id);
  if (kind === 'write') return writeHandoff(id);
  if (kind === 'workbook_schedule')
    return {
      website_path: '/operations?workbook_schedule_id=' + encoded,
      next_call: {tool: 'amcp_workspace', arguments: {action: 'report_schedule', id}},
      next_safe_action:
        'Inspect the current query revision, clock settings and future occurrences before changing this local reporting schedule.',
    };
  if (kind === 'workbook_report')
    return {
      website_path: '/operations?run_id=' + encoded,
      next_call: {tool: 'amcp_workspace', arguments: {action: 'report_run', id}},
      next_safe_action:
        'Inspect this original workbook run, retained query revision and current access before retrieving results or resuming collection.',
    };
  if (kind === 'campaign')
    return {
      website_path: '/campaigns?id=' + encoded,
      next_call: {tool: 'amcp_campaign', arguments: {action: 'get', id}},
      next_safe_action: 'Inspect the original plan, step receipts and required approvals before continuing.',
    };
  if (kind === 'upload')
    return {
      website_path: '/media?review_id=' + encoded,
      next_call: {tool: 'amcp_media', arguments: {action: 'recovery', review_id: id}},
      next_safe_action:
        'Inspect this original review and retained receipt. Recovery decides whether the same upload can resume.',
    };
  if (kind === 'incident')
    return {
      website_path: '/monitors?incident_id=' + encoded,
      next_call: {tool: 'amcp_workspace', arguments: {action: 'incident', id}},
      next_safe_action: 'Inspect the measurement context and evidence before acknowledging or deferring attention.',
    };
  if (kind === 'schedule')
    return {
      website_path: '/schedules?schedule_id=' + encoded,
      next_call: {tool: 'amcp_reporting_overview', arguments: {action: 'preview_schedule', id}},
      next_safe_action: 'Inspect the schedule, current access and destination before resuming delivery.',
    };
  return {
    website_path: '/reporting-overview?report_id=' + encodeURIComponent(kind === 'export' ? p.report_id : id),
    next_call: {
      tool: 'amcp_reporting_overview',
      arguments: {action: kind === 'export' ? 'export_status' : 'get', id, ...(kind === 'report' ? {limit: 1} : {})},
    },
    next_safe_action:
      kind === 'export'
        ? 'Inspect the original delivery job and destination receipt before an explicit retry.'
        : 'Inspect collection evidence, completeness and retained delivery receipts.',
  };
}
export function operationsPage(store: Store, actor: Actor, input: JsonObject, allowWrites: boolean) {
  store.assertActorActive(actor);
  const kind = input.kind ?? 'all',
    state = input.state ?? 'all',
    search = input.search ?? '',
    limit = input.limit ?? 30;
  if (!['all', ...operationKinds].includes(kind) || !operationStates.includes(state))
    bad('Choose a supported operation kind and attention state.');
  if (typeof search !== 'string' || search.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 100)
    bad('Use a search up to 200 characters and a page size of 1–100.');
  for (const key of ['account_id', 'connection_id'])
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 200))
      bad('Use an exact ' + key + '.');
  const filters = {
    kind,
    state,
    search: search.trim().toLowerCase(),
    account_id: input.account_id ?? '',
    connection_id: input.connection_id ?? '',
  };
  const binding = fingerprint({
    tenant: actor.tenantId,
    user: actor.userId,
    role: actor.role,
    session: store.sessionIdentity(actor) ?? null,
    filters,
  });
  let after: JsonObject | null = null;
  if (input.cursor !== undefined) {
    try {
      if (typeof input.cursor !== 'string' || input.cursor.length > 1024) throw Error();
      after = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (
        after?.version !== 1 ||
        after.binding !== binding ||
        !Number.isSafeInteger(after.at) ||
        after.at < 0 ||
        !feedKinds.includes(after.kind) ||
        typeof after.id !== 'string' ||
        after.id.length > 160
      )
        throw Error();
    } catch {
      bad('Use the next_cursor from this identity and exact set of filters, or refresh the feed.', 'INVALID_CURSOR');
    }
  }
  const selectedKind = feedKinds[operationKinds.indexOf(kind)] ?? null;
  const at = Date.now();
  const rows = store.db
    .prepare(query())
    .all(
      at,
      actor.tenantId,
      ...documentKinds,
      actor.tenantId,
      actor.tenantId,
      actor.tenantId,
      selectedKind,
      selectedKind,
      after?.at ?? null,
      after?.at ?? null,
      after?.at ?? null,
      after?.kind ?? null,
      after?.kind ?? null,
      after?.id ?? null,
    ) as JsonObject[];
  const operations: JsonObject[] = [];
  let last: JsonObject | undefined,
    hasMore = false;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (index === scanLimit) {
      hasMore = true;
      break;
    }
    const p = JSON.parse(row.metadata),
      k = operationKinds[feedKinds.indexOf(row.kind)]!;
    let permitted = true;
    if (k === 'campaign' && !ownsRecord(actor, p) && actor.role !== 'admin') permitted = false;
    // An upload review stays with the credential that prepared it, like every write review: its recovery refuses others.
    if (k === 'upload' && (p.user_id !== actor.userId || actor.role === 'reader' || !allowWrites)) permitted = false;
    // A standalone review is its maker's (the credential, or the same person), or an administrator's (WRT-08).
    if (k === 'write' && p.user_id !== actor.userId && !ownsRecord(actor, p) && actor.role !== 'admin')
      permitted = false;
    let scopes = typeof p.scopes === 'string' ? JSON.parse(p.scopes) : p.scopes;
    if (['workbook_report', 'workbook_schedule'].includes(k)) {
      try {
        scopes = [reportRunScope(store, actor, p)];
      } catch (e) {
        if (!(e instanceof MirrorError)) throw e;
        permitted = false;
        scopes = [];
      }
    }
    if (!Array.isArray(scopes) || !scopes.length || scopes.length > 50) permitted = false;
    if (permitted) {
      try {
        for (const s of scopes) {
          const gateway = s.gateway ?? reportPlatforms[s.platform]?.gateway;
          if (
            !gateway ||
            typeof s.account_id !== 'string' ||
            !s.account_id ||
            typeof s.connection_id !== 'string' ||
            !s.connection_id
          ) {
            permitted = false;
            break;
          }
          const c = store.resolveConnection(actor, gateway, s.account_id, s.connection_id);
          if (k === 'upload') assertAccountWrite(store, c, normalizeAccount(gateway, s.account_id));
        }
      } catch (e) {
        if (!(e instanceof MirrorError)) throw e;
        permitted = false;
      }
    }
    const attentionState =
      k === 'incident' ? incidentAttention(p, at) : k === 'write' ? writeRecordState(p, at) : (p.state ?? 'unknown');
    const group = category(k, attentionState);
    const matches =
      permitted &&
      (state === 'all' || state === group) &&
      scopes.some(
        (s: JsonObject) =>
          (!filters.account_id || s.account_id === filters.account_id) &&
          (!filters.connection_id || s.connection_id === filters.connection_id),
      ) &&
      (!filters.search ||
        [row.id, p.name, ...scopes.map((s: JsonObject) => s.account_id)]
          .join(' ')
          .toLowerCase()
          .includes(filters.search));
    if (matches && operations.length === limit) {
      hasMore = true;
      break;
    }
    last = row;
    if (!matches) continue;
    operations.push({
      key: k + ':' + row.id,
      kind: k,
      id: row.id,
      revision: row.revision,
      name: String(p.name ?? row.id).slice(0, 200),
      state: attentionState,
      source_state: k === 'write' ? (p.claim_state ?? 'none') : (p.source_state ?? p.state),
      category: group,
      updated_at: row.at || null,
      accounts: [...new Set(scopes.map((s: JsonObject) => s.account_id))],
      ...(typeof p.error_code === 'string' && /^[A-Z0-9_]{1,100}$/.test(p.error_code)
        ? {error_code: p.error_code}
        : {}),
      ...(k === 'incident' && attentionState === 'snoozed' ? {snoozed_until: p.snoozed_until} : {}),
      ...(['schedule', 'workbook_schedule'].includes(k) && ['active', 'attention'].includes(p.state)
        ? {next_run_at: p.next_run_at}
        : {}),
      ...handoff(k, row.id, p),
      automatic_retry_of_mutation: false,
    });
  }
  store.assertActorActive(actor);
  return {
    operations,
    has_more: hasMore,
    next_cursor:
      hasMore && last
        ? Buffer.from(JSON.stringify({version: 1, binding, at: last.at, kind: last.kind, id: last.id})).toString(
            'base64url',
          )
        : null,
    coverage: operationKinds,
    filters,
    network_requests: 0,
    captured_at: at,
    website_path: '/operations',
    meaning:
      'Retained campaign plans, upload reviews, reporting snapshots, export jobs, overview schedules, incidents, workbook report runs/schedules and standalone reviewed writes with identifiable account scope within current access. This is a live metadata feed, not an immutable audit history. Updates can move rows between pages; refresh to see the latest state. An empty page can still have a continuation. Each continuation checks current access again.',
  };
}
