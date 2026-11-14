import type {Store} from './store.js';
import type {JsonObject} from './types.js';
import type {ReportSelectorGroup, ReportSelectors} from './provider-adapter.js';
import {accountAliases, encodedBodyGateways} from './parameters.js';
import {registeredProviderHooks} from './provider-hooks.js';

/**
 * Workbook reporting records in the store layer (ARC-02): saved queries (`reporting_query`), workbook schedules
 * (`reporting_schedule`), workbook bindings (`workbook`) and report runs (`report` jobs), with the metadata projections
 * that read their account scope out of the stored JSON in SQLite. The projections and statements moved here verbatim
 * from src/report-runs.ts, src/report-resource-scope.ts, src/report-query-access.ts, src/workbook-schedules.ts,
 * src/workbook-bindings.ts, src/workbook-queries.ts, src/report-query-rebinding.ts, src/reporting.ts and
 * src/withheld-workbook-records.ts, which re-export the projections they published. Every statement is bound to one
 * workspace.
 */

// The account scope projection (from src/report-runs.ts).
// SQLite extracts only the canonical account anchor and bounded metadata. The job's retained configuration,
// rather than the current query definition, determines access to old results. Full inputs/results never leave
// SQLite for the Operations feed or status endpoint. Native aliases are shared with the compiler.
// Supported encoded JSON bodies and delegated resource selectors contribute bounded exact account fields,
// never body text. Arbitrary endpoint paths, unsupported opaque formats and provider responses are not scope.
const native = "json_extract(j.input,'$.query_config.gateway') IS NOT NULL";
const scopeField = (path: string, limit = 201) => `CASE
  WHEN json_type(j.input,'${path}') IS NULL OR json_type(j.input,'${path}')='null' THEN NULL
  WHEN json_type(j.input,'${path}')='text' THEN substr(json_extract(j.input,'${path}'),1,${limit})
  ELSE json('{"invalid":true}') END`;
const reference = (key: string) => `CASE WHEN json_type(j.input,'$.${key}')='text'
  AND length(json_extract(j.input,'$.${key}'))<=160 THEN json_extract(j.input,'$.${key}') END`;
const anchor = (key: string, limit = 201) => `CASE WHEN ${native} THEN
  CASE WHEN json_type(j.input,'$.query_config.arguments.operation')='text'
    THEN ${scopeField('$.query_config.arguments.arguments.' + key, limit)}
    ELSE ${scopeField('$.query_config.arguments.' + key, limit)} END
  ELSE ${scopeField('$.query_config.' + key, limit)} END`;
const accountAnchors = `CASE WHEN ${native} THEN CASE json_extract(j.input,'$.query_config.gateway')
  ${Object.entries(accountAliases)
    .map(
      ([gateway, aliases]) =>
        `WHEN '${gateway}' THEN json_array(${aliases
          .flatMap(key =>
            [
              '',
              'params.',
              'path_params.',
              'pathParams.',
              'query.',
              'payload.',
              'body.',
              'params.payload.',
              'params.body.',
            ].map(bag => anchor(bag + key)),
          )
          .join(',')})`,
    )
    .join('\n')}
  ELSE json_array(${anchor('account_id')},${anchor('params.account_id')},${anchor('path_params.account_id')}) END
  ELSE json_array(${scopeField('$.query_config.account_id')}) END`;
const bodyLocations = ['payload', 'body', 'params.payload', 'params.body'];
const encodedSupported = `${native} AND json_extract(j.input,'$.query_config.gateway') IN (${encodedBodyGateways.map(g => `'${g}'`).join(',')})`;
const bodyCell = (bag: string) => `CASE WHEN json_type(j.input,'$.query_config.arguments.operation')='text'
  THEN json_extract(j.input,'$.query_config.arguments.arguments.${bag}')
  ELSE json_extract(j.input,'$.query_config.arguments.${bag}') END`;
const bodyType = (bag: string) => `CASE WHEN json_type(j.input,'$.query_config.arguments.operation')='text'
  THEN json_type(j.input,'$.query_config.arguments.arguments.${bag}')
  ELSE json_type(j.input,'$.query_config.arguments.${bag}') END`;
