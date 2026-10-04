import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocationCalibrationFixture,
  calibrationNow,
  calibrationReport,
  calibrationIds,
} from './fixtures/allocation-calibration-data.mjs';
import {linkedinAllocationFixture, linkedinAllocationIds} from './fixtures/linkedin-allocation-data.mjs';
import {snapchatAllocationData, snapchatAllocationIds} from './fixtures/snapchat-allocation-data.mjs';

const call = (f, input = f.input) => f.service.call('amcp_reporting', input, f.actor);
test('historical allocation calibration is readable without upload/write grants and retains exact original units', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  const f = allocationCalibrationFixture(t),
    before = f.store.document(f.actor.tenantId, 'decision_report', f.input.id);
  const out = await call(f);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.data.record_kind, 'allocation_calibration');
  assert.deepEqual(
    out.data.entities.map(row => row.entity_id),
    calibrationIds,
  );
  assert.equal(out.data.entities[0].folds.length, 7);
  assert.equal(out.data.entities[0].mean_absolute_error, '0');
  assert.deepEqual(out.data.factor_envelope, {efficiency_low: '1', efficiency_high: '1', applicable: true});
  assert.equal(out.data.network_requests, 0);
  assert.equal(out.data.advertising_writes, 0);
  assert.equal(f.nativeCalls(), 0);
  assert.deepEqual(f.store.document(f.actor.tenantId, 'decision_report', f.input.id), before);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_plan').length, 0);
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE-CALIBRATION|"source_request"|accessToken/);
});

test('each held-out conversion estimate uses only earlier dates and known test spend, never later conversions', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  const report = calibrationReport();
  report.rows[7].conversions = '3';
  const f = allocationCalibrationFixture(t, report),
    out = await call(f);
  assert.equal(out.success, true, JSON.stringify(out));
  const fold = out.data.entities[0].folds[0];
  assert.equal(fold.expected_conversions, '2');
  assert.equal(fold.observed_conversions, '3');
  assert.equal(fold.observed_to_expected, '1.5');
  assert.ok(fold.training_date_to < fold.test_date);
  assert.equal(out.data.entities[0].folds[1].expected_conversions, '2.142857142');
  // Independent hand calculation: errors are 1 then six -1/7 values, so MAE=13/49 and mean error=1/49.
  assert.equal(out.data.entities[0].mean_absolute_error, '0.265306122');
  assert.equal(out.data.entities[0].mean_error, '0.020408163');
  assert.equal(out.data.entities[0].efficiency_low, '0.933333');
  assert.equal(out.data.entities[0].efficiency_high, '1.5');
  assert.equal(out.data.entities[0].observed_inside_band, 7);
  assert.equal(out.data.horizon_days, 1);
  assert.match(out.data.limitations.join(' '), /not a forecast/);
});

test('daily row order does not change errors, quantiles or exact entity order', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  const original = calibrationReport(),
    shuffled = structuredClone(original);
  shuffled.rows.reverse();
  const a = allocationCalibrationFixture(t, original),
    b = allocationCalibrationFixture(t, shuffled);
  const first = await call(a),
    second = await call(b);
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.deepEqual(first.data.entities, second.data.entities);
  assert.deepEqual(first.data.factor_envelope, second.data.factor_envelope);
});

test('large spend strings and fractional conversion counts retain exact arithmetic until text projection', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  const report = calibrationReport();
  report.rows.forEach(row => {
    row.spend = '9007199254740993.000000001';
    row.conversions = '1.123456789';
  });
  const f = allocationCalibrationFixture(t, report),
    out = await call(f, {...f.input, options: {...f.input.options, minimum_training_conversions: 1}});
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.data.entities[0].folds[0].training_spend, '63050394783186951.000000007');
  assert.equal(out.data.entities[0].folds[0].expected_conversions, '1.123456789');
  assert.equal(out.data.entities[0].mean_absolute_error, '0');
  assert.equal(out.data.factor_envelope.efficiency_low, '1');
});

test('zero observed conversions are real zeros and produce an unapplied factor rather than a clipped positive value', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  const report = calibrationReport();
  report.rows[7].conversions = '0';
  const f = allocationCalibrationFixture(t, report),
    out = await call(f);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.data.entities[0].folds[0].observed_to_expected, '0');
  assert.equal(out.data.entities[0].efficiency_low, '0');
  assert.equal(out.data.entities[0].applicable, false);
  assert.deepEqual(out.data.factor_envelope, {efficiency_low: null, efficiency_high: null, applicable: false});
});

