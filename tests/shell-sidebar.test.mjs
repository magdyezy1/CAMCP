// V2-WEB-03 decision 2: the sidebar and the rail. A neutral frame (no coloured sidebar), persistent on wide screens,
// collapsing to a rail with one distinct icon per link, its state remembered; the navigation scrolls inside its own
// column and the footer stays reachable at any height (design review: nothing is clipped at 800px in either language);
// below 851px it is the drawer. This file reads the shipped markup, stylesheets and the shell code; the rendered checks
// (geometry at 800px, the rail, the drawer, both languages and themes) are the runner's `shell` kind.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';
import {cssDeclarations} from '../tools/check-colours.mjs';

const read = file => fs.readFileSync('web/' + file, 'utf8'),
  index = read('index.html'),
  catalog = JSON.parse(read('locales/ar.json')),
  sheets = ['app.css', 'identity.css', 'accessibility.css', 'localization.css', 'theme.css'];
// A rule for several selectors is one entry per selector (commas inside :is() and :not() are not separators).
const splitSelectors = list => {
  const parts = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++;
    else if (list[i] === ')') depth--;
    else if (list[i] === ',' && depth === 0) {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  return [...parts, list.slice(start).trim()];
};
const declarations = sheets.flatMap(sheet =>
    cssDeclarations(read(sheet)).flatMap(d => splitSelectors(d.selector).map(selector => ({...d, selector, sheet}))),
  ),
  of = selector => declarations.filter(d => d.selector === selector),
  value = (selector, property, atRule = '') =>
    of(selector)
      .filter(d => d.property === property && d.atRules.join(' ') === atRule)
      .at(-1)?.value;

function shell() {
  const stored = new Map(),
    context = createContext({
      Intl,
      Map,
      Set,
      document: {addEventListener() {}},
      catalog,
      session: {authenticated: true},
      localStorage: {
        getItem: key => stored.get(key) ?? null,
        setItem: (key, value) => stored.set(key, String(value)),
      },
    }),
    run = source => new Script(source).runInContext(context),
    identity = read('identity.js');
  run(read('localization.js'));
  run(read('routes.js'));
  // The glyphs, the navigation builders and the sidebar's rules: everything before the first helper that touches the page.
  run(identity.slice(0, identity.indexOf('/** A public file')));
  return {run, context, stored};
}

test('the sidebar is a neutral frame: no inverse surface, ink, fill or ring anywhere in its rules', () => {
  const inverse =
      /--(?:surface-inverse|text-on-inverse|fill-on-inverse|border-on-inverse|accent-on-inverse|focus-on-inverse)/,
    frame = /\.sidebar|\.nav-group|\.nav-icon|\.nav-text|\.brand-note|\.workspace(?![\w-]*menu)|\.readonly-indicator/,
    offenders = declarations
      .filter(d => frame.test(d.selector) && inverse.test(d.value))
      .map(d => d.sheet + ': ' + d.selector + ' { ' + d.property + ': ' + d.value + ' }');
  assert.deepEqual(offenders, []);
  // The surface is the raised one with a 1px rule; the current page is the only coloured link.
  assert.equal(value('.sidebar', 'background'), 'var(--surface-raised)');
  assert.equal(value('.sidebar', 'border-inline-end'), '1px solid var(--border)');
  assert.equal(value('.sidebar a[data-route].active', 'background'), 'var(--surface-selected)');
  // Peach is a marker, never a surface or text: here only the bar at the start edge of the current link.
  const peach = declarations.filter(
    d => /--apricot|--surface-peach/.test(d.value) && /\.sidebar|\.nav-/.test(d.selector),
  );
  assert.deepEqual(
    peach.map(d => d.selector + ' ' + d.property),
    ['.sidebar a[data-route].active border-inline-start-color'],
  );
  // The global ring is the page's own on this surface; the on-dark ring is for the surfaces that stay dark.
  const ring = read('accessibility.css');
  assert.doesNotMatch(ring, /:is\(\.sidebar[^)]*\)/);
});

