// Runs the tests related to changed files (QA-01): the changed tests themselves, every test whose transitive import
// closure contains a changed module, the tests that read a changed web/ file as text, every test that builds web/ paths when
// it runs (readsWebDynamically: a change to any web/ file selects it), the suites that enumerate their inputs at run time
// (dynamicSuites), and a small critical set (write review, write outcome, review state, spend policy,
// transport, store, Sheets, reporting). When src/, server/, tools/, docs/, generated/, codegen/ or .mirror/ change it
// also runs the deterministic freshness checks, so a stale tracked report fails here instead of first in Railway's
// build. It builds as `npm run build` does (buildSteps), so a fresh tree has dist/release-identity.json too.
// Usage: npm run test:related [-- [--direct] [--plan] file ...]   (default: files changed against HEAD, plus untracked)
//   --direct  the previous behavior: changed tests and tests whose text names a changed module (no closure, no extras)
//   --plan    print the selection as JSON without building or running anything
// This is a fast inner loop; `npm run check:fast` and the full `npm run check` remain the gates.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {importSpecifiers} from './qualification-inputs.mjs';
import {allowanceFile, registryFile, scanRoots} from './check-storage-boundary.mjs';

export const criticalTests = [
  'tests/write-review.test.ts',
  'tests/write-evidence.test.ts',
  'tests/review-state.test.ts',
  'tests/spend-policy.test.ts',
  'tests/transport.test.ts',
  'tests/sqlite-diagnostics.test.mjs',
  'tests/sheets-authority.test.mjs',
  'tests/reporting-overview.test.ts',
  // ARC-04: any backend change can move a top-level read into an import cycle; the guard imports every module first.
  'tests/import-order.test.mjs',
];
export const freshnessChecks = [
  {name: 'report_check', args: ['dist/tools/report.js', '--check']},
  {name: 'docs_index_check', args: ['tools/docs-index.mjs', '--check']},
  {name: 'contracts_check', args: ['dist/tools/generate-contracts.js', '--check']},
  {name: 'contracts_actions_check', args: ['dist/tools/action-contracts.js', '--check']},
  // ARC-03: generated-artifact provenance (capture evidence, frozen catalog, Apple SDK evidence, embedded inputs).
  {name: 'generated_provenance_check', args: ['tools/generated-provenance.mjs', '--check']},
  {name: 'architecture_check', args: ['tools/architecture-map.mjs', '--check']},
];
/**
 * What `npm run build` runs, in order: the compiler, then the release identity that tests reading
 * dist/release-identity.json need (serverInfo, /versionz). A step runs only after the one before it succeeded.
 */
