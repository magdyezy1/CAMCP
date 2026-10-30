import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {reportPlatforms} from './report-metrics.js';
import {normalizeAccount} from './scope.js';
import {fingerprint} from './workspace-core.js';
import {reportingAnchorKind, reportingResourceAccount, reportingResourceAccounts} from './report-resource-scope.js';
import {reportRunRow} from './workbook-repository.js';
import {jobKind} from './job-repository.js';

// The account-scope projection and the report run feed are in the store layer (src/workbook-repository.ts, ARC-02).
export {reportRunFeedSQL, reportScopeFieldsSQL} from './workbook-repository.js';

export function reportRunScope(store: Store, actor: Actor, p: JsonObject) {
  const gateway = p.gateway ?? reportPlatforms[p.platform]?.gateway;
  const groups = Array.isArray(p.encoded_account_anchors) ? p.encoded_account_anchors : [];
  const resourceGroups = Array.isArray(p.resource_account_anchors) ? p.resource_account_anchors : [],
    resources = resourceGroups.flat().filter(row => row?.value !== null),
    resourceAccounts = reportingResourceAccounts(
      gateway,
      resources,
      Array.isArray(p.account_anchors) ? p.account_anchors.filter(v => v !== null) : [],
    );
  const accounts = Array.isArray(p.account_anchors)
      ? [...p.account_anchors, ...groups.flat(), ...resourceAccounts].filter(v => v !== null)
      : [],
    connections = Array.isArray(p.connection_anchors) ? p.connection_anchors.filter(v => v !== null) : [];
  if (
    typeof gateway !== 'string' ||
    !gateway ||
    gateway.length > 100 ||
    p.encoded_body_invalid === 1 ||
    p.resource_body_invalid === 1 ||
    resourceGroups.some(g => !Array.isArray(g)) ||
    resources.length > 8 ||
    groups.some(g => !Array.isArray(g) || g.length > 8) ||
    !accounts.length ||
    [...accounts, ...connections].some(v => typeof v !== 'string' || !v || v.length > 200)
  )
    throw new MirrorError(
      'REPORT_SCOPE_UNAVAILABLE',
      'This reporting record has no unambiguous account scope. Save a query with an explicit provider account identifier and connection_id, then prepare a new run.',
      {},
      403,
    );
  // An anchor in a provider's resource form names its account through that provider's selector check.
  const normalized = new Set(
      accounts.map(v => {
        const kind = reportingAnchorKind(gateway, v);
        return kind ? reportingResourceAccount(gateway, {kind, value: v}) : normalizeAccount(gateway, v);
      }),
    ),
    account = normalized.values().next().value;
  if (!account || normalized.size !== 1 || new Set(connections).size > 1)
    throw new MirrorError(
      'REPORT_SCOPE_UNAVAILABLE',
      'The retained run has empty or conflicting account or connection scope.',
      {},
      403,
    );
  const connection = store.resolveConnection(actor, gateway, account, connections[0]);
  return {gateway, account_id: account, connection_id: connection.id};
}

export function reportRunStatus(store: Store, actor: Actor, id: unknown): JsonObject {
  store.assertActorActive(actor);
  if (typeof id !== 'string' || !id || id.length > 160)
    throw new MirrorError('INVALID_REPORT_RUN', 'Choose an exact reporting run ID.');
  const row = reportRunRow(store, actor.tenantId, id);
  if (!row) {
    const exists = jobKind(store, actor.tenantId, id);
    throw new MirrorError(
      exists ? 'INVALID_REPORT_RUN' : 'NOT_FOUND',
      exists ? 'The job is not a reporting run.' : 'Reporting run not found in this tenant.',
      {},
      exists ? 400 : 404,
    );
  }
  const p = JSON.parse(row.metadata),
    scope = reportRunScope(store, actor, p);
  const writeRejected = p.error_code === 'REPORT_WRITE_FORBIDDEN';
  const resumable = ['prepared', 'failed', 'cancelled'].includes(p.state) && !writeRejected;
  const result: JsonObject = {
    id,
    run_id: id,
    record_kind: 'workbook_report',
    name: p.name,
    name_source: p.name_source,
    state: p.state,
    source_state: p.source_state,
    ...scope,
    query_id: p.query_id,
    query_revision: p.query_revision,
    schedule_id: p.schedule_id,
    created_at: p.created_at,
    updated_at: row.at,
    attempts: p.attempts,
    available_at: p.state === 'prepared' ? null : p.available_at,
    result_available: p.result_available === 1,
    can_resume: resumable && actor.role !== 'reader',
    run_version: fingerprint({id, at: row.at, metadata: p, scope}),
    destination: 'local',
    external_writes: false,
    network_requests: 0,
    automatic_retry_of_mutation: false,
    website_path: '/operations?run_id=' + encodeURIComponent(id),
    next_safe_action: writeRejected
      ? 'The retained query requests a write. Save a corrected read-only query and prepare a new run.'
      : p.state === 'complete'
        ? 'The original run is complete. Retrieve its retained result through MCP; prepare a new run for fresh data.'
        : ['running', 'queued'].includes(p.state)
          ? 'Refresh this original run to follow the worker. A queued run waits for an active worker; do not create duplicates.'
          : resumable
            ? 'Inspect the original query revision and account. Confirm resuming this read-only report with your current access; its original run ID is retained.'
            : 'Inspect this original run and ask the workspace owner to diagnose its state before continuing.',
    next_call: {
      tool: 'amcp_native_action',
      arguments: {
        operation: p.state === 'complete' ? 'get_reporting_run' : 'get_reporting_run_status',
        arguments: {run_id: id},
      },
    },
  };
  if (typeof p.error_code === 'string' && /^[A-Z0-9_]{1,100}$/.test(p.error_code)) result.error_code = p.error_code;
  if (result.can_resume) result.resume_requirements = {confirmed: true, run_version: result.run_version};
  store.assertActorActive(actor);
  return result;
}

export function resumeReportRun(store: Store, actor: Actor, input: JsonObject) {
  return store.transaction(() => {
    const status = reportRunStatus(store, actor, input.id);
    if (actor.role === 'reader')
      throw new MirrorError('FORBIDDEN', 'An operator must resume report authority.', {}, 403);
    if (input.confirmed !== true)
      throw new MirrorError(
        'CONFIRMATION_REQUIRED',
        'Confirm resuming this original read-only report with current access.',
      );
    if (input.run_version !== status.run_version)
      throw new MirrorError(
        'STALE_REPORT_RUN',
        'The run changed. Refresh and inspect its current state before resuming.',
        {},
        409,
      );
    if (!status.can_resume)
      throw new MirrorError(
        'INVALID_JOB_STATE',
        'Only prepared, failed or cancelled reporting runs can be resumed here.',
        {},
        409,
      );
    store.resumeReport(actor, status.id);
    return reportRunStatus(store, actor, status.id);
  });
}
