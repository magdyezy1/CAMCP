// RPT-07: period-over-period comparison of retained Overview snapshots. Synthetic Meta fixtures only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {compareSnapshots, comparisonEligibility, previousEqualWindow, windowDays} from '../dist/src/report-compare.js';

const actor = {tenantId: 'period-compare', userId: 'owner', role: 'admin'};
const viewer = {tenantId: 'period-compare', userId: 'viewer', role: 'viewer'};

// ---------- pure rules ----------

const snap = (id, since, until, extra = {}) => ({
  id,
  state: 'complete',
  completed_at: 1,
  config: {
    name: 'Report',
    grain: 'total',
    date_range: {since, until},
    sources: [{platform: 'meta', account_id: '100', connection_id: 'm'}],
    metrics: ['spend', 'impressions', 'clicks', 'conversions', 'reach', 'cpa', 'ctr'],
    custom_metrics: [],
    formula_fingerprint: 'f',
    ...extra.config,
  },
  rows: extra.rows ?? [],
  ...Object.fromEntries(Object.entries(extra).filter(([k]) => !['config', 'rows'].includes(k))),
});
const row = (id, since, until, metrics, extra = {}) => ({
  campaign_key: 'meta:100:' + id,
  campaign_id: id,
  campaign_name: 'Campaign ' + id,
  platform: 'meta',
  account_id: '100',
  currency: 'USD',
  timezone: 'UTC',
  attribution: 'ad set unified attribution setting',
  result_definition: 'purchases',
  date_from: since,
  date_to: until,
  complete: true,
  metrics,
  ...extra,
});

test('the previous equal window ends the day before and has the same length', () => {
  assert.deepEqual(previousEqualWindow({since: '2026-08-08', until: '2026-08-14'}), {
    since: '2026-08-01',
    until: '2026-08-07',
  });
  assert.deepEqual(previousEqualWindow({since: '2026-03-01', until: '2026-03-31'}), {
    since: '2026-01-29',
    until: '2026-02-28',
  });
  assert.equal(windowDays({since: '2026-03-01', until: '2026-03-31'}), 31);
});

test('eligibility matrix: only finished, equal-length, earlier, same-grain snapshots with a shared account qualify', () => {
  const current = snap('a', '2026-08-08', '2026-08-14');
  assert.deepEqual(comparisonEligibility(current, snap('b', '2026-08-01', '2026-08-07')), {
    eligible: true,
    reasons: [],
  });
  const cases = [
    [snap('a', '2026-08-01', '2026-08-07'), 'same_snapshot'],
    [snap('b', '2026-08-01', '2026-08-07', {state: 'running', completed_at: undefined}), 'not_finished'],
    [snap('b', '2026-08-01', '2026-08-07', {config: {grain: 'daily'}}), 'grain'],
    [snap('b', '2026-08-01', '2026-08-06'), 'window_length'],
    [snap('b', '2026-08-02', '2026-08-08'), 'window_order'],
    [snap('b', '2026-08-15', '2026-08-21'), 'window_order'],
    [
      snap('b', '2026-08-01', '2026-08-07', {
        config: {sources: [{platform: 'meta', account_id: '999', connection_id: 'm'}]},
      }),
      'no_shared_accounts',
    ],
  ];
  for (const [baseline, reason] of cases) {
    const out = comparisonEligibility(current, baseline);
    assert.equal(out.eligible, false, reason);
    assert.ok(out.reasons.includes(reason), reason + ': ' + out.reasons.join(','));
  }
  assert.throws(
    () => compareSnapshots(current, snap('b', '2026-08-02', '2026-08-08')),
    e => e.code === 'REPORT_COMPARISON_INVALID' && e.details.reasons.includes('window_order'),
  );
});

