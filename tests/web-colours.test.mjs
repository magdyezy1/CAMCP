// WEB-07: tokens.css is the one theme source. Dark mode was an override layer (theme.css) over 570 literal colours in
// the shipped stylesheets (2026-10-16), check-web refused only a literal equal to a token value and only in index.html's
// stylesheets, and no CSS followed a dark system on the pages that need no JavaScript. These tests guard the parity of
// the token blocks, the literal-colour ratchet over every stylesheet and the policy pages' dark mode without scripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  checkColours,
  colourRatchet,
  cssDeclarations,
  literalColours,
  readColourBaseline,
  readColourAllowlist,
  tokenParityProblems,
} from '../tools/check-colours.mjs';

// The token sheets as a page that loads both reads them: tokens.css, then the static public pages' public-tokens.css.
const tokens = ['tokens.css', 'public-tokens.css'].map(file => fs.readFileSync('web/' + file, 'utf8')).join('\n');
const block = (selector, atRule) =>
  Object.fromEntries(
    cssDeclarations(tokens)
      .filter(d => d.selector === selector && (atRule ? d.atRules.join(' ') === atRule : !d.atRules.length))
      .map(d => [d.property, d.value]),
  );
const themes = {
  light: block(':root'),
  dark: {...block(':root'), ...block(":root[data-theme='dark']")},
  system: {...block(':root'), ...block(':root:not([data-theme])', '@media (prefers-color-scheme: dark)')},
};
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

test('every colour token has a dark value, and a dark system without JavaScript gets exactly the dark block', () => {
  assert.deepEqual(tokenParityProblems(tokens), []);
  assert.deepEqual(themes.system, themes.dark, 'The no-JavaScript dark block mirrors the dark theme');
  assert.equal(themes.system['color-scheme'], 'dark');
  // The semantic roles follow the palette in both themes.
  for (const [role, palette] of Object.entries({
    '--surface': '--paper',
    '--surface-raised': '--white',
    '--text': '--ink',
    '--text-secondary': '--muted',
    '--border': '--line',
    '--focus': '--iris-700',
    '--status-danger-ink': '--danger',
  }))
    for (const theme of ['light', 'dark'])
      assert.equal(resolve(theme, `var(${role})`), resolve(theme, `var(${palette})`));
  // The refusals the check makes.
  const synthetic = (light, dark, system = dark) =>
    `:root { ${light} }\n:root[data-theme='dark'] { ${dark} }\n@media (prefers-color-scheme: dark) { :root:not([data-theme]) { ${system} } }`;
  assert.match(
    tokenParityProblems(synthetic('--a: #fff; --b: #000;', '--a: #111;')).join('\n'),
    /--b has a light value but no dark value/,
  );
  assert.match(
    tokenParityProblems(synthetic('--a: #fff;', '--a: #111; --c: #222;')).join('\n'),
    /--c is defined only for dark/,
  );
  assert.match(
    tokenParityProblems(synthetic('--a: #fff;', '--a: #111;', '--a: #121;')).join('\n'),
    /system-dark block \(no JavaScript\) differs from the dark block for --a/,
  );
  assert.match(
    tokenParityProblems(`:root { --a: #fff; }\n:root[data-theme='dark'] { --a: #111; }`).join('\n'),
    /cannot follow a dark system/,
  );
  assert.match(
    tokenParityProblems(synthetic('--surface-inverse: #201d30;', '--surface-inverse: #201d30;')).join('\n'),
    /theme-invariant but has a dark value/,
  );
});

test('literal colours are counted in every stylesheet, refused above the baseline, and allowed only by name', () => {
  const found = literalColours(
    `.a { color: #123456; border: 1px solid var(--border, #ddd); background: url("/x#fff.svg") white; }
     @media (max-width: 9px) { .b { box-shadow: 0 1px 2px rgb(0 0 0 / 10%), 0 0 1px hsl(1 2% 3%); } }
     .c { --token: #abc; color: var(--ink); white-space: nowrap; }`,
  );
  assert.deepEqual(
    found.map(entry => entry.selector + ' ' + entry.property + ' ' + entry.literal),
    [
      '.a color #123456',
      '.a border #ddd',
      '.a background white',
      '.b box-shadow rgb(0 0 0 / 10%)',
      '.b box-shadow hsl(1 2% 3%)',
    ],
  );
  assert.deepEqual(found[3].atRules, ['@media (max-width: 9px)']);
  const baseline = {files: {'a.css': 3}, allowlist_entries: 1};
  assert.deepEqual(colourRatchet({'a.css': 3}, baseline, {entries: [{}]}), []);
  assert.deepEqual(colourRatchet({'a.css': 1}, baseline, {entries: []}), [], 'Going down is always allowed');
  assert.match(
    colourRatchet({'a.css': 4}, baseline, {entries: []}).join('\n'),
    /web\/a\.css: 4 literal colours \(limit 3\)/,
  );
  assert.match(
    colourRatchet({'new.css': 1}, baseline, {entries: []}).join('\n'),
    /web\/new\.css: 1 literal colours \(limit 0\)/,
  );
  assert.match(
    colourRatchet({}, baseline, {entries: [{}, {}]}).join('\n'),
    /the allow-list of literal colours only shrinks/,
  );
});

