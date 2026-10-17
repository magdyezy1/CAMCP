import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// WEB-07: the token sheets are the one theme source: tokens.css, which every page loads first, and public-tokens.css,
// which the static public pages load right after it (the policy pages' shades and the dark system a page read without
// JavaScript follows; the workspace needs JavaScript, and theme.js sets its theme before styles load). Dark mode used
// to be an override layer (theme.css re-coloured components
// through [data-theme='dark'] :is(...) lists whose winner depended on specificity), and every component written with a
// literal colour rendered in light colours in dark mode until someone added it to that layer; check-web only refused a
// literal equal to a token value, and only in the stylesheets index.html links. These checks cover every shipped
// stylesheet:
//   parity     every colour token the token sheets set for the light theme is set for the dark theme too (unless it is one
//              of the reviewed theme-invariant tokens below), and the block a dark operating system gets without
//              JavaScript (prefers-color-scheme) is exactly the [data-theme='dark'] block;
//   literals   a colour written outside tokens.css is counted per stylesheet, unless the reviewed allow-list
//              (tools/web-colour-allowlist.json: brand marks, QR codes, illustrations) names it with its reason; a
//              count may only go down (tools/web-colour-baseline.json), and so may the allow-list.

export const baselinePath = 'tools/web-colour-baseline.json';
/** The stylesheets that define tokens, in the order a page loads them. */
export const tokenSheets = Object.freeze(['tokens.css', 'public-tokens.css']);
export const allowlistPath = 'tools/web-colour-allowlist.json';
/** Tokens that keep one value in both themes: the surfaces that stay dark in the light theme and the ink on them. */
export const themeInvariantTokens = new Set(['--surface-inverse', '--surface-inverse-raised', '--text-on-inverse']);
const namedColours =
  'aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen';
const literalPattern = new RegExp(
  '#[0-9a-fA-F]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\([^()]*(?:\\([^()]*\\)[^()]*)*\\)|(?<![\\w-])(?:' +
    namedColours +
    ')(?![\\w-])',
  'gi',
);

/** Every declaration of a stylesheet: its property, value, the selector it sits under, the enclosing at-rules, line. */
export function cssDeclarations(css) {
  const declarations = [],
    blocks = [];
  let buffer = '',
    line = 1,
    start = 1;
  const text = css.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '));
  const flush = () => {
    const colon = buffer.indexOf(':'),
      selector = blocks.findLast(block => !block.startsWith('@'));
    if (colon > 0 && selector !== undefined)
      declarations.push({
        selector,
        atRules: blocks.filter(block => block.startsWith('@')),
        property: buffer.slice(0, colon).trim().toLowerCase(),
        value: buffer.slice(colon + 1).trim(),
        line: start,
      });
    buffer = '';
  };
  for (const char of text) {
    if (char === '{') {
      blocks.push(buffer.trim().replace(/\s+/g, ' '));
      buffer = '';
    } else if (char === '}') {
      if (buffer.trim()) flush();
      blocks.pop();
      buffer = '';
    } else if (char === ';') flush();
    else {
      if (!buffer.trim() && char.trim()) start = line;
      buffer += char;
    }
    if (char === '\n') line++;
  }
  return declarations;
}
/** The literal colours a stylesheet writes, one entry per occurrence (custom property definitions excluded). */
export function literalColours(css) {
  const out = [];
  for (const declaration of cssDeclarations(css)) {
    if (declaration.property.startsWith('--')) continue;
    // url(...) and quoted strings hold file names and text, never colours.
    const value = declaration.value.replace(/url\([^)]*\)|"[^"]*"|'[^']*'/g, '');
    for (const match of value.matchAll(literalPattern)) out.push({...declaration, literal: match[0].toLowerCase()});
  }
  return out;
}
const sameEntry = (entry, found, file) =>
  entry.file === file &&
  entry.selector === found.selector &&
  entry.property === found.property &&
  entry.value.toLowerCase() === found.literal;