export const buildSteps = [
  {name: 'tsc', args: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']},
  {name: 'release_identity', args: ['tools/build-release-identity.mjs']},
];
/** Runs the build steps with `spawn` (spawnSync's signature); the exit status of the first failing step, else 0. */
export function runBuild(spawn = spawnSync) {
  for (const step of buildSteps) {
    const result = spawn(process.execPath, step.args, {stdio: 'inherit'});
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}
/**
 * The selection runs in batches, never as one command (package docs, item 8): a change to a shared module selects about a
 * thousand files, and Windows refuses a command line past 32,767 characters (spawn ENAMETOOLONG), so one `node --test <every
 * file>` could not start there. A batch holds at most `testBatchSize` files and `testBatchCharacters` characters of file
 * names (each counted with its separator), far under that limit and under every host's.
 */
export const testBatchSize = 60;
export const testBatchCharacters = 8000;
/** The files split into batches of at most `size` files and `characters` characters, in order. A name over the budget stands alone. */
export function testBatches(files, size = testBatchSize, characters = testBatchCharacters) {
  const batches = [];
  let batch = [],
    used = 0;
  for (const file of files) {
    if (batch.length && (batch.length >= size || used + file.length + 1 > characters)) {
      batches.push(batch);
      batch = [];
      used = 0;
    }
    batch.push(file);
    used += file.length + 1;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
/**
 * Runs the test files with `node --test`, one command per batch (`spawn` has spawnSync's signature). Every batch runs, so a
 * failure does not hide the rest of the selection; the status is the first failing batch's (a killed one is 1), else 0.
 */
export function runTests(files, spawn = spawnSync) {
  let status = 0;
  for (const batch of testBatches(files)) {
    const result = spawn(process.execPath, ['--test', ...batch], {stdio: 'inherit'});
    if (status === 0 && (result.status ?? 1) !== 0) status = result.status ?? 1;
  }
  return status;
}
/** The mutant catalogue tools/mutants.mjs applies (not imported here: mutants.mjs imports this module). */
export const mutantCatalogue = 'tests/fixtures/mutant-catalogue.json';
const backendSource = file => scanRoots.some(root => file.startsWith(root + '/')) && /\.ts$/.test(file);
/**
 * Suites that enumerate the files they check when they run, so no import edge leads to them (three wave 4a merge
 * follow-ups came from these). Each is selected when a changed file is one of its inputs:
 *   mutants               a catalogued module or killing test, or the catalogue: every edit must still apply exactly once
 *   web-locale-chunks     web/ files and the TypeScript sources whose literals assign Arabic messages to chunks
 *   storage-boundary      the src/ and server/ modules it scans for SQL, its allowance and the document-kind registry
 *   root-independent-cli  every test file, which it scans for a bare admin CLI spawn, and the tools/, server/, src/ and
 *                         deploy/ modules it scans for an entry point that refuses root
 */
export const dynamicSuites = [
  {
    test: 'tests/mutants.test.mjs',
    inputs: (file, root) => {
      if (file === mutantCatalogue) return true;
      let catalogue;
      try {
        catalogue = JSON.parse(fs.readFileSync(path.join(root, mutantCatalogue), 'utf8'));
      } catch {
        return false;
      }
      return (catalogue.mutants ?? []).some(m => m.file === file || (m.tests ?? []).includes(file));
    },
  },
  {
    test: 'tests/web-locale-chunks.test.mjs',
    inputs: file => file.startsWith('web/') || (/^(?:src|server)\//.test(file) && /\.ts$/.test(file)),
  },
  {
    test: 'tests/storage-boundary.test.mjs',
    inputs: file => backendSource(file) || file === allowanceFile || file === registryFile,
  },
  {
    test: 'tests/root-independent-cli.test.mjs',
    inputs: file => /^(?:tests|tools|server|src|deploy)\/.+\.(?:ts|mjs|js)$/.test(file),
  },
];
const freshnessScope = /^(?:src|server|tools|docs|generated|codegen|\.mirror)\//;
const graphRoots = ['src', 'server', 'tools', 'tests', 'generated', 'codegen'];
const posix = file => file.replaceAll('\\', '/');
/**
 * How a file reads web/ without naming one file the planner could match (closing-small, after Merge C found tests outside the
 * selection): a path built when it runs (`'web/' + name`, `` `web/${name}` ``), the directory itself given to a call, listed in a
 * list of roots or defaulted (`path.join(root, 'web', name)`, `readdirSync('web')`, `['docs', 'web']`, `dir ?? 'web'`,
 * `'web/locales'`, `'../web'`), the website's asset server over it (`createPublicAssets(...)`), an asset URL built when it
 * runs (`'/assets/' + name`) or the `AMCP_TEST_WEB_ROOT` switch. Any file under web/ may break such a reader, so every change
 * under web/ selects the tests that reach one. These are the tests, helpers, fixtures and tools; `webServingReads` are the
 * few patterns for src/ and server/, where a bare 'web' is also a data value (a list of directories, a content type) and the
 * website's own modules say what they serve. The patterns are wide on purpose and comments are not stripped: a test selected
 * without need costs one run, one missed costs a late failure. (Checked against an fs trace of all test files: no test read
 * a web/ file that neither a pattern nor a literal name selected.)
 */
const sharedWebReads = [
  /\bweb\/(?:['"`]\s*\+|\$\{)/,
  /\?\?\s*(['"`])web\1/,
  /\bcreatePublicAssets\(/,
  /AMCP_TEST_WEB_ROOT/,
];
export const dynamicWebReads = [
  ...sharedWebReads,
  /(['"`])web\1\s*[,)\]]/,
  /['"`](?:\.{1,2}\/|\/)web(?:\/(?:[\w.-]+\/)*[\w-]*)?['"`]|['"`]web\/(?:[\w.-]+\/)*[\w-]+['"`]/,
  /\/assets\/(?:['"`]|\$\{)/,
];
export const webServingReads = [...sharedWebReads, /\b(?:join|resolve|relative)\((?:[^()\n]*,)?\s*(['"`])web\1/];
export const readsWebDynamically = (text, backend = false) =>
  (backend ? webServingReads : dynamicWebReads).some(pattern => pattern.test(text));
/** The planner and its own test write those patterns as data, in code and in comments: they build no web/ path. */
const patternFiles = new Set(['tools/related-tests.mjs', 'tests/related-tests-selection.test.mjs']);
/** The files whose own text says how they read web/: tests, their helpers and fixtures, the tools they import and the website. */
const webReaderCandidate = file => /^(?:tests|tools|src|server)\/.+\.(?:ts|mjs|js|cjs)$/.test(file);

function listFiles(root, directory) {
  const out = [];
  const visit = relative => {
    let children;
    try {
      children = fs.readdirSync(path.join(root, relative), {withFileTypes: true});
    } catch {
      return;
    }
    for (const child of children) {
      const file = relative + '/' + child.name;
      if (child.isDirectory()) {
        if (child.name !== 'node_modules' && !child.name.startsWith('.')) visit(file);
      } else if (child.isFile() && /\.(?:ts|mjs|js|json)$/.test(child.name) && !/\.d\.ts$/.test(child.name))
        out.push(file);
    }
  };
  visit(directory);
  return out;
}

/** Maps a specifier written in `from` to the repository source file it loads (dist paths map back to sources). */
export function resolveSource(root, from, specifier) {
  let target = posix(path.relative(root, path.resolve(root, path.dirname(from), specifier)));
  if (target.startsWith('..')) return undefined;
  if (target.startsWith('dist/')) target = target.slice(5);
  if (fs.existsSync(path.join(root, target)) && !target.endsWith('.js')) return target;
  const typescript = target.replace(/\.js$/, '.ts');
  if (target.endsWith('.js') && fs.existsSync(path.join(root, typescript))) return typescript;
  return fs.existsSync(path.join(root, target)) ? target : undefined;
}

/** Forward import edges between repository sources (TypeScript, modules and JSON). */
export function importGraph(root) {
  const graph = new Map();
  for (const directory of graphRoots)
    for (const file of listFiles(root, directory)) {
      if (file.endsWith('.json')) {
        graph.set(file, new Set());
        continue;
      }
      const text = fs.readFileSync(path.join(root, file), 'utf8'),
        edges = new Set();
      for (const specifier of importSpecifiers(text)) {
        const target = resolveSource(root, file, specifier);
        if (target) edges.add(target);
      }
      graph.set(file, edges);
    }
  return graph;
}

/** Every test file and the plan for the changed files. */
export function relatedPlan({root = process.cwd(), changed, direct = false}) {
  root = fs.realpathSync(root);
  const tests = fs
    .readdirSync(path.join(root, 'tests'))
    .filter(f => /\.test\.(ts|mjs)$/.test(f))
    .map(f => 'tests/' + f)
    .sort();
  const files = changed.map(posix);
  const selected = new Map(),
    add = (test, reason) => {
      if (!selected.has(test)) selected.set(test, reason);
    };
  for (const file of files)
    if (/^tests\/.+\.test\.(ts|mjs)$/.test(file) && fs.existsSync(path.join(root, file))) add(file, 'changed');
  const texts = new Map(tests.map(test => [test, fs.readFileSync(path.join(root, test), 'utf8')]));
  // Direct: the literal importers the previous selector found.
  for (const file of files) {
    const m = /^(src|server|tools|generated)\/(.+)\.(ts|mjs|json)$/.exec(file);
    if (!m) continue;
    const needle = '/' + m[1] + '/' + m[2] + (m[3] === 'json' ? '.json' : '.js');
    for (const test of tests) if (texts.get(test).includes(needle)) add(test, 'direct');
  }
  if (!direct) {
    const graph = importGraph(root),
      memo = new Map();
    const closure = file => {
      if (memo.has(file)) return memo.get(file);
      const seen = new Set([file]),
        stack = [file];
      memo.set(file, seen);
      while (stack.length) {
        const next = stack.pop();
        for (const dependency of graph.get(next) ?? []) {
          if (seen.has(dependency)) continue;
          seen.add(dependency);
          stack.push(dependency);
        }
      }
      return seen;
    };
    const targets = new Set(files);
    for (const test of tests)
      for (const dependency of closure(test)) if (targets.has(dependency)) add(test, 'transitive');
    // Tests that read a changed web file as text, or fetch it from /assets/, and tests that build web/ paths when they run
    // (readsWebDynamically). Either can sit in the test, a helper or fixture it imports, a tool, or the website's own modules:
    // web/ files are not nodes of the import graph, so the closure is searched for the text that reads them.
    const webFiles = files.filter(f => f.startsWith('web/'));
    if (webFiles.length) {
      const needles = webFiles.flatMap(file => [file, "'web', '" + file.slice(4) + "'", '/assets/' + file.slice(4)]),
        kinds = new Map(),
        kindOf = file => {
          if (!kinds.has(file)) {
            let kind = null;
            if (webReaderCandidate(file)) {
              const backend = /^(?:src|server)\//.test(file);
              let text = texts.get(file) ?? fs.readFileSync(path.join(root, file), 'utf8');
              // A backend module names a web file in a comment as often as in code: only its code counts.
              if (backend)
                text = text
                  .split('\n')
                  .filter(line => !/^\s*(?:\/\/|\/?\*)/.test(line))
                  .join('\n');
              if (needles.some(needle => text.includes(needle))) kind = 'web_reader';
              else if (!patternFiles.has(file) && readsWebDynamically(text, backend)) kind = 'web_dynamic';
            }
            kinds.set(file, kind);
          }
          return kinds.get(file);
        };
      for (const test of tests)
        for (const reached of closure(test)) {
          const kind = kindOf(reached);
          if (kind) add(test, kind);
        }
    }
    for (const suite of dynamicSuites)
      if (texts.has(suite.test) && files.some(file => suite.inputs(file, root))) add(suite.test, 'dynamic_inputs');
    if (files.length) for (const test of criticalTests) if (texts.has(test)) add(test, 'critical');
  }
  const counts = {};
  for (const reason of selected.values()) counts[reason] = (counts[reason] ?? 0) + 1;
  return {
    changed: files,
    mode: direct ? 'direct' : 'closure',
    selected: [...selected.keys()].sort(),
    reasons: counts,
    possible: tests.length,
    freshness: !direct && files.some(file => freshnessScope.test(file)) ? freshnessChecks.map(c => c.name) : [],
  };
}

function changedFiles() {
  const git = args => execFileSync('git', args, {encoding: 'utf8'}).split('\n').filter(Boolean);
  return [
    ...new Set([...git(['diff', '--name-only', 'HEAD']), ...git(['ls-files', '--others', '--exclude-standard'])]),
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    direct = args.includes('--direct'),
    planOnly = args.includes('--plan'),
    named = args.filter(arg => !arg.startsWith('--')),
    changed = named.length ? named : changedFiles(),
    plan = relatedPlan({changed, direct});
  if (planOnly) {
    console.log(JSON.stringify(plan, null, 2));
    process.exit(0);
  }
  if (!plan.selected.length && !plan.freshness.length) {
    console.log('No related tests for: ' + (changed.join(', ') || '(no changes)'));
    process.exit(0);
  }
  const built = runBuild();
  if (built !== 0) process.exit(built);
  let status = 0;
  const stale = [];
  for (const check of freshnessChecks.filter(c => plan.freshness.includes(c.name))) {
    const result = spawnSync(process.execPath, check.args, {stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8'});
    if (result.status !== 0) {
      stale.push(check.name);
      process.stderr.write((result.stdout + result.stderr).split('\n').slice(-4).join('\n') + '\n');
    }
  }
  if (stale.length) {
    status = 1;
    console.error('Stale tracked outputs (' + stale.join(', ') + '): regenerate them before pushing.');
  }
  const run = plan.selected.map(t => (t.endsWith('.ts') ? 'dist/' + t.replace(/\.ts$/, '.js') : t)),
    batches = testBatches(run).length;
  console.log(
    'Selected ' +
      run.length +
      ' of ' +
      plan.possible +
      ' test files (' +
      Object.entries(plan.reasons)
        .map(([reason, n]) => n + ' ' + reason)
        .join(', ') +
      ')' +
      (batches > 1 ? ', run in ' + batches + ' batches' : '') +
      '.',
  );
  const tests = runTests(run);
  if (tests !== 0) status = tests;
  process.exit(status);
}
