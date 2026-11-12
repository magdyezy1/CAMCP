// WEB-06: page identity lived in six label maps and eight route lists. The palette filtered 19 fixed tuples, so 9 of
// the 18 navigation labels found nothing in English ("Reporting" even opened the wrong page) and 7 missed in Arabic;
// titles, breadcrumbs and headings named 11 of 18 pages differently from the navigation; and a test account saw empty
// groups, palette entries and a connectors link that only replaced the URL with /dashboard, without a word. These tests
// run the shipped scripts against the shipped navigation and Arabic catalog.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';
import {
  checkRoutes,
  loadRouteGlyphs,
  loadRouteGroups,
  loadRouteRegistry,
  pageAssetPaths,
  routeProblems,
  servedPages,
} from '../tools/check-routes.mjs';

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
  index = fs.readFileSync('web/index.html', 'utf8');

// V2-WEB-03: the sidebar's links are built from the registry in the browser (web/identity.js), so the tests read the
// markup the shell builds: the real builder, run against the real registry. A group of several pages is a disclosure.
const decode = value =>
  value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
function navigationMarkup() {
  const context = createContext({
      Intl,
      Map,
      Set,
      document: {addEventListener() {}},
      catalog,
      session: {authenticated: true},
    }),
    run = source => new Script(source).runInContext(context),
    identity = fs.readFileSync('web/identity.js', 'utf8');
  run(fs.readFileSync('web/localization.js', 'utf8'));
  run(fs.readFileSync('web/routes.js', 'utf8'));
  // The glyphs and the navigation builder: everything before the first helper that touches the page.
  run(identity.slice(0, identity.indexOf('/** A public file')));
  return String(run('shellNavigationMarkup()'));
}
/** The navigation links in order, with the disclosure group each one sits in (null for a plain link). */
function parseNavigation(markup) {
  const links = [];
  let group = null;
  for (const m of markup.matchAll(
    /data-group="([^"]*)"|<\/div><\/div>|<a href="([^"]*)" data-route="([^"]*)"[^>]*>[\s\S]*?<span class="nav-text" data-ui-text="([^"]*)">([^<]*)<\/span><\/a>/g,
  )) {
    if (m[1] !== undefined) group = decode(m[1]);
    else if (m[0] === '</div></div>') group = null;
    else links.push({href: m[2], route: m[3], label: decode(m[4]), text: decode(m[5]), group});
  }
  return links;
}
const links = parseNavigation(navigationMarkup());