/** Shipped stylesheets other than the token sheets. */
export function colourSheets(root = process.cwd()) {
  return fs
    .readdirSync(path.join(root, 'web'), {recursive: true})
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => file.endsWith('.css') && !tokenSheets.includes(file))
    .sort();
}
export function readColourAllowlist(root = process.cwd()) {
  return JSON.parse(fs.readFileSync(path.join(root, allowlistPath), 'utf8'));
}
export function readColourBaseline(root = process.cwd()) {
  return JSON.parse(fs.readFileSync(path.join(root, baselinePath), 'utf8'));
}
/** Literal colours per stylesheet outside the allow-list, and allow-list entries that no longer match anything. */
export function colourCounts(root = process.cwd(), allowlist = readColourAllowlist(root)) {
  const counts = {},
    allowed = {},
    used = new Set(),
    problems = [];
  for (const file of colourSheets(root)) {
    const literals = literalColours(fs.readFileSync(path.join(root, 'web', file), 'utf8'));
    let count = 0,
      kept = 0;
    for (const found of literals) {
      const entry = allowlist.entries.find(candidate => sameEntry(candidate, found, file));
      if (entry) {
        used.add(entry);
        kept++;
      } else count++;
    }
    counts[file] = count;
    allowed[file] = kept;
  }
  for (const entry of allowlist.entries) {
    if (!entry.reason) problems.push(allowlistPath + ': ' + entry.file + ' ' + entry.selector + ' needs a reason');
    if (!used.has(entry))
      problems.push(
        allowlistPath +
          ': ' +
          entry.file +
          ' ' +
          entry.selector +
          ' { ' +
          entry.property +
          ': ' +
          entry.value +
          ' } no longer exists; remove the entry',
      );
  }
  return {counts, allowed, problems};
}
/** Every count above its committed limit, and an allow-list that grew. */
export function colourRatchet(counts, baseline, allowlist) {
  const problems = [];
  for (const [file, count] of Object.entries(counts)) {
    const limit = baseline.files?.[file] ?? 0;
    if (count > limit)
      problems.push(
        'web/' +
          file +
          ': ' +
          count +
          ' literal colours (limit ' +
          limit +
          '); use a token from web/tokens.css so the colour follows the theme (WEB-07)',
      );
  }
  if (allowlist && allowlist.entries.length > (baseline.allowlist_entries ?? 0))
    problems.push(
      allowlistPath +
        ': ' +
        allowlist.entries.length +
        ' entries (limit ' +
        (baseline.allowlist_entries ?? 0) +
        '); the allow-list of literal colours only shrinks (WEB-07)',
    );
  return problems;
}
/** The custom properties of one block of tokens.css: {name: value}. */
function tokenBlock(declarations, selector, atRule = undefined) {
  const block = {};
  for (const declaration of declarations)
    if (
      declaration.selector === selector &&
      (atRule === undefined ? !declaration.atRules.length : declaration.atRules.join(' ') === atRule)
    )
      block[declaration.property] = declaration.value;
  return block;
}
// A separate, non-global pattern: test() on the global one would move the lastIndex that matchAll() starts from.
const literalTest = new RegExp(literalPattern.source, 'i');
const isLiteralColour = value => {
  return literalTest.test(value) && !/var\(/.test(value);
};
export const themeBlocks = {
  light: [':root'],
  dark: [":root[data-theme='dark']"],
  system: [':root:not([data-theme])', '@media (prefers-color-scheme: dark)'],
};
/** Light/dark parity of the token sheets (their text joined), as problems. */
export function tokenParityProblems(css, label = 'web/tokens.css') {
  const declarations = cssDeclarations(css),
    light = tokenBlock(declarations, ...themeBlocks.light),
    dark = tokenBlock(declarations, ...themeBlocks.dark),
    system = tokenBlock(declarations, ...themeBlocks.system),
    problems = [];
  if (!Object.keys(dark).length) problems.push(label + ": no :root[data-theme='dark'] block");
  if (!Object.keys(system).length)
    problems.push(
      label +
        ': no @media (prefers-color-scheme: dark) { :root:not([data-theme]) } block, so a page without JavaScript cannot follow a dark system',
    );
  for (const [name, value] of Object.entries(light))
    if (name.startsWith('--') && isLiteralColour(value) && !themeInvariantTokens.has(name) && !(name in dark))
      problems.push(label + ': ' + name + ' has a light value but no dark value');
  for (const name of Object.keys(dark))
    if (name.startsWith('--') && !(name in light)) problems.push(label + ': ' + name + ' is defined only for dark');
  for (const name of themeInvariantTokens)
    if (name in dark) problems.push(label + ': ' + name + ' is theme-invariant but has a dark value');
  const differences = [...new Set([...Object.keys(dark), ...Object.keys(system)])].filter(
    name => dark[name] !== system[name],
  );
  if (differences.length)
    problems.push(
      label + ': the system-dark block (no JavaScript) differs from the dark block for ' + differences.join(', '),
    );
  return problems;
}
export function checkColours(
  root = process.cwd(),
  baseline = readColourBaseline(root),
  allowlist = readColourAllowlist(root),
) {
  const {counts, allowed, problems} = colourCounts(root, allowlist);
  return {
    counts,
    allowed,
    problems: [
      ...tokenParityProblems(
        tokenSheets.map(file => fs.readFileSync(path.join(root, 'web', file), 'utf8')).join('\n'),
        tokenSheets.map(file => 'web/' + file).join(' + '),
      ),
      ...problems,
      ...colourRatchet(counts, baseline, allowlist),
    ],
  };
}
const total = counts => Object.values(counts).reduce((sum, value) => sum + value, 0);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const explain = process.argv.indexOf('--explain');
  if (explain > 0) {
    // Lists a stylesheet's literal colours: node tools/check-colours.mjs --explain web/app.css
    const file = process.argv[explain + 1] ?? '';
    for (const found of literalColours(fs.readFileSync(file, 'utf8')))
      console.log(
        file + ':' + found.line + ': ' + found.selector + ' { ' + found.property + ': ' + found.literal + ' }',
      );
  } else if (process.argv.includes('--write')) {
    // The baseline only moves down: a count above its limit must be fixed, never recorded.
    const {counts, allowed, problems} = checkColours(
      process.cwd(),
      fs.existsSync(baselinePath)
        ? readColourBaseline()
        : {files: new Proxy({}, {get: () => Infinity}), allowlist_entries: Infinity},
    );
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    const allowlist = readColourAllowlist();
    fs.writeFileSync(
      baselinePath,
      JSON.stringify(
        {
          meaning:
            'WEB-07 ratchet: literal colours per shipped stylesheet outside web/tokens.css and outside the reviewed allow-list. Counts and the allow-list may only go down (node tools/check-colours.mjs --write).',
          total: total(counts),
          allowlist_entries: allowlist.entries.length,
          files: Object.fromEntries(Object.entries(counts).filter(([, count]) => count)),
          allowed: Object.fromEntries(Object.entries(allowed).filter(([, count]) => count)),
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'Colour baseline written: ' + total(counts) + ' literal colours, ' + allowlist.entries.length + ' allowed.',
    );
  } else {
    const {counts, problems} = checkColours();
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exitCode = 1;
    } else
      console.log('Theme colours: ' + total(counts) + ' literal colours outside tokens.css, none above the baseline.');
  }
}
