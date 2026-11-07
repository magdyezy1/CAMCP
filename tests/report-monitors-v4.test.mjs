// F-L5-06: a monitor never evaluated a v4 snapshot. Its metrics are exact decimal text, so `Number.isFinite` was false and
// every outcome was `data_unavailable`: a rule that silently stops firing is worse than none. A monitor now reads a v4
// summary as the exact decimal it is, compares it with the threshold as one, evaluates only a figure whose every unit is
// known (a partial total gives `data_unavailable` and the reason, never an incident), and may be declared on the
// `unknown` attribution and result definition a v4 snapshot records. A v3 snapshot is evaluated as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateMonitors, monitorOperation} from '../dist/src/report-monitors.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {row} from './helpers/report-packets.mjs';
import {reportEngine} from './helpers/report-engine.mjs';

const campaigns = spendOf =>
  Array.from({length: 28}, (_, i) => row('campaign', 'c' + i, {spend: spendOf(i), clicks: '7', conversions: '4'}));
const metrics = ['spend', 'clicks', 'conversions', 'cpa'];
/** A rule on the context of a summary, as the monitors page builds it from a retained snapshot. */
function saveMonitor(e, summary, more = {}) {
  return monitorOperation(e.store, e.actor, {
    action: 'save_monitor',
    confirmed: true,
    monitor: {
      name: 'Spend ceiling',
      platform: summary.platform,
      connection_id: 'login',
      account_id: summary.account_id,
      currency: summary.currency,
      timezone: summary.timezone,
      result_definition: summary.result_definition,
      attribution: summary.attribution,
      metric: 'spend',
      comparison: 'above',
      threshold: '200',
      max_age_hours: 24,
      ...more,
    },
  });
}
const incidents = e => e.store.documents(e.actor.tenantId, 'report_incident');

test('a breach in a v4 snapshot opens an incident whose value is the exact decimal', async t => {
  const e = reportEngine(t, {rowsFor: () => campaigns(() => '10.5')}),
    {stored} = await e.go(['campaign'], {metrics});
  assert.equal(stored.state, 'complete');
  assert.equal(
    typeof stored.summary[0].metrics.spend,
    'string',
    'a v4 summary holds text, which Number.isFinite refused',
  );
  saveMonitor(e, stored.summary[0]);
  const {outcomes} = evaluateMonitors(e.store, e.actor, stored.id);
  assert.equal(outcomes.length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes[0].state, 'open');
  assert.equal(outcomes[0].value, '294');
  const [incident] = incidents(e);
  assert.equal(incident.value, '294');
  assert.equal(incident.threshold, '200');
  assert.equal(incident.state, 'open');
  // A threshold above the total is within it.
  saveMonitor(e, stored.summary[0], {name: 'Roomy', threshold: '300'});
  const again = evaluateMonitors(e.store, e.actor, stored.id).outcomes.find(o => o.status === 'within_threshold');
  assert.equal(again.value, '294');
  // A CPA rule reads the calculated ratio the same way: 294 spent for 112 conversions is 2.625.
  saveMonitor(e, stored.summary[0], {name: 'CPA', metric: 'cpa', threshold: '2.6'});
  assert.ok(
    evaluateMonitors(e.store, e.actor, stored.id).outcomes.some(o => o.value === '2.625' && o.state === 'open'),
  );
});

test('a figure calculated from some of its rows is never compared: data_unavailable, with the reason, and no incident', async t => {
  // 28 campaigns, cost null on two: the spend is 273, above the threshold, and it is the sum of 26 rows.
  const e = reportEngine(t, {rowsFor: () => campaigns(i => (i < 2 ? null : '10.5'))}),
    {stored} = await e.go(['campaign'], {metrics});
  assert.equal(stored.state, 'complete');
  assert.equal(stored.summary[0].metrics.spend, '273');
  saveMonitor(e, stored.summary[0]);
  saveMonitor(e, stored.summary[0], {name: 'CPA', metric: 'cpa', threshold: '1'});
  const {outcomes} = evaluateMonitors(e.store, e.actor, stored.id);
  assert.deepEqual(
    outcomes.map(o => [o.status, o.reason]),
    [
      ['data_unavailable', 'partial_coverage'],
      ['data_unavailable', 'partial_coverage'],
    ],
  );
  assert.equal(incidents(e).length, 0, 'a partial number opens nothing');
  // The same rules fire once the figure is whole.
  const whole = reportEngine(t, {rowsFor: () => campaigns(() => '10.5')}),
    done = await whole.go(['campaign'], {metrics});
  saveMonitor(whole, done.stored.summary[0]);
  assert.equal(evaluateMonitors(whole.store, whole.actor, done.stored.id).outcomes[0].state, 'open');
});