test('exact additive deltas, recomputed ratios, unknowns and entities in one window only', () => {
  const current = snap('a', '2026-08-08', '2026-08-14', {
      rows: [
        row('c1', '2026-08-08', '2026-08-14', {
          spend: 120.3,
          impressions: 1100,
          clicks: 40,
          conversions: 6,
          reach: 800,
        }),
        row('c2', '2026-08-08', '2026-08-14', {spend: 5, impressions: 10, clicks: 1, conversions: null}),
        row('c4', '2026-08-08', '2026-08-14', {spend: 7, impressions: 7, clicks: 0, conversions: 0}),
        row('c5', '2026-08-08', '2026-08-14', {spend: 1, impressions: 1, clicks: 1, conversions: 1}, {currency: 'EUR'}),
      ],
    }),
    baseline = snap('b', '2026-08-01', '2026-08-07', {
      rows: [
        row('c1', '2026-08-01', '2026-08-07', {
          spend: 100.1,
          impressions: 1000,
          clicks: 50,
          conversions: 5,
          reach: 700,
        }),
        row('c2', '2026-08-01', '2026-08-07', {spend: 4, impressions: 8, clicks: 1, conversions: 2}),
        row('c3', '2026-08-01', '2026-08-07', {spend: 9, impressions: 9, clicks: 9, conversions: 9}),
        row('c4', '2026-08-01', '2026-08-07', {spend: 0, impressions: 0, clicks: 0, conversions: 0}),
        row('c5', '2026-08-01', '2026-08-07', {spend: 1, impressions: 1, clicks: 1, conversions: 1}),
      ],
    });
  const out = compareSnapshots(current, baseline);
  const c1 = out.rows.find(r => r.entity_id === 'c1');
  // 120.3 − 100.1 is exactly 20.2 (never 20.199999999999989), and 20.2 / 100.1 rounds half to even at nine places.
  assert.deepEqual(c1.values.spend, {
    current: '120.3',
    baseline: '100.1',
    delta: '20.2',
    delta_percent: '20.17982018',
  });
  // CPA is recomputed from the window sums (120.3 / 6 and 100.1 / 5), never averaged.
  assert.equal(c1.values.cpa.current, '20.05');
  assert.equal(c1.values.cpa.baseline, '20.02');
  assert.equal(c1.values.cpa.delta, '0.03');
  // Reach over a seven-day window is not a sum of anything: it is excluded, not compared.
  assert.equal(c1.values.reach, undefined);
  assert.deepEqual(out.excluded_metrics, [{metric: 'reach', reason: 'non_additive_multi_day'}]);
  // A missing value stays unknown; a zero baseline has no percentage.
  const c2 = out.rows.find(r => r.entity_id === 'c2');
  assert.equal(c2.values.conversions.delta, null);
  assert.equal(c2.values.spend.delta, '1');
  const c4 = out.rows.find(r => r.entity_id === 'c4');
  assert.equal(c4.values.spend.delta, '7');
  assert.equal(c4.values.spend.delta_percent, null);
  assert.equal(c4.values.spend.reason, 'baseline_zero');
  // A changed currency is incompatible, with the reason; entities in one window are listed, never counted as zero.
  assert.deepEqual(
    out.incompatible.map(r => [r.entity_id, r.reasons]),
    [['c5', ['currency']]],
  );
  assert.deepEqual(
    out.only_current.map(r => r.entity_id),
    [],
  );
  assert.deepEqual(
    out.only_baseline.map(r => r.entity_id),
    ['c3'],
  );
  // Group totals add matched entities only (c1, c2 and c4), never c3 or the EUR row.
  assert.equal(out.group_totals.length, 1);
  assert.equal(out.group_totals[0].entity_count, 3);
  assert.equal(out.group_totals[0].values.spend.current, '132.3');
  assert.equal(out.group_totals[0].values.spend.baseline, '104.1');
  assert.equal(out.group_totals[0].values.conversions.current, null);
  assert.equal(out.network_requests, 0);
  assert.match(out.limitations.join(' '), /does not establish causality/);
});

test('single-day windows compare native reach; grouped periods sum additive values only', () => {
  const day = snap('a', '2026-08-08', '2026-08-08', {
      rows: [row('c1', '2026-08-08', '2026-08-08', {spend: 3, impressions: 30, clicks: 3, conversions: 1, reach: 25})],
    }),
    prior = snap('b', '2026-08-07', '2026-08-07', {
      rows: [row('c1', '2026-08-07', '2026-08-07', {spend: 2, impressions: 20, clicks: 2, conversions: 1, reach: 20})],
    });
  const single = compareSnapshots(day, prior);
  assert.deepEqual(single.excluded_metrics, []);
  assert.equal(single.rows[0].values.reach.delta, '5');
  assert.equal(single.rows[0].values.reach.delta_percent, '25');
  const daily = config => ({config: {grain: 'daily', ...config}});
  const current = snap('a', '2026-08-03', '2026-08-04', {
      ...daily(),
      rows: [
        row('c1', '2026-08-03', '2026-08-03', {spend: 1.1, impressions: 1, clicks: 1, conversions: 1, reach: 1}),
        row('c1', '2026-08-04', '2026-08-04', {spend: 2.2, impressions: 1, clicks: 1, conversions: 1, reach: 1}),
      ],
    }),
    baseline = snap('b', '2026-08-01', '2026-08-02', {
      ...daily(),
      rows: [
        row('c1', '2026-08-01', '2026-08-01', {spend: 1, impressions: 1, clicks: 1, conversions: 1, reach: 1}),
        row('c1', '2026-08-02', '2026-08-02', {spend: 1, impressions: 1, clicks: 1, conversions: 1, reach: 1}),
      ],
    });
  const grouped = compareSnapshots(current, baseline);
  assert.equal(grouped.rows.length, 1);
  assert.equal(grouped.rows[0].values.spend.current, '3.3');
  assert.equal(grouped.rows[0].values.spend.delta, '1.3');
  assert.deepEqual(grouped.rows[0].current_window, {since: '2026-08-03', until: '2026-08-04'});
  assert.ok(grouped.excluded_metrics.some(x => x.metric === 'reach'));
});