test('the sidebar is a column: the navigation scrolls inside it and the footer keeps its size', () => {
  assert.equal(value('.sidebar', 'display'), 'flex');
  assert.equal(value('.sidebar', 'flex-direction'), 'column');
  assert.equal(value('.sidebar', 'position'), 'sticky');
  assert.equal(value('.sidebar', 'height'), '100dvh', 'as tall as the window, whatever its height');
  // The scrolling box has the room and the shrink it needs (min-height: 0 is what lets a flex child scroll at all).
  assert.equal(value('.sidebar > nav', 'overflow-y'), 'auto');
  assert.equal(value('.sidebar > nav', 'min-height'), '0');
  assert.equal(value('.sidebar > nav', 'flex'), '1 1 auto');
  // The focus ring of a link at the edge of the scrolling box is inside its padding, not cut.
  assert.equal(value('.sidebar > nav', 'padding'), '4px');
  for (const kept of ['.sidebar-head', '.sidebar-bottom', '.workspace-card'])
    assert.equal(value(kept, 'flex'), 'none', kept + ' keeps its size');
  // No rule hides the footer, the workspace card or the navigation at a short window, as the old sidebar did.
  for (const d of declarations.filter(d => /sidebar|workspace|readonly/.test(d.selector) && d.property === 'display'))
    assert.ok(
      !(d.value === 'none' && /max-height/.test(d.atRules.join(' '))),
      d.selector + ' is hidden at a short window',
    );
});

test('every link of the sidebar is a 44px target with its own glyph and a visible label', () => {
  assert.equal(value('.sidebar a[data-route]', 'min-height'), '44px');
  assert.equal(value('.sidebar-toggle', 'min-height'), '44px');
  assert.equal(value('.nav-group-toggle', 'min-height'), '40px');
  // Text is 12px or larger.
  for (const d of declarations.filter(
    d => /\.sidebar|\.nav-|\.brand-note|\.workspace|\.readonly/.test(d.selector) && d.property === 'font-size',
  ))
    assert.doesNotMatch(d.value, /^(?:[0-9]|1[01])px$/, d.selector + ' text is under 12px');
});

test('the rail is 72px of icons: every label stays for assistive technology, the groups become rules', () => {
  assert.equal(value(".app-shell[data-sidebar='rail']", 'grid-template-columns'), '72px minmax(0, 1fr)');
  assert.equal(value('.app-shell', 'grid-template-columns'), '256px minmax(0, 1fr)');
  const rail = declarations.filter(d => d.selector.includes("[data-sidebar='rail']"));
  assert.ok(rail.length > 8, 'the rail has its own rules, found ' + rail.length);
  // A label hidden with display: none would leave an icon without a name; the rail clips it instead.
  const hidden = rail.filter(d => /\.nav-text|\.workspace > div|\.readonly-indicator span/.test(d.selector));
  assert.ok(
    hidden.some(d => d.property === 'clip-path'),
    'the rail clips its labels: ' + JSON.stringify(hidden.map(d => d.selector)),
  );
  assert.deepEqual(
    hidden.filter(d => d.property === 'display' || d.property === 'visibility'),
    [],
    'a rail label is clipped, not removed',
  );
  // It applies from 851px: below that the sidebar is the drawer and never a rail.
  assert.deepEqual(
    rail
      .filter(d => d.atRules.join(' ') !== '@media (min-width: 851px)' && d.property !== 'grid-template-columns')
      .map(d => d.selector + ' ' + d.atRules.join(' ')),
    [],
  );
  // The brand is the icon alone in the rail, at 24px or more, never a lockup under 160px.
  assert.equal(value(".app-shell[data-sidebar='rail'] .brand-lockup", 'display', '@media (min-width: 851px)'), 'none');
  assert.equal(value(".app-shell[data-sidebar='rail'] .logo-mark", 'display', '@media (min-width: 851px)'), 'block');
  const mark = /<img class="logo-mark" src="\/assets\/mark\.svg" width="(\d+)" height="(\d+)" alt="AMCP">/.exec(index);
  assert.ok(mark && Number(mark[1]) >= 24 && mark[1] === mark[2], 'the icon is square and at least 24px');
});

