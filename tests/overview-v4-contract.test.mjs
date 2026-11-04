import test from 'node:test';
import assert from 'node:assert/strict';
import {
  overviewConfigV4,
  normalizeOverviewV4Source,
  expandOverviewV4Sources,
  overviewV4Scope,
  overviewV4Sum,
  overviewV4Ratio,
  projectOverviewV4Rows,
} from '../dist/src/overview-v4.js';
const capabilities = {
  levels: ['campaign', 'adset', 'ad'].map(id => ({id, label: id, native_type: id})),
  defaults: {attribution: 'unknown', complete_window: null},
  option_names: ['attribution', 'complete_window'],
};
const source = {platform: 'fixture', account_id: '9007199254740993', connection_id: 'private-login'};
const normalize = value => normalizeOverviewV4Source({...source, ...value}, capabilities);
const metrics = (values, more = {}) => ({metrics: values, ...more});

test('v4 level alias, several levels and provider-owned defaults are deterministic and never declare completeness', () => {
  const original = {...source, levels: ['campaign', 'adset', 'ad']};
  const normalized = normalizeOverviewV4Source(original, capabilities);
  assert.deepEqual(normalized.levels, ['campaign', 'adset', 'ad']);
  assert.equal(normalized.level, 'campaign');
  assert.equal(normalized.reporting_contract, overviewConfigV4);
  assert.deepEqual(normalized.report_options, {attribution: 'unknown', complete_window: null});
  assert.equal(normalized.delivered_only, true);
  assert.deepEqual(normalized.statuses, ['all']);
  assert.equal(original.report_options, undefined, 'caller definition is immutable');
  assert.deepEqual(normalize({level: 'adset'}).levels, ['adset']);
  assert.equal(normalize({report_options: {complete_window: false}}).report_options.complete_window, false);
  assert.equal(normalize({report_options: {complete_window: true}}).report_options.complete_window, true);
  const expanded = expandOverviewV4Sources({contract_version: overviewConfigV4, sources: [normalized]});
  assert.deepEqual(
    expanded.map(row => [row.source_ref, row.account_id, row.level]),
    [
      [0, '9007199254740993', 'campaign'],
      [0, '9007199254740993', 'adset'],
      [0, '9007199254740993', 'ad'],
    ],
  );
  assert.notEqual(expanded[0], normalized);
});

test('v4 refuses ambiguous or unsupported levels and undeclared option fields', () => {
  for (const levels of [[], ['ad', 'ad'], ['keyword'], 'ad'])
    assert.throws(
      () => normalize({levels}),
      e => e.code === 'INVALID_REPORT_LEVEL',
    );
  assert.throws(
    () => normalize({levels: ['ad', 'adset'], level: 'adset'}),
    e => e.code === 'INVALID_REPORT_LEVEL',
  );
  for (const report_options of [
    [],
    null,
    {complete_window: 'true'},
    {attribution: ''},
    {attribution: '\n'},
    {pretend_complete: true},
    JSON.parse('{"__proto__":{}}'),
  ])
    assert.throws(
      () => normalize({report_options}),
      e => e.code === 'INVALID_REPORT_SOURCE',
    );
  let calls = 0;
  assert.throws(
    () =>
      normalizeOverviewV4Source(source, {
        ...capabilities,
        validateOptions(options) {
          calls++;
          assert.equal(options.complete_window, null);
          throw new Error('provider-owned refusal');
        },
      }),
    /provider-owned refusal/,
  );
  assert.equal(calls, 1);
});

test('legacy objectives become fallbacks without replacing an explicit fallback or per-campaign override', () => {
  const old = normalize({objective: 'sales', objective_overrides: {'42': 'leads'}});
  assert.equal(old.objective, undefined);
  assert.equal(old.objective_fallback, 'sales');
  assert.equal(old.objective_migrated_from_v3, true);
  assert.deepEqual(old.objective_overrides, {'42': 'leads'});
  assert.equal(normalize({...old, objective: 'sales', objective_fallback: 'traffic'}).objective_fallback, 'traffic');
  assert.equal(normalize({objective: 'unknown'}).objective_fallback, undefined);
  const retained = {sources: [{...source, level: 'campaign', objective: 'sales'}]};
  assert.equal(expandOverviewV4Sources(retained), retained.sources, 'v3 execution source array is unchanged');
});

test('v4 scope keeps exact IDs, validates statuses, and requires observed delivery', () => {
  for (const value of [
    {campaign_ids: [9007199254740993]},
    {ad_ids: ['bad/id']},
    {adset_ids: ['x'.repeat(201)]},
    {statuses: ['all', 'active']},
    {statuses: ['ACTIVE']},
    {delivered_only: 'true'},
  ])
    assert.throws(
      () => normalize(value),
      e => e.code === 'INVALID_REPORT_SOURCE',
    );
  const selected = normalize({
    levels: ['ad'],
    campaign_ids: ['c1'],
    ad_ids: ['9007199254740993'],
    statuses: ['active'],
  });
  const rows = [
    metrics(
      {spend: '0', impressions: '1', clicks: '0'},
      {entity_id: '9007199254740993', entity_level: 'ad', parent_ids: {campaign_id: 'c1'}, status: 'active'},
    ),
    metrics(
      {spend: '0', impressions: '0', clicks: '0'},
      {entity_id: '9007199254740993', entity_level: 'ad', parent_ids: {campaign_id: 'c1'}, status: 'active'},
    ),
    metrics(
      {spend: '3'},
      {entity_id: '9007199254740993', entity_level: 'ad', parent_ids: {campaign_id: 'c2'}, status: 'active'},
    ),
    metrics({spend: '3'}, {entity_id: '9007199254740993', entity_level: 'ad', parent_ids: {campaign_id: 'c1'}}),
  ];
  const filtered = overviewV4Scope(selected, rows);
  assert.deepEqual(filtered.rows, [rows[0]]);
  assert.deepEqual(filtered.scope, {
    returned_rows: 4,
    retained_rows: 1,
    excluded_rows: 3,
    excluded_unknown_rows: 1,
    filtering: 'after_collection',
  });
  assert.equal(overviewV4Scope(normalize({delivered_only: false}), [metrics({})]).rows.length, 1);
  assert.equal(overviewV4Scope(normalize({}), [metrics({})]).scope.excluded_unknown_rows, 1);
  assert.equal(
    overviewV4Scope(normalize({}), [metrics({spend: null, impressions: '0', clicks: '0'})]).scope.excluded_unknown_rows,
    0,
  );
});

