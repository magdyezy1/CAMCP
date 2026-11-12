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
  // V2-WEB-03: the sidebar is a neutral surface in both themes, so its icon button (the drawer's close) takes the plain
  // hover, whose ink and surface are checked in both themes below; it once kept inverse colours on the dark sidebar.
  const sidebar = cssDeclarations(read('identity.css')).filter(d => d.selector === '.sidebar .icon-button:hover');
  assert.deepEqual(sidebar, []);
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

test('no dark group re-colours a button, a status badge, a notice variant, a feedback alert or a metric pill', () => {
  const members = darkMembers();
  // The regression: these members sat in groups whose ID member outranked every variant rule.
  for (const member of [
    '.button',
    '.status',
    '.notice',
    '.button:hover',
    '.button.primary',
    '.button.primary:hover',
    '.button.danger',
    '.button.danger:hover',
    '.status.online',
    '.status.attention',
    '.notice.warning',
    '.metric-pills span',
    '.metric-pills input:checked + span',
    '.measurement-read-feedback',
    '.workspace-form-feedback',
    '#capture-feedback',
    'dialog',
    '.client-tab',
    '.platform-card',
  ])
    assert.ok(!members.includes(member), member + ' is re-coloured by theme.css');
  // The dark hover surface leaves the variants their own hover, and notices their warning and error colours.
  assert.ok(members.includes('.button:not(.primary, .danger):hover:where(:not(:disabled))'));
  assert.ok(members.includes('.notice:not(.warning, .error)'));
  // What the dark layer still decides only shrinks (B23 removed every entry that only repeated a token).
  assert.ok(members.length <= 87, 'theme.css dark members: ' + members.length);
});

test('every button variant keeps its look in the dark theme, with readable text', () => {
  const surfaceOf = selector =>
    declared('identity.css', selector, 'background') ?? declared('app.css', selector, 'background');
  // Primary: the accent fill and its text (the dark layer used to paint the panel colour over it).
  const primary = [declared('identity.css', '.button.primary', 'color'), surfaceOf('.button.primary')];
  for (const theme of ['light', 'dark']) {
    const [ink, fill] = primary.map(value => resolve(theme, value));
    assert.ok(contrast(ink, fill) >= 4.5, theme + ' primary: ' + contrast(ink, fill).toFixed(2));
    assert.notEqual(fill, resolve(theme, 'var(--surface-raised)'), theme + ': a primary button is not a plain one');
    const hover = resolve(
      theme,
      declared('identity.css', '.button.primary:hover:where(:not(:disabled))', 'background'),
    );
    assert.ok(contrast(ink, hover) >= 4.5, theme + ' primary hover: ' + contrast(ink, hover).toFixed(2));
  }
  // Dark: the inverse fill with the inverse text in both themes (var(--white) is the dark panel colour).
  assert.equal(declared('app.css', '.button.dark', 'color'), 'var(--text-on-inverse-strong)');
  for (const theme of ['light', 'dark'])
    assert.ok(
      contrast(resolve(theme, 'var(--text-on-inverse-strong)'), resolve(theme, surfaceOf('.button.dark'))) >= 4.5,
    );
  // Quiet: transparent until hovered, in both themes.
  assert.equal(declared('app.css', '.button.quiet', 'background'), 'transparent');
  // Danger: its ink and border on the panel, and a danger fill under the pointer, from its tokens in both themes.
  const danger = declared('reporting.css', '.button.danger', 'color'),
    rest = surfaceOf('.button.danger'),
    hover = declared('identity.css', '.button.danger:hover:where(:not(:disabled))', 'background');
  for (const theme of ['light', 'dark']) {
    assert.ok(contrast(resolve(theme, danger), resolve(theme, rest)) >= 4.5, theme + ' danger');
    assert.ok(contrast(resolve(theme, danger), resolve(theme, hover)) >= 4.5, theme + ' danger hover');
    assert.notEqual(resolve(theme, hover), resolve(theme, rest), theme + ': the danger button shows its hover');
  }
});

// WEB-08 (design system pass): the owner Settings section links had no hover state, and in the dark theme the owner's
// own "You" badge (a .status.online pill) and the access rows' Limit and Remove buttons (danger buttons) lost their
// colours to theme.css's group above. The links show hover in both themes with readable ink, and the badge and the
// buttons take their own tokens.
test('WEB-08: the owner Settings section links show hover, and the You badge keeps the success pair in the dark theme', () => {
  for (const theme of ['light', 'dark']) {
    const rest = resolve(theme, declared('reporting.css', '.settings-subnav a', 'background')),
      hover = resolve(theme, declared('reporting.css', '.settings-subnav a:hover', 'background')),
      ink = resolve(theme, declared('reporting.css', '.settings-subnav a', 'color'));
    assert.notEqual(rest, hover, theme + ': the section link shows hover');
    assert.ok(contrast(ink, hover) >= 4.5, theme + ': ' + contrast(ink, hover).toFixed(2));
    assert.notEqual(
      resolve(theme, declared('reporting.css', '.settings-subnav a:hover', 'border-color')),
      resolve(theme, 'var(--line)'),
    );
  }
  assert.match(read('account-approvals.js'), /<span class="status online">\$\{esc\(uiText\('You'\)\)\}<\/span>/);
  const badge = ['color', 'background'].map(property => declared('identity.css', '.status.online', property));
  for (const theme of ['light', 'dark']) {
    const [ink, fill] = badge.map(value => resolve(theme, value));
    assert.ok(contrast(ink, fill) >= 4.5, theme + ' You badge: ' + contrast(ink, fill).toFixed(2));
  }
  assert.equal(resolve('dark', badge[1]), resolve('dark', 'var(--success-bg)'));
  assert.deepEqual(
    darkMembers().filter(member => /^\.status(?:$|[.:])/.test(member) && member !== '.status.error'),
    [],
    'no dark group re-colours the badge',
  );
});
