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
  loadRouteRegistry,
  navigationLinks,
  pageAssetPaths,
  routeProblems,
  servedPages,
} from '../tools/check-routes.mjs';

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
  index = fs.readFileSync('web/index.html', 'utf8'),
  links = navigationLinks(index);

function shell(locale = 'en', session = {authenticated: true}) {
  const context = createContext({Intl, Map, Set, document: {addEventListener() {}}, catalog, session});
  const run = source => new Script(source).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  run(fs.readFileSync('web/routes.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  return {run, context};
}

test('the navigation has the 18 destinations the review measured', () => {
  assert.equal(links.length, 18);
  assert.deepEqual(
    links.map(link => link.label),
    [
      'Home',
      'Campaigns',
      'Live portfolio',
      'Commerce',
      'Creative',
      'Reporting',
      'Report builder',
      'Evidence & analysis',
      'Schedules',
      'Clients & templates',
      'Connections',
      'Measurement',
      'AI connectors',
      'Capabilities',
      'Operations',
      'Monitoring inbox',
      'Audit activity',
      'Workspace settings',
    ],
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

test('drift between the registry and its static consumers fails check-web', () => {
  const base = {
    registry: loadRouteRegistry(),
    index,
    server: servedPages(),
    assets: pageAssetPaths(),
  };
  const renamed = base.index.replace(
    '<span data-ui-text="Creative">Creative</span>',
    '<span data-ui-text="Media library">Media library</span>',
  );
  assert.notEqual(renamed, base.index);
  assert.match(routeProblems({...base, index: renamed}).join('\n'), /\/media is labelled "Media library"/);
  assert.match(
    routeProblems({...base, server: base.server.filter(path => path !== '/schedules')}).join('\n'),
    /does not serve registered page \/schedules/,
  );
  assert.match(
    routeProblems({...base, server: [...base.server, '/new-page']}).join('\n'),
    /serves \/new-page, which web\/routes\.js does not register/,
  );
  assert.match(routeProblems({...base, assets: [...base.assets, '/unregistered']}).join('\n'), /unregistered page/);
  const moved = base.index.replace(
    '<a href="/commerce" data-route="commerce" data-icon="campaign"><span>◈</span><span data-ui-text="Commerce">Commerce</span></a></details>',
    '</details><a href="/commerce" data-route="commerce" data-icon="campaign"><span>◈</span><span data-ui-text="Commerce">Commerce</span></a>',
  );
  assert.notEqual(moved, base.index);
  assert.match(routeProblems({...base, index: moved}).join('\n'), /\/commerce sits in group "null"/);
  const missing = base.index.replace(/<a href="\/schedules"[\s\S]*?<\/a>/, '');
  assert.match(routeProblems({...base, index: missing}).join('\n'), /\/schedules has no navigation link/);
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

// A DOM with the shipped navigation's links, groups and the sidebar note, enough for account-scope.js.
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
  const note = {hidden: false, getAttribute: () => '/connectors'},
    inserted = [],
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
        selector === '[data-route]'
          ? navLinks
          : selector === '.sidebar-note a[href^="/"]'
            ? [note]
            : selector === '.sidebar details.nav-more'
              ? groupNodes
              : [],
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
  return {run, context, navLinks, groupNodes, note, inserted, location};
}

test('a reviewer sees every product navigation group and can open portfolio and AI connectors', async () => {
  const f = scopedShell({authenticated: true, testAccount: true}, '/portfolio');
  await f.run('render()');
  assert.ok(f.navLinks.every(link => !link.hidden));
  assert.ok(f.groupNodes.every(group => !group.hidden));
  assert.equal(f.note.hidden, false);
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
    assert.equal(f.note.hidden, false);
    assert.equal(f.location.pathname, '/portfolio');
    assert.equal(f.inserted.length, 0);
  }
});
