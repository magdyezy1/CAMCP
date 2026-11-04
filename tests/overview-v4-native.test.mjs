import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';

// Synthetic native transport, not a collector stub: exact request scopes, page metadata, hierarchy, result goals
// and two account-local days exercise the same queue and provider boundary as production. No external requests.
function fixture(t) {
  const actor = {tenantId: 'synthetic-v4-native', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 127).toString('base64')),
    connection = 'aaaaaaaa-1111-4111-8111-000000000003',
    account = '100',
    campaign = {
      advertiser_id: account,
      campaign_id: '101',
      campaign_name: 'Synthetic campaign',
      objective_type: 'WEB_CONVERSIONS',
    },
    groups = Array.from({length: 5}, (_, index) => ({
      advertiser_id: account,
      campaign_id: '101',
      adgroup_id: String(200 + index),
      adgroup_name: 'Synthetic group ' + index,
      optimization_goal: 'CONVERT',
      optimization_event: 'COMPLETE_PAYMENT',
    })),
    ads = groups.flatMap((group, index) =>
      Array.from({length: 8}, (_, ad) => ({
        advertiser_id: account,
        campaign_id: '101',
        adgroup_id: group.adgroup_id,
        ad_id: String(1000 + index * 8 + ad),
        ad_name: 'Synthetic ad ' + (index * 8 + ad),
      })),
    ),
    requests = [],
    inventory = {campaign: [campaign], adgroup: groups, ad: ads};
  t.after(() => store.close());
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
  const metrics = units => ({
    spend: String(units / 8),
    impressions: String(units * 10),
    clicks: String(units * 2),
    conversion: String(units),
    result: String(units),
    cost_per_result: '0.125',
    result_rate: '50',
  });
  const fetcher = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'business-api.tiktok.com');
    assert.equal(init?.method ?? 'GET', 'GET');
    requests.push(url);
    if (url.pathname.endsWith('/advertiser/info/'))
      return Response.json({
        code: 0,
        data: {list: [{advertiser_id: account, name: 'Synthetic account', currency: 'USD', timezone: 'UTC'}]},
      });
    assert.equal(url.searchParams.get('advertiser_id'), account);
    const entity = /\/(campaign|adgroup|ad)\/get\/$/.exec(url.pathname)?.[1];
    let list;
    if (entity) {
      const filter = JSON.parse(url.searchParams.get('filtering') ?? '{}'),
        ids = filter[entity + '_ids'];
      list = inventory[entity].filter(row => !ids || ids.includes(row[entity + '_id']));
    } else {
      assert.ok(url.pathname.endsWith('/report/integrated/get/'));
      const dimensions = JSON.parse(url.searchParams.get('dimensions')),
        nativeLevel = {AUCTION_CAMPAIGN: 'campaign', AUCTION_ADGROUP: 'adgroup', AUCTION_AD: 'ad'}[
          url.searchParams.get('data_level')
        ],
        since = url.searchParams.get('start_date'),
        until = url.searchParams.get('end_date'),
        days = ['2026-09-01', '2026-09-02'].filter(day => day >= since && day <= until),
        segmented = dimensions.includes('stat_time_day');
      assert.ok(nativeLevel);
      list = inventory[nativeLevel].flatMap(row =>
        (segmented ? days : [null]).map(day => {
          const count = nativeLevel === 'campaign' ? ads.length : nativeLevel === 'adgroup' ? 8 : 1;
          return {
            dimensions: {[nativeLevel + '_id']: row[nativeLevel + '_id'], ...(day ? {stat_time_day: day} : {})},
            metrics: {...metrics(count * (day ? 1 : days.length)), [nativeLevel + '_name']: row[nativeLevel + '_name']},
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
      date_range: {since: '2026-09-01', until: '2026-09-02'},
      metrics: ['spend', 'impressions', 'clicks', 'conversions'],
    };
  return {
    store,
    actor,
    overview,
    requests,
    config,
    source,
    async run(changes) {
      const queued = await overview.handle({action: 'run', config: {...config, ...changes}, confirmed: true}, actor);
      await worker.once();
      const snapshot = await overview.handle({action: 'get', id: queued.id, limit: 500}, actor);
      assert.equal(snapshot.state, 'complete', JSON.stringify(snapshot.sources));
      return snapshot;
    },
  };
}

test('real three-level TikTok collection reconciles native totals and returns under one third of legacy response bytes', async t => {
  const f = fixture(t),
    legacy = [];
  for (const level of ['campaign', 'adset', 'ad']) {
    const {report_options, ...base} = f.source;
    legacy.push(await f.run({sources: [{...base, level, ...(level === 'campaign' ? {} : {report_options})}]}));
  }
  f.requests.length = 0;
  const current = await f.run({
      contract_version: 'overview-config-v4',
      sources: [{...f.source, levels: ['campaign', 'adset', 'ad']}],
    }),
    stored = f.store.document(f.actor.tenantId, 'overview_report', current.id),
    bytesBefore = Buffer.byteLength(JSON.stringify(legacy)),
    bytesAfter = Buffer.byteLength(JSON.stringify(current));
  assert.equal(current.rows.length, 46);
  assert.deepEqual(
    current.sources[0].level_results.map(level => level.level),
    ['campaign', 'adset', 'ad'],
  );
  assert.equal(current.sources[0].cross_level.length, 6);
  assert.ok(
    current.sources[0].cross_level.every(value => value.state === 'agree'),
    JSON.stringify(current.sources[0].cross_level),
  );
  assert.equal(current.rows.find(row => row.level === 'campaign').result.value, '80');
  assert.equal(
    current.rows.filter(row => row.level === 'ad').every(row => row.result.value === '2'),
    true,
  );
  assert.equal(
    stored.rows.some(row => Object.hasOwn(row, 'lineage')),
    false,
  );
  assert.equal(JSON.stringify(current).includes('"lineage"'), false);
  assert.ok(
    stored.sources[0].lineage.length > 10,
    'real source reads supply the lineage, not manufactured repeated entries',
  );
  assert.ok(bytesAfter < bytesBefore / 3, JSON.stringify({bytesBefore, bytesAfter, ratio: bytesAfter / bytesBefore}));
  assert.equal(
    stored.sources[0].lineage.filter(entry => entry.stage === 'account_lookup').length,
    1,
    'one shared account lookup across native levels',
  );
  assert.equal(
    f.requests.filter(url => url.pathname.endsWith('/advertiser/info/')).length,
    5,
    'each qualified detailed read retains its before/after account verification fence',
  );
  assert.deepEqual(Object.keys(current.rows[0].metrics), f.config.metrics);
  for (const row of current.rows)
    assert.equal(current.sources[0].result_definitions[row.result_context.result_ref].id, row.result.definition_id);
  const requestCount = f.requests.length;
  const included = await f.overview.handle(
    {action: 'get', id: current.id, limit: 500, include: {native: true, lineage: true}},
    f.actor,
  );
  assert.equal(included.rows[0].metrics.cpa, '0.125', 'explicit native inclusion retains the full normalized metrics');
  assert.equal(included.rows[0].recommendation.evidence !== undefined, true);
  assert.equal(included.sources[0].lineage.length, 16);
  assert.equal(
    included.rows.some(row => Object.hasOwn(row, 'lineage')),
    false,
    'even explicit lineage is stored and returned once',
  );
  assert.equal(f.requests.length, requestCount, 'both compact and full evidence projections use retained data only');
  console.log(
    'V4_NATIVE_TIKTOK_BYTES ' +
      JSON.stringify({
        rows: 46,
        bytesBefore,
        bytesAfter,
        ratio: bytesAfter / bytesBefore,
        before: 'three legacy single-level get responses',
        after: 'one v4 multi-level get response',
        sourceReads: stored.sources[0].lineage.length,
      }),
  );
});
