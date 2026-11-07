import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Script, createContext} from 'node:vm';

// WEB-06: the website names, routes and serves every page from one registry (web/routes.js). These checks fail when a
// consumer that cannot read the registry at run time drifts from it: the lazily loaded page assets and the server's list
// of shell pages. V2-WEB-03: the sidebar is built from the registry in the browser (web/identity.js), so index.html holds
// only its hook, and the registry's own rules are checked here: the seven groups, a group, a glyph and a subtitle for
// every page of the navigation, the user menu's links with their glyphs, parents that exist.

/** The registry as the browser evaluates it. */
export function loadRouteRegistry(root = process.cwd()) {
  const context = createContext({});
  new Script(
    fs.readFileSync(path.join(root, 'web/routes.js'), 'utf8') + '\n;globalThis.__routes = routeRegistry;',
  ).runInContext(context);
  return context.__routes;
}
/** The navigation's groups in the order the shell shows them (V2-WEB-03), as the browser evaluates them. */
export function loadRouteGroups(root = process.cwd()) {
  const context = createContext({});
  new Script(
    fs.readFileSync(path.join(root, 'web/routes.js'), 'utf8') +
      "\n;globalThis.__groups = typeof routeGroups === 'undefined' ? [] : routeGroups;",
  ).runInContext(context);
  return [...context.__groups];
}
/** The glyphs web/identity.js draws, by name: {name: path data}. The registry's icons name entries of this object. */
export function loadRouteGlyphs(root = process.cwd()) {
  const source = fs.readFileSync(path.join(root, 'web/identity.js'), 'utf8'),
    literal = /^const glyphPaths = (\{[\s\S]*?^\});$/m.exec(source)?.[1];
  if (!literal) return {};
  const context = createContext({});
  new Script('globalThis.__glyphs = ' + literal).runInContext(context);
  return {...context.__glyphs};
}
/**
 * The navigation hook in index.html: the element the sidebar's links are built into. It has no links of its own, so the
 * navigation cannot drift from the registry; null when the hook is missing.
 */
export function navigationHook(index) {
  const match = /<nav aria-label="Main navigation" data-ui-label="Main navigation">([\s\S]*?)<\/nav>/.exec(index);
  return match ? match[1] : null;
}
/**
 * The website route module that answers the shell pages with index.html (ARC-04 stage D: createWebsite registers it
 * through its route registry, server/website.ts).
 */
export const serverShellSource = 'server/page-routes.ts';
/**
 * The shell pages the server answers with index.html, from the source of serverShellSource. The handler is one
 * expression that ends by sending index.html; it may first send a signed-in visitor of / to Home (P12, DOC-03).
 */
export function serverShellRoutes(source) {
  const list =
    /for \(const route of \[([\s\S]*?)\]\)\s*router\.get\(route, \(_?req, res\) =>[^;]*?res\.type\('html'\)\.send\(publicAssets\.html\('index\.html'\)\),?\s*\)/.exec(
      source,
    )?.[1];
  return list ? [...list.matchAll(/'([^']+)'/g)].map(m => m[1]) : null;
}
/**
 * The members-only Help page (DOC-03) is answered by its own route module, which adds the owner guide to the shell for
 * a signed-in member: its page, from the source of serverHelpSource.
 */
export const serverHelpSource = 'server/help-routes.ts';
export function serverHelpRoutes(source) {
  const path = /export const helpPath = '([^']+)'/.exec(source)?.[1];
  return path && source.includes('router.get(helpPath,') && source.includes("publicAssets.html('index.html')")
    ? [path]
    : null;
}
/** Every page the server answers with the shell: the shell list, then the Help page. */
export function servedPages(root = process.cwd()) {
  const shell = serverShellRoutes(fs.readFileSync(path.join(root, serverShellSource), 'utf8')),
    help = serverHelpRoutes(fs.readFileSync(path.join(root, serverHelpSource), 'utf8'));
  return shell && help ? [...shell, ...help] : null;
}
/** The loader's view of the registry: the files each page loads, and every file the loader may request, in order. */
export function pageAssetPlan(root = process.cwd()) {
  const context = createContext({});
  new Script(fs.readFileSync(path.join(root, 'web/routes.js'), 'utf8')).runInContext(context);
  new Script(
    fs.readFileSync(path.join(root, 'web/route-assets.js'), 'utf8') +
      '\n;globalThis.__assets = JSON.stringify({routes: pageAssetRoutes, order: pageAssetOrder, dependencies: pageAssetDependencies});',
  ).runInContext(context);
  return JSON.parse(context.__assets);
}
/**
 * The files the loader adds for each page that has any, in request order: {path: [file, ...]}. Empty for a tree without a
 * route loader (a fixture tree for a stylesheet check has none).
 */
