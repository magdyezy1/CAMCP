// WEB-07 (design system, wave 4b): the scales beside the colours. Corner radius, shadow, motion and type size were
// written by hand in every stylesheet (122 radii in 33 values, 21 shadows in 21, 377 type sizes in 66 on Work-here
// cb338f68), so the same component got 7 to 12 pixel corners depending on its page, and nothing stopped a new value.
// tools/check-design-tokens.mjs counts the values a stylesheet writes itself per scale; a count may only go down, and
// every custom property a stylesheet reads must be defined in a token sheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkDesignTokens,
  designTokenRatchet,
  pageStylesheets,
  scales,
  undefinedTokenProblems,
} from '../tools/check-design-tokens.mjs';
import {cssDeclarations} from '../tools/check-colours.mjs';

const baseline = JSON.parse(fs.readFileSync('tools/web-design-token-baseline.json', 'utf8'));

test('what counts as a value written by hand, per scale', () => {
  const literal = (scale, value) => scales[scale].literal(value);
  for (const value of ['0', '50%', 'var(--radius-md)', 'var(--radius-md) var(--radius-md) 0 0', 'inherit'])
    assert.equal(literal('radius', value), false, value);
  for (const value of ['10px', '0.75rem', '70px 70px 0 0', 'var(--radius-md) 4px', '999px'])
    assert.equal(literal('radius', value), true, value);
  for (const value of ['none', 'var(--elevation-1)', 'inherit']) assert.equal(literal('shadow', value), false, value);
  for (const value of ['0 5px 20px var(--shadow-soft)', '0 0 0 4px var(--surface-accent)'])
    assert.equal(literal('shadow', value), true, value);
  for (const value of ['none !important', 'background var(--duration), transform var(--duration)', '0s'])
    assert.equal(literal('motion', value), false, value);
  for (const value of ['border-color 0.15s', 'spin 0.7s linear infinite', 'transform 200ms'])
    assert.equal(literal('motion', value), true, value);
  for (const value of ['inherit', 'var(--type-xs) !important', 'var(--type-sm)'])
    assert.equal(literal('type', value), false, value);
  for (const value of ['12px', '0.85rem', '13px/1.8 Consolas, monospace', 'clamp(46px, 4.9vw, 75px)'])
    assert.equal(literal('type', value), true, value);
  // Spacing has no tokens: a value off the 4px grid is counted (a 1px or 2px nudge and em values are not).
  for (const value of [
    '0',
    '8px 16px',
    '0.5rem',
    '1px',
    '-2px',
    'auto',
    '0 auto',
    '1.25em',
    'var(--x) 12px',
    '24px 1.5rem',
  ])
    assert.equal(literal('spacing', value), false, value);
  for (const value of ['10px', '7px 12px', '0.6rem', '-6px', '1.1rem 0', '0 0 18px'])
    assert.equal(literal('spacing', value), true, value);
  assert.ok(scales.radius.property('border-top-left-radius') && scales.radius.property('border-radius'));
  assert.ok(scales.type.property('font') && !scales.type.property('font-weight'));
  for (const property of ['padding', 'margin-inline-start', 'padding-block', 'gap', 'row-gap', 'margin-top'])
    assert.ok(scales.spacing.property(property), property);
  assert.ok(!scales.spacing.property('inset-inline-start') && !scales.spacing.property('width'));
});

test('the shipped stylesheets are within the committed baseline, and every token they read is defined', () => {
  const {counts, problems} = checkDesignTokens();
  assert.deepEqual(problems, []);
  for (const scale of Object.keys(scales)) {
    const total = Object.values(counts).reduce((sum, perScale) => sum + perScale[scale], 0);
    assert.ok(total <= baseline.totals[scale], scale + ': ' + total + ' above ' + baseline.totals[scale]);
  }
  assert.match(fs.readFileSync('tools/check-web.mjs', 'utf8'), /checkDesignTokens\(\)/);
});

