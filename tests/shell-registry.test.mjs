// V2-WEB-03 decision 1: one registry. web/routes.js keeps driving the navigation, the server's shell routes and the asset
// order, and now declares seven groups. Each route has its group, a unique icon, a subtitle and a parent; every path stays
// as it was, so bookmarks keep working, and the pages the captures link to stay where they are. These tests read the
// shipped registry, the shipped glyphs and the shipped Arabic catalog.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';
import {loadRouteGroups, loadRouteGlyphs, loadRouteRegistry} from '../tools/check-routes.mjs';
import {inspectLocaleSource} from '../tools/check-locales.mjs';

// The registry is evaluated in its own realm; a JSON copy compares with plain literals.
const registry = JSON.parse(JSON.stringify(loadRouteRegistry())),
  groups = loadRouteGroups(),
  glyphs = loadRouteGlyphs(),
  catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
  navigation = registry.filter(entry => entry.nav),
  hasArabic = text => /[؀-ۿ]/.test(text ?? '');

function shell(session = {authenticated: true}) {
  const context = createContext({Intl, Map, Set, document: {addEventListener() {}}, catalog, session}),
    run = source => new Script(source).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  run(fs.readFileSync('web/routes.js', 'utf8'));
  return {run, context};
}

test('the navigation has seven groups, in the order the shell shows them', () => {
  assert.deepEqual(Array.from(groups), [
    'Home',
    'Reports',
    'Creatives',
    'Campaigns',
    'Connections',
    'Operations',
    'Settings',
  ]);
  // Pages are listed group by group, so the registry's order is the sidebar's order.
  const order = [...new Set(navigation.map(entry => entry.group))];
  assert.deepEqual(order, Array.from(groups));
  for (const entry of navigation) assert.ok(groups.includes(entry.group), entry.path + ' is in no group');
  // The same page set as before the shell was reorganised: 18 destinations, none added, none lost.
  assert.deepEqual(navigation.map(entry => entry.path).sort(), [
    '/activity',
    '/campaigns',
    '/capabilities',
    '/commerce',
    '/connections',
    '/connectors',
    '/dashboard',
    '/measurement',
    '/media',
    '/monitors',
    '/operations',
    '/portfolio',
    '/profiles',
    '/report-library',
    '/reporting-overview',
    '/reports',
    '/schedules',
    '/settings',
  ]);
});

test('a group holds its pages from its hub: the first page is the hub, the others name it as their parent', () => {
  for (const group of groups) {
    const members = navigation.filter(entry => entry.group === group),
      hub = members[0];
    assert.ok(hub, group + ' has no page');
    assert.equal(hub.parent, undefined, hub.path + ' is the hub of ' + group + ' and has no parent');
    for (const entry of members.slice(1)) assert.equal(entry.parent, hub.path, entry.path + ' belongs to ' + hub.path);
  }
  // Single-page groups are Home and Creatives; every other group holds more than one page.
  assert.deepEqual(
    Array.from(groups).filter(group => navigation.filter(entry => entry.group === group).length === 1),
    ['Home', 'Creatives'],
  );
  assert.deepEqual(
    navigation.filter(entry => entry.group === 'Reports').map(entry => entry.path),
    ['/report-library', '/reporting-overview', '/schedules', '/reports'],
  );
});

test('every registered page that is not public names a parent that exists, with no loop', () => {
  const paths = new Set(registry.map(entry => entry.path));
  // The state page is in no group and has no parent: it is a members-only specimen, not part of the product's pages
  // (tests/design-system-page.test.mjs); a failure there still leads back to Home.
  for (const entry of registry.filter(entry => !entry.public && entry.path !== '/dashboard')) {
    if (entry.path === '/auth/complete' || entry.path === '/design-system') continue;
    // The hub of a group is the one page without a parent; every page of the workspace leads back to Home.
    if (entry.parent === undefined) {
      assert.ok(
        navigation.some(page => page.path === entry.path),
        entry.path + ' has no parent and is not a hub',
      );
      continue;
    }
    assert.ok(paths.has(entry.parent), entry.path + ' names an unregistered parent ' + entry.parent);
    assert.notEqual(entry.parent, entry.path);
    const seen = new Set([entry.path]);
    for (let at = entry; at?.parent; at = registry.find(page => page.path === at.parent)) {
      assert.ok(!seen.has(at.parent), entry.path + ' has a parent loop');
      seen.add(at.parent);
    }
  }
  // The pages that sit in the user menu and footer, outside the seven groups.
  for (const path of ['/account', '/help']) {
    const entry = registry.find(page => page.path === path);
    assert.equal(entry.menu, 'user', path);
    assert.equal(entry.group, undefined, path + ' is in the user menu, not in a group');
    assert.equal(entry.parent, '/dashboard', path);
  }
  assert.equal(registry.find(entry => entry.path === '/report-pack').parent, '/report-library');
  assert.equal(registry.find(entry => entry.path === '/report-pack').group, 'Reports');
  for (const path of ['/oauth/consent', '/oauth/result'])
    assert.equal(registry.find(entry => entry.path === path).parent, '/connections', path);
});

