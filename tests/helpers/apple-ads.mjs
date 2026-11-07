import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {NativeCampaignReports} from '../../dist/src/report-native.js';
import {ReportingOverview} from '../../dist/src/reporting-overview.js';
import {ReportWorker} from '../../dist/src/worker.js';

// A synthetic Apple Ads account of any size. It answers as the pages of Apple's Ads Platform API documentation show
// (docs/records/APPLE-ADS-PLATFORM-PINS-2026-11-06.md), never as AMCP's code does: the report and query bodies, the
// pagination object beside `result` (with the total only where the pages give one), the page-size ceilings, the campaign
// ID that the ad group and ad reports require, the account header. A request the pages forbid is answered with a 400 and
// listed in `violations`, so a test can say that the account never saw one. Nothing leaves the process.
export const appleAccountId = '500';
export const appleLogin = 'aaaaaaaa-1111-4111-8111-000000000007';
export const appleRange = {since: '2026-08-01', until: '2026-08-07'};
export const campaignOf = i => 444555000 + i;
export const groupOf = (i, k = 0) => 600000000 + i * 100000 + k;
export const adOf = (i, k = 0, j = 0) => 700000000000 + (i * 100000 + k) * 100 + j;
export const reportCeiling = 5000;
export const campaignQueryCeiling = 1000;

const metrics = seed => ({
  localSpend: {amount: String((seed % 97) + 1) + '.50', currency: 'USD'},
  impressions: 100 + (seed % 7),
  taps: 5,
  ttr: 0.05,
  tapInstalls: 1,
  totalInstalls: 2,
});
/** What the rows of a report sum to, for a test that checks totals against the account it built. */
export const spendOf = seed => String((seed % 97) + 1) + '.50';

const campaignRow = i => ({
  metadata: {
    id: campaignOf(i),
    name: 'Campaign ' + i,
    adAccountId: 500,
    promotedObjectType: 'APPSTORE_APP',
    promotedObjectId: '987654321',
    promotedObject: {name: 'Synthetic app'},
    bidStrategy: {bidStrategyType: 'MANUAL_CPT'},
    status: 'ENABLED',
    deleted: false,
  },
  totalMetrics: metrics(i),
});
const groupRow = (i, k, deleted = false) => ({
  metadata: {
    id: groupOf(i, k),
    name: 'Group ' + i + '.' + k,
    adAccountId: 500,
    campaignId: campaignOf(i),
    status: 'ENABLED',
    pricingModel: 'CPT',
    deleted,
  },
  totalMetrics: metrics(i + k),
});
const adRow = (i, k, j, deleted = false) => ({
  metadata: {
    id: adOf(i, k, j),
    name: 'Ad ' + i + '.' + k + '.' + j,
    adAccountId: 500,
    campaignId: campaignOf(i),
    adGroupId: groupOf(i, k),
    status: 'ENABLED',
    deleted,
    creative: {id: 456789012, creativeType: 'DEFAULT_PRODUCT_PAGE', systemStatus: 'VALID'},
  },
  totalMetrics: metrics(i + k + j),
});
const campaignRecord = i => ({
  id: campaignOf(i),
  name: 'Campaign ' + i,
  adAccountId: 500,
  promotedObjectType: 'APPSTORE_APP',
  promotedObjectId: '987654321',
  status: 'ENABLED',
  systemStatus: 'RUNNING',
  systemStatusReasons: [],
  systemStatusLimitingReasons: [],
  displayStatus: 'RUNNING',
  deleted: false,
});
const groupRecord = (i, k) => ({
  id: groupOf(i, k),
  name: 'Group ' + i + '.' + k,
  adAccountId: 500,
  campaignId: campaignOf(i),
  pricingModel: 'CPT',
  status: 'ENABLED',
  systemStatus: 'RUNNING',
  deleted: false,
});
const adRecord = (i, k, j) => ({
  id: adOf(i, k, j),
  adAccountId: 500,
  campaignId: campaignOf(i),
  adGroupId: groupOf(i, k),
  creativeId: 666777888,
  name: 'Ad ' + i + '.' + k + '.' + j,
  status: 'ENABLED',
  systemStatus: 'RUNNING',
  systemStatusReasons: [],
  systemStatusLimitingReasons: [],
  deleted: false,
});

const isoDay = /^\d{4}-\d{2}-\d{2}$/;
const bare = value => (Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value);

