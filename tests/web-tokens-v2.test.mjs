// V2-WEB-01: the unloaded palette must preserve old values and satisfy its documented accessibility contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {cssDeclarations, tokenParityProblems, tokenSheets} from '../tools/check-colours.mjs';
import {contrastRatio, cssColours} from '../tools/browser-accessibility.mjs';

const read = file => fs.readFileSync('web/' + file, 'utf8');
function block(css, selector, media) {
  return Object.fromEntries(
    cssDeclarations(css)
      .filter(
        d =>
          d.selector === selector &&
          (media ? d.atRules.join(' ') === media : d.atRules.length === 0) &&
          d.property.startsWith('--'),
      )
      .map(d => [d.property, d.value]),
  );
}
function theme(css, dark) {
  return {...block(css, ':root'), ...(dark ? block(css, ":root[data-theme='dark']") : {})};
}
function resolve(tokens, name, seen = new Set()) {
  assert.ok(Object.hasOwn(tokens, name), 'undefined token ' + name);
  assert.ok(!seen.has(name), 'cyclic token ' + name);
  const path = new Set([...seen, name]);
  return tokens[name].replace(/var\((--[\w-]+)\)/g, (_, target) => resolve(tokens, target, path));
}
const colour = (tokens, name) => {
  const hex = resolve(tokens, name);
  assert.match(hex, /^#[\da-f]{6}$/i, name);
  const channels = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return cssColours('rgb(' + channels.join(', ') + ')')[0];
};

test('every old token resolves to its original value in both V2 themes', () => {
  for (const dark of [false, true]) {
    const old = theme(read('tokens.css'), dark),
      v2 = theme(read('tokens-v2.css'), dark);
    for (const name of Object.keys(old)) assert.equal(resolve(v2, name), resolve(old, name), name + ' dark=' + dark);
    for (const [oldName, nextName] of [
      ['--ink', '--v2-ink'],
      ['--muted', '--v2-ink-2'],
      ['--line', '--v2-rule'],
      ['--line-strong', '--v2-rule-strong'],
      ['--apricot', '--v2-peach'],
      [dark ? '--iris' : '--iris-700', '--v2-violet-text'],
    ])
      assert.equal(v2[oldName], 'var(' + nextName + ')', oldName);
  }
});
test('every V2 text and control pair passes contrast, with data-3 requiring direct labels', () => {
  const needsDirectLabels = ['--v2-data-3'];
  for (const dark of [false, true]) {
    const tokens = theme(read('tokens-v2.css'), dark);
    for (const [ink, paper, minimum] of [
      ['--v2-ink', '--v2-paper', 4.5],
      ['--v2-ink-2', '--v2-paper', 4.5],
      ['--v2-violet-text', '--v2-paper', 4.5],
      ['--v2-on-violet', '--v2-violet', 4.5],
      ['--v2-rule-strong', '--v2-paper', 3],
      ['--v2-data-1', '--v2-paper', 3],
      ['--v2-data-2', '--v2-paper', 3],
    ]) {
      const ratio = contrastRatio(colour(tokens, ink), colour(tokens, paper));
      assert.ok(ratio >= minimum, ink + ' dark=' + dark + ' contrast=' + ratio);
    }
    for (const token of ['--v2-data-1', '--v2-data-2', '--v2-data-3'])
      assert.ok(
        needsDirectLabels.includes(token) || contrastRatio(colour(tokens, token), colour(tokens, '--v2-paper')) >= 3,
        token,
      );
  }
  assert.match(fs.readFileSync('docs/DESIGN-SYSTEM.md', 'utf8'), /data-3[\s\S]*?direct labels/i);
});
test('V2 dark and system blocks are equal, parity is independent, and no page loads the sheet', () => {
  const css = read('tokens-v2.css');
  assert.ok(tokenSheets.includes('tokens-v2.css'));
  assert.deepEqual(
    block(css, ":root[data-theme='dark']"),
    block(css, ':root:not([data-theme])', '@media (prefers-color-scheme: dark)'),
  );
  assert.deepEqual(tokenParityProblems(css, 'web/tokens-v2.css'), []);
  const references = fs
    .readdirSync('web', {recursive: true})
    .map(file => file.replaceAll('\\', '/'))
    .filter(
      file => /\.(?:html|js|css)$/.test(file) && file !== 'tokens-v2.css' && read(file).includes('tokens-v2.css'),
    );
  assert.deepEqual(references, []);
});
test('every V2 token is documented in DESIGN-SYSTEM.md', () => {
  const doc = fs.readFileSync('docs/DESIGN-SYSTEM.md', 'utf8'),
    names = new Set(
      cssDeclarations(read('tokens-v2.css'))
        .map(d => d.property)
        .filter(p => p.startsWith('--v2-')),
    );
  assert.equal(names.size, 45, 'the 45 V2 tokens in the approved contract');
  assert.deepEqual(
    [...names].filter(name => !doc.includes('`' + name + '`')),
    [],
  );
});
test('V2 density, spacing, motion, elevation and numerical values match the contract', () => {
  const css = read('tokens-v2.css'),
    light = theme(css, false),
    compact = block(css, ":root[data-density='compact']"),
    reduced = block(css, ':root', '@media (prefers-reduced-motion: reduce)');
  for (const [index, value] of [4, 8, 12, 16].entries()) assert.equal(light['--v2-space-' + (index + 1)], value + 'px');
  for (const [name, value] of Object.entries({
    '--v2-control-height': '40px',
    '--v2-row-height': '44px',
    '--v2-radius-control': '8px',
    '--v2-radius-card': '12px',
    '--v2-radius-round': '999px',
    '--v2-numeric': 'tabular-nums',
    '--v2-duration-fast': '120ms',
    '--v2-duration': '180ms',
    '--v2-duration-slow': '280ms',
    '--v2-ease': 'cubic-bezier(0.2, 0, 0, 1)',
  }))
    assert.equal(light[name], value, name);
  assert.deepEqual(compact, {'--v2-control-height': '32px', '--v2-row-height': '32px'});
  for (const name of ['--v2-duration-fast', '--v2-duration', '--v2-duration-slow']) assert.equal(reduced[name], '0s');
  for (const [index, name] of ['raised', 'sticky', 'drawer', 'overlay', 'dialog', 'toast'].entries())
    assert.equal(light['--v2-z-' + name], String((index + 1) * 10));
  assert.equal(light['--v2-elevation-overlay'], 'var(--v2-shadow-overlay)');
  for (const dark of [false, true])
    assert.equal(
      resolve(theme(css, dark), '--v2-elevation-overlay'),
      resolve(theme(read('tokens.css'), dark), '--elevation-2'),
    );
});
test('V2 type never goes below 12px and large steps clamp between 320px and 1440px', () => {
  const light = theme(read('tokens-v2.css'), false);
  for (const [name, pixels] of [
    ['xs', 12],
    ['sm', 14],
    ['md', 16],
  ])
    assert.equal(light['--v2-text-' + name], pixels + 'px');
  for (const [name, low, high] of [
    ['lg', 18, 22],
    ['xl', 22, 28],
    ['2xl', 28, 40],
    ['kpi', 32, 56],
    ['space-5', 16, 24],
    ['space-6', 24, 32],
    ['space-7', 32, 48],
    ['space-8', 40, 64],
  ]) {
    const property = '--v2-' + (name.startsWith('space-') ? name : 'text-' + name),
      match = /^clamp\(([\d.]+)px,\s*([\d.]+)px \+ ([\d.]+)vw,\s*([\d.]+)px\)$/.exec(light[property]);
    assert.ok(match, property);
    const [, min, base, vw, max] = match.map(Number);
    assert.deepEqual([min, max], [low, high]);
    const at = width => Math.min(max, Math.max(min, base + (vw * width) / 100));
    assert.ok(at(320) >= 12 && Math.abs(at(320) - low) <= 0.02, property + ' compact');
    assert.ok(Math.abs(at(1440) - high) <= 0.02, property + ' wide');
  }
});
