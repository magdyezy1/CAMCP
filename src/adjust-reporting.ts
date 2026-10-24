import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {Actor, CompiledRequest, Connection, JsonObject} from './types.js';
import type {Store} from './store.js';
import type {NativeTransport, TransportResult} from './transport.js';
import type {CredentialProvider} from './auth.js';
import {loginStamp, storedLogin} from './connection-authority.js';

const gateway = 'adjust_native_action',
  actions = ['LIST_APPS', 'LIST_FILTERS', 'LIST_EVENTS', 'GET_REPORT', 'GET_PIVOT'];
export const adjustReportingKind = (operation: string, action: unknown) =>
  (operation === 'adjust_list_assets' && (action === undefined || action === 'adjust_list_assets')) ||
  (operation === 'adjust_reporting' && actions.includes(String(action)));
const filters = new Set([
  'ad_revenue_sources',
  'ad_spend_mode',
  'apps',
  'apps_network',
  'attributes',
  'attribution_types',
  'attribution_source',
  'attribution_status',
  'channels',
  'cohort_maturity',
  'countries',
  'currencies',
  'dimensions',
  'full_cohort_periods',
  'iap_revenue_mode',
  'monetization_partners',
  'networks',
  'os_names',
  'partners',
  'platform',
  'period_over_period',
  'sdk_signature_version',
  'skad_time_adjustment',
  'store_type',
  'subscription_revenue_mode',
  'utc_offset',
]);
function invalid(message: string): never {
  throw new MirrorError('INVALID_ARGUMENT', message);
}
function object(v: unknown): JsonObject {
  if (!v || typeof v !== 'object' || Array.isArray(v)) invalid('Use an object for the Adjust payload/request.');
  return v as JsonObject;
}
function keys(o: JsonObject, allowed: string[]) {
  if (Object.keys(o).some(k => !allowed.includes(k)))
    invalid('This Adjust action accepts only: ' + allowed.join(', ') + '.');
}
function list(v: unknown, limit: number, pattern: RegExp): string[] {
  const a = typeof v === 'string' ? v.split(',') : v;
  if (
    !Array.isArray(a) ||
    !a.length ||
    a.length > limit ||
    a.some(x => typeof x !== 'string' || !pattern.test(x)) ||
    new Set(a).size !== a.length
  )
    invalid('Use a bounded, nonempty list of distinct native identifiers.');
  return [...a];
}
const field = /^[a-z][a-z0-9_]{0,127}$/,
  appId = /^[a-z0-9]{1,128}$/;
function period(v: unknown): {value: string; absolute?: [string, string]} {
  if (typeof v !== 'string') invalid('date_period is required. Use native absolute or documented logical dates.');
  if (/^(?:today|yesterday|this_week|last_week|this_month|last_month|this_month_until_yesterday)$/.test(v))
    return {value: v};
  if (/^-\d{1,4}d:-\d{1,4}d$/.test(v)) {
    const [a, b] = v.split(':').map(x => Number(x.slice(0, -1)));
    if (a! > b! || a! < -3660) invalid('Relative dates must be ordered and within 3660 days.');
    return {value: v};
  }
  const m = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(v);
  if (!m) invalid('Use YYYY-MM-DD:YYYY-MM-DD or a documented native logical period.');
  const a = m![1]!,
    b = m![2]!;
  for (const d of [a, b])
    if (!Number.isFinite(Date.parse(d + 'T00:00:00Z')) || new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) !== d)
      invalid('The report contains an invalid calendar date.');
  if (a > b || Date.parse(b) - Date.parse(a) > 3660 * 86400000)
    invalid('Report dates must be ordered and span at most 3660 days.');
  return {value: v, absolute: [a, b]};
}
function scopedApps(c: Connection, v: unknown): string[] {
  const apps =
    v === undefined
      ? c.accounts.length === 1
        ? [c.accounts[0]!]
        : invalid('Specify app_token__in or appTokens when the connection has multiple selected apps.')
      : list(v, 50, appId);
  if (apps.some(id => !appId.test(id) || !c.accounts.includes(id)))
    throw new MirrorError(
      'ACCOUNT_SCOPE_MISMATCH',
      'Every requested Adjust app must be selected on this connection.',
      {},
      403,
    );
  return apps;
}
function providerObject(v: unknown): JsonObject {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new MirrorError('ADJUST_RESPONSE_INVALID', 'Adjust returned an unexpected object.', {}, 502);
  const o = v as JsonObject;
  if (o.error !== undefined || (o.errors !== undefined && (!Array.isArray(o.errors) || o.errors.length)))
    throw new MirrorError('ADJUST_RESPONSE_INVALID', 'Adjust returned a provider error envelope.', {}, 502);
  return o;
}
function bounded(value: unknown, depth = 0, counter = {n: 0}) {
  if (++counter.n > 200000 || depth > 12)
    throw new MirrorError('ADJUST_REPORT_LIMIT', 'The native response exceeds its structural bound.', {}, 502);
  if (typeof value === 'string' && value.length > 65536)
    throw new MirrorError('ADJUST_REPORT_LIMIT', 'A native field exceeds 64 KiB.', {}, 502);
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new MirrorError('ADJUST_RESPONSE_INVALID', 'Adjust returned a non-finite value.', {}, 502);
  if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(k))
        throw new MirrorError('ADJUST_RESPONSE_INVALID', 'Adjust returned an unsafe object key.', {}, 502);
      bounded(v, depth + 1, counter);
    }
}

