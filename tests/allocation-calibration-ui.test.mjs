import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {calibrateAllocation} from '../dist/src/allocation-calibration.js';
import {calibrationNow, calibrationReport, calibrationIds} from './fixtures/allocation-calibration-data.mjs';

function fixture(request, locale = 'en') {
  const nodes = new Map(),
    bindings = new Map(),
    events = new Map(),
    calls = [],
    state = {active: true, ids: [...calibrationIds], invalidations: 0, focused: 0};
  const node = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        innerHTML: '',
        isConnected: true,
        value: {
          '#calibration-training-days': '7',
          '#calibration-minimum-conversions': '10',
          '#calibration-central-share': '80',
        }[id],
        elements: {maximum_age_days: {value: '7'}, efficiency_low: {value: '0.8'}, efficiency_high: {value: '1.2'}},
        insertAdjacentHTML(_position, html) {
          this.innerHTML += html;
        },
        addEventListener(event, fn) {
          events.set(id + ':' + event, fn);
        },
        focus() {
          state.focused++;
        },
      });
    return nodes.get(id);
  };
  const esc = value =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const context = createContext({
    document: {addEventListener() {}},
    $: node,
    esc,
    recordDetails: (value, title) => '<details>' + esc(title) + esc(JSON.stringify(value)) + '</details>',
    workspaceBind: (selector, fn, options = {}) => bindings.set(selector, {fn, options}),
    workspaceCall: async (_tool, args) => {
      calls.push(JSON.parse(JSON.stringify(args)));
      return request(args);
    },
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  if (locale === 'ar') {
    context.catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
    new Script("uiLocale='ar';uiMessages=new Map(Object.entries(catalog))").runInContext(context);
  }
  new Script(readFileSync('web/report-quality.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/report-allocation.js', 'utf8')).runInContext(context);
  context.report = calibrationReport();
  context.form = node('#model');
  context.state = state;
  new Script(
    'controller=mountAllocationCalibration(report,form,()=>state.ids,()=>state.active,()=>state.invalidations++)',
  ).runInContext(context);
  return {
    nodes,
    node,
    bindings,
    events,
    calls,
    state,
    context,
    evaluate: () => bindings.get('#allocation-calibrate').fn(),
    apply: () => bindings.get('#allocation-use-calibration').fn(),
  };
}
const result = () =>
  calibrateAllocation(calibrationReport(), calibrationIds, {
    training_days: 7,
    minimum_training_conversions: 10,
    maximum_age_days: 7,
    central_share_percent: 80,
  });

test('calibration is explicit and reader-compatible, retains original IDs, and only an explicit use action replaces factors', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  const f = fixture(async () => result());
  assert.equal(f.calls.length, 0);
  assert.match(f.node('#model').innerHTML, /Check your efficiency assumptions against history/);
  await f.evaluate();
  assert.deepEqual(f.calls, [
    {
      action: 'calibrate_allocation',
      id: 'calibration-report',
      ids: calibrationIds,
      options: {training_days: 7, minimum_training_conversions: 10, central_share_percent: 80, maximum_age_days: 7},
    },
  ]);
  assert.equal(f.node('#model').elements.efficiency_low.value, '0.8');
  assert.equal(f.state.invalidations, 0);
  assert.match(f.node('#allocation-calibration-result').innerHTML, /not a forecast/);
  await f.apply();
  assert.equal(f.node('#model').elements.efficiency_low.value, '1');
  assert.equal(f.node('#model').elements.efficiency_high.value, '1');
  assert.equal(f.state.invalidations, 1);
  assert.match(f.node('#allocation-calibration-result').innerHTML, /model again/);
  await f.apply();
  assert.equal(f.state.invalidations, 1);
  assert.equal(f.bindings.get('#allocation-use-calibration').options.disabled(), true);
  assert.equal(f.calls.length, 1);
});

test('English and Arabic history renders escaped native names/IDs, exact decimals, observed sample counts and finite authored meanings', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  for (const locale of ['en', 'ar']) {
    const f = fixture(async () => result(), locale);
    await f.evaluate();
    const html = f.node('#allocation-calibration-result').innerHTML;
    assert.match(html, /Original &lt;first&gt;/);
    assert.match(html, /9007199254740993/);
    assert.doesNotMatch(html, /<first>|PRIVATE-CALIBRATION/);
    assert.match(html, locale === 'ar' ? /المعايرة التاريخية للكفاءة/ : /Historical efficiency calibration/);
    assert.match(html, locale === 'ar' ? /ليست مستوى ثقة/ : /not a confidence level/);
  }
});

test('unknown or out-of-range historical factors stay inspectable and cannot replace planning inputs', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  const out = result();
  out.factor_envelope = {efficiency_low: null, efficiency_high: null, applicable: false};
  const f = fixture(async () => out);
  await f.evaluate();
  await f.apply();
  assert.equal(f.node('#model').elements.efficiency_low.value, '0.8');
  assert.equal(f.state.invalidations, 0);
  assert.equal(f.bindings.get('#allocation-use-calibration').options.disabled(), true);
  assert.match(f.node('#allocation-calibration-result').innerHTML, /Unknown/);
});

test('pending historical results cannot repaint or apply after selection, controls, source view or identity changes', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  for (const change of ['selection', 'control', 'age', 'active', 'detach', 'reset']) {
    let resolve;
    const f = fixture(
      () =>
        new Promise(r => {
          resolve = r;
        }),
    );
    const pending = f.evaluate();
    f.node('#allocation-calibration-result').innerHTML = 'Current state';
    if (change === 'selection') f.state.ids = [calibrationIds[0]];
    if (change === 'control') f.node('#calibration-training-days').value = '8';
    if (change === 'age') f.node('#model').elements.maximum_age_days.value = '10';
    if (change === 'active') f.state.active = false;
    if (change === 'detach') f.node('#allocation-calibration').isConnected = false;
    if (change === 'reset') f.context.controller.reset();
    resolve(result());
    await pending;
    assert.equal(f.node('#allocation-calibration-result').innerHTML, 'Current state', change);
    assert.equal(f.bindings.has('#allocation-use-calibration'), false, change);
    assert.equal(f.state.invalidations, 0);
  }
  const f = fixture(async () => result());
  await f.evaluate();
  f.state.ids = [];
  await f.apply();
  assert.equal(f.node('#model').elements.efficiency_low.value, '0.8');
});

test('selection bounds avoid even a local reporting call and errors keep original unknown diagnostics and request IDs', async () => {
  const f = fixture(async () => {
    throw Object.assign(Error('Unfamiliar provider diagnostic <original>'), {requestId: 'calibration-request'});
  }, 'ar');
  f.state.ids = [];
  await assert.rejects(() => f.evaluate());
  assert.equal(f.calls.length, 0);
  f.state.ids = calibrationIds;
  await f.evaluate();
  assert.match(f.node('#allocation-calibration-result').innerHTML, /Unfamiliar provider diagnostic &lt;original&gt;/);
  assert.match(f.node('#allocation-calibration-result').innerHTML, /calibration-request/);
});