test('the shipped stylesheets are within the committed baseline, which is below the 570 literals they started from', () => {
  const {counts, problems} = checkColours(),
    committed = readColourBaseline(),
    allowlist = readColourAllowlist();
  assert.deepEqual(problems, []);
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  assert.ok(total <= committed.total);
  // Work-here (2026-10-16): 570 literal colours outside tokens.css, none reviewed, check-web blind to two stylesheets.
  assert.ok(committed.total + allowlist.entries.length < 570);
  for (const entry of allowlist.entries) assert.ok(entry.reason && entry.file && entry.selector && entry.property);
  assert.match(fs.readFileSync('tools/check-web.mjs', 'utf8'), /checkColours\(\)/);
});

test('the policy pages take every colour from tokens, so they follow a dark system with JavaScript turned off', () => {
  // Privacy, Terms, Data deletion and 404 load tokens.css, public-tokens.css, privacy.css and theme.css; theme.css needs
  // a data-theme attribute that only web/theme.js sets, so without JavaScript only tokens can change these pages.
  const privacy = fs.readFileSync('web/privacy.css', 'utf8'),
    allowlist = readColourAllowlist().entries.filter(entry => entry.file === 'privacy.css');
  const literals = literalColours(privacy).filter(
    found => !allowlist.some(entry => entry.selector === found.selector && entry.property === found.property),
  );
  assert.deepEqual(literals, [], 'privacy.css writes no colour of its own');
  assert.deepEqual(
    literalColours(privacy).map(found => found.atRules.join(' ')),
    ['@media print'],
    'The one literal is the printed page',
  );
  for (const html of ['privacy.html', 'privacy-ar.html', 'terms.html', 'data-deletion.html', '404.html'])
    assert.match(
      fs.readFileSync('web/' + html, 'utf8'),
      /href="\/assets\/tokens\.css"><link rel="stylesheet" href="\/assets\/public-tokens\.css">[\s\S]*href="\/assets\/privacy\.css">/,
    );
  // The dark system and the policy shades are the public pages' only: About loads them only without JavaScript, and the
  // workspace, which needs JavaScript (theme.js sets its theme before styles load), never does.
  assert.match(
    fs.readFileSync('web/about.html', 'utf8'),
    /<noscript><link rel="stylesheet" href="\/assets\/public-tokens\.css"><\/noscript>/,
  );
  assert.doesNotMatch(fs.readFileSync('web/index.html', 'utf8'), /public-tokens\.css/);
  assert.doesNotMatch(fs.readFileSync('web/tokens.css', 'utf8'), /--policy-|prefers-color-scheme/);
  const theme = fs.readFileSync('web/theme.css', 'utf8');
  for (const selector of ['.policy-layout', '.policy-heading', '.site-header', '.policy-languages', '.contents'])
    assert.ok(!theme.includes(selector), selector + ' has no dark override: its tokens carry both themes');
  // Every text colour the pages use reaches 4.5:1 on their surfaces in light, dark and system-dark.
  const text = [
      '--policy-text',
      '--policy-text-body',
      '--policy-text-intro',
      '--policy-text-strong',
      '--policy-lead',
      '--policy-text-secondary',
      '--policy-eyebrow',
      '--policy-link',
      '--policy-link-hover',
      '--policy-nav-link',
      '--policy-contents-link',
    ],
    surfaces = ['--policy-surface', '--surface-raised', '--policy-code'];
  for (const theme of ['light', 'dark', 'system'])
    for (const ink of text)
      for (const surface of surfaces) {
        const ratio = contrast(resolve(theme, `var(${ink})`), resolve(theme, `var(${surface})`));
        assert.ok(ratio >= 4.5, `${theme} ${ink} on ${surface}: ${ratio.toFixed(2)}`);
      }
  // The dividers that were light lines on the dark page are the dark theme's line now.
  for (const border of ['--policy-border', '--policy-border-subtle', '--policy-border-strong'])
    assert.equal(resolve('dark', `var(${border})`), resolve('dark', 'var(--line)'));
});
