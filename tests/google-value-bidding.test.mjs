import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';
import {googleEvidenceCustomer} from './fixtures/google-evidence-data.mjs';
import {nativeReportResult} from '../dist/src/report-native.js';
import {reportSource} from '../dist/src/report-sources.js';
import {selectReportResultDefinition} from '../dist/src/report-results.js';
import {reportMetricsSummaryV4} from '../dist/src/report-summary.js';

/**
 * F-L5-13: plan 4.3, "Google and Microsoft: conversions, with conversion value and ROAS when bidding is value-based".
 * Google's campaign.bidding_strategy_type selects the result; the strategies are the pinned BiddingStrategyType enum.
 */
const vendor = JSON.parse(readFileSync('.mirror/VENDOR/google-ads-v25.json', 'utf8')).document;
const strategies = vendor.schemas.GoogleAdsGoogleadsV25Resources__Campaign.properties.biddingStrategyType;
const valueBased = ['MAXIMIZE_CONVERSION_VALUE', 'TARGET_ROAS'];
const range = {since: '2026-09-01', until: '2026-09-01'};
const conversions = {
  id: 'google:primary_conversions',
  metric: 'conversions',
  native_metric: 'metrics.conversions',
  unit: 'number',
};
const conversionValue = {
  id: 'google:conversion_value',
  metric: 'conversion_value',
  label: 'Conversion value',
  native_metric: 'metrics.conversionsValue',
  aggregation: 'sum',
  unit: 'currency',
};

test('the pinned BiddingStrategyType enum is what this table covers, and only two of its values are value based', () => {
  // The vendor document is the source of the list; this fails if a strategy is added or removed there unseen.
  assert.equal(strategies.enum.length, 23);
  assert.match(strategies.enumDescriptions[strategies.enum.indexOf('MAXIMIZE_CONVERSION_VALUE')], /maximize revenue/);
  assert.match(strategies.enumDescriptions[strategies.enum.indexOf('TARGET_ROAS')], /maximize revenue/);
  for (const value of strategies.enum) {
    const selected = selectReportResultDefinition(reportSource('google').resultRules, {bidding: value});
    assert.equal(selected.unavailable_reason, null, value);
    if (valueBased.includes(value)) assert.deepEqual(selected.definition, conversionValue, value);
    else
      assert.deepEqual(
        {...selected.definition, label: undefined, aggregation: undefined},
        {...conversions, label: undefined, aggregation: undefined},
        value,
      );
  }
  // Absent or new strategies fall to primary conversions, and no inherited property selects anything.
  for (const bidding of [undefined, null, '', 'A_FUTURE_STRATEGY', 'constructor', '__proto__', 'toString'])
    assert.equal(
      selectReportResultDefinition(reportSource('google').resultRules, {bidding}).definition.id,
      conversions.id,
      String(bidding),
    );
  assert.equal(selectReportResultDefinition(reportSource('google').resultRules, {}).definition.id, conversions.id);
});

const row = (bidding, metrics = {}) => ({
  campaign: {id: '1', ...(bidding === undefined ? {} : {biddingStrategyType: bidding})},
  metrics: {costMicros: '10000000', conversions: 4, conversionsValue: 50, ...metrics},
});
const read = (raw, context = {}) => nativeReportResult('google', raw, {level: 'campaign', range, ...context});

test('a value-based campaign reports its conversion value as the result and keeps conversions in the metrics', () => {
  for (const bidding of valueBased) {
    const value = read(row(bidding));
    assert.equal(value.definition.id, 'google:conversion_value', bidding);
    assert.equal(value.definition.unit, 'currency');
    assert.deepEqual(value.result, {
      metric: 'conversion_value',
      label: 'Conversion value',
      value: '50',
      cost_per_result: null,
      definition_id: 'google:conversion_value',
    });
    assert.equal(value.source, 'mapped');
    // A result counted in money has a return on spend (ROAS), not a cost per result.
    assert.equal(value.cost_source, 'unknown');
    assert.equal(value.unavailable_reason, null);
  }
  const counted = read(row('MAXIMIZE_CONVERSIONS'));
  assert.equal(counted.definition.id, 'google:primary_conversions');
  assert.equal(counted.result.value, '4');
  assert.equal(counted.result.cost_per_result, '2.5');
  // No strategy on the row (the request did not select it, or Google left it out) is the unchanged conversions rule.
  assert.equal(read(row(undefined)).result.value, '4');
});

test('conversion value keeps exact digits, an explicit zero, and an absent value stays unknown', () => {
  assert.equal(read(row('TARGET_ROAS', {conversionsValue: '9007199254740993'})).result.value, '9007199254740993');
  assert.equal(read(row('TARGET_ROAS', {conversionsValue: '1234.567890123'})).result.value, '1234.567890123');
  assert.equal(read(row('TARGET_ROAS', {conversionsValue: 0})).result.value, '0');
  const absent = read(row('TARGET_ROAS', {conversionsValue: undefined}));
  assert.equal(absent.result.value, null);
  assert.equal(absent.unavailable_reason, 'missing_metric');
  assert.equal(absent.result.definition_id, 'google:conversion_value', 'the definition is still the value one');
  assert.throws(() => read(row('TARGET_ROAS', {conversionsValue: '-3'})), {code: 'REPORT_SHAPE_CHANGED'});
});

