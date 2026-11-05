import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {MirrorError} from '../dist/src/errors.js';
import {NativeCampaignReports} from '../dist/src/report-native.js';
import {normalizeOverviewV4Source} from '../dist/src/overview-v4.js';
import {xReportSource} from '../dist/src/x-report-source.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {estimateCollectionRequests, assertCollectionEstimate} from '../dist/src/report-request-estimate.js';

const range = {since: '2026-09-01', until: '2026-09-08'};
function fixture(
  t,
  {mutate = value => value, failAt = 0, observe = () => {}, collectionRange = range, realTransport = false} = {},
) {
  const actor = {tenantId: 'x-native-detail', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 123).toString('base64')),
    requests = [],
    saved = [],
    campaigns = ['c1', 'c2'].map(id => ({id, name: 'Campaign ' + id})),
    lines = Array.from({length: 21}, (_, i) => ({
      id: 'l' + (i + 1),
      name: 'Line ' + (i + 1),
      campaign_id: i < 20 ? 'c1' : 'c2',
      objective: i < 20 ? 'WEBSITE_CLICKS' : 'REACH',
      entity_status: i ? 'PAUSED' : 'ACTIVE',
      deleted: i === 20,
    })),
    promoted = lines.map((line, i) => ({
      id: 'p' + (i + 1),
      line_item_id: line.id,
      tweet_id: '9007199254740993',
      entity_status: line.entity_status,
      deleted: line.deleted,
    }));
  store.putConnection(
    actor,
    {
      id: 'x',
      tenantId: actor.tenantId,
      gateway: 'x_ads_native_action',
      accounts: ['abc'],
      enabled: true,
      label: 'Synthetic X',
      scopes: [],
    },
    {accessToken: 'synthetic', consumerKey: 'synthetic', consumerSecret: 'synthetic', tokenSecret: 'synthetic'},
  );
  t.after(() => store.close());
  let analytics = 0,
    refusing = failAt > 0;
  const recording = {
    store,
    async runPlan(plan, options) {
      requests.push(structuredClone(plan));
      observe(plan, store, actor);
      const kind = plan.path.split('/').at(-1);
      let data;
      if (['campaigns', 'line_items', 'promoted_tweets'].includes(kind)) {
        assert.equal(options.aggregate_pages, false);
        assert.equal(plan.query.with_deleted, true);
        const all = {campaigns, line_items: lines, promoted_tweets: promoted}[kind],
          second = plan.query.cursor === 'second';
        data = {
          data: all.slice(second ? 10 : 0, second ? all.length : 10),
          next_cursor: !second && all.length > 10 ? 'second' : null,
          request: {params: {account_id: 'abc'}},
        };
      } else if (kind === 'active_entities') {
        const entities = plan.query.entity === 'PROMOTED_TWEET' ? promoted : lines;
        data = {
          data: entities.map(row => ({
            entity_id: row.id,
            placements: ['ALL_ON_TWITTER'],
            activity_start_time: '2026-09-01T00:00:00Z',
            activity_end_time: '2026-09-09T00:00:00Z',
          })),
        };
      } else if (plan.path === '/12/stats/accounts/abc') {
        analytics++;
        if (refusing && analytics === failAt)
          throw new MirrorError('PROVIDER_ERROR', 'Synthetic temporary refusal', {}, 503, true);
        assert(['LINE_ITEM', 'PROMOTED_TWEET'].includes(plan.query.entity));
        const ids = plan.query.entity_ids.split(','),
          hours = (Date.parse(plan.query.end_time) - Date.parse(plan.query.start_time)) / 3600000;
        assert(ids.length > 0 && ids.length <= 20);
        assert(hours > 0 && hours <= 168 && Number.isInteger(hours));
        assert.equal(plan.query.granularity, 'HOUR');
        assert.equal(plan.query.placement, 'ALL_ON_TWITTER');
        data = {
          time_series_length: hours,
          request: {
            params: {
              ...plan.query,
              account_id: 'abc',
              entity_ids: ids,
              metric_groups: plan.query.metric_groups.split(','),
            },
          },
          data: ids.map(id => ({
            id,
            id_data: [
              {
                segment: null,
                metrics: {
                  billed_charge_local_micro: Array(hours).fill('1000000'),
                  impressions: Array(hours).fill('1'),
                  clicks: Array(hours).fill('1'),
                  url_clicks: Array(hours).fill('1'),
                  engagements: Array(hours).fill('1'),
                  video_total_views: Array(hours).fill('1'),
                },
              },
            ],
          })),
        };
      } else {
        assert.equal(plan.path, '/12/accounts/abc');
        data = {data: {id: 'abc', currency: 'USD', timezone: 'UTC', name: 'Synthetic X'}};
      }
      return {success: true, data: mutate(data, plan)};
    },
  };
  const wire = [];
  const service = realTransport
    ? new MirrorService(
        new Registry(),
        store,
        new NativeTransport(
          async (input, init) => {
            const url = new URL(String(input)),
              headers = new Headers(init?.headers);
            assert.equal(url.origin, 'https://ads-api.x.com');
            assert.equal(init?.method, 'GET');
            assert.match(headers.get('authorization'), /^OAuth /);
            wire.push({path: url.pathname, query: Object.fromEntries(url.searchParams), signed: true});
            const query = Object.fromEntries(url.searchParams);
            if (query.with_deleted !== undefined) query.with_deleted = query.with_deleted === 'true';
            if (query.count !== undefined) query.count = Number(query.count);
            const response = await recording.runPlan({path: url.pathname, query}, {aggregate_pages: false});
            return Response.json(response.data);
          },
          async () => {},
        ),
      )
    : recording;
  const native = new NativeCampaignReports(service);
  const collect = (level = 'ad', scopes = {}, checkpoint = {}) =>
    native.collect(
      normalizeOverviewV4Source(
        {
          platform: 'x',
          account_id: 'abc',
          connection_id: 'x',
          levels: [level],
          delivered_only: false,
          report_options: {complete_window: true, attribution: 'unknown'},
          ...scopes,
        },
        xReportSource.overview,
      ),
      collectionRange,
      actor,
      checkpoint,
      value => saved.push(structuredClone(value)),
    );
  return {
    collect,
    requests,
    saved,
    store,
    actor,
    service,
    wire,
    recover() {
      refusing = false;
    },
    analytics: () => requests.filter(p => p.path === '/12/stats/accounts/abc'),
  };
}

