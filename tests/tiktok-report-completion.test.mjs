import test from 'node:test';
import assert from 'node:assert/strict';
import {paginate, nextPage} from '../dist/src/pagination.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';

const plan = {
  gateway: 'tiktok_native_action',
  action: 'tiktok_report_integrated_get',
  method: 'GET',
  path: '/v1.3/report/integrated/get/',
  query: {
    advertiser_id: '100',
    report_type: 'BASIC',
    data_level: 'AUCTION_CAMPAIGN',
    dimensions: ['campaign_id'],
    metrics: ['spend'],
    page: 1,
    page_size: 2,
  },
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  accountId: '100',
  evidence: 'SYNTHETIC',
  warnings: [],
};
const row = id => ({dimensions: {campaign_id: String(id)}, metrics: {spend: '1', clicks: '2'}});
const response = (list, page = 1, size = 2, total = list.length) => ({
  code: 0,
  data: {list, page_info: {page, page_size: size, total_number: total, total_page: Math.ceil(total / size)}},
});

test('TikTok integrated pagination requires explicit consistent native completion metadata', async () => {
  for (const mutate of [
    d => {
      delete d.data.page_info;
    },
    d => {
      delete d.data.list;
    },
    d => {
      d.data.page_info.page = 2;
    },
    d => {
      d.data.page_info.page_size = 1;
    },
    d => {
      d.data.page_info.total_number = '1';
    },
    d => {
      d.data.page_info.total_number = 3;
    },
    d => {
      d.data.page_info.total_page = 5;
    },
    d => {
      d.data.has_more = true;
    },
    d => {
      d.hasMore = false;
    },
    d => {
      d.data.paging = {};
    },
    d => {
      d.truncated = true;
    },
    d => {
      d.data.next_page_token = 'https://example.invalid';
    },
  ]) {
    const data = response([row(1)]);
    mutate(data);
    await assert.rejects(
      paginate(plan, async () => data),
      {code: 'REPORT_INCOMPLETE'},
    );
  }
  assert.throws(() => nextPage(plan, {code: 0, data: {list: []}}), {code: 'REPORT_INCOMPLETE'});
});
test('TikTok integrated aggregation refuses changing totals and duplicate native dimension tuples', async () => {
  for (const tail of [response([row(3), row(4)], 2, 2, 4), response([row(1)], 2, 2, 3)]) {
    await assert.rejects(
      paginate(plan, async p => (p.query.page === 1 ? response([row(1), row(2)], 1, 2, 3) : tail)),
      e => ['REPORT_INCOMPLETE', 'REPORT_DUPLICATE_ROWS'].includes(e.code),
    );
  }
  await assert.rejects(
    paginate(plan, async () => response([row(1), row(1)])),
    {code: 'REPORT_DUPLICATE_ROWS'},
  );
});
test('TikTok integrated aggregation validates the requested dimensional grain instead of counting arbitrary rows', async () => {
  for (const item of [
    null,
    {},
    {dimensions: null},
    {dimensions: {}},
    {dimensions: {campaign_id: '1'}, metrics: null},
    {dimensions: {ad_id: '1'}, metrics: {}},
    {dimensions: {campaign_id: '1', country: 'SA'}, metrics: {}},
    {dimensions: {campaign_id: {}}, metrics: {}},
    {dimensions: {campaign_id: Number.MAX_SAFE_INTEGER + 1}, metrics: {}},
  ])
    await assert.rejects(
      paginate(plan, async () => response([item])),
      {code: 'REPORT_SHAPE_CHANGED'},
    );
  const daily = {...plan, query: {...plan.query, dimensions: ['campaign_id', 'stat_time_day']}},
    dailyRows = ['2026-09-01', '2026-09-02', '2026-09-03'].map(date => ({
      ...row(1),
      dimensions: {campaign_id: '1', stat_time_day: date},
    }));
  const out = await paginate(daily, async p =>
    response(dailyRows.slice((p.query.page - 1) * 2, p.query.page * 2), p.query.page, 2, 3),
  );
  assert.equal(out.truncated, false);
  assert.equal(out.data.data.list.length, 3);
});
test('TikTok integrated aggregation starts at page one and preserves request filters and honest page limits', async () => {
  let reads = 0;
  await assert.rejects(
    paginate({...plan, query: {...plan.query, page: 2}}, async () => {
      reads++;
      return response([row(3)], 2, 2, 3);
    }),
    {code: 'REPORT_INCOMPLETE'},
  );
  assert.equal(reads, 0);
  const queried = [],
    first = response([row(1), row(2)], 1, 2, 3),
    tail = response([row(3)], 2, 2, 3),
    scoped = {
      ...plan,
      query: {
        ...plan.query,
        filtering: [{field_name: 'campaign_ids', filter_type: 'IN', filter_value: '["1","2","3"]'}],
      },
    };
  const out = await paginate(scoped, async p => {
    queried.push(p.query);
    return p.query.page === 1 ? first : tail;
  });
  assert.equal(out.pages, 2);
  assert.equal(out.truncated, false);
  assert.deepEqual(queried[1], {...scoped.query, page: 2});
  assert.deepEqual(
    out.data.data.page_info,
    first.data.page_info,
    'original native first-page metadata is not forged into an aggregate page',
  );
  assert.equal((await paginate(scoped, async () => first, 1)).truncated, true);
});
test('TikTok integrated empty reports need zero native counts and inventory pagination retains its independent contract', async () => {
  await assert.rejects(
    paginate(plan, async () => ({code: 0, data: {list: []}})),
    {code: 'REPORT_INCOMPLETE'},
  );
  for (const pages of [0, 1]) {
    const empty = response([]);
    empty.data.page_info.total_page = pages;
    const out = await paginate(plan, async () => empty);
    assert.equal(out.truncated, false);
    assert.deepEqual(out.data.data.list, []);
  }
  const inventory = {...plan, path: '/v1.3/campaign/get/'};
  assert.equal((await paginate(inventory, async () => ({code: 0, data: {list: []}}))).truncated, false);
});