test('the shell’s markup: a brand with its lockup and its icon, two navigation hooks, a footer with the rail switch', () => {
  const aside = /<aside class="sidebar" id="workspace-sidebar">([\s\S]*?)<\/aside>/.exec(index)?.[1];
  assert.ok(aside, 'the sidebar is there');
  assert.match(
    aside,
    /<div class="sidebar-head"><a class="brand" href="\/"><span class="brand-lockup"><img class="logo-ink"/,
  );
  assert.match(aside, /<nav aria-label="Main navigation" data-ui-label="Main navigation"><\/nav>/);
  assert.match(
    aside,
    /<nav class="sidebar-links" aria-label="Your account and help" data-ui-label="Your account and help"><\/nav>/,
  );
  assert.match(
    aside,
    /<button type="button" class="sidebar-toggle" data-sidebar-toggle aria-expanded="true" aria-controls="workspace-sidebar">/,
  );
  // What the neutral frame retires: the promotional note, the heading over the links and the legal pair.
  for (const gone of ['sidebar-note', 'nav-label', 'mini-spark', 'class="legal"'])
    assert.ok(!aside.includes(gone), gone + ' left the sidebar');
  // The footer keeps Privacy and Terms where every page has them.
  assert.match(
    index,
    /<footer class="page-footer"><span class="footer-links">[\s\S]*?href="\/privacy"[\s\S]*?href="\/terms"/,
  );
  for (const key of ['Your account and help', 'Collapse navigation', 'Expand navigation'])
    assert.match(catalog[key] ?? '', /[؀-ۿ]/, key + ' has Arabic');
  // The shell's rail state starts as the default for wide windows and is set by script from there.
  assert.match(index, /<div class="app-shell" data-sidebar="full">/);
});

test('the state of the sidebar: a remembered choice wins, otherwise wide windows keep it open and narrower ones the rail', () => {
  const page = shell();
  for (const [choice, wide, state] of [
    [null, true, 'full'],
    [null, false, 'rail'],
    ['rail', true, 'rail'],
    ['full', false, 'full'],
    ['sideways', true, 'full'],
    ['sideways', false, 'rail'],
    [undefined, true, 'full'],
  ])
    assert.equal(page.run(`sidebarStateFor(${JSON.stringify(choice)}, ${wide})`), state, `${choice} ${wide}`);
  // The choice is read from this browser's storage and survives a storage that refuses.
  page.stored.set('amcp.sidebar', 'rail');
  assert.equal(page.run('sidebarChoice()'), 'rail');
  page.stored.set('amcp.sidebar', 'junk');
  assert.equal(page.run('sidebarChoice()'), null);
  page.context.localStorage = {
    getItem() {
      throw Error('denied');
    },
  };
  assert.equal(page.run('sidebarChoice()'), null);
});

test('the navigation is built as disclosure groups with real controls, and the footer links come from the registry', () => {
  const page = shell(),
    markup = String(page.run('shellNavigationMarkup()')),
    groups = [
      ...markup.matchAll(
        /<div class="nav-group" data-group="([^"]+)" data-open="false"><button type="button" class="nav-group-toggle" aria-expanded="false" aria-controls="([^"]+)">/g,
      ),
    ];
  assert.deepEqual(
    groups.map(match => match[1]),
    ['Reports', 'Campaigns', 'Connections', 'Operations', 'Settings'],
    'each group of several pages opens as a disclosure; Home and Creative are plain links',
  );
  for (const [, , controls] of groups)
    assert.ok(markup.includes(`<div class="nav-group-links" id="${controls}">`), controls);
  assert.equal((markup.match(/<a href=/g) ?? []).length, 18);
  assert.match(markup, /^<a href="\/dashboard" data-route="dashboard">/);
  // The links name their label for the language switch, and each carries one glyph.
  for (const link of markup.matchAll(
    /<a href="[^"]+" data-route="[^"]+"><span class="nav-icon">(<svg[^>]*><path d="[^"]+"\/><\/svg>)<\/span><span class="nav-text" data-ui-text="[^"]+">/g,
  ))
    assert.ok(link[1]);
  const footer = String(page.run('shellUserLinksMarkup()'));
  assert.match(footer, /<a href="\/account" data-route="account">/);
  assert.match(footer, /<a href="\/help" data-route="help">/);
  const paths = [...(markup + footer).matchAll(/<span class="nav-icon"><svg[^>]*><path d="([^"]+)"/g)].map(
    match => match[1],
  );
  assert.equal(new Set(paths).size, paths.length, 'no two links draw the same glyph');
});

