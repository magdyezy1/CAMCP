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
//              count may only go down (tools/web-colour-baseline.json), and so may the allow-list;
//   markup     scripts and pages write no colour either, except the reviewed data defaults, QR pixels and the
//              downloaded report document (allow-list "scripts", by file, value and count; the number of entries and
//              the total of their counts may only go down), and the theme-color values, which must equal --paper. A
//              named colour counts where markup gives a colour (a fill, stroke or color attribute, a CSS declaration
//              in style text), not in prose.

export const baselinePath = 'tools/web-colour-baseline.json';
/** Stylesheets allowed to define tokens. V2 is checked independently and remains unloaded until page adoption. */
export const tokenSheets = Object.freeze(['tokens.css', 'public-tokens.css', 'tokens-v2.css']);
export const allowlistPath = 'tools/web-colour-allowlist.json';
/**
 * Tokens that keep one value in both themes: the surfaces that stay dark in the light theme and what sits on them, the
 * overlays and shadows, the online status dot, and the illustrations' own colours.
 */
export const themeInvariantTokens = new Set([
  '--surface-inverse',
  '--surface-inverse-raised',
  '--surface-inverse-accent',
  '--text-on-inverse',
  '--text-on-inverse-strong',
  '--text-on-inverse-secondary',
  '--text-on-inverse-muted',
  '--border-on-inverse',
  '--fill-on-inverse',
  '--fill-on-inverse-subtle',
  '--accent-on-inverse',
  '--overlay',
  '--shadow-soft',
  '--shadow',
  '--shadow-strong',
  '--success-dot',
  '--art-iris',
  '--art-frame',
  '--art-spark',
  '--art-lilac',
  '--art-plum',
  '--art-mist',
  '--art-apricot',
  '--art-cream',
  '--art-highlight',
]);
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
// Scripts and pages: a hex or functional colour in markup they write bypasses the tokens and stays light in dark mode
// (the report pack's chart bars did). Vendored code is excluded; the theme-color values are read before any stylesheet
// loads, so they stay literal but must equal --paper.
const markupLiteral =
  /(?<![\w#&-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^()]*\)/g;
// A named colour is a colour only where markup gives one: a colour attribute (fill="white", also escaped or unquoted in
// a script's string) or a CSS declaration in style text a script writes (the downloaded report document's <style>): one
// that follows "{" or ";", starts a line or starts a style attribute. "The white paper" and title="color: tan" are
// prose. The colour name is the first capture group.
const markupNamedColour = [
  new RegExp(
    `(?<![\\w-])(?:fill|stroke|color|stop-color|flood-color|lighting-color|bgcolor)\\s*=\\s*\\\\?["']?\\s*(${namedColours})(?![\\w-])`,
    'gi',
  ),
  new RegExp(
    `(?<=(?:^|[{;]|(?<![\\w-])style\\s*=\\s*\\\\?["'])\\s*)` +
      '(?:color|background(?:-color)?|border(?:-[a-z]+)*|outline(?:-color)?|fill|stroke|stop-color|caret-color|' +
      `accent-color|text-decoration(?:-color)?|column-rule(?:-color)?|box-shadow|text-shadow)\\s*:\\s*[^;{}"'\`<>]*?(?<![\\w-])(${namedColours})(?![\\w-])`,
    'gi',
  ),
];
/** Shipped scripts and pages (web/*.js, web/*.html), vendored files excluded. */
export function markupFiles(root = process.cwd()) {
  return fs
    .readdirSync(path.join(root, 'web'), {recursive: true})
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => /\.(?:js|html)$/.test(file) && !file.startsWith('vendor/'))
    .sort();
}
/** Every literal colour a script or page writes: [{file, line, literal, text}]. */
export function markupColours(text, file = '') {
  const out = [];
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(markupLiteral))
      out.push({file, line: index + 1, literal: match[0].toLowerCase(), text: line});
    for (const pattern of markupNamedColour)
      for (const match of line.matchAll(pattern))
        out.push({file, line: index + 1, literal: match[1].toLowerCase(), text: line});
  });
  return out;
}
/** The literals the reviewed script entries admit: the total of their counts, which may only go down. */
export const reviewedScriptLiterals = scripts => scripts.reduce((sum, entry) => sum + (Number(entry.count) || 0), 0);
const themeColorMeta = /<meta\b[^>]*\bname="theme-color"[^>]*>/g;
/**
 * A page's theme-color metas: [{line, media, dark, content}]. A meta whose media names the dark scheme is the dark
 * one; any other (light media, or none) is read as the light one.
 */
export function themeColorMetas(text) {
  return [...text.matchAll(themeColorMeta)].map(m => {
    const media = /\bmedia="([^"]*)"/.exec(m[0])?.[1] ?? '';
    return {
      line: text.slice(0, m.index).split('\n').length,
      media,
      dark: /prefers-color-scheme:\s*dark/.test(media),
      light: /prefers-color-scheme:\s*light/.test(media),
      content: (/\bcontent="([^"]*)"/.exec(m[0])?.[1] ?? '').trim().toLowerCase(),
    };
  });
}
/**
 * Literals in scripts and pages outside the reviewed list, and theme-color values that are not --paper: a page's
 * metas are read before any stylesheet, so they stay literal, one per appearance (media prefers-color-scheme), each
 * the --paper of its appearance, and the browser bar follows a dark system before JavaScript sets the chosen theme.
 */