const encodedValid = (bag: string) => `CASE WHEN ${bodyType(bag)}='text'
  AND length(CAST(${bodyCell(bag)} AS BLOB))<=65536 AND json_valid(${bodyCell(bag)})
  THEN json_type(${bodyCell(bag)})='object' ELSE 0 END`;
// json_each preserves repeated keys: conflicting duplicate identifiers must not be hidden by first/last-key parsing.
// Nine projected occurrences are sufficient to reject more than eight; arbitrary body fields never leave SQLite.
// Each scalar subquery is wrapped in json(): from SQLite 3.54 (bundled with Node 24.22.3) a subquery's result does not keep
// its JSON subtype, so the enclosing json_array would quote the array as a string. json() marks it as JSON on every version.
const encodedAnchors = `CASE WHEN ${encodedSupported} THEN json_array(${bodyLocations
  .map(
    bag => `json((
  SELECT json_group_array(CASE WHEN v.type='text' THEN substr(v.value,1,201)
    WHEN v.type='null' THEN NULL ELSE json('{"invalid":true}') END)
  FROM (SELECT type,value FROM json_each(CASE WHEN ${encodedValid(bag)} THEN ${bodyCell(bag)} ELSE '{}' END)
    WHERE CASE json_extract(j.input,'$.query_config.gateway')
      ${encodedBodyGateways.map(g => `WHEN '${g}' THEN key IN (${accountAliases[g]!.map(key => `'${key}'`).join(',')})`).join('\n')} ELSE 0 END
    LIMIT 9) v))`,
  )
  .join(',')}) ELSE json_array() END`;
const encodedInvalid = `CASE WHEN ${encodedSupported} AND (${bodyLocations.map(bag => `(${bodyType(bag)}='text' AND NOT (${encodedValid(bag)}))`).join(' OR ')}) THEN 1 ELSE 0 END`;
const revision =
  "CASE WHEN json_type(j.input,'$.query_revision')='integer' THEN json_extract(j.input,'$.query_revision') END";
const jobState =
  "CASE WHEN j.state IN ('queued','running','failed','cancelled','complete') THEN j.state ELSE 'unknown' END";

/**
 * The providers whose saved queries name their accounts by resource selectors, with where the selectors are, in
 * their branches' order (ARC-01, reporting: the selectors of the reportScope hooks, src/<provider>-adapter.ts). They
 * are data: each value is a plain name, checked here before the projection quotes it as a SQL string.
 */
export function reportSelectorProviders(
  hooks: readonly {gateway: string; reportScope?: {selectors?: ReportSelectors}}[],
) {
  const name = /^[a-z0-9_]+$/,
    path = /^\$(?:\.(?:[a-z]+|"[a-z_]+"))*$/,
    providers = hooks.flatMap(({gateway, reportScope}) =>
      reportScope?.selectors ? [{gateway, selectors: reportScope.selectors}] : [],
    );
  for (const {gateway, selectors} of providers) {
    const {order, groups, kinds = {}, otherwise, body} = selectors;
    const plain =
      name.test(gateway) &&
      Number.isInteger(order) &&
      order > 0 &&
      providers.filter(other => other.selectors.order === order).length === 1 &&
      groups.length > 0 &&
      groups.every(
        group =>
          (group.paths ? group.paths.length > 0 && group.within === undefined : typeof group.within === 'string') &&
          [...(group.paths ?? []), ...(group.within === undefined ? [] : [group.within])].every(p => path.test(p)) &&
          group.keys.length > 0 &&
          group.keys.every(key => name.test(key)),
      ) &&
      [...Object.entries(kinds).flat(), otherwise, ...(body === undefined ? [] : [body])].every(value =>
        name.test(value),
      );
    if (!plain) throw new Error('The report selectors of ' + gateway + ' are not plain, ordered names.');
  }
  return providers.sort((a, b) => a.selectors.order - b.selectors.order);
}
const selectorProviders = reportSelectorProviders(registeredProviderHooks);