/**
 * One Adjust reporting read, in stages (ARC-04: the function was one block of 465 lines; each stage below is that block's
 * code unchanged, in the same order): the stored app selections (adjust_list_assets), or the exact connection, the
 * native request of the action, the guarded read and the validation of its response, then the metadata and the audit.
 */
export async function adjustReporting(
  store: Store,
  transport: NativeTransport,
  credentials: CredentialProvider,
  operation: string,
  input: JsonObject,
  actor: Actor,
  requestId: string,
) {
  store.assertActorActive(actor);
  if (operation === 'adjust_list_assets') return adjustListAssets(store, input, actor);
  keys(input, ['action', 'label', 'payload']);
  const action = String(input.action);
  if (!actions.includes(action)) invalid('Choose a supported Adjust reporting action.');
  const connection = adjustConnection(store, input, actor),
    payload = input.payload === undefined ? {} : object(input.payload),
    request = adjustRequest(action, payload, connection, actor),
    {response, current} = await adjustRead(store, transport, credentials, actor, connection, request),
    {data, rows, complete, nullMetricValues, missingTotalMetrics} = adjustResponse(action, payload, request, response);
  current();
  const {query, apps, date} = request,
    metadata = {
      connection_id: connection.id,
      action,
      app_tokens: apps,
      complete,
      rows,
      provider_no_content: response.status === 204,
      provider_count_verified: false,
      numeric_encoding:
        'Native JSON numbers preserved as exact decimal strings; strings, null and booleans are retained.',
      requested_currency: query.currency ?? null,
      utc_offset: query.utc_offset ?? '+00:00',
      date_period: date?.value ?? null,
      period_is_dynamic: date !== undefined && !date.absolute,
      retrieved_at: new Date().toISOString(),
      output_contract_version: 1,
      source_bytes: response.bodyIntegrity?.bytes ?? null,
      request: query,
      meaning:
        'Native Adjust definitions and attribution apply. Totals and ratios are not recomputed; warnings prevent a completeness claim. No provider count/checksum or cross-platform reconciliation is inferred.',
    };
  store.appendAudit(actor.tenantId, requestId, {
    event: 'adjust_read_completed',
    connection_id: connection.id,
    action,
    rows,
    complete,
    provider_changes: 0,
    raw_data_omitted: true,
  });
  return {data, ...metadata, null_metric_values: nullMetricValues, missing_total_metrics: missingTotalMetrics};
}

