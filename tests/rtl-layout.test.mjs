// WEB-05: the shell stylesheets were written left-to-right first and patched for Arabic rule by rule (identity.css had
// 64 physical left/right declarations, app.css 14, localization.css 18 mirror patches). They now use logical
// properties, check-web refuses a new physical side, the top bar keeps one row, and shell identifiers are isolated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {physicalAllowed, physicalReason, rtlProblems, accountMarkupProblems} from '../tools/check-rtl.mjs';

const sheets = fs
  .readdirSync('web', {recursive: true})
  .filter(file => file.endsWith('.css'))
  .map(file => file.replaceAll('\\', '/'));

test('check-web refuses a new physical left/right declaration and accepts its logical form', () => {
  const css = `.a { margin-left: 4px; }
.b { padding-right: 2px; left: 0; right: auto; }
.c { border-left: 1px solid; border-top-right-radius: 4px; }
.d { text-align: left; float: right; }
.e { margin: 0 4px 0 0; inset: 0 auto 0 0; border-radius: 4px 0 0 4px; }
@media (max-width: 850px) { .f { right: 9px; } }
/* .commented { margin-left: 4px; } */
.ok { margin-inline-start: 4px; padding-inline: 2px 4px; inset-inline: 0 auto; text-align: start; }
.ok2 { margin: 0 4px; padding: 1px 2px 3px 2px; border-radius: 4px 4px 0 0; float: inline-start; text-align: center; }`;
  const problems = rtlProblems(css, 'synthetic.css');
  assert.deepEqual(
    problems.map(problem => problem.split(' — ')[0]),
    [
      'synthetic.css:1: .a { margin-left: 4px }',
      'synthetic.css:2: .b { padding-right: 2px }',
      'synthetic.css:2: .b { left: 0 }',
      'synthetic.css:2: .b { right: auto }',
      'synthetic.css:3: .c { border-left: 1px solid }',
      'synthetic.css:3: .c { border-top-right-radius: 4px }',
      'synthetic.css:4: .d { text-align: left }',
      'synthetic.css:4: .d { float: right }',
      'synthetic.css:5: .e { margin: 0 4px 0 0 }',
      'synthetic.css:5: .e { inset: 0 auto 0 0 }',
      'synthetic.css:5: .e { border-radius: 4px 0 0 4px }',
      'synthetic.css:6: .f { right: 9px }',
    ],
  );
  assert.ok(problems.every(problem => problem.endsWith('use the logical property')));
  assert.equal(physicalReason('margin-inline-start', '4px'), null);
  assert.equal(physicalReason('transform', 'translateX(100%)'), null, 'Transforms have no logical form');
  // An allow-listed declaration names its file, selector and exact declaration.
  physicalAllowed.set('synthetic.css|.a|margin-left: 4px', 'Synthetic exception');
  try {
    assert.equal(rtlProblems('.a { margin-left: 4px; }', 'synthetic.css').length, 0);
    assert.equal(rtlProblems('.a { margin-left: 5px; }', 'synthetic.css').length, 1);
  } finally {
    physicalAllowed.delete('synthetic.css|.a|margin-left: 4px');
  }
});