/** SQLite projects at most nine native scope selectors from a bounded argument object.
 * json_tree preserves repeated keys; the compiler's alias comparison is shared through a pure SQLite function.
 * Complete definitions, unrelated body fields and native child resources never leave the metadata endpoint.
 * (From src/report-resource-scope.ts, which re-exports it.)
 */
export function reportResourceFieldsSQL(native: string) {
  const source = "CASE WHEN length(CAST(j.input AS BLOB))<=131072 THEN j.input ELSE '{}' END",
    config = `json_extract(${source},'$.query_config')`,
    wrapper = `json_extract(${source},'$.query_config.arguments')`,
    occurrences = (cell: string, key: string) => `(SELECT count(*) FROM json_each(${cell}) WHERE key='${key}')`,
    wrapped = "json_type(j.input,'$.query_config.arguments.operation')='text'",
    envelopeValid = `length(CAST(j.input AS BLOB))<=131072
      AND ${occurrences(source, 'query_config')}=1 AND json_type(${source},'$.query_config')='object'
      AND ${occurrences(config, 'gateway')}=1 AND ${occurrences(config, 'arguments')}=1
      AND CASE WHEN ${wrapped} THEN ${occurrences(wrapper, 'operation')}=1 AND ${occurrences(wrapper, 'arguments')}=1 ELSE 1 END`,
    args = `CASE WHEN ${wrapped} THEN json_extract(j.input,'$.query_config.arguments.arguments')
      ELSE json_extract(j.input,'$.query_config.arguments') END`,
    argsType = `CASE WHEN ${wrapped} THEN json_type(j.input,'$.query_config.arguments.arguments')
      ELSE json_type(j.input,'$.query_config.arguments') END`,
    valid = `${envelopeValid} AND ${argsType}='object' AND length(CAST(${args} AS BLOB))<=65536`,
    bounded = `CASE WHEN ${valid} THEN ${args} ELSE '{}' END`,
    key = 'native_parameter_key(r.key)',
    // A provider's selector fields (its reportScope hook's selectors) as the json_tree condition that finds them.
    quoted = (values: readonly string[]) => values.map(value => `'${value}'`).join(','),
    keyed = (keys: readonly string[]) => (keys.length === 1 ? `${key}='${keys[0]}'` : `${key} IN (${quoted(keys)})`),
    located = ({paths, within}: ReportSelectorGroup) =>
      within === undefined
        ? `r.path IN (${quoted(paths!)})`
        : `(r.path='${within}' OR substr(r.path,1,${within.length + 1}) IN ('${within}.','${within}['))`,
    selected = (group: ReportSelectorGroup) =>
      `${located(group)} AND ${keyed(group.keys)}` +
      (group.resourceNames ? `\n        AND (r.type!='text' OR instr(r.value,'/')>0)` : ''),
    condition = ({groups}: ReportSelectors) =>
      groups.length === 1 ? selected(groups[0]!) : groups.map(group => `(${selected(group)})`).join('\n      OR '),
    kindOf = ({kinds = {}, otherwise}: ReportSelectors) => {
      const named = Object.entries(kinds);
      if (!named.length) return `'${otherwise}'`;
      if (named.length === 1)
        return `CASE WHEN ${key}='${named[0]![0]}' THEN '${named[0]![1]}' ELSE '${otherwise}' END`;
      return `CASE ${key} ${named.map(([field, kind]) => `WHEN '${field}' THEN '${kind}'`).join(' ')} ELSE '${otherwise}' END`;
    },
    // Wrapped in json() as encodedAnchors is: SQLite 3.54 does not keep a scalar subquery's JSON subtype.
    project = (where: string, kind: string) => `json((SELECT json_group_array(json_object('kind',v.kind,'value',
      CASE WHEN v.type='text' THEN substr(v.value,1,513) ELSE json('{"invalid":true}') END))
      FROM (SELECT r.type,r.value,${kind} AS kind FROM json_tree(${bounded}) r WHERE ${where} LIMIT 9) v))`,
    invalidBody = (body: string) => `EXISTS(SELECT 1 FROM json_tree(${bounded}) r
      WHERE r.path='$' AND r.key='${body}' AND r.type!='object')`,
    anchors = selectorProviders.map(
      ({gateway, selectors}) => `
      WHEN '${gateway}' THEN json_array(${project(condition(selectors), kindOf(selectors))})`,
    ),
    invalid = selectorProviders.map(
      ({gateway, selectors: {body}}) => `
      WHEN '${gateway}' THEN CASE WHEN NOT coalesce((${valid}),0)${body === undefined ? '' : ' OR ' + invalidBody(body)} THEN 1 ELSE 0 END`,
    );
  return `'resource_account_anchors',CASE WHEN ${native} THEN CASE json_extract(j.input,'$.query_config.gateway')${anchors.join('')}
      ELSE json_array() END ELSE json_array() END,
    'resource_body_invalid',CASE WHEN ${native} THEN CASE json_extract(j.input,'$.query_config.gateway')${invalid.join('')}
      ELSE 0 END ELSE 0 END`;
}
/** The bounded account-scope metadata of a stored configuration column (a run's input or a query's data). */
export function reportScopeFieldsSQL(column: 'j.input' | 'q.data') {
  return `'platform',CASE WHEN ${native} THEN NULL ELSE ${scopeField('$.query_config.platform', 81)} END,
    'gateway',${scopeField('$.query_config.gateway', 101)},
    'account_anchors',${accountAnchors},'encoded_account_anchors',${encodedAnchors},'encoded_body_invalid',${encodedInvalid},
    'connection_anchors',json_array(${anchor('connection_id')},${anchor('connectionId')}),
    ${reportResourceFieldsSQL(native)}`.replaceAll('j.input', column);
}
/** A workspace's report runs as Operations feed rows (one parameter: the workspace). */
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

