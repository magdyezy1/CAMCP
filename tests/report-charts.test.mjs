// V2-EXP-01: the chart specs the server computes when a snapshot finishes. The renderers only draw them, so everything a
// chart says is decided here and pinned here: what is drawn, what is folded, what is left out and why, and that no chart
// ever mixes a currency or a result definition. The rows are the shapes the real row assembly produces.
import test from 'node:test';
import assert from 'node:assert/strict';
import {reportCharts} from '../dist/src/report-charts.js';
import {chartKinds} from '../dist/src/report-chart-spec.js';
import {chartRow, names, parts, purchaseDefinition, valueDefinition} from './helpers/chart-rows.mjs';

const charts = (rows, more, options = {platformNames: names}) => reportCharts(parts(rows, more), options);
const of = (specs, kind) => specs.filter(spec => spec.kind === kind);
const campaigns = spends =>
  spends.map((spend, index) => chartRow('c' + (index + 1), spend === null ? null : String(spend)));
const texts = spec => spec.notes.map(note => note.text);

test('a definition from before v4, and a snapshot with no rows, have no charts', () => {
  assert.deepEqual(charts(campaigns([10, 20]), {config: {contract_version: undefined}}), []);
  assert.deepEqual(charts([]), []);
});

test('the kinds a report can switch off are the ones the module draws, each once', () => {
  assert.deepEqual(
    chartKinds.map(kind => kind.id),
    ['kpi', 'trend', 'spend_by_entity', 'cost_vs_target', 'spend_by_objective', 'top_ads'],
  );
});

test('spend by campaign: ranked bars from zero, the top ten and the exact sum of the rest as Other', () => {
  const spends = [140, 130, 120, 110, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10],
    [spec, ...more] = of(charts(campaigns([...spends].reverse())), 'spend_by_entity');
  assert.equal(more.length, 0, 'one platform: no platform chart');
  assert.equal(spec.type, 'bar');
  assert.equal(spec.title.text, 'Spend by campaign');
  assert.equal(spec.drawn, true);
  assert.equal(spec.x.kind, 'category');
  assert.equal(spec.x.items.length, 11);
  assert.deepEqual(
    spec.x.items.slice(0, 10).map(item => item.label),
    spends.slice(0, 10).map((_, index) => 'Campaign c' + (14 - index)),
  );
  assert.equal(spec.x.items[10].other, true);
  assert.equal(spec.x.items[10].label, 'Other');
  const [series] = spec.series;
  assert.deepEqual(series.values, ['140', '130', '120', '110', '100', '90', '80', '70', '60', '50', '100']);
  assert.equal(series.unit, 'currency');
  assert.equal(series.currency, 'USD');
  assert.equal(series.color_index, 0, 'spend is the first hue');
  assert.deepEqual(series.label_at, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(spec.scale, {
    min: '0',
    max: '150',
    ticks: ['0', '50', '100', '150'],
    tick_labels: ['0', '50', '100', '150'],
  });
  // The table has the same rows with each share of the exact total (1,050), cut to one place: 140/1050 is 13.33, 100/1050 9.52.
  assert.deepEqual(
    spec.table.columns.map(column => column.label),
    ['Campaign', 'Spend', 'Share of spend'],
  );
  assert.deepEqual(spec.table.rows[0], ['Campaign c14', '140', '13.3']);
  assert.deepEqual(spec.table.rows[10], ['Other', '100', '9.5']);
  assert.equal(spec.table.other, 10);
  assert.equal(spec.takeaway.text, 'The largest share of spend is Campaign c14: 13.3% of 1,050.00 USD.');
  assert.deepEqual(spec.takeaway.params, {name: 'Campaign c14', share: '13.3%', total: '1,050.00 USD'});
  assert.deepEqual(
    spec.notes.map(note => note.text),
    ['The smaller entries are combined as Other: 4.'],
  );
});

test('a short list has no Other', () => {
  const [spec] = of(charts(campaigns([30, 20, 10])), 'spend_by_entity');
  assert.equal(spec.x.items.length, 3);
  assert.ok(spec.x.items.every(item => !item.other));
  assert.deepEqual(spec.notes, []);
});

test('a platform chart appears only when a currency has two platforms, and entries say where they come from', () => {
  const rows = [
    chartRow('a', '50', '1', {platform: 'meta', account_id: '100'}),
    chartRow('b', '30', '1', {platform: 'google', account_id: '200'}),
    chartRow('c', '20', '1', {platform: 'google', account_id: '200'}),
  ];
  const specs = of(charts(rows), 'spend_by_entity'),
    platform = specs.find(spec => spec.title.text === 'Spend by platform'),
    campaign = specs.find(spec => spec.title.text === 'Spend by campaign');
  assert.deepEqual(
    platform.x.items.map(item => item.label),
    ['Google Ads', 'Meta'],
  );
  assert.deepEqual(platform.series[0].values, ['50', '50']);
  assert.equal(platform.takeaway.params.share, '50%');
  assert.deepEqual(
    campaign.x.items.map(item => item.detail),
    ['Meta · 100', 'Google Ads · 200', 'Google Ads · 200'],
  );
});

test('a chart never mixes currencies: each currency has its own chart and a shared note names them', () => {
  const rows = [
    chartRow('a', '50'),
    chartRow('b', '10'),
    chartRow('e', '700', '1', {currency: 'EUR'}),
    chartRow('f', '300', '1', {currency: 'EUR'}),
  ];
  const specs = of(charts(rows), 'spend_by_entity');
  assert.equal(specs.length, 2);
  const byCurrency = Object.fromEntries(specs.map(spec => [spec.context.currency, spec]));
  assert.deepEqual(byCurrency.USD.series[0].values, ['50', '10']);
  assert.deepEqual(byCurrency.EUR.series[0].values, ['700', '300']);
  for (const spec of specs) {
    assert.equal(spec.series[0].currency, spec.context.currency);
    assert.ok(
      texts(spec).includes(
        'Each currency has its own chart (EUR, USD). Amounts in different currencies are never combined.',
      ),
      texts(spec).join(' | '),
    );
  }
  assert.notEqual(specs[0].id, specs[1].id);
});

test('property: whatever the rows, every spend chart holds the rows of one currency and sums them exactly', () => {
  // A small seeded generator keeps the cases the same on every run.
  let seed = 7,
    checked = 0;
  const next = limit => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % limit;
  };
  for (let run = 0; run < 60; run++) {
    const currencies = ['USD', 'EUR', 'SAR', null],
      rows = Array.from({length: 1 + next(40)}, (_, index) =>
        chartRow('c' + next(12), next(7) === 0 ? null : (next(100000) / 100).toFixed(2), '1', {
          currency: currencies[next(4)],
          account_id: String(100 + next(3)),
          campaign_key: 'k' + index + ':' + next(5),
        }),
      ),
      specs = of(charts(rows), 'spend_by_entity').filter(spec => spec.drawn);
    for (const spec of specs) {
      const currency = spec.context.currency;
      assert.ok(currency, 'a chart with no currency is never drawn');
      assert.equal(spec.series[0].currency, currency);
      // The exact sum of this currency's known spend, recomputed from the rows in cents.
      const cents = rows
          .filter(row => row.currency === currency && row.metrics.spend !== null)
          .reduce((sum, row) => sum + BigInt(Math.round(Number(row.metrics.spend) * 100)), 0n),
        shown = spec.series[0].values.reduce(
          (sum, value) => sum + (value === null ? 0n : BigInt(Math.round(Number(value) * 100))),
          0n,
        );
      if (spec.title.text === 'Spend by campaign') {
        assert.equal(shown, cents, 'run ' + run + ' ' + currency);
        checked++;
      }
    }
  }
  assert.ok(checked > 40, 'the generator drew enough charts to mean something: ' + checked);
});