/** adjust_list_assets: the stored AMCP app selections only; no provider read. */
function adjustListAssets(store: Store, input: JsonObject, actor: Actor) {
  keys(input, ['include_disconnected']);
  if (input.include_disconnected !== undefined && typeof input.include_disconnected !== 'boolean')
    invalid('include_disconnected must be a boolean.');
  const connections = store
    .connectionsFor(actor)
    .filter(c => c.gateway === gateway && (input.include_disconnected === true || c.enabled))
    .map(c => ({
      connection_id: c.id,
      label: c.id,
      display_label: c.label,
      enabled: c.enabled,
      app_tokens: c.accounts,
      source: 'configured_binding',
      provider_visibility: 'not_checked',
    }));
  return {
    connections,
    live_verified: false,
    network_requests: 0,
    meaning:
      'Stored AMCP app selections only. LIST_APPS checks provider visibility; this list never reads tokens or grants account access.',
  };
}

/** The one Adjust connection the call names, by its exact ID or a unique label. */
function adjustConnection(store: Store, input: JsonObject, actor: Actor): Connection {
  const configured = store.connectionsFor(actor).filter(c => c.gateway === gateway),
    exact = configured.find(c => c.id === input.label),
    matches = exact ? [exact] : configured.filter(c => c.label === input.label);
  if (matches.length !== 1)
    throw new MirrorError(
      matches.length ? 'AMBIGUOUS_CONNECTION' : 'CONNECTION_REQUIRED',
      'Select the exact Adjust connection ID from adjust_list_assets.',
      {},
      409,
    );
  return matches[0]!;
}

