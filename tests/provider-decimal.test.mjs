// RPT-01 regression suite: provider report numbers are parsed losslessly and rounded half to even at nine places
// (owner decision D10). Every provider response here is synthetic; no network or provider account is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProviderDecimal,
  providerDecimalText,
  sumProviderDecimals,
  mergeMetricRounding,
  metricRoundingLimitation,
} from '../dist/src/provider-decimal.js';
import {DecisionReporting} from '../dist/src/decision-reporting.js';
import {reportAllocation} from '../dist/src/report-allocation.js';
import {calibrateAllocation} from '../dist/src/allocation-calibration.js';
import {losslessReportNumbers} from '../dist/src/transport.js';
import {calibrationNow, calibrationReport, calibrationIds} from './fixtures/allocation-calibration-data.mjs';
import {overviewGranularityFixture, granularSource, granularConfig} from './fixtures/overview-granularity-data.mjs';

const nine = value => {
  const {scaled, rounded} = parseProviderDecimal(value, {field: 'conversions'}),
    whole = scaled / 1000000000n,
    fraction = (scaled % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
  return [fraction ? whole + '.' + fraction : String(whole), rounded];
};

test('long provider doubles, long strings and exponent forms round half to even at nine places instead of failing', () => {
  // Each of these failed the whole source with INVALID_ARGUMENT before RPT-01.
  assert.deepEqual(nine(1 / 3), ['0.333333333', true]);
  assert.deepEqual(nine(0.1 + 0.2), ['0.3', true]);
  assert.deepEqual(nine('1.0379464285714'), ['1.037946429', true]);
  assert.deepEqual(nine(1e-7), ['0.0000001', false]);
  assert.deepEqual(nine('12.000000000000002'), ['12', true]);
  assert.deepEqual(nine(2 / 3), ['0.666666667', true]);
  assert.deepEqual(nine(3.0000000000000004), ['3', true]);
  assert.deepEqual(nine('1.2E+3'), ['1200', false]);
  assert.deepEqual(nine('5e-10'), ['0', true], 'An exact half rounds to the even neighbor (zero)');
  assert.deepEqual(nine('0.0000000015'), ['0.000000002', true], 'An exact half rounds to the even neighbor');
  assert.deepEqual(nine('0.0000000025'), ['0.000000002', true]);
  assert.deepEqual(nine('0.00000000250001'), ['0.000000003', true]);
  // Exact values with up to nine places are unchanged and never marked rounded.
  for (const value of ['0', '2.5', '12.345678912', '9007199254740993.000000001', 7, 2.5])
    assert.equal(nine(value)[1], false, String(value));
  assert.deepEqual(nine('9007199254740993.000000001'), ['9007199254740993.000000001', false]);
});

test('native unit divisors apply to the exact decimal text before rounding', () => {
  const at = (value, divisor) => parseProviderDecimal(value, {field: 'spend', divisor});
  assert.deepEqual(at('9007199254740993', 1000000), {scaled: 9007199254740993000n, rounded: false});
  // The old BigInt division truncated 0.0000015 / 1e6 to zero silently; now the rounding is explicit.
  assert.deepEqual(at('1.5', 1000000000), {scaled: 2n, rounded: true});
  assert.deepEqual(at('2.5', 1000000000), {scaled: 2n, rounded: true});
  assert.equal(providerDecimalText('1234567', {field: 'spend', divisor: 1000000}), '1.234567');
});

test('display-only reach and frequency keep exact provider text', () => {
  assert.equal(providerDecimalText('1.0379464285714', {field: 'frequency'}), '1.0379464285714');
  assert.equal(providerDecimalText(1.0379464285714, {field: 'frequency'}), '1.0379464285714');
  assert.equal(providerDecimalText(1e-7, {field: 'frequency'}), '0.0000001');
  assert.equal(providerDecimalText('1.250', {field: 'frequency'}), '1.25');
  assert.equal(providerDecimalText('8e2', {field: 'reach'}), '800');
});

// Package meta-results: Meta reports one count per requested attribution window; the windows add exactly.
test('provider decimals add exactly and keep every digit of the sum (package meta-results)', () => {
  const sum = (...values) => sumProviderDecimals(values, {field: 'result'});
  assert.equal(sum('27', '3'), '30');
  assert.equal(sum('0.1', '0.2'), '0.3', 'a float sum would read 0.30000000000000004');
  assert.equal(sum('9007199254740993', '1'), '9007199254740994', 'past the exact float range');
  assert.equal(sum('1.250', '2'), '3.25', 'trailing zeros are not part of the value');
  assert.equal(sum('1e3', '5'), '1005', 'exponent forms are exact');
  assert.equal(sum('0.0000000001', '0.0000000002'), '0.0000000003', 'no rounding to nine places in the sum');
  assert.equal(sum(5, '0.5', 0.25), '5.75', 'JSON numbers are read as their shortest decimal text');
  assert.equal(sum('7'), '7');
  assert.equal(sum('0', '0'), '0');
  assert.equal(sum(), '0', 'an empty sum is zero; callers do not ask for it when nothing was reported');
  for (const bad of [-1, '-1', 'abc', '', '1,5', null, true, {}, NaN])
    assert.throws(
      () => sum('1', bad),
      error => error.code === 'REPORT_SHAPE_CHANGED' && error.details.field === 'result',
      String(bad),
    );
});

test('malformed provider values fail with a field-naming shape error, never a caller-input error', () => {
  for (const value of [-1, '-1', 'abc', '', '1,5', '1.', '.5', NaN, Infinity, -Infinity, null, true, {}, [], '0x10'])
    assert.throws(
      () => parseProviderDecimal(value, {field: 'conversions (/metrics/conversions)'}),
      error =>
        error.code === 'REPORT_SHAPE_CHANGED' &&
        error.details.field === 'conversions (/metrics/conversions)' &&
        error.message.includes('conversions'),
      String(value),
    );
  assert.throws(() => parseProviderDecimal(2 ** 53 + 2, {field: 'spend'}), {code: 'METRIC_PRECISION_LOSS'});
  assert.throws(() => providerDecimalText(-0.5, {field: 'frequency'}), {code: 'REPORT_SHAPE_CHANGED'});
});

test('per-period rounding records combine without inventing rounding for exact periods', () => {
  assert.equal(mergeMetricRounding([undefined, null, {}]), undefined);
  assert.deepEqual(
    mergeMetricRounding([
      {conversions: {places: 9, rule: 'half_even', rows_rounded: 2}},
      undefined,
      {conversions: {places: 9, rule: 'half_even', rows_rounded: 1}, spend: {rows_rounded: 1}},
    ]),
    {
      conversions: {places: 9, rule: 'half_even', rows_rounded: 3},
      spend: {places: 9, rule: 'half_even', rows_rounded: 1},
    },
  );
});

async function run(f, config) {
  const queued = await f.overview.handle({action: 'run', config, confirmed: true}, f.actor);
  assert.equal(await f.worker.once(), true);
  return f.overview.handle({action: 'get', id: queued.id}, f.actor);
}

test('fractional Google conversions no longer fail the source and the rounding is recorded in evidence', async () => {
  const f = overviewGranularityFixture();
  try {
    f.mutate((rows, platform) =>
      platform === 'google'
        ? rows.map((row, i) => ({...row, metrics: {...row.metrics, conversions: i ? 0.1 + 0.2 : 1 / 3}}))
        : rows,
    );
    const report = await run(f, granularConfig(granularSource('google', 'ad')));
    assert.equal(report.state, 'complete', JSON.stringify(report.sources));
    assert.equal(report.rows[0].native.exact_totals.conversions, '0.633333333');
    assert.deepEqual(report.sources[0].quality.metric_rounding, {
      conversions: {places: 9, rule: 'half_even', rows_rounded: 2},
    });
    assert.equal(report.rows[0].quality.metric_rounding.conversions.rows_rounded, 2);
  } finally {
    f.close();
  }
});

test('exact nine-place detail totals stay unchanged and carry no rounding record', async () => {
  const f = overviewGranularityFixture();
  try {
    const report = await run(f, granularConfig(granularSource('meta', 'ad')));
    assert.equal(report.state, 'complete');
    assert.equal(report.rows[0].native.exact_totals.spend, '0.200000002');
    assert.equal(report.sources[0].quality.metric_rounding, undefined);
  } finally {
    f.close();
  }
});

test('a negative provider metric fails its detailed source with a field-naming shape error', async () => {
  const f = overviewGranularityFixture();
  try {
    f.mutate((rows, platform) =>
      platform === 'google' ? rows.map(row => ({...row, metrics: {...row.metrics, conversions: -1}})) : rows,
    );
    const report = await run(f, granularConfig(granularSource('google', 'ad')));
    assert.equal(report.state, 'failed');
    assert.equal(report.sources[0].error.code, 'REPORT_SHAPE_CHANGED', JSON.stringify(report.sources[0].error));
    assert.notEqual(report.sources[0].error.code, 'INVALID_ARGUMENT');
  } finally {
    f.close();
  }
});

test('capture_overview accepts a 13-decimal Meta frequency snapshot and rounds additive values half to even', async () => {
  const f = overviewGranularityFixture();
  try {
    f.mutate((rows, platform) =>
      platform === 'meta' ? rows.map(row => ({...row, frequency: '1.0379464285714', spend: '0.1000000015'})) : rows,
    );
    const {level, report_options, ...campaign} = granularSource('meta');
    const snapshot = await run(f, granularConfig(campaign, 'daily'));
    assert.equal(snapshot.state, 'complete', JSON.stringify(snapshot.sources));
    const reporting = new DecisionReporting(f.store, (gateway, args, actor) => f.service.call(gateway, args, actor));
    const groups = await reporting.handle({action: 'overview_sources', id: snapshot.id}, f.actor);
    const captured = await reporting.handle(
      {action: 'capture_overview', id: snapshot.id, group_id: groups.groups[0].id},
      f.actor,
    );
    assert.equal(captured.rows[0].frequency, '1.0379464285714', 'Frequency keeps its exact display text');
    assert.equal(captured.rows[0].spend, '0.100000002', '0.1000000015 rounds half to even');
    assert.deepEqual(captured.semantics.metric_rounding, {spend: {places: 9, rule: 'half_even', rows_rounded: 2}});
    assert.equal(captured.totals.spend, '0.200000004');
    assert.equal(captured.totals.frequency, null, 'Frequency is never summed');
  } finally {
    f.close();
  }
});

test('the optional lossless report-number transport flag is off by default and limited to read-only report data plans', () => {
  const plan = (gateway, path, extra = {}) => ({gateway, path, method: 'GET', readOnly: true, ...extra});
  const on = {AMCP_REPORT_LOSSLESS_NUMBERS: 'true'};
  const reports = [
    plan('google_ads_native_action', '/v25/customers/123/googleAds:search', {method: 'POST'}),
    plan('meta_native_action', '/v26.0/act_100/insights'),
    plan('tiktok_native_action', '/v1.3/report/integrated/get/'),
    plan('snapchat_native_action', '/v1/adaccounts/abc/stats'),
    plan('linkedin_native_action', '/rest/adAnalytics'),
  ];
  for (const p of reports) {
    assert.equal(losslessReportNumbers(p, {}), false, 'Default keeps JSON numbers');
    assert.equal(losslessReportNumbers(p, on), true, p.path);
    assert.equal(losslessReportNumbers({...p, readOnly: false}, on), false, 'Writes are never affected');
  }
  for (const p of [
    plan('meta_native_action', '/v26.0/act_100'),
    plan('linkedin_native_action', '/rest/adAccounts/100'),
    plan('tiktok_native_action', '/v1.3/advertiser/info/'),
    plan('x_ads_native_action', '/12/stats/accounts/1'),
  ])
    assert.equal(losslessReportNumbers(p, on), false, p.path);
});

test('with the lossless report-number flag on, every qualified detail collector still completes exactly', async () => {
  const previous = process.env.AMCP_REPORT_LOSSLESS_NUMBERS;
  process.env.AMCP_REPORT_LOSSLESS_NUMBERS = 'true';
  try {
    for (const platform of ['meta', 'google', 'tiktok', 'snapchat', 'linkedin']) {
      const f = overviewGranularityFixture();
      try {
        const report = await run(f, granularConfig(granularSource(platform, 'ad')));
        assert.equal(report.state, 'complete', platform + ': ' + JSON.stringify(report.sources));
        assert.equal(report.rows[0].native.exact_totals.conversions, '4', platform);
      } finally {
        f.close();
      }
    }
    const f = overviewGranularityFixture();
    try {
      f.mutate((rows, platform) =>
        platform === 'google' ? rows.map(row => ({...row, metrics: {...row.metrics, conversions: 1 / 3}})) : rows,
      );
      const report = await run(f, granularConfig(granularSource('google', 'ad')));
      assert.equal(report.state, 'complete');
      assert.equal(report.rows[0].native.exact_totals.conversions, '0.666666666');
      assert.equal(report.rows[0].native.daily_rows[0].metrics.conversions, '0.3333333333333333', 'Exact source text');
    } finally {
      f.close();
    }
  } finally {
    if (previous === undefined) delete process.env.AMCP_REPORT_LOSSLESS_NUMBERS;
    else process.env.AMCP_REPORT_LOSSLESS_NUMBERS = previous;
  }
});

test('allocation and calibration disclose provider rounding only when the evidence records it', t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  const exact = calibrationReport(),
    rounded = calibrationReport();
  rounded.semantics = {
    ...rounded.semantics,
    metric_rounding: {conversions: {places: 9, rule: 'half_even', rows_rounded: 3}},
  };
  const options = {training_days: 7, minimum_training_conversions: 10, maximum_age_days: 7, central_share_percent: 80};
  assert.ok(!calibrateAllocation(exact, calibrationIds, options).limitations.includes(metricRoundingLimitation));
  assert.ok(calibrateAllocation(rounded, calibrationIds, options).limitations.includes(metricRoundingLimitation));
  const allocation = {
    budget: '200',
    efficiency_low: 0.8,
    efficiency_high: 1.2,
    maximum_age_days: 7,
    minimum_conversions: 5,
    allocations: calibrationIds.map(entity_id => ({entity_id, minimum: '25', maximum: '175'})),
  };
  assert.ok(!reportAllocation(exact, allocation).limitations.includes(metricRoundingLimitation));
  const modeled = reportAllocation(rounded, allocation);
  assert.ok(modeled.limitations.includes(metricRoundingLimitation));
  assert.notEqual(modeled.model_fingerprint, reportAllocation(exact, allocation).model_fingerprint);
});
