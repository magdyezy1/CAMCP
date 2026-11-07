import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {ReportingOverview} from '../../dist/src/reporting-overview.js';
import {ReportWorker} from '../../dist/src/worker.js';

/**
 * A synthetic TikTok Business API provider behind the real queue, worker and collectors: one advertiser with campaigns,
 * ad groups and ads (campaign, ad group and ad inventory reads, and BASIC integrated reports at the three data levels),
 * answering in the documented shapes. `state.hook(url)` may return a Response (or a promise of one) to replace an answer.
 * No network is used: the transport's fetcher is this provider.
 */
export function tiktokThreeLevelFixture({
  campaigns = 1,
  groupsPerCampaign = 5,
  adsPerGroup = 8,
  days = ['2026-09-01', '2026-09-02'],
  goal = 'CONVERT',
  eventFor = () => 'COMPLETE_PAYMENT',
} = {}) {
  const actor = {tenantId: 'synthetic-tiktok-levels', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 127).toString('base64')),
    connection = 'aaaaaaaa-1111-4111-8111-000000000003',
    account = '100';
  const campaignRows = Array.from({length: campaigns}, (_, c) => ({
    advertiser_id: account,
    campaign_id: String(101 + c),
    campaign_name: 'Synthetic campaign ' + c,
    objective_type: 'WEB_CONVERSIONS',
    operation_status: 'ENABLE',
  }));
  const groupRows = campaignRows.flatMap((campaign, c) =>
    Array.from({length: groupsPerCampaign}, (_, g) => ({
      advertiser_id: account,
      campaign_id: campaign.campaign_id,
      adgroup_id: String(2000 + c * groupsPerCampaign + g),
      adgroup_name: 'Synthetic group ' + c + '.' + g,
      optimization_goal: goal,
      optimization_event: eventFor(c, g),
      operation_status: 'ENABLE',
    })),
  );
  const adRows = groupRows.flatMap((group, index) =>
    Array.from({length: adsPerGroup}, (_, a) => ({
      advertiser_id: account,
      campaign_id: group.campaign_id,
      adgroup_id: group.adgroup_id,
      ad_id: String(100000 + index * adsPerGroup + a),
      ad_name: 'Synthetic ad ' + index + '.' + a,
      operation_status: 'ENABLE',
    })),
  );
  const inventory = {campaign: campaignRows, adgroup: groupRows, ad: adRows};
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
  // One ad's day is one unit: spend 1/8, 10 impressions, 2 clicks, 1 conversion and result.
  const metricsOf = units => ({
    spend: String(units / 8),
    impressions: String(units * 10),
    clicks: String(units * 2),
    conversion: String(units),
    result: String(units),
    cost_per_result: '0.125',
    result_rate: '50',
  });
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
        data: {list: [{advertiser_id: account, name: 'Synthetic account', currency: 'USD', timezone: 'UTC'}]},
      });
    const entity = /\/(campaign|adgroup|ad)\/get\/$/.exec(url.pathname)?.[1];
    let list;
    if (entity) {
      const filter = JSON.parse(url.searchParams.get('filtering') ?? '{}'),
        ids = filter[entity + '_ids'];
      list = inventory[entity].filter(row => !ids || ids.includes(row[entity + '_id']));
    } else {
      const dimensions = JSON.parse(url.searchParams.get('dimensions')),
        level = {AUCTION_CAMPAIGN: 'campaign', AUCTION_ADGROUP: 'adgroup', AUCTION_AD: 'ad'}[
          url.searchParams.get('data_level')
        ],
        since = url.searchParams.get('start_date'),
        until = url.searchParams.get('end_date'),
        inRange = days.filter(day => day >= since && day <= until),
        daily = dimensions.includes('stat_time_day');
      assert.ok(level);
      list = inventory[level].flatMap(row =>
        (daily ? inRange : [null]).map(day => {
          const units = level === 'campaign' ? groupsPerCampaign * adsPerGroup : level === 'adgroup' ? adsPerGroup : 1;
          return {
            dimensions: {[level + '_id']: row[level + '_id'], ...(day ? {stat_time_day: day} : {})},
            metrics: {...metricsOf(units * (day ? 1 : inRange.length)), [level + '_name']: row[level + '_name']},
          };
        }),
      );
    }
    const page = Number(url.searchParams.get('page') ?? 1),
      pageSize = Number(url.searchParams.get('page_size') ?? 1000),
      data = {
        list: list.slice((page - 1) * pageSize, page * pageSize),
        page_info: {
          page,
          page_size: pageSize,
          total_number: list.length,
          total_page: Math.ceil(list.length / pageSize),
        },
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
    ),
    source = {
      platform: 'tiktok',
      account_id: account,
      connection_id: connection,
      report_options: {complete_window: true, attribution: 'unknown'},
    },
    config = {
      name: 'Synthetic three-level TikTok report',
      contract_version: 'overview-config-v4',
      sources: [{...source, levels: ['campaign', 'adset', 'ad']}],
      date_range: {since: days[0], until: days.at(-1)},
      metrics: ['spend', 'impressions', 'clicks', 'conversions', 'primary_result', 'cost_per_result'],
    };
  return {
    store,
    actor,
    state,
    config,
    queue: (changes = {}) => overview.handle({action: 'run', config: {...config, ...changes}, confirmed: true}, actor),
    get: id => overview.handle({action: 'get', id, limit: 500}, actor),
    /** Runs the worker once; a job it left queued for a retry becomes due again, as when its delay has passed. */
    async turn() {
      store.db.prepare("UPDATE jobs SET available_at=0 WHERE state='queued'").run();
      return worker.once();
    },
    jobs: () => store.db.prepare('SELECT id,state,attempts,error FROM jobs').all(),
    close: () => store.close(),
  };
}
/** The level (campaign, adset, ad) a TikTok integrated report request asks for. */
export const tiktokLevelOf = url =>
  ({AUCTION_CAMPAIGN: 'campaign', AUCTION_ADGROUP: 'adset', AUCTION_AD: 'ad'})[url.searchParams.get('data_level')];
/** A TikTok answer that carries a return code inside HTTP 200, as TikTok does for refusals and throttles. */
export const tiktokBodyCode = (code, message = 'Synthetic TikTok refusal') =>
  Response.json({code, message, request_id: 'synthetic-refusal', data: {}}, {status: 200});
