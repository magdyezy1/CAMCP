// WEB-07 (design system, wave 4b): the shared components' states and their dark appearance (docs/DESIGN-SYSTEM.md).
// A computed-style comparison of the rendered fixture pages found that web/theme.css's dark groups, whose specificity is
// that of their most specific member (an ID), outranked every component variant in the dark theme: primary, danger,
// quiet and dark buttons looked like plain buttons, status badges and warning notices lost their success and warning
// colours, the feedback alerts their danger border, and checked metric pills looked unchecked; the variants' own dark
// rules never applied. Disabled buttons changed under the pointer, toggle groups said which choice was selected only by
// colour, some controls had no hover state, and two control boundaries were decorative lines (1.29:1). These tests
// guard each fix where the stylesheets and markup show it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {cssDeclarations} from '../tools/check-colours.mjs';

const read = file => fs.readFileSync('web/' + file, 'utf8');
const tokens = [read('tokens.css'), read('public-tokens.css')].join('\n');
const block = (selector, atRule) =>
  Object.fromEntries(
    cssDeclarations(tokens)
      .filter(d => d.selector === selector && (atRule ? d.atRules.join(' ') === atRule : !d.atRules.length))
      .map(d => [d.property, d.value]),
  );
const themes = {light: block(':root'), dark: {...block(':root'), ...block(":root[data-theme='dark']")}};
const resolve = (theme, value) => {
  for (let depth = 0; depth < 8; depth++) {
    const reference = /^var\((--[\w-]+)\)$/.exec(value.trim());
    if (!reference) return value.trim();
    value = themes[theme][reference[1]];
    assert.ok(value, 'Unknown token ' + reference[1]);
  }
  throw Error('Token reference cycle');
};
const channel = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = hex => {
  const value = hex.replace('#', ''),
    full = value.length === 3 ? [...value].map(c => c + c).join('') : value.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map(i => channel(parseInt(full.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};
/** The value a sheet gives a property for an exact selector (the selector list's member), outside media queries. */
const declared = (file, selector, property) =>
  cssDeclarations(read(file)).findLast(
    d =>
      !d.atRules.length &&
      d.property === property &&
      d.selector
        .split(',')
        .map(s => s.trim())
        .includes(selector),
  )?.value;
// The dark layer's groups: [data-theme='dark'] :is(…) member lists, and the plain dark rules.
const splitList = text => {
  const out = [];
  let depth = 0,
    current = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
};
const darkMembers = () =>
  [
    ...new Set(
      cssDeclarations(read('theme.css'))
        .filter(d => !d.atRules.length)
        .map(d => d.selector),
    ),
  ].flatMap(selector => {
    const group = /^\[data-theme='dark'\]\s*:is\(([\s\S]*)\)$/.exec(selector);
    if (group) return splitList(group[1]);
    return selector.startsWith("[data-theme='dark']") ? [selector.replace("[data-theme='dark'] ", '')] : [];
  });

test('a disabled button keeps its look under the pointer: every button hover rule is guarded', () => {
  const hovers = ['identity.css', 'app.css', 'reporting.css'].flatMap(file =>
    cssDeclarations(read(file))
      .flatMap(d => d.selector.split(',').map(s => s.trim()))
      .filter(s => /^\.button(?:\.[\w-]+)*:hover/.test(s)),
  );
  assert.ok(hovers.length >= 3, 'the button hover rules: ' + hovers.length);
  for (const selector of new Set(hovers)) assert.match(selector, /:where\(:not\(:disabled\)\)$/, selector);
  // The guard adds no specificity, so the dark button's own colours still win over the plain hover.
  assert.match(read('app.css'), /button:disabled \{\s*cursor: not-allowed;\s*opacity: 0\.5;/);
  // A busy button (identity.js sets aria-busy while a sign-in request runs) shows a progress cursor.
  assert.match(read('app.css'), /\.button\[aria-busy='true'\] \{\s*cursor: progress;/);
  assert.match(read('identity.js'), /button\.setAttribute\('aria-busy', 'true'\)/);
});

test('toggle groups say which choice is selected, and their buttons and icon buttons show hover', () => {
  const app = read('app.js');
  for (const toggle of ["filter === 'all'", "filter === 'connected'", 'assetKind === k', "client === 'codex'"])
    assert.ok(app.includes('aria-pressed="${String(' + toggle + ')}"'), toggle);
  for (const [file, selector] of [
    ['app.css', '.filter-tab:hover'],
    ['app.css', '.client-tab:hover'],
    ['app.css', '.asset-tabs button:hover'],
    ['app.css', '.icon-button:hover'],
  ])
    assert.ok(
      cssDeclarations(read(file)).some(d =>
        d.selector
          .split(',')
          .map(s => s.trim())
          .includes(selector),
      ),
      file + ' ' + selector,
    );
  // On the dark sidebar the icon button's hover keeps the inverse colours (the plain hover's ink would vanish there).
  const sidebar = cssDeclarations(read('identity.css')).filter(d => d.selector === '.sidebar .icon-button:hover');
  assert.deepEqual(
    sidebar.map(d => d.property + ': ' + d.value),
    ['color: var(--text-on-inverse-strong)', 'background: var(--fill-on-inverse)'],
  );
  for (const theme of ['light', 'dark']) {
    const hover = resolve(theme, declared('app.css', '.icon-button:hover', 'background')),
      ink = resolve(theme, declared('app.css', '.icon-button:hover', 'color'));
    assert.ok(contrast(ink, hover) >= 4.5, theme + ' icon button hover: ' + contrast(ink, hover).toFixed(2));
  }
});

test('notices, feedback alerts, dialogs and client tabs take their colours from tokens in both themes', () => {
  // An error notice reads as one (it had the plain notice's look in light and its ink in dark).
  const error = {
    border: declared('identity.css', '.notice.error', 'border-color'),
    color: declared('identity.css', '.notice.error', 'color'),
  };
  assert.deepEqual(error, {border: 'var(--danger-line)', color: 'var(--danger-text)'});
  for (const theme of ['light', 'dark'])
    assert.ok(
      contrast(resolve(theme, error.color), resolve(theme, declared('identity.css', '.notice', 'background'))) >= 4.5,
    );
  // The three feedback alerts are one component: one rule, a danger border on the raised surface.
  const feedback = cssDeclarations(read('workflows.css')).filter(d => d.selector.includes('#capture-feedback'));
  assert.ok(feedback.length > 0);
  for (const d of feedback)
    assert.match(d.selector, /\.workspace-form-feedback/, 'one rule for all three: ' + d.selector);
  assert.equal(declared('workflows.css', '.workspace-form-feedback', 'border'), '1px solid var(--danger)');
  // Dialogs and client tabs name their surface and ink: without the dark layer the browser's own dark canvas
  // (#121212) and button text (white) showed through.
  assert.equal(declared('app.css', 'dialog', 'background'), 'var(--surface-raised)');
  assert.equal(declared('app.css', '.client-tab', 'color'), 'var(--text)');
});

test('the compact selects share one size, focus rings take the focus role, and control boundaries reach 3:1', () => {
  for (const [file, selector] of [
    ['theme.css', '.theme-control select'],
    ['app.css', '.working-client-control select'],
    ['localization.css', '.language-control select'],
  ]) {
    assert.equal(declared(file, selector, 'min-height'), '36px', selector);
    assert.equal(declared(file, selector, 'border-radius'), 'var(--radius-sm)', selector);
    assert.equal(declared(file, selector, 'border'), '1px solid var(--line-strong)', selector);
  }
  // About's header controls are touch targets of 44px, the language select and the appearance select alike.
  assert.equal(declared('about.css', '.theme-control select', 'min-height'), '44px');
  assert.equal(declared('about.css', '.about-header .language-control select', 'min-height'), '44px');
  for (const file of ['accessibility.css', 'reporting.css', 'workflows.css', 'privacy.css'])
    for (const d of cssDeclarations(read(file)).filter(d => d.property === 'outline' && d.value !== 'none'))
      assert.match(d.value, /^\d+px solid var\(--focus\)$/, file + ' ' + d.selector);
  // A border a stylesheet gives a field (an input, select or textarea, or the search field's frame) is its visible
  // boundary: --border-strong, 3:1 or more against white (WCAG 2.1 1.4.11). The search field and the report actions'
  // select took the decorative --line (1.29:1) in the light theme.
  const fields = [];
  for (const file of ['app.css', 'identity.css', 'workflows.css', 'reporting.css', 'accessibility.css'])
    for (const d of cssDeclarations(read(file)))
      if (/^border(?:-color)?$/.test(d.property) && /var\(--/.test(d.value))
        for (const member of d.selector.split(',').map(s => s.trim()))
          if (
            (/^(?:input|select|textarea)\b/.test(member.split(/[\s>+~]+/).at(-1)) || member === '.search') &&
            !/:focus/.test(member)
          )
            fields.push({file, member, value: d.value});
  assert.ok(fields.length >= 10, 'the field borders: ' + fields.length);
  for (const field of fields)
    assert.match(field.value, /var\(--(?:border-strong|line-strong|danger|focus)\)/, field.file + ' ' + field.member);
  for (const theme of ['light', 'dark'])
    assert.ok(contrast(resolve(theme, 'var(--border-strong)'), resolve(theme, 'var(--surface-raised)')) >= 3);
  // The regression itself: the decorative line against the white field.
  assert.ok(contrast(resolve('light', 'var(--line)'), resolve('light', 'var(--surface-raised)')) < 3);
});
