import test from 'node:test';
import assert from 'node:assert/strict';
import {
  overviewConfigV4,
  overviewDefinitionForms,
  normalizeOverviewV4Source,
  expandOverviewV4Sources,
  overviewV4Scope,
  projectOverviewV4Rows,
} from '../dist/src/overview-v4.js';
import {objectiveReportFixture} from './helpers/objective-report.mjs';
import {reportSource} from '../dist/src/report-sources.js';
import {estimateCollectionRequests} from '../dist/src/report-request-estimate.js';
import {normalizeNativeRowV4} from '../dist/src/report-native.js';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';
import {reportPreset} from '../dist/src/report-presets.js';
import {overviewSourceLevel, detailedOverviewRows} from '../dist/src/overview-levels.js';
const capabilities = {
  levels: ['campaign', 'adset', 'ad'].map(id => ({id, label: id, native_type: id})),
  defaults: {attribution: 'unknown', complete_window: null},
  option_names: ['attribution', 'complete_window'],
  delivery_metrics: ['spend', 'impressions', 'clicks'],
  supported_statuses: ['active', 'paused', 'archived', 'all'],
  status_basis: 'current_configuration',
};
const source = {platform: 'fixture', account_id: '9007199254740993', connection_id: 'private-login'};
const normalize = value => normalizeOverviewV4Source({...source, ...value}, capabilities);
const metrics = (values, more = {}) => ({metrics: values, ...more});

test('Snapchat scalar campaign scope migrates without widening and new all-campaign detail refuses old binaries', () => {
  const caps = reportSource('snapchat').overview,
    parent = '33333333-3333-4333-8333-000000000002',
    other = '33333333-3333-4333-8333-000000000003',
    original = {
      platform: 'snapchat',
      levels: ['adset'],
      campaign_id: parent,
      delivered_only: false,
      report_options: {complete_window: true},
    };
  for (const campaign_ids of [undefined, [], [parent], [other, parent]]) {
    const value = normalizeOverviewV4Source({...original, campaign_ids}, caps);
    assert.deepEqual(value.campaign_ids, [parent]);
    assert.equal(value.campaign_id, undefined);
    assert.equal(original.campaign_id, parent);
  }
  assert.throws(
    () => normalizeOverviewV4Source({...original, campaign_ids: [other]}, caps),
    e => e.code === 'INVALID_REPORT_SOURCE',
  );
  for (const campaign_ids of [['not-a-uuid'], [null], 'invalid'])
    assert.throws(
      () => normalizeOverviewV4Source({...original, campaign_id: undefined, campaign_ids}, caps),
      e => e.code === 'INVALID_REPORT_SOURCE',
    );
  const source = normalizeOverviewV4Source({...original, campaign_id: undefined}, caps),
    forms = overviewDefinitionForms({contract_version: overviewConfigV4, sources: [source]}, () => caps);
  assert.deepEqual(source.campaign_ids, []);
  assert.equal(forms.config.sources[0].level, 'v4_required');
  const old = {sources: [{platform: 'snapchat', level: 'adset', campaign_id: parent}]};
  assert.deepEqual(overviewDefinitionForms(old, () => caps).config, old, 'the original v3 rollback form is untouched');
});

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
    excluded_status_rows: 1,
    filtering: 'after_collection',
    status_basis: 'current_configuration',
  });
  assert.equal(overviewV4Scope(normalize({delivered_only: false}), [metrics({})]).rows.length, 1);
  assert.equal(overviewV4Scope(normalize({}), [metrics({})]).scope.excluded_unknown_rows, 1);
  assert.equal(
    overviewV4Scope(normalize({}), [metrics({spend: null, impressions: '0', clicks: '0'})]).scope.excluded_unknown_rows,
    1,
  );
  assert.equal(
    overviewV4Scope(normalize({}), [metrics({spend: '0', impressions: '0', clicks: '0'})]).scope.excluded_unknown_rows,
    0,
    'known zero activity is distinct from partly unknown activity',
  );
  assert.equal(overviewV4Scope(normalize({}), [metrics({spend: null, impressions: '1'})]).rows.length, 1);
  assert.equal(
    overviewV4Scope(normalize({}), [metrics({spend: '0.0000000001', impressions: '0', clicks: '0'})]).rows.length,
    1,
    'positive native activity is observed before display rounding',
  );
  assert.equal(
    overviewV4Scope(normalize({statuses: ['active']}), [metrics({spend: '1'}, {status: 'UNMAPPED_NATIVE'})]).scope
      .excluded_unknown_rows,
    1,
  );
});