test('a new hand-written value and an undefined token are refused', () => {
  assert.deepEqual(designTokenRatchet({'a.css': {radius: 2}}, {files: {'a.css': {radius: 2}}}), []);
  assert.match(
    designTokenRatchet({'a.css': {radius: 3, type: 0}}, {files: {'a.css': {radius: 2}}}).join('\n'),
    /web\/a\.css: 3 radius values written by hand \(limit 2\)/,
  );
  assert.match(
    designTokenRatchet({'new.css': {shadow: 1}}, {files: {}}).join('\n'),
    /web\/new\.css: 1 shadow values written by hand \(limit 0\)/,
  );
  assert.match(
    designTokenRatchet({'a.css': {spacing: 5}}, {files: {'a.css': {spacing: 4}}}).join('\n'),
    /web\/a\.css: 5 spacing values off the 4px grid \(limit 4\); use multiples of 4px/,
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-design-tokens-'));
  try {
    fs.mkdirSync(path.join(directory, 'web'));
    fs.writeFileSync(path.join(directory, 'web/tokens.css'), ':root { --radius-md: 10px; --line: #e5e1eb; }\n');
    fs.writeFileSync(path.join(directory, 'web/public-tokens.css'), ':root { --policy-surface: #f8f6fb; }\n');
    fs.writeFileSync(
      path.join(directory, 'web/a.css'),
      '.a { border-radius: var(--radius-md); border: 1px solid var(--line); }\n.b { border-color: var(--border, #ddd); }\n',
    );
    assert.deepEqual(undefinedTokenProblems(directory), ['web/a.css:2: --border is defined in no token sheet (.b)']);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

// Integration review of wave 4b: "defined" was the union of tokens.css and public-tokens.css for every stylesheet, so a
// workspace sheet reading a --policy-* token (public-tokens.css, which the workspace never loads) passed and fell back
// at runtime. A sheet may read a token only from a token sheet that every page loading it loads (outside <noscript>).
test('a stylesheet reads only tokens that every page loading it also loads', () => {
  const shipped = Object.fromEntries(pageStylesheets().map(({page, sheets}) => [page, sheets]));
  assert.ok(!shipped['index.html'].includes('public-tokens.css'), 'the workspace does not load public-tokens.css');
  assert.ok(!shipped['about.html'].includes('public-tokens.css'), "About's copy is inside <noscript>");
  assert.ok(shipped['privacy.html'].includes('public-tokens.css'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-token-pages-'));
  try {
    fs.mkdirSync(path.join(directory, 'web'));
    const write = (file, text) => fs.writeFileSync(path.join(directory, 'web', file), text);
    const link = sheet => '<link rel="stylesheet" href="/assets/' + sheet + '">';
    write('tokens.css', ':root { --line: #e5e1eb; }\n');
    write('public-tokens.css', ':root { --policy-surface: #f8f6fb; --policy-text: var(--line); }\n');
    write('index.html', [link('tokens.css'), link('w.css'), link('shared.css')].join(''));
    write('p.html', [link('tokens.css'), link('public-tokens.css'), link('p.css'), link('shared.css')].join(''));
    write('a.html', link('tokens.css') + '<noscript>' + link('public-tokens.css') + '</noscript>' + link('a.css'));
    write('w.css', '.w { border-color: var(--line); background: var(--policy-surface); }\n');
    write('p.css', '.p { color: var(--policy-text); background: var(--policy-surface); }\n');
    write('shared.css', '.s { color: var(--policy-text); }\n');
    write('a.css', '.a { color: var(--policy-text); }\n');
    write('orphan.css', '.o { background: var(--policy-surface); border-color: var(--missing); }\n');
    assert.deepEqual(undefinedTokenProblems(directory), [
      'web/a.css:1: --policy-text is defined only in public-tokens.css, which a.html does not load (.a)',
      'web/orphan.css:1: --policy-surface is defined only in public-tokens.css, and no page links this sheet to load it (.o)',
      'web/orphan.css:1: --missing is defined in no token sheet (.o)',
      'web/shared.css:1: --policy-text is defined only in public-tokens.css, which index.html does not load (.s)',
      'web/w.css:1: --policy-surface is defined only in public-tokens.css, which index.html does not load (.w)',
    ]);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

// docs/DESIGN-SYSTEM.md documents the tokens: a token added to tokens.css or public-tokens.css without a line there fails.
test('every token the token sheets define is documented in docs/DESIGN-SYSTEM.md', () => {
  const doc = fs.readFileSync('docs/DESIGN-SYSTEM.md', 'utf8');
  const defined = new Set(
    ['tokens.css', 'public-tokens.css'].flatMap(file =>
      cssDeclarations(fs.readFileSync('web/' + file, 'utf8'))
        .map(d => d.property)
        .filter(p => p.startsWith('--')),
    ),
  );
  const missing = [...defined].filter(token => !doc.includes('`' + token + '`') && !doc.includes(token + ','));
  assert.deepEqual(missing, [], 'tokens without documentation');
});
