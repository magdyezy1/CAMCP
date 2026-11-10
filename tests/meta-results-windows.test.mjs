// Package meta-results (F-LEAD-02): under explicit attribution windows Meta's `actions[].value` is the ad set's own
// setting, and the count of each requested window is under the key named for it (the owner's live read of 2026-11-07,
// docs/records/META-RESULTS-PIN-2026-11-07.md). Every Meta action read of a v4 report honours the requested windows; a v3
// report keeps reading `.value`, exactly as before. Synthetic rows only; nothing reaches a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeNativeRow, normalizeNativeRowV4} from '../dist/src/report-native.js';
import {granularConfig, granularSource, overviewGranularityFixture} from './fixtures/overview-granularity-data.mjs';

const raw = (more = {}) => ({
  campaign_id: '1',
  campaign_name: 'Synthetic',
  objective: 'OUTCOME_LEADS',
  spend: '54',
  impressions: '1000',
  clicks: '10',
  ...more,
});
/** A v4 campaign row read under the report options of its source. */
const v4 = (row, windows) => normalizeNativeRowV4('meta', row, {}, {attribution_windows: windows});
const lead = more => ({action_type: 'lead', value: '34', ...more});

test('v4 campaign metrics read the requested window’s count, not the ad set’s setting', () => {
  const row = raw({actions: [lead({'1d_click': '27'})]});
  assert.equal(v4(row, ['1d_click']).metrics.leads, '27');
  assert.equal(v4(row, ['1d_click']).metrics.conversions, '27', 'the objective’s conversions follow');
  // Two windows add; a requested window with no key counts 0; a window that was not requested is not added.
  const two = raw({actions: [lead({'7d_click': '20', '1d_view': '7', '28d_click': '99'})]});
  assert.equal(v4(two, ['7d_click', '1d_view']).metrics.leads, '27');
  assert.equal(v4(raw({actions: [lead({'7d_click': '20'})]}), ['7d_click', '1d_view']).metrics.leads, '20');
  assert.equal(v4(raw({actions: [lead({'7d_click': '20'})]}), ['7d_click']).metrics.leads, '20');
  // The sum is exact.
  assert.equal(
    v4(raw({actions: [lead({'7d_click': '0.1', '1d_view': '0.2'})]}), ['7d_click', '1d_view']).metrics.leads,
    '0.3',
  );
});

test('v4 campaign metrics keep the ad set’s own value when no window was requested', () => {
  const row = raw({actions: [lead({'1d_click': '27'})]});
  assert.equal(v4(row, null).metrics.leads, '34', 'the unified setting');
  assert.equal(normalizeNativeRowV4('meta', row).metrics.leads, '34', 'a row read without the source’s options');
  assert.equal(normalizeNativeRowV4('meta', row, {}, {}).metrics.leads, '34', 'options that name no windows');
  assert.equal(
    v4(row, ['9d_click']).metrics.leads,
    '34',
    'a window list Meta does not offer is not an explicit selection',
  );
});

test('v4 action values follow the requested windows too', () => {
  const row = raw({
    objective: 'OUTCOME_SALES',
    actions: [{action_type: 'purchase', value: '9', '7d_click': '2', '1d_view': '1'}],
    action_values: [{action_type: 'purchase', value: '100', '7d_click': '60.25', '1d_view': '4.5'}],
  });
  const read = v4(row, ['7d_click', '1d_view']);
  assert.equal(read.metrics.purchases, '3');
  assert.equal(read.metrics.conversions, '3');
  assert.equal(read.metrics.conversion_value, '64.75');
  assert.equal(v4(row, null).metrics.conversion_value, '100');
});

test('an action with none of the requested keys is the omitted case: zero on a delivered row, unknown otherwise', () => {
  const row = raw({actions: [lead({'7d_click': '20'})]});
  const delivered = v4(row, ['1d_click']);
  assert.equal(delivered.metrics.leads, '0');
  assert.equal(delivered.metrics.conversions, '0');
  assert.ok(delivered.omitted_as_zero.includes('leads') && delivered.omitted_as_zero.includes('conversions'));
  const quiet = v4({...row, impressions: '0'}, ['1d_click']);
  assert.equal(quiet.metrics.leads, null);
  assert.equal(quiet.omitted_as_zero, undefined);
});

test('the first alias that Meta lists is the one read, and an alias without a count is never replaced by another', () => {
  const row = raw({
    actions: [lead(), {action_type: 'onsite_conversion.lead_grouped', value: '9', '1d_click': '9'}],
  });
  // `lead` is listed, has no 1d_click count, so the lead count is 0; the lower alias is not added or substituted.
  assert.equal(v4(row, ['1d_click']).metrics.leads, '0');
  assert.equal(
    v4(raw({actions: [{action_type: 'onsite_conversion.lead_grouped', value: '9', '1d_click': '9'}]}), ['1d_click'])
      .metrics.leads,
    '9',
  );
});