for (const level of ['adset', 'ad'])
  test('X ' + level + ' proves paged native parents and chunks synchronous stats with exact results', async t => {
    const f = fixture(t),
      result = await f.collect(level);
    assert.equal(result.rows.length, 21);
    assert.equal(result.complete, true);
    assert.equal(result.collection_complete, true);
    assert.equal(f.analytics().length, 4);
    for (const row of result.rows) {
      assert.equal(row.entity_level, level);
      assert.equal(row.native.exact_totals.spend, '192');
      assert.equal(row.native.exact_totals.impressions, '192');
      assert.equal(row.result.value, '192');
      assert.equal(row.result.cost_per_result, row.entity_id.endsWith('21') ? '1000' : '1');
      assert.equal(row.metrics.reach, null);
      assert.equal(row.metrics.frequency, null);
      assert.equal(row.parent_ids.campaign_id, row.entity_id.endsWith('21') ? 'c2' : 'c1');
      if (level === 'ad') assert.equal(row.parent_ids.adset_id, row.entity_id.replace('p', 'l'));
    }
    assert.equal(result.rows.find(row => row.entity_id === (level === 'ad' ? 'p21' : 'l21')).status, 'archived');
    assert.equal(result.rows.find(row => row.entity_id === (level === 'ad' ? 'p1' : 'l1')).status, 'active');
    assert.equal(result.native_population.includes_deleted, true);
    assert.equal(
      f.requests.some(p => /jobs|async/.test(p.path)),
      false,
    );
  });

test('X selected promotion IDs scope stats by promotion identity, despite reused native tweet IDs', async t => {
  const f = fixture(t),
    result = await f.collect('ad', {ad_ids: ['p21']});
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].entity_id, 'p21');
  assert.equal(result.rows[0].parent_ids.campaign_id, 'c2');
  assert(f.analytics().every(plan => plan.query.entity_ids === 'p21'));
  const populations = f.requests.filter(plan => plan.path.endsWith('/promoted_tweets'));
  assert.equal(populations.length, 2, 'the complete native promotion population is proven before narrowing');
});