test('spend without a known currency is not charted, and the chart says so', () => {
  const specs = of(
    charts([chartRow('a', '5', '1', {currency: null}), chartRow('b', '9', '1', {currency: null})]),
    'spend_by_entity',
  );
  assert.equal(specs.length, 1);
  assert.equal(specs[0].drawn, false);
  assert.deepEqual(texts(specs[0]), ['Amounts without a known currency are not charted.']);
});

test('a campaign with no spend figure is left out of the bars, never drawn as zero, and the shared coverage helper says how many', () => {
  const [spec] = of(charts(campaigns([30, null, 10])), 'spend_by_entity');
  assert.deepEqual(
    spec.x.items.map(item => item.label),
    ['Campaign c1', 'Campaign c3'],
  );
  assert.deepEqual(spec.series[0].values, ['30', '10']);
  const coverage = spec.notes.find(note => note.kind === 'coverage');
  assert.equal(coverage.text, 'Spend: 2 of 3 rows');
  assert.deepEqual([coverage.metric, coverage.known, coverage.total, coverage.unit], ['spend', 2, 3, 'rows']);
});

test('the coverage a chart reports is the coverage the summary beside it reports, native measurements included', async () => {
  const {reportMetricsSummaryV4, metricSumCoverage} = await import('../dist/src/report-summary.js');
  const native = (spends, id) =>
    chartRow(id, null, '1', {native: {exact_rows: spends.map(spend => ({spend, impressions: '1', clicks: '1'}))}});
  for (const group of [
    campaigns([30, null, 10]),
    [chartRow('a', '5'), native(['1', '2', null], 'b'), native(['4'], 'c')],
    campaigns([1, 2, 3]),
  ])
    assert.deepEqual(metricSumCoverage(group, 'spend'), reportMetricsSummaryV4(group).metrics_coverage.spend);
  // A row built from three daily measurements counts them as units, and the note says "measurements".
  const rows = [chartRow('a', '5'), native(['1', '2', null], 'b')],
    [spec] = of(charts(rows), 'spend_by_entity');
  assert.ok(
    spec.notes.some(
      note => note.kind === 'coverage' && note.unit === 'measurements' && note.text === 'Spend: 3 of 4 measurements',
    ),
  );
});

test('a campaign that spent nothing is a bar of zero, not a gap', () => {
  const [spec] = of(charts(campaigns([30, 0, 10])), 'spend_by_entity');
  assert.deepEqual(spec.series[0].values, ['30', '10', '0']);
  assert.deepEqual(spec.series[0].label_at, [0, 1, 2], 'the zero is labelled too');
  assert.equal(spec.table.rows[2][1], '0');
  assert.equal(spec.table.rows[2][2], '0');
});

test('one entry is not a chart: it is not drawn, and the table has it', () => {
  const [spec] = of(charts(campaigns([30])), 'spend_by_entity');
  assert.equal(spec.drawn, false);
  assert.equal(spec.scale, null);
  assert.deepEqual(texts(spec), ['There is only one entry, so there is nothing to compare. The table has it.']);
  assert.deepEqual(spec.table.rows, [['Campaign c1', '30', '100']]);
});

test('when no spend is known there is nothing to draw, and the table lists the campaigns as unknown', () => {
  const [spec] = of(charts(campaigns([null, null])), 'spend_by_entity');
  assert.equal(spec.drawn, false);
  assert.ok(texts(spec).includes('No value is known, so there is nothing to draw.'), texts(spec).join('|'));
  assert.deepEqual(spec.table.rows, [
    ['Campaign c1', null, null],
    ['Campaign c2', null, null],
  ]);
});

test('a value below zero cannot be drawn from a zero baseline, so the chart is not drawn and the table keeps it', () => {
  const [spec] = of(charts(campaigns([30, -5, 10])), 'spend_by_entity');
  assert.equal(spec.drawn, false);
  assert.equal(spec.scale, null);
  assert.ok(texts(spec).includes('Values below zero cannot be drawn from a zero baseline. The table has them.'));
  assert.deepEqual(
    spec.table.rows.map(row => row[1]),
    ['30', '10', '-5'],
  );
});

test('names from a provider travel unchanged and bounded: the spec is data, the renderers escape it', () => {
  const hostile = '</svg><script>alert(1)</script>',
    long = 'x'.repeat(5000),
    specs = charts([
      chartRow('a', '30', '1', {campaign_name: hostile}),
      chartRow('b', '20', '1', {campaign_name: long}),
      chartRow('c', '10', '1', {campaign_name: 'control\u0007char'}),
    ]),
    [spec] = of(specs, 'spend_by_entity');
  assert.equal(spec.x.items[0].label, hostile);
  assert.equal(spec.table.rows[0][0], hostile);
  assert.equal(spec.takeaway.params.name, hostile);
  assert.equal(spec.x.items[1].label.length, 160);
  assert.ok(spec.x.items[1].label.endsWith('…'));
  assert.equal(spec.x.items[2].label, 'control char');
});

test('a grouped report sums an entity over its periods and counts each campaign once', () => {
  const rows = [
    chartRow('a', '10', '1', {date_from: '2026-09-01', date_to: '2026-09-07', grain: 'weekly'}),
    chartRow('a', '15', '1', {date_from: '2026-09-08', date_to: '2026-09-14', grain: 'weekly'}),
    chartRow('b', '40', '1', {date_from: '2026-09-01', date_to: '2026-09-07', grain: 'weekly'}),
  ];
  const [spec] = of(charts(rows, {config: {grain: 'weekly'}}), 'spend_by_entity');
  assert.deepEqual(
    spec.x.items.map(item => item.label),
    ['Campaign b', 'Campaign a'],
  );
  assert.deepEqual(spec.series[0].values, ['40', '25']);
});

