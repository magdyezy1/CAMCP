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
    /function overviewMayLeave\(\)\{return !overviewState\.dirty\|\|confirm\(/.test(text)
      ? 1
      : 0);
  if (natives > 0) problems.push(file + ': native confirm() (' + natives + '); use confirmAction()');
}
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
