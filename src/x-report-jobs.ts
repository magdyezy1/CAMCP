import {assertNoMethodOverride} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {familyErrors, type ReasonFirstRefusal} from './family-kit.js';
import {sha256, scopeKey, stable} from './security.js';
import {xRead, xReader} from './x-creative-writes.js';
import type {Store} from './store.js';
import type {CompiledRequest, Connection, Credentials, JsonObject, ToolDefinition} from './types.js';
import type {TransportResult} from './transport.js';

const gateway = 'x_ads_native_action',
  origin = 'https://ads-api.x.com';
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const native = /^[a-z0-9]{1,32}$/,
  snowflake = /^[1-9][0-9]{0,24}$/;
const entities: Record<string, string> = {
  ACCOUNT: '',
  FUNDING_INSTRUMENT: 'funding_instruments',
  CAMPAIGN: 'campaigns',
  LINE_ITEM: 'line_items',
  PROMOTED_TWEET: 'promoted_tweets',
  MEDIA_CREATIVE: 'media_creatives',
};
const groups = [
  'ENGAGEMENT',
  'BILLING',
  'VIDEO',
  'WEB_CONVERSION',
  'MOBILE_CONVERSION',
  'LIFE_TIME_VALUE_MOBILE_CONVERSION',
];
const fields = [
  'entity',
  'entity_ids',
  'start_time',
  'end_time',
  'granularity',
  'placement',
  'metric_groups',
  'segmentation_type',
  'country',
  'platform',
];
const statuses = ['PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED'];
type Send = (p: CompiledRequest) => Promise<TransportResult>;
const fail: ReasonFirstRefusal = familyErrors('X_REPORT_INVALID', {
  RESOURCE_SCOPE_REQUIRED: 403,
  X_REPORT_LOGIN_CHANGED: 403,
  X_REPORT_STATE_UNVERIFIED: 502,
});
function stateFail(message: string): never {
  return fail(message, 'X_REPORT_STATE_UNVERIFIED');
}
function only(v: JsonObject, keys: string[]) {
  if (Object.keys(v).some(k => !keys.includes(k)))
    fail('Unqualified X report field. Inspect the exact asynchronous report contract.');
}
const ids = (v: unknown, pattern: RegExp, max: number) =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.split(',').length <= max &&
  new Set(v.split(',')).size === v.split(',').length &&
  v.split(',').every(x => pattern.test(x));
function instant(v: unknown): number {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00(?:\.000)?Z$/.test(v))
    fail('Use explicit UTC ISO 8601 timestamps aligned to whole hours; the end time is exclusive.');
  const n = Date.parse(v as string);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== (v as string).replace(/(?:\.000)?Z$/, '.000Z'))
    fail('Use real calendar dates and whole-hour timestamps.');
  return n;
}
/**
 * An X analytics time: ISO 8601 "expressed in whole hours (0 minutes and 0 seconds)", as X's reference shows it
 * (2026-05-19T07:00:00Z). X refuses fractional seconds (INVALID_PARAMETER "Expected Time").
 */