test('a v3 row reads value, whatever windows its report asks for', () => {
  const row = raw({actions: [lead({'1d_click': '27'})]});
  assert.equal(normalizeNativeRow('meta', row).metrics.leads, 34);
  assert.equal(normalizeNativeRow('meta', row).metrics.conversions, 34);
});

test('native action metrics (native_meta_actions_*) follow the requested windows in v4 and read value in v3', () => {
  const row = raw({
    actions: [lead({'1d_click': '27'}), {action_type: 'video_view', value: '8'}],
    outbound_clicks: [{action_type: 'outbound_click', value: '5'}],
  });
  const read = v4(row, ['1d_click']);
  assert.equal(read.metrics.native_meta_actions_lead, '27');
  assert.equal(
    read.metrics.native_meta_actions_video_view,
    undefined,
    'no count in the requested window: not a number',
  );
  assert.equal(
    read.metrics.native_meta_outbound_clicks_outbound_click,
    '5',
    'a list that is not split by window keeps its value',
  );
  assert.equal(v4(row, null).metrics.native_meta_actions_lead, '34');
  assert.equal(normalizeNativeRow('meta', row).metrics.native_meta_actions_lead, 34);
});

// A cost per action is the other native list that depends on the attribution (the bootstrap suggests it as a native metric of a
// campaign source). Its entry has the same shape as an action's: `value` is the ad set's own cost, and each requested window's
// own cost is under the window's name. Unlike a count, a cost does not add across windows.
const costRow = more =>
  raw({
    spend: '40',
    actions: [lead({'7d_click': '16', '1d_view': '4'})],
    cost_per_action_type: [{action_type: 'lead', value: '2', '7d_click': '2.5', '1d_view': '10'}],
    ...more,
  });
const nativeCost = (row, windows) => v4(row, windows).metrics.native_meta_cost_per_action_type_lead;

test('a cost per action under explicit windows is the requested window’s own cost, and has no number for several windows', () => {
  // One window: that window's own cost (40 spent over 16 and over 4), not the ad set's own 2.
  assert.equal(nativeCost(costRow(), ['7d_click']), '2.5');
  assert.equal(nativeCost(costRow(), ['1d_view']), '10');
  // Two windows: the cost of the pair is the spend over the pair's count (40 / 20 = 2), which is neither the sum of the two
  // costs (12.5) nor the ad set's own number. Costs do not add, and Meta sends no cost for the pair, so there is none.
  assert.equal(nativeCost(costRow(), ['7d_click', '1d_view']), undefined);
  // A window with no count has no key, so there is no cost for it.
  assert.equal(nativeCost(costRow(), ['1d_click']), undefined);
  // Under the ad set's own setting, with no options, and in v3 the entry's value is what the report asked for.
  assert.equal(nativeCost(costRow(), null), '2');
  assert.equal(normalizeNativeRowV4('meta', costRow()).metrics.native_meta_cost_per_action_type_lead, '2');
  assert.equal(normalizeNativeRow('meta', costRow()).metrics.native_meta_cost_per_action_type_lead, 2);
});

// The same through the queue, the worker and the collectors, as a person's report runs.
const range = ['2026-09-01', '2026-09-02'];
const windowedActions = (key, count) => [{action_type: 'lead', value: '10', [key]: count}];
async function run(f, config) {
  const queued = await f.overview.handle({action: 'run', config, confirmed: true}, f.actor);
  assert.equal(await f.worker.once(), true);
  return f.overview.handle({action: 'get', id: queued.id, limit: 100, include: {native: true}}, f.actor);
}
const metrics = ['spend', 'impressions', 'clicks', 'conversions', 'primary_result'];
function v4Config(source, grain = 'total') {
  return {...granularConfig(source, grain), contract_version: 'overview-config-v4', sources: [source], metrics};
}
function campaignSource(report_options) {
  const {objective, level, report_options: _v3, ...source} = granularSource('meta', 'campaign');
  return {...source, levels: ['campaign'], ...(report_options ? {report_options} : {})};
}
const leadRows = (rows, platform) =>
  platform === 'meta'
    ? rows.map(row => ({...row, objective: 'OUTCOME_LEADS', actions: windowedActions('7d_click', '4')}))
    : rows;

test('a v4 campaign report with the default windows counts the requested window in every period', async () => {
  const f = overviewGranularityFixture();
  try {
    // The windows are 7d_click and 1d_view: the ad set’s setting is 10, 7d_click counted 4 and 1d_view counted none.
    f.mutate(leadRows);
    const report = await run(f, v4Config(campaignSource(), 'daily'));
    assert.equal(report.state, 'complete', JSON.stringify(report.sources?.[0]?.error));
    assert.deepEqual(
      report.rows.map(row => row.metrics.conversions),
      ['4', '4'],
    );
    const request = f.requests.find(item => item.url.pathname.endsWith('/insights')).url.searchParams;
    assert.deepEqual(JSON.parse(request.get('action_attribution_windows')), ['7d_click', '1d_view']);
  } finally {
    f.close();
  }
});

