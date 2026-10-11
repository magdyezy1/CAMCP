import {assertNoMethodOverride} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {scopeKey, stable} from './security.js';
import type {Store} from './store.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {criteoPrefix} from './criteo-version.js';
import {sameLogin} from './connection-authority.js';

type Kind = 'accounts' | 'campaigns' | 'line-items';
type Send = (p: CompiledRequest) => Promise<TransportResult>;
const prefix = criteoPrefix,
  gateway = 'criteo_native_action';
/**
 * The three captured report actions on API 2026-07. Criteo replaced the account, campaign and line item reports with
 * one performance report, POST /reports/performance, scoped by exactly one of filters.accountIds, campaignIds or
 * lineItemIds (Criteo guides "Performance Report" and "Migrating from the Legacy Reporting API", read 2026-09-29).
 * Each action keeps its scope: the account report names only the selected account; the campaign and line item
 * reports name up to 50 IDs discovered in it. Every scope spans at most 100 days.
 */
const actions: Record<string, Kind> = {
  GENERATE_ASYNC_ACCOUNTS_REPORT: 'accounts',
  GENERATE_ASYNC_CAMPAIGNS_REPORT: 'campaigns',
  GENERATE_ASYNC_LINE_ITEMS_REPORT: 'line-items',
};
const scopes: Record<Kind, string> = {accounts: 'accountIds', campaigns: 'campaignIds', 'line-items': 'lineItemIds'};
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const jobId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const date = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
const timestamp = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) &&
  Number.isFinite(Date.parse(v));
function fail(message: string, code = 'CRITEO_REPORT_INVALID'): never {
  throw new MirrorError(code, message, {}, code === 'CRITEO_REPORT_STATE_UNVERIFIED' ? 502 : 400);
}
function stateFail(message: string): never {
  return fail(message, 'CRITEO_REPORT_STATE_UNVERIFIED');
}
const only = (v: JsonObject, allowed: string[]) => {
  if (Object.keys(v).some(k => !allowed.includes(k)))
    fail('Unsupported report fields. Use the inspected version-specific contract.');
};
const list = (v: unknown, allowed: string[], maximum: number) =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.length <= maximum &&
  new Set(v).size === v.length &&
  v.every(x => typeof x === 'string' && allowed.includes(x));
