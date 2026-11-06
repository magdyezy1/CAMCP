import test from 'node:test';
import assert from 'node:assert/strict';
import {assembleReportRows, reportCustomMetrics, reportNativeFields} from '../dist/src/report-row-assembly.js';
import {assertRefused} from './helpers/assert-refused.mjs';

// Row assembly without a queue, a worker or a store: collected packets and a frozen definition in, report rows out.
const range = {since: '2026-09-01', until: '2026-09-02'};
const definition = {
  id: 'meta:leads',
  metric: 'leads',
  label: 'Leads',
  native_metric: 'actions.lead',
  aggregation: 'sum',
  unit: 'number',
};
/** One v4-shaped campaign or entity row, as the collectors hand it to the assembly. */
function row(level, id, metrics = {}, more = {}) {
  const entity =
    level === 'campaign' ? {} : {entity_id: id, entity_name: id, entity_level: level, native_entity_type: level};
  return {
    campaign_id: level === 'campaign' ? id : 'c1',
    campaign_name: level === 'campaign' ? id : 'c1',
    ...entity,
    ...(level === 'campaign' ? {} : {parent_ids: {campaign_id: 'c1', campaign_name: 'c1'}}),
    objective: 'OUTCOME_LEADS',
    currency: null,
    status: 'active',
    metrics: {impressions: '100', clicks: '10', spend: '1', reach: null, frequency: null, ...metrics},
    result: {metric: 'leads', label: 'Leads', value: '2', cost_per_result: null, definition_id: definition.id},
    result_context: {definition, source: 'mapped', cost_source: 'derived', unavailable_reason: null, rounding: {}},
    native: {delivery_activity: true},
    ...more,
  };
}
const source = (level, more = {}) => ({
  platform: 'meta',
  account_id: '100',
  connection_id: 'login',
  level,
  levels: ['campaign', 'ad'],
  source_ref: 0,
  reporting_contract: 'overview-config-v4',
  ...more,
});
const packet = (level, rows, more = {}) => ({
  source: source(level, more.source),
  rows,
  currency: 'USD',
  timezone: 'UTC',
  complete: true,
  collection_complete: true,
  source_kind: 'ads',
  date_range: range,
  warnings: [],
  lineage: [],
  captured_at: 1790000000000,
  result_definition: 'Synthetic results',
  attribution: 'Synthetic click window',
  quality: {version: 2, status: 'complete'},
  ...more,
  ...(more.source ? {source: source(level, more.source)} : {}),
});
const config = (more = {}) => ({
  contract_version: 'overview-config-v4',
  name: 'Synthetic',
  sources: [source('campaign')],
  date_range: range,
  grain: 'total',
  metrics: ['spend', 'cpc'],
  custom_metrics: [],
  objectives: [],
  targets: {},
  formula_version: 'synthetic-formula',
  ...more,
});
const assemble = (results, changes = {}) => {
  const c = config(changes),
    custom = reportCustomMetrics(c, reportNativeFields(results));
  return assembleReportRows(results, c, custom);
};

test('packets and a definition become report rows with the account frame, the objective and the calculated metrics', () => {
  const rows = assemble([
    packet('campaign', [row('campaign', 'c1', {spend: '10', clicks: '4'})]),
    packet('ad', [row('ad', 'a1', {spend: '10', clicks: '4'})], {source: {}}),
  ]);
  assert.equal(rows.length, 2);
  const [campaign, ad] = rows;
  assert.equal(campaign.row_key, 'meta:100:c1:2026-09-01:2026-09-02');
  assert.equal(ad.row_key, 'meta:100:ad:a1:2026-09-01:2026-09-02');
  assert.equal(ad.entity_key, 'meta:100:ad:a1');
  assert.equal(campaign.entity_key, undefined, 'a campaign row keeps its campaign key only');
  assert.equal(campaign.campaign_key, 'meta:100:c1');
  assert.deepEqual(
    [campaign.platform, campaign.account_id, campaign.connection_id, campaign.currency, campaign.timezone],
    ['meta', '100', 'login', 'USD', 'UTC'],
  );
  assert.deepEqual(
    [campaign.objective, campaign.objective_group, campaign.objective_source],
    ['OUTCOME_LEADS', 'leads', 'provider'],
  );
  assert.deepEqual([campaign.date_from, campaign.date_to, campaign.source_ref], ['2026-09-01', '2026-09-02', 0]);
  assert.equal(campaign.metrics.spend, '10');
  assert.equal(campaign.metrics.cpc, '2.5');
  assert.equal(campaign.metrics.primary_result, '2');
  assert.equal(campaign.metrics.cost_per_result, '5');
  assert.equal(campaign.result_definition, 'Leads');
  assert.equal(campaign.formula_version, 'synthetic-formula');
  assert.equal(campaign.lineage, undefined, 'v4 rows carry no lineage; the source keeps it once');
  assert.equal(campaign.grain, 'total');
  assert.equal(campaign.attribution, 'Synthetic click window');
  assert.equal(typeof campaign.recommendation.decision, 'string');
  assert.equal(campaign.metrics_coverage.spend.known, 1);
});