export function markupColourProblems(
  root = process.cwd(),
  allowlist = readColourAllowlist(root),
  baseline = readColourBaseline(root),
) {
  const declarations = cssDeclarations(fs.readFileSync(path.join(root, 'web/tokens.css'), 'utf8')),
    paper = [tokenBlock(declarations, ...themeBlocks.light), tokenBlock(declarations, ...themeBlocks.dark)].map(block =>
      block['--paper']?.toLowerCase(),
    ),
    reviewed = allowlist.scripts ?? [],
    seen = new Map(),
    problems = [];
  for (const file of markupFiles(root)) {
    const source = fs.readFileSync(path.join(root, 'web', file), 'utf8'),
      metas = themeColorMetas(source);
    for (const meta of metas) {
      const expected = paper[meta.dark ? 1 : 0];
      if (meta.content !== expected)
        problems.push(
          'web/' +
            file +
            ':' +
            meta.line +
            ': theme-color ' +
            (meta.content || '(empty)') +
            ' is not --paper (' +
            expected +
            (meta.media ? ' for ' + meta.media : '') +
            ')',
        );
    }
    if (metas.length && !(metas.some(meta => meta.dark) && metas.some(meta => meta.light)))
      problems.push(
        'web/' +
          file +
          ': theme-color needs a light and a dark meta (media "(prefers-color-scheme: light)" and "(prefers-color-scheme: dark)"), so the browser bar follows the system before JavaScript',
      );
    // The metas are checked above; their literals are not script colours.
    const text = source.replace(themeColorMeta, tag => ' '.repeat(tag.length));
    for (const found of markupColours(text, file)) {
      const mirror = /name="theme-color"|setAttribute\('content'/.test(found.text);
      if (mirror) {
        if (!paper.includes(found.literal))
          problems.push(
            'web/' +
              file +
              ':' +
              found.line +
              ': theme-color ' +
              found.literal +
              ' is not --paper (' +
              paper.join(', ') +
              ')',
          );
        continue;
      }
      const entry = reviewed.find(
        e => e.file === file && e.value.toLowerCase() === found.literal && found.text.includes(e.within),
      );
      if (entry) seen.set(entry, (seen.get(entry) ?? 0) + 1);
      else
        problems.push(
          'web/' +
            file +
            ':' +
            found.line +
            ': literal colour ' +
            found.literal +
            ' in markup; give the element a class whose colour comes from web/tokens.css (WEB-07)',
        );
    }
  }
  for (const entry of reviewed) {
    if (!entry.reason || !entry.within)
      problems.push(allowlistPath + ': scripts ' + entry.file + ' ' + entry.value + ' needs a reason and a context');
    const count = seen.get(entry) ?? 0;
    if (count !== entry.count)
      problems.push(
        allowlistPath +
          ': scripts ' +
          entry.file +
          ' ' +
          entry.value +
          ' occurs ' +
          count +
          ' times, not ' +
          entry.count,
      );
  }
  if (reviewed.length > (baseline.script_entries ?? 0))
    problems.push(
      allowlistPath +
        ': ' +
        reviewed.length +
        ' script entries (limit ' +
        (baseline.script_entries ?? 0) +
        '); the reviewed script colours only shrink (WEB-07)',
    );
  // Each entry's count must match what its file writes, so raising a count by hand would admit more literals of that
  // value in that context; the total of the counts is recorded and may only go down.
  const literals = reviewedScriptLiterals(reviewed);
  if (literals > (baseline.script_literals ?? 0))
    problems.push(
      allowlistPath +
        ': the script entries admit ' +
        literals +
        ' literal colours (limit ' +
        (baseline.script_literals ?? 0) +
        '); a reviewed count only goes down (WEB-07)',
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
        tokenSheets
          .filter(file => file !== 'tokens-v2.css')
          .map(file => fs.readFileSync(path.join(root, 'web', file), 'utf8'))
          .join('\n'),
        'web/tokens.css + web/public-tokens.css',
      ),
      ...tokenParityProblems(fs.readFileSync(path.join(root, 'web/tokens-v2.css'), 'utf8'), 'web/tokens-v2.css'),
      ...problems,
      ...colourRatchet(counts, baseline, allowlist),
      ...markupColourProblems(root, allowlist, baseline),
    ],
  };
}
const total = counts => Object.values(counts).reduce((sum, value) => sum + value, 0);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const explain = process.argv.indexOf('--explain');
  if (explain > 0) {
    // Lists a stylesheet's (or a script's) literal colours: node tools/check-colours.mjs --explain web/app.css
    const file = process.argv[explain + 1] ?? '';
    if (/\.(?:js|html)$/.test(file))
      for (const found of markupColours(fs.readFileSync(file, 'utf8')))
        console.log(file + ':' + found.line + ': ' + found.literal);
    else
      for (const found of literalColours(fs.readFileSync(file, 'utf8')))
        console.log(
          file + ':' + found.line + ': ' + found.selector + ' { ' + found.property + ': ' + found.literal + ' }',
        );
  } else if (process.argv.includes('--write')) {
    // The baseline only moves down: a count above its limit must be fixed, never recorded.
    // A limit the baseline does not record yet (the script entries and their total before their first recording)
    // starts open.
    const existing = fs.existsSync(baselinePath)
      ? readColourBaseline()
      : {files: new Proxy({}, {get: () => Infinity}), allowlist_entries: Infinity};
    const {counts, allowed, problems} = checkColours(process.cwd(), {
      script_entries: Infinity,
      script_literals: Infinity,
      ...existing,
    });
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
            'WEB-07 ratchet: literal colours per shipped stylesheet outside web/tokens.css and outside the reviewed allow-list, and the reviewed colours scripts and pages write. Counts and both lists may only go down (node tools/check-colours.mjs --write).',
          total: total(counts),
          allowlist_entries: allowlist.entries.length,
          script_entries: allowlist.scripts?.length ?? 0,
          script_literals: reviewedScriptLiterals(allowlist.scripts ?? []),
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