test('only the top level of a source is charted, so a campaign and its ads are never added together', () => {
  const rows = [
    chartRow('a', '100'),
    chartRow('b', '50'),
    chartRow('ad1', '60', '1', {entity_level: 'ad'}),
    chartRow('ad2', '40', '1', {entity_level: 'ad'}),
  ];
  const [spec] = of(charts(rows), 'spend_by_entity');
  assert.deepEqual(spec.series[0].values, ['100', '50']);
  assert.equal(spec.title.text, 'Spend by campaign');
  // A source reported at the ad level only is charted at that level.
  const [ads] = of(
    charts([chartRow('ad1', '60', '1', {entity_level: 'ad'}), chartRow('ad2', '40', '1', {entity_level: 'ad'})]),
    'spend_by_entity',
  );
  assert.equal(ads.title.text, 'Spend by ad');
  assert.deepEqual(ads.series[0].values, ['60', '40']);
});

test('totals rolled up from selected children and native totals never share a chart, and the rolled-up one says what it is', () => {
  const label = 'Rolled up from selected ads',
    rolled = {kind: 'rolled_up', from_level: 'ad', scope_field: 'ad_ids', label},
    rows = [
      chartRow('a', '50', '1', {platform: 'meta', account_id: '100'}),
      chartRow('b', '30', '1', {platform: 'meta', account_id: '100'}),
      chartRow('r1', '9', '1', {platform: 'google', account_id: '200', aggregation: rolled}),
      chartRow('r2', '8', '1', {platform: 'google', account_id: '200', aggregation: rolled}),
    ],
    campaignCharts = of(charts(rows), 'spend_by_entity').filter(spec => spec.title.text === 'Spend by campaign');
  assert.equal(campaignCharts.length, 2);
  const rolledChart = campaignCharts.find(spec => texts(spec).includes(label)),
    native = campaignCharts.find(spec => !texts(spec).includes(label));
  assert.deepEqual(rolledChart.series[0].values, ['9', '8']);
  assert.deepEqual(native.series[0].values, ['50', '30']);
});

// ----- spend and results over time -----
const weeks = ['2026-09-07', '2026-09-14', '2026-09-21'];
const week = (date, id, spend, result = '2', more = {}) =>
  chartRow(id, spend, result, {
    date_from: date,
    date_to: date.replace(/..$/, d => String(Number(d) + 6)),
    grain: 'weekly',
    ...more,
  });
const weekly = (rows, more = {}) => charts(rows, {config: {grain: 'weekly'}, ...more});
/** Three weeks of three campaigns; in the second week the first campaign has no cost. */
const threeWeeks = () =>
  weeks.flatMap((date, index) =>
    ['c1', 'c2', 'c3'].map(id => week(date, id, index === 1 && id === 'c1' ? null : ['20', '15', '30'][index], '4')),
  );
const trendOf = (specs, title) => of(specs, 'trend').find(spec => spec.title.text === title);

test('a total report has no trend, and a grouped report with one period says a trend needs two', () => {
  assert.deepEqual(of(charts(campaigns([10, 20])), 'trend'), []);
  const [spec, ...more] = of(weekly([week(weeks[0], 'a', '10'), week(weeks[0], 'b', '20')]), 'trend');
  assert.equal(more.length, 0);
  assert.equal(spec.drawn, false);
  assert.deepEqual(texts(spec), ['A trend needs at least two periods; this report has 1.']);
});

test('spend over time: a line from zero over the periods, left to right, with the highest whole period said exactly', () => {
  const spec = trendOf(weekly(threeWeeks()), 'Spend over time');
  assert.equal(spec.type, 'line');
  assert.equal(spec.drawn, true);
  assert.deepEqual(spec.context, {currency: 'USD'});
  assert.equal(spec.x.kind, 'time');
  assert.deepEqual(
    spec.x.items.map(item => item.key),
    weeks,
  );
  assert.deepEqual(
    spec.x.items.map(item => item.label),
    weeks,
    'dates are ISO text: Latin digits, left to right',
  );
  const [series] = spec.series;
  assert.deepEqual(series.values, ['60', '30', '90']);
  assert.equal(series.color_index, 0);
  assert.equal(spec.scale.min, '0');
  assert.deepEqual(spec.scale.ticks, ['0', '50', '100']);
  assert.equal(spec.takeaway.text, 'Spend was highest in the period starting 2026-09-21: 90.00 USD.');
  // The peak and the last period are labelled; the other points are not.
  assert.deepEqual(series.label_at, [2]);
});

test('a week with one unknown campaign is a short point, not a dip: it is marked, kept out of the extremes, and the notes say how many', () => {
  const spec = trendOf(weekly(threeWeeks()), 'Spend over time'),
    [series] = spec.series;
  assert.deepEqual(series.short, [null, {known: 2, total: 3, unit: 'rows'}, null]);
  assert.deepEqual(texts(spec), [
    'Hollow marks are periods calculated from some of their rows only: 1.',
    'Spend: 8 of 9 rows',
  ]);
  // The short week (30) would be the lowest if it counted; the takeaway, which names the highest, would not change, so
  // make the short week the highest and see that it is still left out.
  const rows = weeks.flatMap((date, index) =>
      ['c1', 'c2'].map(id => week(date, id, index === 1 ? (id === 'c1' ? '500' : null) : '10', '4')),
    ),
    tall = trendOf(weekly(rows), 'Spend over time');
  assert.deepEqual(tall.series[0].values, ['20', '500', '20']);
  assert.deepEqual(tall.series[0].short.map(Boolean), [false, true, false]);
  assert.equal(
    tall.takeaway.text,
    'Spend was highest in the period starting 2026-09-07: 20.00 USD.',
    'ties go to the first',
  );
  // The table keeps the short week's value and says how many rows stand behind it.
  assert.deepEqual(
    spec.table.columns.map(column => column.label),
    ['Period', 'Spend', 'Rows with a value'],
  );
  assert.deepEqual(spec.table.rows, [
    ['2026-09-07', '60', null],
    ['2026-09-14', '30', '2/3'],
    ['2026-09-21', '90', null],
  ]);
});

test('a period no row of the currency covers is a gap, not zero', () => {
  const rows = [
    week(weeks[0], 'a', '10'),
    week(weeks[2], 'a', '30'),
    week(weeks[0], 'e', '50', '1', {currency: 'EUR'}),
    week(weeks[1], 'e', '99', '1', {currency: 'EUR'}),
  ];
  const specs = of(weekly(rows), 'trend').filter(spec => spec.title.text === 'Spend over time'),
    usd = specs.find(spec => spec.context.currency === 'USD');
  assert.deepEqual(usd.series[0].values, ['10', null, '30']);
  assert.deepEqual(usd.table.rows[1], ['2026-09-14', null]);
  assert.equal(specs.length, 2, 'the euro has its own chart');
  assert.deepEqual(specs.find(spec => spec.context.currency === 'EUR').series[0].values, ['50', '99', null]);
});