// A campaign set in one report: two value-based campaigns and one conversion-based Shopping campaign, all `sales`.
const campaign = (id, {channel = 'SEARCH', bidding, cost, conversions: count, value}) => ({
  customer: googleEvidenceCustomer(),
  campaign: {
    id,
    resourceName: 'customers/123/campaigns/' + id,
    name: 'Campaign ' + id,
    status: 'ENABLED',
    advertisingChannelType: channel,
    biddingStrategyType: bidding,
  },
  metrics: {
    costMicros: String(cost * 1e6),
    impressions: '100',
    clicks: '10',
    conversions: count,
    conversionsValue: value,
  },
  segments: {date: range.since},
});
const set = [
  campaign('11', {bidding: 'TARGET_ROAS', cost: 10, conversions: 4, value: 50}),
  campaign('12', {bidding: 'MAXIMIZE_CONVERSION_VALUE', cost: 20, conversions: 5, value: 80}),
  campaign('13', {channel: 'SHOPPING', bidding: 'MAXIMIZE_CONVERSIONS', cost: 30, conversions: 6, value: 90}),
];
const metricNames = ['spend', 'conversions', 'conversion_value', 'roas', 'cpa', 'primary_result', 'cost_per_result'];
async function run(t, levels = ['campaign'], answer = rows => set.map(item => ({...item}))) {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  let query = '';
  f.hook(() => {
    query = f.requests.at(-1)?.body?.query ?? query;
  });
  f.mutate((rows, kind) => (kind === 'google' && /FROM campaign /.test(query) ? answer(rows) : rows));
  const {objective, level, ...source} = granularSource('google', 'ad'),
    queued = await f.overview.handle(
      {
        action: 'run',
        confirmed: true,
        config: {
          ...granularConfig(source),
          contract_version: 'overview-config-v4',
          date_range: range,
          metrics: metricNames,
          sources: [{...source, levels}],
        },
      },
      f.actor,
    );
  await f.worker.once();
  return {f, report: await f.overview.handle({action: 'get', id: queued.id, limit: 500}, f.actor)};
}
const figures = item => Object.fromEntries(metricNames.map(name => [name, item.metrics[name]]));

test('value-based and conversion-based campaigns of one account give rows and summaries that never add across', async t => {
  const {report} = await run(t);
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  const byId = Object.fromEntries(report.rows.map(item => [item.entity_id, item]));
  // ROAS is conversion value divided by spend, on the row; conversions stay in the metrics beside it.
  assert.deepEqual(figures(byId['11']), {
    spend: '10',
    conversions: '4',
    conversion_value: '50',
    roas: '5',
    cpa: '2.5',
    primary_result: '50',
    cost_per_result: null,
  });
  assert.deepEqual(figures(byId['12']), {
    spend: '20',
    conversions: '5',
    conversion_value: '80',
    roas: '4',
    cpa: '4',
    primary_result: '80',
    cost_per_result: null,
  });
  assert.deepEqual(figures(byId['13']), {
    spend: '30',
    conversions: '6',
    conversion_value: '90',
    roas: '3',
    cpa: '5',
    primary_result: '6',
    cost_per_result: '5',
  });
  assert.deepEqual(
    ['11', '12', '13'].map(id => byId[id].result.definition_id),
    ['google:conversion_value', 'google:conversion_value', 'google:primary_conversions'],
  );
  for (const id of ['11', '12', '13'])
    assert.equal(byId[id].objective.group, 'sales', 'one objective, two result meanings');
  // The summaries: the value-based pair is one group with ROAS 130 / 30, the conversion campaign its own.
  assert.equal(report.summary.length, 2);
  const value = report.summary.find(item => item.result_definition === 'Conversion value'),
    counted = report.summary.find(item => item.result_definition === 'Primary conversions');
  assert.deepEqual(figures(value), {
    spend: '30',
    conversions: '9',
    conversion_value: '130',
    roas: '4.333333333',
    cpa: '3.333333333',
    primary_result: '130',
    cost_per_result: null,
  });
  assert.deepEqual(figures(counted), {
    spend: '30',
    conversions: '6',
    conversion_value: '90',
    roas: '3',
    cpa: '5',
    primary_result: '6',
    cost_per_result: '5',
  });
  assert.equal(value.result.definition_id, 'google:conversion_value');
  assert.equal(value.result_groups.length, 1);
  assert.equal(counted.result.definition_id, 'google:primary_conversions');
  for (const item of report.summary)
    assert.notEqual(item.metrics.primary_result, '136', 'a value and a count are never added');
});

