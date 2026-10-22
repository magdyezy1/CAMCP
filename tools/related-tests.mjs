// Runs the tests related to changed files (QA-01): the changed tests themselves, every test whose transitive import
// closure contains a changed module, the tests that read a changed web/ file as text, the suites that enumerate their
// inputs at run time (dynamicSuites), and a small critical set (write review, write outcome, review state, spend policy,
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
/** The mutant catalogue tools/mutants.mjs applies (not imported here: mutants.mjs imports this module). */
export const mutantCatalogue = 'tests/fixtures/mutant-catalogue.json';
const backendSource = file => scanRoots.some(root => file.startsWith(root + '/')) && /\.ts$/.test(file);
/**
 * Suites that enumerate the files they check when they run, so no import edge leads to them (three wave 4a merge
 * follow-ups came from these). Each is selected when a changed file is one of its inputs:
 *   mutants             a catalogued module or killing test, or the catalogue: every edit must still apply exactly once
 *   web-locale-chunks   web/ files and the TypeScript sources whose literals assign Arabic messages to chunks
 *   storage-boundary    the src/ and server/ modules it scans for SQL, its allowance and the document-kind registry
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
];
const freshnessScope = /^(?:src|server|tools|docs|generated|codegen|\.mirror)\//;
const graphRoots = ['src', 'server', 'tools', 'tests', 'generated', 'codegen'];
const posix = file => file.replaceAll('\\', '/');

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
    // Tests that read a changed web file as text, or fetch it from /assets/.
    for (const file of files.filter(f => f.startsWith('web/'))) {
      const relative = file.slice(4),
        needles = [file, "'web', '" + relative + "'", '/assets/' + relative];
      for (const test of tests) if (needles.some(needle => texts.get(test).includes(needle))) add(test, 'web_reader');
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
  const run = plan.selected.map(t => (t.endsWith('.ts') ? 'dist/' + t.replace(/\.ts$/, '.js') : t));
  console.log(
    'Selected ' +
      run.length +
      ' of ' +
      plan.possible +
      ' test files (' +
      Object.entries(plan.reasons)
        .map(([reason, n]) => n + ' ' + reason)
        .join(', ') +
      ').',
  );
  if (run.length) {
    const tests = spawnSync(process.execPath, ['--test', ...run], {stdio: 'inherit'});
    if ((tests.status ?? 1) !== 0) status = tests.status ?? 1;
  }
  process.exit(status);
}