export function routeAssetFiles(root = process.cwd()) {
  const routes = path.join(root, 'web/routes.js'),
    loader = path.join(root, 'web/route-assets.js');
  if (!fs.existsSync(routes) || !fs.existsSync(loader)) return {};
  const context = createContext({});
  new Script(fs.readFileSync(routes, 'utf8')).runInContext(context);
  new Script(
    fs.readFileSync(loader, 'utf8') +
      '\n;globalThis.__files = JSON.stringify(Object.fromEntries(Object.keys(pageAssetRoutes).map(route => [route, pageAssetsFor(route)])));',
  ).runInContext(context);
  return JSON.parse(context.__files);
}
/** The page paths route-assets.js loads feature scripts for. */
export function pageAssetPaths(root = process.cwd()) {
  return Object.keys(pageAssetPlan(root).routes);
}
/** WEB-07: a page's assets are authored scripts the loader knows, and each loader file ships. */
export function pageAssetProblems(plan, exists = () => true) {
  const problems = [],
    order = new Set(plan.order);
  for (const [route, files] of Object.entries(plan.routes)) {
    if (!Array.isArray(files) || !files.length) problems.push('web/routes.js: ' + route + ' declares no assets');
    for (const file of files ?? [])
      if (!order.has(file))
        problems.push('web/routes.js: ' + route + ' loads ' + file + ', which web/route-assets.js does not list');
  }
  for (const [file, dependencies] of Object.entries(plan.dependencies))
    for (const dependency of [file, ...dependencies])
      if (!order.has(dependency))
        problems.push('web/route-assets.js: dependency ' + dependency + ' is not in the loader order');
  for (const file of plan.order) if (!exists(file)) problems.push('web/route-assets.js: ' + file + ' does not ship');
  return problems;
}
export function routeProblems({registry, index, server, assets, groups = [], glyphs = {}}) {
  const problems = [],
    paths = registry.map(entry => entry.path);
  if (new Set(paths).size !== paths.length) problems.push('web/routes.js: a path is registered twice');
  for (const entry of registry) {
    if (!entry.label) problems.push('web/routes.js: ' + entry.path + ' has no label');
    if (entry.parent && !paths.includes(entry.parent))
      problems.push('web/routes.js: ' + entry.path + ' names an unregistered parent ' + entry.parent);
    if (entry.parent === entry.path) problems.push('web/routes.js: ' + entry.path + ' is its own parent');
    if (entry.palette && !entry.description)
      problems.push('web/routes.js: ' + entry.path + ' needs a palette description');
    if (entry.nav && !groups.includes(entry.group))
      problems.push('web/routes.js: ' + entry.path + ' is in "' + entry.group + '", not one of the navigation groups');
    if (!entry.nav && entry.group !== undefined && !groups.includes(entry.group))
      problems.push('web/routes.js: ' + entry.path + ' names a group that is not one of the navigation groups');
    if (entry.nav || entry.menu === 'user') {
      if (typeof entry.icon !== 'string' || !Object.hasOwn(glyphs, entry.icon))
        problems.push(
          'web/routes.js: ' + entry.path + ' needs an icon that web/identity.js draws (found ' + entry.icon + ')',
        );
    } else if (entry.icon !== undefined)
      problems.push('web/routes.js: ' + entry.path + ' is in no navigation or menu and needs no icon');
    if (!entry.public && entry.path !== '/auth/complete' && !entry.subtitle)
      problems.push('web/routes.js: ' + entry.path + ' has no subtitle');
  }
  const linked = registry.filter(entry => entry.nav || entry.menu === 'user'),
    icons = linked.map(entry => entry.icon).filter(icon => typeof icon === 'string');
  for (const icon of new Set(icons.filter((icon, i) => icons.indexOf(icon) !== i)))
    problems.push('web/routes.js: more than one link has the icon ' + icon);
  const drawn = icons.map(icon => glyphs[icon]).filter(Boolean);
  if (new Set(drawn).size !== drawn.length) problems.push('web/identity.js: two icon names draw the same glyph');
  // Pages are listed group by group, and a group's first page is the hub every other page of it names as its parent.
  const navigation = registry.filter(entry => entry.nav),
    order = [...new Set(navigation.map(entry => entry.group))];
  if (order.join() !== groups.filter(group => order.includes(group)).join())
    problems.push('web/routes.js: the pages are not listed in the order of the navigation groups');
  for (const group of groups) {
    const members = navigation.filter(entry => entry.group === group);
    if (!members.length) problems.push('web/routes.js: the navigation group ' + group + ' has no page');
    members.forEach((entry, position) => {
      if (position === 0 && entry.parent !== undefined)
        problems.push('web/routes.js: ' + entry.path + ' is the hub of ' + group + ' and has no parent');
      if (position > 0 && entry.parent !== members[0].path)
        problems.push('web/routes.js: ' + entry.path + ' should name its hub ' + members[0].path + ' as its parent');
    });
  }
  const hook = navigationHook(index);
  if (hook === null) problems.push('index.html: the main navigation hook is missing');
  else if (/<a\b/.test(hook))
    problems.push('index.html: the main navigation holds links; web/identity.js builds them from web/routes.js');
  if (!server) problems.push(serverShellSource + ' or ' + serverHelpSource + ': the list of shell pages was not found');
  else {
    for (const route of server)
      if (!paths.includes(route))
        problems.push(serverShellSource + ': serves ' + route + ', which web/routes.js does not register');
    for (const route of paths)
      if (!server.includes(route)) problems.push(serverShellSource + ': does not serve registered page ' + route);
    if (new Set(server).size !== server.length) problems.push(serverShellSource + ': a page is served twice');
  }
  for (const route of assets ?? [])
    if (!paths.includes(route)) problems.push('web/route-assets.js: loads assets for unregistered page ' + route);
  return problems;
}
export function checkRoutes(root = process.cwd()) {
  const plan = pageAssetPlan(root);
  return [
    ...routeProblems({
      registry: loadRouteRegistry(root),
      index: fs.readFileSync(path.join(root, 'web/index.html'), 'utf8'),
      server: servedPages(root),
      assets: Object.keys(plan.routes),
      groups: loadRouteGroups(root),
      glyphs: loadRouteGlyphs(root),
    }),
    ...pageAssetProblems(plan, file => fs.existsSync(path.join(root, 'web', file))),
  ];
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkRoutes();
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  } else console.log('Route registry, navigation, page assets and server shell pages agree.');
}
