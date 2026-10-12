// RPT-02 regression suite: completeness labels match reality. Every provider response is synthetic; no network or
// provider account is used. Fake clocks shift Date.now only (it keeps advancing), never into the real future.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';
import {collectReportPeriods} from '../dist/src/report-periods.js';
import {campaignRecommendation} from '../dist/src/report-metrics.js';
import {reportWindowState, markReportWindow} from '../dist/src/report-windows.js';
import {resolveReportConfig} from '../dist/src/reporting.js';
import {evaluateMonitors, monitorOperation} from '../dist/src/report-monitors.js';
import {overviewGranularityFixture, granularSource, granularConfig} from './fixtures/overview-granularity-data.mjs';

const connection = 'aaaaaaaa-2222-4222-8222-000000000001';
/** Date.now shifted to `iso` and still advancing, so leases and rate limits behave normally. */
function clock(t, iso) {
  const real = Date.now.bind(Date),
    shift = Date.parse(iso) - real();
  t.mock.method(Date, 'now', () => real() + shift);
}
const iso = day => new Date(day).toISOString().slice(0, 10);

/** A Meta traffic campaign whose account time zone is chosen per test (null = Meta omits it). */
function metaFixture(timezone = 'UTC') {
  const actor = {tenantId: 'completeness', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 71).toString('base64')),
    requests = [];
  store.putConnection(
    actor,
    {
      id: connection,
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: ['ads_read'],
    },
    {accessToken: 'synthetic'},
  );
  const fetcher = async (raw, init) => {
    const url = new URL(String(raw));
    requests.push(url);
    assert.equal(init?.method ?? 'GET', 'GET', 'Synthetic Meta refuses mutations');
    if (url.hostname !== 'graph.facebook.com') throw Error('Synthetic fixture refuses egress: ' + url.hostname);
    if (!url.pathname.endsWith('/insights'))
      return Response.json({
        id: 'act_100',
        account_id: '100',
        name: 'Synthetic Meta',
        currency: 'USD',
        ...(timezone ? {timezone_name: timezone} : {}),
      });
    const range = JSON.parse(url.searchParams.get('time_range'));
    // RPT-03: a daily source sends one time_increment=1 request; Meta answers with one row per day.
    const periods = [];
    if (url.searchParams.get('time_increment') === '1')
      for (let d = Date.parse(range.since); d <= Date.parse(range.until); d += 86400000) {
        const day = new Date(d).toISOString().slice(0, 10);
        periods.push({since: day, until: day});
      }
    else periods.push(range);
    return Response.json({
      data: periods.map(period => ({
        account_id: '100',
        campaign_id: '101',
        campaign_name: 'Synthetic traffic',
        objective: 'OUTCOME_TRAFFIC',
        date_start: period.since,
        date_stop: period.until,
        spend: '10',
        impressions: '1000',
        clicks: '100',
      })),
    });
  };
  const service = new MirrorService(new Registry(), store, new NativeTransport(fetcher, async () => {})),
    overview = new ReportingOverview(service, async () => {
      throw Error('Unexpected Google Sheets request');
    }),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (tenant, kind, input) => overview.work(tenant, kind, input),
    );
  const config = (date_range, grain = 'total') => ({
    name: 'Synthetic traffic',
    sources: [{platform: 'meta', connection_id: connection, account_id: '100'}],
    date_range,
    grain,
    metrics: ['spend', 'clicks', 'cpc'],
    custom_metrics: [],
    // Without any completeness hold this traffic campaign earns "scale": CPC 0.1 against a 1 USD target.
    targets: {traffic: {target: 1, currency: 'USD'}},
    objectives: [],
  });
  const run = async c => {
    const queued = await overview.handle({action: 'run', config: c, confirmed: true}, actor);
    assert.equal(await worker.once(), true);
    return overview.handle({action: 'get', id: queued.id}, actor);
  };
  return {actor, store, overview, requests, config, run, close: () => store.close()};
}

