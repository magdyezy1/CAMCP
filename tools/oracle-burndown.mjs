// Burn-down helper for the refusal-oracle ratchet (QA-02, tools/check-test-oracles.mjs). It never guesses a code: it
// runs the named test files once with each weak oracle instrumented (tests/helpers/oracle-capture.*), records what
// every site actually saw, restores the files, and rewrites only the sites whose every observation was a named
// refusal: `assert.equal(x.success, false)` becomes `assertRefused(x, 'CODE')`, and a bare throws/rejects gets
// `{code: 'CODE'}` (or `e => assertRefused(e, [...])` when a loop sees several codes). A site that saw a crash
// (INTERNAL_ERROR, a Node ERR_* or a TypeError), an error without a code, or was never reached is listed for a person
// to review; it is left as it was. Run the tests and `node tools/check-test-oracles.mjs --update` afterwards.
//   node tools/oracle-burndown.mjs [--dry-run] tests/<file>.test.(mjs|ts) ...
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {callSpans, scan} from './check-test-oracles.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const named = code => typeof code === 'string' && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$|^[A-Z]{4,}$/.test(code);
const crash = code => code === 'INTERNAL_ERROR' || /^ERR_/.test(String(code));
const genericErrors = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'AssertionError']);
const specifier = (file, helper) => './helpers/' + helper + (file.endsWith('.ts') ? '.js' : '.mjs');

/** The `assert.equal(<x>.success, false[, message])` call around a code-less site; undefined for any other shape. */
export function refusalAssertion(text, line) {
  const lines = text.split('\n'),
    lineStart = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0),
    successAt = text.indexOf('.success', lineStart);
  if (successAt < 0 || successAt > lineStart + lines[line - 1].length) return undefined;
  let found;
  for (const match of text.matchAll(/\bassert\s*\.\s*(?:equal|strictEqual)\s*\(/g)) {
    if (match.index > successAt) break;
    const spans = callSpans(text, match.index + match[0].length - 1);
    if (spans && spans.end > successAt) found = {start: match.index, ...spans};
  }
  if (!found || found.args.length < 2) return undefined;
  const [first, second] = found.args;
  if (second.text === 'false' && /\.success$/.test(first.text))
    return {start: found.start, end: found.end + 1, expression: first, value: first.text.slice(0, -'.success'.length)};
  if (first.text === 'false' && /\.success$/.test(second.text))
    return {
      start: found.start,
      end: found.end + 1,
      expression: second,
      value: second.text.slice(0, -'.success'.length),
    };
  return undefined;
}
const unwrap = expression => {
  const t = expression.trim();
  if (!t.startsWith('(') || !t.endsWith(')')) return t;
  const spans = callSpans(t, 0);
  return spans && spans.end === t.length - 1 && spans.args.length === 1 ? unwrap(spans.args[0].text) : t;
};
const quoted = codes =>
  codes.length === 1 ? "'" + codes[0] + "'" : '[' + codes.map(c => "'" + c + "'").join(', ') + ']';