// Workbook schedules as feed rows (from src/workbook-schedules.ts).
const text = (key: string, limit = 160) => `CASE WHEN json_type(d.data,'$.${key}')='text'
  AND length(json_extract(d.data,'$.${key}'))<=${limit} THEN json_extract(d.data,'$.${key}') END`;
const integer = (key: string) =>
  `CASE WHEN json_type(d.data,'$.${key}')='integer' THEN json_extract(d.data,'$.${key}') END`;
const timestamp = (key: string) => `coalesce(CASE WHEN json_type(d.data,'$.${key}')='integer'
  THEN json_extract(d.data,'$.${key}')
  ELSE cast(unixepoch(json_extract(d.data,'$.${key}'),'subsec')*1000 AS integer) END,0)`;
/** A workspace's workbook schedules as Operations feed rows (one parameter: the workspace). */
export const workbookScheduleFeedSQL = `SELECT d.id,'workbook_schedule' AS kind,d.revision,
  max(${timestamp('updated_at')},${timestamp('last_run_at')}) AS at,
  json_object('name',coalesce(${text('name', 200)},d.id),
    'state',CASE WHEN json_extract(d.data,'$.error.code') IS NOT NULL THEN 'failed'
      WHEN json_extract(d.data,'$.is_active')=1 AND json_extract(d.data,'$.schedule_warning.code') IS NOT NULL THEN 'attention'
      WHEN json_extract(d.data,'$.is_active')=1 THEN 'active' ELSE 'paused' END,
    'active',CASE WHEN json_extract(d.data,'$.is_active')=1 THEN 1 ELSE 0 END,
    'timezone',${text('timezone', 80)},'schedule_kind',${text('schedule_kind', 20)},
    'minute',${integer('schedule_config.minute')},'hour',${integer('schedule_config.hour')},
    'weekday',${integer('schedule_config.weekday')},'day',${integer('schedule_config.day')},
    'query_id',${text('schedule_config.query_id')},'query_revision',q.revision,
    'next_run_at',${integer('next_run_at')},'last_run_id',${text('last_run_id')},
    'error_code',substr(coalesce(json_extract(d.data,'$.error.code'),json_extract(d.data,'$.schedule_warning.code')),1,101),
    ${reportScopeFieldsSQL('q.data')}
  ) AS metadata
  FROM documents d LEFT JOIN documents q ON q.tenant_id=d.tenant_id AND q.kind='reporting_query'
    AND q.id=json_extract(d.data,'$.schedule_config.query_id')
  WHERE d.tenant_id=? AND d.kind='reporting_schedule'`;