test('a v4 campaign report under the unified setting, and a v3 report with an attribution profile, read value', async () => {
  const profile = (({objective, level, report_options, ...source}) => ({
    ...source,
    report_options: {attribution_windows: ['7d_click', '1d_view']},
  }))(granularSource('meta', 'campaign'));
  for (const [name, config] of [
    ['v4 unified', v4Config(campaignSource({attribution_windows: null}), 'daily')],
    ['v3 profile', granularConfig(profile, 'daily')],
  ]) {
    const f = overviewGranularityFixture();
    try {
      f.mutate(leadRows);
      const report = await run(f, config);
      assert.equal(report.state, 'complete', name + JSON.stringify(report.sources?.[0]?.error));
      assert.deepEqual(
        report.rows.map(row => String(row.metrics.conversions)),
        ['10', '10'],
        name + ': the ad set’s own value, which is what this report asked for or has always read',
      );
    } finally {
      f.close();
    }
  }
});

test('a v4 detail report with an exact action counts the requested window per day, and a v3 detail report reads value', async () => {
  for (const [name, v4Report, expected] of [
    ['v4', true, '8'],
    ['v3', false, '20'],
  ]) {
    const f = overviewGranularityFixture();
    try {
      f.mutate(leadRows);
      const {objective, level, ...source} = granularSource('meta', 'ad'),
        options = {complete_window: true, result_action_type: 'lead', attribution_windows: ['7d_click', '1d_view']},
        config = v4Report
          ? v4Config({...source, levels: ['ad'], report_options: options})
          : granularConfig({...source, level: 'ad', report_options: options});
      const report = await run(f, config);
      assert.equal(report.state, 'complete', name + JSON.stringify(report.sources?.[0]?.error));
      assert.equal(report.rows.length, 1, name);
      // 2 days of 4 on the requested window; 2 days of 10 on the ad set’s own setting.
      assert.equal(String(report.rows[0].metrics.conversions), expected, name);
      assert.equal(String(report.rows[0].native.exact_totals.conversions), expected, name);
    } finally {
      f.close();
    }
  }
});

test('a v4 detail report counts an action with no key for the requested windows as the omitted zero', async () => {
  const f = overviewGranularityFixture();
  try {
    f.mutate((rows, platform) =>
      platform === 'meta' ? rows.map(row => ({...row, actions: [lead({'28d_click': '9'})]})) : rows,
    );
    const {objective, level, ...source} = granularSource('meta', 'ad'),
      options = {complete_window: true, result_action_type: 'lead', attribution_windows: ['7d_click', '1d_view']};
    const report = await run(f, v4Config({...source, levels: ['ad'], report_options: options}));
    assert.equal(report.state, 'complete', JSON.stringify(report.sources?.[0]?.error));
    assert.equal(report.rows[0].metrics.conversions, '0');
    assert.deepEqual(report.rows[0].omitted_as_zero, ['conversions', 'conversion_value']);
  } finally {
    f.close();
  }
});

test('a v4 campaign report with a cost per action as a native metric never shows the ad set’s own cost under its windows', async () => {
  const costs = [{action_type: 'lead', value: '2', '7d_click': '2.5', '1d_view': '10'}];
  for (const [name, windows, expected] of [
    ['one window', ['7d_click'], {native: '2.5', cpa: '2.5'}],
    ['two windows', ['7d_click', '1d_view'], {native: null, cpa: '2'}],
    ['the ad set’s own setting', null, {native: '2', cpa: '2'}],
  ]) {
    const f = overviewGranularityFixture();
    try {
      f.mutate((rows, platform) =>
        platform === 'meta'
          ? rows.map(row => ({
              ...row,
              objective: 'OUTCOME_LEADS',
              spend: '40',
              actions: [lead({value: '20', '7d_click': '16', '1d_view': '4'})],
              cost_per_action_type: costs,
            }))
          : rows,
      );
      const source = {...campaignSource({attribution_windows: windows}), native_metrics: ['cost_per_action_type']},
        report = await run(f, {
          ...v4Config(source, 'daily'),
          metrics: ['spend', 'conversions', 'cpa', 'native_meta_cost_per_action_type_lead'],
        });
      assert.equal(report.state, 'complete', name + JSON.stringify(report.sources?.[0]?.error));
      for (const row of report.rows) {
        // The cost per action the row shows is the one its own cost per result (spend over the counted windows) agrees with.
        assert.equal(row.metrics.native_meta_cost_per_action_type_lead ?? null, expected.native, name);
        assert.equal(String(row.metrics.cpa), expected.cpa, name);
      }
    } finally {
      f.close();
    }
  }
});