const nativeIds = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.length <= 50 && new Set(v).size === v.length && v.every(id);
export const criteoReportDimensions = [
  'date',
  'hour',
  'accountId',
  'accountName',
  'campaignId',
  'campaignName',
  'campaignType',
  'lineItemId',
  'lineItemName',
  'retailerId',
  'retailerName',
  'brandId',
  'brandName',
  'productCategory',
  'productId',
  'productName',
  'salesChannel',
  'mediaType',
  'buyType',
  'budgetModel',
  'activationPlatform',
  'environment',
  'pageType',
  'pageCategory',
  'servedCategory',
  'keyword',
  'searchTerm',
  'searchTermType',
  'searchTermTargeting',
  'creativeId',
  'creativeName',
  'creativeType',
  'creativeTemplateId',
  'creativeTemplateName',
  'targetedKeywordType',
];
export const criteoReportMetrics = [
  'impressions',
  'clicks',
  'spend',
  'attributedSales',
  'attributedUnits',
  'attributedOrders',
  'assistedSales',
  'assistedUnits',
  'ctr',
  'cpc',
  'cpo',
  'cpm',
  'roas',
  'videoViews',
  'videosStarted',
  'videosPlayedTo25',
  'videosPlayedTo50',
  'videosPlayedTo75',
  'videosPlayedTo100',
  'videoPlayingRate',
  'videoCompletionRate',
  'videoImpressions',
  'videoMuted',
  'videoUnmuted',
  'videoPaused',
  'videoResumed',
  'videoAvgInteractionRate',
  'videoViewability',
  'videoStartingRate',
  'videoCPC',
  'videoCPCV',
  'newToBrandAttributedSales',
  'newToBrandAttributedSalesRate',
  'newToBrandAttributedUnits',
  'newToBrandAttributedUnitsRate',
  'uniqueVisitors',
  'frequency',
  'winRate',
  'sampledBidsWon',
  'sampledBidsParticipated',
  'makeGoodSpend',
];
/** The optional filters of PerformanceReportFilters; each is a list of these values. */
export const criteoReportFilters: Record<string, string[]> = {
  activationPlatforms: ['CommerceMax', 'PrivateMarket'],
  budgetModels: ['CriteoBudget', 'RetailerBudget'],
  buyTypes: ['auction', 'preferredDeals', 'sponsorship'],
  campaignTypes: ['sponsoredProducts', 'onSiteDisplays'],
  mediaTypes: ['unknown', 'video', 'display'],
  salesChannels: ['online', 'offline'],
  searchTermTargetings: ['unknown', 'automatic', 'manual'],
  searchTermTypes: ['unknown', 'searched', 'entered'],
  targetedKeywordTypes: ['unknown', 'generic', 'branded', 'conquesting'],
};
const attributionWindows: Record<string, string[]> = {
  clickAttributionWindow: ['none', '7D', '14D', '30D'],
  viewAttributionWindow: ['none', '1D', '7D', '14D', '30D'],
};
const matchLevels = ['sameSku', 'sameCategory', 'sameBrand', 'campaign'];
export function criteoReportKind(p: CompiledRequest): Kind | undefined {
  const kind = actions[p.action.split('/').at(-1)!];
  return kind &&
    p.action === 'criteo_reporting_ops/' + Object.keys(actions).find(a => actions[a] === kind) &&
    p.gateway === gateway &&
    p.method === 'POST' &&
    p.path === prefix + '/reports/performance' &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://api.criteo.com')
    ? kind
    : undefined;
}
const attributes = (p: CompiledRequest): JsonObject => (p.body as JsonObject).data.attributes;
function targetIds(p: CompiledRequest): string[] {
  return attributes(p).filters[scopes[criteoReportKind(p)!]];
}
export function assertCriteoReport(p: CompiledRequest) {
  const kind = criteoReportKind(p);
  if (!kind) return;
  if (
    !id(p.accountId) ||
    Object.keys(p.query).length ||
    Object.keys(p.headers).length ||
    !object(p.body) ||
    !object(p.body.data) ||
    !object(p.body.data.attributes)
  )
    fail('Select one numeric account and an explicit native data.attributes report, without query/header overrides.');
  only(p.body, ['data']);
  only(p.body.data, ['type', 'attributes']);
  if (p.body.data.type !== undefined && p.body.data.type !== 'AsyncPerformanceReport')
    fail('Use the documented report request type, AsyncPerformanceReport.');
  const a = attributes(p);
  only(a, [
    'filters',
    'startDate',
    'endDate',
    'timezone',
    'format',
    'dimensions',
    'metrics',
    ...Object.keys(attributionWindows),
    'clickMatchLevel',
    'viewMatchLevel',
  ]);
  const f = a.filters;
  if (!object(f)) fail('Scope the report in filters: ' + scopes[kind] + ' for this action.');
  only(f, [scopes[kind], ...Object.keys(criteoReportFilters)]);
  if (kind === 'accounts') {
    if (!nativeIds(f.accountIds) || f.accountIds.length !== 1 || f.accountIds[0] !== p.accountId)
      fail(
        'Account reports require filters.accountIds containing only the selected account. Use separate reports for other account grants.',
      );
  } else if (!nativeIds(f[scopes[kind]]))
    fail('Supply 1–50 distinct IDs from this account in filters.' + scopes[kind] + '.');
  for (const [field, allowed] of Object.entries(criteoReportFilters))
    if (f[field] !== undefined && !list(f[field], allowed, allowed.length))
      fail('Invalid native report filter: ' + field + '.');
  if (
    !date(a.startDate) ||
    !date(a.endDate) ||
    a.startDate > a.endDate ||
    (Date.parse(a.endDate) - Date.parse(a.startDate)) / 86400000 >= 100
  )
    fail('Use inclusive YYYY-MM-DD dates spanning at most 100 days.');
  if (typeof a.timezone !== 'string' || !a.timezone || /^[+-]/.test(a.timezone))
    fail('Select an explicit IANA timezone.');
  try {
    new Intl.DateTimeFormat('en', {timeZone: a.timezone});
  } catch {
    fail('Unrecognized IANA timezone.');
  }
  if (!['json', 'json-compact'].includes(a.format))
    fail(
      'Explicitly select json or json-compact. CSV and newline provider formats need a separately qualified parser.',
    );
  if (
    !list(a.dimensions, criteoReportDimensions, criteoReportDimensions.length) ||
    !list(a.metrics, criteoReportMetrics, criteoReportMetrics.length) ||
    !a.dimensions.includes('accountId') ||
    !a.dimensions.includes('date') ||
    (kind !== 'accounts' && !a.dimensions.includes('campaignId')) ||
    (kind === 'line-items' && !a.dimensions.includes('lineItemId')) ||
    (a.dimensions.includes('lineItemId') && !a.dimensions.includes('campaignId'))
  )
    fail('Use distinct native dimensions/metrics with accountId, date and every selected parent/entity identity.');
  for (const [field, allowed] of Object.entries(attributionWindows))
    if (a[field] !== undefined && !allowed.includes(a[field])) fail('Invalid attribution window: ' + field + '.');
  for (const field of ['clickMatchLevel', 'viewMatchLevel'])
    if (a[field] !== undefined && !matchLevels.includes(a[field]))
      fail('Invalid attribution match level: ' + field + '.');
  const click = a.clickAttributionWindow,
    view = a.viewAttributionWindow;
  if (
    (click === undefined) !== (view === undefined) ||
    (click !== undefined && (parseInt(view) || 0) > (parseInt(click) || 0))
  )
    fail(
      'Set both attribution windows together, with view no longer than click; omit both to retain campaign settings.',
    );
  if (
    a.metrics.includes('winRate') &&
    stable(f.campaignTypes) !== stable(['sponsoredProducts']) &&
    !a.dimensions.includes('campaignType')
  )
    fail('winRate requires filters.campaignTypes ["sponsoredProducts"] or the campaignType dimension.');
  if (a.metrics.some((m: string) => m.startsWith('video')) && !a.dimensions.includes('lineItemId'))
    fail('Native video metrics require line-item grain and its parent campaignId.');
}
export function assertCriteoReportScopes(c: Connection, discovery?: Kind) {
  const required = [
    'RetailMedia_Analytics_Read',
    ...(discovery
      ? ['RetailMedia_Accounts_Read', ...(discovery === 'accounts' ? [] : ['RetailMedia_Campaign_Read'])]
      : []),
  ];
  if (!required.every(s => c.scopes.includes(s)))
    fail('The selected connection needs ' + required.join(', ') + '.', 'INSUFFICIENT_SCOPE');
}
function read(p: CompiledRequest, path: string, query: JsonObject = {}): CompiledRequest {
  return {
    ...p,
    action: 'AMCP_CRITEO_REPORT_READ',
    method: 'GET',
    path,
    query,
    body: undefined,
    headers: {},
    readOnly: true,
    requiresConfirmation: false,
    destructive: false,
    responseControls: undefined,
    scopeContext: undefined,
    criteoReportRead: undefined,
    criteoReportReviewId: undefined,
    queryArrayEncoding: 'repeat',
  };
}
export function criteoReportSnapshots(p: CompiledRequest) {
  const reads = [read(p, prefix + '/accounts', {limitToId: [p.accountId], pageIndex: 0, pageSize: 2})];
  if (criteoReportKind(p) !== 'accounts')
    reads.push(
      read(p, prefix + '/accounts/' + p.accountId + '/' + criteoReportKind(p), {
        limitToId: targetIds(p),
        pageIndex: 0,
        pageSize: 51,
      }),
    );
  return reads;
}
function envelope(r: TransportResult): JsonObject {
  const d = r.data;
  if (
    r.status !== 200 ||
    !object(d) ||
    d.error !== undefined ||
    ['errors', 'warnings'].some(k => d[k] != null && (!Array.isArray(d[k]) || d[k].length)) ||
    Buffer.byteLength(JSON.stringify(d)) > 4 * 1024 * 1024
  )
    stateFail('Criteo returned failed, partial, oversized or unknown report state.');
  return d;
}
function selectedRows(d: JsonObject, ids: string[]): JsonObject[] {
  const m = d.metadata;
  if (
    !Array.isArray(d.data) ||
    d.data.length !== ids.length ||
    !object(m) ||
    m.currentPageIndex !== 0 ||
    !Number.isSafeInteger(m.currentPageSize) ||
    m.currentPageSize < ids.length ||
    m.nextPage ||
    m.previousPage ||
    (m.totalItemsAcrossAllPages != null && m.totalItemsAcrossAllPages !== ids.length) ||
    (m.totalPages != null && m.totalPages !== 1)
  )
    stateFail('Filtered account discovery did not return every selected resource in one complete page.');
  const found = new Set<string>();
  for (const row of d.data) {
    if (!object(row) || !id(row.id) || !ids.includes(row.id) || found.has(row.id) || !object(row.attributes))
      stateFail('Filtered discovery returned a missing, duplicate or foreign identity.');
    found.add(row.id);
  }
  return d.data;
}
/** Configuration only: telemetry, changing spend and response meters cannot
 * prevent creating a read report. Identity/currency/timezone/parents still do. */
