import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {reportPlatforms} from './report-metrics.js';
import {normalizeAccount} from './scope.js';
import {fingerprint} from './workspace-core.js';
import {accountAliases} from './parameters.js';

// SQLite extracts only the canonical account anchor and bounded metadata. The job's retained configuration,
// rather than the current query definition, determines access to old results. Full inputs/results never leave
// SQLite for the Operations feed or status endpoint. Native aliases are shared with the compiler; scope
// inferred only from a resource path, an opaque body string or a provider response fails closed.
const native = "json_extract(j.input,'$.query_config.gateway') IS NOT NULL";
const scopeField = (path: string, limit = 201) => `CASE
  WHEN json_type(j.input,'${path}') IS NULL OR json_type(j.input,'${path}')='null' THEN NULL
  WHEN json_type(j.input,'${path}')='text' THEN substr(json_extract(j.input,'${path}'),1,${limit})
  ELSE json('{"invalid":true}') END`;
const reference = (key: string) => `CASE WHEN json_type(j.input,'$.${key}')='text'
  AND length(json_extract(j.input,'$.${key}'))<=160 THEN json_extract(j.input,'$.${key}') END`;
const anchor = (key: string) => `CASE WHEN ${native} THEN
  CASE WHEN json_type(j.input,'$.query_config.arguments.operation')='text'
    THEN ${scopeField('$.query_config.arguments.arguments.' + key)}
    ELSE ${scopeField('$.query_config.arguments.' + key)} END
  ELSE ${scopeField('$.query_config.' + key)} END`;
const accountAnchors = `CASE WHEN ${native} THEN CASE json_extract(j.input,'$.query_config.gateway')
  ${Object.entries(accountAliases)
    .map(
      ([gateway, aliases]) =>
        `WHEN '${gateway}' THEN json_array(${aliases
          .flatMap(key =>
            ['', 'params.', 'path_params.', 'pathParams.', 'query.', 'payload.', 'body.'].map(bag => anchor(bag + key)),
          )
          .join(',')})`,
    )
    .join('\n')}
  ELSE json_array(${anchor('account_id')},${anchor('params.account_id')},${anchor('path_params.account_id')}) END
  ELSE json_array(${scopeField('$.query_config.account_id')}) END`;
const revision =
  "CASE WHEN json_type(j.input,'$.query_revision')='integer' THEN json_extract(j.input,'$.query_revision') END";
const jobState =
  "CASE WHEN j.state IN ('queued','running','failed','cancelled','complete') THEN j.state ELSE 'unknown' END";
export function reportScopeFieldsSQL(column: 'j.input' | 'q.data') {
  return `'platform',CASE WHEN ${native} THEN NULL ELSE ${scopeField('$.query_config.platform', 81)} END,
    'gateway',${scopeField('$.query_config.gateway', 101)},
    'account_anchors',${accountAnchors},'connection_anchors',json_array(${anchor('connection_id')},${anchor('connectionId')})`.replaceAll(
    'j.input',
    column,
  );
}
export const reportRunFeedSQL = `SELECT j.id, 'workbook_report' AS kind,
  ${revision} AS revision, j.updated_at AS at,
  json_object(
    'name',substr(coalesce(CASE WHEN json_type(j.input,'$.query_name')='text' THEN json_extract(j.input,'$.query_name') END,
      CASE WHEN json_type(q.data,'$.name')='text' THEN json_extract(q.data,'$.name') END,j.id),1,200),
    'name_source',CASE WHEN json_type(j.input,'$.query_name')='text' THEN 'retained_run'
      WHEN json_type(q.data,'$.name')='text' THEN 'current_query' ELSE 'run_id' END,
    'state',CASE WHEN j.state='queued' AND j.available_at=9007199254740991 THEN 'prepared' ELSE ${jobState} END,
    'source_state',${jobState},'attempts',j.attempts,'created_at',j.created_at,'available_at',j.available_at,
    'query_id',${reference('query_id')},'query_revision',${revision},
    'schedule_id',${reference('schedule_id')},
    ${reportScopeFieldsSQL('j.input')},
    'error_code',CASE WHEN json_valid(j.error) THEN substr(json_extract(j.error,'$.code'),1,101) END,
    'result_available',CASE WHEN j.state='complete' AND j.result IS NOT NULL THEN 1 ELSE 0 END
  ) AS metadata
  FROM jobs j LEFT JOIN documents q ON q.tenant_id=j.tenant_id AND q.kind='reporting_query'
    AND q.id=json_extract(j.input,'$.query_id')
  WHERE j.tenant_id=? AND j.kind='report'`;

export function reportRunScope(store: Store, actor: Actor, p: JsonObject) {
  const gateway = p.gateway ?? reportPlatforms[p.platform]?.gateway;
  const accounts = Array.isArray(p.account_anchors) ? p.account_anchors.filter(v => v !== null) : [],
    connections = Array.isArray(p.connection_anchors) ? p.connection_anchors.filter(v => v !== null) : [];
  if (
    typeof gateway !== 'string' ||
    !gateway ||
    gateway.length > 100 ||
    !accounts.length ||
    [...accounts, ...connections].some(v => typeof v !== 'string' || !v || v.length > 200)
  )
    throw new MirrorError(
      'REPORT_SCOPE_UNAVAILABLE',
      'This reporting record has no unambiguous account scope. Save a query with an explicit provider account identifier and connection_id, then prepare a new run.',
      {},
      403,
    );
  const normalized = new Set(accounts.map(v => normalizeAccount(gateway, v))),
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
  const row = store.db.prepare(reportRunFeedSQL + ' AND j.id=?').get(actor.tenantId, id) as JsonObject | undefined;
  if (!row) {
    const exists = store.db.prepare('SELECT kind FROM jobs WHERE tenant_id=? AND id=?').get(actor.tenantId, id);
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
