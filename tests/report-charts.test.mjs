// V2-EXP-01: the chart specs the server computes when a snapshot finishes. The renderers only draw them, so everything a
// chart says is decided here and pinned here: what is drawn, what is folded, what is left out and why, and that no chart
// ever mixes a currency or a result definition. The rows are the shapes the real row assembly produces.
import test from 'node:test';
import assert from 'node:assert/strict';
import {reportCharts} from '../dist/src/report-charts.js';
import {chartKinds} from '../dist/src/report-chart-spec.js';
import {chartRow, names, parts} from './helpers/chart-rows.mjs';

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
  assert.deepEqual(texts(specs[0]), ['Spend without a known currency is not charted.']);
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

test('a chart that is switched off in the report is not computed, and the others still are', () => {
  assert.equal(of(charts(campaigns([30, 20])), 'spend_by_entity').length, 1, 'on by default');
  const off = charts(campaigns([30, 20]), {config: {charts: {disabled: ['spend_by_entity']}}});
  assert.deepEqual(of(off, 'spend_by_entity'), []);
});

test('a partial snapshot says so on every chart it draws', () => {
  const [spec] = of(charts(campaigns([30, 20]), {state: 'partial'}), 'spend_by_entity');
  assert.ok(texts(spec).includes('This report is partial: totals leave out the sources or periods that are missing.'));
});