test('results over time: one chart per result definition, never added together', () => {
  const rows = weeks.flatMap((date, index) => [
    week(date, 'a', '10', String(index + 1)),
    week(date, 'b', '10', String((index + 1) * 10), {definition: purchaseDefinition}),
  ]);
  const results = of(weekly(rows), 'trend').filter(spec => spec.title.text === 'Results over time');
  assert.equal(results.length, 2);
  const leads = results.find(spec => spec.context.result === 'Leads'),
    purchases = results.find(spec => spec.context.result === 'Purchases');
  assert.deepEqual(leads.series[0].values, ['1', '2', '3']);
  assert.deepEqual(purchases.series[0].values, ['10', '20', '30']);
  assert.equal(leads.series[0].color_index, 1, 'results are the second hue');
  assert.equal(leads.series[0].unit, 'number');
  for (const spec of results)
    assert.ok(
      texts(spec).includes(
        'Each result definition has its own chart (Leads, Purchases). Different results are never added.',
      ),
      texts(spec).join('|'),
    );
  assert.equal(leads.takeaway.text, 'Results were highest in the period starting 2026-09-21: 3.');
});

test('a result counted in money is charted in its currency, and rows with no single definition are counted and left out', () => {
  const rows = [
    ...weeks.map((date, index) => week(date, 'v', '10', String((index + 1) * 100), {definition: valueDefinition})),
    ...weeks.map(date =>
      week(date, 'm', '5', null, {
        result: {metric: null, label: null, value: null, cost_per_result: null, definition_id: null},
        result_context: undefined,
      }),
    ),
  ];
  const [money] = of(weekly(rows), 'trend').filter(spec => spec.title.text === 'Results over time');
  assert.equal(money.series[0].unit, 'currency');
  assert.equal(money.series[0].currency, 'USD');
  assert.equal(money.takeaway.text, 'Results were highest in the period starting 2026-09-21: 300.00 USD.');
  assert.ok(
    texts(money).includes('Rows with no single result definition are left out of this chart: 3.'),
    texts(money).join('|'),
  );
});

test('a trend is not drawn from one known period, and with no known value it says so', () => {
  const one = weekly([week(weeks[0], 'a', '10'), week(weeks[1], 'a', null)]);
  const spend = trendOf(one, 'Spend over time');
  assert.equal(spend.drawn, false);
  assert.ok(
    texts(spend).includes('There is only one entry, so there is nothing to compare. The table has it.'),
    texts(spend).join('|'),
  );
  assert.deepEqual(spend.table.rows, [
    ['2026-09-07', '10'],
    ['2026-09-14', null],
  ]);
  const none = trendOf(weekly([week(weeks[0], 'a', null), week(weeks[1], 'a', null)]), 'Spend over time');
  assert.equal(none.drawn, false);
  assert.ok(texts(none).includes('No value is known, so there is nothing to draw.'));
});

test('a trend is not charted for spend without a known currency', () => {
  const rows = weeks.map(date => week(date, 'a', '10', '1', {currency: null}));
  const specs = of(weekly(rows), 'trend').filter(spec => spec.title.text === 'Spend over time');
  assert.equal(specs.length, 1);
  assert.equal(specs[0].drawn, false);
  assert.deepEqual(texts(specs[0]), ['Amounts without a known currency are not charted.']);
});

// ----- cost per result against target -----
const target = (value, more = {}) => ({target: value, currency: 'USD', ...more});
/** Three leads campaigns: 100 spent for 10, 5 and 3 results, so a cost of 10, 20 and 30. */
const costRows = (more = {}) => [
  chartRow('c1', '100', '10', more),
  chartRow('c2', '100', '5', more),
  chartRow('c3', '90', '3', more),
];
const costOf = (specs, index = 0) => of(specs, 'cost_vs_target')[index];

test('cost per result against target: bars from zero with the target marked on each, worst first', () => {
  const spec = costOf(charts(costRows(), {config: {targets: {leads: target(12.5)}}}));
  assert.equal(spec.type, 'bar');
  assert.equal(spec.title.text, 'Cost per result against target');
  assert.equal(spec.drawn, true);
  assert.deepEqual(
    spec.x.items.map(item => item.label),
    ['Campaign c3', 'Campaign c2', 'Campaign c1'],
  );
  const [series] = spec.series;
  assert.deepEqual(series.values, ['30', '20', '10']);
  assert.deepEqual(series.targets, ['12.5', '12.5', '12.5']);
  assert.equal(series.color_index, 2, 'cost per result is the third hue, so it is labelled');
  assert.deepEqual(series.label_at, [0, 1, 2]);
  assert.deepEqual(spec.scale.ticks, ['0', '10', '20', '30']);
  assert.equal(spec.takeaway.text, 'Campaigns at or under their target cost per result: 1 of 3.');
  assert.deepEqual(
    spec.table.columns.map(column => column.label),
    ['Campaign', 'Cost per result', 'Target', 'Against target'],
  );
  assert.deepEqual(spec.table.rows, [
    ['Campaign c3', '30', '12.5', 'Over target'],
    ['Campaign c2', '20', '12.5', 'Over target'],
    ['Campaign c1', '10', '12.5', 'At or under target'],
  ]);
});

test('the scale holds a target above every cost, so a mark is never off the chart', () => {
  const spec = costOf(charts(costRows(), {config: {targets: {leads: target(100)}}}));
  assert.deepEqual(spec.scale.ticks, ['0', '50', '100']);
  assert.equal(spec.takeaway.text, 'Campaigns at or under their target cost per result: 3 of 3.');
});

test('a campaign target beats a currency target, which beats an objective target', () => {
  const targets = {leads: target(100), 'leads:USD': target(15), 'meta:100:c1': target(5)},
    spec = costOf(charts(costRows(), {config: {targets}})),
    byName = Object.fromEntries(spec.x.items.map((item, index) => [item.label, spec.series[0].targets[index]]));
  assert.deepEqual(byName, {'Campaign c1': '5', 'Campaign c2': '15', 'Campaign c3': '15'});
});

test('a target that cannot be compared (another currency, another KPI) is no target, as the recommendation holds it', () => {
  const targets = {
      leads: target(100),
      'meta:100:c2': target(5, {currency: 'EUR'}),
      'meta:100:c3': target(5, {kpi: 'cpa'}),
    },
    spec = costOf(charts(costRows(), {config: {targets}}));
  assert.deepEqual(
    spec.x.items.map(item => item.label),
    ['Campaign c1'],
    'c2 and c3 have a target of their own that cannot be used',
  );
  assert.deepEqual(spec.series[0].targets, ['100']);
});

test('with no target there is no chart, and the omitted chart says why', () => {
  const specs = of(charts(costRows()), 'cost_vs_target');
  assert.equal(specs.length, 1);
  assert.equal(specs[0].drawn, false);
  assert.deepEqual(texts(specs[0]), [
    'No campaign has a cost per result target, so there is nothing to compare costs with.',
  ]);
  // A target in another currency or for another KPI is no target here.
  const wrong = of(
    charts(costRows(), {config: {targets: {leads: target(5, {currency: 'EUR'}), sales: target(9)}}}),
    'cost_vs_target',
  );
  assert.equal(wrong[0].drawn, false);
});