test('v4 native campaign normalization keeps large decimal strings exact before deriving any totals', () => {
  const rounding = {},
    row = normalizeNativeRowV4(
      'google',
      {
        campaign: {id: '9007199254740993', name: 'Synthetic'},
        metrics: {
          costMicros: '9007199254740993123456.789',
          conversions: '0.0000000015',
          conversionsValue: '27.987654321',
          clicks: '0',
          impressions: '100',
        },
      },
      rounding,
    );
  assert.equal(row.campaign_id, '9007199254740993');
  assert.equal(row.metrics.spend, '9007199254740993.123456789');
  assert.equal(row.native.exact_totals.spend, '9007199254740993.123456789');
  assert.equal(row.metrics.native_google_metrics_costMicros, '9007199254740993123456.789');
  assert.equal(row.metrics.conversions, '0.000000002');
  assert.equal(rounding.conversions, 1);
  assert.throws(
    () => normalizeNativeRowV4('google', {campaign: {id: '1'}, metrics: {costMicros: 9007199254740992}}),
    error => error.code === 'METRIC_PRECISION_LOSS',
  );
  const reach = normalizeNativeRowV4('meta', {campaign_id: '1', reach: '2000', frequency: '1.1234567890123'});
  assert.equal(reach.metrics.frequency, '1.1234567890123');
  assert.equal(reach.native.exact_totals.reach, undefined);
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
  assert.equal(
    included[0].lineage,
    undefined,
    'lineage is returned once in the source capsule, including explicit reads',
  );
  assert.deepEqual(included[0].native, rows[0].native);
  assert.equal(projectOverviewV4Rows({config: {version: 1}}, rows), rows);
  assert.equal(rows[0].objective, 'TRAFFIC', 'projection never rewrites retained rows');
});

test('the projection keeps the coverage of a figure built from some of its units, whichever build stored it (F-L5-31)', () => {
  const row = metrics_coverage => ({
      entity_id: '1',
      source_ref: 0,
      metrics: {spend: '1', clicks: '2', cpc: '3', roas: '4', cost: '5', cost_per_result: '6'},
      metrics_coverage,
    }),
    snapshot = {config: {contract_version: overviewConfigV4}, sources: [{}]},
    kept = coverage => Object.keys(projectOverviewV4Rows(snapshot, [row(coverage)])[0].metrics_coverage ?? {}).sort();
  // This build: only a figure built from some of its units, or one with a reason, is kept.
  assert.deepEqual(
    kept({
      spend: {known_rows: 1, total_rows: 2, basis: 'report_rows', report_rows: 2},
      clicks: {known_rows: 2, total_rows: 2, basis: 'report_rows', report_rows: 2},
      cost: {
        known_rows: 2,
        total_rows: 2,
        basis: 'report_rows',
        report_rows: 2,
        unavailable_reason: 'calculation_limit',
      },
    }),
    ['cost', 'spend'],
  );
  // Builds before the unified shape: known/total for a sum, known_rows/total for a formula, known_pairs/total for a cost.
  assert.deepEqual(
    kept({
      spend: {known: 1, total: 2, basis: 'native_measurements', report_rows: 2},
      clicks: {known: 2, total: 2, basis: 'native_measurements', report_rows: 2},
      roas: {known_rows: 1, total: 2, known_pairs: 1, basis: 'native_measurements', report_rows: 2},
      cpc: {known_rows: 2, total: 2, known_pairs: 2, basis: 'native_measurements', report_rows: 2},
      cost_per_result: {known_pairs: 1, total: 2, basis: 'native_measurements', report_rows: 2},
    }),
    ['cost_per_result', 'roas', 'spend'],
  );
});

