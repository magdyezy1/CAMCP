import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeTransport} from '../src/transport.js';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {ReportingOverview} from '../src/reporting-overview.js';
import {ReportWorker} from '../src/worker.js';
import {reportContractVersion} from '../src/report-quality.js';
import {estimateCollectionRequests} from '../src/report-request-estimate.js';
import {NativeCampaignReports} from '../src/report-native.js';
import type {Actor, JsonObject} from '../src/types.js';

// RPT-03: daily Google and Meta sources are collected with one natively day-segmented request, the account is read
// once before and once after, and over-budget configurations are refused before any provider request.
const actor: Actor = {tenantId: 'native-daily', userId: 'owner', role: 'admin'};
const dayIndex = (date: string) => (Date.parse(date) - Date.parse('2026-08-01')) / 86400000;
const nextDay = (d: string) => new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10);
const days = (since: string, until: string) => {
  const out: string[] = [];
  for (let d = since; d <= until; d = nextDay(d)) out.push(d);
  return out;
};
/** Two campaigns; c2 delivers on even days only. Values depend on the day so a misassigned row changes totals. */
const metaRow = (date: string, id: string) => ({
  account_id: '100',
  campaign_id: id,
  campaign_name: 'Campaign ' + id,
  objective: 'OUTCOME_SALES',
  date_start: date,
  date_stop: date,
  spend: String(10 + dayIndex(date) + (id === 'c2' ? 0.25 : 0)),
  impressions: String(1000 + dayIndex(date)),
  clicks: String(20 + dayIndex(date)),
  reach: String(700 + dayIndex(date)),
  frequency: '1.4',
  actions: [{action_type: 'purchase', value: String(1 + (dayIndex(date) % 3))}],
});
const metaRows = (since: string, until: string) =>
  days(since, until).flatMap(d => [metaRow(d, 'c1'), ...(dayIndex(d) % 2 === 0 ? [metaRow(d, 'c2')] : [])]);

function fixture(
  options: {
    refuseSegmented?: boolean;
    timezoneAfterFirst?: string;
    accounts?: string[];
  } = {},
) {
  const store = new Store(':memory:', Buffer.alloc(32, 92).toString('base64'));
  store.putConnection(
    actor,
    {
      id: 'meta-daily',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: options.accounts ?? ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['ads_read'],
    },
    {accessToken: 'synthetic'},
  );
  const calls: URL[] = [];
  let lookups = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async raw => {
        const url = new URL(String(raw));
        calls.push(url);
        if (url.pathname.endsWith('/insights')) {
          const range = JSON.parse(url.searchParams.get('time_range')!);
          if (url.searchParams.get('time_increment') === '1') {
            if (options.refuseSegmented)
              return Response.json(
                {error: {message: 'Please reduce the amount of data you are asking for', code: 1}},
                {status: 400},
              );
            return Response.json({data: metaRows(range.since, range.until)});
          }
          // A per-period query: one row per delivering campaign, summed over the period, reach as Meta reports it.
          const rows = metaRows(range.since, range.until);
          const by = new Map<string, JsonObject>();
          for (const r of rows) {
            const prior = by.get(r.campaign_id);
            by.set(
              r.campaign_id,
              prior
                ? {
                    ...prior,
                    date_start: range.since,
                    date_stop: range.until,
                    spend: String(Number(prior.spend) + Number(r.spend)),
                    impressions: String(Number(prior.impressions) + Number(r.impressions)),
                    clicks: String(Number(prior.clicks) + Number(r.clicks)),
                    reach: '9999',
                    actions: [
                      {
                        action_type: 'purchase',
                        value: String(Number(prior.actions[0].value) + Number(r.actions[0]!.value)),
                      },
                    ],
                  }
                : {...r, date_start: range.since, date_stop: range.until},
            );
          }
          return Response.json({data: [...by.values()]});
        }
        lookups++;
        return Response.json({
          id: 'act_' + url.pathname.split('act_')[1],
          currency: 'USD',
          timezone_name: lookups > 1 && options.timezoneAfterFirst ? options.timezoneAfterFirst : 'UTC',
        });
      },
      async () => {},
    ),
  );
  const overview = new ReportingOverview(service);
  const worker = new ReportWorker(
    store,
    async () => ({}),
    (t, k, i) => overview.work(t, k, i),
  );
  const config = (grain: string, since = '2026-08-01', until = '2026-08-31') => ({
    name: 'Daily Meta',
    sources: [{platform: 'meta', account_id: '100', connection_id: 'meta-daily'}],
    date_range: {since, until},
    metrics: ['spend', 'impressions', 'clicks', 'reach', 'conversions'],
    custom_metrics: [],
    grain,
  });
  const run = async (cfg: JsonObject, edit?: (record: JsonObject) => JsonObject) => {
    const queued = await overview.handle({action: 'run', config: cfg, confirmed: true}, actor);
    if (edit)
      store.putDocument(
        actor.tenantId,
        'overview_report',
        queued.id,
        edit(store.document(actor.tenantId, 'overview_report', queued.id)),
      );
    const before = calls.length;
    await worker.once();
    return {
      queued,
      report: await overview.handle({action: 'get', id: queued.id, limit: 500}, actor),
      requests: calls.slice(before),
    };
  };
  return {store, overview, calls, config, run};
}
const additive = (report: JsonObject) =>
  Object.fromEntries(
    report.rows
      .map((r: JsonObject) => [
        r.campaign_id + ':' + r.date_from,
        {
          spend: r.metrics.spend,
          impressions: r.metrics.impressions,
          clicks: r.metrics.clicks,
          conversions: r.metrics.conversions,
          reach: r.metrics.reach,
        },
      ])
      .sort(([a]: string[], [b]: string[]) => (a! < b! ? -1 : 1)),
  );

