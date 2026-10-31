import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeGraph} from '../tools/architecture-map.mjs';
import {providerAdapters, providerById} from '../dist/src/provider-adapters.js';
import * as windows from '../dist/src/meta-attribution-windows.js';
import {metaAttributionWindows as reportSourcesWindows} from '../dist/src/report-sources.js';
import {campaignAttributionProfile, overviewSourceLevel} from '../dist/src/overview-levels.js';

/**
 * ARC-01 (reporting, wave 4c round 6): Meta's explicit attribution windows (RPT-07) are its adapter's facts
 * (`reportWindows`, src/provider-adapters.ts), which src/overview-levels.ts reads without importing a provider module
 * and src/meta-attribution-windows.ts re-exports. Each test pins what the module answered before, copied here.
 */
const legacy = (() => {
  const metaAttributionWindows = Object.freeze(['1d_click', '7d_click', '28d_click', '1d_view', '1d_ev']);
  const metaClickWindows = Object.freeze(['1d_click', '7d_click', '28d_click']);
  const metaWindowsMessage =
    'Choose at most one click window (1d_click, 7d_click or 28d_click), with optional 1d_view and 1d_ev (engaged view), or view windows alone.';
  function metaWindowsValid(windows) {
    return (
      Array.isArray(windows) &&
      windows.length > 0 &&
      windows.length <= 3 &&
      new Set(windows).size === windows.length &&
      windows.every(v => typeof v === 'string' && metaAttributionWindows.includes(v)) &&
      windows.filter(v => metaClickWindows.includes(v)).length <= 1
    );
  }
  const metaWindowsOrdered = windows => metaAttributionWindows.filter(w => windows.includes(w));
  return {metaAttributionWindows, metaClickWindows, metaWindowsMessage, metaWindowsValid, metaWindowsOrdered};
})();
const detailedMessage =
  'Choose one exact Meta result action and at most one click window (1d_click, 7d_click or 28d_click), with optional 1d_view and 1d_ev (engaged view), or view windows alone.';

// Every selection of up to `length` tokens, repeats and unsupported values included.
function selections(tokens, length) {
  const out = [[]];
  for (let size = 1; size <= length; size++)
    for (const prefix of out.filter(s => s.length === size - 1))
      for (const token of tokens) out.push([...prefix, token]);
  return out;
}
const tokens = [...legacy.metaAttributionWindows, '7d_view', '28d_view', '', '1D_CLICK', 1, null];
const others = [undefined, null, '1d_click', 7, {}, {length: 1, 0: '1d_click'}, new Set(['1d_click'])];
const outcome = run => {
  try {
    return {returns: run()};
  } catch (error) {
    return {code: error.code, message: error.message};
  }
};

test('the Meta adapter declares the windows, the click windows and the refusal the module declared, frozen', () => {
  const facts = providerById('meta').reportWindows;
  assert.deepEqual(facts.windows, legacy.metaAttributionWindows);
  assert.deepEqual(facts.clickWindows, legacy.metaClickWindows);
  assert.equal(facts.message, legacy.metaWindowsMessage);
  assert.ok(Object.isFrozen(facts) && Object.isFrozen(facts.windows) && Object.isFrozen(facts.clickWindows));
  // Only Meta's reports take an explicit window selection.
  assert.deepEqual(
    providerAdapters.filter(adapter => adapter.reportWindows).map(adapter => adapter.id),
    ['meta'],
  );
  // The module's names are the adapter's facts, so its importers and src/report-sources.ts read the same values.
  assert.equal(windows.metaAttributionWindows, facts.windows);
  assert.equal(windows.metaClickWindows, facts.clickWindows);
  assert.equal(windows.metaWindowsMessage, facts.message);
  assert.equal(windows.metaWindowsValid, facts.valid);
  assert.equal(reportSourcesWindows, facts.windows);
});