test('the real v4 queue and worker retain X promoted-tweet identity, scope, result and native parents', async t => {
  const f = fixture(t),
    overview = new ReportingOverview(f.service, async () => {
      throw Error('Unexpected network request');
    }),
    worker = new ReportWorker(
      f.store,
      async () => ({}),
      (tenant, kind, input) => overview.work(tenant, kind, input),
    ),
    queued = await overview.handle(
      {
        action: 'run',
        confirmed: true,
        config: {
          contract_version: 'overview-config-v4',
          name: 'Selected X promotion',
          date_range: range,
          grain: 'total',
          sources: [
            {
              platform: 'x',
              account_id: 'abc',
              connection_id: 'x',
              levels: ['ad'],
              ad_ids: ['p21'],
              delivered_only: false,
              report_options: {complete_window: true, attribution: 'unknown'},
            },
          ],
          metrics: ['spend', 'impressions', 'conversions'],
        },
      },
      f.actor,
    );
  assert.equal(await worker.once(), true);
  const report = await overview.handle({action: 'get', id: queued.id}, f.actor);
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].entity_id, 'p21');
  assert.equal(report.rows[0].level, 'ad');
  assert.equal(report.rows[0].parents.campaign.id, 'c2');
  assert.equal(report.rows[0].parents.adset.id, 'l21');
  assert.equal(report.rows[0].metrics.spend, '192');
  assert.equal(report.rows[0].result.value, '192');
  assert(f.analytics().every(plan => plan.query.entity_ids === 'p21'));
});

for (const [label, mutate] of [
  [
    'foreign native entity',
    (data, plan) => {
      if (plan.path.endsWith('/line_items')) data.data[0].account_id = 'other';
      return data;
    },
  ],
  [
    'orphan line item',
    (data, plan) => {
      if (plan.path.endsWith('/line_items')) data.data[0].campaign_id = 'other';
      return data;
    },
  ],
  [
    'orphan promotion',
    (data, plan) => {
      if (plan.path.endsWith('/promoted_tweets')) data.data[0].line_item_id = 'other';
      return data;
    },
  ],
  [
    'duplicate native identity',
    (data, plan) => {
      if (plan.path.endsWith('/promoted_tweets') && plan.query.cursor) data.data[0].id = 'p1';
      return data;
    },
  ],
  [
    'continued empty population',
    (data, plan) => {
      if (plan.path.endsWith('/line_items')) {
        data.data = [];
        data.next_cursor = 'again';
      }
      return data;
    },
  ],
  [
    'missing pagination boundary',
    (data, plan) => {
      if (plan.path.endsWith('/line_items')) delete data.next_cursor;
      return data;
    },
  ],
  [
    'declared population mismatch',
    (data, plan) => {
      if (plan.path.endsWith('/line_items')) data.total_count = 99;
      return data;
    },
  ],
  [
    'unlisted active ID',
    (data, plan) => {
      if (plan.path.endsWith('/active_entities')) data.data[0].entity_id = 'missing';
      return data;
    },
  ],
])
  test('X detail refuses ' + label + ' before analytics', async t => {
    const f = fixture(t, {mutate});
    await assert.rejects(
      () => f.collect(),
      e => /^REPORT_/.test(e.code),
    );
    assert.equal(f.analytics().length, 0);
  });

for (const [label, change] of [
  [
    'entity type',
    data => {
      data.request.params.entity = 'CAMPAIGN';
    },
  ],
  [
    'requested IDs',
    data => {
      data.request.params.entity_ids = ['foreign'];
    },
  ],
  [
    'account',
    data => {
      data.request.params.account_id = 'other';
    },
  ],
  [
    'start',
    data => {
      data.request.params.start_time = '2025-01-01T00:00:00Z';
    },
  ],
  [
    'end',
    data => {
      data.request.params.end_time = '2025-01-02T00:00:00Z';
    },
  ],
  [
    'placement',
    data => {
      data.request.params.placement = 'TREND';
    },
  ],
  [
    'hour count',
    data => {
      data.time_series_length = 1;
    },
  ],
  [
    'uncollected continuation',
    data => {
      data.next_cursor = 'unexpected';
    },
  ],
])
  test('X detail refuses mismatched analytics ' + label, async t => {
    const f = fixture(t, {
      mutate(data, plan) {
        if (plan.path === '/12/stats/accounts/abc') change(data);
        return data;
      },
    });
    await assert.rejects(
      () => f.collect(),
      e => /^REPORT_/.test(e.code),
    );
  });