test('an objective target is not applied across result definitions: only a campaign’s own target compares unlike results', () => {
  const rows = [...costRows(), chartRow('p1', '50', '5', {definition: purchaseDefinition})];
  const specs = of(charts(rows, {config: {targets: {leads: target(12.5)}}}), 'cost_vs_target');
  assert.equal(specs.length, 1);
  assert.equal(
    specs[0].drawn,
    false,
    'the leads objective holds two result definitions, so its target compares neither',
  );
  const own = of(
    charts(rows, {config: {targets: {leads: target(12.5), 'meta:100:p1': target(8)}}}),
    'cost_vs_target',
  ).filter(spec => spec.drawn);
  assert.equal(own.length, 1);
  assert.deepEqual(
    own[0].x.items.map(item => item.label),
    ['Campaign p1'],
  );
  assert.equal(own[0].context.result, 'Purchases');
});

test('a campaign with a target and no cost is a gap in the chart and "unknown" in the table, never zero', () => {
  const rows = [chartRow('c1', '100', '10'), chartRow('c2', '100', null), chartRow('c3', '100', '0')],
    spec = costOf(charts(rows, {config: {targets: {leads: target(15)}}}));
  assert.deepEqual(
    spec.x.items.map(item => item.label),
    ['Campaign c1', 'Campaign c2', 'Campaign c3'],
  );
  assert.deepEqual(spec.series[0].values, ['10', null, null]);
  assert.deepEqual(
    spec.table.rows.map(row => row.slice(1)),
    [
      ['10', '15', 'At or under target'],
      [null, '15', null],
      [null, '15', null],
    ],
  );
  assert.equal(spec.takeaway.text, 'Campaigns at or under their target cost per result: 1 of 1.');
});

test('a result counted in money has no cost per result, so there is no such chart for it at all', () => {
  const rows = [
    chartRow('v1', '10', '100', {definition: valueDefinition}),
    chartRow('v2', '10', '50', {definition: valueDefinition}),
  ];
  assert.deepEqual(of(charts(rows, {config: {targets: {leads: target(15)}}}), 'cost_vs_target'), []);
});

test('different result definitions are different charts, and each says so', () => {
  const rows = [
      ...costRows(),
      chartRow('p1', '50', '5', {definition: purchaseDefinition}),
      chartRow('p2', '50', '2', {definition: purchaseDefinition}),
    ],
    targets = {
      'meta:100:c1': target(12.5),
      'meta:100:c2': target(12.5),
      'meta:100:p1': target(8),
      'meta:100:p2': target(30),
    },
    specs = of(charts(rows, {config: {targets}}), 'cost_vs_target').filter(spec => spec.drawn);
  assert.equal(specs.length, 2);
  assert.deepEqual(specs.map(spec => spec.context.result).sort(), ['Leads', 'Purchases']);
  const purchases = specs.find(spec => spec.context.result === 'Purchases');
  assert.deepEqual(purchases.series[0].values, ['25', '10']);
  for (const spec of specs)
    assert.ok(
      texts(spec).includes(
        'Each result definition has its own chart (Leads, Purchases). Different results are never added.',
      ),
      texts(spec).join('|'),
    );
});

test('over several periods a campaign’s cost is its spend over its results, counting only the periods that have both', () => {
  const rows = [
    week(weeks[0], 'a', '50', '5'),
    week(weeks[1], 'a', '50', '5'),
    week(weeks[2], 'a', '80', null),
    week(weeks[0], 'b', '30', '3'),
    week(weeks[1], 'b', '60', '3'),
  ];
  const spec = costOf(weekly(rows, {config: {targets: {leads: target(12)}}}));
  assert.deepEqual(
    spec.x.items.map(item => item.label),
    ['Campaign b', 'Campaign a'],
  );
  // b: 90 over 6 is 15. a: 100 over 10 is 10; the third period has no result, so its 80 is not counted.
  assert.deepEqual(spec.series[0].values, ['15', '10']);
  assert.equal(spec.takeaway.text, 'Campaigns at or under their target cost per result: 1 of 2.');
});

test('a cost shown is exact: a third of a unit is nine places, not a float', () => {
  const rows = [
      week(weeks[0], 'a', '10', '3'),
      week(weeks[1], 'a', '10', '3'),
      week(weeks[0], 'b', '40', '4'),
      week(weeks[1], 'b', '40', '4'),
    ],
    spec = costOf(weekly(rows, {config: {targets: {leads: target(5)}}}));
  // a: 20 over 6 results; b: 80 over 8.
  assert.deepEqual(spec.series[0].values, ['10', '3.333333333']);
});

test('only the ten campaigns with the most spend are shown, and the chart says how many', () => {
  const rows = Array.from({length: 13}, (_, index) => chartRow('c' + (index + 1), String(100 + index), '10')),
    spec = costOf(charts(rows, {config: {targets: {leads: target(50)}}}));
  assert.equal(spec.x.items.length, 10);
  assert.ok(
    !spec.x.items.some(item => ['Campaign c1', 'Campaign c2', 'Campaign c3'].includes(item.label)),
    'the three smallest are out',
  );
  assert.ok(
    texts(spec).includes('Only the 10 entries with the most spend are shown. The report table has the rest.'),
    texts(spec).join('|'),
  );
});

// ----- spend by objective -----
const withObjective = (id, group, spend, more = {}) => chartRow(id, spend, '1', {objective_group: group, ...more});
const objectiveRows = () => [
  withObjective('s1', 'sales', '100', {platform: 'meta', account_id: '100'}),
  withObjective('l1', 'leads', '60', {platform: 'meta', account_id: '100'}),
  withObjective('t1', 'traffic', '30', {platform: 'meta', account_id: '100'}),
  withObjective('a1', 'awareness', '10', {platform: 'meta', account_id: '100'}),
  withObjective('s2', 'sales', '40', {platform: 'google', account_id: '200'}),
  withObjective('l2', 'leads', '20', {platform: 'google', account_id: '200'}),
  withObjective('t2', 'traffic', '20', {platform: 'google', account_id: '200'}),
];
const objectiveOf = (specs, index = 0) => of(specs, 'spend_by_objective')[index];

