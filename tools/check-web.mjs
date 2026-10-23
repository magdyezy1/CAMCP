import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {checkWebLocales} from './check-locales.mjs';
import {accountMarkupProblems, rtlProblems} from './check-rtl.mjs';
import {checkRoutes} from './check-routes.mjs';
import {checkMarkup} from './check-markup.mjs';
import {checkExtensions} from './check-extensions.mjs';
import {
  checkColours,
  colourSheets,
  cssDeclarations,
  literalColours,
  readColourAllowlist,
  tokenSheets,
} from './check-colours.mjs';
import {checkDesignTokens} from './check-design-tokens.mjs';
import {localeChunkProblems, planLocaleChunks} from './locale-chunks.mjs';
import {readRouteBytesBaseline, routeBytes, routeBytesOpen, routeBytesProblems} from './web-route-bytes.mjs';

// Static checks for the shipped website. The Content-Security-Policy (server/website.ts) allows scripts and styles
// from 'self' only, so inline code would silently stop working; the other rules keep review findings from returning.
const files = fs
  .readdirSync('web', {recursive: true})
  .filter(f => f.endsWith('.js'))
  .sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', 'web/' + file], {stdio: 'inherit'});
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const problems = [];
const html = fs.readdirSync('web').filter(f => f.endsWith('.html'));
for (const file of html) {
  const text = fs.readFileSync('web/' + file, 'utf8');
  // CSP: no inline scripts, style blocks, style attributes or inline event handlers.
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g))
    if (!/\bsrc=/.test(m[1]) || m[2].trim()) problems.push(file + ': inline <script> (blocked by the CSP)');
  if (/<style\b/.test(text)) problems.push(file + ': <style> block (blocked by the CSP)');
  if (/\sstyle="/.test(text)) problems.push(file + ': style attribute (blocked by the CSP)');
  if (/\son[a-z]+="/.test(text)) problems.push(file + ': inline event handler (blocked by the CSP)');
  // Every referenced asset ships.
  for (const m of text.matchAll(/(?:href|src)="\/assets\/([^"?#]+)"/g))
    if (!fs.existsSync('web/' + m[1])) problems.push(file + ': missing asset /assets/' + m[1]);
}
const index = fs.readFileSync('web/index.html', 'utf8');
// The accessibility layer must load after every other stylesheet, or later rules undo it.
const sheets = [...index.matchAll(/<link rel="stylesheet" href="\/assets\/([^"]+)">/g)].map(m => m[1]);
if (sheets.at(-1) !== 'accessibility.css')
  problems.push('index.html: accessibility.css must be the last stylesheet (found ' + sheets.join(', ') + ')');
// The design tokens live in tokens.css, which loads first; a token defined anywhere else forks the palette (F-40).
if (sheets[0] !== 'tokens.css')
  problems.push('index.html: tokens.css must be the first stylesheet (found ' + sheets.join(', ') + ')');
// WEB-07: every page's stylesheets, not only the workspace's (privacy.css and about.css were unchecked).
const stylesheets = colourSheets();
for (const html of fs.readdirSync('web').filter(f => f.endsWith('.html'))) {
  const linked = [
    ...fs.readFileSync('web/' + html, 'utf8').matchAll(/<link rel="stylesheet" href="\/assets\/([^"]+)">/g),
  ];
  if (linked.length && linked[0][1] !== 'tokens.css') problems.push(html + ': tokens.css must be the first stylesheet');
  // The static public pages can be read without JavaScript, so their dark system and the policy shades come right
  // after; the workspace needs JavaScript (theme.js sets its theme before styles load) and does not download them.
  if (html === 'index.html' && linked.some(m => m[1] === 'public-tokens.css'))
    problems.push(html + ': the workspace does not load public-tokens.css');
  if (html !== 'index.html' && linked.length && linked[1]?.[1] !== 'public-tokens.css')
    problems.push(html + ': public-tokens.css must be the second stylesheet');
}
for (const sheet of stylesheets)
  if (/(?:^|[{;\s])--[\w-]+\s*:/.test(fs.readFileSync('web/' + sheet, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')))
    problems.push(
      sheet + ': defines a design token; tokens belong in the token sheets (' + tokenSheets.join(', ') + ')',
    );
// A colour equal to a light token's value uses the token, so a palette change reaches it (F-40). Reviewed literals
// (tools/web-colour-allowlist.json) are brand marks and print colours that never follow the palette.
const hex = v => (v.length === 4 ? '#' + [...v.slice(1)].map(c => c + c).join('') : v).toLowerCase();
const tokenColours = new Map(
  cssDeclarations(tokenSheets.map(sheet => fs.readFileSync('web/' + sheet, 'utf8')).join('\n'))
    .filter(d => d.selector === ':root' && !d.atRules.length && /^#[0-9a-fA-F]{3,8}$/.test(d.value))
    .map(d => [hex(d.value), d.property.slice(2)]),
);
const allowedColours = readColourAllowlist().entries;
for (const sheet of stylesheets)
  for (const found of literalColours(fs.readFileSync('web/' + sheet, 'utf8')))
    if (
      found.literal.startsWith('#') &&
      tokenColours.has(hex(found.literal)) &&
      !allowedColours.some(
        entry => entry.file === sheet && entry.selector === found.selector && entry.property === found.property,
      )
    )
      problems.push(
        sheet + ':' + found.line + ': ' + found.literal + ' is var(--' + tokenColours.get(hex(found.literal)) + ')',
      );
// WEB-07: tokens.css sets every colour for both themes, and the literal colours left in stylesheets only go down.
const colours = checkColours();
problems.push(...colours.problems);
// The radius, shadow, motion and type scales: hand-written values only go down, and every token read exists.
const designTokens = checkDesignTokens();
problems.push(...designTokens.problems);
// WEB-05: one set of stylesheets serves both directions; a physical left/right side needs an allow-list entry.
for (const sheet of fs
  .readdirSync('web', {recursive: true})
  .filter(f => f.endsWith('.css'))
  .sort())
  problems.push(...rtlProblems(fs.readFileSync('web/' + sheet, 'utf8'), sheet.replaceAll('\\', '/')));
// A live region around the whole page reads every route change aloud; announcements use #toast and alerts.
if (/id="content"[^>]*aria-live/.test(index)) problems.push('index.html: #content must not be a live region');
if (!/<dialog id="action-dialog"[^>]*aria-labelledby="action-title"/.test(index))
  problems.push('index.html: #action-dialog (confirmAction) is missing or unnamed');
for (const file of files) {
  const text = fs.readFileSync('web/' + file, 'utf8');
  if (/\beval\s*\(|new Function\s*\(/.test(text)) problems.push(file + ': eval/new Function (blocked by the CSP)');
  if (/\.style\.[a-zA-Z]+\s*=|setAttribute\(\s*['"]style['"]/.test(text))
    problems.push(file + ': inline style write (blocked by the CSP)');
  // Destructive actions use the styled confirmAction dialog. The one synchronous navigation guard keeps confirm().
  const natives =
    [...text.matchAll(/(^|[^\w.])confirm\(/g)].length -
    (file === 'report-library.js' &&
    /function overviewMayLeave\(\)\s*\{\s*return !overviewState\.dirty\s*\|\|\s*confirm\(/.test(text)
      ? 1
      : 0);
  if (natives > 0) problems.push(file + ': native confirm() (' + natives + '); use confirmAction()');
  // F-43: every dialog has a name, nothing is placed above a page's own h1, and the sign-in pages' story column
  // carries display text rather than a heading that comes before the page's h1.
  for (const m of text.matchAll(/<dialog\b[^>]*>/g))
    if (!/\baria-(?:label|labelledby)=/.test(m[0])) problems.push(file + ': unnamed ' + m[0]);
  if (/\bcontent\.prepend\(/.test(text))
    problems.push(file + ': content.prepend() puts a section above the page heading; insert it after .page-heading');
  for (const m of text.matchAll(/class="auth-story">((?:(?!<\/section>)[\s\S])*)<\/section>/g))
    if (/<h[1-6]\b/.test(m[1]))
      problems.push(file + ': a heading in .auth-story comes before the page h1; use .auth-tagline');
  problems.push(...accountMarkupProblems(text, file));
}
for (const m of index.matchAll(/<dialog\b[^>]*>/g))
  if (!/\baria-(?:label|labelledby)=/.test(m[0])) problems.push('index.html: unnamed ' + m[0]);
const localization = checkWebLocales();
problems.push(...localization.problems);
// WEB-07: the Arabic chunks the browser loads are generated from the catalog, bounded, and carry what each page needs.
const chunkPlan = planLocaleChunks(process.cwd(), localization);
problems.push(...localeChunkProblems(process.cwd(), chunkPlan));
// WEB-06: navigation, page assets and the server's shell pages agree with the route registry.
problems.push(...checkRoutes());
// WEB-07: new markup is escape-by-default (html`…` and setHtml); the counts of markup escaped by hand only go down.
const markup = checkMarkup();
problems.push(...markup.problems);
// WEB-07: scripts extend the shell through AMCP.routes and AMCP.hooks, never by reassigning a shell function.
problems.push(...checkExtensions());
// WEB-07: no page downloads more before it renders than before WEB-07 (an open gap may not grow and must close).
const bytesNow = routeBytes(),
  bytesBaseline = readRouteBytesBaseline();
problems.push(...routeBytesProblems(bytesNow, bytesBaseline));
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(
  'Checked every shipped browser script: ' +
    files.length +
    '; HTML, CSP, assets, stylesheet order, tokens and confirmations: ' +
    html.length +
    ' pages',
);
const markupTotals = Object.values(markup.counts).reduce(
  (sum, value) => ({sinks: sum.sinks + value.sinks, unescaped: sum.unescaped + value.unescaped}),
  {sinks: 0, unescaped: 0},
);
console.log(
  'Escape-by-default markup: ' +
    markupTotals.sinks +
    ' HTML writes and ' +
    markupTotals.unescaped +
    ' unescaped values remain escaped by hand, none above the baseline.',
);
console.log(
  'Theme colours: tokens.css sets both themes; ' +
    Object.values(colours.counts).reduce((sum, count) => sum + count, 0) +
    ' literal colours remain in stylesheets, none above the baseline.',
);
console.log(
  'Design tokens: ' +
    ['radius', 'shadow', 'motion', 'type']
      .map(scale => Object.values(designTokens.counts).reduce((sum, c) => sum + c[scale], 0) + ' ' + scale)
      .join(', ') +
    ' values written by hand and ' +
    Object.values(designTokens.counts).reduce((sum, c) => sum + c.spacing, 0) +
    ' spacing values off the 4px grid, none above the baseline; every token read is defined.',
);
console.log(
  'Arabic catalog covers ' +
    localization.required_messages +
    ' explicitly selected interface messages in ' +
    Object.keys(chunkPlan.chunks).length +
    ' chunks; untranslated workflows remain tracked separately.',
);
const openBytes = routeBytesOpen(bytesNow, bytesBaseline);
console.log(
  'Route bytes: ' +
    (Object.keys(bytesNow).length - openBytes.length) +
    ' of ' +
    Object.keys(bytesNow).length +
    ' pages (both languages) at or below their bytes before WEB-07' +
    (openBytes.length
      ? '; open: ' + openBytes.map(gap => gap.key + ' ' + gap.bytes + ' of ' + gap.baseline).join(', ')
      : '') +
    '.',
);