test('X detail retries retain the proven population, active set and completed synchronous chunks', async t => {
  const f = fixture(t, {failAt: 2});
  await assert.rejects(
    () => f.collect(),
    e => e.retryable === true,
  );
  const checkpoint = f.saved.at(-1),
    inventoryReads = f.requests.filter(p => /\/(campaigns|line_items|promoted_tweets)$/.test(p.path)).length;
  assert(checkpoint.x_detail_v1.report.next > 0);
  f.recover();
  const result = await f.collect('ad', {}, checkpoint);
  assert.equal(result.complete, true);
  assert.equal(result.rows.length, 21);
  assert.equal(f.requests.filter(p => /\/(campaigns|line_items|promoted_tweets)$/.test(p.path)).length, inventoryReads);
  assert.equal(f.analytics().length, 5, 'four completed calls plus one temporary refusal');
  await assert.rejects(
    () => f.collect('ad', {ad_ids: ['p21']}, checkpoint),
    e => e.code === 'REPORT_DEFINITION_CHANGED',
  );
});

test('an undeclared X window stays partial with an undeclared explanation and exact known metrics', async t => {
  const f = fixture(t),
    result = await f.collect('ad', {report_options: {complete_window: null, attribution: 'unknown'}});
  assert.equal(result.complete, false);
  assert.equal(result.collection_complete, true);
  assert.equal(result.rows[0].native.exact_totals.spend, '192');
  assert(
    result.warnings.includes(
      'The reporting window was not declared complete. Results remain partial and recommendations are withheld.',
    ),
  );
  assert(!result.warnings.some(message => message.includes('was declared incomplete')));
});

test('X native activity survives sub-precision spend at both new detail levels', async t => {
  const f = fixture(t, {
    mutate(data, plan) {
      if (plan.path === '/12/stats/accounts/abc')
        for (const row of data.data)
          for (const segment of row.id_data)
            for (const [field, values] of Object.entries(segment.metrics))
              segment.metrics[field] = values.map(() => (field === 'billed_charge_local_micro' ? '0.000000001' : '0'));
      return data;
    },
  });
  for (const level of ['adset', 'ad']) {
    const result = await f.collect(level);
    assert.equal(result.rows[0].native.exact_totals.spend, '0', 'retained metric obeys nine-place rounding');
    assert.equal(
      result.rows[0].native.delivery_activity,
      true,
      'positive native activity is observed before display rounding',
    );
    assert.equal(
      result.quality.metric_rounding?.spend?.rows_rounded,
      21,
      'native precision loss is disclosed for every rounded entity',
    );
  }
});

test('X detail no-activity entities produce no invented zero rows', async t => {
  const f = fixture(t, {
      mutate(data, plan) {
        if (plan.path.endsWith('/active_entities')) data.data = [];
        return data;
      },
    }),
    result = await f.collect();
  assert.equal(result.complete, true);
  assert.deepEqual(result.rows, []);
  assert.equal(result.no_activity_count, 21);
  assert.equal(f.analytics().length, 0);
});

test('unrequested X publisher-network delivery keeps detail coverage partial', async t => {
  const f = fixture(t, {
      mutate(data, plan) {
        if (plan.path.endsWith('/active_entities')) for (const row of data.data) row.placements = ['PUBLISHER_NETWORK'];
        return data;
      },
    }),
    result = await f.collect();
  assert.equal(result.complete, false);
  assert.equal(result.collection_complete, false);
  assert.deepEqual(result.rows, []);
  assert(result.warnings.some(message => message.includes('Some X entities have activity on the publisher network')));
  assert.equal(f.analytics().length, 0);
});

test('X population continuation stops at page100 before analytics', async t => {
  const f = fixture(t, {
    mutate(data, plan) {
      if (plan.path.endsWith('/line_items')) {
        const page = plan.query.cursor ? Number(plan.query.cursor) : 1;
        data.data = [{id: 'l' + page, campaign_id: 'c1'}];
        data.next_cursor = String(page + 1);
      }
      return data;
    },
  });
  await assert.rejects(
    () => f.collect(),
    e => e.code === 'REPORT_INCOMPLETE',
  );
  assert.equal(f.requests.filter(plan => plan.path.endsWith('/line_items')).length, 100);
  assert.equal(f.analytics().length, 0);
});

test('X detail refuses a sync plan above100requests without starting analytics or async work', async t => {
  const previous = process.env.AMCP_X_ACTIVE_ENTITIES;
  process.env.AMCP_X_ACTIVE_ENTITIES = 'off';
  t.after(() => {
    if (previous === undefined) delete process.env.AMCP_X_ACTIVE_ENTITIES;
    else process.env.AMCP_X_ACTIVE_ENTITIES = previous;
  });
  const f = fixture(t, {collectionRange: {since: '2026-03-01', until: '2026-09-08'}});
  await assert.rejects(
    () => f.collect(),
    e => e.code === 'REPORT_RANGE_LIMIT' && e.details.planned_requests > 100,
  );
  assert.equal(f.analytics().length, 0);
  assert(!f.requests.some(plan => /jobs|async/.test(plan.path)));
});