test('a summary over a mixed campaign set keeps the two result meanings apart and gives no combined result', () => {
  const rows = set.map(item => {
    const {result, ...result_context} = read(item),
      m = item.metrics;
    return {
      platform: 'google',
      account_id: '123',
      currency: 'USD',
      date_from: range.since,
      date_to: range.until,
      attribution: 'unknown',
      entity_level: 'campaign',
      metrics: {
        spend: String(m.costMicros / 1e6),
        conversions: String(m.conversions),
        conversion_value: String(m.conversionsValue),
      },
      result,
      result_context,
    };
  });
  const summary = reportMetricsSummaryV4(rows);
  assert.deepEqual(
    summary.result_groups
      .map(group => [group.definition.id, group.result.value, group.result.cost_per_result, group.coverage])
      .sort(),
    [
      ['google:conversion_value', '130', null, {known: 2, total: 2}],
      ['google:primary_conversions', '6', '5', {known: 1, total: 1}],
    ],
  );
  assert.equal(summary.result.value, null);
  assert.equal(summary.metrics.primary_result, null);
  assert.equal(summary.metrics.cost_per_result, null);
  // The plain conversion count is a metric of its own and still adds; the result does not.
  assert.equal(summary.metrics.conversions, '15');
});

const googleSelected = text =>
  /^SELECT (.+) FROM (\w+) WHERE /s
    .exec(text)[1]
    .split(', ')
    .filter(field => !/[\s()]/.test(field));

test('the campaign, ad group and ad requests select the two fields the bidding selector reads, once each', async t => {
  const {f} = await run(t, ['campaign', 'adset', 'ad']),
    queries = f.requests
      .map(request => request.body?.query)
      .filter(text => /^SELECT .* FROM (campaign|ad_group|ad_group_ad) /s.test(text ?? ''));
  assert.deepEqual(
    queries.map(text => /FROM (\w+)/.exec(text)[1]),
    ['campaign', 'ad_group', 'ad_group_ad'],
  );
  for (const text of queries) {
    const fields = googleSelected(text);
    // GAQL refuses a repeated field; the strategy and the value are selected by every level that resolves a result.
    assert.equal(new Set(fields).size, fields.length, text);
    for (const field of ['campaign.bidding_strategy_type', 'metrics.conversions_value'])
      assert.equal(fields.filter(item => item === field).length, 1, field + ' in ' + /FROM (\w+)/.exec(text)[1]);
  }
});

test('Google ad group and ad rows resolve value-based bidding from the fields their real request selected', async t => {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  let query = '';
  f.hook(() => {
    query = f.requests.at(-1)?.body?.query ?? query;
  });
  // A provider that answers only with the fields the request selected.
  f.mutate((rows, kind) =>
    kind === 'google'
      ? rows.map(item => ({
          ...item,
          campaign: {
            ...item.campaign,
            ...(query.includes('campaign.bidding_strategy_type') ? {biddingStrategyType: 'TARGET_ROAS'} : {}),
          },
        }))
      : rows,
  );
  const {objective, level, ...source} = granularSource('google', 'ad'),
    queued = await f.overview.handle(
      {
        action: 'run',
        confirmed: true,
        config: {
          ...granularConfig(source),
          contract_version: 'overview-config-v4',
          date_range: range,
          metrics: metricNames,
          sources: [{...source, levels: ['adset', 'ad']}],
        },
      },
      f.actor,
    );
  await f.worker.once();
  const report = await f.overview.handle({action: 'get', id: queued.id, limit: 500}, f.actor);
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.deepEqual(report.rows.map(item => item.level).sort(), ['ad', 'adset']);
  for (const item of report.rows) {
    assert.equal(item.result.definition_id, 'google:conversion_value', item.level);
    assert.equal(item.result.value, '30', item.level + ': the fixture rowâ€™s conversionsValue');
    assert.equal(item.metrics.conversions, '2', item.level);
    assert.equal(item.result.cost_per_result, null);
  }
});

test('Microsoft stays on conversions: its campaign, ad group and ad reports have no bidding strategy column', () => {
  const reporting = JSON.parse(readFileSync('.mirror/VENDOR/microsoft-reporting-v13.json', 'utf8')).document.schemas,
    columns = name =>
      reporting['simpleType:{https://bingads.microsoft.com/Reporting/v13}' + name].children[0].children.map(
        item => item.attributes.value,
      );
  for (const report of [
    'CampaignPerformanceReportColumn',
    'AdGroupPerformanceReportColumn',
    'AdPerformanceReportColumn',
  ]) {
    const names = columns(report);
    assert.ok(names.includes('Conversions') && names.includes('Revenue'), report);
    // If Microsoft adds a strategy column here, a value-based Microsoft result becomes possible and this must be revisited.
    assert.deepEqual(
      names.filter(name => /Strateg|Scheme/i.test(name)),
      [],
      report,
    );
  }
  const rules = reportSource('microsoft').resultRules;
  assert.deepEqual(rules.selectors, []);
  assert.equal(rules.default.id, 'microsoft:conversions');
  const microsoft = nativeReportResult(
    'microsoft',
    {Conversions: '5.25', Revenue: '99', Spend: '10.5'},
    {level: 'campaign', range},
  );
  assert.equal(microsoft.result.value, '5.25');
  assert.equal(microsoft.result.cost_per_result, '2');
});