test('zero expected counts and insufficient training keep every test day with explicit unknown ratios', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  for (const change of ['zero_expected', 'insufficient_training']) {
    const report = calibrationReport();
    if (change === 'zero_expected') report.rows[7].spend = '0';
    else report.rows.slice(0, 7).forEach(row => (row.conversions = '0'));
    const f = allocationCalibrationFixture(t, report),
      out = await call(f);
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.entities[0].folds[0].status, change);
    assert.equal(out.data.entities[0].folds[0].observed_to_expected, null);
    assert.equal(out.data.entities[0].folds.length, 7);
    assert.ok(out.data.entities[0].unknown_ratio_days > 0);
    assert.equal(out.data.factor_envelope.applicable, false);
  }
});

test('factor values above the existing planning ceiling remain visible and cannot be automatically narrowed', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  const report = calibrationReport();
  report.rows[7].conversions = '22.000001';
  const f = allocationCalibrationFixture(t, report),
    out = await call(f);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.data.entities[0].folds[0].observed_to_expected, '11.0000005');
  assert.equal(out.data.entities[0].efficiency_high, '11.000001');
  assert.equal(out.data.factor_envelope.applicable, false);
});

test('malformed, unknown, incomplete, duplicated and unsupported native evidence is refused without egress or rewriting', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  const edits = [
    r => r.rows.splice(2, 1),
    r => r.rows.push({...r.rows[0]}),
    r => (r.rows[1].spend = null),
    r => (r.rows[1].conversions = null),
    r => (r.rows[1].spend = 1),
    r => (r.rows[1].conversions = '1e2'),
    r => (r.rows[1].date = '2026-02-30'),
    r => (r.rows[1].entity_id = 9007199254740993),
    r => (r.semantics.complete = false),
    r => (r.semantics.currency = 'XXX'),
    r => (r.semantics.attribution = 'unknown'),
    r => (r.semantics.timezone = 'not/a/zone'),
    r => (r.source = 'overview_snapshot'),
    r => (r.preset = 'meta_ad'),
    r => (r.source_hash = 'unqualified'),
    r => (r.captured_at = calibrationNow + 1),
  ];
  for (const edit of edits) {
    const report = calibrationReport();
    edit(report);
    const f = allocationCalibrationFixture(t, report),
      before = JSON.stringify(f.store.document(f.actor.tenantId, 'decision_report', report.id));
    assert.equal((await call(f)).success, false, edit.toString());
    assert.equal(f.nativeCalls(), 0);
    assert.equal(JSON.stringify(f.store.document(f.actor.tenantId, 'decision_report', report.id)), before);
  }
});

test('selection, training, sample, age and option bounds fail before any result or saved plan', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  const f = allocationCalibrationFixture(t);
  for (const patch of [
    {ids: []},
    {ids: [calibrationIds[0], calibrationIds[0]]},
    {ids: ['foreign']},
    {ids: Array(21).fill('10')},
    {options: {training_days: 6}},
    {options: {training_days: 22}},
    {options: {training_days: 8}},
    {options: {minimum_training_conversions: 0}},
    {options: {minimum_training_conversions: 1.5}},
    {options: {maximum_age_days: 0}},
    {options: {maximum_age_days: 91}},
    {options: {central_share_percent: 99}},
    {options: {central_share_percent: '80'}},
    {options: {budget: '100'}},
  ]) {
    assert.equal((await call(f, {...f.input, ...patch})).success, false, JSON.stringify(patch));
  }
  for (const days of [13, 32]) {
    const g = allocationCalibrationFixture(t, calibrationReport(days));
    assert.equal((await call(g)).success, false);
  }
  assert.equal(f.nativeCalls(), 0);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_plan').length, 0);
});

test('fresh capture time cannot make stale or still-open account calendar dates recent', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  for (const type of ['old', 'open']) {
    const report = calibrationReport(),
      offset = type === 'old' ? -30 : 1;
    report.rows.forEach(
      row => (row.date = new Date(Date.parse(row.date) + offset * 86400000).toISOString().slice(0, 10)),
    );
    report.semantics.date_from = report.rows[0].date;
    report.semantics.date_to = report.rows[13].date;
    const f = allocationCalibrationFixture(t, report);
    assert.equal((await call(f)).success, false, type);
    assert.equal(f.nativeCalls(), 0);
  }
});

test('current key, tenant and original account authorization are checked before and after a local calibration', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  const f = allocationCalibrationFixture(t);
  assert.equal((await f.service.call('amcp_reporting', f.input, {...f.actor, tenantId: 'foreign'})).success, false);
  f.store.putConnection({...f.actor, role: 'admin'}, {...f.connection, accounts: ['200']}, {accessToken: 'synthetic'});
  assert.equal((await call(f)).success, false);
  f.store.putConnection({...f.actor, role: 'admin'}, f.connection, {accessToken: 'synthetic'});
  const resolve = f.store.resolveConnection.bind(f.store);
  let reads = 0;
  f.store.resolveConnection = (...args) => {
    reads++;
    if (reads === 2) f.store.revokeKey(f.key);
    return resolve(...args);
  };
  assert.equal((await call(f)).success, false);
  assert.equal(f.nativeCalls(), 0);
});

