// One chart of every drawn shape, built from synthetic rows through the real chart module, for the tests that lay out,
// draw and compare charts: ranked bars with awkward names, bars with a target, a stack with and without the fold into Other,
// a line with a short period, and the key figures with their change.
import {reportCharts} from '../../dist/src/report-charts.js';
import {chartRow, keyFigures, money, names, parts} from './chart-rows.mjs';

export const charts = (rows, more) => reportCharts(parts(rows, more), {platformNames: names});
export const of = (specs, kind) => specs.filter(spec => spec.kind === kind);
export const campaigns = spends => spends.map((spend, index) => chartRow('c' + (index + 1), String(spend)));
export const week = (date, id, spend, more = {}) =>
  chartRow(id, spend, '1', {date_from: date, date_to: date, grain: 'weekly', ...more});
export const weekly = rows => charts(rows, {config: {grain: 'weekly'}});

/** Campaign names that are long, short, Arabic, and markup. */
export const hostile = [
  'A very long campaign name that will not fit on a narrow screen at all',
  'Short',
  'x',
  'مرحبا بالعالم',
  '</svg><script>alert(1)</script>',
];
export const barsSpec = () =>
  of(
    charts(
      campaigns([1234567.89, 98765.43, 5000, 12.5, 3]).map((row, index) => ({...row, campaign_name: hostile[index]})),
    ),
    'spend_by_entity',
  )[0];
/** Twelve campaigns: the ten with the most spend and the rest folded into Other. */
export const foldedBarsSpec = () =>
  of(charts(campaigns([100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 5, 4])), 'spend_by_entity')[0];
export const costSpec = () =>
  of(
    charts([chartRow('a', '100', '10'), chartRow('b', '100', null)], {
      config: {targets: {leads: {target: 12, currency: 'USD'}}},
    }),
    'cost_vs_target',
  )[0];
export const stackSpec = () => {
  const group = (id, objective, spend, platform, account) =>
    chartRow(id, spend, '1', {objective_group: objective, platform, account_id: account});
  return of(
    charts([
      group('s1', 'sales', '100', 'meta', '100'),
      group('l1', 'leads', '60', 'meta', '100'),
      group('t1', 'traffic', '1', 'meta', '100'),
      group('s2', 'sales', '40', 'google', '200'),
      group('l2', 'leads', '20', 'google', '200'),
    ]),
    'spend_by_objective',
  )[0];
};
/** Five objectives: the three largest and the rest as Other. */
export const foldedStackSpec = () =>
  of(
    charts(
      Object.entries({sales: '100', leads: '80', traffic: '60', awareness: '20', engagement: '10'}).map(
        ([objective, spend]) => chartRow(objective, spend, '1', {objective_group: objective}),
      ),
    ),
    'spend_by_objective',
  )[0];
export const eightWeeks = [
  '2026-09-07',
  '2026-09-14',
  '2026-09-21',
  '2026-09-28',
  '2026-10-05',
  '2026-10-12',
  '2026-10-19',
  '2026-10-26',
];
export const lineSpec = (dates = eightWeeks) =>
  of(
    weekly(dates.map((date, index) => week(date, 'a', String([10, 80, 40, 25, 60, 5, 90, 33][index % 8])))),
    'trend',
  ).find(item => item.title.text === 'Spend over time');
/** A line with a period that one campaign has no figure for (a hollow mark off the line) and a period with no data (a gap). */
export const shortLineSpec = () => {
  const rows = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'].flatMap((date, index) =>
    ['a', 'b'].map(id => week(date, id, index === 1 && id === 'a' ? null : '20')),
  );
  return of(weekly([...rows, week('2026-09-14', 'x', '5', {currency: 'EUR'})]), 'trend').find(
    item => item.context.currency === 'USD',
  );
};
export const tilesSpec = () =>
  keyFigures([money('a', '120'), money('b', '80')], [money('a', '100'), money('b', '50')])[0];
/** Key figures with figures and a change too long for one line of a phone's tile. */
export const bigTilesSpec = () => keyFigures([money('a', '12345678.5')], [money('a', '100')])[0];

/** Every shape, by name. */
export const specimens = () => ({
  bars: barsSpec(),
  'folded-bars': foldedBarsSpec(),
  cost: costSpec(),
  stack: stackSpec(),
  'folded-stack': foldedStackSpec(),
  line: lineSpec(),
  'short-line': shortLineSpec(),
  tiles: tilesSpec(),
});
