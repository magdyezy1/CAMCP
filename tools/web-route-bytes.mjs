import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Script, createContext} from 'node:vm';
import {brotliCompressSync, constants} from 'node:zlib';

// WEB-07: transferred bytes per route, recorded so a change to how the website is split can only lower them. For each
// page and language this sums what the browser downloads from the public snapshot before the page renders: the
// document's stylesheets and scripts, the page's feature scripts with their dependencies, and in Arabic the catalog
// (one ar.json before WEB-07, the shell chunk and the page's chunks after). Each file is Brotli-compressed on its own
// at quality 5, as server/compressed-assets.ts serves it. Fonts, images, API responses and HTTP headers are excluded:
// this is a byte count of the website's own code and copy, not a browser timing. A stylesheet inside <noscript> is
// not counted: a browser that runs scripts never downloads it.
//
// The baseline holds each page's value before WEB-07 (`routes`). A page above it fails, unless it is listed under
// `open`: an acceptance gap WEB-07 has not closed yet (not an accepted exception), with the value it may not exceed
// while open and the reason. An open page fails above that value, and fails once it is back at or below its
// baseline, so the list only shrinks.
export const baselinePath = 'tools/web-route-bytes-baseline.json';
const publicPages = ['/', '/login', '/signup', '/forgot-password'];

function loader(root) {
  const context = createContext({});
  const read = file => fs.readFileSync(path.join(root, 'web', file), 'utf8');
  new Script(read('routes.js')).runInContext(context);
  new Script(
    read('route-assets.js') +
      `\n;globalThis.__plan = JSON.stringify({
        routes: Object.keys(pageAssetRoutes),
        assets: Object.fromEntries(routeRegistry.map(entry => [entry.path, pageAssetsFor(entry.path)])),
        chunks: typeof pageLocaleChunks === 'function'
          ? Object.fromEntries(routeRegistry.map(entry => [entry.path, pageLocaleChunks(entry.path)]))
          : null,
        registry: routeRegistry.map(entry => entry.path),
      });`,
  ).runInContext(context);
  return JSON.parse(context.__plan);
}
const linked = (html, kind) =>
  [
    ...html
      .replace(/<noscript>[\s\S]*?<\/noscript>/g, '')
      .matchAll(
        kind === 'css' ? /<link rel="stylesheet" href="\/assets\/([^"]+)">/g : /<script src="\/assets\/([^"]+)"/g,
      ),
  ].map(match => match[1]);