function shell(locale = 'en', session = {authenticated: true}) {
  const context = createContext({Intl, Map, Set, document: {addEventListener() {}}, catalog, session});
  const run = source => new Script(source).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  run(fs.readFileSync('web/routes.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  return {run, context};
}

// V2-WEB-03: the same 18 destinations, listed group by group (Home, Reports, Creatives, Campaigns, Connections,
// Operations, Settings) instead of the earlier order, which put every hub before its tools.
test('the navigation has the 18 destinations the review measured', () => {
  assert.equal(links.length, 18);
  assert.deepEqual(
    links.map(link => link.label),
    [
      'Home',
      'Reporting',
      'Report builder',
      'Schedules',
      'Evidence & analysis',
      'Creative',
      'Campaigns',
      'Live portfolio',
      'Commerce',
      'Connections',
      'Measurement',
      'AI connectors',
      'Capabilities',
      'Operations',
      'Monitoring inbox',
      'Audit activity',
      'Workspace settings',
      'Clients & templates',
    ],
  );
  // Home and Creative stand alone; every other group opens as a disclosure named for the group.
  assert.deepEqual(
    links.filter(link => link.group === null).map(link => link.label),
    ['Home', 'Creative'],
  );
  assert.deepEqual(
    [...new Set(links.filter(link => link.group !== null).map(link => link.group))],
    ['Reports', 'Campaigns', 'Connections', 'Operations', 'Settings'],
  );
});

test('every navigation label opens its own page first in the command palette, in English and Arabic', () => {
  for (const locale of ['en', 'ar']) {
    const page = shell(locale);
    for (const link of links) {
      page.context.query = page.run('uiText(' + JSON.stringify(link.label) + ')');
      if (locale === 'ar') assert.match(page.context.query, /[؀-ۿ]/, link.label + ' is translated');
      const first = page.run('routeMatches(query, text => uiText(text))[0]?.path');
      assert.equal(first, link.href, locale + ': "' + page.context.query + '" opens ' + first);
    }
  }
});

test('former page names, partial names and descriptions still find their page', () => {
  const page = shell('en');
  for (const [query, path] of [
    ['Media library', '/media'],
    ['media', '/media'],
    ['MCP connectors', '/connectors'],
    ['Reporting overview', '/reporting-overview'],
    ['Client profiles', '/profiles'],
    ['Report library', '/report-library'],
    ['Live account portfolio', '/portfolio'],
    ['Settings', '/settings'],
    ['Activity', '/activity'],
    ['Overview', '/dashboard'],
    ['creat', '/media'],
    ['tokens', '/connectors'],
  ]) {
    page.context.query = query;
    assert.equal(page.run('routeMatches(query, text => uiText(text))[0]?.path'), path, query);
  }
  page.context.query = 'no such page';
  assert.equal(page.run('routeMatches(query).length'), 0);
});

test('the palette shell renders the registry: names, descriptions and the best match first', () => {
  const nodes = new Map(),
    node = id => {
      if (!nodes.has(id)) nodes.set(id, {value: '', innerHTML: ''});
      return nodes.get(id);
    };
  const page = shell('ar');
  page.context.$ = node;
  page.context.esc = value =>
    String(value ?? '').replace(
      /[&<>"']/g,
      c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c],
    );
  const identity = fs.readFileSync('web/identity.js', 'utf8');
  page.run(identity.slice(identity.indexOf('function commandResults('), identity.indexOf('function openCommand(')));
  node('#command-query').value = catalog['Creative'];
  page.run('commandResults()');
  const html = node('#command-results').innerHTML;
  assert.match(html, /^<button data-command-go="\/media">/);
  assert.ok(html.includes(catalog['Creative']) && html.includes(catalog['Drive imports, formats, and reuse']));
  assert.doesNotMatch(html, /↗/, 'Internal pages carry no external-link glyph');
});

test('the registry, navigation, page assets and server shell pages agree', () => {
  assert.deepEqual(checkRoutes(), []);
  const registry = loadRouteRegistry();
  for (const entry of registry.filter(entry => entry.nav)) {
    // The title and breadcrumb come from this label; the navigation link shows the same name.
    assert.equal(links.find(link => link.href === entry.path)?.label, entry.label, entry.path);
    assert.ok(entry.palette, entry.path + ' is findable');
  }
  // Every registered page is served by the server and client-navigable (clientNavigation reads the registry): the shell
  // pages by server/page-routes.ts, the members-only Help page by server/help-routes.ts (DOC-03).
  const served = servedPages();
  assert.deepEqual([...served].sort(), Array.from(registry, entry => entry.path).sort());
  assert.equal(served.at(-1), '/help');
});

test('drift between the registry and its consumers fails check-web', () => {
  const copy = () => JSON.parse(JSON.stringify(loadRouteRegistry())),
    base = {
      registry: copy(),
      index,
      server: servedPages(),
      assets: pageAssetPaths(),
      groups: loadRouteGroups(),
      glyphs: loadRouteGlyphs(),
    };
  assert.deepEqual(routeProblems(base), []);
  // The navigation is built from the registry, so index.html keeps only its hook: a hand-written link is drift.
  const handWritten = base.index.replace(
    '<nav aria-label="Main navigation" data-ui-label="Main navigation">',
    '<nav aria-label="Main navigation" data-ui-label="Main navigation"><a href="/media" data-route="media">Media</a>',
  );
  assert.notEqual(handWritten, base.index);
  assert.match(routeProblems({...base, index: handWritten}).join('\n'), /main navigation holds links/);
  assert.match(
    routeProblems({...base, index: base.index.replace('data-ui-label="Main navigation"', 'data-ui-label="Menu"')}).join(
      '\n',
    ),
    /navigation hook is missing/,
  );
  // The registry's own rules: a group, a glyph, a subtitle, a hub and a parent for every page of the navigation.
  const changed = edit => {
    const registry = copy();
    edit(registry);
    return routeProblems({...base, registry}).join('\n');
  };
  assert.match(
    changed(registry => (registry.find(entry => entry.path === '/media').group = 'Media')),
    /\/media is in "Media", not one of the navigation groups/,
  );
  assert.match(
    changed(registry => (registry.find(entry => entry.path === '/commerce').icon = 'portfolio')),
    /more than one link has the icon portfolio/,
  );
  assert.match(
    changed(registry => (registry.find(entry => entry.path === '/commerce').icon = 'no-such-glyph')),
    /\/commerce needs an icon that web\/identity.js draws/,
  );
  assert.match(
    changed(registry => delete registry.find(entry => entry.path === '/schedules').subtitle),
    /\/schedules has no subtitle/,
  );
  assert.match(
    changed(registry => (registry.find(entry => entry.path === '/portfolio').parent = '/commerce')),
    /\/portfolio should name its hub \/campaigns as its parent/,
  );
  assert.match(
    changed(registry => (registry.find(entry => entry.path === '/campaigns').parent = '/dashboard')),
    /\/campaigns is the hub of Campaigns and has no parent/,
  );
  assert.match(
    changed(registry => (registry.find(entry => entry.path === '/account').icon = 'help')),
    /more than one link has the icon help/,
  );
  assert.match(
    routeProblems({...base, glyphs: {...base.glyphs, account: base.glyphs.help}}).join('\n'),
    /two icon names draw the same glyph/,
  );
  assert.match(
    changed(registry =>
      registry.push({path: '/orphan', label: 'Orphan', parent: '/nowhere', subtitle: 'An orphan page.'}),
    ),
    /\/orphan names an unregistered parent \/nowhere/,
  );
  assert.match(
    routeProblems({...base, server: base.server.filter(path => path !== '/schedules')}).join('\n'),
    /does not serve registered page \/schedules/,
  );
  assert.match(
    routeProblems({...base, server: [...base.server, '/new-page']}).join('\n'),
    /serves \/new-page, which web\/routes\.js does not register/,
  );
  assert.match(routeProblems({...base, assets: [...base.assets, '/unregistered']}).join('\n'), /unregistered page/);
});

// DOC-03 (owner instruction of 2026-10-24): the members-only Help page has no sidebar link; the palette finds it by its
// name, its former names and its description in both languages, a sign-in returns to it, and a test account's scope
// leaves it out, as the server does (it sends a test account no guide).
test('the palette finds Help in English and Arabic; sign-in returns to it; a test account has no Help page', () => {
  const entry = loadRouteRegistry().find(e => e.path === '/help');
  assert.equal(entry.label, 'Help');
  assert.ok(entry.palette && !entry.nav && !entry.public && !entry.testAccount);
  assert.deepEqual(Array.from(entry.assets), ['help.js']);
  assert.equal(
    links.find(link => link.href === '/help'),
    undefined,
    'no sidebar link',
  );
  for (const locale of ['en', 'ar']) {
    const page = shell(locale);
    for (const query of ['Help', 'Owner guide', 'Documentation', 'guide'].map(q =>
      locale === 'ar' ? (catalog[q] ?? q) : q,
    )) {
      page.context.query = query;
      assert.equal(page.run('routeMatches(query, text => uiText(text))[0]?.path'), '/help', locale + ': ' + query);
    }
  }
  const member = shell('en');
  assert.equal(member.run("routeReturnable('/help')"), true);
  assert.equal(member.run("routeReturnable('/help#help-en-team')"), true);
  const reviewer = shell('en', {authenticated: true, testAccount: true});
  assert.equal(reviewer.run("routeAvailable('/help')"), false);
  reviewer.context.query = 'Help';
  assert.ok(!Array.from(reviewer.run('routeMatches(query).map(e => e.path)')).includes('/help'));
});

test('sign-in returns only to a registered workspace page', () => {
  const page = shell('en');
  for (const path of [
    '/dashboard',
    '/media?x=1',
    '/campaigns#campaign-create',
    '/report-pack?id=1',
    '/oauth/consent?request=a',
  ])
    assert.equal(page.run('routeReturnable(' + JSON.stringify(path) + ')'), true, path);
  for (const path of [
    '/',
    '/login',
    '/oauth/result',
    '/auth/complete',
    '//evil.invalid/dashboard',
    'https://evil.invalid/dashboard',
    '/dashboardx',
    '/unknown',
    null,
    '/dashboard?' + 'x'.repeat(10000),
  ])
    assert.equal(page.run('routeReturnable(' + JSON.stringify(path) + ')'), false, String(path).slice(0, 40));
});

// A DOM with the shipped navigation's links and groups, enough for account-scope.js. (The sidebar's promotional note, whose
// connectors link this once held, is gone with the neutral frame; the connectors page is a navigation link like the rest.)
function scopedShell(session, pathname) {
  const groupNodes = [],
    navLinks = [];
  for (const link of links) {
    const node = {dataset: {route: link.route}, hidden: false};
    navLinks.push(node);
    if (!link.group) continue;
    let group = groupNodes.find(g => g.label === link.group);
    if (!group) {
      const members = [];
      group = {label: link.group, hidden: false, members, querySelectorAll: () => members};
      groupNodes.push(group);
    }
    group.members.push(node);
  }
  const inserted = [],
    heading = {insertAdjacentHTML: (_where, html) => inserted.push(html)};
  const location = {pathname, search: '', hash: ''};
  const context = createContext({
    Intl,
    Map,
    Set,
    catalog,
    session,
    location,
    history: {replaceState: (_a, _b, url) => (location.pathname = url)},
    content: {querySelector: selector => (selector === '.page-heading' ? heading : null), insertAdjacentHTML() {}},
    esc: value => String(value),
    document: {
      addEventListener() {},
      body: {classList: {toggle() {}}},
      querySelectorAll: selector =>
        selector === '[data-route]' ? navLinks : selector === '.sidebar .nav-group' ? groupNodes : [],
    },
  });
  const run = source => new Script(source).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  run(fs.readFileSync('web/routes.js', 'utf8'));
  // The shell's real render() with its hooks (WEB-07); the page itself is recorded instead of rendered.
  const app = fs.readFileSync('web/app.js', 'utf8');
  run(app.slice(app.indexOf('async function render() {'), app.indexOf('async function renderCurrentPage()')));
  run('var renders = []; var renderCurrentPage = async function () { renders.push(location.pathname); };');
  run(fs.readFileSync('web/account-scope.js', 'utf8'));
  return {run, context, navLinks, groupNodes, inserted, location};
}

test('a reviewer sees every product navigation group and can open portfolio and AI connectors', async () => {
  const f = scopedShell({authenticated: true, testAccount: true}, '/portfolio');
  await f.run('render()');
  assert.ok(f.navLinks.every(link => !link.hidden));
  assert.ok(f.groupNodes.every(group => !group.hidden));
  assert.equal(f.location.pathname, '/portfolio');
  assert.deepEqual(Array.from(f.run('renders')), ['/portfolio']);
  assert.equal(f.inserted.length, 0);
  const offered = Array.from(f.run("routeMatches('').map(entry => entry.path)"));
  for (const path of ['/campaigns', '/portfolio', '/commerce', '/media', '/reports', '/connectors', '/operations'])
    assert.ok(offered.includes(path), path);
  assert.ok(!offered.includes('/help'), 'owner documentation remains outside the reviewer scope');
});

test('a test account is redirected from a path the registry does not list (regression: unknown paths were allowed)', async () => {
  const f = scopedShell({authenticated: true, testAccount: true}, '/not-a-page');
  assert.equal(f.run("routeAvailable('/not-a-page')"), false);
  assert.equal(f.run("routeAvailable('/dashboard')"), true);
  await f.run('render()');
  assert.equal(f.location.pathname, '/dashboard');
  // Members keep their own handling of an unknown path.
  const member = scopedShell({authenticated: true, workspaceRole: 'viewer'}, '/not-a-page');
  assert.equal(member.run("routeAvailable('/not-a-page')"), true);
});

test('the scoped redirect notice reads in Arabic', async () => {
  const f = scopedShell({authenticated: true, testAccount: true}, '/help');
  f.run("uiLocale='ar'; uiMessages=new Map(Object.entries(catalog))");
  await f.run('render()');
  assert.equal(f.inserted.length, 1);
  assert.ok(
    f.inserted[0].includes(catalog['This test workspace does not include {page}.'].replace('{page}', catalog['Help'])),
  );
});

test('members, owners and visitors keep the whole navigation and no redirect', async () => {
  for (const session of [{authenticated: true, workspaceRole: 'viewer'}, {authenticated: false}]) {
    const f = scopedShell(session, '/portfolio');
    await f.run('render()');
    assert.ok(f.navLinks.every(link => !link.hidden));
    assert.ok(f.groupNodes.every(group => !group.hidden));
    assert.equal(f.location.pathname, '/portfolio');
    assert.equal(f.inserted.length, 0);
  }
});