test('custom metrics compare only with the same formulas and without native or non-additive inputs', () => {
  const custom = [
    {id: 'cost_per_click_x', label: 'CPC', formula: 'spend / clicks', format: 'currency'},
    {id: 'native_based', label: 'Native', formula: 'spend / native_meta_x', format: 'decimal'},
    {id: 'reach_based', label: 'Reach', formula: 'spend / reach', format: 'decimal'},
  ];
  const rows = (since, until) => [row('c1', since, until, {spend: 10, impressions: 10, clicks: 5, conversions: 1})];
  const current = snap('a', '2026-08-08', '2026-08-14', {
      config: {custom_metrics: custom, metrics: ['spend', 'cost_per_click_x', 'native_based', 'reach_based']},
      rows: rows('2026-08-08', '2026-08-14'),
    }),
    same = snap('b', '2026-08-01', '2026-08-07', {
      config: {custom_metrics: custom},
      rows: rows('2026-08-01', '2026-08-07'),
    });
  const out = compareSnapshots(current, same);
  assert.equal(out.rows[0].values.cost_per_click_x.current, '2');
  assert.deepEqual(out.excluded_metrics.map(x => x.metric + ':' + x.reason).sort(), [
    'native_based:native_or_non_additive_dependency',
    'reach_based:native_or_non_additive_dependency',
  ]);
  const changed = compareSnapshots(current, {...same, config: {...same.config, formula_fingerprint: 'other'}});
  assert.ok(changed.excluded_metrics.every(x => x.reason === 'formula_changed'));
  assert.equal(changed.rows[0].values.cost_per_click_x, undefined);
});

// r25-mf-jobs item 6: a campaign's window was read off its own rows, first day to last, so a campaign with no spend on
// the last day of a window looked one day shorter than the other window and was left out as "incompatible", and one
// with no spend on the first day was compared over other days than the baseline. The window of an entity is what its
// report asked for: its source's own range (an account's time zone), or the report's.
const days = (since, count) =>
  Array.from({length: count}, (_, i) => new Date(Date.parse(since) + i * 86400000).toISOString().slice(0, 10));
const dayRows = (id, dates, extra) =>
  dates.map(date => row(id, date, date, {spend: 1, impressions: 10, clicks: 1, conversions: 1}, extra));
const daily = {config: {grain: 'daily'}};

test('a campaign with no spend on the last day of its window is compared, over the report’s own days', () => {
  const current = snap('a', '2026-08-08', '2026-08-14', {...daily, rows: dayRows('c1', days('2026-08-08', 6))}),
    baseline = snap('b', '2026-08-01', '2026-08-07', {...daily, rows: dayRows('c1', days('2026-08-01', 7))});
  const out = compareSnapshots(current, baseline);
  assert.deepEqual(out.incompatible, [], 'the campaign is not left out');
  assert.equal(out.rows.length, 1);
  assert.deepEqual(out.rows[0].current_window, {since: '2026-08-08', until: '2026-08-14'});
  assert.deepEqual(out.rows[0].baseline_window, {since: '2026-08-01', until: '2026-08-07'});
  assert.deepEqual(
    [out.rows[0].values.spend.current, out.rows[0].values.spend.baseline, out.rows[0].values.spend.delta],
    ['6', '7', '-1'],
    'the totals are the sums of the days it did spend on',
  );
});

