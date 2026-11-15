import test from 'node:test';
import assert from 'node:assert/strict';
import {paginate, nextPage} from '../dist/src/pagination.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';
import {tiktokStatusFilterRefusedWarning} from '../dist/src/tiktok-report-request.js';

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
    // r25-hotfix (V2-RPT-01): 3 is neither the page size asked for (2) nor the row count (1). A page_size of 1, the row count,
    // used to be refused here; TikTok reports that for a report that fits on one page (read live on 2026-11-15), so it is
    // accepted now and asserted after this loop.
    d => {
      d.data.page_info.page_size = 3;
    },
    d => {
      d.data.page_info.total_number = '1';
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
  // Rows with no page counts at all are refused; an empty list with none is an empty report (F-L1-01), so nothing follows it.
  assert.throws(() => nextPage(plan, {code: 0, data: {list: [row(1)]}}), {code: 'REPORT_INCOMPLETE'});
  assert.equal(nextPage(plan, {code: 0, data: {list: []}}), null);
  // r25-hotfix (V2-RPT-01): the one-row page whose page_size is its row count is a whole report on page one, as TikTok
  // answers it live, and completes. A page_size that is neither the request nor the row count is still refused (above).
  const whole = response([row(1)]);
  whole.data.page_info.page_size = 1;
  const out = await paginate(plan, async () => whole);
  assert.equal(out.truncated, false);
  assert.equal(out.data.data.list.length, 1);
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
test('TikTok integrated empty reports are empty whatever page counts they omit, and inventory pagination retains its independent contract', async () => {
  // F-L1-01: TikTok documents no empty-report values, so missing or zero page fields are handled defensively. This
  // replaces the earlier pin that refused `{list: []}`; rows without counts and declared totals still refuse.
  for (const data of [
    {list: []},
    {list: [], page_info: {}},
    {list: [], page_info: {page: 0, page_size: 0, total_number: 0, total_page: 0}},
    {list: [], page_info: {total_number: 0, total_page: 0}},
  ]) {
    const out = await paginate(plan, async () => ({code: 0, data}));
    assert.equal(out.truncated, false, JSON.stringify(data));
    assert.equal(out.pages, 1);
    assert.deepEqual(out.data.data.list, []);
  }
  await assert.rejects(
    paginate(plan, async () => ({code: 0, data: {list: [row(1)]}})),
    {code: 'REPORT_INCOMPLETE'},
  );
  await assert.rejects(
    paginate(plan, async () => ({code: 0, data: {list: [], page_info: {page: 0, page_size: 0, total_number: 2}}})),
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
  for (const data of [{code: 0, data: {list: [row(1)]}}]) {
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

test('TikTok Overview reads every empty-report page shape as a complete empty source, never a failed one', async t => {
  for (const data of [
    {list: []},
    {list: [], page_info: {}},
    {list: [], page_info: {page: 0, page_size: 0, total_number: 0, total_page: 0}},
    {list: [], page_info: {total_number: 0, total_page: 0}},
  ]) {
    const f = fixture(t, () => ({code: 0, data})),
      report = await f.run();
    assert.equal(report.state, 'complete', JSON.stringify([data, report.sources[0].error]));
    assert.equal(report.row_count, 0);
    assert.equal(report.sources[0].complete, true);
    assert.equal(report.sources[0].error, undefined);
  }
});
test('an empty page does not hide rows that TikTok’s own totals say exist', async t => {
  const f = fixture(t, () => ({
      code: 0,
      data: {list: [], page_info: {}, total_metrics: {spend: '5.00', impressions: '50', clicks: '3', conversion: '1'}},
    })),
    report = await f.run();
  assert.equal(report.sources[0].complete, false);
  assert.match(report.sources[0].warnings.join(' '), /spend 0\.00 of 5\.00/);
});

test('a TikTok refusal inside HTTP 200 that names only the filter value falls back once and completes (F-L1-12)', async t => {
  let filtered = 0,
    plain = 0;
  const f = fixture(t, url => {
    if (url.searchParams.get('filtering')) {
      filtered++;
      return {code: 40002, message: 'Invalid value: STATUS_ALL', request_id: 'synthetic'};
    }
    plain++;
    return response([row(1)], 1, 1000);
  });
  const report = await f.run();
  assert.equal(report.state, 'complete', JSON.stringify(report.sources[0].error));
  assert.deepEqual([filtered, plain], [1, 1]);
  assert.ok(report.sources[0].warnings.includes(tiktokStatusFilterRefusedWarning));
});
test('a TikTok login failure inside HTTP 200 is a connection failure with the reconnect action, and is not retried as a refused filter', async t => {
  let reads = 0;
  const f = fixture(t, () => {
    reads++;
    return {code: 40105, message: 'Access token is invalid or expired', request_id: 'synthetic'};
  });
  const report = await f.run();
  assert.equal(report.state, 'failed');
  assert.equal(reads, 1);
  // TikTok's return-code table (read 2026-11-06) names 40105 a credential failure (F-L1-05).
  const error = report.sources[0].error;
  assert.deepEqual([error.code, error.category, error.layer], ['AUTH_EXPIRED', 'connection', 'credential']);
  assert.equal('http_status' in error, false, 'the answer was HTTP 200');
  assert.equal(error.provider.code, '40105');
  assert.match(error.next_action, /Reconnect the affected login in Connections/);
});
test('the filter fallback is for parameter refusals: a code TikTok’s table maps is never read as one, whatever its words', async t => {
  // 40001 and 40119 role, 40125 consent, 40118 eligibility and 40105 credential are asked once; 40100 throttle and 50000
  // server failures are retried as reads with the filter kept. The message names the filter on purpose.
  for (const [code, attempts] of [
    [40105, 1],
    [40001, 1],
    [40119, 1],
    [40125, 1],
    [40118, 1],
    [40100, 3],
    [50000, 3],
  ]) {
    const filtered = [];
    const f = fixture(t, url => {
      filtered.push(url.searchParams.get('filtering') !== null);
      return {code, message: 'The filtering by STATUS_ALL could not be applied', request_id: 'synthetic'};
    });
    const report = await f.run();
    assert.equal(filtered.length, attempts, String(code));
    assert.ok(filtered.every(Boolean), code + ' keeps the filter on every read');
    assert.ok(!(report.sources[0].warnings ?? []).includes(tiktokStatusFilterRefusedWarning), String(code));
    assert.notEqual(report.state, 'complete', String(code));
  }
});

test('TikTok Overview retains short collections as partial with declared and returned counts', async t => {
  const f = fixture(t, () => response([row(1)], 1, 1000, 2));
  const report = await f.run();
  assert.equal(report.state, 'partial');
  assert.equal(report.row_count, 1);
  assert.equal(report.sources[0].complete, false);
  assert.equal(report.sources[0].collection_complete, false);
  assert.ok(report.sources[0].warnings.includes('TikTok declared 2 rows and returned 1.'));
  assert.equal(report.rows[0].metrics.spend, 1);
  assert.equal(report.rows[0].complete, false);
  assert.equal(report.rows[0].recommendation.decision, 'needs_review');
});
test('TikTok Overview keeps both counts in a partial source even when TikTok’s totals are present (F-L1-02)', async t => {
  const f = fixture(t, () => {
    const answer = response([row(1)], 1, 1000, 2);
    answer.data.total_metrics = {spend: '2', clicks: '4'};
    return answer;
  });
  const report = await f.run();
  assert.equal(report.state, 'partial');
  assert.equal(report.sources[0].complete, false);
  const warnings = report.sources[0].warnings.join(' | ');
  assert.match(warnings, /spend 1\.00 of 2\.00/);
  assert.ok(report.sources[0].warnings.includes('TikTok declared 2 rows and returned 1.'), warnings);
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
