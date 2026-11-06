import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {ReportingOverview} from '../../dist/src/reporting-overview.js';
import {ReportWorker} from '../../dist/src/worker.js';

/**
 * A synthetic TikTok business API behind the real queue, worker and collectors: campaigns, ad groups and ads in the
 * documented list and report shapes, no external request. `eventFor(campaign, group)` names the optimization event of an
 * ad group, `metricsFor(units, {level, id, day})` the report metrics of an entity with that many ad units under it, and
 * `state.hook(url)` may return a Response (or a promise of one) to replace the answer to one request.
 */
export function tiktokNativeFixture(
  t,
  {
    campaigns = 1,
    groupsPerCampaign = 5,
    adsPerGroup = 8,
    days = ['2026-09-01', '2026-09-02'],
    status = 'ENABLE',
    currency = 'USD',
    timezone = 'UTC',
    goal = 'CONVERT',
    metricsFor,
    eventFor,
  } = {},
) {
  const actor = {tenantId: 'synthetic-engine-core', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 127).toString('base64')),
    connection = 'aaaaaaaa-1111-4111-8111-000000000003',
    account = '100';
  t.after(() => store.close());
  const campaignRows = Array.from({length: campaigns}, (_, c) => ({
      advertiser_id: account,
      campaign_id: String(101 + c),
      campaign_name: 'Synthetic campaign ' + c,
      objective_type: 'WEB_CONVERSIONS',
      operation_status: status,
    })),
    groups = campaignRows.flatMap((campaign, c) =>
      Array.from({length: groupsPerCampaign}, (_, g) => ({
        advertiser_id: account,
        campaign_id: campaign.campaign_id,
        adgroup_id: String(2000 + c * groupsPerCampaign + g),
        adgroup_name: 'Synthetic group ' + c + '.' + g,
        optimization_goal: goal,
        optimization_event: eventFor ? eventFor(c, g) : 'COMPLETE_PAYMENT',
        operation_status: status,
      })),
    ),
    ads = groups.flatMap((group, index) =>
      Array.from({length: adsPerGroup}, (_, a) => ({
        advertiser_id: account,
        campaign_id: group.campaign_id,
        adgroup_id: group.adgroup_id,
        ad_id: String(100000 + index * adsPerGroup + a),
        ad_name: 'Synthetic ad ' + index + '.' + a,
        operation_status: status,
      })),
    ),
    inventory = {campaign: campaignRows, adgroup: groups, ad: ads};
  store.putConnection(
    actor,
    {
      id: connection,
      tenantId: actor.tenantId,
      gateway: 'tiktok_native_action',
      accounts: [account],
      enabled: true,
      scopes: ['advertiser.read', 'report.read'],
      label: 'Synthetic',
    },
    {accessToken: 'synthetic'},
  );
  const metrics =
    metricsFor ??
    (units => ({
      spend: String(units / 8),
      impressions: String(units * 10),
      clicks: String(units * 2),
      conversion: String(units),
      result: String(units),
      cost_per_result: '0.125',
      result_rate: '50',
    }));
  const state = {hook: () => undefined, requests: []};
  const fetcher = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'business-api.tiktok.com');
    assert.equal(init?.method ?? 'GET', 'GET');
    state.requests.push(url);
    const hooked = await state.hook(url);
    if (hooked instanceof Response) return hooked;
    if (url.pathname.endsWith('/advertiser/info/'))
      return Response.json({
        code: 0,
        data: {list: [{advertiser_id: account, name: 'Synthetic account', currency, timezone}]},
      });
    const entity = /\/(campaign|adgroup|ad)\/get\/$/.exec(url.pathname)?.[1];
    let list;
    if (entity) {
      const filter = JSON.parse(url.searchParams.get('filtering') ?? '{}'),
        ids = filter[entity + '_ids'];
      list = inventory[entity].filter(row => !ids || ids.includes(row[entity + '_id']));
    } else {
      const dimensions = JSON.parse(url.searchParams.get('dimensions')),
        nativeLevel = {AUCTION_CAMPAIGN: 'campaign', AUCTION_ADGROUP: 'adgroup', AUCTION_AD: 'ad'}[
          url.searchParams.get('data_level')
        ],
        since = url.searchParams.get('start_date'),
        until = url.searchParams.get('end_date'),
        inRange = days.filter(day => day >= since && day <= until),
        segmented = dimensions.includes('stat_time_day');
      assert.ok(nativeLevel);
      list = inventory[nativeLevel].flatMap(row =>
        (segmented ? inRange : [null]).map(day => {
          const count =
            nativeLevel === 'campaign' ? groupsPerCampaign * adsPerGroup : nativeLevel === 'adgroup' ? adsPerGroup : 1;
          return {
            dimensions: {[nativeLevel + '_id']: row[nativeLevel + '_id'], ...(day ? {stat_time_day: day} : {})},
            metrics: {
              ...metrics(count * (day ? 1 : inRange.length), {level: nativeLevel, id: row[nativeLevel + '_id'], day}),
              [nativeLevel + '_name']: row[nativeLevel + '_name'],
            },
          };
        }),
      );
    }
    const page = Number(url.searchParams.get('page') ?? 1),
      pageSize = Number(url.searchParams.get('page_size') ?? 1000);
    const data = {
      list: list.slice((page - 1) * pageSize, page * pageSize),
      page_info: {page, page_size: pageSize, total_number: list.length, total_page: Math.ceil(list.length / pageSize)},
    };
    if (!entity)
      data.total_metrics = Object.fromEntries(
        ['spend', 'impressions', 'clicks', 'conversion'].map(key => [
          key,
          String(list.reduce((sum, row) => sum + Number(row.metrics[key]), 0)),
        ]),
      );
    return Response.json({code: 0, message: 'OK', request_id: 'synthetic-native-report', data});
  };
  const service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(fetcher, async () => {}),
      undefined,
      undefined,
      fetcher,
    ),
    overview = new ReportingOverview(service, fetcher),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (tenant, kind, input) => overview.work(tenant, kind, input),
    );
  const source = {
      platform: 'tiktok',
      account_id: account,
      connection_id: connection,
      report_options: {complete_window: true, attribution: 'unknown'},
    },
    config = {
      name: 'Synthetic native three-level report',
      sources: [source],
      date_range: {since: days[0], until: days.at(-1)},
      metrics: ['spend', 'impressions', 'clicks', 'conversions'],
    };
  return {
    store,
    actor,
    overview,
    worker,
    state,
    requests: state.requests,
    config,
    source,
    inventory,
    /** The v4 definition of this fixture's source at three levels. */
    v4(changes = {}, sourceChanges = {}) {
      return {
        ...config,
        contract_version: 'overview-config-v4',
        sources: [{...source, levels: ['campaign', 'adset', 'ad'], ...sourceChanges}],
        ...changes,
      };
    },
    queue(changes = {}) {
      return overview.handle({action: 'run', config: {...config, ...changes}, confirmed: true}, actor);
    },
    get(id, more = {}) {
      return overview.handle({action: 'get', id, limit: 500, ...more}, actor);
    },
    stored: id => store.document(actor.tenantId, 'overview_report', id),
    /** Makes every queued job runnable now (a retry waits for its back-off otherwise). */
    requeue() {
      store.db.prepare("UPDATE jobs SET available_at=0 WHERE state='queued'").run();
    },
    job(id) {
      return store.db.prepare('SELECT state,attempts,error,lease_expiries FROM jobs WHERE id=?').get(id);
    },
  };
}