test('multi-period measurement quality is tri-state: unknown stays null, any known gap is false', async () => {
  const periods = qualities =>
    collectReportPeriods(
      {platform: 'meta'},
      {since: '2026-09-01', until: '2026-09-03'},
      'daily',
      {},
      async range => {
        const measurement_complete =
          qualities[Date.parse(range.since) / 86400000 - Date.parse('2026-09-01') / 86400000];
        return {rows: [], complete: true, date_range: range, quality: {version: 1, measurement_complete}};
      },
      () => {},
    );
  // Before RPT-02 every one of these unknown or mixed sources became false.
  assert.equal((await periods([null, null, null])).quality.measurement_complete, null);
  assert.equal((await periods([true, null, true])).quality.measurement_complete, null);
  assert.equal((await periods([true, false, null])).quality.measurement_complete, false, 'A thresholded GA4 day');
  assert.equal((await periods([true, true, true])).quality.measurement_complete, true);
});

test('a daily Meta campaign source reports unknown measurement completeness, not false', async () => {
  const f = metaFixture();
  try {
    const report = await f.run(f.config({since: '2026-09-01', until: '2026-09-03'}, 'daily'));
    assert.equal(report.state, 'complete', JSON.stringify(report.sources));
    assert.equal(report.sources[0].quality.measurement_complete, null);
    assert.equal(report.sources[0].collection_complete, true);
  } finally {
    f.close();
  }
});

test('a closed window is unchanged: complete and eligible for advice', async () => {
  const f = metaFixture('America/New_York');
  try {
    const report = await f.run(f.config({since: '2026-09-01', until: '2026-09-07'}));
    assert.equal(report.state, 'complete', JSON.stringify(report.sources));
    assert.equal(report.sources[0].open_window, undefined);
    assert.equal(report.rows[0].recommendation.decision, 'scale');
  } finally {
    f.close();
  }
});

test('a window ending in the future is partial and its advice waits, for a non-conversion objective too', async () => {
  const f = metaFixture();
  try {
    const today = Date.now(),
      report = await f.run(f.config({since: iso(today - 30 * 86400000), until: iso(today + 30 * 86400000)}));
    // Before RPT-02: state complete, decision scale.
    assert.equal(report.state, 'partial');
    assert.equal(report.sources[0].complete, false);
    assert.equal(report.sources[0].collection_complete, true, 'Every page was still collected');
    assert.equal(report.sources[0].open_window, true);
    assert.equal(report.sources[0].quality.open_window, true);
    assert.equal(report.sources[0].quality.window_timezone_basis, 'source_timezone');
    assert.ok(report.sources[0].warnings.some(w => /in-progress day/.test(w)));
    assert.equal(report.rows[0].objective_group, 'traffic');
    assert.equal(report.rows[0].recommendation.decision, 'wait');
    assert.match(report.rows[0].recommendation.reason, /has not ended in the source time zone/);
  } finally {
    f.close();
  }
});

test('"today" is judged in the account time zone: a UTC-closed day can still be open in New York', async t => {
  // 02:00 UTC on 8 September is 22:00 on 7 September in New York.
  clock(t, '2026-09-08T02:00:00Z');
  for (const [timezone, state, decision] of [
    ['UTC', 'complete', 'scale'],
    ['America/New_York', 'partial', 'wait'],
  ]) {
    const f = metaFixture(timezone);
    try {
      const report = await f.run(f.config({since: '2026-09-01', until: '2026-09-07'}));
      assert.equal(report.state, state, timezone);
      assert.equal(report.rows[0].recommendation.decision, decision, timezone);
      if (state === 'partial') assert.equal(report.sources[0].quality.window_closes_at, '2026-09-08T04:00:00.000Z');
    } finally {
      f.close();
    }
  }
});