test('a campaign idle on the first day of one window and the last of the other is compared over the same seven days', () => {
  const current = snap('a', '2026-08-08', '2026-08-14', {...daily, rows: dayRows('c1', days('2026-08-09', 6))}),
    baseline = snap('b', '2026-08-01', '2026-08-07', {...daily, rows: dayRows('c1', days('2026-08-01', 6))});
  const out = compareSnapshots(current, baseline);
  assert.equal(out.rows.length, 1);
  // Both windows are the whole seven days of their report, not the six days each had a row on (08-09..08-14 against 08-01..08-06).
  assert.deepEqual(out.rows[0].current_window, {since: '2026-08-08', until: '2026-08-14'});
  assert.deepEqual(out.rows[0].baseline_window, {since: '2026-08-01', until: '2026-08-07'});
});

test('the window of a campaign is its source’s own range when the report holds one, and its report’s otherwise', () => {
  const source = {platform: 'meta', account_id: '100', connection_id: 'm'},
    sourceOf = (since, until) => ({source, date_range: {since, until}}),
    withConnection = {connection_id: 'm'};
  const compare = (currentSource, baselineSource) =>
    compareSnapshots(
      snap('a', '2026-08-08', '2026-08-14', {
        ...daily,
        sources: [currentSource],
        rows: dayRows('c1', days('2026-08-08', 6), withConnection),
      }),
      snap('b', '2026-08-01', '2026-08-07', {
        ...daily,
        sources: [baselineSource],
        rows: dayRows('c1', days('2026-08-01', 6), withConnection),
      }),
    );
  // An account whose own window is a day later (its time zone) is compared over that window.
  const zoned = compare(sourceOf('2026-08-09', '2026-08-15'), sourceOf('2026-08-02', '2026-08-08'));
  assert.deepEqual(zoned.rows[0].current_window, {since: '2026-08-09', until: '2026-08-15'});
  assert.deepEqual(zoned.rows[0].baseline_window, {since: '2026-08-02', until: '2026-08-08'});
  // The gate stays: source windows of different lengths, or out of order, are not compared.
  for (const [label, currentSource, baselineSource] of [
    ['different lengths', sourceOf('2026-08-08', '2026-08-14'), sourceOf('2026-08-02', '2026-08-07')],
    ['out of order', sourceOf('2026-08-08', '2026-08-14'), sourceOf('2026-08-04', '2026-08-10')],
  ]) {
    const out = compare(currentSource, baselineSource);
    assert.deepEqual(
      out.incompatible.map(r => [r.entity_id, r.reasons]),
      [['c1', ['window']]],
      label,
    );
    assert.deepEqual(out.rows, [], label);
  }
});

test('the gate before and after: a total-grain campaign whose source windows differ in length or order stays incompatible', () => {
  const source = {platform: 'meta', account_id: '100', connection_id: 'm'},
    snapshot = (id, report, window) =>
      snap(id, ...report, {
        sources: [{source, date_range: {since: window[0], until: window[1]}}],
        rows: [
          row('c1', window[0], window[1], {spend: 1, impressions: 1, clicks: 1, conversions: 1}, {connection_id: 'm'}),
        ],
      });
  for (const [label, baselineWindow] of [
    ['different lengths', ['2026-08-02', '2026-08-07']],
    ['out of order', ['2026-08-04', '2026-08-10']],
  ]) {
    const out = compareSnapshots(
      snapshot('a', ['2026-08-08', '2026-08-14'], ['2026-08-08', '2026-08-14']),
      snapshot('b', ['2026-08-01', '2026-08-07'], baselineWindow),
    );
    assert.deepEqual(
      out.incompatible.map(r => [r.entity_id, r.reasons]),
      [['c1', ['window']]],
      label,
    );
    assert.deepEqual(out.rows, [], label);
  }
  // And equal source windows compare, with their own range as the window.
  const same = compareSnapshots(
    snapshot('a', ['2026-08-08', '2026-08-14'], ['2026-08-09', '2026-08-15']),
    snapshot('b', ['2026-08-01', '2026-08-07'], ['2026-08-02', '2026-08-08']),
  );
  assert.equal(same.rows.length, 1);
  assert.deepEqual(same.rows[0].current_window, {since: '2026-08-09', until: '2026-08-15'});
});

// ---------- Overview integration ----------