test('RPT-03: a 31-day daily Meta source uses at most 3 requests with the per-day additive results', async () => {
  const f = fixture();
  try {
    const segmented = await f.run(f.config('daily'));
    assert.equal(segmented.queued.estimated_requests, 3);
    assert.equal(segmented.report.state, 'complete');
    assert.ok(segmented.requests.length <= 3, 'requests: ' + segmented.requests.length);
    assert.equal(segmented.requests.filter(u => u.pathname.endsWith('/insights')).length, 1);
    assert.equal(segmented.report.collection_budget.requests, segmented.requests.length);
    assert.equal(segmented.report.config.source_contract_version, reportContractVersion);
    assert.equal(segmented.report.sources[0].collection_mode, 'native_daily');
    assert.equal(segmented.report.sources[0].periods.length, 31);
    assert.ok(segmented.report.sources[0].lineage.some((l: JsonObject) => l.stage === 'account_verify'));
    // A v3 snapshot resumes on the per-period path: one query per day, with the account read once and verified once.
    const legacy = await f.run(f.config('daily'), r => ({
      ...r,
      config: {...r.config, source_contract_version: 'campaign-source-v3'},
    }));
    assert.equal(legacy.requests.filter(u => u.pathname.endsWith('/insights')).length, 31);
    assert.equal(legacy.requests.length, 33, 'one cached account read before and one after, not one per day');
    assert.equal(legacy.report.sources[0].collection_mode, undefined);
    assert.deepEqual(additive(segmented.report), additive(legacy.report));
    assert.equal(segmented.report.rows.length, 31 + 16);
  } finally {
    f.store.close();
  }
});

test('RPT-03: weekly grain keeps per-period queries, so reach is never summed from days', async () => {
  const f = fixture();
  try {
    const weekly = await f.run(f.config('weekly'));
    const insights = weekly.requests.filter(u => u.pathname.endsWith('/insights'));
    assert.equal(insights.length, 6, 'August 2026 spans six calendar weeks (Saturday the 1st to Monday the 31st)');
    assert.ok(insights.every(u => !u.searchParams.has('time_increment')));
    // The stub reports 9999 as the provider's own deduplicated reach for a multi-day period of c1.
    const weeks = weekly.report.rows.filter((r: JsonObject) => r.campaign_id === 'c1' && r.date_from !== r.date_to);
    assert.equal(weeks.length, 5);
    assert.ok(weeks.every((r: JsonObject) => r.metrics.reach === 9999));
  } finally {
    f.store.close();
  }
});

test('RPT-03: a provider that refuses the day-segmented request falls back to per-day queries', async () => {
  const f = fixture({refuseSegmented: true});
  try {
    const out = await f.run(f.config('daily', '2026-08-01', '2026-08-03'));
    assert.equal(out.report.state, 'complete');
    assert.equal(out.report.rows.length, 3 + 2);
    assert.match(out.report.sources[0].warnings.join(' '), /refused one day-segmented request/);
    assert.equal(out.requests.filter(u => u.pathname.endsWith('/insights')).length, 1 + 3);
  } finally {
    f.store.close();
  }
});