test('an unknown account time zone keeps the latest day open until it has ended everywhere', async t => {
  clock(t, '2026-09-08T06:00:00Z');
  const f = metaFixture(null);
  try {
    const report = await f.run(f.config({since: '2026-09-01', until: '2026-09-07'}));
    assert.equal(report.state, 'partial');
    assert.equal(report.sources[0].quality.window_timezone_basis, 'unknown_timezone');
    assert.equal(report.sources[0].quality.window_closes_at, '2026-09-08T12:00:00.000Z');
    assert.equal(report.rows[0].recommendation.decision, 'wait');
  } finally {
    f.close();
  }
  assert.equal(reportWindowState({until: '2026-09-07'}, null, Date.parse('2026-09-08T12:00:00Z')).open, false);
  assert.equal(reportWindowState({until: '2026-09-07'}, 'Not/AZone', Date.parse('2026-09-08T11:59:59Z')).open, true);
  // A closed source keeps its exact original shape.
  const closed = {date_range: {since: '2026-09-01', until: '2026-09-07'}, timezone: 'UTC', complete: true};
  assert.equal(markReportWindow(closed, Date.parse('2026-09-08T00:00:00Z')), closed);
});

test('the UTC+3 / US instant: a Riyadh "yesterday" still in progress in Los Angeles is held, or resolved per source', async t => {
  // 22:30 UTC on 7 September: 01:30 on 8 September in Riyadh, 15:30 on 7 September in Los Angeles.
  clock(t, '2026-09-07T22:30:00Z');
  const rolling = {preset: 'last_complete_days', days: 1, timezone: 'Asia/Riyadh'};
  const f = metaFixture('America/Los_Angeles');
  try {
    const held = await f.run(f.config(rolling));
    assert.equal(held.config.date_range.until, '2026-09-07');
    assert.equal(held.state, 'partial', 'Before RPT-02 this in-progress day was labelled complete');
    assert.equal(held.rows[0].recommendation.decision, 'wait');
    assert.equal(held.sources[0].quality.window_closes_at, '2026-09-08T07:00:00.000Z');

    // Owner policy P6, opt-in: the same frozen instant resolved in the account's own day boundary.
    const before = f.requests.length,
      perSource = await f.run(f.config({...rolling, source_timezone: 'account'}));
    assert.equal(perSource.state, 'complete', JSON.stringify(perSource.sources));
    assert.equal(perSource.config.date_range.until, '2026-09-07', 'The report-level window is unchanged');
    assert.deepEqual(perSource.sources[0].date_range, {since: '2026-09-06', until: '2026-09-06'});
    assert.deepEqual(perSource.sources[0].window_resolution, {
      basis: 'account_timezone',
      timezone: 'America/Los_Angeles',
    });
    assert.equal(perSource.rows[0].date_from, '2026-09-06');
    assert.equal(perSource.rows[0].date_to, '2026-09-06');
    assert.equal(perSource.rows[0].recommendation.decision, 'scale');
    // One bounded account read resolves the zone; the collector still re-reads and re-checks the account.
    assert.equal(f.requests.length - before, 3);

    // Schedule previews read no provider and show when every source's window closes.
    const sent = f.requests.length;
    const preview = await f.overview.handle(
      {
        action: 'preview_schedule',
        config: f.config(rolling),
        schedule: {schedule_kind: 'daily', schedule_config: {hour: 1, minute: 30}, timezone: 'Asia/Riyadh'},
      },
      f.actor,
    );
    assert.equal(f.requests.length, sent);
    const first = preview.occurrences[0];
    assert.equal(first.delivery_at, '2026-09-08T22:30:00.000Z');
    assert.deepEqual(first.date_range, {since: '2026-09-08', until: '2026-09-08'});
    assert.deepEqual(first.sources[0], {
      platform: 'meta',
      account_id: '100',
      timezone: 'America/Los_Angeles',
      timezone_basis: 'last_observed',
      date_range: {since: '2026-09-08', until: '2026-09-08'},
      window_closes_at: '2026-09-09T07:00:00.000Z',
      open_at_delivery: true,
    });
    const perSourcePreview = await f.overview.handle(
      {
        action: 'preview_schedule',
        config: f.config({...rolling, source_timezone: 'account'}),
        schedule: {schedule_kind: 'daily', schedule_config: {hour: 1, minute: 30}, timezone: 'Asia/Riyadh'},
      },
      f.actor,
    );
    assert.equal(perSourcePreview.occurrences[0].source_timezone, 'account');
    assert.deepEqual(perSourcePreview.occurrences[0].sources[0].date_range, {since: '2026-09-07', until: '2026-09-07'});
    assert.equal(perSourcePreview.occurrences[0].sources[0].open_at_delivery, false);
  } finally {
    f.close();
  }
});