test('every shipped stylesheet uses logical sides, so the Arabic mirror patches are gone', () => {
  assert.ok(sheets.includes('identity.css') && sheets.includes('app.css') && sheets.includes('localization.css'));
  for (const sheet of sheets) assert.deepEqual(rtlProblems(fs.readFileSync('web/' + sheet, 'utf8'), sheet), [], sheet);
  assert.equal(physicalAllowed.size, 0, 'No physical side is needed today');
  const localization = fs.readFileSync('web/localization.css', 'utf8');
  for (const patched of ['.main-shell', '.password-toggle', '.sidebar-close', '.default-badge', '.platform-metrics'])
    assert.ok(!localization.includes("html[dir='rtl'] " + patched + ' {'), patched + ' needs no mirror patch');
  // The phone drawer slides in from the reading side: a transform has no logical form, so this patch stays.
  assert.match(localization, /html\[dir='rtl'\] \.sidebar \{\s*transform: translateX\(100%\);/);
  const identity = fs.readFileSync('web/identity.css', 'utf8'),
    app = fs.readFileSync('web/app.css', 'utf8');
  // V2-WEB-03: the sidebar is the first column of a grid, which follows the writing direction by itself (it was a fixed
  // column, with a start margin on the page to make room for it); only the phone drawer, a fixed panel that waits off
  // the window, keeps its logical inset.
  assert.match(app, /\.app-shell \{\s*display: grid;\s*grid-template-columns: 256px minmax\(0, 1fr\);/);
  assert.doesNotMatch(identity, /\.main-shell \{[^}]*margin-inline-start/);
  assert.match(
    identity,
    /@media \(max-width: 850px\) \{\s*\.sidebar \{\s*position: fixed;\s*inset-block: 0;\s*inset-inline: 0 auto;/,
  );
});

test('the top bar keeps one row: square avatar, shortening breadcrumb, labels give way by container width', () => {
  const identity = fs.readFileSync('web/identity.css', 'utf8'),
    localization = fs.readFileSync('web/localization.css', 'utf8'),
    index = fs.readFileSync('web/index.html', 'utf8');
  assert.match(identity, /\.topbar \{\s*container: topbar \/ inline-size;\s*\}/);
  assert.match(
    identity,
    /\.breadcrumb \{\s*min-width: 0;\s*overflow: hidden;\s*white-space: nowrap;\s*text-overflow: ellipsis;\s*\}/,
  );
  assert.match(
    identity,
    /\.top-actions,\s*\.top-actions > \*,\s*\.command-trigger,\s*\.topbar \.button \{\s*flex-shrink: 0;\s*white-space: nowrap;\s*\}/,
  );
  assert.match(
    identity,
    /@container topbar \(max-width: 800px\) \{\s*\.top-actions \.language-control > span,\s*\.top-actions \.theme-control > span \{\s*display: none;/,
  );
  assert.match(identity, /@container topbar \(max-width: 690px\) \{\s*#command-trigger-label \{\s*display: none;/);
  // Arabic buttons may wrap elsewhere; in the top bar they stay on one line.
  assert.match(localization, /html\[lang='ar'\] \.topbar \.button \{\s*white-space: nowrap;\s*\}/);
  // The hidden labels leave every control named.
  assert.match(index, /<select data-language-select aria-label="Language" data-ui-label="Language">/);
  assert.match(index, /<select data-theme-select aria-label="Appearance" data-ui-label="Appearance">/);
  assert.match(index, /aria-labelledby="command-trigger-label command-trigger-shortcut"/);
  // An RTL workspace name starts with its own first word instead of being cut from its start.
  assert.match(index, /<strong id="workspace-name" dir="auto">/);
});

test('account names in markup go through the isolating helpers; option labels stay plain text', () => {
  assert.deepEqual(
    accountMarkupProblems(
      '`<small>${esc(recordAccountLabel(a.platform, a.connection_id, a.account_id))}</small>`',
      'x.js',
    ).map(problem => problem.split(';')[0]),
    ['x.js:1: recordAccountLabel in markup'],
  );
  assert.equal(accountMarkupProblems('`<p>${esc(accountText(p, c, id))}</p>`', 'x.js').length, 1);
  assert.equal(accountMarkupProblems('`<option value="1">${esc(accountLabel(p, c, a))}</option>`', 'x.js').length, 0);
  for (const file of fs.readdirSync('web').filter(file => file.endsWith('.js')))
    assert.deepEqual(accountMarkupProblems(fs.readFileSync('web/' + file, 'utf8'), file), [], file);
});

test('the report builder keeps native account and login names and metric formulas literal', () => {
  // RPT-07's rendered period comparison: the Arabic leak probe counted the account name and seven metric formulas
  // ("spend / clicks") as English interface text, because they sat in Arabic running text unmarked. They are now
  // isolated native values and left-to-right literals.
  const source = fs.readFileSync('web/reporting-overview.js', 'utf8');
  assert.match(source, /<span><bdi dir="auto" data-native>\$\{esc\(a\.label\)\}<\/bdi><small>/);
  assert.match(
    source,
    /\$\{esc\(uiText\('Login:'\)\)\} <bdi dir="auto" data-native>\$\{esc\(a\.connection_label \?\? a\.label\)\}<\/bdi>/,
  );
  // Design review 2026-10: only a formula is a left-to-right literal; a base metric's aggregation ("sum",
  // "non_additive") showed raw and in English on the Arabic page, and is now said in words through the catalog.
  assert.match(
    source,
    /<small class="metric-formula"\$\{m\.formula \? ' dir="ltr"' : ''\}>\$\{esc\(m\.formula \?\? uiText\(metricAggregations\[m\.aggregation\] \?\? m\.aggregation\)\)\}<\/small>/,
  );
});