test('an incident that is open stays open when the next snapshot is partial: missing evidence never resolves it', async t => {
  const e = reportEngine(t, {rowsFor: () => campaigns(() => '10.5')}),
    first = await e.go(['campaign'], {metrics});
  saveMonitor(e, first.stored.summary[0]);
  assert.equal(evaluateMonitors(e.store, e.actor, first.stored.id).outcomes[0].state, 'open');
  // A later run whose cost is short: below the threshold on the partial number (spend 10.5 of 28 rows), not resolved.
  e.overview.native.collect = ((collect, rows) => async (source, dates) => ({
    ...(await collect(source, dates)),
    rows: structuredClone(rows),
  }))(
    e.overview.native.collect,
    campaigns(i => (i === 0 ? '10.5' : null)),
  );
  const second = await e.go(['campaign'], {metrics});
  assert.equal(second.stored.summary[0].metrics.spend, '10.5');
  const out = evaluateMonitors(e.store, e.actor, second.stored.id).outcomes[0];
  assert.equal(out.status, 'data_unavailable');
  assert.equal(out.reason, 'partial_coverage');
  assert.equal(incidents(e)[0].state, 'open');
});

test('values are compared as exact decimals: a total a double cannot tell from the threshold is above it', async t => {
  const e = reportEngine(t, {
      rowsFor: () => [row('campaign', 'c1', {spend: '9007199254740991.000000001', clicks: '7'})],
    }),
    {stored} = await e.go(['campaign'], {metrics: ['spend', 'clicks']});
  assert.equal(stored.summary[0].metrics.spend, '9007199254740991.000000001');
  assert.equal(Number('9007199254740991.000000001') > Number('9007199254740991'), false, 'as a double it is not above');
  saveMonitor(e, stored.summary[0], {threshold: '9007199254740991'});
  assert.equal(evaluateMonitors(e.store, e.actor, stored.id).outcomes[0].state, 'open');
  saveMonitor(e, stored.summary[0], {name: 'Below', comparison: 'below', threshold: '9007199254740991'});
  assert.ok(evaluateMonitors(e.store, e.actor, stored.id).outcomes.some(o => o.status === 'within_threshold'));
});

test('a rule may be declared on the unknown attribution and result definition a v4 snapshot records', async t => {
  const e = reportEngine(t, {
      rowsFor: () => [row('campaign', 'c1', {spend: '250', clicks: '7'}, {definition: null})],
      packet: {attribution: 'unknown'},
    }),
    {stored} = await e.go(['campaign'], {metrics: ['spend', 'clicks']});
  const [summary] = stored.summary;
  assert.equal(summary.attribution, 'unknown');
  assert.equal(summary.result_definition, 'unknown');
  saveMonitor(e, summary);
  assert.equal(evaluateMonitors(e.store, e.actor, stored.id).outcomes[0].state, 'open');
  // The money and the time zone still have to be declared exactly.
  for (const field of ['currency', 'timezone'])
    assert.throws(
      () => saveMonitor(e, summary, {[field]: 'unknown'}),
      error => assertRefused(error, 'INVALID_ARGUMENT', {message: new RegExp('Declare the exact ' + field)}),
    );
});

test('a rule on a report of several levels watches the top level once, and a level it does not watch never stands in', async t => {
  const rowsFor = level =>
      level === 'ad'
        ? [row('ad', 'a1', {spend: '300', clicks: '7'})]
        : [row('campaign', 'c1', {spend: '290', clicks: '7'}), row('campaign', 'c2', {spend: null, clicks: '7'})],
    e = reportEngine(t, {rowsFor}),
    {stored} = await e.go(['campaign', 'ad'], {metrics: ['spend', 'clicks']});
  assert.deepEqual(
    stored.summary.map(s => s.entity_level ?? 'campaign'),
    ['campaign', 'ad'],
  );
  saveMonitor(e, stored.summary[0]);
  // The campaign level is short (one campaign has no cost), the ad level is whole and above the threshold. The rule
  // watches campaigns, so it has no answer, and the ad total does not answer for it.
  const out = evaluateMonitors(e.store, e.actor, stored.id).outcomes;
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].status, out[0].reason], ['data_unavailable', 'partial_coverage']);
  assert.equal(incidents(e).length, 0);
});

test('a summary the rule does not describe, and stale or incomplete evidence, say why they give no answer', async t => {
  const e = reportEngine(t, {rowsFor: () => campaigns(() => '10.5')}),
    {stored} = await e.go(['campaign'], {metrics});
  saveMonitor(e, stored.summary[0], {name: 'Other currency', currency: 'EUR'});
  assert.deepEqual(
    evaluateMonitors(e.store, e.actor, stored.id).outcomes.map(o => [o.status, o.reason]),
    [['data_unavailable', 'no_matching_summary']],
  );
  const late = reportEngine(t, {
      rowsFor: () => campaigns(() => '10.5'),
      packet: {captured_at: Date.now() - 48 * 3600000},
    }),
    old = await late.go(['campaign'], {metrics});
  saveMonitor(late, old.stored.summary[0]);
  assert.equal(evaluateMonitors(late.store, late.actor, old.stored.id).outcomes[0].reason, 'stale_evidence');
  const open = reportEngine(t, {rowsFor: () => campaigns(() => '10.5'), packet: {complete: false}}),
    partial = await open.go(['campaign'], {metrics});
  saveMonitor(open, partial.stored.summary[0]);
  assert.equal(evaluateMonitors(open.store, open.actor, partial.stored.id).outcomes[0].reason, 'incomplete');
});