test('known additive values retain exact decimal text and coverage; non-additive metrics are refused', () => {
  const rows = [
    metrics({spend: '9007199254740993.123456789'}),
    metrics({spend: null}),
    metrics({}),
    metrics({spend: '0.000000001'}),
    metrics({spend: '0'}),
  ];
  assert.deepEqual(overviewV4Sum(rows, 'spend'), {
    value: '9007199254740993.12345679',
    coverage: {known: 3, total: 5},
    rounded_values: 0,
  });
  assert.equal(overviewV4Sum([metrics({spend: '0.0000000015'})], 'spend').value, '0.000000002');
  assert.equal(overviewV4Sum([metrics({spend: '0.0000000015'})], 'spend').rounded_values, 1);
  assert.equal(
    overviewV4Sum([metrics({spend: '999'}, {native: {exact_totals: {spend: '0.1'}}})], 'spend').value,
    '0.1',
  );
  assert.deepEqual(overviewV4Sum([metrics({spend: null})], 'spend').coverage, {known: 0, total: 1});
  assert.equal(overviewV4Sum([metrics({spend: null})], 'spend').value, null);
  for (const metric of ['reach', 'frequency', 'cpa', 'roas', 'native_unknown'])
    assert.throws(
      () => overviewV4Sum([metrics({[metric]: '1'})], metric),
      e => e.code === 'INVALID_METRICS',
    );
});

test('ratios only use known numerator-denominator pairs, including zero numerators and half-even rounding', () => {
  const rows = [
    metrics({spend: '10', clicks: '5'}),
    metrics({spend: '100', clicks: null}),
    metrics({spend: null, clicks: '995'}),
    metrics({spend: '0', clicks: '5'}),
  ];
  assert.deepEqual(overviewV4Ratio(rows, 'spend', 'clicks'), {
    value: '1',
    coverage: {known_pairs: 2, total: 4},
    rounded: false,
  });
  assert.equal(overviewV4Ratio([metrics({spend: '1', clicks: '2000000000'})], 'spend', 'clicks').value, '0');
  assert.equal(overviewV4Ratio([metrics({spend: '3', clicks: '2000000000'})], 'spend', 'clicks').value, '0.000000002');
  assert.equal(overviewV4Ratio([metrics({spend: '10', impressions: '2000'})], 'spend', 'impressions', 1000).value, '5');
  assert.equal(overviewV4Ratio([metrics({spend: '10', clicks: '0'})], 'spend', 'clicks').value, null);
});

test('v4 get projection omits repeated native/lineage, exposes structured objectives/parents and leaves legacy rows intact', () => {
  const lineage = Array.from({length: 15}, (_, i) => ({
    stage: 'synthetic-read-' + i,
    response_fingerprint: 'a'.repeat(64),
    query_fingerprint: 'b'.repeat(64),
    captured_at: 1,
  }));
  const rows = Array.from({length: 30}, (_, i) => ({
    entity_id: String(i),
    entity_level: ['campaign', 'adset', 'ad'][i % 3],
    source_ref: 0,
    objective: 'TRAFFIC',
    objective_group: 'traffic',
    objective_source: 'provider',
    objective_reason: null,
    parent_ids: {campaign_id: 'c1', campaign_name: 'Campaign', adset_id: 'g1', adset_name: 'Group'},
    metrics: {spend: '1'},
    native: {daily_rows: [{metrics: {spend: '1'}}]},
    lineage,
  }));
  const snapshot = {config: {contract_version: overviewConfigV4}, sources: [{lineage}]};
  const projected = projectOverviewV4Rows(snapshot, rows);
  assert.equal(
    Buffer.byteLength(JSON.stringify({rows: projected, sources: snapshot.sources})) <
      Buffer.byteLength(JSON.stringify(rows)) / 3,
    true,
  );
  assert.equal(projected[0].lineage, undefined);
  assert.equal(projected[0].native, undefined);
  assert.deepEqual(projected[0].objective, {native: 'TRAFFIC', group: 'traffic', source: 'provider', reason: null});
  assert.deepEqual(projected[0].parents.campaign, {id: 'c1', name: 'Campaign'});
  assert.equal(projected[0].level, 'campaign');
  const included = projectOverviewV4Rows(snapshot, rows, {native: true, lineage: true});
  assert.deepEqual(included[0].lineage, lineage);
  assert.deepEqual(included[0].native, rows[0].native);
  assert.equal(projectOverviewV4Rows({config: {version: 1}}, rows), rows);
  assert.equal(rows[0].objective, 'TRAFFIC', 'projection never rewrites retained rows');
});