export async function readCriteoReportState(p: CompiledRequest, send: Send) {
  const start = performance.now();
  let bytes = 0,
    calls = 0;
  const get = async (q: CompiledRequest) => {
    if (++calls > 4 || performance.now() - start > 60000)
      stateFail('Report prerequisites exceeded the bounded request/deadline budget.');
    const d = envelope(await send(q));
    bytes += Buffer.byteLength(JSON.stringify(d));
    if (bytes > 8 * 1024 * 1024 || performance.now() - start > 60000)
      stateFail('Report prerequisites exceeded the byte/deadline budget.');
    return d;
  };
  const plans = criteoReportSnapshots(p),
    row = selectedRows(await get(plans[0]!), [p.accountId!])[0]!,
    a = row.attributes;
  if (
    a.type !== 'demand' ||
    typeof a.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(a.currency) ||
    typeof a.timeZone !== 'string' ||
    !a.timeZone
  )
    stateFail('Demand account identity, currency and timezone are required.');
  try {
    new Intl.DateTimeFormat('en', {timeZone: a.timeZone});
  } catch {
    stateFail('The account timezone is invalid.');
  }
  const state: JsonObject = {
    account: {id: row.id, currency: a.currency, timezone: a.timeZone, type: a.type},
    targets: [],
  };
  if (plans[1]) {
    const kind = criteoReportKind(p),
      rows = selectedRows(await get(plans[1]), targetIds(p));
    if (kind === 'campaigns') {
      for (const row of rows) {
        if (row.attributes.accountId !== p.accountId) stateFail('A selected campaign belongs to a different account.');
        state.targets.push({id: row.id, accountId: p.accountId});
      }
    } else {
      for (const row of rows) {
        if (!id(row.attributes.campaignId)) stateFail('A selected line item has no verified campaign.');
        state.targets.push({id: row.id, campaignId: row.attributes.campaignId});
      }
      const parents = [...new Set(state.targets.map((x: JsonObject) => x.campaignId))] as string[];
      const campaigns = selectedRows(
        await get(
          read(p, prefix + '/accounts/' + p.accountId + '/campaigns', {limitToId: parents, pageIndex: 0, pageSize: 51}),
        ),
        parents,
      );
      if (campaigns.some(row => row.attributes.accountId !== p.accountId))
        stateFail('A line-item parent is outside this account.');
    }
    state.targets.sort((a: JsonObject, b: JsonObject) => a.id.localeCompare(b.id, 'en'));
  }
  return [state];
}
function status(r: TransportResult, expected?: string): JsonObject {
  const d = envelope(r);
  if (!object(d.data) || !jobId(d.data.id) || (expected && d.data.id !== expected) || !object(d.data.attributes))
    stateFail('The report receipt/status has no matching native UUID.');
  const a = d.data.attributes;
  if (!['pending', 'success', 'failure', 'expired'].includes(a.status) || (a.id != null && a.id !== d.data.id))
    stateFail('Unknown or mismatched report status.');
  if (a.md5CheckSum != null && a.md5Checksum != null && a.md5CheckSum !== a.md5Checksum)
    stateFail('Conflicting report checksums.');
  const md5 = a.md5CheckSum ?? a.md5Checksum;
  if (
    a.status === 'success' &&
    (!Number.isSafeInteger(a.rowCount) ||
      a.rowCount < 0 ||
      !Number.isSafeInteger(a.fileSizeBytes) ||
      a.fileSizeBytes < 2 ||
      typeof md5 !== 'string' ||
      !/^[a-f0-9]{32}$/i.test(md5) ||
      !timestamp(a.createdAt) ||
      !timestamp(a.expiresAt) ||
      Date.parse(a.expiresAt) <= Date.parse(a.createdAt))
  )
    stateFail('Successful report metadata lacks count, size, checksum or timestamps.');
  return {
    id: d.data.id,
    status: a.status,
    ...(a.status === 'success'
      ? {
          rowCount: a.rowCount,
          fileSizeBytes: a.fileSizeBytes,
          md5: md5.toLowerCase(),
          createdAt: a.createdAt,
          expiresAt: a.expiresAt,
        }
      : {}),
  };
}
export function criteoReportOutcome(_p: CompiledRequest, r: TransportResult) {
  try {
    return ['pending', 'success'].includes(status(r).status);
  } catch {
    return false;
  }
}
const bindingKey = (c: Connection, job: string) => scopeKey(c.id, job);
function document(store: Store, c: Connection, kind: string, key: string): JsonObject | undefined {
  try {
    return store.document(c.tenantId, kind, key);
  } catch (e) {
    if (e instanceof MirrorError && e.code === 'NOT_FOUND') return;
    throw e;
  }
}
export function authorizeCriteoReport(p: CompiledRequest, c: Connection, store: Store, account: string): boolean {
  if (p.gateway !== gateway) return false;
  const kind = criteoReportKind(p);
  if (kind) {
    assertCriteoReport(p);
    assertCriteoReportScopes(c, kind);
    if (
      kind !== 'accounts' &&
      targetIds(p).some(v => !store.ownsResource(c, account, 'criteo-report-target/' + kind + '/' + v))
    )
      fail(
        'Discover the selected account campaigns or line items before preparing their report. Preparation will independently recheck current ownership.',
        'RESOURCE_SCOPE_REQUIRED',
      );
    return true;
  }
  if (
    p.action === 'AMCP_CRITEO_REPORT_READ' &&
    p.path === prefix + '/accounts' &&
    p.method === 'GET' &&
    p.readOnly &&
    p.body === undefined &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://api.criteo.com') &&
    stable(p.query) === stable({limitToId: [account], pageIndex: 0, pageSize: 2}) &&
    !Object.keys(p.headers).length
  ) {
    assertCriteoReportScopes(c, 'accounts');
    return true;
  }
  const m = new RegExp('^' + prefix + '/reports/([^/]+)/(status|output)$').exec(p.path);
  if (!m) return false;
  if (
    !jobId(m[1]) ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.body !== undefined ||
    p.specialTransport ||
    (p.origin && p.origin !== 'https://api.criteo.com') ||
    Object.keys(p.query).length ||
    Object.keys(p.headers).length
  )
    fail('Report bindings authorize exact status/output GETs without overrides.', 'RESOURCE_SCOPE_REQUIRED');
  assertCriteoReportScopes(c);
  const job = m[1]!,
    saved = document(store, c, 'criteo_report_run', bindingKey(c, job));
  let binding = saved;
  if (p.criteoReportReviewId) {
    const review = document(store, c, 'write_review', p.criteoReportReviewId),
      claim = store.db
        .prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?')
        .get(c.tenantId, p.criteoReportReviewId) as JsonObject | undefined;
    let result: JsonObject | undefined;
    try {
      result = claim?.result ? JSON.parse(claim.result) : undefined;
    } catch {}
    if (
      m[2] !== 'status' ||
      !review ||
      review.connection_id !== c.id ||
      review.plan.accountId !== account ||
      !criteoReportKind(review.plan) ||
      claim?.state !== 'complete' ||
      result?.success !== true ||
      result.data?.data?.id !== job
    )
      fail('The original successful reviewed submission must authorize this status read.', 'RESOURCE_SCOPE_REQUIRED');
    binding = {
      review_id: p.criteoReportReviewId,
      connection_id: c.id,
      account_id: account,
      job_id: job,
      definition: attributes(review.plan),
      target_kind: criteoReportKind(review.plan),
      targets: review.state[0].targets,
      currency: review.state[0].account.currency,
      account_timezone: review.state[0].account.timezone,
      retained_until: Date.now() + 7 * 86400000,
    };
    if (
      saved &&
      (saved.account_id !== account ||
        stable(saved.definition) !== stable(binding.definition) ||
        saved.target_kind !== binding.target_kind ||
        stable(saved.targets) !== stable(binding.targets) ||
        saved.currency !== binding.currency)
    )
      stateFail('The provider reused a report ID for a different account or reviewed definition.');
  }
  if (
    !binding ||
    binding.connection_id !== c.id ||
    binding.account_id !== account ||
    binding.retained_until <= Date.now()
  )
    fail(
      'Verify the original report review for this account/connection before retrieving it.',
      'RESOURCE_SCOPE_REQUIRED',
    );
  p.criteoReportRead = {...binding, kind: m[2]};
  return true;
}
/** Only actual account collections establish target ownership, never reports. */
export function observeCriteoReportTargets(p: CompiledRequest, c: Connection, store: Store, data: unknown) {
  if (p.gateway !== gateway || !p.readOnly || p.method !== 'GET') return;
  const m = new RegExp('^' + prefix + '/accounts/([1-9][0-9]*)/(campaigns|line-items)$').exec(p.path);
  if (!m || m[1] !== p.accountId || !object(data) || !Array.isArray(data.data)) return;
  envelope({data, status: 200, headers: {}});
  for (const row of data.data) {
    if (
      !object(row) ||
      !id(row.id) ||
      !object(row.attributes) ||
      (m[2] === 'campaigns' && row.attributes.accountId !== p.accountId) ||
      (m[2] === 'line-items' && !id(row.attributes.campaignId))
    )
      stateFail('Account discovery returned an unverified report target.');
  }
  for (const row of data.data) store.rememberResource(c, p.accountId!, 'criteo-report-target/' + m[2] + '/' + row.id);
}
function usable(s: JsonObject) {
  if (s.status === 'pending')
    fail(
      'Report processing is pending. Poll this same report later; do not submit a replacement automatically.',
      'CRITEO_REPORT_PENDING',
    );
  if (s.status === 'failure')
    fail(
      'The provider failed to generate this report. Inspect the original review before any new submission.',
      'CRITEO_REPORT_FAILED',
    );
  if (s.status === 'expired' || Date.parse(s.expiresAt) <= Date.now())
    fail('This report expired. Review a new report request explicitly.', 'CRITEO_REPORT_EXPIRED');
  if (s.status !== 'success') stateFail('Unknown report completion state.');
  // 2026-07 truncates a report at 10,000,000 rows (Demand Side Analytics overview, "Report Row Limits").
  if (s.rowCount >= 10000000)
    fail(
      'The provider row limit may have truncated this report. Split the date or entity scope.',
      'CRITEO_REPORT_INCOMPLETE',
    );
  if (s.rowCount > 25000 || s.fileSizeBytes > 8 * 1024 * 1024)
    fail('Split this report: AMCP retrieves at most 25000 rows and 8 MiB per output.', 'CRITEO_REPORT_TOO_LARGE');
}
export function criteoReportReadResult(p: CompiledRequest, r: TransportResult): JsonObject | undefined {
  const spec = p.criteoReportRead;
  if (!spec) return;
  if (spec.kind === 'status') return status(r, spec.job_id);
  const s = spec.status_data;
  if (!object(s)) stateFail('Read the current report status before downloading.');
  usable(s);
  if (
    r.status !== 200 ||
    !r.bodyIntegrity ||
    r.bodyIntegrity.bytes !== s.fileSizeBytes ||
    r.bodyIntegrity.md5 !== s.md5
  )
    stateFail('Report bytes do not match the completed job size and checksum.');
  const a = spec.definition,
    fields = [...a.dimensions, ...a.metrics];
  let rows: unknown[];
  if (a.format === 'json') {
    if (!Array.isArray(r.data)) stateFail('Expected the requested native JSON row array.');
    rows = r.data;
  } else {
    const d = r.data;
    if (
      !object(d) ||
      Object.keys(d).some(k => !['columns', 'data', 'rows'].includes(k)) ||
      !Array.isArray(d.columns) ||
      d.columns.length !== fields.length ||
      new Set(d.columns).size !== fields.length ||
      d.columns.some((k: unknown) => !fields.includes(k)) ||
      !Array.isArray(d.data) ||
      d.rows !== d.data.length
    )
      stateFail('The compact report columns, rows or count are incomplete.');
    rows = d.data.map((row: unknown) => {
      if (!Array.isArray(row) || row.length !== d.columns.length)
        stateFail('A compact row does not match its column count.');
      return Object.fromEntries(d.columns.map((k: string, i: number) => [k, row[i]]));
    });
  }
  if (rows.length !== s.rowCount) stateFail('Downloaded row count does not match the completed report.');
  const identities = new Set<string>();
  const output = rows.map((value: unknown) => {
    if (
      !object(value) ||
      Object.keys(value).some(k => !fields.includes(k)) ||
      fields.some(k => !Object.hasOwn(value, k))
    )
      stateFail('A report row contains missing or unexpected columns.');
    const row = {...value};
    for (const k of ['accountId', 'campaignId', 'lineItemId'])
      if (fields.includes(k)) {
        if (typeof row[k] === 'number' && Number.isSafeInteger(row[k])) row[k] = String(row[k]);
        if (!id(row[k])) stateFail('Native account/entity identity is missing or lost precision.');
      }
    if (row.accountId !== spec.account_id || !date(row.date) || row.date < a.startDate || row.date > a.endDate)
      stateFail('Report account or inclusive date is outside the reviewed request.');
    if (
      (spec.target_kind === 'campaigns' && !spec.targets.some((t: JsonObject) => t.id === row.campaignId)) ||
      (spec.target_kind === 'line-items' &&
        !spec.targets.some((t: JsonObject) => t.id === row.lineItemId && t.campaignId === row.campaignId))
    )
      stateFail('A report row belongs to an unreviewed campaign or line item.');
    if (
      a.dimensions.includes('hour') &&
      !(
        (Number.isInteger(row.hour) && row.hour >= 0 && row.hour <= 23) ||
        (typeof row.hour === 'string' && /^(?:[01]?\d|2[0-3])$/.test(row.hour))
      )
    )
      stateFail('Invalid native report hour.');
    for (const k of a.dimensions)
      if (row[k] !== null && typeof row[k] !== 'string' && typeof row[k] !== 'number')
        stateFail('A report dimension has an unknown shape.');
    for (const k of a.metrics)
      if (
        row[k] !== null &&
        !(
          (typeof row[k] === 'number' && Number.isFinite(row[k])) ||
          (typeof row[k] === 'string' && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(row[k]))
        )
      )
        stateFail('A native metric is neither numeric nor explicitly unavailable.');
    const identity = stable([...a.dimensions].sort().map(k => row[k]));
    if (identities.has(identity)) stateFail('The report repeats an identical dimension grain.');
    identities.add(identity);
    return row;
  });
  return {
    data: output,
    report: {
      report_id: spec.job_id,
      account_id: spec.account_id,
      currency: spec.currency,
      timezone: a.timezone,
      account_timezone: spec.account_timezone,
      definition: a,
      rows: output.length,
      complete: true,
      created_at: s.createdAt,
      expires_at: s.expiresAt,
      attribution:
        a.clickAttributionWindow === undefined
          ? 'provider campaign settings'
          : {click: a.clickAttributionWindow, view: a.viewAttributionWindow},
      freshness:
        'A complete download does not imply settled attribution. Recent activity can be delayed and attribution can change for up to 120 hours.',
      aggregation: 'Native values retained; null is unavailable, not zero. Ratios, reach and frequency are not summed.',
      checksum_verified: true,
    },
  };
}
export function observeCriteoReportRead(p: CompiledRequest, c: Connection, store: Store, data: JsonObject) {
  const s = p.criteoReportRead;
  if (!s || s.kind !== 'status') return;
  const {kind, ...binding} = s;
  store.db
    .prepare(
      "DELETE FROM documents WHERE tenant_id=? AND kind='criteo_report_run' AND json_extract(data,'$.retained_until')<=?",
    )
    .run(c.tenantId, Date.now());
  store.putDocument(c.tenantId, 'criteo_report_run', bindingKey(c, s.job_id), {
    ...binding,
    status_data: data,
    checked_at: Date.now(),
  });
}
export async function verifyCriteoReport(p: CompiledRequest, result: JsonObject, reviewId: string, send: Send) {
  const job = result.data.data.id,
    plan = read(p, prefix + '/reports/' + job + '/status');
  plan.criteoReportReviewId = reviewId;
  const d = criteoReportReadResult(plan, await send(plan))!;
  const outcome =
    d.status === 'success' ? 'verified' : ['failure', 'expired'].includes(d.status) ? 'failed' : 'pending';
  return {
    status: outcome,
    checks: [
      {
        resource_id: job,
        status: outcome,
        provider_status: d.status,
        verification_scope: 'original_review_bound_job_status',
        report_rows_downloaded: false,
      },
    ],
    resources:
      outcome === 'verified'
        ? [
            {
              report_id: job,
              account_id: p.accountId,
              read_result: {
                tool: gateway,
                arguments: {
                  operation: 'criteo_reporting_ops',
                  arguments: {
                    action: 'GET_ASYNC_EXPORT_OUTPUT',
                    account_id: p.accountId,
                    params: {reportId: job},
                    dry_run: false,
                  },
                },
              },
              meaning:
                'Status confirms processing only. Output retrieval checks fresh status, byte checksum, row count and exact account/date/entity scope.',
            },
          ]
        : [],
  };
}
/** No polling loop, worker or new queue: each call is resumable through the
 * durable original review. One output is fenced by two fresh status reads. */
