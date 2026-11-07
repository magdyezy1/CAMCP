// V2-WEB-02: what the component stylesheets promise and the rendered cases cannot see from one page state: no debt on the
// token ratchet, no custom property or colour of their own, logical properties and container queries only, one focus style,
// motion that stops under prefers-reduced-motion, forced-colour rules, a 44px primary action, and no text on a colour it
// fails on (the pairs the audit measured, and every rule that sets both a text and a background colour from tokens).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {cssDeclarations, literalColours, themeBlocks} from '../tools/check-colours.mjs';
import {baselinePath, designTokenCounts} from '../tools/check-design-tokens.mjs';
import {rtlProblems} from '../tools/check-rtl.mjs';
import {contrastRatio, cssColours} from '../tools/browser-accessibility.mjs';

const sheets = [
  'components.css',
  'components-controls.css',
  'components-data.css',
  'components-overlays.css',
  'design-system.css',
];
const read = file => fs.readFileSync('web/' + file, 'utf8');
const rules = file => {
  const groups = new Map();
  for (const declaration of cssDeclarations(read(file))) {
    const key = declaration.atRules.join(' ') + ' | ' + declaration.selector;
    if (!groups.has(key))
      groups.set(key, {selector: declaration.selector, atRules: declaration.atRules, declarations: {}});
    groups.get(key).declarations[declaration.property] = declaration.value;
  }
  return [...groups.values()];
};
/** A theme's custom properties from the token sheets a V2 route loads, in cascade order. */
function theme(dark) {
  const declarations = cssDeclarations(['tokens.css', 'tokens-v2.css'].map(read).join('\n')).filter(d =>
      d.property.startsWith('--'),
    ),
    layers = [
      declarations.filter(d => d.selector === themeBlocks.light[0] && !d.atRules.length),
      ...(dark ? [declarations.filter(d => d.selector === themeBlocks.dark[0] && !d.atRules.length)] : []),
    ];
  return Object.fromEntries(layers.flat().map(d => [d.property, d.value]));
}
function resolve(tokens, value) {
  const match = /^var\((--[\w-]+)\)$/.exec(value.trim());
  if (!match) return value.trim();
  assert.ok(Object.hasOwn(tokens, match[1]), 'undefined token ' + match[1]);
  return resolve(tokens, tokens[match[1]]);
}
const rgb = hex => {
  assert.match(hex, /^#[\da-f]{6}$/i, hex);
  return cssColours(
    'rgb(' + [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(', ') + ')',
  )[0];
};

test('the component sheets have no debt on the token ratchet and no entry in its baseline', () => {
  const {counts} = designTokenCounts(),
    baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  for (const sheet of sheets) {
    assert.deepEqual(counts[sheet], {radius: 0, shadow: 0, motion: 0, type: 0, spacing: 0}, sheet);
    assert.equal(Object.hasOwn(baseline.files, sheet), false, sheet + ' is not in the baseline: its limit is zero');
    assert.deepEqual(literalColours(read(sheet)), [], sheet + ' writes no colour of its own');
    assert.doesNotMatch(
      read(sheet).replace(/\/\*[\s\S]*?\*\//g, ''),
      /(?:^|[{;\s])--[\w-]+\s*:/,
      sheet + ' declares no custom property',
    );
    assert.deepEqual(rtlProblems(read(sheet), sheet), [], sheet + ' names no physical side');
  }
});

test('the sheets use container queries inside components, never a viewport breakpoint', () => {
  for (const sheet of sheets) assert.doesNotMatch(read(sheet), /@media[^{]*\((?:min|max)-(?:width|height)/, sheet);
  assert.match(
    read('components-data.css'),
    /@container \(max-width: 40rem\)/,
    'the table becomes cards by its own width',
  );
  assert.match(read('components.css'), /@container \(min-width: 36rem\)/, 'the stepper lays out by its own width');
});

test('every focus ring is the one style: the focus width and offset tokens in the --focus colour', () => {
  for (const sheet of sheets)
    for (const {selector, declarations} of rules(sheet)) {
      if (!declarations.outline || declarations.outline === 'none') continue;
      assert.match(declarations.outline, /^var\(--v2-focus-width\) solid var\(--focus\)$/, sheet + ' ' + selector);
      assert.match(
        declarations['outline-offset'] ?? 'var(--v2-focus-offset)',
        /^(?:var\(--v2-focus-offset\)|calc\(var\(--v2-focus-offset\) \* -1\))$/,
        sheet + ' ' + selector,
      );
    }
  assert.match(
    read('components.css'),
    /\[class\*='amcp-'\]:focus-visible,\s*\[class\*='amcp-'\]\[data-state='focus'\] \{\s*outline:/,
  );
});

test('motion stops under prefers-reduced-motion, and every sheet that animates says so', () => {
  for (const sheet of sheets) {
    const animated = rules(sheet).filter(rule => rule.declarations.animation || rule.declarations['animation-name']);
    if (!animated.length) continue;
    const reduced = rules(sheet)
      .filter(
        rule =>
          rule.atRules.includes('@media (prefers-reduced-motion: reduce)') &&
          /^none$/.test(rule.declarations.animation ?? ''),
      )
      .flatMap(rule => rule.selector.split(',').map(s => s.trim()));
    for (const rule of animated)
      for (const selector of rule.selector.split(',').map(s => s.trim()))
        assert.ok(reduced.includes(selector), sheet + ': ' + selector + ' keeps animating under reduced motion');
  }
  for (const rule of rules('components.css').filter(r => r.declarations.animation))
    assert.doesNotMatch(rule.declarations.animation, /\d(?:m?s)\b/, 'a duration comes from a token');
});

test('every component sheet has forced-colour rules, and a state is never only a fill', () => {
  for (const sheet of sheets.slice(0, 4)) assert.match(read(sheet), /@media \(forced-colors: active\)/, sheet);
  const css = read('components.css');
  for (const state of ["aria-pressed='true'", "data-state='error'", "data-status='current'"])
    assert.ok(css.includes(state), 'the forced-colour rules name ' + state);
});

test('a primary action is 44px high and wide from the target token, and no control is under the 24px minimum', () => {
  const light = theme(false);
  assert.equal(light['--v2-target-primary'], '44px');
  assert.equal(light['--v2-target-min'], '24px');
  const primary = rules('components.css').find(rule => rule.selector === ".amcp-button[data-variant='primary']");
  assert.equal(primary.declarations['min-block-size'], 'var(--v2-target-primary)');
  assert.equal(primary.declarations['min-inline-size'], 'var(--v2-target-primary)');
  const base = rules('components.css').find(rule => rule.selector === '.amcp-button' && !rule.atRules.length);
  assert.equal(base.declarations['min-inline-size'], 'var(--v2-target-min)');
  assert.match(base.declarations['min-block-size'], /^var\(--v2-control-height\)$/);
  for (const [selector, token] of [
    ['.amcp-chip', /^calc\(var\(--v2-target-min\) \+ var\(--v2-space-2\)\)$/],
    ['.amcp-chip-remove', /^var\(--v2-target-min\)$/],
    ['.amcp-combobox-toggle', /^var\(--v2-target-min\)$/],
    ['.amcp-tree-expander', /^var\(--v2-target-min\)$/],
  ]) {
    const rule = [...rules('components.css'), ...rules('components-controls.css')].find(
      r => r.selector === selector && !r.atRules.length,
    );
    assert.ok(rule, selector);
    assert.match(rule.declarations['min-block-size'] ?? rule.declarations['block-size'], token, selector);
  }
});

test('no rule sets text on a colour it fails on, and none uses a pair the audit measured as unusable', () => {
  const forbidden = [
      ['--v2-ink-2', '--v2-rule'],
      ['--v2-violet-text', '--v2-rule'],
      ['--v2-ink', '--v2-peach'],
    ],
    checked = [];
  for (const sheet of sheets)
    for (const {selector, declarations, atRules} of rules(sheet)) {
      const text = declarations.color,
        fill = declarations.background ?? declarations['background-color'];
      if (!text || !fill) continue;
      const names = value => /^var\((--[\w-]+)\)$/.exec(value)?.[1];
      assert.ok(
        !forbidden.some(([ink, surface]) => names(text) === ink && names(fill) === surface),
        sheet + ' ' + selector + ' sets an unusable pair',
      );
      if (!names(text) || !names(fill) || atRules.some(rule => rule.includes('forced-colors'))) continue;
      for (const dark of [false, true]) {
        const tokens = theme(dark),
          ratio = contrastRatio(rgb(resolve(tokens, text)), rgb(resolve(tokens, fill)));
        // WCAG exempts an inactive control from contrast, but a disabled state still has to be seen: it keeps 3:1.
        const floor = /:disabled|aria-disabled/.test(selector) ? 3 : 4.5;
        assert.ok(
          ratio >= floor,
          sheet + ' ' + selector + ' ' + (dark ? 'dark' : 'light') + ': ' + ratio.toFixed(2) + ' < ' + floor,
        );
      }
      checked.push(sheet + ' ' + selector);
    }
  assert.ok(checked.length >= 25, 'the pairs checked: ' + checked.length);
  // Peach is a marker: it is only ever a dot's fill or a bar's colour, never behind words.
  for (const sheet of sheets)
    for (const {selector, declarations} of rules(sheet))
      for (const [property, value] of Object.entries(declarations))
        if (value.includes('--v2-peach'))
          assert.ok(
            (selector === '.amcp-marker' && property === 'background') ||
              (/amcp-creative/.test(selector) && property === 'border-inline-start'),
            sheet + ' ' + selector + ' ' + property + ' uses peach for something other than a marker',
          );
});