export function xAnalyticsTime(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms % 3600000 !== 0)
    throw new MirrorError('INVALID_REPORT_RANGE', 'X analytics times are expressed in whole hours.');
  return new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
}
export function xReportRoute(p: CompiledRequest): 'create' | 'status' | undefined {
  if (
    p.gateway !== gateway ||
    (p.origin && p.origin !== origin) ||
    p.specialTransport ||
    !/^\/12\/stats\/jobs\/accounts\/[a-z0-9]{1,32}$/.test(p.path)
  )
    return;
  if (p.method === 'POST' && p.action === 'x_stats_jobs_accounts_account_id_post') return 'create';
  if (p.method === 'GET' && ['x_stats_jobs_accounts_account_id_get', 'AMCP_X_REPORT_READ'].includes(p.action))
    return 'status';
}
export const xReportKind = (p: CompiledRequest) => (xReportRoute(p) === 'create' ? 'create' : undefined);
/** Explicit AMCP result retrieval control. It never becomes an X query parameter. */
export function extendXReportTool(tool: ToolDefinition): ToolDefinition {
  const schema = structuredClone(tool.inputSchema);
  schema.properties.download_report = {
    type: 'boolean',
    description:
      'On the exact asynchronous job GET, download and validate the gzip result on the server. Select one original AMCP job_id; offset/limit page the validated result. No URL or advertising credential is relayed to the client.',
  };
  return {
    ...tool,
    inputSchema: schema,
    description:
      tool.description +
      ' Asynchronous analytics creation uses amcp_write; poll the original job with x_stats_jobs_accounts_account_id_get. download_report=true returns bounded validated native metrics.',
  };
}
export function xReportPlan(p: CompiledRequest, input: JsonObject): CompiledRequest {
  if (p.gateway !== gateway) return p;
  if (
    input.download_report !== undefined &&
    (typeof input.download_report !== 'boolean' || xReportRoute(p) !== 'status')
  )
    fail('download_report applies only to x_stats_jobs_accounts_account_id_get.');
  if (xReportKind(p)) {
    if (p.body !== undefined && !object(p.body)) fail('Use one native report parameter object.');
    const b = (p.body ?? {}) as JsonObject;
    for (const [k, v] of Object.entries(b))
      if (p.query[k] !== undefined && stable(p.query[k]) !== stable(v))
        fail('Conflicting report body and query values.');
    p = {...p, query: {...b, ...p.query}, body: undefined};
    // A whole-hour time written with .000Z is sent in the documented form, which X accepts.
    for (const key of ['start_time', 'end_time'])
      if (typeof p.query[key] === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(p.query[key]))
        p = {...p, query: {...p.query, [key]: p.query[key].replace(/\.000Z$/, 'Z')}};
  }
  if (input.download_report === true) {
    if (['result_fields', 'fields', 'max_items', 'compact'].some(k => input[k] !== undefined))
      fail(
        'Use offset/limit for report pages and select metric_groups at creation. Field projection or compaction can destroy native time-series/null semantics.',
      );
    const offset = input.offset ?? 0,
      limit = input.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      fail('Report pages require offset >= 0 and limit 1–100.');
    p = {...p, reportDownload: {offset, limit}};
  }
  return p;
}
export function assertXReport(p: CompiledRequest) {
  if (!xReportKind(p)) return;
  if (
    !native.test(p.accountId ?? '') ||
    p.path.split('/').at(-1) !== p.accountId ||
    Object.keys(p.headers).length ||
    p.body !== undefined
  )
    fail('Select one account, the fixed Ads API route and native query parameters without header/body overrides.');
  const a = p.query;
  only(a, fields);
  if (
    !Object.hasOwn(entities, a.entity) ||
    !ids(a.entity_ids, native, 20) ||
    (a.entity === 'ACCOUNT' && a.entity_ids !== p.accountId)
  )
    fail('Select one documented entity type and up to 20 distinct native IDs from this account.');
  if (!ids(a.metric_groups, /^[A-Z_]+$/, 6) || a.metric_groups.split(',').some((g: string) => !groups.includes(g)))
    fail('Select documented native metric groups.');
  const selected = a.metric_groups.split(',');
  if (
    (a.entity === 'ACCOUNT' && a.metric_groups !== 'ENGAGEMENT') ||
    (a.entity === 'FUNDING_INSTRUMENT' && selected.some((g: string) => !['ENGAGEMENT', 'BILLING'].includes(g)))
  )
    fail('The selected entity does not support these metric groups.');
  if (
    (selected.includes('MOBILE_CONVERSION') && selected.length !== 1) ||
    (selected.includes('LIFE_TIME_VALUE_MOBILE_CONVERSION') && selected.length !== 1)
  )
    fail('Submit mobile and lifetime conversion groups separately from other metric groups.');
  if (
    !['TOTAL', 'DAY', 'HOUR'].includes(a.granularity) ||
    !['ALL_ON_TWITTER', 'SPOTLIGHT', 'TREND'].includes(a.placement)
  )
    fail('Select TOTAL, DAY or HOUR and one current native placement.');
  if (
    a.segmentation_type !== undefined &&
    !['AGE', 'GENDER', 'METROS', 'REGIONS', 'PLATFORMS', 'CONVERSION_TAGS'].includes(a.segmentation_type)
  )
    fail('Use a currently documented September 2026 segmentation type.');
  if (
    ['METROS', 'REGIONS'].includes(a.segmentation_type)
      ? typeof a.country !== 'string' || !/^[a-f0-9]{16}$/.test(a.country)
      : a.country !== undefined
  )
    fail(
      'METROS and REGIONS require the discovered native country location ID. Other segmentations do not use this country filter.',
    );
  if (a.platform !== undefined)
    fail('A platform filter needs a separately documented native value contract; use the PLATFORMS breakdown.');
  if (
    (a.segmentation_type && ['ACCOUNT', 'FUNDING_INSTRUMENT'].includes(a.entity)) ||
    (a.segmentation_type && selected.includes('LIFE_TIME_VALUE_MOBILE_CONVERSION')) ||
    (a.segmentation_type === 'CONVERSION_TAGS' && a.metric_groups !== 'WEB_CONVERSION') ||
    (selected.includes('WEB_CONVERSION') &&
      a.segmentation_type &&
      !['PLATFORMS', 'CONVERSION_TAGS'].includes(a.segmentation_type))
  )
    fail('The selected metric/entity and segmentation combination is unsupported.');
  const start = instant(a.start_time),
    end = instant(a.end_time);
  if (end <= start || end - start > (a.segmentation_type ? 45 : 90) * 86400000)
    fail('Use a positive interval up to 90 days, or 45 days with segmentation.');
}
const accountPlan = (p: CompiledRequest) => ({...p, path: '/12/accounts/' + p.accountId});
export function xReportSnapshots(p: CompiledRequest) {
  return [xRead(accountPlan(p), '')];
}
/** OAuth 1 has no refresh-token rotation. Bind the original app/user key material,
 * excluding harmless expiration metadata and connection display names. */