function fixture(t, reportResponse) {
  const actor = {tenantId: 'tiktok-overview-completion', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 106).toString('base64'));
  t.after(() => store.close());
  const source = {platform: 'tiktok', account_id: '100', connection_id: 'ffffffff-1111-4111-8111-111111111114'};
  store.putConnection(
    actor,
    {
      id: source.connection_id,
      tenantId: actor.tenantId,
      gateway: 'tiktok_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const calls = [],
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(
        async (raw, init) => {
          const url = new URL(raw);
          calls.push({url, method: init.method});
          assert.equal(init.method, 'GET');
          if (url.pathname.endsWith('/advertiser/info/'))
            return Response.json({
              code: 0,
              data: {list: [{advertiser_id: '100', name: 'Synthetic', currency: 'USD', timezone: 'Etc/GMT'}]},
            });
          if (url.pathname.endsWith('/report/integrated/get/')) return Response.json(reportResponse(url));
          if (url.pathname.endsWith('/campaign/get/'))
            return Response.json({code: 0, data: {list: [{campaign_id: '1', objective_type: 'TRAFFIC'}]}});
          // RPT-04: campaign reports also read ad group optimization events.
          if (url.pathname.endsWith('/adgroup/get/'))
            return Response.json({
              code: 0,
              data: {list: [{adgroup_id: '11', campaign_id: '1', optimization_goal: 'CLICK'}]},
            });
          throw Error('Unexpected route');
        },
        async () => {},
      ),
    ),
    overview = new ReportingOverview(service),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (tenant, key, input) => overview.work(tenant, key, input),
    );
  const run = async () => {
    const queued = await overview.handle(
      {
        action: 'run',
        confirmed: true,
        config: {
          name: 'Synthetic TikTok',
          sources: [source],
          date_range: {since: '2026-09-01', until: '2026-09-02'},
          metrics: ['spend', 'clicks'],
          custom_metrics: [],
        },
      },
      actor,
    );
    await worker.once();
    return overview.handle({action: 'get', id: queued.id}, actor);
  };
  return {actor, store, service, overview, calls, run};
}
test('TikTok Overview keeps malformed native completion as a failed source instead of retaining successful metrics', async t => {
  for (const data of [{code: 0, data: {list: [row(1)]}}, response([row(1)], 1, 1000, 2)]) {
    const f = fixture(t, () => data),
      report = await f.run();
    assert.equal(report.state, 'failed', JSON.stringify(report));
    assert.equal(report.row_count, 0);
    assert.equal(report.sources[0].complete, false);
    assert.equal(report.sources[0].error.code, 'REPORT_INCOMPLETE');
    assert.equal(report.sources[0].error.request.stage, 'campaign_report');
    assert.equal(f.calls.length, 2, 'inventory is not queried after incomplete analytics');
  }
});
test('TikTok Overview refuses repeated campaign rows across pages while preserving valid complete reporting', async t => {
  const first = Array.from({length: 1000}, (_, i) => row(i + 1));
  const broken = fixture(t, u =>
    response(u.searchParams.get('page') === '1' ? first : [row(1)], Number(u.searchParams.get('page')), 1000, 1001),
  );
  const bad = await broken.run();
  assert.equal(bad.state, 'failed');
  assert.equal(bad.row_count, 0);
  assert.equal(bad.sources[0].error.code, 'REPORT_DUPLICATE_ROWS');
  const complete = fixture(t, u => response([row(1)], Number(u.searchParams.get('page')), 1000)),
    good = await complete.run();
  assert.equal(good.state, 'complete', JSON.stringify(good));
  assert.equal(good.row_count, 1);
  assert.equal(good.rows[0].metrics.spend, 1);
  assert.equal(good.sources[0].complete, true);
});
