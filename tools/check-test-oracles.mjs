// Refusal-oracle ratchet (QA-02): a test that asserts a refusal must say which refusal. Two weak shapes are counted in
// every test file:
//   codeless  an assertion that a result failed (`success, false` or `success === false`) with no code or message
//             check on its line or the four lines after it;
//   bare      an `assert.throws(...)` or `assert.rejects(...)` without a matcher (an error code object, a RegExp, a
//             validation function or an error class), which passes on any failure, a crash included.
// tests/fixtures/test-oracle-allowance.json records the count each file may still have. The check fails when a file
// has more than its allowance (a new weak oracle) and lists files below it, whose allowance should be lowered with
// --update. Write, auth and export test files have an allowance of zero and must keep it. Use
// tests/helpers/assert-refused.mjs (or .ts): assertRefused(result, 'CODE', {writes: () => writes}).
//   node tools/check-test-oracles.mjs [--update] [--json] [file ...]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const allowanceFile = 'tests/fixtures/test-oracle-allowance.json';
/**
 * Test files whose allowance is zero, by name: the reviewed write paths (writes, reviews, deletions, spend and budget,
 * idempotency, retry, pause), sign-in, credentials and authorization, connections, and exports (Sheets, workbooks).
 */
export const zeroAllowance =
  /^tests\/[^/]*(?:write|review|delet|export|sheets|workbook|spend|budget|connection|credential|oauth|login|signin|password|mfa|door|auth|security|session|grant|token|idempot|retry|pause)[^/]*$/;
// A named failure: an error code or message, the typed helper, or a failed write outcome's own name.
const codeCheck = /\.code\b|\bcode\s*:|\bmessage\b|assertRefused|partial_or_failed|\b[A-Z][A-Z0-9]+_[A-Z0-9_]{2,}\b/;
const failed =
  /(?:\.success\s*,\s*false\b|\bsuccess\s*===\s*false\b|\bsuccess\s*!==\s*true\b|false\s*,\s*[^,;]*\.success\b)/;

/** Splits the arguments of the call whose opening parenthesis is at `open`; null when the text ends first. */
export function callArguments(text, open) {
  return callSpans(text, open)?.args.map(a => a.text) ?? null;
}
/**
 * The arguments of the call whose opening parenthesis is at `open`, each with its trimmed text and offsets, and the
 * offset of the closing parenthesis; null when the text ends first. Empty arguments (a trailing comma) are dropped.
 */