// Saved queries (from src/report-query-access.ts).
/** A workspace's saved queries with their size and scope metadata (one parameter: the workspace). */
export const reportQuerySQL = `SELECT q.id,q.revision,length(CAST(q.data AS BLOB)) AS bytes,json_object(
  'name',substr(json_extract(q.data,'$.name'),1,120),
  'workbook_binding_id',substr(json_extract(q.data,'$.workbook_binding_id'),1,160),
  'updated_at',json_extract(q.data,'$.updated_at'),
  ${reportScopeFieldsSQL('q.data')}) AS metadata
  FROM documents q WHERE q.tenant_id=? AND q.kind='reporting_query'`;
/** The scope metadata (JSON text) of an unsaved configuration, projected exactly as a saved query's. */
export function configurationScope(store: Store, config: JsonObject): JsonObject {
  return store
    .sql()
    .prepare(`SELECT json_object(${reportScopeFieldsSQL('q.data')}) AS metadata FROM (SELECT ? AS data) q`)
    .get(JSON.stringify({query_config: config})) as JsonObject;
}
/** One saved query's row (id, revision, bytes, metadata), or undefined. */
export function savedQuery(store: Store, tenant: string, id: string): JsonObject | undefined {
  return store
    .sql()
    .prepare(reportQuerySQL + ' AND q.id=?')
    .get(tenant, id) as JsonObject | undefined;
}
/** The rows of the saved queries attached to a workbook binding, at most 501 (the bound is 500). */
export function bindingQueries(store: Store, tenant: string, bindingId: string, ordered = false): JsonObject[] {
  return store
    .sql()
    .prepare(
      reportQuerySQL +
        " AND json_extract(q.data,'$.workbook_binding_id')=?" +
        (ordered ? ' ORDER BY q.id' : '') +
        ' LIMIT 501',
    )
    .all(tenant, bindingId) as JsonObject[];
}
/** 501 saved query rows from `offset`, by id; with a spreadsheet, only queries bound to a workbook of it. */
export function savedQueryPage(
  store: Store,
  tenant: string,
  spreadsheetId: string | undefined,
  offset: number,
): JsonObject[] {
  return store
    .sql()
    .prepare(
      reportQuerySQL +
        (spreadsheetId
          ? " AND EXISTS(SELECT 1 FROM documents w WHERE w.tenant_id=q.tenant_id AND w.kind='workbook' AND w.id=json_extract(q.data,'$.workbook_binding_id') AND json_extract(w.data,'$.spreadsheet_id')=?)"
          : '') +
        ' ORDER BY q.id LIMIT 501 OFFSET ?',
    )
    .all(tenant, ...(spreadsheetId ? [spreadsheetId] : []), offset) as JsonObject[];
}
/** How many saved queries a workbook binding has. */
export function bindingQueryCount(store: Store, tenant: string, bindingId: string): number {
  return (
    store
      .sql()
      .prepare(
        "SELECT count(*) AS n FROM documents WHERE tenant_id=? AND kind='reporting_query' AND json_extract(data,'$.workbook_binding_id')=?",
      )
      .get(tenant, bindingId) as JsonObject
  ).n;
}

// Workbook bindings (from src/report-query-access.ts, src/workbook-bindings.ts and src/reporting.ts).
/** A binding's size and creator, or undefined when it does not exist. */
export function workbookSize(store: Store, tenant: string, id: string): JsonObject | undefined {
  return store
    .sql()
    .prepare(
      "SELECT length(CAST(data AS BLOB)) AS bytes,json_extract(data,'$.created_by') AS creator FROM documents WHERE tenant_id=? AND kind='workbook' AND id=?",
    )
    .get(tenant, id) as JsonObject | undefined;
}
/**
 * The ids of up to 100 active bindings without queries that the person may manage (their own, or any for an
 * administrator), optionally of one spreadsheet, by id.
 */