export async function runCriteoReportRead(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<unknown>,
  now = () => performance.now(),
) {
  if (p.criteoReportRead?.kind !== 'output') return {data: await fetch(p), pages: 1, truncated: false};
  const deadline = now() + 60000,
    plan = {...p, criteoReportDeadline: deadline},
    s = read(plan, p.path.replace(/\/output$/, '/status'));
  const within = () => {
    if (now() >= deadline) stateFail('Report retrieval exceeded its monotonic deadline. Retry only this output read.');
  };
  const bounded = async (q: CompiledRequest) => {
    within();
    const result = await fetch(q);
    within();
    return result;
  };
  const before = (await bounded(s)) as JsonObject;
  usable(before);
  const data = await bounded(plan),
    after = (await bounded(s)) as JsonObject;
  usable(after);
  if (stable(before) !== stable(after)) stateFail('The report changed during retrieval. Retry only this output read.');
  return {data, pages: 1, truncated: false};
}
export const criteoReportImpact = {
  provider: 'criteo',
  effect:
    'Creates one asynchronous report job; no advertising configuration or budget is changed. Provider reporting quota is consumed.',
  verification:
    'Fresh account currency/timezone and selected campaign/line-item parents are reviewed. A retained successful receipt authorizes only that job; output checks count, bytes, checksum and every account/date/entity row.',
  limits:
    '2026.07 performance report. One account, or up to 50 of its campaign or line item IDs; at most 100 inclusive days; explicit dimensions, metrics, filters and json or json-compact. 25000 rows, 8 MiB output, 60-second retrieval. Other provider formats and the missed-opportunities, attributed-transactions and synchronous reports are not exposed.',
  recovery:
    'Keep the original review and key after a lost submission response. Never automatically resubmit. Pending jobs use the same verification; expired/failed jobs require a new explicit review. Output GETs are safely repeatable while valid.',
};

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const criteoReportFamily: ReviewedFamily = {
  name: 'criteo_report_jobs',
  files: ['src/criteo-report-jobs.ts', ['tests/criteo-report-jobs.test.ts']],
  kind: criteoReportKind,
  // A report or export job (RPT-06): a reviewed write unless the owner’s provider-job switch admits it.
  effect: 'provider_job',
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    assertCriteoReport(plan);
    gateway();
  },
  scope: (c, write, plan) => assertCriteoReportScopes(c, write ? criteoReportKind(plan!) : undefined),
  authorize: (plan, connection, account, store) => {
    if (plan.gateway === 'criteo_native_action' && plan.action === 'AMCP_CRITEO_REPORT_READ')
      assertCriteoReportScopes(connection);
    return authorizeCriteoReport(plan, connection, store, account);
  },
  observe: (read, connection, account, data, store) => observeCriteoReportTargets(read, connection, store, data),
  snapshots: criteoReportSnapshots,
  state: (plan, readers) =>
    readCriteoReportState(
      plan,
      readers.guarded(
        'Report prerequisites must remain read-only.',
        readers.sameLogin('The selected login changed during report preparation. Prepare again.'),
      ).read,
    ),
  impact: () => criteoReportImpact,
  outcome: criteoReportOutcome,
  verify: async (plan, v) => {
    const verified = await verifyCriteoReport(
      plan,
      v.result,
      v.reviewId,
      v.guarded('Report verification must remain read-only.', {
        check: assertCriteoReportScopes,
        after: (read, active, response, auth) => {
          if (!sameLogin(auth, v.store.credentials(v.actor.tenantId, active.id)))
            throw new MirrorError('CONNECTION_AUTHORITY_CHANGED', 'The login changed while checking this report.');
          observeCriteoReportRead(read, active, v.store, criteoReportReadResult(read, response)!);
        },
      }),
    );
    for (const resource of verified.resources as JsonObject[])
      resource.read_result.arguments.arguments.connection_id = v.connection.id;
    return verified;
  },
  retryReadAfterMs: 6000,
  exemptFromSpendTextMatch: true,
};