test('spend by objective: a stacked bar per platform, the three largest objectives and the rest as Other', () => {
  const spec = objectiveOf(charts(objectiveRows()));
  assert.equal(spec.type, 'stacked_bar');
  assert.equal(spec.title.text, 'Spend by objective');
  assert.equal(spec.drawn, true);
  assert.deepEqual(
    spec.x.items.map(item => item.label),
    ['Meta', 'Google Ads'],
    'the larger platform first',
  );
  assert.deepEqual(
    spec.series.map(series => series.name),
    ['Sales', 'Leads', 'Traffic', 'Other'],
  );
  assert.deepEqual(
    spec.series.map(series => series.name_kind),
    ['label', 'label', 'label', 'label'],
  );
  assert.deepEqual(
    spec.series.map(series => series.values),
    [
      ['100', '40'],
      ['60', '20'],
      ['30', '20'],
      ['10', null],
    ],
  );
  assert.deepEqual(spec.scale.ticks, ['0', '50', '100', '150', '200'], 'the scale holds the tallest stack');
  assert.equal(spec.series[3].color_index, null, 'Other is the neutral');
  const colours = spec.series.slice(0, 3).map(series => series.color_index);
  assert.equal(new Set(colours).size, 3, 'three objectives, three hues');
  assert.equal(spec.takeaway.text, 'The largest share of spend is Sales: 50% of 280.00 USD.');
  assert.deepEqual(spec.takeaway.labels, ['name'], 'Sales is a name AMCP wrote, so a renderer translates it');
  assert.deepEqual(
    spec.table.columns.map(column => column.label),
    ['Platform', 'Sales', 'Leads', 'Traffic', 'Other', 'Total'],
  );
  assert.deepEqual(spec.table.rows, [
    ['Meta', '100', '60', '30', '10', '200'],
    ['Google Ads', '40', '20', '20', null, '80'],
  ]);
  assert.deepEqual(texts(spec), ['The smaller entries are combined as Other: 1.']);
});

test('colour follows the objective: a filter that removes one does not repaint the others, and two never share a hue', async () => {
  const {chartColorIndex} = await import('../dist/src/report-chart-scale.js');
  const groups = ['awareness', 'traffic', 'engagement', 'video_views', 'leads', 'sales', 'app_installs', 'unknown'],
    rows = groups.map((group, index) => withObjective(group, group, String(100 - index * 10)));
  for (let a = 0; a < groups.length; a++)
    for (let b = a + 1; b < groups.length; b++)
      for (let c = b + 1; c < groups.length; c++) {
        const three = [groups[a], groups[b], groups[c]],
          spec = objectiveOf(charts(rows.filter(row => three.includes(row.objective_group))));
        assert.equal(
          new Set(spec.series.map(series => series.color_index)).size,
          3,
          three.join(' ') + ' have distinct hues',
        );
        // A series keeps its home hue unless another of the three wants it.
        if (new Set(three.map(chartColorIndex)).size === 3)
          for (const series of spec.series) assert.equal(series.color_index, chartColorIndex(series.key), series.key);
      }
  // Three objectives with three home hues: removing one repaints neither of the others.
  const distinct = groups.filter(
    (group, index) => groups.findIndex(other => chartColorIndex(other) === chartColorIndex(group)) === index,
  );
  assert.equal(distinct.length, 3);
  const hue = (spec, key) => spec.series.find(series => series.key === key).color_index,
    all = objectiveOf(charts(rows.filter(row => distinct.includes(row.objective_group)))),
    fewer = objectiveOf(charts(rows.filter(row => distinct.slice(0, 2).includes(row.objective_group))));
  for (const key of distinct.slice(0, 2)) assert.equal(hue(fewer, key), hue(all, key), key);
});

test('more than three objectives fold the rest into Other, per platform, exactly', () => {
  const rows = [
    ...objectiveRows(),
    withObjective('e1', 'engagement', '5', {platform: 'google', account_id: '200'}),
    withObjective('e2', 'app_installs', '2', {platform: 'google', account_id: '200'}),
  ];
  const spec = objectiveOf(charts(rows)),
    other = spec.series.at(-1);
  assert.equal(other.name, 'Other');
  assert.deepEqual(other.values, ['10', '7'], 'awareness 10 on Meta; engagement 5 and app installs 2 on Google');
  assert.deepEqual(texts(spec), ['The smaller entries are combined as Other: 3.']);
});

test('one objective is nothing to compare, and a chart never mixes currencies', () => {
  const [one] = of(charts([withObjective('a', 'sales', '5'), withObjective('b', 'sales', '6')]), 'spend_by_objective');
  assert.equal(one.drawn, false);
  assert.deepEqual(texts(one), ['All spend is on one objective, so there is nothing to compare.']);
  const rows = [
    withObjective('a', 'sales', '5'),
    withObjective('b', 'leads', '6'),
    withObjective('c', 'sales', '50', {currency: 'EUR'}),
    withObjective('d', 'leads', '60', {currency: 'EUR'}),
  ];
  const specs = of(charts(rows), 'spend_by_objective');
  assert.equal(specs.length, 2);
  for (const spec of specs) assert.equal(spec.series[0].currency, spec.context.currency);
  // Leads are the larger objective in each, so they come first.
  assert.deepEqual(
    Object.fromEntries(specs.map(spec => [spec.context.currency, spec.series.flatMap(series => series.values)])),
    {USD: ['6', '5'], EUR: ['60', '50']},
  );
});

test('only the top level of a source is added up by objective', () => {
  const rows = [
    withObjective('a', 'sales', '10'),
    withObjective('b', 'leads', '20'),
    withObjective('ad1', 'sales', '10', {entity_level: 'ad'}),
    withObjective('ad2', 'leads', '20', {entity_level: 'ad'}),
  ];
  const spec = objectiveOf(charts(rows));
  assert.deepEqual(
    spec.series.flatMap(series => series.values),
    ['20', '10'],
  );
});

// ----- top ads by result -----
const ad = (id, result, more = {}) => chartRow(id, '10', result, {entity_level: 'ad', ...more});
const adsOf = (specs, index = 0) => of(specs, 'top_ads')[index];

test('top ads by result: ranked bars from zero of the ads with the most results, with no picture until previews supply one', () => {
  const spec = adsOf(charts([chartRow('c1', '50', '9'), ad('a1', '5'), ad('a2', '30'), ad('a3', '12')]));
  assert.equal(spec.type, 'bar');
  assert.equal(spec.title.text, 'Top ads by result');
  assert.equal(spec.drawn, true);
  assert.deepEqual(
    spec.x.items.map(item => item.label),
    ['Entity a2', 'Entity a3', 'Entity a1'],
  );
  assert.ok(
    spec.x.items.every(item => !Object.hasOwn(item, 'thumbnail')),
    'a thumbnail joins in round 3',
  );
  assert.deepEqual(spec.series[0].values, ['30', '12', '5']);
  assert.equal(spec.series[0].color_index, 1);
  assert.equal(spec.series[0].unit, 'number');
  assert.deepEqual(spec.scale.ticks, ['0', '10', '20', '30']);
  assert.equal(spec.takeaway.text, 'The ad with the most results is Entity a2: 30.');
  assert.deepEqual(
    spec.table.columns.map(column => column.label),
    ['Ad', 'Results'],
  );
  assert.deepEqual(spec.table.rows, [
    ['Entity a2', '30'],
    ['Entity a3', '12'],
    ['Entity a1', '5'],
  ]);
});