test('every link of the shell has its own icon, and no two icons draw the same glyph', () => {
  const linked = registry.filter(entry => entry.nav || entry.menu === 'user'),
    icons = linked.map(entry => entry.icon);
  assert.equal(linked.length, 20, 'eighteen navigation pages, the account and Help');
  for (const entry of linked) {
    assert.equal(typeof entry.icon, 'string', entry.path + ' has no icon');
    assert.ok(
      Object.hasOwn(glyphs, entry.icon),
      entry.path + ' names a glyph ' + entry.icon + ' that identity.js lacks',
    );
  }
  assert.equal(new Set(icons).size, icons.length, 'two links share an icon name: ' + icons.join(', '));
  const drawn = icons.map(icon => glyphs[icon]);
  assert.equal(new Set(drawn).size, drawn.length, 'two icon names draw the same glyph');
  // The icon is for the shell's links; a page that is in no navigation or menu needs none.
  for (const entry of registry.filter(entry => !entry.nav && entry.menu !== 'user'))
    assert.equal(entry.icon, undefined, entry.path + ' is in no navigation and needs no icon');
});

test('every page of the workspace has a subtitle of its own, from the registry, with its Arabic', () => {
  const pages = registry.filter(entry => !entry.public && entry.path !== '/auth/complete'),
    subtitles = pages.map(entry => entry.subtitle);
  for (const entry of pages) {
    assert.equal(typeof entry.subtitle, 'string', entry.path + ' has no subtitle');
    assert.match(entry.subtitle, /^[A-Z].{18,}\.$/, entry.path + ': a sentence of its own');
    assert.ok(hasArabic(catalog[entry.subtitle]), entry.path + ' has no Arabic subtitle');
  }
  assert.equal(new Set(subtitles).size, subtitles.length, 'two pages share a subtitle');
  // The generic line that every page without a heading of its own used to say (design review S8).
  assert.ok(!subtitles.includes('Plan, review and verify work across your selected accounts.'));
  for (const group of groups) assert.ok(hasArabic(catalog[group]), group + ' has no Arabic name');
});

// Package closing-small (web-shell report, "Found and not fixed" 6): the group "Reports" and the hub link "Reporting" were both
// "التقارير", so two names the English tells apart read as one in the Arabic sidebar. The sidebar draws a group's name where the
// group holds several pages (a group of one page is just its link), each link's label, and the footer's Account and Help.
test('no two names the sidebar draws, which the English tells apart, read alike in Arabic', () => {
  const several = groups.filter(group => navigation.filter(entry => entry.group === group).length > 1),
    drawn = new Set([
      ...several,
      ...navigation.map(entry => entry.label),
      ...registry.filter(entry => entry.menu === 'user').map(entry => entry.label),
    ]),
    readAs = new Map();
  for (const name of drawn) {
    assert.ok(hasArabic(catalog[name]), name + ' has no Arabic');
    readAs.set(catalog[name], [...(readAs.get(catalog[name]) ?? []), name]);
  }
  assert.deepEqual(
    [...readAs.values()].filter(names => names.length > 1),
    [],
    'two names that read alike',
  );
  // The hub is still about reports, in words of its own.
  assert.match(catalog.Reporting, /التقارير/);
  assert.notEqual(catalog.Reporting, catalog.Reports);
});

test('a page heading takes its subtitle from the registry, never from a sentence written beside it', () => {
  // Design review S8: pages without a heading of their own all said "Plan, review and verify work across your selected
  // accounts." The sentence under a page's heading is the registry's, so the loading frame and the page agree.
  const labels = new Set(registry.filter(entry => !entry.public).map(entry => entry.label)),
    offenders = [];
  for (const file of fs.readdirSync('web').filter(name => name.endsWith('.js'))) {
    const text = fs.readFileSync('web/' + file, 'utf8');
    assert.ok(!text.includes('Plan, review and verify work across your selected accounts.'), file);
    for (const match of text.matchAll(
      /\bheader\(\s*uiText\('([^']+)'\)\s*,\s*(?!\s|(?:esc\()?uiText\(routeSubtitle\()/g,
    ))
      if (labels.has(match[1])) offenders.push(file + ': ' + match[1]);
  }
  assert.deepEqual(offenders, []);
});

