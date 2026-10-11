// Mutant catalogue runner (QA-02 step 5). Each catalogued mutant is one small, deliberate defect in a guard that a
// test is supposed to catch: a narrowed CSV formula guard, a `<=` turned into `<`, a dropped field. The runner copies
// a fresh candidate (the tracked and untracked source files plus the built dist/) into a scratch directory, applies one
// catalogued edit at a time to the compiled module the tests import, runs the mutant's named killing tests and, when
// they all pass, the critical set (tools/related-tests.mjs), then restores the module. A mutant is
//   killed     a named test (or, failing that, a critical test) fails;
//   timeout    the tests did not finish in time (counted as killed, reported apart);
//   survived   every test passed: the guard is unprotected;
//   invalid    the edit no longer matches exactly once, or the mutated module does not parse (the catalogue is stale).
// Release qualification (tools/qualify.mjs, full profile) requires every catalogued mutant killed. Nothing here
// touches the checkout: the scratch copy lives under .runtime/mutants/ (ignored) and is removed afterwards.
//   node tools/mutants.mjs [--only <id>[,<id>...]] [--json] [--record <file>] [--keep-scratch] [--timeout <ms>]
//                          [--root <candidate>] [--catalogue <file>]
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {criticalTests} from './related-tests.mjs';

const here = fileURLToPath(new URL('..', import.meta.url));
export const catalogueFile = 'tests/fixtures/mutant-catalogue.json';
/** Never copied into the scratch candidate: VCS data, dependencies, local runtime state and retained live samples. */
const excluded =
  /^(?:\.git(?:\/|$)|node_modules(?:\/|$)|\.runtime\/|\.release\/|\.claude\/|coverage\/|\.mirror\/RESULTS\/|\.mirror\/PRIVATE\/)/;

/** The compiled module a test imports for a catalogued source file: src/x.ts -> dist/src/x.js. */
export const compiledPath = file => 'dist/' + file.replace(/\.ts$/, '.js');
/** The file Node runs for a test: a TypeScript test runs from its compiled twin. */
export const testTarget = file => (file.endsWith('.ts') ? 'dist/' + file.replace(/\.ts$/, '.js') : file);
/**
 * Every span of `text` that `find` matches. Whitespace runs in `find` match any whitespace run, so an edit survives
 * reformatting of the compiled output; everything else is literal.
 */