test('the per-source policy is explicit and validated; fixed collector zones need no account read', () => {
  for (const source_timezone of ['source', '', null])
    assert.throws(
      () => resolveReportConfig({date_range: {preset: 'last_complete_week', timezone: 'UTC', source_timezone}}),
      {code: 'INVALID_ROLLING_WINDOW'},
    );
  assert.throws(
    () => resolveReportConfig({date_range: {since: '2026-09-01', until: '2026-09-02', source_timezone: 'account'}}),
    {code: 'INVALID_ROLLING_WINDOW'},
  );
  const legacy = resolveReportConfig({date_range: {preset: 'last_complete_week', timezone: 'UTC'}}, 0);
  assert.equal(legacy.date_range_rule, undefined, 'Existing rolling windows keep one report time zone');
  const rule = resolveReportConfig(
    {date_range: {preset: 'last_complete_days', days: 7, timezone: 'UTC', source_timezone: 'account'}},
    Date.parse('2026-09-07T22:30:00Z'),
  ).date_range_rule;
  assert.deepEqual(rule, {
    preset: 'last_complete_days',
    days: 7,
    timezone: 'UTC',
    source_timezone: 'account',
    resolved_at: Date.parse('2026-09-07T22:30:00Z'),
  });
});

test('recommendations hold open and declared-incomplete windows before any objective logic', () => {
  const row = {
    source_kind: 'paid',
    complete: true,
    currency: 'USD',
    timezone: 'UTC',
    captured_at: Date.now(),
    objective_group: 'traffic',
    date_to: '2026-09-07',
    metrics: {spend: 10, clicks: 100, cpc: 0.1},
  };
  const policy = {traffic: {target: 1, currency: 'USD'}};
  assert.equal(campaignRecommendation(row, policy).decision, 'scale');
  assert.equal(
    campaignRecommendation({...row, quality: {open_window: true, window_closes_at: 'x'}}, policy).decision,
    'wait',
  );
  for (const quality of [{reporting_window_declared_complete: false}, {measurement_complete: false}])
    assert.equal(campaignRecommendation({...row, quality}, policy).decision, 'needs_review');
  assert.equal(campaignRecommendation({...row, quality: {measurement_complete: null}}, policy).decision, 'scale');
});

test('Search Console top-row coverage is a scope flag, not a partial snapshot', async () => {
  const actor = {tenantId: 'completeness-gsc', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 72).toString('base64')),
    site = 'sc-domain:example.com';
  try {
    store.putConnection(
      actor,
      {
        id: 'gsc-login',
        tenantId: actor.tenantId,
        gateway: 'google_search_console_native_action',
        accounts: [site],
        enabled: true,
        label: 'Synthetic Search Console',
        scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
      },
      {accessToken: 'synthetic'},
    );
    const fetcher = async raw => {
      const url = new URL(String(raw));
      assert.ok(url.pathname.endsWith('/searchAnalytics/query'), url.pathname);
      return Response.json({
        rows: [{keys: ['https://example.com/'], clicks: 12, impressions: 300, ctr: 0.04, position: 3.5}],
      });
    };
    const service = new MirrorService(new Registry(), store, new NativeTransport(fetcher, async () => {})),
      overview = new ReportingOverview(service, async () => {
        throw Error('Unexpected Google Sheets request');
      }),
      worker = new ReportWorker(
        store,
        async () => ({}),
        (tenant, kind, input) => overview.work(tenant, kind, input),
      );
    const queued = await overview.handle(
      {
        action: 'run',
        confirmed: true,
        config: {
          name: 'Organic context',
          sources: [{platform: 'gsc', connection_id: 'gsc-login', account_id: site}],
          date_range: {since: '2026-09-01', until: '2026-09-07'},
          metrics: ['clicks', 'impressions'],
          custom_metrics: [],
        },
      },
      actor,
    );
    assert.equal(await worker.once(), true);
    const report = await overview.handle({action: 'get', id: queued.id}, actor);
    // Before RPT-02 every Search Console source forced a permanently partial snapshot.
    assert.equal(report.state, 'complete', JSON.stringify(report.sources));
    assert.deepEqual(report.sources[0].scope_limitations, ['search_console_top_rows']);
    assert.deepEqual(report.rows[0].quality.scope_limitations, ['search_console_top_rows']);
    assert.equal(report.rows[0].recommendation.decision, 'observe');
  } finally {
    store.close();
  }
});