export function emptyWorkbooks(
  store: Store,
  tenant: string,
  role: string,
  user: string,
  spreadsheetId: string | null,
): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT w.id FROM documents w WHERE w.tenant_id=? AND w.kind='workbook' AND json_extract(w.data,'$.retired_at') IS NULL AND (?='admin' OR json_extract(w.data,'$.created_by')=?) AND (? IS NULL OR json_extract(w.data,'$.spreadsheet_id')=?) AND NOT EXISTS(SELECT 1 FROM documents q WHERE q.tenant_id=w.tenant_id AND q.kind='reporting_query' AND json_extract(q.data,'$.workbook_binding_id')=w.id) ORDER BY w.id LIMIT 100",
    )
    .all(tenant, role, user, spreadsheetId, spreadsheetId) as JsonObject[];
}
/** 51 binding ids from `offset`, by id: all, active or retired ones, optionally of one spreadsheet. */
export function workbookPage(
  store: Store,
  tenant: string,
  state: 'all' | 'active' | 'retired' | string,
  spreadsheetId: string | undefined,
  offset: number,
): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT id FROM documents WHERE tenant_id=? AND kind='workbook'" +
        (state === 'all'
          ? ''
          : " AND json_extract(data,'$.retired_at') IS " + (state === 'active' ? 'NULL' : 'NOT NULL')) +
        (spreadsheetId ? " AND json_extract(data,'$.spreadsheet_id')=?" : '') +
        ' ORDER BY id LIMIT 51 OFFSET ?',
    )
    .all(tenant, ...(spreadsheetId ? [spreadsheetId] : []), offset) as JsonObject[];
}
/** The binding of a spreadsheet (its id), or undefined. */
export function workbookOfSpreadsheet(store: Store, tenant: string, spreadsheetId: string): JsonObject | undefined {
  return store
    .sql()
    .prepare(
      "SELECT id FROM documents WHERE tenant_id=? AND kind='workbook' AND json_extract(data,'$.spreadsheet_id')=? ORDER BY id LIMIT 1",
    )
    .get(tenant, spreadsheetId) as JsonObject | undefined;
}

// Workbook schedules (from src/report-query-access.ts, src/workbook-bindings.ts, src/workbook-queries.ts,
// src/report-query-rebinding.ts, src/reporting.ts and src/workbook-schedules.ts).
/** Up to 100 schedules (id, bytes) of one query and binding, by id. */
export function linkedSchedules(store: Store, tenant: string, queryId: string, bindingId: string): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT id,length(CAST(data AS BLOB)) AS bytes FROM documents WHERE tenant_id=? AND kind='reporting_schedule' AND json_extract(data,'$.schedule_config.query_id')=? AND json_extract(data,'$.workbook_binding_id')=? ORDER BY id LIMIT 100",
    )
    .all(tenant, queryId, bindingId) as JsonObject[];
}
/** Whether any schedule names the binding. */
export function bindingHasSchedule(store: Store, tenant: string, bindingId: string): JsonObject | undefined {
  return store
    .sql()
    .prepare(
      "SELECT 1 AS present FROM documents WHERE tenant_id=? AND kind='reporting_schedule' AND json_extract(data,'$.workbook_binding_id')=? LIMIT 1",
    )
    .get(tenant, bindingId) as JsonObject | undefined;
}
/** Up to 101 schedules of a query (id, revision, active), by id. */
export function querySchedules(store: Store, tenant: string, queryId: string): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT id,revision,json_extract(data,'$.is_active') AS active FROM documents WHERE tenant_id=? AND kind='reporting_schedule' AND json_extract(data,'$.schedule_config.query_id')=? ORDER BY id LIMIT 101",
    )
    .all(tenant, queryId) as JsonObject[];
}
/** How many active schedules a query has. */
export function activeQueryScheduleCount(store: Store, tenant: string, queryId: string): number {
  return Number(
    (
      store
        .sql()
        .prepare(
          "SELECT count(*) AS n FROM documents WHERE tenant_id=? AND kind='reporting_schedule' AND json_extract(data,'$.schedule_config.query_id')=? AND json_extract(data,'$.is_active')=1",
        )
        .get(tenant, queryId) as JsonObject
    ).n,
  );
}
/** Up to 101 schedules of a query with their size, binding and active state (id, revision, bytes, binding_id, active). */
export function queryScheduleBindings(store: Store, tenant: string, queryId: string): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT id,revision,length(CAST(data AS BLOB)) AS bytes,json_extract(data,'$.workbook_binding_id') AS binding_id,json_extract(data,'$.is_active') AS active FROM documents WHERE tenant_id=? AND kind='reporting_schedule' AND json_extract(data,'$.schedule_config.query_id')=? ORDER BY id LIMIT 101",
    )
    .all(tenant, queryId) as JsonObject[];
}
/**
 * Moves one schedule revision to another binding and pauses it (a reviewed query move); how many changed (0 when the
 * schedule changed since it was read).
 */