test('RPT-03: an account time zone that changes during collection fails the source instead of mixing days', async () => {
  const f = fixture({timezoneAfterFirst: 'Asia/Riyadh'});
  try {
    const out = await f.run(f.config('daily', '2026-08-01', '2026-08-03'));
    assert.equal(out.report.state, 'failed');
    assert.equal(out.report.sources[0].error.code, 'REPORT_ACCOUNT_CHANGED');
  } finally {
    f.store.close();
  }
});

test('RPT-03: an over-budget configuration is refused before any provider request', async () => {
  const accounts = Array.from({length: 30}, (_, i) => String(100 + i));
  const f = fixture({accounts});
  try {
    const cfg = {
      ...f.config('weekly', '2025-10-01', '2026-09-30'),
      sources: accounts.map(account_id => ({platform: 'meta', account_id, connection_id: 'meta-daily'})),
    };
    const estimate = estimateCollectionRequests({...cfg, source_contract_version: reportContractVersion});
    assert.ok(estimate.estimated_requests > estimate.limit);
    await assert.rejects(
      f.overview.handle({action: 'run', config: cfg, confirmed: true}, actor),
      (e: JsonObject) => e.code === 'REPORT_COLLECTION_LIMIT' && e.details.estimate.estimated_requests > 1200,
    );
    assert.equal(f.calls.length, 0);
    assert.equal((await f.overview.handle({action: 'list'}, actor)).reports.length, 0);
    // The same accounts at daily grain fit: each source needs three requests.
    const daily = estimateCollectionRequests({
      ...cfg,
      grain: 'daily',
      source_contract_version: reportContractVersion,
    });
    assert.equal(daily.estimated_requests, 90);
    const bootstrap = await f.overview.handle({action: 'bootstrap'}, actor);
    assert.equal(
      bootstrap.platforms.find((p: JsonObject) => p.id === 'meta').request_model.native_daily_segmentation,
      true,
    );
  } finally {
    f.store.close();
  }
});

test('RPT-03: Google days come from one segments.date query and a row outside the requested days is refused', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 93).toString('base64'));
  try {
    store.putConnection(
      actor,
      {
        id: 'google-daily',
        tenantId: actor.tenantId,
        gateway: 'google_ads_native_action',
        accounts: ['1234567890'],
        enabled: true,
        label: 'Synthetic',
        scopes: [],
      },
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
    let outside = false;
    const queries: string[] = [];
    const service = {
      store,
      runPlan: async (p: JsonObject) => {
        const query = String(p.body?.query ?? '');
        queries.push(query);
        if (query.includes('FROM customer'))
          return {success: true, data: {results: [{customer: {currencyCode: 'EUR', timeZone: 'Europe/Berlin'}}]}};
        return {
          success: true,
          data: {
            results: ['2026-08-01', '2026-08-02', ...(outside ? ['2026-08-09'] : [])].map(date => ({
              campaign: {id: '77', name: 'Search'},
              customer: {currencyCode: 'EUR'},
              segments: {date},
              metrics: {costMicros: '1500000', impressions: '10', clicks: '2', conversions: 1, conversionsValue: 3},
            })),
          },
        };
      },
    };
    const native = new NativeCampaignReports(service as never);
    const source = {platform: 'google', account_id: '1234567890', connection_id: 'google-daily'};
    const days = await native.collectDaily(source, {since: '2026-08-01', until: '2026-08-03'}, actor);
    assert.deepEqual(
      days.map(d => [d.date_range.since, d.rows.length]),
      [
        ['2026-08-01', 1],
        ['2026-08-02', 1],
        ['2026-08-03', 0],
      ],
    );
    assert.equal(days[0]!.rows[0].metrics.spend, 1.5);
    assert.match(queries.at(-1)!, /segments\.date/);
    outside = true;
    await assert.rejects(
      native.collectDaily(source, {since: '2026-08-01', until: '2026-08-03'}, actor),
      (e: JsonObject) => e.code === 'REPORT_DATE_MISMATCH',
    );
    await assert.rejects(
      native.collectDaily({...source, platform: 'tiktok'}, {since: '2026-08-01', until: '2026-08-03'}, actor),
      (e: JsonObject) => e.code === 'INVALID_REPORT_SOURCE',
    );
  } finally {
    store.close();
  }
});
