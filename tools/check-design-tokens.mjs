import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {colourSheets, cssDeclarations, tokenSheets} from './check-colours.mjs';
import {routeAssetFiles} from './check-routes.mjs';

// WEB-07 (design system): the scales beside the colours. Corner radius, shadow, motion and type size come from the
// tokens in web/tokens.css (docs/DESIGN-SYSTEM.md); a value a stylesheet writes itself is counted per stylesheet and
// scale, and a count may only go down (tools/web-design-token-baseline.json), as the literal colours did. Circles
// (50%), zero, "none" and inherited values are not scale values. Spacing stays component geometry with no tokens, so
// what is counted there is a padding, margin or gap off the 4px grid (more than 2px and not a multiple of 4). Every
// custom property a stylesheet reads must be defined in a token sheet that every page loading the stylesheet loads: a
// misspelt or missing token silently falls back (the review tables once asked for a --border that did not exist).

export const baselinePath = 'tools/web-design-token-baseline.json';
const length = /(?<![\w-])-?(?:\d*\.)?\d+(?:px|rem|em|pt|vw|vh|vmin|vmax|ch|%)(?![\w-])/g;
const withoutVars = value => value.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, ' ');
/** The scales, each with the properties it covers and what counts as a value written by hand. */
export const scales = {
  radius: {
    property: p => /^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/.test(p),
    literal: value =>
      (withoutVars(value).match(length) ?? []).some(v => !/^-?0(?:\.0+)?[a-z%]*$/.test(v) && v !== '50%'),
  },
  shadow: {
    property: p => p === 'box-shadow' || p === 'text-shadow',
    literal: value => !/^(?:none|inherit|initial|unset)$/.test(value.trim()) && /\d/.test(withoutVars(value)),
  },
  motion: {
    property: p => /^(?:transition|animation)(?:-duration|-delay)?$/.test(p),
    literal: value => /(?<![\w-])(?:\d*\.)?\d+m?s(?![\w-])/.test(withoutVars(value)) && !/^0m?s$/.test(value.trim()),
  },
  type: {
    property: p => p === 'font-size' || p === 'font',
    literal: value => (withoutVars(value).match(length) ?? []).length > 0,
  },
  spacing: {
    property: p =>
      /^(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?$/.test(
        p,
      ),
    literal: value =>
      (withoutVars(value).match(/(?<![\w.-])-?(?:\d*\.)?\d+(?:px|rem)(?![\w-])/g) ?? []).some(v => {
        const pixels = Math.abs(Number.parseFloat(v) * (v.endsWith('rem') ? 16 : 1));
        return pixels > 2 && pixels % 4 !== 0;
      }),
  },
};
const readBaseline = root => JSON.parse(fs.readFileSync(path.join(root, baselinePath), 'utf8'));
/** Values written by hand per stylesheet and scale: {file: {scale: count}}, with the declarations behind them. */
export function designTokenCounts(root = process.cwd()) {
  const counts = {},
    found = [];
  for (const file of colourSheets(root)) {
    const declarations = cssDeclarations(fs.readFileSync(path.join(root, 'web', file), 'utf8'));
    counts[file] = Object.fromEntries(Object.keys(scales).map(scale => [scale, 0]));
    for (const declaration of declarations)
      for (const [scale, rule] of Object.entries(scales))
        if (rule.property(declaration.property) && rule.literal(declaration.value)) {
          counts[file][scale]++;
          found.push({file, scale, ...declaration});
        }
  }
  return {counts, found};
}
/**
 * The stylesheets each shipped page loads, in order: its <link rel="stylesheet"> elements outside <noscript> (About
 * loads public-tokens.css only for a reader without JavaScript, so its other sheets cannot rely on it).
 */
export function pageStylesheets(root = process.cwd()) {
  const pages = fs
    .readdirSync(path.join(root, 'web'))
    .filter(file => file.endsWith('.html'))
    .sort()
    .map(page => ({
      page,
      sheets: [
        ...fs
          .readFileSync(path.join(root, 'web', page), 'utf8')
          .replace(/<noscript>[\s\S]*?<\/noscript>/g, '')
          .matchAll(/<link rel="stylesheet" href="\/assets\/([^"?#]+)"/g),
      ].map(m => m[1]),
    }));
  // V2-WEB-02: a route that loads stylesheets (web/route-assets.js) is a page of its own, the workspace shell's sheets
  // plus its own; a sheet the loader adds is loaded by exactly the routes that list it (or depend on it).
  const shell = pages.find(({page}) => page === 'index.html');
  for (const [route, files] of Object.entries(routeAssetFiles(root))) {
    const sheets = files.filter(file => file.endsWith('.css'));
    if (shell && sheets.length) pages.push({page: 'route ' + route, sheets: [...shell.sheets, ...sheets]});
  }
  return pages;
}
/**
 * Custom properties a stylesheet reads that are defined in no token sheet, or only in a token sheet one of the pages
 * loading it does not load (a workspace sheet reading a --policy-* token of public-tokens.css, which the workspace never
 * downloads, falls back silently). An unlinked component sheet can rely on tokens.css only; a token sheet can also
 * reference its own definitions, which are available whenever that sheet is loaded.
 */
export function undefinedTokenProblems(root = process.cwd()) {
  const definedIn = new Map(
      tokenSheets.map(file => [
        file,
        new Set(
          cssDeclarations(fs.readFileSync(path.join(root, 'web', file), 'utf8'))
            .map(d => d.property)
            .filter(p => p.startsWith('--')),
        ),
      ]),
    ),
    pages = pageStylesheets(root),
    problems = [];
  for (const file of [...tokenSheets, ...colourSheets(root)]) {
    const loading = pages.filter(p => p.sheets.includes(file));
    for (const d of cssDeclarations(fs.readFileSync(path.join(root, 'web', file), 'utf8')))
      for (const match of d.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
        const owners = tokenSheets.filter(sheet => definedIn.get(sheet).has(match[1])),
          without = loading.filter(p => !owners.some(sheet => p.sheets.includes(sheet))).map(p => p.page),
          at = 'web/' + file + ':' + d.line + ': ' + match[1] + ' is defined ';
        if (!owners.length) problems.push(at + 'in no token sheet (' + d.selector + ')');
        else if (without.length)
          problems.push(
            at +
              'only in ' +
              owners.join(', ') +
              ', which ' +
              without.join(', ') +
              ' does not load (' +
              d.selector +
              ')',
          );
        else if (!loading.length && !owners.includes('tokens.css') && !owners.includes(file))
          problems.push(
            at + 'only in ' + owners.join(', ') + ', and no page links this sheet to load it (' + d.selector + ')',
          );
      }
  }
  return problems;
}
/** Every count above its committed limit (a new stylesheet's limit is 0). */
export function designTokenRatchet(counts, baseline) {
  const problems = [];
  for (const [file, perScale] of Object.entries(counts))
    for (const [scale, count] of Object.entries(perScale)) {
      const limit = baseline.files?.[file]?.[scale] ?? 0;
      if (count > limit)
        problems.push(
          scale === 'spacing'
            ? 'web/' +
                file +
                ': ' +
                count +
                ' spacing values off the 4px grid (limit ' +
                limit +
                '); use multiples of 4px (docs/DESIGN-SYSTEM.md)'
            : 'web/' +
                file +
                ': ' +
                count +
                ' ' +
                scale +
                ' values written by hand (limit ' +
                limit +
                '); use the ' +
                scale +
                ' tokens in web/tokens.css (docs/DESIGN-SYSTEM.md)',
        );
    }
  return problems;
}
export function checkDesignTokens(root = process.cwd(), baseline = readBaseline(root)) {
  const {counts, found} = designTokenCounts(root);
  return {counts, found, problems: [...undefinedTokenProblems(root), ...designTokenRatchet(counts, baseline)]};
}
const totals = counts =>
  Object.fromEntries(
    Object.keys(scales).map(scale => [scale, Object.values(counts).reduce((sum, c) => sum + (c[scale] ?? 0), 0)]),
  );
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const explain = process.argv.indexOf('--explain');
  if (explain > 0) {
    // Lists a stylesheet's hand-written scale values: node tools/check-design-tokens.mjs --explain web/app.css
    const file = (process.argv[explain + 1] ?? '').replace(/^web\//, '');
    for (const d of designTokenCounts().found.filter(d => d.file === file))
      console.log(
        'web/' + file + ':' + d.line + ': ' + d.scale + ' ' + d.selector + ' { ' + d.property + ': ' + d.value + ' }',
      );
  } else if (process.argv.includes('--write')) {
    // The baseline only moves down: a count above its limit must be fixed, never recorded. A scale the baseline does
    // not record yet (its totals name no such scale) starts open, once.
    const open = {files: new Proxy({}, {get: () => new Proxy({}, {get: () => Infinity})})},
      recorded = fs.existsSync(baselinePath) ? readBaseline(process.cwd()) : undefined,
      existing = recorded
        ? {
            files: new Proxy(recorded.files ?? {}, {
              get: (files, file) =>
                new Proxy(files[file] ?? {}, {
                  get: (perScale, scale) => (scale in (recorded.totals ?? {}) ? perScale[scale] : Infinity),
                }),
            }),
          }
        : open,
      {counts, problems} = checkDesignTokens(process.cwd(), existing);
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    fs.writeFileSync(
      baselinePath,
      JSON.stringify(
        {
          meaning:
            'WEB-07 design-system ratchet: radius, shadow, motion and type values each shipped stylesheet writes itself instead of taking a token from web/tokens.css, and its spacing values off the 4px grid. Counts may only go down (node tools/check-design-tokens.mjs --write).',
          totals: totals(counts),
          files: Object.fromEntries(
            Object.entries(counts)
              .map(([file, perScale]) => [file, Object.fromEntries(Object.entries(perScale).filter(([, n]) => n))])
              .filter(([, perScale]) => Object.keys(perScale).length),
          ),
        },
        null,
        2,
      ) + '\n',
    );
    console.log('Design token baseline written: ' + JSON.stringify(totals(counts)) + '.');
  } else {
    const {counts, problems} = checkDesignTokens();
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exitCode = 1;
    } else
      console.log(
        'Design tokens: ' +
          Object.entries(totals(counts))
            .map(([scale, n]) => n + ' ' + (scale === 'spacing' ? 'spacing (off the 4px grid)' : scale))
            .join(', ') +
          ' values written by hand, none above the baseline; every token read is defined.',
      );
  }
}