/** The native request of one action: its path and query, and what its response is checked against. */
interface AdjustRequest {
  path: string;
  query: JsonObject;
  apps: string[];
  date: ReturnType<typeof period> | undefined;
  dims: string[];
  metrics: string[];
  required: string[];
}
function adjustRequest(action: string, payload: JsonObject, connection: Connection, actor: Actor): AdjustRequest {
  const request: AdjustRequest = {
    path: '/reports-service/',
    query: {},
    apps: [],
    date: undefined,
    dims: [],
    metrics: [],
    required: [],
  };
  if (action === 'LIST_FILTERS' || action === 'LIST_APPS') adjustFilterRequest(action, payload, actor, request);
  else if (action === 'LIST_EVENTS') adjustEventsRequest(payload, connection, request);
  else adjustReportRequest(action, payload, connection, request);
  return request;
}
/** LIST_FILTERS and LIST_APPS: account-wide filter discovery, for administrators only. */
function adjustFilterRequest(action: string, payload: JsonObject, actor: Actor, request: AdjustRequest) {
  const {query} = request;
  if (actor.role !== 'admin')
    throw new MirrorError('FORBIDDEN', 'Only an administrator may discover account-wide Adjust filters/apps.', {}, 403);
  keys(payload, action === 'LIST_APPS' ? ['search'] : ['requiredFilters', 'section', 'search']);
  const required = (request.required = action === 'LIST_APPS' ? ['apps'] : list(payload.requiredFilters, 10, field));
  if (required.some(k => !filters.has(k)))
    invalid(
      'Use a filter named in Adjust’s current Filters Data contract. Metrics are discovered through the glossary/events endpoint.',
    );
  query.required_filters = required.join(',');
  if (payload.search !== undefined) {
    if (typeof payload.search !== 'string' || !payload.search || payload.search.length > 200 || required.length !== 1)
      invalid('search requires one filter and 1–200 characters.');
    query[required[0] + '__contains'] = payload.search;
  }
  if (
    payload.section !== undefined &&
    (typeof payload.section !== 'string' || !payload.section || payload.section.length > 100)
  )
    invalid('section must be a short exact native section name.');
  request.path += 'filters_data';
}
/** LIST_EVENTS: the event catalog of the selected apps. */
function adjustEventsRequest(payload: JsonObject, connection: Connection, request: AdjustRequest) {
  const {query} = request;
  keys(payload, ['appTokens', 'search', 'tokens_mapping']);
  const apps = (request.apps = scopedApps(connection, payload.appTokens));
  query.app_token__in = apps.join(',');
  if (payload.search !== undefined) {
    if (typeof payload.search !== 'string' || !payload.search || payload.search.length > 200)
      invalid('search must be 1–200 characters.');
    query.events__contains = payload.search;
  }
  if (payload.tokens_mapping !== undefined && typeof payload.tokens_mapping !== 'boolean')
    invalid('tokens_mapping must be boolean.');
  query.tokens_mapping = payload.tokens_mapping === true;
  request.path += 'events';
}
/** GET_REPORT and GET_PIVOT: one bounded native report of the selected apps, with every native parameter checked. */
function adjustReportRequest(action: string, payload: JsonObject, connection: Connection, request: AdjustRequest) {
  const {query} = request;
  let dims: string[], metrics: string[];
  keys(payload, ['request']);
  const r = object(payload.request);
  dims = list(r.dimensions, 10, field);
  metrics = request.metrics = list(r.metrics, 100, field);
  if (dims.some(d => metrics.includes(d))) invalid('A field cannot be both a metric and a dimension.');
  if (!dims.includes('app_token')) dims = ['app_token', ...dims];
  request.dims = dims;
  const apps = (request.apps = scopedApps(connection, r.app_token__in));
  const date = (request.date = period(r.date_period));
  const globals = [
    'dimensions',
    'metrics',
    'date_period',
    'app_token__in',
    'utc_offset',
    'attribution_types',
    'attribution_source',
    'reattributed',
    'iap_revenue_mode',
    'ad_revenue_sources',
    'os_names',
    'ad_spend_mode',
    'sandbox',
    'sort',
    'index',
    'format_dates',
    'period_over_period',
    'currency',
    'cohort_maturity',
  ];
  for (const [k, v] of Object.entries(r)) {
    if (globals.includes(k)) continue;
    const m =
        /^([a-z][a-z0-9_]{0,127})__(in|not_in|contains|exclude|starts_with|not_starts_with|ends_with|not_ends_with|lt|lte|gt|gte|eq|ne)$/.exec(
          k,
        ),
      numeric = m && ['lt', 'lte', 'gt', 'gte', 'eq', 'ne'].includes(m[2]!);
    if (!m || m[1] === 'app_token' || !(numeric ? metrics : dims).includes(m[1]!))
      invalid('Unsupported Adjust request field: ' + k);
    if (
      typeof v !== 'string' ||
      !v ||
      v.length > 2000 ||
      (numeric && !/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v))
    )
      invalid('Use bounded native dimension text or decimal metric filters.');
    query[k] = v;
  }
  for (const k of globals.filter(k => !['dimensions', 'metrics', 'date_period', 'app_token__in', 'index'].includes(k)))
    if (r[k] !== undefined) {
      const v = r[k],
        boolean = ['sandbox', 'format_dates'].includes(k);
      if (boolean ? typeof v !== 'boolean' : typeof v !== 'string' || !v || v.length > 2000)
        invalid('Invalid native report parameter: ' + k);
      query[k] = v;
    }
  const enums: Record<string, string[]> = {
    cohort_maturity: ['immature', 'mature'],
    attribution_source: ['first', 'dynamic'],
    reattributed: ['all', 'false', 'true'],
    iap_revenue_mode: ['GROSS_100', 'GROSS_85', 'GROSS_70', 'GROSS_60'],
    ad_spend_mode: ['adjust', 'network', 'mixed'],
  };
  for (const [k, values] of Object.entries(enums))
    if (r[k] !== undefined && !values.includes(r[k])) invalid('Unsupported native ' + k + '.');
  if (
    r.attribution_types !== undefined &&
    list(r.attribution_types, 3, field).some(x => !['click', 'impression', 'engaged_ad'].includes(x))
  )
    invalid('Unsupported attribution_types.');
  if (
    r.sort !== undefined &&
    list(r.sort, 110, /^-?[a-z][a-z0-9_]{0,127}$/).some(x => ![...dims, ...metrics].includes(x.replace(/^-/, '')))
  )
    invalid('Sort only by requested dimensions or metrics.');
  if (r.currency !== undefined && !/^[A-Z]{3}$/.test(r.currency))
    invalid('currency must be a native ISO currency code.');
  if (
    r.utc_offset !== undefined &&
    (!/^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(r.utc_offset) ||
      (r.utc_offset.slice(1, 3) === '14' && r.utc_offset.slice(-2) !== '00'))
  )
    invalid('utc_offset must be a fixed native offset between -14:00 and +14:00.');
  for (const k of ['sandbox', 'format_dates'])
    if (r[k] !== undefined && typeof r[k] !== 'boolean') invalid(k + ' must be boolean.');
  if (r.format_dates === true) invalid('Use format_dates false for unambiguous native ISO date dimensions.');
  query.dimensions = dims.join(',');
  query.metrics = metrics.join(',');
  query.date_period = date.value;
  query.app_token__in = apps.join(',');
  query.format_dates = false;
  query.utc_offset = r.utc_offset ?? '+00:00';
  if (action === 'GET_PIVOT') {
    if (r.index !== undefined && stable(list(r.index, 1, field)) !== stable(['app_token']))
      invalid('The qualified pivot index is app_token. Other nesting requires a separate output contract.');
    query.index = 'app_token';
    request.path += 'pivot_report';
  } else {
    if (r.index !== undefined) invalid('Use GET_PIVOT for indexed reports.');
    request.path += 'report';
  }
}