const values = {
  // Each campaign's totals per window; c3 delivers only in the baseline window.
  '2026-08-01': {
    c1: {spend: '100.1', impressions: '1000', clicks: '50', purchases: '5'},
    c3: {spend: '9', impressions: '90', clicks: '9', purchases: '1'},
  },
  '2026-08-08': {c1: {spend: '170.3', impressions: '1100', clicks: '40', purchases: '6'}},
};
function fixture({timezone = 'UTC'} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 41).toString('base64'));
  store.putConnection(
    actor,
    {
      id: 'meta-compare',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['ads_read'],
    },
    {accessToken: 'synthetic'},
  );
  const calls = [];
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async raw => {
        const url = new URL(String(raw));
        calls.push(url);
        if (url.pathname.endsWith('/insights')) {
          const range = JSON.parse(url.searchParams.get('time_range'));
          const window = values[range.since] ?? {
            c1: {spend: '1', impressions: '10', clicks: '1', purchases: '1'},
          };
          return Response.json({
            data: Object.entries(window).map(([id, v]) => ({
              account_id: '100',
              campaign_id: id,
              campaign_name: 'Campaign ' + id,
              objective: 'OUTCOME_SALES',
              date_start: range.since,
              date_stop: range.until,
              spend: v.spend,
              impressions: v.impressions,
              clicks: v.clicks,
              reach: '1',
              frequency: '1',
              actions: [{action_type: 'purchase', value: v.purchases}],
            })),
          });
        }
        return Response.json({id: 'act_100', currency: 'USD', timezone_name: timezone});
      },
      async () => {},
    ),
  );
  const overview = new ReportingOverview(service);
  const config = (since = '2026-08-08', until = '2026-08-14') => ({
    name: 'Weekly Meta',
    sources: [{platform: 'meta', account_id: '100', connection_id: 'meta-compare'}],
    date_range: {since, until},
    metrics: ['spend', 'impressions', 'clicks', 'conversions', 'reach', 'cpa'],
    custom_metrics: [],
  });
  const work = id => overview.work(actor.tenantId, 'report_overview', {report_id: id});
  return {store, service, overview, calls, config, work};
}

test('a previous_period run queues a linked equal earlier window, and compare uses the pair', async () => {
  const f = fixture();
  try {
    const queued = await f.overview.handle(
      {action: 'run', config: f.config(), compare: 'previous_period', confirmed: true},
      actor,
    );
    assert.deepEqual(queued.comparison.baseline_date_range, {since: '2026-08-01', until: '2026-08-07'});
    assert.equal(queued.comparison.estimated_requests_total, queued.estimated_requests * 2);
    const baselineDoc = f.store.document(actor.tenantId, 'overview_report', queued.comparison.baseline_id);
    assert.deepEqual(baselineDoc.config.date_range, {since: '2026-08-01', until: '2026-08-07'});
    assert.equal(baselineDoc.comparison.current_id, queued.id);
    // Not comparable until both finish; then a viewer (read-only) may compare.
    await assert.rejects(
      f.overview.handle({action: 'compare', id: queued.id}, actor),
      e => e.code === 'REPORT_NOT_READY',
    );
    await f.work(queued.id);
    await f.work(queued.comparison.baseline_id);
    const before = f.calls.length;
    const out = await f.overview.handle({action: 'compare', id: queued.id}, viewer);
    assert.equal(f.calls.length, before, 'comparison reads retained snapshots only');
    assert.equal(out.paired, true);
    assert.equal(out.baseline.id, queued.comparison.baseline_id);
    const c1 = out.rows.find(r => r.entity_id === 'c1');
    assert.equal(c1.values.spend.delta, '70.2');
    assert.equal(c1.values.conversions.delta, '1');
    assert.deepEqual(
      out.only_baseline.map(r => r.entity_id),
      ['c3'],
    );
    // Candidates list the pair as eligible; an overlapping snapshot is offered disabled with its reason.
    const overlap = await f.overview.handle(
      {action: 'run', config: f.config('2026-08-05', '2026-08-11'), confirmed: true},
      actor,
    );
    await f.work(overlap.id);
    const listed = await f.overview.handle({action: 'compare_candidates', id: queued.id}, viewer);
    const pair = listed.candidates.find(c => c.id === queued.comparison.baseline_id),
      other = listed.candidates.find(c => c.id === overlap.id);
    assert.equal(listed.paired_baseline_id, queued.comparison.baseline_id);
    assert.equal(pair.eligible, true);
    assert.equal(pair.paired, true);
    assert.equal(other.eligible, false);
    assert.deepEqual(
      other.reasons.map(r => r.code),
      ['window_order'],
    );
    await assert.rejects(
      f.overview.handle({action: 'compare', id: queued.id, baseline_id: overlap.id}, viewer),
      e => e.code === 'REPORT_COMPARISON_INVALID',
    );
  } finally {
    f.store.close();
  }
});

