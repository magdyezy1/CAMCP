import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleReportRows,
  reportCustomMetrics,
  reportNativeFields,
  snapshotOutcome,
} from '../dist/src/report-row-assembly.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {config, packet, row, source} from './helpers/report-packets.mjs';

// Row assembly without a queue, a worker or a store: collected packets and a frozen definition in, report rows out.
const assemble = (results, changes = {}) => {
  const c = config(changes),
    custom = reportCustomMetrics(c, reportNativeFields(results));
  return assembleReportRows(results, c, custom);
};

test('packets and a definition become report rows with the account frame, the objective and the calculated metrics', async () => {
  const rows = await assemble([
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

test('a packet that only supports a scope rollup contributes no report rows of its own', async () => {
  const rows = await assemble([
    packet('campaign', [row('campaign', 'c1')]),
    packet('ad', [row('ad', 'a1')], {source: {scope_supporting: true}}),
  ]);
  assert.deepEqual(
    rows.map(value => value.entity_level ?? 'campaign'),
    ['campaign'],
  );
});

test('the objective filter of the definition drops rows after their objective is resolved', async () => {
  const rows = await assemble(
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

test('a source override or fallback decides the objective of a row whose platform gave none', async () => {
  const rows = await assemble([
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

test('a saved source-wide objective applies to every row of its source, and a provider mapping reads the raw row', async () => {
  const legacy = await assemble([
    packet('campaign', [row('campaign', 'c1', {}, {objective: 'unknown'})], {source: {objective: 'sales'}}),
  ]);
  assert.deepEqual([legacy[0].objective_group, legacy[0].objective_source], ['sales', 'user_override']);
  // Google reads no objective: its campaign settings map the group, on a campaign row and inside a detail row's daily rows.
  const mapped = await assemble([
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

test('a row that carries the objective its collector resolved keeps it instead of resolving it a second time', async () => {
  // A detail row, or a rolled-up row built from its parent's row, records the resolution made with the parent's raw
  // evidence. The assembly must not discard it for a second resolution from the evidence left on the row itself.
  const recorded = {
    objective: 'unknown',
    objective_group: 'sales',
    objective_source: 'provider_mapped',
    objective_reason: 'Mapped from Google Ads campaign settings.',
    native: {delivery_activity: true, daily_rows: [{}]},
  };
  const [adset] = await assemble([
    packet('adset', [row('adset', 's1', {}, recorded)], {source: {platform: 'google', levels: ['adset']}}),
  ]);
  assert.deepEqual(
    [adset.objective, adset.objective_group, adset.objective_source, adset.objective_reason],
    ['unknown', 'sales', 'provider_mapped', 'Mapped from Google Ads campaign settings.'],
  );
  // A recorded resolution still reaches the objective filter.
  assert.deepEqual(
    await assemble(
      [packet('adset', [row('adset', 's1', {}, recorded)], {source: {platform: 'google', levels: ['adset']}})],
      {objectives: ['leads']},
    ),
    [],
  );
});

test('a campaign row rolled up from selected ads is resolved from the parent’s own evidence', async () => {
  const rolled = row(
    'campaign',
    'c1',
    {},
    {
      objective: 'unknown',
      aggregation: {kind: 'rolled_up', from_level: 'ad', scope_field: 'ad_ids', child_rows: 1},
      native: {
        delivery_activity: true,
        scope_rollup: {native_parent: {campaign: {advertisingChannelType: 'SHOPPING'}}},
      },
    },
  );
  const [campaign] = await assemble([packet('campaign', [rolled], {source: {platform: 'google'}})]);
  assert.deepEqual(
    [campaign.objective_group, campaign.objective_source],
    ['sales', 'provider_mapped'],
    'Google maps the group from the parent campaign’s settings, which the rolled row no longer carries itself',
  );
});
test('an override that matched no campaign of the source is named once, on its first packet', async () => {
  const results = [
    packet('campaign', [row('campaign', 'c1')], {source: {objective_overrides: {gone: 'traffic'}}}),
    packet('ad', [row('ad', 'a1')], {source: {objective_overrides: {gone: 'traffic'}}}),
  ];
  await assemble(results);
  assert.equal(results[0].warnings.length, 1);
  assert.match(results[0].warnings[0], /gone/);
  assert.deepEqual(results[1].warnings, []);
});

test('native fields any row reports become valid formula inputs, and accepted native dependencies stay valid when none does', async () => {
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
  const assembled = await assemble([packet('campaign', rows)], {
    custom_metrics: [{id: 'quarter_rate', label: 'Quarter', formula: 'native_meta_video_p25 / impressions'}],
  });
  assert.equal(assembled[0].metrics.quarter_rate, '0.03');
});

test('two rows of one entity in one reporting period are refused, whichever level repeats', async () => {
  await assert.rejects(assemble([packet('ad', [row('ad', 'a1'), row('ad', 'a1')])]), e =>
    assertRefused(e, 'DUPLICATE_ENTITY_ROWS'),
  );
  await assert.rejects(assemble([packet('campaign', [row('campaign', 'c1'), row('campaign', 'c1')])]), e =>
    assertRefused(e, 'DUPLICATE_CAMPAIGN_ROWS'),
  );
});

// The outcome of a snapshot follows its requested units. A unit that only supports a scope rollup measures a requested
// level and is never a level of the report (F-L5-18).
const refusal = {code: 'PLATFORM_ERROR', message: 'Synthetic refusal'};
const failedUnit = (level, more = {}) => ({source: source(level, more), rows: [], complete: false, error: refusal});
const rolledUp = (level, from, available, more = {}) =>
  packet(level, [], {
    complete: available,
    scope: {returned_rows: 1, input_rows: 0, rollup: {from_level: from, available, derived_rows: 0}},
    ...more,
  });
const assembleRows = (results, changes) => {
  const c = config(changes);
  return assembleReportRows(results, c, reportCustomMetrics(c, reportNativeFields(results)));
};
const outcome = async (results, changes = {}) =>
  snapshotOutcome(results, await assembleRows(results, changes), config(changes));

test('a report is failed only when every requested level failed, whatever its supporting reads did', async () => {
  const supporting = packet('ad', [row('ad', 'a1')], {source: {scope_supporting: true}});
  const failed = await outcome([failedUnit('campaign'), supporting]);
  assert.equal(failed.state, 'failed', 'the one requested level failed; the read that supports it worked');
  assert.equal(failed.emptyReason, null);
  assert.deepEqual(
    failed.failures.map(f => [f.unit.source.level, f.error.code]),
    [['campaign', 'PLATFORM_ERROR']],
  );
  const partial = await outcome([packet('campaign', [row('campaign', 'c1')]), failedUnit('ad')]);
  assert.equal(partial.state, 'partial');
  const limited = await outcome([packet('campaign', [row('campaign', 'c1')], {complete: false})]);
  assert.equal(limited.state, 'partial', 'a level that collected with limited coverage makes the report partial');
  assert.deepEqual(limited.failures, []);
  const clean = await outcome([packet('campaign', [row('campaign', 'c1')]), packet('ad', [row('ad', 'a1')])]);
  assert.equal(clean.state, 'complete');
});

test('a requested level measured through a level that failed has failed with that level’s error', async () => {
  const results = [rolledUp('campaign', 'ad', false), failedUnit('ad', {scope_supporting: true})];
  const result = await outcome(results);
  assert.equal(result.state, 'failed');
  assert.equal(result.emptyReason, null, 'the empty report is a failed collection, not a source filter');
  assert.deepEqual(
    result.failures.map(f => [f.unit.source.level, f.error]),
    [['campaign', refusal]],
  );
  // Rolled up from a level that collected, the same level has not failed.
  const derived = await outcome([
    rolledUp('campaign', 'ad', true),
    packet('ad', [], {source: {scope_supporting: true}}),
  ]);
  assert.equal(derived.state, 'complete');
});

test('an empty report says why only when nothing failed to explain it', async () => {
  const filtered = packet('campaign', [], {scope: {returned_rows: 3, input_rows: 3}});
  assert.equal((await outcome([filtered])).emptyReason, 'scope_filter');
  assert.equal((await outcome([packet('campaign', [])])).emptyReason, 'no_provider_rows');
  assert.equal((await outcome([filtered], {objectives: ['sales']})).emptyReason, 'scope_filter');
  const rowsFiltered = packet('campaign', [row('campaign', 'c1')]);
  assert.equal((await outcome([rowsFiltered], {objectives: ['sales']})).emptyReason, 'objective_filter');
  assert.equal(
    (await outcome([filtered, failedUnit('ad')])).emptyReason,
    'scope_filter',
    'the level that collected still explains itself',
  );
  assert.equal((await outcome([failedUnit('campaign')])).emptyReason, null);
});

test('the snapshot counters count the requested units and disclose the supporting rows apart', async () => {
  const results = [
    packet('campaign', [row('campaign', 'c1')], {
      scope: {returned_rows: 2, input_rows: 3, rollup: {from_level: 'ad', available: true, derived_rows: 3}},
    }),
    packet('ad', [row('ad', 'a1'), row('ad', 'a2')], {source: {scope_supporting: true}, scope: {returned_rows: 5}}),
  ];
  const {counts} = await outcome(results);
  assert.deepEqual(counts, {
    source_row_count: 2,
    filtered_row_count: 2,
    scoped_row_count: 1,
    scope_filtered_row_count: 2,
    objective_filtered_row_count: 0,
    scope_input_row_count: 3,
    derived_row_count: 3,
    supporting_row_count: 5,
  });
  assert.deepEqual(Object.keys((await outcome(results, {contract_version: 'overview-config-v3'})).counts), [
    'source_row_count',
    'filtered_row_count',
  ]);
});