/**
 * The guarded read: the connection and its apps are checked, the login is pinned, and every attempt re-checks them,
 * the deadline and the shared source-IP permit. Returns the response and the check run again after it.
 */
async function adjustRead(
  store: Store,
  transport: NativeTransport,
  credentials: CredentialProvider,
  actor: Actor,
  connection: Connection,
  {path, query, apps}: AdjustRequest,
): Promise<{response: TransportResult; current: () => Connection}> {
  const access = () => {
    store.assertActorActive(actor);
    const c = store.connectionsFor(actor).find(c => c.gateway === gateway && c.id === connection.id);
    if (!c || !c.enabled)
      throw new MirrorError('CONNECTION_REQUIRED', 'The selected Adjust connection is disabled or removed.', {}, 403);
    if (apps.some(a => !c.accounts.includes(a)))
      throw new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'An Adjust app grant changed during this read.', {}, 403);
    return c;
  };
  access();
  const token = await credentials.get(connection),
    fingerprint = loginStamp(token),
    start = performance.now(),
    deadline = start + 60000;
  const current = () => {
    const c = access();
    if (storedLogin(store, c) !== fingerprint)
      throw new MirrorError('CONNECTION_CHANGED', 'The selected Adjust token changed during reporting.', {}, 409);
    if (performance.now() >= deadline)
      throw new MirrorError('ADJUST_REPORT_LIMIT', 'Adjust reporting exceeded its time limit.', {}, 502);
    return c;
  };
  const c = current(),
    plan: CompiledRequest = {
      gateway,
      action: 'AMCP_ADJUST_REPORT_READ',
      origin: 'https://automate.adjust.com',
      path,
      query,
      method: 'GET',
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      evidence: 'INDEPENDENT_ADJUST_REPORTS_SERVICE',
      warnings: [],
      adjustReportDeadline: deadline,
      adjustReportRead: true,
    };
  // Provider limits are per source IP: coordinate all workspaces sharing this store,
  // including retries, without assuming other applications behind the NAT cooperate.
  let response;
  try {
    response = await transport.request(plan, c, token, undefined, {
      beforeAttempt: () => {
        current();
        store.providerPermit('adjust-report-source-ip');
      },
    });
  } catch (e) {
    if (e instanceof MirrorError) {
      if (e.details.http_status === 429 && typeof e.details.retry_after_ms === 'number')
        store.providerCooldown('adjust-report-source-ip', e.details.retry_after_ms);
      throw new MirrorError(
        e.code,
        e.message,
        Object.fromEntries(
          Object.entries(e.details).filter(([k]) => ['http_status', 'request_id', 'retry_after_ms'].includes(k)),
        ),
        e.status,
        e.retryable,
      );
    }
    throw e;
  }
  current();
  return {response, current};
}