test('real v4 queue/worker/get collects three levels for one account and retains one source lineage', async t => {
  const f = objectiveReportFixture(t),
    calls = [];
  f.overview.native.collect = async (configured, range, actor, checkpoint, save, lookup) => {
    calls.push({level: configured.level, lookup});
    const id = {campaign: '1', adset: '2', ad: '3'}[configured.level];
    return {
      rows: [
        {
          entity_id: id,
          entity_level: configured.level,
          campaign_id: '1',
          entity_name: configured.level,
          parent_ids:
            configured.level === 'campaign'
              ? {}
              : {
                  campaign_id: '1',
                  campaign_name: 'Campaign',
                  ...(configured.level === 'ad' ? {adset_id: '2', adset_name: 'Group'} : {}),
                },
          objective: 'OUTCOME_TRAFFIC',
          metrics: {spend: 10, impressions: 100, clicks: 2},
          native: {exact_totals: {spend: '10', impressions: '100', clicks: '2'}},
        },
      ],
      complete: true,
      collection_complete: true,
      currency: 'USD',
      timezone: 'UTC',
      date_range: range,
      warnings: [],
      source_kind: 'paid',
      result_definition: 'Synthetic result',
      attribution: 'Synthetic window',
      captured_at: 1,
      lineage: [
        {stage: 'account', response_fingerprint: 'shared'},
        {stage: configured.level, response_fingerprint: id},
      ],
    };
  };
  const config = {
    ...f.config,
    contract_version: overviewConfigV4,
    sources: [{...f.config.sources[0], levels: ['campaign', 'adset', 'ad']}],
  };
  const normalized = f.overview.config(config, f.actor);
  assert.equal(normalized.sources.length, 1);
  assert.deepEqual(normalized.sources[0].report_options.attribution_windows, ['7d_click', '1d_view']);
  assert.equal(normalized.sources[0].report_options.complete_window, null);
  assert.deepEqual(
    estimateCollectionRequests(normalized).sources.map(row => row.level),
    ['campaign', 'adset', 'ad'],
  );
  const snapshot = await f.run(config);
  assert.equal(snapshot.rows.length, 3, JSON.stringify(snapshot.error));
  assert.deepEqual(
    calls.map(row => row.level),
    ['campaign', 'adset', 'ad'],
  );
  assert.equal(calls[0].lookup, calls[1].lookup, 'account-level cache is shared across native levels');
  assert.equal(calls[1].lookup, calls[2].lookup);
  assert.equal(snapshot.sources.length, 1);
  assert.equal(snapshot.sources[0].level_results.length, 3);
  assert.equal(JSON.stringify(snapshot).includes('"lineage"'), false, 'default v4 get carries no lineage anywhere');
  assert.equal(
    snapshot.rows.every(row => row.source_ref === 0 && row.native === undefined),
    true,
  );
  const included = await f.overview.handle(
    {action: 'get', id: snapshot.id, include: {native: true, lineage: true}},
    f.actor,
  );
  assert.equal(included.sources[0].lineage.length, 4, 'shared account evidence deduplicates');
  assert.equal(included.rows[2].parents.adset.id, '2');
  assert.equal(included.rows[2].objective.source, 'provider');
  assert.equal(included.rows[2].native.exact_totals.spend, '10');
  const stored = f.store.document(f.actor.tenantId, 'overview_report', snapshot.id);
  assert.equal(
    stored.rows.every(row => !Object.hasOwn(row, 'lineage')),
    true,
  );
  assert.deepEqual(stored.config.sources[0].levels, ['campaign', 'adset', 'ad']);
});

test('v4 bootstrap owns provider names/defaults; legacy input cannot forge the normalized marker', async t => {
  const f = objectiveReportFixture(t);
  const bootstrap = await f.overview.handle({action: 'bootstrap'}, f.actor);
  assert.equal(bootstrap.metrics_v4.primary_result.aggregation, 'result_definition');
  assert.equal(bootstrap.metrics_v4.cost_per_result.better, 'lower');
  assert.equal(bootstrap.metrics.primary_result, undefined, 'legacy metric discovery keeps its contract');
  for (const platform of [
    'meta',
    'tiktok',
    'snapchat',
    'linkedin',
    'google',
    'microsoft',
    'apple',
    'reddit',
    'x',
    'ga4',
    'gsc',
  ])
    assert.ok(reportSource(platform).overview.levels.length > 0, platform);
  const legacy = f.overview.config(
    {...f.config, sources: [{...f.config.sources[0], reporting_contract: overviewConfigV4}]},
    f.actor,
  );
  assert.equal(legacy.sources[0].reporting_contract, undefined);
  assert.equal(legacy.contract_version, undefined);
  assert.throws(
    () =>
      f.overview.config(
        {
          ...f.config,
          contract_version: overviewConfigV4,
          sources: [
            {...f.config.sources[0], levels: ['campaign']},
            {...f.config.sources[0], levels: ['ad']},
          ],
        },
        f.actor,
      ),
    error => error.code === 'DUPLICATE_REPORT_ACCOUNT',
  );
});

