import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Script, createContext} from 'node:vm';

// WEB-06: the website names, routes and serves every page from one registry (web/routes.js). These checks fail when a
// consumer that cannot read the registry at run time drifts from it: the static navigation in index.html (href,
// data-route, label and group, in order), the lazily loaded page assets and the server's list of shell pages.

/** The registry as the browser evaluates it. */
export function loadRouteRegistry(root = process.cwd()) {
  const context = createContext({});
  new Script(
    fs.readFileSync(path.join(root, 'web/routes.js'), 'utf8') + '\n;globalThis.__routes = routeRegistry;',
  ).runInContext(context);
  return context.__routes;
}
const decode = value =>
  value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
/** The main navigation links in index.html, in order, with the disclosure group each one sits in. */
export function navigationLinks(index) {
  const nav = /<nav aria-label="Main navigation"[^>]*>([\s\S]*?)<\/nav>/.exec(index)?.[1] ?? '';
  const links = [];
  let group = null;
  for (const m of nav.matchAll(
    /<summary[^>]*>([^<]*)<\/summary>|<\/details>|<a href="([^"]*)" data-route="([^"]*)"[^>]*>[\s\S]*?<span data-ui-text="([^"]*)">([^<]*)<\/span><\/a>/g,
  )) {
    if (m[1] !== undefined) group = decode(m[1]);
    else if (m[0] === '</details>') group = null;
    else links.push({href: m[2], route: m[3], label: decode(m[4]), text: decode(m[5]), group});
  }
  return links;
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
export function routeProblems({registry, index, server, assets}) {
  const problems = [],
    paths = registry.map(entry => entry.path);
  if (new Set(paths).size !== paths.length) problems.push('web/routes.js: a path is registered twice');
  for (const entry of registry) {
    if (!entry.label) problems.push('web/routes.js: ' + entry.path + ' has no label');
    if (entry.parent && !paths.includes(entry.parent))
      problems.push('web/routes.js: ' + entry.path + ' names an unregistered parent ' + entry.parent);
    if (entry.palette && !entry.description)
      problems.push('web/routes.js: ' + entry.path + ' needs a palette description');
  }
  const links = navigationLinks(index),
    expected = registry.filter(entry => entry.nav);
  for (const link of links) {
    const entry = registry.find(e => e.path === link.href);
    if (link.href !== '/' + link.route)
      problems.push('index.html: navigation link ' + link.href + ' has data-route "' + link.route + '"');
    if (!entry?.nav) {
      problems.push('index.html: navigation link ' + link.href + ' is not a navigation page in web/routes.js');
      continue;
    }
    if (link.label !== entry.label || link.text !== entry.label)
      problems.push(
        'index.html: navigation link ' + link.href + ' is labelled "' + link.text + '", not "' + entry.label + '"',
      );
    if ((link.group ?? null) !== (entry.group ?? null))
      problems.push(
        'index.html: navigation link ' + link.href + ' sits in group "' + link.group + '", not "' + entry.group + '"',
      );
  }
  for (const entry of expected)
    if (!links.some(link => link.href === entry.path))
      problems.push('index.html: navigation page ' + entry.path + ' has no navigation link');
  if (links.map(link => link.href).join() !== expected.map(entry => entry.path).join())
    problems.push('index.html: navigation order differs from web/routes.js');
  if (!server) problems.push(serverShellSource + ': the list of shell pages was not found');
  else {
    for (const route of server)
      if (!paths.includes(route))
        problems.push(serverShellSource + ': serves ' + route + ', which web/routes.js does not register');
    for (const route of paths)
      if (!server.includes(route)) problems.push(serverShellSource + ': does not serve registered page ' + route);
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
      server: serverShellRoutes(fs.readFileSync(path.join(root, serverShellSource), 'utf8')),
      assets: Object.keys(plan.routes),
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