/** What a validated response holds: the native data, its row count and whether the provider claims completeness. */
interface AdjustData {
  data: unknown;
  rows: number;
  complete: boolean;
  nullMetricValues: number;
  missingTotalMetrics: string[];
}
/** The response, bounded and validated for its action. */
function adjustResponse(
  action: string,
  payload: JsonObject,
  request: AdjustRequest,
  response: TransportResult,
): AdjustData {
  const raw = response.data;
  bounded(raw);
  if (action === 'LIST_APPS' || action === 'LIST_FILTERS') return adjustFilterData(payload, request, response, raw);
  if (action === 'LIST_EVENTS') return adjustEventsData(request, response, raw);
  return adjustReportData(action, request, response, raw);
}
/** LIST_APPS and LIST_FILTERS: every requested filter collection, with unique identifiers. */
function adjustFilterData(
  payload: JsonObject,
  {required}: AdjustRequest,
  response: TransportResult,
  raw: unknown,
): AdjustData {
  let rows = 0;
  const source = response.status === 204 ? Object.fromEntries(required.map(k => [k, []])) : providerObject(raw),
    out: JsonObject = {};
  for (const k of required) {
    const items = source[k];
    if (!Array.isArray(items) || items.length > 25000)
      throw new MirrorError(
        'ADJUST_RESPONSE_INVALID',
        'Adjust omitted or exceeded the requested filter collection.',
        {},
        502,
      );
    const seen = new Set<string>();
    for (const item of items) {
      const row = providerObject(item);
      if (typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || seen.has(row.id))
        throw new MirrorError(
          'ADJUST_RESPONSE_INVALID',
          'Adjust returned an invalid or duplicate filter identifier.',
          {},
          502,
        );
      seen.add(row.id);
    }
    out[k] = payload.section === undefined ? items : items.filter(row => row.section === payload.section);
    rows += out[k].length;
  }
  return {data: out, rows, complete: true, nullMetricValues: 0, missingTotalMetrics: []};
}
/** LIST_EVENTS: an event catalog whose every event names only selected apps. */
function adjustEventsData({apps}: AdjustRequest, response: TransportResult, raw: unknown): AdjustData {
  const items = response.status === 204 ? [] : raw;
  if (!Array.isArray(items) || items.length > 25000)
    throw new MirrorError('ADJUST_RESPONSE_INVALID', 'Adjust returned an invalid event catalog.', {}, 502);
  const seen = new Set<string>();
  for (const value of items) {
    const row = providerObject(value);
    if (
      typeof row.id !== 'string' ||
      !row.id ||
      seen.has(row.id) ||
      !Array.isArray(row.app_token) ||
      !row.app_token.length ||
      row.app_token.some((a: unknown) => typeof a !== 'string' || !apps.includes(a))
    )
      throw new MirrorError(
        'ACCOUNT_SCOPE_MISMATCH',
        'Adjust event metadata did not confirm the selected apps.',
        {},
        502,
      );
    seen.add(row.id);
    if (
      row.app_token_x_event_tokens_mapping &&
      Object.keys(object(row.app_token_x_event_tokens_mapping)).some(a => !apps.includes(a))
    )
      throw new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'Adjust event mapping contains another app.', {}, 502);
  }
  return {data: items, rows: items.length, complete: true, nullMetricValues: 0, missingTotalMetrics: []};
}
/**
 * GET_REPORT and GET_PIVOT: every row of a selected app, with every requested field, unique grain and days inside the
 * period; native metric values are never converted, and warnings or missing totals withhold the completeness claim.
 */