test('top ads shows ten at most; a report without ad rows says so; one ad is nothing to rank', () => {
  const many = Array.from({length: 14}, (_, index) => ad('a' + (index + 1), String(index + 1))),
    spec = adsOf(charts(many));
  assert.equal(spec.x.items.length, 10);
  assert.deepEqual(spec.series[0].values.slice(0, 3), ['14', '13', '12']);
  const none = adsOf(charts(campaigns([10, 20])));
  assert.equal(none.drawn, false);
  assert.deepEqual(texts(none), ['This report has no ad-level rows.']);
  const single = adsOf(charts([ad('a1', '5')]));
  assert.equal(single.drawn, false);
  assert.deepEqual(single.table.rows, [['Entity a1', '5']]);
});

test('top ads never adds unlike results: one chart per definition, and a result in money is charted in its currency', () => {
  const rows = [
    ad('a1', '5'),
    ad('a2', '9'),
    ad('p1', '7', {definition: purchaseDefinition}),
    ad('p2', '3', {definition: purchaseDefinition}),
    ad('v1', '300', {definition: valueDefinition}),
    ad('v2', '100', {definition: valueDefinition}),
  ];
  const specs = of(charts(rows), 'top_ads').filter(spec => spec.drawn);
  assert.deepEqual(specs.map(spec => spec.context.result).sort(), ['Conversion value', 'Leads', 'Purchases']);
  const money = specs.find(spec => spec.context.result === 'Conversion value');
  assert.equal(money.series[0].unit, 'currency');
  assert.equal(money.series[0].currency, 'USD');
  assert.equal(money.takeaway.text, 'The ad with the most results is Entity v1: 300.00 USD.');
  for (const spec of specs)
    assert.ok(
      texts(spec).some(text =>
        text.startsWith('Each result definition has its own chart (Conversion value, Leads, Purchases).'),
      ),
      spec.context.result,
    );
  assert.deepEqual(specs.find(spec => spec.context.result === 'Leads').series[0].values, ['9', '5']);
});

test('an ad with no result figure is left out and counted in the shared helper’s words; the name stays data', () => {
  const hostile = '</svg><script>alert(1)</script>',
    spec = adsOf(charts([ad('a1', '5', {entity_name: hostile}), ad('a2', null), ad('a3', '2')]));
  assert.deepEqual(
    spec.x.items.map(item => item.label),
    [hostile, 'Entity a3'],
  );
  assert.ok(
    spec.notes.some(note => note.kind === 'coverage' && note.text === 'Results: 2 of 3 rows'),
    texts(spec).join('|'),
  );
  assert.equal(spec.takeaway.params.name, hostile);
});

// ----- key figures -----
const withSummaries = async (rows, more = {}) => {
  const {reportSummary, reportWindowSummary} = await import('../dist/src/report-summary.js'),
    grouped = (more.config?.grain ?? 'total') !== 'total';
  return charts(rows, {
    ...more,
    summary: reportSummary(rows, [], true),
    window_summary: grouped ? reportWindowSummary(rows, [], true) : undefined,
  });
};
const tilesOf = specs => of(specs, 'kpi');
const tile = (spec, key) => spec.series.find(series => series.key === key);

test('key figures: spend, impressions, clicks, results and cost per result of each summary, exact', async () => {
  const [spec, ...more] = tilesOf(await withSummaries(costRows()));
  assert.equal(more.length, 0);
  assert.equal(spec.type, 'kpi');
  assert.equal(spec.title.text, 'Key figures');
  assert.equal(spec.drawn, true);
  assert.deepEqual(
    spec.series.map(series => series.key),
    ['spend', 'impressions', 'clicks', 'primary_result', 'cost_per_result'],
  );
  assert.deepEqual(
    spec.series.map(series => series.name),
    ['Spend', 'Impressions', 'Clicks', 'Results', 'Cost per result'],
  );
  assert.deepEqual(
    spec.series.map(series => series.values),
    [['290'], ['3000'], ['30'], ['18'], ['16.111111111']],
  );
  assert.deepEqual(
    spec.series.map(series => series.unit),
    ['currency', 'number', 'number', 'number', 'currency'],
  );
  assert.equal(tile(spec, 'spend').currency, 'USD');
  assert.deepEqual(spec.context, {
    platform: 'Meta',
    account_id: '100',
    currency: 'USD',
    level: 'campaign',
    objective: 'leads',
    result: 'Leads',
    date_from: '2026-09-01',
    date_to: '2026-09-30',
    compare: {
      platform: 'meta',
      account_id: '100',
      currency: 'USD',
      timezone: 'UTC',
      result_definition: 'Leads',
      attribution: 'Synthetic click window',
      entity_level: 'campaign',
    },
  });
  assert.equal(spec.scale, null);
  assert.equal(spec.takeaway, null);
  assert.deepEqual(
    spec.table.columns.map(column => column.label),
    ['Metric', 'Value', 'Currency'],
  );
  assert.deepEqual(spec.table.rows[0], ['Spend', '290', 'USD']);
  assert.deepEqual(spec.table.rows[1], ['Impressions', '3000', null]);
  assert.ok(
    spec.series.every(series => series.change === undefined),
    'the change is read when the report is, not stored',
  );
});

test('a figure of zero is zero and a figure nobody has is unknown; each says how many rows stand behind it', async () => {
  const rows = [chartRow('a', '0', '4'), chartRow('b', null, '4'), chartRow('c', '10', null)],
    [spec] = tilesOf(await withSummaries(rows));
  assert.deepEqual(tile(spec, 'spend').values, ['10']);
  assert.deepEqual(
    spec.notes.filter(note => note.kind === 'coverage').map(note => note.text),
    ['Spend: 2 of 3 rows', 'Results: 2 of 3 rows', 'Cost per result: 1 of 3 rows'],
  );
  const zero = tilesOf(await withSummaries([chartRow('a', '0', '0'), chartRow('b', '0', '0')]))[0];
  assert.deepEqual(tile(zero, 'spend').values, ['0']);
  assert.deepEqual(tile(zero, 'primary_result').values, ['0']);
  assert.deepEqual(tile(zero, 'cost_per_result').values, [null], 'no results, so no cost per result, not zero');
});

test('results are one definition’s: mixed definitions in a summary have no single figure, and a result in money has no cost', async () => {
  const mixed = tilesOf(
    await withSummaries([chartRow('a', '10', '4'), chartRow('b', '10', '3', {definition: purchaseDefinition})]),
  );
  // Two result definitions are two summaries, each its own tile.
  assert.equal(mixed.length, 2);
  assert.deepEqual(mixed.map(spec => spec.context.result).sort(), ['Leads', 'Purchases']);
  const money = tilesOf(await withSummaries([chartRow('v', '10', '300', {definition: valueDefinition})]))[0];
  assert.equal(tile(money, 'primary_result').unit, 'currency');
  assert.deepEqual(tile(money, 'primary_result').values, ['300']);
  assert.deepEqual(tile(money, 'cost_per_result').values, [null]);
});