test('a genuine synthetic LinkedIn daily capture retains original URNs, UTC source and account proof without extra reads', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  const f = linkedinAllocationFixture(t);
  const nativeDate = text => {
    const [year, month, day] = text.split('-').map(Number);
    return {year, month, day};
  };
  f.capture.semantics.date_from = '2026-09-20';
  f.capture.semantics.date_to = '2026-10-03';
  const original = f.analytics.elements.slice(0, 2);
  f.analytics.elements = Array.from({length: 14}, (_, i) =>
    new Date(Date.UTC(2026, 8, 20 + i)).toISOString().slice(0, 10),
  ).flatMap(date => original.map(row => ({...row, dateRange: {start: nativeDate(date), end: nativeDate(date)}})));
  const captured = await f.call(f.capture);
  assert.equal(captured.success, true, JSON.stringify(captured));
  const reads = f.requests.length,
    ids = linkedinAllocationIds.map(id => 'urn:li:sponsoredCampaign:' + id);
  const out = await f.call({action: 'calibrate_allocation', id: captured.data.id, ids});
  assert.equal(out.success, true, JSON.stringify(out));
  assert.deepEqual(
    out.data.entities.map(row => row.entity_id),
    ids,
  );
  assert.equal(out.data.semantics.timezone, 'UTC');
  assert.equal(out.data.gateway, 'linkedin_native_action');
  assert.equal(out.data.source_hash, captured.data.source_hash);
  assert.equal(f.requests.length, reads);
  const report = f.store.document(f.actor.tenantId, 'decision_report', captured.data.id);
  report.source_request.query.accounts = 'List(urn:li:sponsoredAccount:200)';
  f.store.putDocument(f.actor.tenantId, 'decision_report', captured.data.id, report);
  assert.equal((await f.call({action: 'calibrate_allocation', id: captured.data.id, ids})).success, false);
  assert.equal(f.requests.length, reads);
});

test('supported Google campaign and parent-bound Snapchat ad-squad history preserve native units and selected parent boundaries', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  for (const provider of ['google', 'snapchat']) {
    const report = calibrationReport();
    let ids = calibrationIds;
    if (provider === 'google') {
      report.gateway = 'google_ads_native_action';
      report.preset = 'google_campaign';
    } else {
      const source = snapchatAllocationData().report;
      Object.assign(report, {
        gateway: source.gateway,
        preset: source.preset,
        grain: source.grain,
        account_id: source.account_id,
        source_request: source.source_request,
        native_account_evidence: source.native_account_evidence,
      });
      ids = snapchatAllocationIds;
      report.rows.forEach(row => (row.entity_id = ids[calibrationIds.indexOf(row.entity_id)]));
    }
    const f = allocationCalibrationFixture(t, report),
      out = await call(f, {...f.input, ids});
    assert.equal(out.success, true, JSON.stringify(out));
    assert.deepEqual(
      out.data.entities.map(row => row.entity_id),
      ids,
    );
    assert.equal(out.data.entity_kind, provider === 'google' ? 'campaign' : 'ad_squad');
    assert.equal(f.nativeCalls(), 0);
    if (provider === 'snapchat') {
      assert.equal(out.data.parent_campaign_id, report.source_request.path_params.campaign_id);
      report.native_account_evidence.parent_campaign.account_id = 'foreign';
      f.store.putDocument(f.actor.tenantId, 'decision_report', report.id, report);
      assert.equal((await call(f, {...f.input, ids})).success, false);
    }
  }
});

test('the maximum declared workload stays bounded and normalizes defaults without losing exact source identity', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  const report = calibrationReport(31),
    original = report.rows.slice(0, 31),
    ids = Array.from({length: 20}, (_, i) => String(9007199254740993n + BigInt(i)));
  report.rows = ids.flatMap(entity_id => original.map(row => ({...row, entity_id})));
  const f = allocationCalibrationFixture(t, report),
    a = await call(f, {...f.input, ids}),
    b = await call(f, {...f.input, ids, options: {}});
  assert.equal(a.success, true, JSON.stringify(a));
  assert.equal(b.success, true);
  assert.equal(a.data.entities.length, 20);
  assert.equal(
    a.data.entities.reduce((n, row) => n + row.folds.length, 0),
    480,
  );
  assert.equal(a.data.evidence_fingerprint, b.data.evidence_fingerprint);
  assert.ok(Buffer.byteLength(JSON.stringify(a.data)) < 600000);
  assert.equal(f.nativeCalls(), 0);
});