function adjustReportData(
  action: string,
  {apps, date, dims, metrics}: AdjustRequest,
  response: TransportResult,
  raw: unknown,
): AdjustData {
  let rows = 0,
    nullMetricValues = 0;
  const source =
    response.status === 204
      ? {rows: [], totals: {}, warnings: [], ...(action === 'GET_PIVOT' ? {totals_per_dimension: {}} : {})}
      : providerObject(raw);
  if (
    !Array.isArray(source.rows) ||
    !Array.isArray(source.warnings) ||
    !source.totals ||
    typeof source.totals !== 'object' ||
    Array.isArray(source.totals) ||
    source.pagination != null
  )
    throw new MirrorError(
      'ADJUST_RESPONSE_INVALID',
      'Adjust returned an incomplete or unrecognized report envelope.',
      {},
      502,
    );
  if (
    action === 'GET_PIVOT' &&
    (!source.totals_per_dimension ||
      typeof source.totals_per_dimension !== 'object' ||
      Array.isArray(source.totals_per_dimension))
  )
    throw new MirrorError('ADJUST_RESPONSE_INVALID', 'Adjust omitted pivot totals metadata.', {}, 502);
  if (
    source.totals_per_dimension?.app_token &&
    Object.keys(providerObject(source.totals_per_dimension.app_token)).some(a => !apps.includes(a))
  )
    throw new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'Adjust pivot totals contain an unselected app.', {}, 502);
  const metricValue = (value: unknown) => {
    if (value === null) return;
    if (typeof value !== 'string' || !/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))
      throw new MirrorError(
        'ADJUST_RESPONSE_INVALID',
        'Adjust returned an unrecognized metric value; it was not converted to zero.',
        {},
        502,
      );
  };
  const seen = new Set<string>(),
    leaf = (v: unknown, boundApp?: string) => {
      const row = providerObject(v),
        a = row.app_token ?? boundApp;
      if (typeof a !== 'string' || !apps.includes(a) || (boundApp !== undefined && a !== boundApp))
        throw new MirrorError(
          'ACCOUNT_SCOPE_MISMATCH',
          'Adjust report row belongs to an unselected or unknown app.',
          {},
          502,
        );
      if (++rows > 25000)
        throw new MirrorError('ADJUST_REPORT_LIMIT', 'Adjust returned more than 25000 rows.', {}, 502);
      if (dims.some(d => d !== 'app_token' && !Object.hasOwn(row, d)) || metrics.some(m => !Object.hasOwn(row, m)))
        throw new MirrorError('ADJUST_RESPONSE_INVALID', 'Adjust omitted a requested report field.', {}, 502);
      if (dims.some(d => d !== 'app_token' && row[d] !== null && typeof row[d] !== 'string'))
        throw new MirrorError('ADJUST_RESPONSE_INVALID', 'Adjust returned a non-scalar dimension.', {}, 502);
      for (const m of metrics) {
        metricValue(row[m]);
        if (row[m] === null) nullMetricValues++;
      }
      const identity = stable(dims.map(d => (d === 'app_token' ? a : row[d])));
      if (seen.has(identity))
        throw new MirrorError('ADJUST_RESPONSE_INVALID', 'Adjust repeated a report grain.', {}, 502);
      seen.add(identity);
      if (
        date?.absolute &&
        dims.includes('day') &&
        (typeof row.day !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(row.day) ||
          !Number.isFinite(Date.parse(row.day + 'T00:00:00Z')) ||
          new Date(row.day + 'T00:00:00Z').toISOString().slice(0, 10) !== row.day ||
          row.day < date.absolute[0] ||
          row.day > date.absolute[1])
      )
        throw new MirrorError(
          'ADJUST_RESPONSE_INVALID',
          'Adjust returned a day outside the requested period.',
          {},
          502,
        );
    };
  for (const value of source.rows) {
    const row = providerObject(value);
    if (Object.hasOwn(row, 'app_token')) leaf(row);
    else if (action === 'GET_PIVOT') {
      const entries = Object.entries(row);
      if (!entries.length)
        throw new MirrorError('ADJUST_RESPONSE_INVALID', 'Adjust returned an empty pivot group.', {}, 502);
      for (const [a, group] of entries) {
        if (!apps.includes(a) || !Array.isArray(group?.rows) || Object.keys(group).some(k => k !== 'rows'))
          throw new MirrorError('ADJUST_RESPONSE_INVALID', 'Adjust returned an unsupported pivot nesting.', {}, 502);
        for (const item of group.rows) leaf(item, a);
      }
    } else leaf(row);
  }
  const missingTotalMetrics = rows ? metrics.filter(m => !Object.hasOwn(source.totals, m)) : [];
  for (const m of metrics) if (Object.hasOwn(source.totals, m)) metricValue(source.totals[m]);
  return {
    data: source,
    rows,
    complete: source.warnings.length === 0 && missingTotalMetrics.length === 0,
    nullMetricValues,
    missingTotalMetrics,
  };
}