test('a packet that only supports a scope rollup contributes no report rows of its own', () => {
  const rows = assemble([
    packet('campaign', [row('campaign', 'c1')]),
    packet('ad', [row('ad', 'a1')], {source: {scope_supporting: true}}),
  ]);
  assert.deepEqual(
    rows.map(value => value.entity_level ?? 'campaign'),
    ['campaign'],
  );
});

test('the objective filter of the definition drops rows after their objective is resolved', () => {
  const rows = assemble(
    [packet('campaign', [row('campaign', 'c1'), row('campaign', 'c2', {}, {objective: 'OUTCOME_SALES'})])],
    {
      objectives: ['sales'],
    },
  );
  assert.deepEqual(
    rows.map(value => [value.campaign_id, value.objective_group]),
    [['c2', 'sales']],
  );
});

test('a source override or fallback decides the objective of a row whose platform gave none', () => {
  const rows = assemble([
    packet(
      'campaign',
      [row('campaign', 'c1', {}, {objective: 'unknown'}), row('campaign', 'c2', {}, {objective: 'unknown'})],
      {
        source: {objective_overrides: {c1: 'traffic'}, objective_fallback: 'awareness'},
      },
    ),
  ]);
  assert.deepEqual(
    rows.map(value => [value.campaign_id, value.objective_group, value.objective_source]),
    [
      ['c1', 'traffic', 'user_override'],
      ['c2', 'awareness', 'user_fallback'],
    ],
  );
});

test('a saved source-wide objective applies to every row of its source, and a provider mapping reads the raw row', () => {
  const legacy = assemble([
    packet('campaign', [row('campaign', 'c1', {}, {objective: 'unknown'})], {source: {objective: 'sales'}}),
  ]);
  assert.deepEqual([legacy[0].objective_group, legacy[0].objective_source], ['sales', 'user_override']);
  // Google reads no objective: its campaign settings map the group, on a campaign row and inside a detail row's daily rows.
  const mapped = assemble([
    packet(
      'campaign',
      [
        row('campaign', 'c1', {}, {objective: 'unknown', native: {campaign: {advertisingChannelType: 'SHOPPING'}}}),
        row(
          'campaign',
          'c2',
          {},
          {
            objective: 'unknown',
            native: {daily_rows: [{campaign: {biddingStrategyType: 'TARGET_ROAS'}}], delivery_activity: true},
          },
        ),
        row('campaign', 'c3', {}, {objective: 'unknown', native: {campaign: {advertisingChannelType: 'SEARCH'}}}),
      ],
      {source: {platform: 'google'}},
    ),
  ]);
  assert.deepEqual(
    mapped.map(value => [value.campaign_id, value.objective_group, value.objective_source]),
    [
      ['c1', 'sales', 'provider_mapped'],
      ['c2', 'sales', 'provider_mapped'],
      ['c3', 'unknown', 'unknown'],
    ],
  );
});

test('an override that matched no campaign of the source is named once, on its first packet', () => {
  const results = [
    packet('campaign', [row('campaign', 'c1')], {source: {objective_overrides: {gone: 'traffic'}}}),
    packet('ad', [row('ad', 'a1')], {source: {objective_overrides: {gone: 'traffic'}}}),
  ];
  assemble(results);
  assert.equal(results[0].warnings.length, 1);
  assert.match(results[0].warnings[0], /gone/);
  assert.deepEqual(results[1].warnings, []);
});

test('native fields any row reports become valid formula inputs, and accepted native dependencies stay valid when none does', () => {
  const rows = [row('campaign', 'c1', {native_meta_video_p25: '3'})],
    fields = reportNativeFields([packet('campaign', rows), packet('ad', [row('ad', 'a1')])]);
  assert.deepEqual([...fields], ['native_meta_video_p25']);
  const custom = reportCustomMetrics(
    config({custom_metrics: [{id: 'quarter_rate', label: 'Quarter', formula: 'native_meta_video_p25 / impressions'}]}),
    fields,
  );
  assert.equal(custom[0].id, 'quarter_rate');
  const sparse = reportCustomMetrics(
    config({custom_metrics: [{id: 'unseen', label: 'Unseen', formula: 'native_meta_video_p50 / impressions'}]}),
    [],
  );
  assert.equal(sparse[0].id, 'unseen');
  const assembled = assemble([packet('campaign', rows)], {
    custom_metrics: [{id: 'quarter_rate', label: 'Quarter', formula: 'native_meta_video_p25 / impressions'}],
  });
  assert.equal(assembled[0].metrics.quarter_rate, '0.03');
});

test('two rows of one entity in one reporting period are refused, whichever level repeats', () => {
  assert.throws(
    () => assemble([packet('ad', [row('ad', 'a1'), row('ad', 'a1')])]),
    e => assertRefused(e, 'DUPLICATE_ENTITY_ROWS'),
  );
  assert.throws(
    () => assemble([packet('campaign', [row('campaign', 'c1'), row('campaign', 'c1')])]),
    e => assertRefused(e, 'DUPLICATE_CAMPAIGN_ROWS'),
  );
});