test('v4 TikTok detail collects native result fields without a completeness declaration and holds recommendations', async t => {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  f.parents((platform, url, body) => {
    if (platform === 'tiktok' && url.pathname.includes('/adgroup/get/'))
      body.data.list = body.data.list.map(row => ({
        ...row,
        optimization_goal: 'CONVERT',
        optimization_event: 'COMPLETE_PAYMENT',
      }));
    return body;
  });
  f.mutate((rows, platform) =>
    platform === 'tiktok'
      ? rows.map((row, index) => ({
          ...row,
          metrics: {...row.metrics, result: index === 0 ? '3' : '7', cost_per_result: '99', result_rate: '12'},
        }))
      : rows,
  );
  const source = {...granularSource('tiktok'), report_options: undefined, levels: ['ad']},
    queued = await f.overview.handle(
      {action: 'run', confirmed: true, config: {...granularConfig(source), contract_version: overviewConfigV4}},
      f.actor,
    );
  await f.worker.once();
  const snapshot = await f.overview.handle({action: 'get', id: queued.id}, f.actor);
  assert.equal(snapshot.state, 'partial', JSON.stringify(snapshot.sources));
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].result.value, '10');
  assert.equal(snapshot.rows[0].result.cost_per_result, '2.024');
  assert.equal(
    snapshot.rows[0].result_context.source,
    'mapped',
    'a multi-day total is computed from native result rows',
  );
  assert.equal(snapshot.rows[0].complete, false);
  assert.equal(snapshot.sources[0].quality.reporting_window_declared_complete, null);
  assert.equal(snapshot.sources[0].detail_contract, 'overview-detail-v4');
  const request = f.requests.find(row => row.url.pathname.includes('/report/integrated/get/'));
  assert.equal(JSON.parse(request.url.searchParams.get('metrics')).includes('result'), true);
  const groupRead = f.requests.find(row => row.url.pathname.includes('/adgroup/get/'));
  assert.equal(JSON.parse(groupRead.url.searchParams.get('fields')).includes('optimization_goal'), true);
});

// Package meta-results: the row carries no insights `results`, so the goal's documented field is the labelled fallback. (The
// row used to carry an `unverified` placeholder `results`; that is not the recorded shape and is unknown now. A row that
// does carry `results` is read as Meta's own result: tests/meta-results-reports.test.mjs.)
test('v4 Meta detail accepts no action override and maps the goal’s documented field when a row carries no results', async t => {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  f.mutate((rows, platform) =>
    platform === 'meta'
      ? rows.map((row, index) => ({
          ...row,
          optimization_goal: 'LINK_CLICKS',
          inline_link_clicks: index === 0 ? '3' : '6',
        }))
      : rows,
  );
  const source = {...granularSource('meta'), report_options: undefined, levels: ['ad']},
    queued = await f.overview.handle(
      {action: 'run', confirmed: true, config: {...granularConfig(source), contract_version: overviewConfigV4}},
      f.actor,
    );
  await f.worker.once();
  const snapshot = await f.overview.handle({action: 'get', id: queued.id}, f.actor);
  assert.equal(snapshot.state, 'partial', JSON.stringify(snapshot.sources));
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].result.metric, 'link_clicks');
  assert.equal(snapshot.rows[0].result.value, '9');
  assert.equal(snapshot.rows[0].result_context.source, 'mapped');
  assert.equal(snapshot.rows[0].metrics.conversions, null, 'no invented conversion action');
  const request = f.requests.find(row => row.url.pathname.endsWith('/insights'));
  assert.equal(request.url.searchParams.get('fields').split(',').includes('results'), true);
  assert.equal(request.url.searchParams.get('fields').split(',').includes('inline_link_clicks'), true);
});

