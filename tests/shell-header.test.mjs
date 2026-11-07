// V2-WEB-03 decision 3: the header. One row at 320px: the logo at the start edge (the right in Arabic), the client
// switcher, search and the menu; language and appearance (and signing in or out) move into the drawer, which opens from
// the end edge beside the menu that opens it. The hooks the rendered cases and the keyboard model rely on stay. This file
// reads the shipped markup and stylesheets; the rendered geometry is the runner's `shell` kind.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  value = (selector, property, atRule = '') =>
    declarations
      .filter(d => d.selector === selector && d.property === property && d.atRules.join(' ') === atRule)
      .at(-1)?.value;
const phone = '@media (max-width: 850px)';
const header = /<header class="topbar">([\s\S]*?)<\/header>/.exec(index)?.[1];

test('the header holds the logo first and the menu last, and keeps the hooks the cases and the keyboard use', () => {
  assert.ok(header, 'the header is there');
  const leading = /<div class="top-leading">([\s\S]*?)<\/div><div class="top-actions">/.exec(header)?.[1] ?? '',
    actions = /<div class="top-actions">([\s\S]*)$/.exec(header)?.[1] ?? '';
  // The logo is the first thing at the start edge: the lockup in both variants and the icon alone, as in the sidebar.
  assert.match(leading, /^<a class="brand top-brand" href="\/"><span class="brand-lockup"><img class="logo-ink"/);
  assert.match(leading, /<img class="logo-mark" src="\/assets\/mark\.svg" width="32" height="32" alt="AMCP"><\/a>/);
  // The menu is the last control at the end edge, where the drawer it opens comes from.
  assert.match(actions, /<button id="menu-toggle"[^>]*aria-controls="workspace-sidebar"[^>]*>[^<]*<\/button><\/div>$/);
  // Search is between: icon alone on a phone, with its words and shortcut where there is room.
  assert.match(
    actions,
    /<button class="command-trigger" data-command-open aria-labelledby="command-trigger-label command-trigger-shortcut"/,
  );
  // The hooks (decision 3): .skip, #menu-toggle, .main-shell, .sidebar-close, #command-dialog and body.menu-open.
  assert.match(index, /<a class="skip" href="#main"/);
  assert.match(index, /<div class="main-shell">/);
  assert.match(index, /<button class="icon-button sidebar-close" data-menu-close/);
  assert.match(index, /<dialog id="command-dialog"/);
  assert.match(read('identity.js'), /document\.body\.classList\.(?:toggle|add|remove|contains)\('menu-open'/);
});

test('language, appearance and signing out are in the drawer, once, and the controls keep their names', () => {
  const drawer = /<div class="sidebar-prefs">([\s\S]*?)<\/div><div class="readonly-indicator">/.exec(index)?.[1];
  assert.ok(drawer, 'the drawer has its preferences');
  assert.match(drawer, /<select data-language-select aria-label="Language" data-ui-label="Language">/);
  assert.match(drawer, /<select data-theme-select aria-label="Appearance" data-ui-label="Appearance">/);
  assert.match(drawer, /<button type="button" class="button" data-shell-session="in" data-action="logout" hidden/);
  assert.match(drawer, /<button type="button" class="button primary" data-shell-session="out" data-action="login"/);
  // The wide header keeps its own copies (they are not shown on a phone); the drawer's are shown only on a phone.
  for (const hidden of [
    '.top-actions .language-control',
    '.top-actions .theme-control',
    '#login-button',
    '#logout-button',
    '#user-avatar',
  ])
    assert.equal(value(hidden, 'display', phone), 'none', hidden + ' leaves the phone header');
  assert.equal(value('.sidebar-prefs', 'display'), 'none');
  assert.equal(value('.sidebar-prefs', 'display', phone), 'grid');
  // In the drawer the labels are shown: two selects in a column need their words.
  assert.equal(value('.sidebar-prefs :is(.language-control, .theme-control) > span', 'display', phone), 'block');
  for (const key of ['Sign in', 'Sign out', 'Language', 'Appearance']) assert.match(catalog[key] ?? '', /[؀-ۿ]/, key);
});

test('the phone header is one row at every width down to 320px: a fixed height, no wrapping, nothing but four controls', () => {
  assert.equal(value('.topbar', 'height', phone), '64px');
  assert.equal(value('.topbar', 'padding', phone), '0 16px');
  // The two-row layout (a grid that wrapped the actions below 421px) is gone, and the actions never wrap.
  const wrapping = declarations.filter(
    d =>
      /\.topbar|\.top-actions|\.top-leading/.test(d.selector) &&
      /(^display$|^flex-wrap$)/.test(d.property) &&
      /grid|(^wrap)/.test(d.value),
  );
  assert.deepEqual(
    wrapping.map(d => d.selector + ' ' + d.property + ' ' + d.value + ' ' + d.atRules.join(' ')),
    [],
  );
  assert.equal(value('.top-actions', 'flex-wrap', phone), 'nowrap');
  // The client switcher takes the room that is left; it is the one control that may shrink.
  assert.equal(value('.top-actions > .working-client-control', 'flex', phone), '1 1 0');
  assert.equal(value('.top-actions > .working-client-control', 'min-width', phone), '0');
  // Targets are 44px: the menu and search are icon buttons.
  assert.equal(value('#menu-toggle', 'min-width', phone), '44px');
  assert.equal(value('#menu-toggle', 'min-height', phone), '44px');
  assert.equal(value('.command-trigger', 'min-width', phone), '44px');
  assert.equal(value('.command-trigger', 'min-height', phone), '44px');
  // The shortcut means nothing on a touch screen (design review S5): hidden below 851px.
  assert.equal(value('.command-trigger kbd', 'display', phone), 'none');
  // The scroll padding under the sticky bar is its height plus room, not the two-row bar's 140px.
  assert.equal(value('html:has(.topbar)', 'scroll-padding-top', '@media (max-width: 900px)'), '88px');
});

test('the logo is at the start edge: the lockup where the header has room, the icon alone where it has not', () => {
  // The header is a size container, so the choice follows the bar's own width, not the window's.
  assert.equal(value('.topbar', 'container', ''), 'topbar / inline-size');
  assert.equal(value('.top-brand', 'display', phone), 'flex');
  assert.equal(value('.top-brand', 'display'), 'none', 'the sidebar carries the brand where it is persistent');
  assert.equal(value('.top-brand .brand-lockup', 'display', phone), 'none');
  assert.equal(value('.top-brand .logo-mark', 'display', phone), 'block');
  const query = '@container topbar (min-width: 520px)';
  assert.equal(value('.top-brand .brand-lockup', 'display', phone + ' ' + query), 'flex');
  assert.equal(value('.top-brand .logo-mark', 'display', phone + ' ' + query), 'none');
  // The start edge in both directions comes from flex order, so no rule mirrors or moves the logo.
  assert.equal(value('.top-leading', 'display'), 'flex');
});

test('the drawer comes from the end edge, beside the menu that opens it, in both directions', () => {
  assert.equal(value('.sidebar', 'inset-inline', phone), 'auto 0');
  assert.equal(value('.sidebar', 'transform', phone), 'translateX(100%)');
  assert.equal(value("html[dir='rtl'] .sidebar", 'transform', phone), 'translateX(-100%)');
  assert.equal(value("html[dir='rtl'] .menu-open .sidebar", 'transform', phone), 'none');
  assert.equal(value('.menu-open .sidebar', 'transform', phone), 'none');
  // The drawer is one scrolling panel on a phone, so the preferences and the footer are reachable on a short screen.
  assert.equal(value('.sidebar', 'overflow-y', phone), 'auto');
  assert.equal(value('.sidebar > nav', 'overflow-y', phone), 'visible');
  // Its Tab trap covers every control in it, the selects included.
  assert.match(
    read('identity.js'),
    /querySelectorAll\('a\[href\],button:not\(\[disabled\]\),select:not\(\[disabled\]\),summary/,
  );
});