export function locate(text, find) {
  const pattern = find
    .trim()
    .split(/\s+/)
    .map(part => part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
    .join('\\s+');
  return [...text.matchAll(new RegExp(pattern, 'g'))].map(m => ({start: m.index, end: m.index + m[0].length}));
}
/** The mutated text; throws when the edit does not match exactly once. */
export function applyMutant(text, mutant) {
  const spans = locate(text, mutant.find);
  if (spans.length !== 1) throw new Error(mutant.id + ': the edit matches ' + spans.length + ' times, not once');
  const [{start, end}] = spans;
  return text.slice(0, start) + mutant.replace + text.slice(end);
}
/** Problems with the catalogue's shape or with its edits against the candidate at `root`. */
export function checkCatalogue(catalogue, root = here) {
  const problems = [],
    ids = new Set();
  if (!Array.isArray(catalogue.mutants) || !catalogue.mutants.length) return ['the catalogue lists no mutants'];
  for (const m of catalogue.mutants) {
    const where = m?.id ?? JSON.stringify(m).slice(0, 80);
    if (!/^[A-Z]\d+(?:-[a-z0-9]+)+$/.test(m?.id ?? '')) problems.push(where + ': id must look like M12-what-it-breaks');
    if (ids.has(m.id)) problems.push(where + ': duplicate id');
    ids.add(m.id);
    for (const key of ['guards', 'file', 'find'])
      if (typeof m[key] !== 'string' || !m[key].trim()) problems.push(where + ': ' + key + ' is required');
    if (typeof m.replace !== 'string') problems.push(where + ': replace is required (it may be empty)');
    if (m.find === m.replace) problems.push(where + ': replace equals find');
    if (!Array.isArray(m.tests) || !m.tests.length) problems.push(where + ': name at least one killing test');
    if (typeof m.file !== 'string' || !/^(?:src|server)\/[A-Za-z0-9._/-]+\.ts$/.test(m.file)) {
      problems.push(where + ': file must be a src/ or server/ TypeScript module');
      continue;
    }
    for (const t of m.tests ?? [])
      if (!/^tests\/[A-Za-z0-9._/-]+\.test\.(?:ts|mjs)$/.test(t) || !fs.existsSync(path.join(root, t)))
        problems.push(where + ': killing test missing: ' + t);
    const compiled = path.join(root, compiledPath(m.file));
    if (!fs.existsSync(compiled)) {
      problems.push(where + ': ' + compiledPath(m.file) + ' is missing (build first)');
      continue;
    }
    const n = locate(fs.readFileSync(compiled, 'utf8'), m.find).length;
    if (n !== 1) problems.push(where + ': the edit matches ' + n + ' times in ' + compiledPath(m.file) + ', not once');
  }
  return problems;
}

/** The candidate's files: tracked and untracked (not ignored) source files when it is a Git checkout, else a walk. */
function candidateFiles(root) {
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {cwd: root, encoding: 'utf8'});
  const isRoot = git.status === 0 && top.status === 0 && path.resolve(top.stdout.trim()) === path.resolve(root);
  const listed = isRoot ? git.stdout.split('\0').filter(Boolean) : walk(root, '');
  return listed.filter(f => !excluded.test(f) && !f.startsWith('dist/') && fs.existsSync(path.join(root, f)));
}
/** Files under `dir`, never entering an excluded directory or following a link (node_modules may be a junction). */
function walk(root, dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), {withFileTypes: true})) {
    const rel = dir ? dir + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink() || excluded.test(rel + (entry.isDirectory() ? '/' : '')) || rel === 'dist') continue;
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}
/** Copies a fresh candidate (source files plus the built dist/) into `scratch`. */
export function prepareScratch(root, scratch) {
  if (!fs.existsSync(path.join(root, 'dist'))) throw new Error('dist/ is missing: run npm run build first');
  fs.mkdirSync(scratch, {recursive: true});
  for (const file of candidateFiles(root)) {
    fs.mkdirSync(path.dirname(path.join(scratch, file)), {recursive: true});
    fs.copyFileSync(path.join(root, file), path.join(scratch, file));
  }
  fs.cpSync(path.join(root, 'dist'), path.join(scratch, 'dist'), {recursive: true});
}
/** Names of the failing tests in TAP output, at most five. */
export function failingTests(output) {
  return [...String(output).matchAll(/^\s*not ok \d+ - (.+?)(?: # .*)?$/gm)]
    .map(m => m[1].trim())
    .filter((name, i, all) => all.indexOf(name) === i && !/\.test\.(?:js|mjs)$/.test(name))
    .slice(0, 5);
}
function runTests(scratch, tests, timeout) {
  const started = Date.now(),
    run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests.map(testTarget)], {
      cwd: scratch,
      encoding: 'utf8',
      timeout,
      maxBuffer: 256 * 1024 * 1024,
      env: cleanEnv(),
    });
  return {
    passed: run.status === 0 && !run.error,
    timedOut: run.error?.code === 'ETIMEDOUT' || run.signal === 'SIGTERM',
    failing: failingTests(run.stdout),
    tail: (run.stdout + run.stderr).slice(-1500),
    ms: Date.now() - started,
  };
}
/**
 * The environment of a child run: inherited, except what would change how the child runs. Inside a test run, Node sets
 * NODE_TEST_CONTEXT, and a child `node --test` that inherits it reports to that parent and exits 0 whatever failed.
 */
function cleanEnv() {
  const env = {...process.env, NODE_OPTIONS: ''};
  delete env.NODE_TEST_CONTEXT;
  return env;
}
/** Whether a compiled module still parses, as the ES module it is. */
const parses = (scratch, file) =>
  spawnSync(process.execPath, ['--input-type=module', '--check'], {
    cwd: scratch,
    encoding: 'utf8',
    input: fs.readFileSync(path.join(scratch, file), 'utf8'),
    env: cleanEnv(),
  }).status === 0;

/**
 * Runs `catalogue` against the candidate at `root`. Returns the per-mutant results and the totals; `baseline` holds
 * the unmutated run of every named test, which must pass for any result to mean something.
 */
export function runMutants({
  root = here,
  catalogue,
  only,
  timeout = 300000,
  scratch = path.join(root, '.runtime', 'mutants', randomUUID()),
  keep = false,
  critical = criticalTests,
  log = () => {},
}) {
  const selected = catalogue.mutants.filter(m => !only?.length || only.includes(m.id));
  const named = [...new Set(selected.flatMap(m => m.tests))].sort();
  const identity = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, 'dist/release-identity.json'), 'utf8')).sha256 ?? null;
    } catch {
      return null;
    }
  })();
  const report = {candidate_package_sha256: identity, mutants: [], totals: {}};
  try {
    prepareScratch(root, scratch);
    const criticalSet = critical.filter(t => fs.existsSync(path.join(scratch, t)));
    log('baseline: ' + named.length + ' named test files');
    const base = runTests(scratch, named, timeout * 2);
    report.baseline = {passed: base.passed, failing: base.failing, ms: base.ms};
    if (!base.passed) {
      report.baseline.tail = base.tail;
      return finish(report);
    }
    for (const m of selected) {
      const file = path.join(scratch, compiledPath(m.file)),
        original = fs.readFileSync(file, 'utf8');
      let result;
      try {
        let mutated;
        try {
          mutated = applyMutant(original, m);
        } catch (error) {
          result = {status: 'invalid', reason: error.message};
        }
        if (mutated !== undefined) {
          fs.writeFileSync(file, mutated);
          if (!parses(scratch, compiledPath(m.file)))
            result = {status: 'invalid', reason: 'the mutated module does not parse'};
          else {
            const first = runTests(scratch, m.tests, timeout);
            if (first.timedOut) result = {status: 'timeout', killed_by: 'named', ms: first.ms};
            else if (!first.passed)
              result = {status: 'killed', killed_by: 'named', failing: first.failing, ms: first.ms};
            else {
              const rest = criticalSet.filter(t => !m.tests.includes(t));
              const second = rest.length ? runTests(scratch, rest, timeout) : {passed: true, ms: 0};
              result = second.timedOut
                ? {status: 'timeout', killed_by: 'critical', ms: first.ms + second.ms}
                : second.passed
                  ? {status: 'survived', ms: first.ms + second.ms}
                  : {status: 'killed', killed_by: 'critical', failing: second.failing, ms: first.ms + second.ms};
            }
          }
        }
      } finally {
        fs.writeFileSync(file, original);
      }
      report.mutants.push({id: m.id, file: m.file, guards: m.guards, ...result});
      log(m.id + ': ' + result.status + (result.failing?.length ? ' (' + result.failing[0] + ')' : ''));
    }
    return finish(report);
  } finally {
    if (!keep) fs.rmSync(scratch, {recursive: true, force: true});
  }
}
function finish(report) {
  const count = status => report.mutants.filter(m => m.status === status).length;
  report.totals = {
    catalogued: report.mutants.length,
    killed: count('killed'),
    timeout: count('timeout'),
    survived: count('survived'),
    invalid: count('invalid'),
  };
  report.passed =
    report.baseline?.passed === true &&
    report.mutants.length > 0 &&
    report.totals.survived === 0 &&
    report.totals.invalid === 0;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    option = name => {
      const i = args.indexOf(name);
      return i >= 0 ? args[i + 1] : undefined;
    };
  const root = path.resolve(option('--root') ?? here),
    catalogue = JSON.parse(fs.readFileSync(path.resolve(root, option('--catalogue') ?? catalogueFile), 'utf8'));
  const problems = checkCatalogue(catalogue, root);
  if (problems.length) {
    for (const p of problems) console.error('MUTANT_CATALOGUE_INVALID ' + p);
    process.exit(1);
  }
  const report = runMutants({
    root,
    catalogue,
    only: option('--only')?.split(','),
    timeout: Number(option('--timeout') ?? 300000),
    keep: args.includes('--keep-scratch'),
    log: args.includes('--json') ? () => {} : line => console.log(line),
  });
  if (option('--record')) fs.writeFileSync(path.resolve(option('--record')), JSON.stringify(report, null, 2) + '\n');
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    if (report.baseline && !report.baseline.passed)
      console.log('BASELINE FAILED: the named tests fail without any mutant\n' + report.baseline.tail);
    const t = report.totals;
    console.log(
      t.catalogued +
        ' mutants: ' +
        t.killed +
        ' killed, ' +
        t.timeout +
        ' timed out, ' +
        t.survived +
        ' survived, ' +
        t.invalid +
        ' invalid',
    );
    for (const m of report.mutants.filter(m => m.status === 'survived' || m.status === 'invalid'))
      console.log((m.status === 'survived' ? 'SURVIVED ' : 'INVALID ') + m.id + ': ' + (m.reason ?? m.guards));
  }
  process.exitCode = report.passed ? 0 : 1;
}