function addImport(text, file, helper, names) {
  if (text.includes(specifier(file, helper))) return text;
  const statement = 'import {' + names.join(', ') + "} from '" + specifier(file, helper) + "';\n";
  let last = -1;
  for (const match of text.matchAll(/^import\b[\s\S]*?['"];?[ \t]*$/gm)) last = match.index + match[0].length;
  return last < 0 ? statement + text : text.slice(0, last + 1) + statement + text.slice(last + 1);
}

/** The instrumented text of one file and the sites it instruments. */
export function instrument(file, text) {
  const edits = [],
    sites = [];
  for (const site of scan(text).sort((a, b) => a.line - b.line)) {
    const id = file + '#' + sites.length;
    if (site.kind === 'codeless') {
      const a = refusalAssertion(text, site.line);
      if (!a) {
        sites.push({...site, id, skip: 'not an assert.equal(<result>.success, false) shape'});
        continue;
      }
      edits.push({
        start: a.expression.start,
        end: a.expression.end,
        text: '__oracleRefusal(' + JSON.stringify(id) + ', ' + a.value + ').success',
      });
      sites.push({...site, id, assertion: a});
    } else {
      const spans = callSpans(text, site.open);
      edits.push({
        start: spans.args[0].end,
        end: spans.args[0].end,
        text: ', __oracleThrown(' + JSON.stringify(id) + ')',
      });
      sites.push({...site, id, spans});
    }
  }
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return {
    text: edits.length ? addImport(out, file, 'oracle-capture', ['__oracleRefusal', '__oracleThrown']) : out,
    sites,
  };
}

/** Decides each site from its observations: a rewrite, or a reason a person must look at it. */
export function decide(site, seen) {
  if (site.skip) return {manual: site.skip};
  if (!seen.length) return {manual: 'not reached in this run'};
  if (site.kind === 'codeless') {
    if (seen.some(s => s.success !== false)) return {manual: 'the value was not a service refusal'};
    const codes = [...new Set(seen.map(s => s.code))];
    if (codes.some(c => !named(c) || crash(c)))
      return {manual: 'saw ' + codes.map(String).join(', ') + ' (a crash or no code)'};
    return {replace: 'assertRefused(' + unwrap(site.assertion.value) + ', ' + quoted(codes) + ')', codes};
  }
  const codes = [...new Set(seen.map(s => s.code))];
  if (codes.every(c => named(c) && !crash(c)))
    return {
      matcher: codes.length === 1 ? "{code: '" + codes[0] + "'}" : 'e => assertRefused(e, ' + quoted(codes) + ')',
      codes,
    };
  const names = [...new Set(seen.map(s => s.name))];
  if (codes.every(c => c === null) && names.length === 1 && names[0] && !genericErrors.has(names[0]))
    return {matcher: "{name: '" + names[0] + "'}", codes: names};
  return {
    manual:
      'saw ' +
      seen
        .slice(0, 3)
        .map(s => (s.code ?? s.name) + ': ' + s.message)
        .join(' | '),
  };
}

/** The rewritten text of one file from its decisions; unchanged sites stay as they were. */
export function rewrite(file, text, sites, decisions) {
  const edits = [];
  sites.forEach((site, i) => {
    const d = decisions[i];
    if (d.replace) edits.push({start: site.assertion.start, end: site.assertion.end, text: d.replace});
    if (d.matcher) {
      const spans = callSpans(text, site.open);
      edits.push({start: spans.args[0].end, end: spans.args[0].end, text: ', ' + d.matcher});
    }
  });
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  if (/\bassertRefused\(/.test(out) && !/import\s*\{[^}]*\bassertRefused\b/.test(out))
    out = addImport(out, file, 'assert-refused', ['assertRefused']);
  return out;
}

function runFiles(files, log) {
  const env = {...process.env, ORACLE_CAPTURE_LOG: log};
  if (files.some(f => f.endsWith('.ts'))) {
    const build = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
      cwd: root,
      encoding: 'utf8',
    });
    if (build.status !== 0) throw new Error('TypeScript build failed:\n' + build.stdout + build.stderr);
  }
  const targets = files.map(f => (f.endsWith('.ts') ? 'dist/' + f.replace(/\.ts$/, '.js') : f));
  return spawnSync(process.execPath, ['--test', '--test-reporter=dot', ...targets], {cwd: root, env, encoding: 'utf8'});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dry = process.argv.includes('--dry-run'),
    files = process.argv
      .slice(2)
      .filter(a => !a.startsWith('--'))
      .map(f => f.replaceAll('\\', '/'));
  const originals = new Map(files.map(f => [f, fs.readFileSync(path.join(root, f), 'utf8')])),
    plans = new Map(),
    log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-oracle-burndown-')), 'capture.jsonl');
  let run;
  try {
    for (const [file, text] of originals) {
      const plan = instrument(file, text);
      plans.set(file, plan);
      fs.writeFileSync(path.join(root, file), plan.text);
    }
    run = runFiles(files, log);
  } finally {
    for (const [file, text] of originals) fs.writeFileSync(path.join(root, file), text);
  }
  const seen = new Map();
  if (fs.existsSync(log))
    for (const line of fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      seen.set(entry.site, [...(seen.get(entry.site) ?? []), entry]);
    }
  const report = {test_exit: run.status, files: []};
  for (const [file, plan] of plans) {
    const decisions = plan.sites.map(site => decide(site, seen.get(site.id) ?? []));
    const converted = decisions.filter(d => !d.manual).length;
    if (!dry && converted)
      fs.writeFileSync(path.join(root, file), rewrite(file, originals.get(file), plan.sites, decisions));
    report.files.push({
      file,
      converted,
      manual: plan.sites
        .map((s, i) => ({line: s.line, kind: s.kind, reason: decisions[i].manual}))
        .filter(m => m.reason),
    });
  }
  if (run.status !== 0) report.test_output = (run.stdout + run.stderr).slice(-4000);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = run.status === 0 ? 0 : 1;
}
