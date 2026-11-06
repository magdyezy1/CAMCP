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
import {assertRefused} from './helpers/assert-refused.mjs';

const range = {since: '2026-09-01', until: '2026-09-08'};
function fixture(
  t,
  {
    mutate = value => value,
    failAt = 0,
    observe = () => {},
    collectionRange = range,
    realTransport = false,
    timezone = 'UTC',
    activity = {start: '2026-09-01T00:00:00Z', end: '2026-09-09T00:00:00Z'},
  } = {},
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
            activity_start_time: activity.start,
            activity_end_time: activity.end,
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
        data = {data: {id: 'abc', currency: 'USD', timezone, name: 'Synthetic X'}};
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
  const collect = (level = 'ad', scopes = {}, checkpoint = {}, lookup = undefined) =>
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
      lookup,
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
      // The line item's own objective, pinned from X's documentation, labelled as from the provider.
      assert.equal(row.objective, row.entity_id.endsWith('21') ? 'REACH' : 'WEBSITE_CLICKS');
      assert.equal(row.objective_group, row.entity_id.endsWith('21') ? 'awareness' : 'traffic');
      assert.equal(row.objective_source, 'provider');
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

// F-L7-09: every other X test uses a UTC account, so a window computed from UTC midnights would still pass them.
for (const [zone, window, first, last, hours] of [
  [
    'America/Los_Angeles',
    {since: '2026-09-01', until: '2026-09-07'},
    '2026-09-01T07:00:00Z',
    '2026-09-08T07:00:00Z',
    168,
  ],
  // The clocks go forward on 2026-03-08, so this local week has 167 hours.
  ['America/New_York', {since: '2026-03-02', until: '2026-03-08'}, '2026-03-02T05:00:00Z', '2026-03-09T04:00:00Z', 167],
  // The clocks go back on 2026-11-01, so this local week has 169 hours and needs two requests.
  ['America/New_York', {since: '2026-10-26', until: '2026-11-01'}, '2026-10-26T04:00:00Z', '2026-11-02T05:00:00Z', 169],
  ['Asia/Riyadh', {since: '2026-09-01', until: '2026-09-08'}, '2026-08-31T21:00:00Z', '2026-09-08T21:00:00Z', 192],
  // Cairo has no 00:00 on 2026-04-24, so that local day starts at 01:00 and has 23 hours.
  ['Africa/Cairo', {since: '2026-04-22', until: '2026-04-26'}, '2026-04-21T22:00:00Z', '2026-04-26T21:00:00Z', 119],
])
  test('X detail windows follow the account time zone: ' + zone + ' from ' + window.since, async t => {
    const f = fixture(t, {
        timezone: zone,
        collectionRange: window,
        activity: {start: '2026-01-01T00:00:00Z', end: '2026-12-31T00:00:00Z'},
      }),
      result = await f.collect('adset');
    const spans = [...new Set(f.analytics().map(plan => plan.query.start_time + '/' + plan.query.end_time))]
      .map(span => span.split('/').map(Date.parse))
      .sort((a, b) => a[0] - b[0]);
    assert.equal(spans[0][0], Date.parse(first));
    assert.equal(spans.at(-1)[1], Date.parse(last));
    assert.deepEqual(
      spans.slice(1).map((span, index) => span[0] - spans[index][1]),
      spans.slice(1).map(() => 0),
      'the requests tile the window without a gap or an overlap',
    );
    assert(spans.every(([from, to]) => (to - from) / 3600000 <= 168));
    assert.equal(
      spans.reduce((total, [from, to]) => total + (to - from) / 3600000, 0),
      hours,
    );
    assert.equal(result.rows.length, 21);
    for (const row of result.rows)
      assert.equal(row.native.exact_totals.impressions, String(hours), 'one hourly bucket counts once');
  });

// F-L7-04: X documents no name for a promoted tweet (docs.x.com/x-ads-api/campaign-management, promoted_tweets).
test('X promoted tweets are labelled by their promotion ID, and line items keep their own names', async t => {
  const f = fixture(t),
    ads = await f.collect('ad'),
    lines = await f.collect('adset');
  assert.equal(ads.rows.find(row => row.entity_id === 'p1').entity_name, 'Promoted tweet p1');
  assert.equal(ads.rows.find(row => row.entity_id === 'p21').entity_name, 'Promoted tweet p21');
  assert.equal(lines.rows.find(row => row.entity_id === 'l1').entity_name, 'Line 1');
});

// F-L7-05: the population is proven complete before the scope narrows it, so an ID that matches nothing is known.
test('requested IDs that match nothing in the proven X population are counted, kept and warned about', async t => {
  const f = fixture(t),
    result = await f.collect('ad', {
      campaign_ids: ['c2', 'nosuchcampaign'],
      adset_ids: ['l21', 'nosuchline'],
      ad_ids: ['p21', 'nosuchad'],
    });
  assert.deepEqual(
    result.rows.map(row => row.entity_id),
    ['p21'],
  );
  assert.equal(result.complete, true);
  assert.deepEqual(result.quality.population.unmatched, {
    campaign_ids: ['nosuchcampaign'],
    adset_ids: ['nosuchline'],
    ad_ids: ['nosuchad'],
  });
  assert.ok(result.warnings.includes('3 requested IDs matched no entity in this account.'));
  const none = await f.collect('adset', {adset_ids: ['nosuchline']});
  assert.deepEqual(none.rows, []);
  assert.equal(none.complete, true, 'the population is complete; the request named something that is not in it');
  assert.ok(none.warnings.includes('1 requested ID matched no entity in this account.'));
  assert.equal(none.quality.population.unmatched_count, 1);
  const matched = await f.collect('adset', {adset_ids: ['l1']});
  assert.deepEqual(matched.quality.population.unmatched, {campaign_ids: [], adset_ids: [], ad_ids: []});
  assert.equal(
    matched.warnings.some(message => /requested IDs? matched no entity/.test(message)),
    false,
  );
});

// F-L7-15: a rejected or short chunk at the new levels (the campaign level was already covered).
test('an X rejection of one detail chunk keeps the source partial with the chunks that were read', async t => {
  let analytics = 0;
  const f = fixture(t, {
      observe(plan) {
        if (plan.path === '/12/stats/accounts/abc' && ++analytics === 2)
          throw new MirrorError('UPSTREAM_ERROR', 'X refused the request.', {http_status: 400}, 400);
      },
    }),
    result = await f.collect('adset');
  assert.equal(result.complete, false);
  assert.equal(result.collection_complete, false);
  assert.ok(result.rows.length > 0, 'the chunks that were read are kept');
  assert.ok(result.warnings.some(message => message.startsWith('X rejected ALL_ON_TWITTER')));
});

test('an X detail chunk that omits requested IDs keeps the source partial and does not zero-fill them', async t => {
  const f = fixture(t, {
      mutate(data, plan) {
        if (plan.path === '/12/stats/accounts/abc') data.data = data.data.filter(row => row.id !== 'l5');
        return data;
      },
    }),
    result = await f.collect('adset');
  assert.equal(result.complete, false);
  assert.equal(result.collection_complete, false);
  assert.equal(
    result.rows.some(row => row.entity_id === 'l5'),
    false,
  );
  assert.ok(result.rows.length >= 20);
  assert.ok(result.warnings.includes('X omitted requested native entity IDs; the returned subset is retained.'));
});

// F-L7-03 at the sibling sites: the active-entities read answers to the same whole-job allowance.
test('AMCP’s own whole-job limit during the active-entities read is not mistaken for X refusing it', async t => {
  const f = fixture(t, {
    observe(plan) {
      if (plan.path.endsWith('/active_entities'))
        throw new MirrorError(
          'REPORT_COLLECTION_LIMIT',
          'This snapshot reached its whole-job requests limit.',
          {},
          422,
        );
    },
  });
  await assert.rejects(
    () => f.collect('adset'),
    error => assertRefused(error, 'REPORT_COLLECTION_LIMIT'),
  );
  assert.equal(f.analytics().length, 0, 'no analytics were requested instead');
  assert.equal(
    f.saved.some(value => value.x_detail_v1?.active_fallback === true),
    false,
    'the fallback is never recorded for a limit that is not X’s refusal',
  );
});

// F-L7-16: the population bounds are named with the condition that reached them.
const populationFixture = (t, handler) =>
  fixture(t, {
    mutate(data, plan) {
      if (plan.path.endsWith('/line_items')) handler(data, plan);
      return data;
    },
  });
const refusalOf = async (f, code) => {
  let caught;
  await assert.rejects(
    () => f.collect('adset'),
    error => {
      caught = error;
      return assertRefused(error, code);
    },
  );
  assert.equal(f.analytics().length, 0);
  return caught.message;
};
test('an X population over 10,000 entities names the bound and the kind, and says scope does not shorten it', async t => {
  const f = populationFixture(t, (data, plan) => {
    const page = plan.query.cursor ? Number(plan.query.cursor) : 1;
    data.data = Array.from({length: 1000}, (_, index) => ({id: 'p' + page + 'n' + index, campaign_id: 'c1'}));
    data.next_cursor = String(page + 1);
  });
  const message = await refusalOf(f, 'REPORT_COLLECTION_LIMIT');
  assert.match(message, /more than 10,000 line items/);
  assert.match(message, /scope/i);
});
test('an X population cursor that repeats is named as a repeated cursor', async t => {
  const f = populationFixture(t, (data, plan) => {
    const page = plan.query.cursor ? 2 : 1;
    data.data = [{id: 'r' + page, campaign_id: 'c1'}];
    data.next_cursor = 'same';
  });
  assert.match(await refusalOf(f, 'REPORT_INCOMPLETE'), /repeated a continuation cursor while listing line items/);
});
test('an X population page that is empty but continues is named as stalled', async t => {
  const f = populationFixture(t, (data, plan) => {
    data.data = plan.query.cursor ? [] : [{id: 's1', campaign_id: 'c1'}];
    data.next_cursor = plan.query.cursor ? 'again' : 'first';
  });
  assert.match(await refusalOf(f, 'REPORT_INCOMPLETE'), /empty page with a continuation while listing line items/);
});
test('an X population that needs over 100 pages names the page bound', async t => {
  const f = populationFixture(t, (data, plan) => {
    const page = plan.query.cursor ? Number(plan.query.cursor) : 1;
    data.data = [{id: 'q' + page, campaign_id: 'c1'}];
    data.next_cursor = String(page + 1);
  });
  assert.match(await refusalOf(f, 'REPORT_INCOMPLETE'), /more than 100 pages/);
});

// F-L7-17: the detail levels and periods of one source shared nothing, so a source with a line item and a promoted tweet level
// listed its campaigns and line items twice, and every period listed them again.
const listed = (f, kind) => f.requests.filter(p => p.path === '/12/accounts/abc/' + kind).length,
  listings = f => [listed(f, 'campaigns'), listed(f, 'line_items'), listed(f, 'promoted_tweets')];
test('the X populations are listed once for the job, then reused by its other levels and periods with their lineage marked cached', async t => {
  const f = fixture(t),
    lookup = {},
    groups = await f.collect('adset', {}, {}, lookup);
  assert.deepEqual(listings(f), [1, 2, 0], 'campaigns on one page, line items on two');
  const ads = await f.collect('ad', {}, {}, lookup);
  assert.deepEqual(listings(f), [1, 2, 2], 'the promoted tweet level lists only the promoted tweets');
  assert.equal(groups.rows.length, 21);
  assert.equal(ads.rows.length, 21);
  const stage = ads.lineage.filter(entry => entry.stage === 'detail_population');
  assert.equal(stage.length, 5);
  assert.equal(stage.filter(entry => entry.cached === true).length, 3, 'the campaigns and both line item pages');
  assert.ok(stage.filter(entry => entry.cached !== true).every(entry => entry.path.endsWith('/promoted_tweets')));
  assert.equal(ads.quality.population.promoted_tweets, 21);
  // A later period of either level reads no list at all.
  await f.collect('adset', {}, {}, lookup);
  await f.collect('ad', {}, {}, lookup);
  assert.deepEqual(listings(f), [1, 2, 2]);
  // Without the job’s cache each collection lists its own, as before.
  await f.collect('adset');
  assert.deepEqual(listings(f), [2, 4, 2]);
});

test('an X population read under another login is never reused', async t => {
  const f = fixture(t),
    lookup = {};
  await f.collect('adset', {}, {}, lookup);
  assert.deepEqual(listings(f), [1, 2, 0]);
  const connection = f.store.resolveConnection(f.actor, 'x_ads_native_action', 'abc', 'x');
  f.store.putConnection(f.actor, {...connection, scopes: ['changed']}, {accessToken: 'synthetic-rotated'});
  await f.collect('adset', {}, {}, lookup);
  assert.deepEqual(listings(f), [2, 4, 0], 'listed again under the new login');
});