// The pairs the neutral frame draws, read from the shipped stylesheets and tokens in both themes: text 4.5:1, the focus
// ring 3:1 (WCAG 1.4.3, 1.4.11).
const tokenText = fs.readFileSync('web/tokens.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
  tokenBlock = selector => {
    const start = tokenText.indexOf(selector + ' {');
    assert.ok(start >= 0, 'Missing ' + selector);
    return tokenText.slice(start, tokenText.indexOf('}', start));
  },
  tokenMap = body => new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()])),
  lightTokens = tokenMap(tokenBlock(':root')),
  darkTokens = new Map([...lightTokens, ...tokenMap(tokenBlock(":root[data-theme='dark']"))]),
  resolveToken = (theme, token) => {
    let current = token;
    for (let depth = 0; depth < 8; depth++) {
      const reference = /^var\((--[\w-]+)\)$/.exec(current);
      if (!reference) return current;
      current = theme.get(reference[1]);
      assert.ok(current, 'Unknown token ' + reference[1]);
    }
    throw Error('Token reference cycle');
  },
  channel = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4),
  luminance = hex => {
    const full = hex.length === 4 ? [...hex.slice(1)].map(c => c + c).join('') : hex.slice(1);
    assert.match(full, /^[0-9a-f]{6}$/i, 'Opaque colour expected: ' + hex);
    const [r, g, b] = [0, 2, 4].map(i => channel(Number.parseInt(full.slice(i, i + 2), 16) / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  },
  contrast = (a, b) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  };

test('the neutral sidebar reads in both themes: text 4.5:1 on every surface it meets, the ring 3:1', () => {
  const colour = (selector, property) => {
    const found = value(selector, property);
    assert.ok(found, selector + ' { ' + property + ' }');
    return found;
  };
  const surface = colour('.sidebar', 'background'),
    hover = colour('.sidebar a[data-route]:hover', 'background'),
    selected = colour('.sidebar a[data-route].active', 'background'),
    card = colour('.workspace', 'background');
  const pairs = [
    ['link', colour('.sidebar a[data-route]', 'color'), surface],
    ['link on hover', colour('.sidebar a[data-route]:hover', 'color'), hover],
    ['current page', colour('.sidebar a[data-route].active', 'color'), selected],
    ['group name', colour('.nav-group-toggle', 'color'), surface],
    ['group name on hover', colour('.nav-group-toggle', 'color'), colour('.nav-group-toggle:hover', 'background')],
    ['tagline', colour('.brand-note', 'color'), surface],
    ['workspace name', colour('.workspace strong', 'color'), card],
    ['workspace note', colour('.workspace small', 'color'), card],
    ['access line', colour('.readonly-indicator', 'color'), surface],
    ['rail switch', colour('.sidebar-toggle', 'color'), surface],
  ];
  for (const [theme, tokens] of [
    ['light', lightTokens],
    ['dark', darkTokens],
  ]) {
    for (const [name, ink, ground] of pairs) {
      const ratio = contrast(resolveToken(tokens, ink), resolveToken(tokens, ground));
      assert.ok(ratio >= 4.5, theme + ' ' + name + ' ' + ink + ' on ' + ground + ': ' + ratio.toFixed(2));
    }
    // The page's own ring (--focus) on the three surfaces a focused control sits on.
    const ring = resolveToken(tokens, 'var(--focus)');
    for (const ground of [surface, hover, selected]) {
      const ratio = contrast(ring, resolveToken(tokens, ground));
      assert.ok(ratio >= 3, theme + ' focus ring on ' + ground + ': ' + ratio.toFixed(2));
    }
  }
});
