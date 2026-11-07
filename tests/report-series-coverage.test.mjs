// F-L5-26: the sparkline and the report pack's click-through chart never drew for a v4 report (they tested for JavaScript
// numbers, and a v4 metric is exact decimal text), and a series point lost its coverage, so a week with one unknown
// campaign read "40" beside "60" and "90", a false dip. A point calculated from fewer units than it has now carries
// `coverage`, the pages parse the decimals for display only, and a short point is a hollow mark off the line. The
// snapshots are built by the real engine; the pages are the real scripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {row} from './helpers/report-packets.mjs';
import {reportEngine} from './helpers/report-engine.mjs';
import {reportPage} from './helpers/report-page.mjs';

const range = {since: '2026-09-07', until: '2026-09-27'};
/** Three weeks of three campaigns; in the second week the first campaign has no cost. */
async function threeWeeks(t) {
  const e = reportEngine(t, {rowsFor: () => []}),
    collect = e.overview.native.collect,
    spend = {'2026-09-07': '20', '2026-09-14': '15', '2026-09-21': '30'};
  e.overview.native.collect = async (source, dates) => ({
    ...(await collect(source, dates)),
    rows: ['c1', 'c2', 'c3'].map((id, index) =>
      row('campaign', id, {
        spend: dates.since === '2026-09-14' && index === 0 ? null : spend[dates.since],
        clicks: '5',
      }),
    ),
  });
  const done = await e.go(['campaign'], {metrics: ['spend', 'clicks'], grain: 'weekly', date_range: range});
  return {...done, bootstrap: await e.overview.handle({action: 'bootstrap'}, e.actor)};
}

test('a series point calculated from fewer units than it has carries its coverage, and a whole point carries none', async t => {
  const {report, stored} = await threeWeeks(t);
  assert.equal(report.state, 'complete');
  const [window] = report.window_summary;
  assert.deepEqual(
    window.series.map(point => [
      point.date_from,
      point.spend,
      point.coverage?.known_rows ?? null,
      point.coverage?.total_rows ?? null,
    ]),
    [
      ['2026-09-07', '60', null, null],
      ['2026-09-14', '30', 2, 3],
      ['2026-09-21', '90', null, null],
    ],
  );
  assert.deepEqual(window.series[1].coverage, {known_rows: 2, total_rows: 3, basis: 'report_rows', report_rows: 3});
  // Stored as get returns it; nothing is added to the point of a whole period.
  assert.equal(stored.window_summary[0].series[0].coverage, undefined);
});

for (const locale of ['en', 'ar']) {
  test(locale + ': the sparkline draws a v4 series, leaves the short week off the line and says so', async t => {
    const {report, bootstrap} = await threeWeeks(t),
      view = reportPage(locale, bootstrap),
      svg = view.call('reportSparkline(g)', {g: report.window_summary[0]});
    assert.match(svg, /^<svg class="report-sparkline"/, 'a v4 series is drawn');
    // The two whole weeks are points of their own, with the short week between them outside the line.
    assert.equal((svg.match(/<polyline/g) ?? []).length, 0);
    assert.equal((svg.match(/r="1\.5" fill="currentColor"/g) ?? []).length, 2);
    assert.equal((svg.match(/r="2" fill="none" stroke="currentColor"/g) ?? []).length, 1, 'one hollow mark');
    // The short week does not decide the lowest period: it is 30, the whole weeks are 60 and 90.
    const label = /aria-label="([^"]*)"/.exec(svg)[1].replaceAll('&amp;', '&');
    assert.ok(label.includes('60'), label);
    assert.ok(label.includes('90'), label);
    assert.equal(/\b30\b/.test(label), false, 'the partial 30 is neither the lowest nor the highest');
    assert.ok(
      label.includes(
        view.text('Hollow marks are periods calculated from some of their rows only: {count}.').replace('{count}', '1'),
      ),
      label,
    );
  });
}