export function callSpans(text, open) {
  const args = [];
  const push = (from, to) => {
    const raw = text.slice(from, to),
      lead = raw.length - raw.trimStart().length,
      trimmed = raw.trim();
    if (trimmed) args.push({text: trimmed, start: from + lead, end: from + lead + trimmed.length});
  };
  let depth = 0,
    start = open + 1,
    i = open;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      for (i++; i < text.length && text[i] !== quote; i++) {
        if (text[i] === '\\') i++;
        else if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
          let nested = 1;
          for (i += 2; i < text.length && nested; i++) {
            if (text[i] === '{') nested++;
            else if (text[i] === '}') nested--;
          }
          i--;
        }
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) return null;
      i++;
      continue;
    }
    // A regular expression literal after an operator or an argument separator.
    if (c === '/' && /[(,=:[!&|?{};]\s*$/.test(text.slice(Math.max(0, i - 20), i))) {
      for (i++; i < text.length && text[i] !== '/'; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '[') while (i < text.length && text[i] !== ']') i += text[i] === '\\' ? 2 : 1;
      }
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      depth--;
      if (depth === 0) {
        push(start, i);
        return {args, end: i};
      }
    } else if (c === ',' && depth === 1) {
      push(start, i);
      start = i + 1;
    }
  }
  return null;
}
/** The weak oracles of one test file's text, each with its line. */
export function scan(text) {
  const sites = [],
    lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!failed.test(line) || !/assert|expect/.test(line + (lines[i - 1] ?? ''))) return;
    const window = lines.slice(i, i + 5).join('\n');
    if (!codeCheck.test(window.replace(failed, ''))) sites.push({kind: 'codeless', line: i + 1});
  });
  for (const match of text.matchAll(/\bassert\s*\.\s*(throws|rejects)\s*\(/g)) {
    const open = match.index + match[0].length - 1,
      args = callArguments(text, open);
    if (!args) continue;
    const matcher = args[1];
    // A second argument that is only a message string does not check the error.
    if (!matcher || /^['"`]/.test(matcher))
      sites.push({kind: 'bare', line: text.slice(0, match.index).split('\n').length, call: match[1], open});
  }
  return sites;
}
export function testFiles(dir = path.join(root, 'tests')) {
  return fs
    .readdirSync(dir)
    .filter(n => /\.test\.(?:ts|mjs)$/.test(n))
    .sort()
    .map(n => 'tests/' + n);
}
export function counts(files) {
  const out = {};
  for (const file of files) {
    const sites = scan(fs.readFileSync(path.resolve(root, file), 'utf8'));
    const c = {
      codeless: sites.filter(s => s.kind === 'codeless').length,
      bare: sites.filter(s => s.kind === 'bare').length,
    };
    if (c.codeless || c.bare) out[file] = {...c, sites};
  }
  return out;
}
export function compareAllowance(found, allowance) {
  const over = [],
    under = [];
  for (const [file, c] of Object.entries(found)) {
    const allowed = zeroAllowance.test(file) ? {codeless: 0, bare: 0} : (allowance[file] ?? {codeless: 0, bare: 0});
    for (const kind of ['codeless', 'bare'])
      if (c[kind] > allowed[kind])
        over.push({file, kind, found: c[kind], allowed: allowed[kind], sites: c.sites.filter(s => s.kind === kind)});
  }
  for (const [file, allowed] of Object.entries(allowance))
    for (const kind of ['codeless', 'bare'])
      if ((found[file]?.[kind] ?? 0) < allowed[kind])
        under.push({file, kind, found: found[file]?.[kind] ?? 0, allowed: allowed[kind]});
  return {over, under};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const named = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const files = named.length ? named.map(f => f.replaceAll('\\', '/')) : testFiles();
  const found = counts(files);
  const file = path.join(root, allowanceFile);
  if (process.argv.includes('--update')) {
    const allowance = Object.fromEntries(
      Object.entries(found)
        .filter(([f]) => !zeroAllowance.test(f))
        .map(([f, c]) => [f, {codeless: c.codeless, bare: c.bare}]),
    );
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          description:
            'Weak refusal oracles each test file may still have (QA-02, tools/check-test-oracles.mjs). Lower a count when a file is converted; never raise one. Write, auth and export test files are held at zero by the tool.',
          allowance,
        },
        null,
        2,
      ) + '\n',
    );
  }
  const allowance = JSON.parse(fs.readFileSync(file, 'utf8')).allowance;
  const scope = named.length
    ? Object.fromEntries(Object.entries(allowance).filter(([f]) => files.includes(f)))
    : allowance;
  const result = compareAllowance(found, scope);
  const total = Object.values(found).reduce((n, c) => ({codeless: n.codeless + c.codeless, bare: n.bare + c.bare}), {
    codeless: 0,
    bare: 0,
  });
  if (process.argv.includes('--json')) console.log(JSON.stringify({files: files.length, total, ...result}, null, 2));
  else {
    console.log(
      files.length +
        ' test files; ' +
        total.codeless +
        ' code-less refusal assertions, ' +
        total.bare +
        ' bare throws/rejects',
    );
    for (const o of result.over)
      console.log(
        'NEW WEAK ORACLE ' +
          o.file +
          ' ' +
          o.kind +
          ' ' +
          o.found +
          ' > ' +
          o.allowed +
          ' (lines ' +
          o.sites.map(s => s.line).join(', ') +
          ')',
      );
    for (const u of result.under)
      console.log('lower the allowance: ' + u.file + ' ' + u.kind + ' ' + u.found + ' < ' + u.allowed);
  }
  process.exitCode = result.over.length ? 1 : 0;
}
