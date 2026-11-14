// V2-WEB-02: what the component layer adds to the V2 token sheet, and where the sheet loads. The surfaces and statuses the
// components draw on have contrast measured in both themes (the pairs the audit named as unusable are pinned below their
// threshold, so a component cannot adopt them by accident); the 18 policy shades have V2 names that follow the theme; and
// loading the sheet after the token sheets a page already has changes no legacy token on any page that loads it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {cssDeclarations, themeBlocks} from '../tools/check-colours.mjs';
import {contrastRatio, cssColours} from '../tools/browser-accessibility.mjs';

const read = file => fs.readFileSync('web/' + file, 'utf8');
const sheets = {tokens: read('tokens.css'), policy: read('public-tokens.css'), v2: read('tokens-v2.css')};
/** A theme's custom properties for a cascade of sheets, later sheets winning: light, dark (explicit) or system dark. */
function cascade(files, theme) {
  const declarations = cssDeclarations(files.join('\n')).filter(d => d.property.startsWith('--')),
    pick = (selector, atRule) =>
      declarations.filter(
        d => d.selector === selector && (atRule ? d.atRules.join(' ') === atRule : d.atRules.length === 0),
      );
  const [light] = themeBlocks.light,
    [dark] = themeBlocks.dark,
    [systemSelector, systemMedia] = themeBlocks.system;
  const layers =
    theme === 'light'
      ? pick(light)
      : theme === 'dark'
        ? [...pick(light), ...pick(dark)]
        : [...pick(light), ...pick(systemSelector, systemMedia)];
  return Object.fromEntries(layers.map(d => [d.property, d.value]));
}
function resolve(tokens, name, seen = new Set()) {
  assert.ok(Object.hasOwn(tokens, name), 'undefined token ' + name);
  assert.ok(!seen.has(name), 'cyclic token ' + name);
  const path = new Set([...seen, name]);
  return tokens[name].replace(/var\((--[\w-]+)\)/g, (_, target) => resolve(tokens, target, path));
}
const rgb = (tokens, name) => {
  const hex = resolve(tokens, name);
  assert.match(hex, /^#[\da-f]{6}$/i, name);
  return cssColours(
    'rgb(' + [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(', ') + ')',
  )[0];
};
const ratio = (tokens, ink, surface) => contrastRatio(rgb(tokens, ink), rgb(tokens, surface));

test('the surfaces and statuses components draw on reach their contrast in both themes', () => {
  for (const theme of ['light', 'dark', 'system']) {
    const tokens = cascade([sheets.v2], theme);
    for (const surface of ['--v2-paper', '--v2-raised', '--v2-subtle', '--v2-selected'])
      for (const ink of ['--v2-ink', '--v2-ink-2', '--v2-violet-text'])
        assert.ok(ratio(tokens, ink, surface) >= 4.5, ink + ' on ' + surface + ' ' + theme);
    for (const status of ['success', 'warning', 'danger', 'info'])
      for (const surface of ['--v2-' + status + '-bg', '--v2-raised'])
        assert.ok(ratio(tokens, '--v2-' + status, surface) >= 4.5, status + ' on ' + surface + ' ' + theme);
    assert.ok(ratio(tokens, '--v2-on-danger', '--v2-danger-solid') >= 4.5, 'on-danger ' + theme);
    // A control boundary and a filled control reach 3:1 against the surfaces they sit on.
    for (const surface of ['--v2-paper', '--v2-raised', '--v2-subtle'])
      assert.ok(ratio(tokens, '--v2-rule-strong', surface) >= 3, 'rule-strong on ' + surface + ' ' + theme);
    for (const surface of ['--v2-paper', '--v2-raised']) {
      assert.ok(ratio(tokens, '--v2-violet', surface) >= 3, 'violet on ' + surface + ' ' + theme);
      assert.ok(ratio(tokens, '--v2-danger-solid', surface) >= 3, 'danger-solid on ' + surface + ' ' + theme);
    }
  }
});

test('the pairs the audit measured below 4.5:1 stay unusable for text, and peach stays a marker', () => {
  const light = cascade([sheets.v2], 'light'),
    dark = cascade([sheets.v2], 'dark');
  assert.ok(ratio(light, '--v2-ink-2', '--v2-rule') < 4.5, 'ink-2 on rule, light');
  assert.ok(ratio(dark, '--v2-ink-2', '--v2-rule') < 4.5, 'ink-2 on rule, dark');
  assert.ok(ratio(dark, '--v2-violet-text', '--v2-rule') < 4.5, 'violet-text on rule, dark');
  assert.ok(ratio(dark, '--v2-ink', '--v2-peach') < 4.5, 'ink on peach, dark');
  assert.ok(ratio(light, '--v2-ink', '--v2-peach') >= 4.5, 'ink on peach reads only in the light theme');
});

test('the 18 policy shades have V2 names that follow the theme through the shade they name', () => {
  const policy = [...new Set(cssDeclarations(sheets.policy).map(d => d.property))].filter(name =>
      name.startsWith('--policy-'),
    ),
    aliases = cssDeclarations(sheets.policy).filter(d => d.property.startsWith('--v2-policy-'));
  assert.equal(policy.length, 18);
  assert.deepEqual(
    aliases.map(d => [d.selector, d.property, d.value]),
    policy.map(name => [':root', '--v2-' + name.slice(2), 'var(' + name + ')']),
    'one alias per shade, in the light block only: it follows the shade through the theme',
  );
  for (const theme of ['light', 'dark', 'system']) {
    const tokens = cascade([sheets.tokens, sheets.policy], theme);
    for (const name of policy) assert.equal(resolve(tokens, '--v2-' + name.slice(2)), resolve(tokens, name), name);
  }
});

test('the V2 sheet after the token sheets changes no legacy token a page resolves, in any theme', () => {
  // The workspace needs JavaScript, and theme.js sets data-theme before styles load, so the sheet's system-dark block
  // (:root:not([data-theme])) never matches there; the static pages follow a dark system through it, as through
  // public-tokens.css's own identical block.
  for (const [files, themes] of [
    [
      [sheets.tokens, sheets.v2],
      ['light', 'dark'],
    ],
    [
      [sheets.tokens, sheets.policy, sheets.v2],
      ['light', 'dark', 'system'],
    ],
  ])
    for (const theme of themes) {
      const before = cascade(files.slice(0, -1), theme),
        after = cascade(files, theme);
      for (const name of Object.keys(before))
        assert.equal(resolve(after, name), resolve(before, name), name + ' ' + theme);
    }
});

test('the static public pages load the V2 sheet third; the shell and About leave it to the routes that use it', () => {
  const links = page =>
    [
      ...read(page)
        .replace(/<noscript>[\s\S]*?<\/noscript>/g, '')
        .matchAll(/<link rel="stylesheet" href="\/assets\/([^"]+)">/g),
    ].map(match => match[1]);
  for (const page of [
    'privacy.html',
    'privacy-ar.html',
    'terms.html',
    'terms-ar.html',
    'data-deletion.html',
    'data-deletion-ar.html',
    '404.html',
    '404-ar.html',
  ])
    assert.deepEqual(links(page).slice(0, 3), ['tokens.css', 'public-tokens.css', 'tokens-v2.css'], page);
  // The sheet would add its bytes to every route that loads the shell or About, and a recorded route budget is never raised for
  // a sheet, so neither links it (docs/DESIGN-SYSTEM.md, "Where it loads"; the room of each route is in web-route-bytes).
  assert.ok(!links('index.html').includes('tokens-v2.css'));
  assert.ok(!links('about.html').includes('tokens-v2.css'));
});