test('every selection is valid, and ordered, exactly when the module accepted it', () => {
  let valid = 0;
  for (const selection of [...selections(tokens, 4), ...others]) {
    const label = JSON.stringify(selection) ?? String(selection);
    assert.equal(windows.metaWindowsValid(selection), legacy.metaWindowsValid(selection), label);
    if (legacy.metaWindowsValid(selection)) {
      valid++;
      assert.deepEqual(windows.metaWindowsOrdered(selection), legacy.metaWindowsOrdered(selection), label);
    }
  }
  // The 15 supported selections (no click window or one of three, with any of the two view windows), in every order.
  assert.equal(valid, 37);
});

test('a Meta campaign source keeps the attribution profile it accepted and the refusal it gave', () => {
  for (const selection of [...selections(tokens.slice(0, 7), 3), ...others]) {
    const label = JSON.stringify(selection) ?? String(selection);
    const options = {attribution_windows: selection};
    const expected = legacy.metaWindowsValid(selection)
      ? {returns: options}
      : {code: 'INVALID_REPORT_LEVEL', message: legacy.metaWindowsMessage};
    assert.deepEqual(
      outcome(() => campaignAttributionProfile({platform: 'meta', report_options: options})),
      expected,
      label,
    );
    // overviewSourceLevel checks the same profile for a campaign source and returns the campaign level.
    const level = outcome(() => overviewSourceLevel({platform: 'meta', report_options: options}));
    assert.deepEqual(
      level,
      expected.returns ? {returns: {id: 'campaign', label: 'Campaign', native_type: 'campaign'}} : expected,
      label,
    );
  }
  // Snapchat's profile does not consult Meta's windows.
  assert.deepEqual(
    campaignAttributionProfile({
      platform: 'snapchat',
      report_options: {swipe_up_attribution_window: '7_DAY', view_attribution_window: 'none'},
    }),
    {swipe_up_attribution_window: '7_DAY', view_attribution_window: 'none'},
  );
});

test('a detailed Meta source keeps the windows it accepted and the result-action refusal it gave', () => {
  for (const selection of [...selections(tokens.slice(0, 7), 3), ...others])
    for (const level of ['adset', 'ad']) {
      const label = level + ' ' + (JSON.stringify(selection) ?? String(selection));
      const source = {
        platform: 'meta',
        level,
        report_options: {
          complete_window: false,
          result_action_type: 'offsite_conversion.fb_pixel_purchase',
          attribution_windows: selection,
        },
      };
      const expected = legacy.metaWindowsValid(selection)
        ? {returns: {id: level, label: level === 'ad' ? 'Ad' : 'Ad set', preset: 'meta_' + level, native_type: level}}
        : {code: 'INVALID_REPORT_LEVEL', message: detailedMessage};
      assert.deepEqual(
        outcome(() => overviewSourceLevel(source)),
        expected,
        label,
      );
    }
  // A valid selection still needs an exact result action.
  assert.deepEqual(
    outcome(() =>
      overviewSourceLevel({
        platform: 'meta',
        level: 'ad',
        report_options: {complete_window: true, result_action_type: 'Purchase', attribution_windows: ['7d_click']},
      }),
    ),
    {code: 'INVALID_REPORT_LEVEL', message: detailedMessage},
  );
});

test('the Overview levels read Meta’s windows from the adapter registry, not from a provider module', () => {
  const graph = runtimeGraph(process.cwd());
  assert.ok(graph.get('src/overview-levels.ts').has('src/provider-adapters.ts'));
  assert.ok(!graph.get('src/overview-levels.ts').has('src/meta-attribution-windows.ts'));
  // The registry stays a leaf: the windows module reads it, never the reverse. Merged with the shared tables package,
  // its one import is the leaf src/frozen-facts.ts (deepFrozen, which freezes the retired actions' facts), which
  // imports no module.
  assert.ok(graph.get('src/meta-attribution-windows.ts').has('src/provider-adapters.ts'));
  assert.deepEqual([...graph.get('src/provider-adapters.ts')], ['src/frozen-facts.ts']);
  assert.deepEqual([...graph.get('src/frozen-facts.ts')], []);
});