export function appleAccount({
  campaigns = 1,
  groups = 1,
  ads = 1,
  idle = () => false,
  /**
   * An ad group (`deleted('adgroup', i, k)`) or ad (`deleted('ad', i, k, j)`) deleted in the window: its report row is
   * there, with `deleted: true`, and the entity queries leave it out, as Apple's pages say they do (Q3).
   */
  deleted = () => false,
  /** Rows one page holds at most, whatever size was asked: `{report, query}` (a short page with more to come). */
  cap = {},
  /** How `pagination` states the total: `count` (totalCount), `absent`, or `results` (the undocumented totalResults). */
  total = 'count',
  /** What `pagination.pageSize` echoes: the size asked (every endpoint example) or the rows returned (QueryPaginationResult). */
  echo = 'requested',
  /** Changes an answer before it is sent: (where, body, response) => response, where is `report:adgroups` and so on. */
  tamper = (_where, _body, response) => response,
  unpaced = true,
} = {}) {
  const actor = {tenantId: 'apple-account', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64')),
    requests = [],
    violations = [],
    groupsOf = typeof groups === 'function' ? groups : () => groups;
  store.putConnection(
    actor,
    {
      id: appleLogin,
      tenantId: actor.tenantId,
      gateway: 'apple_ads_native_action',
      accounts: [appleAccountId],
      enabled: true,
      label: 'Synthetic Apple Ads',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  store.putDocument(actor.tenantId, 'website_assets', appleLogin, {
    groups: [{kind: 'ad_accounts', assets: [{id: appleAccountId, name: 'Synthetic Apple Ads account'}]}],
  });
  const live = Array.from({length: campaigns}, (_, i) => i).filter(i => !idle(i)),
    campaignIndex = value => {
      const n = Number(value) - campaignOf(0);
      return Number.isInteger(n) && n >= 0 && n < campaigns ? n : -1;
    },
    groupAt = id => {
      const n = id - groupOf(0, 0),
        i = Math.floor(n / 100000),
        k = n % 100000;
      return n >= 0 && i < campaigns && k < groupsOf(i) ? {i, k} : undefined;
    },
    adAt = id => {
      const n = id - adOf(0, 0, 0),
        j = n % 100,
        ik = Math.floor(n / 100),
        i = Math.floor(ik / 100000),
        k = ik % 100000;
      return n >= 0 && i < campaigns && k < groupsOf(i) && j < ads ? {i, k, j} : undefined;
    };

  /** The rows a report of this kind lists for the request: how many, and the row at an index. */
  const reportOf = (entity, filters) => {
    if (entity === 'campaigns') return {count: live.length, row: n => campaignRow(live[n])};
    const i = campaignIndex(bare(filters.find(f => f.field === 'campaignId')?.value));
    if (i < 0 || idle(i)) return {count: 0, row: () => undefined};
    if (entity === 'adgroups') return {count: groupsOf(i), row: n => groupRow(i, n, deleted('adgroup', i, n))};
    return {
      count: groupsOf(i) * ads,
      row: n => adRow(i, Math.floor(n / ads), n % ads, deleted('ad', i, Math.floor(n / ads), n % ads)),
    };
  };
  const recordsOf = (entity, body) => {
    const ids = (body.filters ?? []).find(f => f.field === 'id')?.value ?? [];
    const found = ids
      .map(id =>
        entity === 'campaigns'
          ? campaignIndex(id) >= 0 && campaignRecord(campaignIndex(id))
          : entity === 'adgroups'
            ? groupAt(id) &&
              !deleted('adgroup', groupAt(id).i, groupAt(id).k) &&
              groupRecord(groupAt(id).i, groupAt(id).k)
            : adAt(id) &&
              !deleted('ad', adAt(id).i, adAt(id).k, adAt(id).j) &&
              adRecord(adAt(id).i, adAt(id).k, adAt(id).j),
      )
      .filter(Boolean)
      .sort((a, b) => a.id - b.id);
    return {count: found.length, row: n => found[n]};
  };
  const pagination = (offset, size, returned, count, withTotal) => ({
    ...(withTotal ? (total === 'count' ? {totalCount: count} : total === 'results' ? {totalResults: count} : {}) : {}),
    offset,
    pageSize: echo === 'returned' ? returned : size,
  });
  const violation = (where, ...problems) => {
    const text = where + ': ' + problems.join('; ');
    violations.push(text);
    return Response.json({error: {errors: [{messageCode: 'SYNTHETIC_DOCUMENTED_RULE', message: text}]}}, {status: 400});
  };
  const fetcher = async (raw, init) => {
    const url = new URL(String(raw)),
      method = init?.method ?? 'GET',
      body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({url, method, body});
    if (url.hostname !== 'api.ads.apple.com') throw Error('Unexpected synthetic host ' + url.hostname);
    const context = new Headers(init?.headers).get('x-ap-context');
    if (context !== 'adAccountId=' + appleAccountId + ';')
      return violation(url.pathname, 'the account header is ' + context);
    if (method === 'GET' && url.pathname === '/v1/ad-accounts/' + appleAccountId)
      return Response.json({
        result: {
          id: Number(appleAccountId),
          name: 'Synthetic Apple Ads',
          orgId: 12345,
          timezone: 'America/Los_Angeles',
          currency: 'USD',
        },
      });
    const reportMatch = /^\/v1\/reports\/apps\/(campaigns|adgroups|ads)\/query$/.exec(url.pathname),
      queryMatch = /^\/v1\/(campaigns|adgroups|ads)\/query$/.exec(url.pathname);
    if (method !== 'POST' || !body || !(reportMatch || queryMatch))
      return violation(url.pathname, 'a read the account does not answer');
    const entity = (reportMatch ?? queryMatch)[1],
      where = (reportMatch ? 'report:' : 'query:') + entity,
      problems = [],
      p = body.pagination ?? {},
      filters = body.filters ?? [];
    requests.at(-1).where = where;
    if (!Number.isInteger(p.offset) || p.offset < 0) problems.push('offset ' + p.offset);
    if (!Number.isInteger(p.pageSize) || p.pageSize < 1) problems.push('pageSize ' + p.pageSize);
    if (reportMatch) {
      if (p.pageSize > reportCeiling) problems.push('pageSize ' + p.pageSize + ' is above the report ceiling');
      if ('fetchTotalCount' in p) problems.push('fetchTotalCount belongs to the entity queries');
      const range = body.timeRange;
      if (!range || !isoDay.test(range.start) || !isoDay.test(range.end) || !['UTC', 'ORTZ'].includes(range.timeZone))
        problems.push('timeRange ' + JSON.stringify(range));
      if (range?.granularity === 'HOURLY' && entity === 'ads') problems.push('ads have no hourly granularity');
      const campaign = filters.find(f => f.field === 'campaignId');
      if (
        entity !== 'campaigns' &&
        !(campaign?.operator === 'EQUALS' && /^[1-9]\d*$/.test(String(bare(campaign.value))))
      )
        problems.push('the ' + entity + ' report requires a campaignId filter');
      for (const filter of filters)
        if (!['campaignId', 'adGroupId'].includes(filter.field) || filter.operator !== 'EQUALS')
          problems.push('filter ' + JSON.stringify(filter));
    } else {
      if (entity === 'campaigns' && p.pageSize > campaignQueryCeiling)
        problems.push('pageSize ' + p.pageSize + ' is above the campaign query cap');
      if ('fetchTotalCount' in p && typeof p.fetchTotalCount !== 'boolean') problems.push('fetchTotalCount');
      for (const filter of filters)
        if (
          filter.field !== 'id' ||
          filter.operator !== 'IN' ||
          !Array.isArray(filter.value) ||
          !filter.value.every(id => Number.isSafeInteger(id))
        )
          problems.push('filter ' + JSON.stringify(filter));
    }
    if (problems.length) return violation(where, ...problems);
    const source = reportMatch ? reportOf(entity, filters) : recordsOf(entity, body),
      size = Math.min(p.pageSize, (reportMatch ? cap.report : cap.query) ?? p.pageSize),
      n = Math.max(0, Math.min(size, source.count - p.offset)),
      rows = Array.from({length: n}, (_, index) => source.row(p.offset + index)),
      page = pagination(p.offset, p.pageSize, n, source.count, reportMatch ? true : p.fetchTotalCount === true);
    const response = reportMatch
      ? {result: {rows, summary: {grandTotal: {impressions: 0}}}, pagination: page}
      : {result: rows, pagination: page};
    const out = tamper(where, body, response);
    return out instanceof Response ? out : Response.json(out);
  };
  const transport = unpaced
    ? new NativeTransport(fetcher, undefined, undefined, undefined, 1e9)
    : new NativeTransport(fetcher);
  const service = new MirrorService(new Registry(), store, transport, undefined, undefined, fetcher),
    native = new NativeCampaignReports(service),
    overview = new ReportingOverview(service, fetcher),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (tenant, kind, input) => overview.work(tenant, kind, input),
    );
  /** A v4 source of the account at a level. */
  const source = (level = 'adset', changes = {}) => ({
    platform: 'apple',
    account_id: appleAccountId,
    connection_id: appleLogin,
    level,
    levels: [level],
    statuses: ['all'],
    delivered_only: false,
    report_options: {complete_window: true, attribution: 'unknown'},
    ...changes,
  });
  const config = (level = 'adset', {grain = 'total', range = appleRange, ...changes} = {}) => ({
    name: 'Synthetic Apple Ads report',
    sources: [source(level, changes)],
    date_range: range,
    grain,
    metrics: ['spend', 'impressions', 'clicks', 'conversions', 'reach', 'frequency', 'cpa'],
    custom_metrics: [],
    targets: {},
    objectives: [],
    contract_version: 'overview-config-v4',
  });
  const of = {
    /** The requests the account answered, by the kind of read: `report:adgroups`, `query:campaigns`, ... */
    reads: where => requests.filter(request => request.where === where),
    accountReads: () => requests.filter(request => request.method === 'GET').length,
  };
  return {
    store,
    actor,
    service,
    native,
    overview,
    worker,
    requests,
    violations,
    source,
    config,
    ...of,
    /** One collection of the source through the native collector, as the overview's worker calls it. */
    collect: (level = 'adset', changes = {}, range = appleRange) =>
      native.collect({...source(level, changes), reporting_contract: 'overview-config-v4'}, range, actor),
    /** Queues the report, works it once and reads it back. */
    async run(level = 'adset', options = {}) {
      const queued = await overview.handle({action: 'run', config: config(level, options), confirmed: true}, actor);
      assert.equal(await worker.once(), true);
      const report = await overview.handle({action: 'get', id: queued.id, limit: 500, include: {native: true}}, actor);
      return {queued, report};
    },
    close: () => store.close(),
  };
}