export const xReportIdentity = (auth: Credentials) =>
  sha256(
    stable(
      Object.fromEntries(
        ['consumerKey', 'consumerSecret', 'accessToken', 'tokenSecret'].map(k => [
          k,
          auth[k as keyof Credentials] ?? '',
        ]),
      ),
    ),
  );
function dayParts(at: number, zone: string) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(at))
      .map(p => [p.type, p.value]),
  );
}
export function xReportBuckets(a: JsonObject, zone: string) {
  const start = instant(a.start_time),
    end = instant(a.end_time);
  if (a.granularity === 'TOTAL') return 1;
  if (a.granularity === 'HOUR') return (end - start) / 3600000;
  const first = dayParts(start, zone),
    last = dayParts(end, zone);
  if ([first, last].some(d => d.hour !== '00' || d.minute !== '00' || d.second !== '00'))
    fail('DAY report boundaries must be midnight in the current account timezone, including DST.');
  return (
    (Date.parse(last.year + '-' + last.month + '-' + last.day) -
      Date.parse(first.year + '-' + first.month + '-' + first.day)) /
    86400000
  );
}
export async function readXReportState(p: CompiledRequest, send: Send, identity: () => string) {
  assertXReport(p);
  let bytes = 0,
    calls = 0;
  const deadline = performance.now() + 60000;
  const read = xReader(accountPlan(p), async q => {
    if (++calls > 48 || performance.now() >= deadline)
      stateFail('Report prerequisites exceeded their request/deadline bound.');
    const r = await send({...q, xReportDeadline: deadline});
    bytes += Buffer.byteLength(JSON.stringify(r.data));
    if (bytes > 8 * 1024 * 1024 || performance.now() >= deadline)
      stateFail('Report prerequisites exceeded their response/deadline bound.');
    return r;
  });
  const states: JsonObject[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const account = await read.single('', p.accountId!);
    if (
      account.id !== p.accountId ||
      account.deleted !== false ||
      typeof account.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(account.currency) ||
      typeof account.timezone !== 'string'
    )
      stateFail('The current account identity, currency or timezone is unverified.');
    try {
      new Intl.DateTimeFormat('en', {timeZone: account.timezone});
    } catch {
      stateFail('The account timezone is invalid.');
    }
    const found: string[] = [];
    for (const id of p.query.entity_ids.split(',')) {
      if (p.query.entity !== 'ACCOUNT') {
        const row = await read.single('/' + entities[p.query.entity] + '/' + id, id, 'id', true);
        if (row.account_id !== p.accountId) stateFail('The exact reporting entity is not bound to this account.');
      }
      found.push(id);
    }
    states.push({
      account_id: p.accountId,
      currency: account.currency,
      timezone: account.timezone,
      entity: p.query.entity,
      entity_ids: found.sort(),
      time_series_length: xReportBuckets(p.query, account.timezone),
      login_fingerprint: identity(),
    });
  }
  if (stable(states[0]) !== stable(states[1]))
    stateFail('Account/credential prerequisites changed during report preparation.');
  return [states[0]!];
}
function envelope(r: TransportResult): JsonObject {
  if (
    r.status !== 200 ||
    !object(r.data) ||
    Object.hasOwn(r.data, 'errors') ||
    Object.hasOwn(r.data, 'error') ||
    Object.keys(r.data).some(k => !['data', 'request', 'next_cursor', 'total_count'].includes(k))
  )
    stateFail('X returned a failed, partial or unrecognized job envelope.');
  return r.data;
}
function sameDefinition(row: JsonObject, a: JsonObject) {
  for (const key of ['entity', 'granularity', 'placement'])
    if (row[key] !== a[key]) stateFail('Job definition differs from the reviewed ' + key + '.');
  for (const key of ['start_time', 'end_time'])
    if (instant(row[key]) !== instant(a[key])) stateFail('Job interval differs from the reviewed definition.');
  for (const key of ['entity_ids', 'metric_groups'])
    if (
      !Array.isArray(row[key]) ||
      row[key].some((v: unknown) => typeof v !== 'string') ||
      new Set(row[key]).size !== row[key].length ||
      stable([...row[key]].sort()) !== stable(a[key].split(',').sort())
    )
      stateFail('Job ' + key + ' differs from the reviewed definition.');
  for (const key of ['segmentation_type', 'country', 'platform'])
    if ((row[key] ?? null) !== (a[key] ?? null)) stateFail('Job segmentation differs from the reviewed definition.');
}
function job(row: unknown, a: JsonObject, account: string, expected?: string): JsonObject {
  if (
    !object(row) ||
    typeof row.id_str !== 'string' ||
    !snowflake.test(row.id_str) ||
    (expected && row.id_str !== expected) ||
    row.account_id !== account ||
    !statuses.includes(row.status)
  )
    stateFail('The job ID, account or native status is missing, foreign or unrecognized.');
  if (
    row.error !== undefined ||
    row.errors !== undefined ||
    row.partial_failure !== undefined ||
    row.partial === true ||
    row.truncated === true ||
    row.success === false
  )
    stateFail('Native job metadata indicates an error or incomplete result.');
  if (
    row.id !== undefined &&
    (typeof row.id === 'string'
      ? row.id !== row.id_str
      : typeof row.id !== 'number' || !Number.isFinite(row.id) || Number(row.id_str) !== row.id)
  )
    stateFail('Native job ID representations disagree. Always use id_str to preserve large IDs.');
  sameDefinition(row, a);
  if (
    row.status === 'SUCCESS' &&
    (typeof row.url !== 'string' ||
      !row.url ||
      typeof row.expires_at !== 'string' ||
      !Number.isFinite(Date.parse(row.expires_at)))
  )
    stateFail('Successful job is missing its expiring result location.');
  return row;
}
export function xReportOutcome(p: CompiledRequest, r: TransportResult) {
  try {
    const d = envelope(r);
    if (d.next_cursor || Array.isArray(d.data)) return false;
    job(d.data, p.query, p.accountId!);
    return true;
  } catch {
    return false;
  }
}
function safeJob(row: JsonObject) {
  return Object.fromEntries(
    [...fields, 'account_id', 'id_str', 'status', 'expires_at', 'created_at', 'updated_at']
      .filter(k => row[k] !== undefined)
      .map(k => [k, row[k]]),
  );
}
export function xReportSafeData(data: unknown): JsonObject {
  if (!object(data)) return {};
  const row = data.data;
  if (!object(row)) return {};
  return {
    data: safeJob(row),
    result_download_available: row.status === 'SUCCESS',
    meaning: 'Original native job receipt; metrics have not yet been downloaded and validated.',
  };
}
const bindingKey = (c: Connection, id: string) => sha256(scopeKey(c.id, id));
const quotaKey = (account: string) => sha256(scopeKey('x-report-processing', account));
export function admitXReport(p: CompiledRequest, store: Store, review: string) {
  if (!xReportKind(p)) return;
  const key = quotaKey(p.accountId!),
    claim = sha256(review);
  const row = store.db
    .prepare("SELECT data FROM documents WHERE tenant_id='__service_limits__' AND kind='x_report_quota' AND id=?")
    .get(key) as JsonObject | undefined;
  const active: string[] = row ? JSON.parse(row.data).active : [];
  if (!Array.isArray(active) || active.some(v => typeof v !== 'string') || active.length > 100)
    stateFail('Invalid local report admission state.');
  if (active.includes(claim)) return;
  if (active.length >= 100)
    throw new MirrorError(
      'PLATFORM_RATE_LIMIT',
      '100 X report submissions are still processing or have uncertain outcomes in this account. Poll the original jobs; do not replace them automatically.',
      {submission_started: false, unresolved_jobs: active.length},
      429,
      true,
    );
  store.putDocument('__service_limits__', 'x_report_quota', key, {active: [...active, claim], at: Date.now()});
}
export function observeXReport(p: CompiledRequest, c: Connection, store: Store, rows: JsonObject[]) {
  for (const row of rows) {
    const b = p.xReportRead?.find(b => b.job_id === row.id_str);
    if (!b) stateFail('Cannot observe an unbound report job.');
    if (!['SUCCESS', 'FAILED', 'CANCELLED'].includes(row.status)) continue;
    store.transaction(() => {
      const key = quotaKey(b.account_id),
        prior = store.db
          .prepare("SELECT data FROM documents WHERE tenant_id='__service_limits__' AND kind='x_report_quota' AND id=?")
          .get(key) as JsonObject | undefined;
      if (prior) {
        const active = JSON.parse(prior.data).active.filter((id: string) => id !== sha256(b.review_id));
        if (active.length) store.putDocument('__service_limits__', 'x_report_quota', key, {active, at: Date.now()});
        else
          store.db
            .prepare("DELETE FROM documents WHERE tenant_id='__service_limits__' AND kind='x_report_quota' AND id=?")
            .run(key);
      }
      store.putDocument(c.tenantId, 'x_report_run', bindingKey(c, b.job_id), {
        ...b,
        last_status: row.status,
        status_checked_at: Date.now(),
      });
    });
  }
}
export function retainXReport(
  p: CompiledRequest,
  c: Connection,
  store: Store,
  response: TransportResult,
  state: unknown[],
  reviewId: string,
  auth: Credentials,
  submittedAt: number,
) {
  if (!xReportKind(p) || !xReportOutcome(p, response)) return;
  const row = (response.data as JsonObject).data,
    key = bindingKey(c, row.id_str);
  if (
    store.db.prepare("SELECT 1 FROM documents WHERE tenant_id=? AND kind='x_report_run' AND id=?").get(c.tenantId, key)
  )
    stateFail('X reused an existing job ID. It cannot establish new report ownership.');
  const b = {
    review_id: reviewId,
    job_id: row.id_str,
    connection_id: c.id,
    account_id: p.accountId,
    definition: p.query,
    ...(state[0] as JsonObject),
    login_fingerprint: xReportIdentity(auth),
    submitted_at: submittedAt,
    expires_at: submittedAt + 30 * 86400000,
  };
  store.putDocument(c.tenantId, 'x_report_run', key, b);
  observeXReport({...p, xReportRead: [b]}, c, store, [row]);
}
export function authorizeXReport(p: CompiledRequest, c: Connection, store: Store, account: string): boolean {
  if (p.gateway !== gateway || !/^\/12\/stats\/jobs\/accounts\//.test(p.path)) return false;
  const kind = xReportRoute(p);
  if (
    !kind ||
    p.path.split('/').at(-1) !== account ||
    p.accountId !== account ||
    Object.keys(p.headers).length ||
    p.body !== undefined
  )
    fail('Use the exact selected-account report route without overrides.', 'RESOURCE_SCOPE_REQUIRED');
  if (kind === 'create') {
    assertXReport(p);
    return true;
  }
  if (
    !p.readOnly ||
    Object.keys(p.query).some(k => k !== 'job_ids') ||
    !ids(p.query.job_ids, snowflake, p.reportDownload ? 1 : 200)
  )
    fail('Poll explicit original AMCP job_ids; download_report requires exactly one job.', 'RESOURCE_SCOPE_REQUIRED');
  const bindings = p.query.job_ids.split(',').map((id: string) => {
    let b: JsonObject;
    try {
      b = store.document(c.tenantId, 'x_report_run', bindingKey(c, id));
    } catch {
      fail('The job must come from a successful reviewed submission on this connection.', 'RESOURCE_SCOPE_REQUIRED');
    }
    if (b.job_id !== id || b.account_id !== account || b.connection_id !== c.id)
      fail('Job belongs to another account or connection.', 'RESOURCE_SCOPE_REQUIRED');
    if (b.expires_at <= Date.now())
      fail('The retained report job expired. An explicitly reviewed new report is required.', 'X_REPORT_EXPIRED');
    if (b.login_fingerprint !== xReportIdentity(store.credentials(c.tenantId, c.id)))
      fail(
        'The original X app/user login changed; do not reuse or automatically recreate this job.',
        'X_REPORT_LOGIN_CHANGED',
      );
    return b;
  });
  p.xReportRead = bindings;
  return true;
}
export function xReportStatus(p: CompiledRequest, r: TransportResult): JsonObject[] {
  const d = envelope(r),
    bindings = p.xReportRead;
  if (
    !bindings ||
    !Array.isArray(d.data) ||
    d.data.length !== bindings.length ||
    (d.next_cursor && d.data.length === 0)
  )
    stateFail('X did not return every requested report job.');
  const seen = new Set<string>();
  return d.data.map(row => {
    const b = bindings.find(b => b.job_id === row?.id_str);
    if (!b || seen.has(row.id_str)) stateFail('X returned duplicate or unrequested jobs.');
    seen.add(row.id_str);
    return job(row, b.definition, b.account_id, b.job_id);
  });
}
export function xReportStatusData(p: CompiledRequest, r: TransportResult) {
  const rows = xReportStatus(p, r);
  return {
    data: rows.map(row => ({
      ...safeJob(row),
      result_download_available: row.status === 'SUCCESS',
      report_complete: false,
    })),
    meaning: 'Status only. Use download_report=true on one original job to retrieve and validate metrics.',
  };
}
export function xReportRead(p: CompiledRequest, id: string): CompiledRequest {
  return {
    ...p,
    action: 'AMCP_X_REPORT_READ',
    method: 'GET',
    path: '/12/stats/jobs/accounts/' + p.accountId,
    query: {job_ids: id},
    body: undefined,
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    reportDownload: undefined,
    xReportRead: undefined,
  };
}
export async function verifyXReport(p: CompiledRequest, result: JsonObject, send: Send) {
  const id = result.data.data.id_str,
    read = xReportRead(p, id),
    rows = xReportStatus(read, await send(read)),
    row = rows[0]!;
  const status =
    row.status === 'PROCESSING'
      ? 'pending'
      : row.status === 'SUCCESS' && Date.parse(row.expires_at) > Date.now()
        ? 'verified'
        : 'failed';
  return {
    status,
    checks: [
      {
        job_id: id,
        status,
        provider_status: row.status,
        verification_scope: 'original_review_bound_job_status',
        report_rows_downloaded: false,
      },
    ],
    resources:
      status === 'verified'
        ? [
            {
              job_id: id,
              account_id: p.accountId,
              read_result: {
                tool: gateway,
                arguments: {
                  action: 'x_stats_jobs_accounts_account_id_get',
                  account_id: p.accountId,
                  params: {job_ids: id},
                  download_report: true,
                  dry_run: false,
                },
              },
              meaning:
                'Retrieve validated metrics from the original report; job success alone does not certify report completeness.',
            },
          ]
        : [],
  };
}
/** Request parameters are echoed in native report files. They are part of the
 * result identity, not proof by themselves: current account/login + original job
 * binding + the provider-only download URL must also be checked by the caller. */
export function validateXReportData(data: unknown, b: JsonObject) {
  if (
    !object(data) ||
    data.data_type !== 'stats' ||
    !Number.isSafeInteger(data.time_series_length) ||
    data.time_series_length !== b.time_series_length ||
    !Array.isArray(data.data) ||
    !object(data.request) ||
    !object(data.request.params) ||
    Object.keys(data).some(k => !['data_type', 'time_series_length', 'data', 'request'].includes(k))
  )
    stateFail('The downloaded report has an invalid or incomplete native envelope.');
  sameDefinition(data.request.params, b.definition);
  if (data.request.params.account_id !== undefined && data.request.params.account_id !== b.account_id)
    stateFail('Downloaded report belongs to another account.');
  const expected = new Set<string>(b.definition.entity_ids.split(',')),
    seen = new Set<string>(),
    flat: JsonObject[] = [];
  let cells = 0,
    segments = 0;
  function metrics(v: unknown, depth = 0) {
    if (!object(v) || depth > 6 || !Object.keys(v).length || Object.keys(v).length > 256)
      stateFail('Metric nesting/columns are empty, excessive or invalid.');
    for (const [key, value] of Object.entries(v)) {
      if (!/^[a-z][a-z0-9_]{0,127}$/.test(key)) stateFail('Invalid native metric field.');
      if (value === null) continue;
      if (object(value)) {
        metrics(value, depth + 1);
        continue;
      }
      if (!Array.isArray(value) || value.length !== b.time_series_length)
        stateFail('Metric time series does not match the reviewed grain.');
      cells += value.length;
      if (cells > 1000000) stateFail('Report exceeds one million metric cells; narrow the date range or segmentation.');
      for (const n of value)
        if (n !== null && (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER))
          stateFail(
            'Metric values must be finite and exactly representable native numbers; unsafe magnitudes are refused.',
          );
    }
  }
  for (const row of data.data) {
    if (
      !object(row) ||
      typeof row.id !== 'string' ||
      !expected.has(row.id) ||
      seen.has(row.id) ||
      !Array.isArray(row.id_data) ||
      Object.keys(row).some(k => !['id', 'id_data'].includes(k))
    )
      stateFail('Downloaded report contains a foreign, duplicate or malformed entity.');
    seen.add(row.id);
    const grains = new Set<string>();
    for (const piece of row.id_data) {
      if (!object(piece) || Object.keys(piece).some(k => !['segment', 'metrics'].includes(k)))
        stateFail('Invalid report segment.');
      if (
        (!b.definition.segmentation_type && piece.segment !== null) ||
        (b.definition.segmentation_type && !object(piece.segment))
      )
        stateFail('Report segmentation differs from the reviewed request.');
      // Preserve provider segment metadata as bounded untrusted JSON. Do not invent
      // an interpretation for native names/codes or aggregate different segments.
      if (
        object(piece.segment) &&
        (!Object.keys(piece.segment).length || Buffer.byteLength(JSON.stringify(piece.segment)) > 4096)
      )
        stateFail('Missing or oversized native segment identity.');
      const grain = stable(piece.segment);
      if (grains.has(grain)) stateFail('Duplicate segment within a requested entity.');
      grains.add(grain);
      if (++segments > 25000) stateFail('Report exceeds 25000 segment rows.');
      metrics(piece.metrics);
      flat.push({id: row.id, segment: piece.segment, metrics: piece.metrics});
    }
    if (!b.definition.segmentation_type && row.id_data.length !== 1)
      stateFail('Unsegmented reports need one metrics object per entity.');
  }
  const missing = [...expected].filter(id => !seen.has(id));
  return {
    data: flat,
    report: {
      job_id: b.job_id,
      account_id: b.account_id,
      currency: b.currency,
      timezone: b.timezone,
      definition: b.definition,
      time_series_length: b.time_series_length,
      rows: flat.length,
      entities: data.data.length,
      segments,
      cells,
      complete: missing.length === 0,
      missing_entity_ids: missing,
      provider_count_verified: false,
      segmentation_reconciles_to_total: b.definition.segmentation_type ? false : null,
      native_values:
        'Numeric series and explicit nulls are preserved; absent metrics remain unavailable. Spend billed_charge_local_micro is in account-currency micros. No cross-placement, cross-currency or attribution aggregation is performed.',
      data_untrusted: true,
      freshness:
        'Recent metrics can change. Spend may be adjusted for up to 14 days; attribution and segmented totals remain provider estimates.',
    },
  };
}
export const xReportImpact = {
  provider: 'x',
  effect:
    'Creates one asynchronous analytics job. Advertising configuration and budgets are unchanged; provider concurrent-job quota is consumed.',
  prerequisites:
    'Explicit account and entity IDs, metric groups, placement, date interval and grain; current account ownership, timezone, currency and original app/user login are checked.',
  limits:
    '20 IDs; 90 days unsegmented or 45 days segmented; current AGE/GENDER/METROS/REGIONS/PLATFORMS/CONVERSION_TAGS breakdowns. Native compatibility and MACT permissions remain provider checks. Server result parsing is bounded to 8 MiB compressed, 32 MiB expanded, 25000 segments and one million metric cells.',
  recovery:
    'Retain the original review/key/job ID. Lost submissions are never retried automatically. Poll the original job; download_report=true retrieves and validates results on the server. Failure, expiry, incomplete identity coverage or an invalid download is never a successful empty report. Cancellation is still unqualified pending a current official endpoint contract.',
};

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const xReportFamily: ReviewedFamily = {
  name: 'x_report_jobs',
  files: ['src/x-report-jobs.ts / src/x-report-download.ts', ['tests/x-report-jobs.test.ts']],
  kind: xReportKind,
  // A report or export job (RPT-06): a reviewed write unless the owner’s provider-job switch admits it.
  effect: 'provider_job',
  assert: plan => {
    assertNoMethodOverride(plan);
    assertXReport(plan);
  },
  authorize: (plan, connection, account, store) => authorizeXReport(plan, connection, store, account),
  snapshots: xReportSnapshots,
  state: (plan, readers) => {
    const reader = readers.guarded('Report prerequisites must remain read-only.', {
      value: xReportIdentity,
      changed: () => {
        throw new MirrorError('X_REPORT_LOGIN_CHANGED', 'The X login changed during preparation.');
      },
    });
    return readXReportState(plan, reader.read, reader.bound);
  },
  impact: () => xReportImpact,
  beforeSubmit: (plan, state, auth) => {
    if (xReportIdentity(auth) !== (state[0] as JsonObject).login_fingerprint)
      throw new MirrorError('X_REPORT_LOGIN_CHANGED', 'The X login changed after preparation.');
  },
  admit: (plan, submission) => admitXReport(plan, submission.store, submission.reviewId),
  outcome: xReportOutcome,
  safeOutcome: (outcome, plan, result) => ({...outcome, data: xReportSafeData(result.data)}),
  retain: (plan, response, result, submission) =>
    retainXReport(
      plan,
      submission.connection,
      submission.store,
      response,
      submission.state,
      submission.reviewId,
      submission.auth,
      submission.submittedAt,
    ),
  verify: async (plan, v) => {
    const verified = await verifyXReport(
      plan,
      v.result,
      v.guarded('Report verification must remain read-only.', {
        after: (read, active, response) => {
          observeXReport(read, active, v.store, xReportStatus(read, response));
        },
      }),
    );
    for (const resource of verified.resources as JsonObject[])
      resource.read_result.arguments.connection_id = v.connection.id;
    return verified;
  },
  verifyEveryTime: true,
  exemptFromSpendTextMatch: true,
};