test('the locale check requires Arabic for the registry’s subtitles and group names, as for its labels', () => {
  const {required} = inspectLocaleSource(
    "const routeGroups = Object.freeze(['A group']); const routeRegistry = [{path: '/x', label: 'A label', subtitle: 'A subtitle.', icon: 'glyph-name', menu: 'user'}];",
    'routes.js',
  );
  assert.deepEqual([...required].sort(), ['A group', 'A label', 'A subtitle.']);
  // And the shipped registry's own strings are all in the catalog (check-web fails otherwise).
  const shipped = inspectLocaleSource(fs.readFileSync('web/routes.js', 'utf8'), 'routes.js').required;
  for (const entry of registry.filter(entry => entry.subtitle)) assert.ok(shipped.has(entry.subtitle), entry.path);
  for (const group of groups) assert.ok(shipped.has(group), group);
});

test('the pages the evidence captures link to are where they were', () => {
  // src/decision-reporting.ts, src/allocation-outcome.ts and src/creative-performance.ts hand out /reports?id=…
  for (const file of ['decision-reporting', 'allocation-outcome', 'creative-performance'])
    assert.match(fs.readFileSync('src/' + file + '.ts', 'utf8'), /'\/reports\?id=' \+ encodeURIComponent/, file);
  const evidence = registry.find(entry => entry.path === '/reports');
  assert.equal(evidence.label, 'Evidence & analysis');
  assert.equal(evidence.group, 'Reports');
  assert.equal(evidence.nav, true);
  // Every path of the old registry is still registered with the same section key.
  for (const path of [
    '/',
    '/login',
    '/signup',
    '/forgot-password',
    '/reset-password',
    '/verify-email',
    '/auth/complete',
    '/dashboard',
    '/campaigns',
    '/portfolio',
    '/commerce',
    '/media',
    '/report-library',
    '/reporting-overview',
    '/reports',
    '/schedules',
    '/profiles',
    '/connections',
    '/measurement',
    '/connectors',
    '/capabilities',
    '/operations',
    '/monitors',
    '/activity',
    '/settings',
    '/account',
    '/help',
    '/report-pack',
    '/design-system',
    '/oauth/consent',
    '/oauth/result',
  ])
    assert.ok(
      registry.some(entry => entry.path === path),
      path + ' left the registry',
    );
});

test('a navigation page highlights its own link and a child page its parent', () => {
  const page = shell();
  for (const [path, key] of [
    ['/portfolio', 'portfolio'],
    ['/schedules', 'schedules'],
    ['/activity', 'activity'],
    ['/dashboard', 'dashboard'],
    ['/report-pack', 'report-library'],
    ['/oauth/result', 'connections'],
    ['/oauth/consent', 'connections'],
    ['/account', 'account'],
    ['/design-system', 'design-system'],
    ['/login', ''],
    ['/unknown', ''],
  ])
    assert.equal(page.run('routeNavigationKey(' + JSON.stringify(path) + ')'), key, path);
});

test('the navigation as data: groups in order with their pages, for the shell to draw', () => {
  const page = shell(),
    groupsNow = JSON.parse(page.run('JSON.stringify(routeNavigation())'));
  assert.deepEqual(
    groupsNow.map(group => group.name),
    Array.from(groups),
  );
  assert.deepEqual(
    groupsNow.find(group => group.name === 'Campaigns').entries.map(entry => entry.path),
    ['/campaigns', '/portfolio', '/commerce'],
  );
  assert.equal(groupsNow.find(group => group.name === 'Campaigns').hub, '/campaigns');
  assert.equal(groupsNow.find(group => group.name === 'Home').entries.length, 1);
  assert.equal(groupsNow.flatMap(group => group.entries).length, 18);
  // The route a failed page leads back to: its parent, or Home for a hub; nothing for Home itself.
  for (const [path, back] of [
    ['/portfolio', '/campaigns'],
    ['/report-pack', '/report-library'],
    ['/oauth/result', '/connections'],
    ['/campaigns', '/dashboard'],
    ['/account', '/dashboard'],
    ['/dashboard', null],
    ['/login', null],
  ])
    assert.equal(page.run('routeBack(' + JSON.stringify(path) + ')?.path ?? null'), back, path);
});