test('a client cannot use a JSON flag to bypass legacy guided declarations, and v4 still requires closed dates', () => {
  const sem = {
      currency: 'USD',
      timezone: 'UTC',
      date_from: '2026-09-01',
      date_to: '2026-09-02',
      attribution: 'unknown',
      conversion_definition: 'unknown',
      source_name: 'Synthetic',
      complete: false,
    },
    input = {
      preset: 'tiktok_ad',
      account_id: '100',
      connection_id: 'synthetic',
      reporting_contract: overviewConfigV4,
      allow_partial: true,
      semantics: sem,
    };
  assert.throws(
    () => reportPreset(input),
    error => error.code === 'INVALID_DATE_RANGE',
  );
  assert.equal(reportPreset(input, {overviewV4: true}).arguments.query.metrics.includes('result'), true);
  assert.throws(
    () => reportPreset({...input, semantics: {...sem, date_to: '2099-01-01'}}, {overviewV4: true}),
    error => error.code === 'INVALID_DATE_RANGE',
  );
  assert.throws(
    () => reportPreset({...input, preset: 'meta_ad', attribution_windows: ['7d_click']}),
    /exact native Meta result action_type/,
  );
});

test('D22 notice is carried and spent once by the first completed snapshot of a report that ran before, and persists in History without editing v3', async t => {
  const f = objectiveReportFixture(t, {
      rows: [{campaign_id: '1', objective: 'OUTCOME_TRAFFIC', metrics: {spend: 10, impressions: 100, clicks: 2}}],
    }),
    legacy = {...f.config, sources: [{...f.config.sources[0], objective: 'sales'}]},
    saved = await f.overview.handle({action: 'save', confirmed: true, config: legacy}, f.actor);
  // Work-here ran this report before: a retained finished snapshot is what makes the upgrade change its numbers.
  f.store.putDocument(f.actor.tenantId, 'overview_report', 'ran-before', {
    config: legacy,
    view_id: saved.id,
    schedule_id: null,
    state: 'complete',
    created_at: 10,
    completed_at: 20,
    rows: [],
    sources: [],
  });
  const original = JSON.stringify(f.store.document(f.actor.tenantId, 'overview_view', saved.id).config),
    // Both runs are queued before either finishes, as two people (or a person and a schedule) can.
    first = await f.overview.handle({action: 'run', id: saved.id, confirmed: true}, f.actor),
    second = await f.overview.handle({action: 'run', id: saved.id, confirmed: true}, f.actor);
  await f.worker.once();
  await f.worker.once();
  const a = await f.overview.handle({action: 'get', id: first.id}, f.actor),
    b = await f.overview.handle({action: 'get', id: second.id}, f.actor),
    notices = snapshot => (snapshot.notices ?? []).filter(notice => notice.id === 'objective-fallback-v4');
  assert.equal(a.state, 'complete');
  assert.equal(b.state, 'complete');
  assert.equal(
    notices(a).length + notices(b).length,
    1,
    'concurrently queued snapshots do not duplicate the migration notice',
  );
  assert.equal(a.rows[0].objective.group, 'traffic', 'provider objective now takes precedence over the saved fallback');
  assert.equal(JSON.stringify(f.store.document(f.actor.tenantId, 'overview_view', saved.id).config), original);
  const history = await f.overview.handle({action: 'list'}, f.actor);
  assert.equal(history.reports.flatMap(notices).length, 1);
  assert.equal(
    notices(await f.overview.handle({action: 'get', id: first.id}, f.actor)).length +
      notices(await f.overview.handle({action: 'get', id: second.id}, f.actor)).length,
    1,
  );
});