/** The Arabic chunks each route waits for before it renders (web/route-assets.js pageLocaleChunks): {"<path>": ["workspace", …]}. */
export function routeLocaleChunks(root = process.cwd()) {
  return loader(root).chunks ?? {};
}
/** Brotli bytes per route and language: {"<locale> <path>": {bytes, files}}. */
export function routeBytes(root = process.cwd()) {
  const sizes = new Map(),
    size = file => {
      if (!sizes.has(file))
        sizes.set(
          file,
          brotliCompressSync(fs.readFileSync(path.join(root, 'web', file)), {
            params: {[constants.BROTLI_PARAM_QUALITY]: 5},
          }).length,
        );
      return sizes.get(file);
    },
    plan = loader(root),
    chunked = fs.existsSync(path.join(root, 'web/locales/ar/shell.json')),
    index = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8'),
    about = fs.readFileSync(path.join(root, 'web/about.html'), 'utf8'),
    out = {};
  const record = (key, files) => {
    const unique = [...new Set(files)];
    out[key] = {bytes: unique.reduce((sum, file) => sum + size(file), 0), files: unique.length};
  };
  const routes = [...new Set([...publicPages, ...plan.registry.filter(route => !route.includes('oauth'))])];
  for (const locale of ['en', 'ar'])
    for (const route of routes) {
      const files = [...linked(index, 'css'), ...linked(index, 'js'), ...(plan.assets[route] ?? [])];
      if (locale === 'ar')
        files.push(
          ...(chunked
            ? ['shell', ...(plan.chunks?.[route] ?? [])].map(chunk => 'locales/ar/' + chunk + '.json')
            : ['locales/ar.json']),
        );
      record(locale + ' ' + route, files);
    }
  for (const locale of ['en', 'ar'])
    record(locale + ' /about', [
      ...linked(about, 'css'),
      ...linked(about, 'js'),
      ...(locale === 'ar' ? [chunked ? 'locales/ar/shell.json' : 'locales/ar.json'] : []),
    ]);
  return out;
}
export function readRouteBytesBaseline(root = process.cwd()) {
  return JSON.parse(fs.readFileSync(path.join(root, baselinePath), 'utf8'));
}
/** Every route above its recorded baseline that is not an open gap, and every open gap that grew or has closed. */
export function routeBytesProblems(current, baseline) {
  const problems = [];
  for (const [key, value] of Object.entries(current)) {
    const limit = baseline.routes?.[key],
      open = baseline.open?.[key];
    if (limit === undefined) continue;
    if (open) {
      if (!open.reason || !Number.isSafeInteger(open.limit))
        problems.push(key + ': an open gap needs a limit and a reason');
      else if (value.bytes > open.limit)
        problems.push(
          key +
            ': ' +
            value.bytes +
            ' Brotli bytes before rendering, above its open limit of ' +
            open.limit +
            ' (WEB-07)',
        );
      else if (value.bytes <= limit)
        problems.push(key + ': back at or below its baseline of ' + limit + '; remove it from the open gaps (WEB-07)');
    } else if (value.bytes > limit)
      problems.push(
        key + ': ' + value.bytes + ' Brotli bytes before rendering, above the recorded ' + limit + ' (WEB-07)',
      );
  }
  for (const key of Object.keys(baseline.open ?? {}))
    if (!(key in current)) problems.push(key + ': an open gap for a page that is not measured');
  return problems;
}
/** The open gaps as they stand: [{key, bytes, baseline, limit, reason}]. */
export function routeBytesOpen(current, baseline) {
  return Object.entries(baseline.open ?? {})
    .filter(([key]) => key in current)
    .map(([key, open]) => ({key, bytes: current[key].bytes, baseline: baseline.routes?.[key], ...open}));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootIndex = process.argv.indexOf('--root'),
    root = rootIndex > 0 ? path.resolve(process.argv[rootIndex + 1]) : process.cwd(),
    current = routeBytes(root);
  if (process.argv.includes('--write')) {
    // Records a baseline: the measured state of the tree given with --root (the tree before a change). An open gap keeps
    // its recorded target and its entry: a new recording never turns an open gap into the baseline.
    const existing = fs.existsSync(baselinePath) ? readRouteBytesBaseline() : {routes: {}};
    fs.writeFileSync(
      baselinePath,
      JSON.stringify(
        {
          meaning:
            'WEB-07: Brotli (quality 5) bytes of the stylesheets, scripts, feature scripts and Arabic catalog each page downloads before it renders, per language. A route may not exceed its recorded value unless it is an open gap, which may not exceed its own limit and leaves the list once it is back at its baseline (node tools/web-route-bytes.mjs, part of check-web).',
          recorded_from: process.argv[process.argv.indexOf('--label') + 1] ?? 'unlabelled tree',
          routes: Object.fromEntries(
            Object.entries(current).map(([key, value]) => [
              key,
              existing.open?.[key] && existing.routes?.[key] !== undefined ? existing.routes[key] : value.bytes,
            ]),
          ),
          // Open gaps are written by hand.
          ...(existing.open ? {open: existing.open} : {}),
        },
        null,
        2,
      ) + '\n',
    );
    console.log('Route bytes baseline written for ' + Object.keys(current).length + ' routes.');
  } else {
    const baseline = fs.existsSync(path.join(process.cwd(), baselinePath)) ? readRouteBytesBaseline() : {routes: {}};
    for (const [key, value] of Object.entries(current)) {
      const limit = baseline.routes[key];
      console.log(
        key.padEnd(28) +
          String(value.bytes).padStart(9) +
          (limit === undefined
            ? ''
            : String(limit).padStart(9) + ' ' + ((100 * (value.bytes - limit)) / limit).toFixed(1) + '%'),
      );
    }
    for (const gap of routeBytesOpen(current, baseline))
      console.log(
        'open: ' + gap.key + ' ' + gap.bytes + ' of ' + gap.baseline + ' (limit ' + gap.limit + '): ' + gap.reason,
      );
    const problems = routeBytesProblems(current, baseline);
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exitCode = 1;
    }
  }
}
