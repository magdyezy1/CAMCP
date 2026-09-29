import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

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
for (const sheet of sheets.slice(1))
  if (/(?:^|[{;\s])--[\w-]+\s*:/.test(fs.readFileSync('web/' + sheet, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')))
    problems.push(sheet + ': defines a design token; tokens belong in tokens.css');
// A colour equal to a token's value uses the token, so a palette change reaches it (F-40).
const hex = v => (v.length === 4 ? '#' + [...v.slice(1)].map(c => c + c).join('') : v).toLowerCase();
const tokenColours = new Map(
  [...fs.readFileSync('web/tokens.css', 'utf8').matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)].map(m => [
    hex(m[2]),
    m[1],
  ]),
);
for (const sheet of sheets.slice(1))
  for (const m of fs
    .readFileSync('web/' + sheet, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/#[0-9a-fA-F]{3,8}\b/g))
    if (tokenColours.has(hex(m[0])))
      problems.push(sheet + ': ' + m[0] + ' is var(--' + tokenColours.get(hex(m[0])) + ')');
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
}
for (const m of index.matchAll(/<dialog\b[^>]*>/g))
  if (!/\baria-(?:label|labelledby)=/.test(m[0])) problems.push('index.html: unnamed ' + m[0]);
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
