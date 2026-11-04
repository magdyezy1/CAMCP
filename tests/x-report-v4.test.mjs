import test from 'node:test';
import assert from 'node:assert/strict';
import {xCampaignReport} from '../dist/src/x-campaign-report.js';
import {normalizeNativeRowV4} from '../dist/src/report-native.js';
import {xReportSource} from '../dist/src/x-report-source.js';

const start = Date.parse('2026-09-01T00:00:00Z'),
  end = start + 3600000;
const inventory = [{id: 'one', name: 'One'}];
const analytics =
  (metric, calls = []) =>
  async query => {
    calls.push(query);
    const selected = query.placement === 'ALL_ON_TWITTER';
    return {data: [{id: 'one', id_data: [{segment: null, metrics: selected ? metric : {}}]}]};
  };

test('X v4 retains exact native totals, converts micros after aggregation and derives results without a float', async () => {
  const native = {billed_charge_local_micro: ['9007199254740993123456.789'], impressions: ['3'], url_clicks: ['3']};
  const report = await xCampaignReport(inventory, start, end, [], analytics(native), {exact: true});
  assert.equal(report.rows[0].metrics.spend, '9007199254740993.123456789');
  const normalized = normalizeNativeRowV4('x', report.rows[0]);
  assert.equal(normalized.native.exact_totals.spend, '9007199254740993.123456789');
  const result = xReportSource.readResult(report.rows[0], {
    objective: 'WEBSITE_CLICKS',
    level: 'campaign',
    range: {since: '2026-09-01', until: '2026-09-01'},
  });
  assert.equal(result.result.value, '3');
  assert.equal(result.result.cost_per_result, '3002399751580331.041152263');
});

test('X adds hourly native decimal text before rounding and records documented omitted-zero fields', async () => {
  const report = await xCampaignReport(
    inventory,
    start,
    start + 2 * 3600000,
    [],
    analytics({
      impressions: [null, null],
      billed_charge_local_micro: ['0.0005', '0.0005'],
      clicks: null,
    }),
    {exact: true},
  );
  assert.equal(report.rows[0].metrics.spend, '0.000000001', 'two half units round only after aggregation');
  assert.equal(report.rows[0].metrics.impressions, '0');
  const row = normalizeNativeRowV4('x', report.rows[0]);
  assert.deepEqual(row.omitted_as_zero, ['clicks', 'impressions']);
  assert.equal(row.metrics.video_views, null, 'an absent column is unknown');
});

test('X v4 refuses unsafe numeric inputs and binds exact checkpoints separately from legacy ones', async () => {
  await assert.rejects(
    () => xCampaignReport(inventory, start, end, [], analytics({impressions: [9007199254740992]}), {exact: true}),
    error => error.code === 'METRIC_PRECISION_LOSS',
  );
  let checkpoint;
  const first = await xCampaignReport(inventory, start, end, [], analytics({impressions: ['3']}), {
    exact: true,
    save: value => {
      checkpoint = structuredClone(value);
    },
  });
  const calls = [];
  const resumed = await xCampaignReport(inventory, start, end, [], analytics({}, calls), {exact: true, checkpoint});
  assert.deepEqual(resumed.rows, first.rows);
  assert.equal(calls.length, 0);
  await assert.rejects(
    () => xCampaignReport(inventory, start, end, [], analytics({}), {checkpoint}),
    error => error.code === 'REPORT_DEFINITION_CHANGED',
  );
});