export function moveSchedule(
  store: Store,
  tenant: string,
  id: string,
  revision: number,
  bindingId: string,
  at: string,
): number {
  return Number(
    store
      .sql()
      .prepare(
        "UPDATE documents SET data=json_set(data,'$.workbook_binding_id',?,'$.is_active',json('false'),'$.pause_reason','workbook_binding_changed','$.updated_at',?),revision=revision+1 WHERE tenant_id=? AND kind='reporting_schedule' AND id=? AND revision=?",
      )
      .run(bindingId, at, tenant, id, revision).changes,
  );
}
/** Pauses a query's active schedules after its definition changed; how many. */
export function pauseQuerySchedules(store: Store, tenant: string, queryId: string, at: string): number {
  return Number(
    store
      .sql()
      .prepare(
        "UPDATE documents SET data=json_set(data,'$.is_active',json('false'),'$.error',NULL,'$.pause_reason','query_definition_changed','$.updated_at',?),revision=revision+1 WHERE tenant_id=? AND kind='reporting_schedule' AND json_extract(data,'$.schedule_config.query_id')=? AND json_extract(data,'$.is_active')=1",
      )
      .run(at, tenant, queryId).changes,
  );
}
/** A schedule's size and query, or undefined. */
export function scheduleSize(store: Store, tenant: string, id: string): JsonObject | undefined {
  return store
    .sql()
    .prepare(
      "SELECT length(CAST(data AS BLOB)) AS bytes,json_extract(data,'$.schedule_config.query_id') AS query_id FROM documents WHERE tenant_id=? AND kind='reporting_schedule' AND id=?",
    )
    .get(tenant, id) as JsonObject | undefined;
}
/** A schedule's move to Reporting overview (JSON text in `m`), or undefined. */
export function scheduleMigration(store: Store, tenant: string, id: string): JsonObject | undefined {
  return store
    .sql()
    .prepare(
      "SELECT json_extract(data,'$.overview_migration') AS m FROM documents WHERE tenant_id=? AND kind='reporting_schedule' AND id=?",
    )
    .get(tenant, id) as JsonObject | undefined;
}
/** One workbook schedule as a feed row, or undefined. */
export function workbookScheduleRow(store: Store, tenant: string, id: string): JsonObject | undefined {
  return store
    .sql()
    .prepare(workbookScheduleFeedSQL + ' AND d.id=?')
    .get(tenant, id) as JsonObject | undefined;
}

// Report runs (from src/report-runs.ts and src/withheld-workbook-records.ts).
/** One report run as a feed row, or undefined. */
export function reportRunRow(store: Store, tenant: string, id: string): JsonObject | undefined {
  return store
    .sql()
    .prepare(reportRunFeedSQL + ' AND j.id=?')
    .get(tenant, id) as JsonObject | undefined;
}
/** The metadata of up to `limit` of a workspace's report runs or workbook schedules, as feed rows. */
export function workbookFeedRows(
  store: Store,
  tenant: string,
  records: 'runs' | 'schedules',
  limit: number,
): {metadata: string}[] {
  return store
    .sql()
    .prepare((records === 'runs' ? reportRunFeedSQL : workbookScheduleFeedSQL) + ' LIMIT ' + limit)
    .all(tenant) as {metadata: string}[];
}