async function granularRun(f, config) {
  const queued = await f.overview.handle({action: 'run', config, confirmed: true}, f.actor);
  assert.equal(await f.worker.once(), true);
  return f.overview.handle({action: 'get', id: queued.id}, f.actor);
}
const detailed = complete_window => {
  const source = granularSource('meta', 'ad');
  return {
    ...granularConfig({...source, report_options: {...source.report_options, complete_window}}),
    partial_delivery: 'complete_only',
    targets: {sales: {target: 1, currency: 'USD', minimum_results: 1, conversion_lag_days: 0}},
  };
};

test('a declared-incomplete detail window is partial, held, skipped by complete-only delivery and unavailable to monitors', async () => {
  const f = overviewGranularityFixture();
  try {
    const complete = await granularRun(f, detailed(true));
    assert.equal(complete.state, 'complete', JSON.stringify(complete.sources));
    assert.equal(complete.rows[0].recommendation.decision, 'scale');
    // v3 (RPT-07) keeps v2's declared-incomplete rule and adds native parents to detailed rows.
    assert.equal(complete.sources[0].detail_contract, 'overview-detail-v3');
    const row = complete.rows[0];
    monitorOperation(f.store, f.actor, {
      action: 'save_monitor',
      confirmed: true,
      monitor: {
        name: 'Spend ceiling',
        platform: 'meta',
        connection_id: row.connection_id,
        account_id: row.account_id,
        currency: row.currency,
        timezone: row.timezone,
        result_definition: row.result_definition,
        attribution: row.attribution,
        metric: 'spend',
        comparison: 'above',
        threshold: '50',
        max_age_hours: 24,
      },
    });
    assert.notEqual(evaluateMonitors(f.store, f.actor, complete.id).outcomes[0].status, 'data_unavailable');

    // Before RPT-02 this declared-incomplete window was state complete with decision scale.
    const declared = await granularRun(f, detailed(false));
    assert.equal(declared.state, 'partial');
    assert.equal(declared.sources[0].complete, false);
    assert.equal(declared.sources[0].collection_complete, true);
    assert.equal(declared.sources[0].quality.reporting_window_declared_complete, false);
    assert.equal(declared.rows[0].complete, false);
    assert.equal(declared.rows[0].recommendation.decision, 'needs_review');
    assert.match(declared.rows[0].recommendation.reason, /declared incomplete/);
    assert.ok(declared.sources[0].warnings.some(w => /declared incomplete/.test(w)));
    assert.equal(evaluateMonitors(f.store, f.actor, declared.id).outcomes[0].status, 'data_unavailable');

    const files = await f.overview.handle(
      {
        action: 'bind_file_destination',
        confirmed: true,
        idempotency_key: 'declared-incomplete-files',
        file_destination: {name: 'Synthetic files', formats: ['pdf']},
      },
      f.actor,
    );
    await assert.rejects(
      f.overview.handle({action: 'export', report_id: declared.id, destination_id: files.id, confirmed: true}, f.actor),
      e => e.code === 'PARTIAL_DELIVERY_BLOCKED',
    );
    const sheet = await f.overview.handle(
      {
        action: 'bind_destination',
        connection_id: 'sheets-granular',
        spreadsheet_id: 'syntheticGranularSheet',
        tab_name: 'Declared incomplete',
        idempotency_key: 'declared-incomplete-sheet',
        confirmed: true,
      },
      f.actor,
    );
    const stored = f.store.document(f.actor.tenantId, 'overview_report', declared.id);
    await assert.rejects(
      f.overview.sheets.write(f.actor, sheet.id, {...stored, id: declared.id}),
      e => e.code === 'PARTIAL_DELIVERY_BLOCKED',
    );
    assert.deepEqual(f.tabs.get(7).values, [['KEEP THIS ORIGINAL']]);
  } finally {
    f.close();
  }
});