test('saved v4 definitions keep an independently readable v3 form and the current public form', async t => {
  const f = objectiveReportFixture(t, {
      rows: [{campaign_id: '1', objective: 'OUTCOME_TRAFFIC', metrics: {spend: 10, impressions: 100, clicks: 2}}],
    }),
    saved = await f.overview.handle(
      {
        action: 'save',
        confirmed: true,
        config: {
          ...f.config,
          contract_version: overviewConfigV4,
          sources: [{...f.config.sources[0], objective: 'sales', levels: ['campaign'], delivered_only: false}],
        },
      },
      f.actor,
    ),
    stored = f.store.document(f.actor.tenantId, 'overview_view', saved.id);
  assert.equal(saved.config.contract_version, overviewConfigV4);
  assert.equal(saved.config_v4, undefined, 'public definition has only the current form');
  assert.equal(stored.config.contract_version, undefined);
  assert.equal(stored.config.sources[0].objective, 'sales');
  assert.equal(stored.config.sources[0].levels, undefined);
  assert.deepEqual(stored.config.sources[0].report_options, {attribution_windows: ['7d_click', '1d_view']});
  assert.equal(overviewSourceLevel(stored.config.sources[0]).id, 'campaign', 'old validation accepts the v3 form');
  assert.equal(stored.config_v4.sources[0].objective, undefined);
  assert.equal(stored.config_v4.sources[0].objective_fallback, 'sales');
  assert.deepEqual(
    stored.config_v4.sources.map(row => [row.account_id, row.connection_id]),
    stored.config.sources.map(row => [row.account_id, row.connection_id]),
  );
  const snapshot = await f.finish(await f.overview.handle({action: 'run', id: saved.id, confirmed: true}, f.actor));
  assert.equal(snapshot.rows[0].objective.group, 'traffic');
  assert.equal(snapshot.config.contract_version, overviewConfigV4);
});

test('an old binary refuses unrepresentable v4 scopes instead of silently widening a saved report', async t => {
  const f = objectiveReportFixture(t),
    saved = await f.overview.handle(
      {
        action: 'save',
        confirmed: true,
        config: {
          ...f.config,
          contract_version: overviewConfigV4,
          sources: [{...f.config.sources[0], levels: ['campaign', 'ad'], campaign_ids: ['1']}],
        },
      },
      f.actor,
    ),
    stored = f.store.document(f.actor.tenantId, 'overview_view', saved.id);
  assert.equal(stored.config.sources.length, 1, 'old account authorization remains mandatory');
  assert.equal(stored.config.sources[0].account_id, '100');
  assert.equal(stored.config.sources[0].level, 'v4_required');
  assert.throws(
    () => overviewSourceLevel(stored.config.sources[0]),
    error => error.code === 'INVALID_REPORT_LEVEL',
  );
  const bootstrap = await f.overview.handle({action: 'bootstrap'}, f.actor),
    current = bootstrap.views.find(view => view.id === saved.id);
  assert.deepEqual(current.config.sources[0].levels, ['campaign', 'ad']);
  assert.equal(current.config_v4, undefined);
});

test('rollback keeps a delivered-only report runnable: the flag stays in the v4 form, Work-here shows every row', () => {
  const legacy = delivered_only =>
    overviewDefinitionForms(
      {
        contract_version: overviewConfigV4,
        sources: [
          normalizeOverviewV4Source(
            {platform: 'google', account_id: '100', connection_id: 'login', delivered_only},
            reportSource('google').overview,
          ),
        ],
      },
      platform => reportSource(platform).overview,
    ).config.sources[0];
  // D21: delivered_only defaults to true, so refusing it refused every new report on the build a rollback returns to.
  // Work-here also shows rows without activity; its totals are the same (tests/report-rollback-form.test.mjs).
  assert.equal(legacy(true).level, 'campaign');
  assert.equal(overviewSourceLevel(legacy(true)).id, 'campaign');
  assert.equal(legacy(true).delivered_only, undefined);
  assert.equal(legacy(false).level, 'campaign');
  assert.equal(legacy(false).delivery_metrics, undefined);
  assert.equal(legacy(false).status_basis, undefined);
});