test('X authority revoked between native population pages refuses the rest of collection', async t => {
  const f = fixture(t, {
    observe(plan, store, actor) {
      if (plan.path.endsWith('/line_items') && plan.query.cursor) {
        const connection = store.resolveConnection(actor, 'x_ads_native_action', 'abc', 'x');
        store.putConnection(actor, {...connection, enabled: false}, {accessToken: 'synthetic'});
      }
    },
  });
  await assert.rejects(
    () => f.collect(),
    e =>
      ['CONNECTION_REQUIRED', 'CONNECTION_DISABLED', 'ACCOUNT_NOT_ALLOWED', 'CONNECTION_AUTHORITY_CHANGED'].includes(
        e.code,
      ),
  );
  assert.equal(f.analytics().length, 0);
});

test('empty X native populations are complete without invented entities or analytics requests', async t => {
  const f = fixture(t, {
    mutate(data, plan) {
      if (
        ['campaigns', 'line_items', 'promoted_tweets', 'active_entities'].some(kind => plan.path.endsWith('/' + kind))
      ) {
        data.data = [];
        if (!plan.path.endsWith('/active_entities')) data.next_cursor = null;
      }
      return data;
    },
  });
  for (const level of ['adset', 'ad']) {
    const report = await f.collect(level);
    assert.equal(report.complete, true);
    assert.deepEqual(report.rows, []);
    assert.equal(report.native_population.selected, 0);
  }
  assert.equal(f.analytics().length, 0);
});

test('X campaign, line-item and promotion scopes intersect rather than widen the selection', async t => {
  const f = fixture(t),
    report = await f.collect('ad', {campaign_ids: ['c2'], adset_ids: ['l21'], ad_ids: ['p1']});
  assert.equal(report.complete, true);
  assert.deepEqual(report.rows, []);
  assert.equal(f.analytics().length, 0);
});

test('a changed X login cannot reuse an earlier authority-bound detail checkpoint', async t => {
  const f = fixture(t, {failAt: 2});
  await assert.rejects(
    () => f.collect(),
    error => error.retryable,
  );
  const checkpoint = f.saved.at(-1),
    previous = f.analytics().length,
    connection = f.store.resolveConnection(f.actor, 'x_ads_native_action', 'abc', 'x');
  f.store.putConnection(f.actor, {...connection, scopes: ['changed']}, {accessToken: 'synthetic-rotated'});
  await assert.rejects(
    () => f.collect('ad', {}, checkpoint),
    error => error.code === 'CONNECTION_AUTHORITY_CHANGED',
  );
  assert.equal(f.analytics().length, previous);
});

test('X request estimates include known entity batches and seven-day chunks and can refuse before egress', () => {
  const config = (count, until) => ({
    contract_version: 'overview-config-v4',
    date_range: {since: '2026-01-01', until},
    grain: 'total',
    sources: [
      normalizeOverviewV4Source(
        {
          platform: 'x',
          account_id: 'abc',
          connection_id: 'x',
          levels: ['ad'],
          ad_ids: Array.from({length: count}, (_, i) => 'p' + (i + 1)),
        },
        xReportSource.overview,
      ),
    ],
  });
  const short = estimateCollectionRequests(config(1, '2026-01-01')),
    longer = estimateCollectionRequests(config(41, '2026-01-08'));
  assert(longer.estimated_requests > short.estimated_requests);
  assert(longer.estimated_requests >= 3 * 3 * 2, 'three known batches, three placements, two synchronous windows');
  assert.throws(
    () => assertCollectionEstimate(config(500, '2026-09-08')),
    error => error.code === 'REPORT_COLLECTION_LIMIT',
  );
});

test('X detail traverses the real authorized transport and signs synthetic native reads', async t => {
  const f = fixture(t, {realTransport: true}),
    report = await f.collect('ad', {ad_ids: ['p21']});
  assert.equal(report.complete, true);
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].entity_id, 'p21');
  assert.equal(report.rows[0].parent_ids.campaign_id, 'c2');
  assert(f.wire.length > 0);
  assert(f.wire.every(request => request.signed));
  assert(
    f.wire
      .filter(request => request.path === '/12/stats/accounts/abc')
      .every(request => request.query.entity_ids === 'p21'),
  );
});