test('a series of decimal text with no short period is a line, and a single whole period draws nothing', async t => {
  const {bootstrap} = await threeWeeks(t),
    view = reportPage('en', bootstrap),
    series = spends => ({
      currency: 'USD',
      series: spends.map((spend, index) => ({date_from: `2026-09-0${index + 1}`, spend})),
    });
  const svg = view.call('reportSparkline(g)', {g: series(['10', '30.5', '20.25'])});
  assert.match(svg, /<polyline points="0\.0,34\.0 100\.0,2\.0 200\.0,18\.0"/, 'the numbers the text means');
  assert.equal(view.call('reportSparkline(g)', {g: series(['10'])}), '');
  // Two periods, one of them short: only one whole period, so there is no line to draw.
  const short = series(['10', '30']);
  short.series[1].coverage = {known_rows: 1, total_rows: 2, basis: 'report_rows', report_rows: 2};
  assert.equal(view.call('reportSparkline(g)', {g: short}), '');
  // A text that is not a decimal is a gap, as a null is.
  assert.equal(
    (view.call('reportSparkline(g)', {g: series(['10', 'n/a', '30', '20'])}).match(/<circle/g) ?? []).length,
    1,
  );
});

test('the report pack draws the click-through chart of a v4 report and states the coverage of a short figure', async () => {
  const f = reportPage('en', {platforms: [], metrics: {}}),
    source = readFileSync('web/evidence-workflows.js', 'utf8');
  f.run(source.slice(source.indexOf('function reportPackBody('), source.indexOf('async function renderReportPack(')));
  const summary = {
    platform: 'meta',
    account_id: '100',
    objective_group: 'sales',
    currency: 'USD',
    timezone: 'UTC',
    result_definition: 'purchase',
    attribution: 'unknown',
    complete: true,
    date_from: '2026-09-01',
    date_to: '2026-09-07',
    // v4: every metric is exact decimal text.
    metrics: {spend: '273', impressions: '2800', clicks: '196', conversions: '4', cpa: '68.25', ctr: '7'},
    metrics_coverage: {
      spend: {known_rows: 26, total_rows: 28, basis: 'report_rows', report_rows: 28},
      ctr: {known_rows: 26, total_rows: 28, basis: 'report_rows', report_rows: 28, known_pairs: 26},
    },
  };
  const pack = rows => ({
    title: 'Pack',
    date_range: {since: '2026-09-01', until: '2026-09-07'},
    grain: 'total',
    state: 'complete',
    row_count: 28,
    created_at: 0,
    platform_names: {meta: 'Meta'},
    summary: rows,
    sources: [{platform: 'meta', account_id: '100', complete: true, row_count: 28}],
    limitations: [],
    snapshot_id: 's',
    source_hash: 'h',
  });
  const html = f.call('reportPackBody(pack)', {pack: pack([summary])}),
    plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(html, /<figure>/, 'the chart is drawn for a ratio held as text');
  assert.ok(!html.includes('Click-through rate is unavailable'));
  assert.match(html, /<rect class="pack-bar" width="500"/, 'the only rate fills the scale');
  // The short figures say so beside their values: the spend in the table, the click-through rate beside its bar.
  assert.equal((plain.match(/26 of 28 rows/g) ?? []).length, 2, plain);
  assert.ok(plain.includes('Limited coverage: these totals may be incomplete.'));
  // A pack of whole figures says nothing of coverage.
  const whole = f.call('reportPackBody(pack)', {pack: pack([{...summary, metrics_coverage: {}}])});
  assert.ok(!whole.includes('of 28 rows') && !whole.includes('Limited coverage'));
  // A rolled-up total says what it is.
  const rolled = f.call('reportPackBody(pack)', {
    pack: pack([{...summary, aggregation: {kind: 'rolled_up_from_selected', label: 'Rolled up from selected ads'}}]),
  });
  assert.ok(rolled.includes('Rolled up from selected ads'));
});