test('only the top level of a source has key figures, rolled-up totals say so, and a partial report says so', async () => {
  const rolled = {kind: 'rolled_up', from_level: 'ad', scope_field: 'ad_ids', label: 'Rolled up from selected ads'},
    rows = [chartRow('a', '10', '1', {aggregation: rolled}), chartRow('ad1', '4', '1', {entity_level: 'ad'})],
    specs = tilesOf(await withSummaries(rows, {state: 'partial'}));
  assert.equal(specs.length, 1);
  assert.equal(specs[0].context.level, 'campaign');
  assert.ok(texts(specs[0]).includes('Rolled up from selected ads'));
  assert.ok(
    texts(specs[0]).includes('This report is partial: totals leave out the sources or periods that are missing.'),
  );
});

test('a grouped report’s key figures are its whole-window totals', async () => {
  const rows = weeks.map((date, index) => week(date, 'a', ['10', '20', '30'][index], '1')),
    [spec] = tilesOf(await withSummaries(rows, {config: {grain: 'weekly'}}));
  assert.deepEqual(tile(spec, 'spend').values, ['60']);
  assert.equal(spec.context.date_from, '2026-09-07');
  assert.equal(spec.context.date_to, '2026-09-27');
});

test('twelve groups of key figures are shown at most, and the report says so', async () => {
  const rows = Array.from({length: 14}, (_, index) =>
      chartRow('c' + index, '5', '1', {account_id: String(100 + index)}),
    ),
    specs = tilesOf(await withSummaries(rows));
  assert.equal(specs.length, 12);
  assert.ok(texts(specs.at(-1)).includes('Only the first 12 groups are charted. The report table has the rest.'));
});

test('a snapshot with no summaries has no key figures', () => {
  assert.deepEqual(tilesOf(charts(costRows())), []);
});

// ----- the change since the previous period -----
// A retained snapshot of a window: its rows are for that window, as the comparison requires.
const snapshot = (id, rows, range, completedAt) => ({
  id,
  state: 'complete',
  completed_at: completedAt,
  config: parts(rows, {config: {date_range: range}}).config,
  rows: rows.map(row => ({...row, date_from: range.since, date_to: range.until})),
});
const thisWeek = {since: '2026-09-08', until: '2026-09-14'},
  lastWeek = {since: '2026-09-01', until: '2026-09-07'};
const money = (id, spend, more = {}) =>
  chartRow(id, spend, '1', {
    metrics: {spend, impressions: spend === null ? null : String(Number(spend) * 10), clicks: '5'},
    ...more,
  });
const withChange = async (currentRows, baselineRows, baseline = true, ranges = [thisWeek, lastWeek]) => {
  const {chartsWithChange} = await import('../dist/src/report-charts.js'),
    current = snapshot('cur', currentRows, ranges[0], 2),
    previous = baseline ? snapshot('base', baselineRows, ranges[1], 1) : undefined,
    specs = tilesOf(await withSummaries(currentRows));
  return {before: specs, after: tilesOf(chartsWithChange(specs, current, previous))};
};

test('a key figure’s change is read from the linked baseline: the exact delta and percentage, for the campaigns in both periods', async () => {
  const {before, after} = await withChange(
    [money('a', '120'), money('b', '80')],
    [money('a', '100'), money('b', '50')],
  );
  const spend = tile(after[0], 'spend');
  assert.deepEqual(spend.change, {baseline: '150', delta: '50', delta_percent: '33.333333333'});
  assert.deepEqual(tile(after[0], 'impressions').change, {
    baseline: '1500',
    delta: '500',
    delta_percent: '33.333333333',
  });
  assert.equal(tile(after[0], 'primary_result').change, undefined, 'a result has no comparison here');
  assert.ok(texts(after[0]).includes('The change compares the campaigns and ads that appear in both periods.'));
  // The stored charts are not touched.
  assert.ok(before[0].series.every(series => series.change === undefined));
  assert.equal(
    texts(before[0]).includes('The change compares the campaigns and ads that appear in both periods.'),
    false,
  );
});

test('without a linked baseline, or when the two periods cannot be compared, no change is shown', async () => {
  const none = await withChange([money('a', '120'), money('b', '80')], [], false);
  assert.ok(none.after[0].series.every(series => series.change === undefined));
  // A baseline of another length is not comparable.
  const longer = await withChange([money('a', '120'), money('b', '80')], [money('a', '100'), money('b', '50')], true, [
    thisWeek,
    {since: '2026-08-25', until: '2026-09-07'},
  ]);
  assert.ok(longer.after[0].series.every(series => series.change === undefined));
});

test('a change never crosses a currency: a baseline in another currency is no baseline for the tile', async () => {
  const {after} = await withChange(
    [money('a', '120'), money('b', '80')],
    [money('a', '100', {currency: 'EUR'}), money('b', '50', {currency: 'EUR'})],
  );
  assert.ok(after[0].series.every(series => series.change === undefined));
});

test('a campaign only one period has is not counted in the change, and a zero baseline has no percentage', async () => {
  const {after} = await withChange(
    [money('a', '120'), money('b', '80'), money('new', '1000')],
    [money('a', '100'), money('b', '0')],
  );
  const spend = tile(after[0], 'spend');
  assert.equal(spend.values[0], '1200', 'the tile is the whole window');
  // Matched campaigns only: 200 now against 100 then.
  assert.deepEqual(spend.change, {baseline: '100', delta: '100', delta_percent: '100'});
  const zero = await withChange([money('a', '20')], [money('a', '0')]);
  assert.deepEqual(tile(zero.after[0], 'spend').change, {baseline: '0', delta: '20', delta_percent: null});
});

test('a figure the baseline does not know has no change, and two tiles that share a group get none', async () => {
  const unknown = await withChange([money('a', '120'), money('b', '80')], [money('a', null), money('b', '50')]);
  assert.equal(tile(unknown.after[0], 'spend').change, undefined);
  // Two objectives of one account and currency are two tiles but one comparison group: the change would be both's.
  const two = [money('a', '120', {objective_group: 'sales'}), money('b', '80', {objective_group: 'leads'})];
  const shared = await withChange(two, [
    money('a', '100', {objective_group: 'sales'}),
    money('b', '50', {objective_group: 'leads'}),
  ]);
  assert.equal(shared.after.length, 2);
  assert.ok(shared.after.every(spec => spec.series.every(series => series.change === undefined)));
});

test('a chart that is switched off in the report is not computed, and the others still are', () => {
  assert.equal(of(charts(campaigns([30, 20])), 'spend_by_entity').length, 1, 'on by default');
  const off = charts(campaigns([30, 20]), {config: {charts: {disabled: ['spend_by_entity']}}});
  assert.deepEqual(of(off, 'spend_by_entity'), []);
});

test('a partial snapshot says so on every chart it draws', () => {
  const [spec] = of(charts(campaigns([30, 20]), {state: 'partial'}), 'spend_by_entity');
  assert.ok(texts(spec).includes('This report is partial: totals leave out the sources or periods that are missing.'));
});
