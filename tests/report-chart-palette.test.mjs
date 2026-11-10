// V2-EXP-01: the chart palette is three data hues and a neutral, validated in both themes with the checks of the data
// visualisation validator (tests/helpers/palette-checks.mjs: lightness band, chroma floor, colour-vision separation, the
// normal-vision floor, contrast), and the page's --chart-* tokens are the same colours the SVG and PDF back ends draw.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {cssDeclarations} from '../tools/check-colours.mjs';
import {chartPalette, hueColor, hueInk} from '../dist/src/report-chart-theme.js';
import {contrast, deltaE, thresholds, validatePalette} from './helpers/palette-checks.mjs';

const themes = ['light', 'dark'];

test('the three data hues pass every colour check in both themes', () => {
  for (const theme of themes) {
    const {hues, surface} = chartPalette[theme],
      {checks, ok} = validatePalette(hues, {mode: theme, surface});
    assert.equal(ok, true, theme);
    for (const name of ['lightness', 'chroma', 'cvd', 'normal'])
      assert.equal(checks[name].state, 'pass', `${theme} ${name} ${JSON.stringify(checks[name].detail)}`);
    assert.ok(
      checks.cvd.detail.value >= thresholds.CVD_TARGET,
      `${theme}: worst adjacent colour-vision distance ${checks.cvd.detail.value}`,
    );
    assert.ok(checks.normal.detail >= thresholds.NORMAL_FLOOR);
  }
});

test('the hues are the fixed order of the plan, and a theme never has a fourth', () => {
  assert.deepEqual(chartPalette.light.hues, ['#6250d6', '#eb6834', '#1baf7a']);
  assert.deepEqual(chartPalette.dark.hues, ['#9085e9', '#d95926', '#199e70']);
  for (const theme of themes) assert.equal(chartPalette[theme].hues.length, 3);
});

test('only the light aqua is below 3:1 against its surface, and the chart then names its values and keeps a table', () => {
  const light = validatePalette(chartPalette.light.hues, {mode: 'light', surface: chartPalette.light.surface});
  assert.equal(light.checks.contrast.state, 'relief');
  assert.deepEqual(
    light.checks.contrast.detail.map(([hex]) => hex),
    ['#1baf7a'],
  );
  assert.ok(Math.abs(light.checks.contrast.detail[0][1] - 2.77) < 0.01);
  const dark = validatePalette(chartPalette.dark.hues, {mode: 'dark', surface: chartPalette.dark.surface});
  assert.equal(dark.checks.contrast.state, 'pass');
});

test('Other is a neutral, kept apart from every hue and from the surface', () => {
  for (const theme of themes) {
    const {hues, other, surface} = chartPalette[theme];
    for (const hue of hues) {
      assert.ok(deltaE(other, hue) >= thresholds.NORMAL_FLOOR, `${theme} ${hue}: ${deltaE(other, hue)}`);
      // Under colour-vision deficiency the neutral may be only in the floor band: legal because Other is always named
      // (in the legend, or as the row's own name), is separated by a gap, and is textured in print.
      for (const kind of ['protan', 'deutan'])
        assert.ok(
          deltaE(other, hue, kind) >= thresholds.CVD_FLOOR,
          `${theme} ${hue} ${kind}: ${deltaE(other, hue, kind)}`,
        );
    }
    assert.ok(contrast(other, surface) >= thresholds.CONTRAST_MIN, theme + ' neutral against the surface');
  }
});

test('every ink is at least 4.5:1 against what it sits on', () => {
  for (const theme of themes) {
    const colors = chartPalette[theme];
    assert.ok(contrast(colors.ink, colors.surface) >= thresholds.TEXT_CONTRAST, theme + ' ink');
    assert.ok(contrast(colors.ink2, colors.surface) >= thresholds.TEXT_CONTRAST, theme + ' secondary ink');
    for (const hue of [0, 1, 2, null]) {
      const ratio = contrast(hueInk(colors, hue), hueColor(colors, hue));
      assert.ok(ratio >= thresholds.TEXT_CONTRAST, `${theme} ink on hue ${hue}: ${ratio.toFixed(2)}`);
    }
  }
});

test('furniture is quieter than the data: the grid is fainter than the axis, and the axis is still visible', () => {
  for (const theme of themes) {
    const {grid, axis, surface} = chartPalette[theme];
    assert.ok(contrast(grid, surface) < contrast(axis, surface), theme);
    assert.ok(contrast(axis, surface) >= thresholds.CONTRAST_MIN, theme + ' axis');
    assert.ok(contrast(grid, surface) >= 1.05, theme + ' grid is a different colour from the surface');
  }
});

// ----- the page's tokens are the colours the back ends draw -----
const css = fs.readFileSync('web/tokens-v2.css', 'utf8');
const block = (selector, media) =>
  Object.fromEntries(
    cssDeclarations(css)
      .filter(
        d =>
          d.selector === selector &&
          (media ? d.atRules.join(' ') === media : d.atRules.length === 0) &&
          d.property.startsWith('--chart-'),
      )
      .map(d => [d.property, d.value]),
  );
const tokensOf = colors => ({
  '--chart-surface': colors.surface,
  '--chart-ink': colors.ink,
  '--chart-ink-2': colors.ink2,
  '--chart-grid': colors.grid,
  '--chart-axis': colors.axis,
  '--chart-1': colors.hues[0],
  '--chart-2': colors.hues[1],
  '--chart-3': colors.hues[2],
  '--chart-other': colors.other,
  '--chart-on-1': colors.on[0],
  '--chart-on-2': colors.on[1],
  '--chart-on-3': colors.on[2],
  '--chart-on-other': colors.onOther,
});

test('the --chart-* tokens of web/tokens-v2.css are the palette: light, dark, and the dark a page without JavaScript gets', () => {
  assert.deepEqual(block(':root'), tokensOf(chartPalette.light));
  assert.deepEqual(block(":root[data-theme='dark']"), tokensOf(chartPalette.dark));
  assert.deepEqual(
    block(':root:not([data-theme])', '@media (prefers-color-scheme: dark)'),
    tokensOf(chartPalette.dark),
  );
});

test('the tokens that already carried the three hues say the same thing', () => {
  const declared = (selector, media) =>
    Object.fromEntries(
      cssDeclarations(css)
        .filter(d => d.selector === selector && (media ? d.atRules.join(' ') === media : d.atRules.length === 0))
        .map(d => [d.property, d.value]),
    );
  for (const [theme, selector] of [
    ['light', ':root'],
    ['dark', ":root[data-theme='dark']"],
  ]) {
    const tokens = declared(selector);
    assert.deepEqual(
      [tokens['--v2-data-1'], tokens['--v2-data-2'], tokens['--v2-data-3']],
      chartPalette[theme].hues,
      theme,
    );
  }
});