test('capture_overview keeps the paired group and analyze uses it as the default baseline', async () => {
  const f = fixture();
  try {
    const queued = await f.overview.handle(
      {action: 'run', config: f.config(), compare: 'previous_period', confirmed: true},
      actor,
    );
    await f.work(queued.id);
    await f.work(queued.comparison.baseline_id);
    const groups = await f.service.call('amcp_reporting', {action: 'overview_sources', id: queued.id}, actor);
    assert.equal(groups.success, true, JSON.stringify(groups));
    const captured = await f.service.call(
      'amcp_reporting',
      {action: 'capture_overview', id: queued.id, group_id: groups.data.groups[0].id},
      actor,
    );
    assert.equal(captured.success, true, JSON.stringify(captured));
    assert.equal(captured.data.pairing.status, 'paired');
    const baselineEvidence = f.store.document(actor.tenantId, 'decision_report', captured.data.pairing.baseline_id);
    assert.equal(baselineEvidence.semantics.date_from, '2026-08-01');
    assert.equal(captured.data.paired_baseline_id, captured.data.pairing.baseline_id);
    const analyzed = await f.service.call('amcp_reporting', {action: 'analyze', id: captured.data.id}, actor);
    assert.equal(analyzed.success, true, JSON.stringify(analyzed));
    assert.equal(analyzed.data.baseline_id, captured.data.pairing.baseline_id);
    assert.equal(analyzed.data.baseline_source, 'paired_previous_period');
    // 170.3 is more than 1.5 × 109.1: the pair feeds the existing spend-anomaly heuristic.
    assert.ok(analyzed.data.recommendations.some(r => r.type === 'spend_anomaly'));
    // A deleted pair is skipped with a stated limitation instead of failing the analysis.
    f.store.deleteDocument(actor.tenantId, 'decision_report', captured.data.pairing.baseline_id);
    const without = await f.service.call('amcp_reporting', {action: 'analyze', id: captured.data.id}, actor);
    assert.equal(without.success, true, JSON.stringify(without));
    assert.equal(without.data.baseline_id, null);
    assert.match(without.data.limitations.join(' '), /paired previous-period baseline could not be used/);
  } finally {
    f.store.close();
  }
});

test('an account-time-zone rolling window pairs each source with the equal window before its own', async () => {
  const f = fixture({timezone: 'Pacific/Kiritimati'});
  try {
    const queued = await f.overview.handle(
      {
        action: 'run',
        config: {
          ...f.config(),
          date_range: {preset: 'last_complete_days', days: 3, timezone: 'UTC', source_timezone: 'account'},
        },
        compare: 'previous_period',
        confirmed: true,
      },
      actor,
    );
    await f.work(queued.id);
    await f.work(queued.comparison.baseline_id);
    const current = await f.overview.handle({action: 'get', id: queued.id}, actor),
      baseline = await f.overview.handle({action: 'get', id: queued.comparison.baseline_id}, actor);
    const window = s => s.sources[0].date_range;
    assert.equal(current.sources[0].window_resolution.basis, 'account_timezone');
    assert.equal(baseline.sources[0].window_resolution.window, 'previous_equal');
    assert.deepEqual(window(baseline), previousEqualWindow(window(current)));
    const out = await f.overview.handle({action: 'compare', id: queued.id}, actor);
    assert.equal(out.rows.length, 1);
    assert.deepEqual(out.rows[0].baseline_window, previousEqualWindow(out.rows[0].current_window));
  } finally {
    f.store.close();
  }
});

test('a previous_period pair counts two queued jobs and is refused as a whole at the queue limit', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 99; i++) f.store.enqueue(actor.tenantId, 'report_overview', {report_id: 'placeholder-' + i});
    const before = f.store.documents(actor.tenantId, 'overview_report').length;
    await assert.rejects(
      f.overview.handle({action: 'run', config: f.config(), compare: 'previous_period', confirmed: true}, actor),
      e => e.code === 'REPORT_QUEUE_FULL',
    );
    assert.equal(f.store.documents(actor.tenantId, 'overview_report').length, before, 'neither snapshot was kept');
    await assert.rejects(
      f.overview.handle({action: 'run', config: f.config(), compare: 'next_period', confirmed: true}, actor),
      e => ['INVALID_REPORT', 'INVALID_ARGUMENT', 'INVALID_INPUT'].includes(e.code),
    );
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