test('v4 rollback preserves incomplete campaign declarations instead of silently restoring advice', () => {
  const legacy = (platform, level, complete) => {
    const source = normalizeOverviewV4Source(
      {
        platform,
        account_id: '100',
        connection_id: 'login',
        level,
        delivered_only: false,
        report_options: {complete_window: complete},
      },
      reportSource(platform).overview,
    );
    return overviewDefinitionForms(
      {contract_version: overviewConfigV4, sources: [source]},
      platform => reportSource(platform).overview,
    ).config.sources[0];
  };
  for (const platform of ['meta', 'google', 'linkedin', 'tiktok', 'snapchat', 'microsoft', 'reddit', 'apple', 'x']) {
    const projected = legacy(platform, 'campaign', false);
    assert.equal(projected.level, 'v4_required', platform + ': an explicit incomplete declaration is not discarded');
    assert.throws(
      () => overviewSourceLevel(projected),
      error => error.code === 'INVALID_REPORT_LEVEL',
    );
    assert.equal(legacy(platform, 'campaign', true).level, 'campaign');
  }
  // A campaign-level source has no window declaration in the v3 form, for any platform: an undeclared window is the
  // ordinary v3 campaign report, not a v4-only one (F-L6-02, F-L6-01). Detail levels keep their declaration rule.
  for (const platform of ['tiktok', 'snapchat']) {
    assert.equal(legacy(platform, 'campaign', null).level, 'campaign', platform + ': undeclared campaign window');
    assert.equal(legacy(platform, 'ad', null).level, 'v4_required', platform + ': undeclared detail window');
  }
  assert.equal(
    legacy('google', 'adset', false).level,
    'adset',
    'v3 detail already represents declared-incomplete windows',
  );
});

test('the real v4 worker retains large decimal strings through row formulas, summaries and advisory review', async t => {
  const raw = {
      campaign: {id: '1'},
      metrics: {
        costMicros: '9007199254740993123456.789',
        conversions: '3',
        conversionsValue: '9007199254740994.123456789',
        impressions: '100',
        clicks: '30',
      },
    },
    normalized = normalizeNativeRowV4('google', raw),
    resolved = reportSource('google').readResult(raw, {
      level: 'campaign',
      range: {since: '2026-09-01', until: '2026-09-02'},
    }),
    f = objectiveReportFixture(t, {
      platform: 'google',
      rows: [{...normalized, result: resolved.result, result_context: resolved}],
    }),
    snapshot = await f.run({
      contract_version: overviewConfigV4,
      sources: [{...f.config.sources[0], objective_fallback: 'sales'}],
      metrics: [...f.config.metrics, 'cpa'],
      custom_metrics: [{id: 'profit', label: 'Profit', formula: 'conversion_value - spend'}],
    });
  assert.equal(snapshot.state, 'complete', JSON.stringify(snapshot.error));
  assert.equal(snapshot.rows[0].metrics.spend, '9007199254740993.123456789');
  assert.equal(snapshot.rows[0].metrics.cpa, '3002399751580331.041152263');
  assert.equal(snapshot.rows[0].metrics.profit, '1');
  assert.equal(snapshot.summary[0].metrics.spend, '9007199254740993.123456789');
  assert.equal(snapshot.rows[0].recommendation.decision, 'needs_review');
});

test('v4 single-measurement reach and frequency preserve native decimal text without summing or unsafe display numbers', () => {
  const source = {...granularSource('meta', 'adset'), reporting_contract: overviewConfigV4},
    metrics = {
      entity_id: '201',
      entity_name: 'Synthetic set',
      spend: '1',
      impressions: '10',
      clicks: '2',
      conversions: null,
      reach: '9007199254740993',
      frequency: '1.123456789012345',
    },
    raw = {campaign_id: '101', adset_id: '201'},
    capture = {rows: [metrics], native_rows: [raw], semantics: {currency: 'USD'}},
    row = detailedOverviewRows(source, capture)[0];
  assert.equal(row.metrics.reach, '9007199254740993');
  assert.equal(row.metrics.frequency, '1.123456789012345');
  assert.equal(row.native.exact_totals.reach, undefined);
  const multiple = detailedOverviewRows(source, {...capture, rows: [metrics, metrics], native_rows: [raw, raw]})[0];
  assert.equal(multiple.metrics.reach, null);
  assert.equal(multiple.metrics.frequency, null);
  assert.throws(
    () => detailedOverviewRows(source, {...capture, rows: [{...metrics, reach: 9007199254740992}]}),
    error => error.code === 'METRIC_PRECISION_LOSS',
  );
  const group = normalizeNativeRowV4('linkedin', {
    pivotValues: ['urn:li:sponsoredCampaignGroup:20'],
    objectiveType: 'BRAND_AWARENESS',
    approximateMemberReach: '9007199254740993',
  });
  assert.equal(group.metrics.reach, '9007199254740993');
});
