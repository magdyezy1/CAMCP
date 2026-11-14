// QA-01: `test:related` selected only tests whose text named a changed module (src/errors.ts: 35 of ~515 dependents;
// web/app.js: none). It now selects by import-graph closure, maps web/ files to the tests that read them, always adds
// a small critical set, and appends the freshness checks that otherwise first fail inside Railway's build.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {removeTestDirectory} from '../dist/tests/temp.js';
import {
  buildSteps,
  criticalTests,
  dynamicSuites,
  freshnessChecks,
  mutantCatalogue,
  relatedPlan,
  runBuild,
  runTests,
  testBatchCharacters,
  testBatchSize,
} from '../tools/related-tests.mjs';
import {catalogueFile} from '../tools/mutants.mjs';

test('a change to a shared write-path module selects its transitive dependents and the stale-report checks', () => {
  const direct = relatedPlan({changed: ['src/errors.ts'], direct: true}),
    closure = relatedPlan({changed: ['src/errors.ts']});
  assert.equal(direct.mode, 'direct');
  assert.deepEqual(direct.freshness, [], '--direct keeps the old behavior');
  assert.ok(
    closure.selected.length > direct.selected.length * 3,
    closure.selected.length + ' vs ' + direct.selected.length,
  );
  assert.ok(closure.reasons.transitive > 0);
  assert.ok(
    direct.selected.every(file => closure.selected.includes(file)),
    'closure includes every direct importer',
  );
  // A refusal code added in a write-path module changes the tracked report: the report check runs with the tests.
  assert.ok(closure.freshness.includes('report_check'));
  assert.ok(closure.freshness.includes('docs_index_check'));
  assert.equal(closure.possible, fs.readdirSync('tests').filter(f => /\.test\.(ts|mjs)$/.test(f)).length);
});

test('a change to web/app.js selects the tests that read it as text', () => {
  const plan = relatedPlan({changed: ['web/app.js']}),
    readers = fs
      .readdirSync('tests')
      .filter(f => /\.test\.(ts|mjs)$/.test(f))
      .map(f => 'tests/' + f)
      .filter(f => fs.readFileSync(f, 'utf8').includes("readFileSync('web/app.js'"));
  assert.ok(readers.length > 5, 'the repository has text readers of web/app.js');
  for (const reader of readers) assert.ok(plan.selected.includes(reader), reader);
  assert.ok(plan.reasons.web_reader > 0);
  assert.deepEqual(plan.freshness, [], 'web-only changes need no generated-output check');
  assert.equal(relatedPlan({changed: ['web/app.js'], direct: true}).selected.length, 0);
});

test('the critical set exists and is always included, and freshness checks name real tools', () => {
  for (const file of criticalTests) assert.ok(fs.existsSync(file), file);
  const plan = relatedPlan({changed: ['docs/OPERATIONS.md']});
  for (const file of criticalTests) assert.ok(plan.selected.includes(file), file);
  assert.ok(plan.freshness.includes('docs_index_check'));
  for (const check of freshnessChecks)
    assert.ok(
      fs.existsSync(check.args[0].replace(/^dist\//, '').replace(/\.js$/, '.ts')) || fs.existsSync(check.args[0]),
      check.name,
    );
  assert.deepEqual(relatedPlan({changed: []}).selected, []);
});

// QA follow-up (2026-10-17): related tests ran tsc only, so in a fresh tree a test that reads dist/release-identity.json
// (tests/mcp-help-introspection.test.mjs, serverInfo) failed although `npm run build` passes it.
test('the build is the one `npm run build` runs: tsc, then the release identity, stopping at the first failure', () => {
  const script = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts.build;
  assert.deepEqual(
    buildSteps.map(step => step.name),
    ['tsc', 'release_identity'],
  );
  assert.match(script, /^tsc -p tsconfig\.json && node tools\/build-release-identity\.mjs$/);
  assert.deepEqual(buildSteps[0].args.slice(1), ['-p', 'tsconfig.json']);
  assert.deepEqual(buildSteps[1].args, ['tools/build-release-identity.mjs']);
  for (const step of buildSteps) assert.ok(fs.existsSync(step.args[0]), step.args[0]);
  const ran = [],
    spawn = status => (command, args) => {
      ran.push([command, ...args]);
      return {status: args[0] === 'tools/build-release-identity.mjs' ? status.identity : status.tsc};
    };
  assert.equal(runBuild(spawn({tsc: 0, identity: 0})), 0);
  assert.deepEqual(
    ran.map(r => r.slice(1)),
    buildSteps.map(step => step.args),
  );
  assert.ok(ran.every(r => r[0] === process.execPath));
  ran.length = 0;
  assert.equal(runBuild(spawn({tsc: 2, identity: 0})), 2, 'a failed compile is the run’s status');
  assert.equal(ran.length, 1, 'the identity is not written over a failed compile');
  ran.length = 0;
  assert.equal(runBuild(spawn({tsc: 0, identity: 1})), 1);
  assert.equal(ran.length, 2);
  // A killed step (status null) still fails the build.
  assert.equal(
    runBuild(() => ({status: null})),
    1,
  );
});

// Package docs (item 8): the tool ran its selection as one `node --test <every file>` command. A change to a shared module
// selects about a thousand files, and Windows refuses a command line past 32,767 characters (spawn ENAMETOOLONG on 889 files),
// so a long selection could not be run there. The selection now runs in batches, each far under that limit and every host's.
const windowsCommandLimit = 32767;
const longSelection = Array.from({length: 1000}, (_, i) => 'tests/' + 'a-long-test-name-'.repeat(2) + i + '.test.mjs');
const recordingSpawn = (calls, status = () => 0) => {
  return (command, args, options) => {
    calls.push({command, args, options});
    return {status: status(calls.length)};
  };
};

test('the selected tests run in batches: a selection over the Windows command-line limit never becomes one command', () => {
  assert.ok(
    longSelection.join(' ').length > windowsCommandLimit,
    'the selection is over the limit that stopped Windows',
  );
  const calls = [];
  assert.equal(runTests(longSelection, recordingSpawn(calls)), 0);
  assert.ok(
    calls.length >= Math.ceil(longSelection.length / testBatchSize),
    'one command per batch of at most the size',
  );
  for (const {command, args, options} of calls) {
    assert.equal(command, process.execPath);
    assert.equal(args[0], '--test');
    assert.deepEqual(options, {stdio: 'inherit'});
    assert.ok(args.length - 1 <= testBatchSize, args.length - 1 + ' files in one command');
    assert.ok(args.slice(1).join(' ').length <= testBatchCharacters, 'the names of a batch fit their budget');
    assert.ok([command, ...args].join(' ').length < windowsCommandLimit / 2, 'far under the Windows limit');
  }
  assert.deepEqual(
    calls.flatMap(({args}) => args.slice(1)),
    longSelection,
    'every file runs once, in the selection’s order',
  );
  // The real selection of a change to a shared module (about a thousand files) is split the same way.
  const real = relatedPlan({changed: ['src/errors.ts']}).selected,
    realCalls = [];
  runTests(real, recordingSpawn(realCalls));
  assert.deepEqual(
    realCalls.flatMap(({args}) => args.slice(1)),
    real,
  );
  for (const {args} of realCalls) assert.ok([...args].join(' ').length < windowsCommandLimit / 2);
});

test('a batch also ends at its character budget, a name longer than it runs alone, and nothing selected runs nothing', () => {
  const names = Array.from({length: 7}, (_, i) => 'tests/' + String(i).repeat(3000) + '.test.mjs'),
    // How many 3,000-character names the budget holds, each counted with its separator.
    per = Math.floor(testBatchCharacters / (names[0].length + 1)),
    expected = [],
    calls = [];
  assert.ok(per > 1 && per < names.length && per < testBatchSize, 'the budget, not the count, ends these batches');
  for (let left = names.length; left > 0; left -= per) expected.push(Math.min(per, left));
  runTests(names, recordingSpawn(calls));
  assert.deepEqual(
    calls.map(({args}) => args.length - 1),
    expected,
  );
  for (const {args} of calls) assert.ok(args.slice(1).join(' ').length <= testBatchCharacters);
  const oversized = ['tests/' + 'x'.repeat(testBatchCharacters * 2) + '.test.mjs', 'tests/short.test.mjs'],
    alone = [];
  runTests(oversized, recordingSpawn(alone));
  assert.deepEqual(
    alone.map(({args}) => args.slice(1)),
    oversized.map(name => [name]),
    'a name over the budget is never split and never shares a command',
  );
  runTests([], () => {
    throw new Error('an empty selection starts no command');
  });
});

test('the status of the batches is the run’s: the first failing batch, a killed one is 1, and a failure does not stop the rest', () => {
  const files = Array.from({length: testBatchSize * 5}, (_, i) => 'tests/f' + i + '.test.mjs'),
    calls = [],
    statuses = [0, 3, 0, 1, null];
  assert.equal(
    runTests(
      files,
      recordingSpawn(calls, n => statuses[n - 1]),
    ),
    3,
    'the first failing batch’s status',
  );
  assert.equal(calls.length, 5, 'every batch runs');
  assert.equal(
    runTests(files.slice(0, 1), () => ({status: null})),
    1,
    'a killed batch fails the run',
  );
  assert.equal(
    runTests(files, () => ({status: 0})),
    0,
  );
});

// Wave 4a follow-up: the mutant catalogue, the Arabic locale chunks and the storage boundary enumerate their inputs
// when they run, so no import edge led to them and a change that broke them passed test:related. The root-handling
// guard of the admin CLI spawns (tests/root-independent-cli.test.mjs) scans the tests and entry points the same way.
test('the suites that enumerate their inputs are selected when one of their inputs changes', () => {
  assert.equal(mutantCatalogue, catalogueFile);
  assert.deepEqual(dynamicSuites.map(s => s.test).sort(), [
    'tests/mutants.test.mjs',
    'tests/root-independent-cli.test.mjs',
    'tests/storage-boundary.test.mjs',
    'tests/web-locale-chunks.test.mjs',
  ]);
  for (const suite of dynamicSuites) assert.ok(fs.existsSync(suite.test), suite.test);
  const dynamic = changed =>
    relatedPlan({changed})
      .selected.filter(t => dynamicSuites.some(s => s.test === t))
      .sort();
  // A catalogued module the compiled mutant edits, and a killing test the catalogue names.
  const catalogue = JSON.parse(fs.readFileSync(catalogueFile, 'utf8'));
  assert.ok(dynamic([catalogue.mutants[1].file]).includes('tests/mutants.test.mjs'));
  assert.ok(dynamic([catalogue.mutants[1].tests[0]]).includes('tests/mutants.test.mjs'));
  assert.ok(dynamic([catalogueFile]).includes('tests/mutants.test.mjs'));
  // Every backend module is scanned for SQL and for the literals that assign Arabic messages to chunks, and a shared
  // module may hold a root check for the entry points that import it.
  assert.deepEqual(dynamic(['src/guidance.ts']), [
    'tests/root-independent-cli.test.mjs',
    'tests/storage-boundary.test.mjs',
    'tests/web-locale-chunks.test.mjs',
  ]);
  // A server module may also be an entry point that checks for root.
  assert.deepEqual(dynamic(['server/workspace-search.ts']), [
    'tests/root-independent-cli.test.mjs',
    'tests/storage-boundary.test.mjs',
    'tests/web-locale-chunks.test.mjs',
  ]);
  assert.deepEqual(dynamic(['tests/fixtures/storage-boundary-allowance.json']), ['tests/storage-boundary.test.mjs']);
  // A page script or a locale file changes which chunk carries a message. Every change under web/ also selects the mutants
  // suite, for another reason: it imports tools/qualify.mjs, which snapshots web/ for the public asset version (closing-small:
  // the tests that reach a file that reads web/ when it runs are selected for any change under it).
  assert.deepEqual(dynamic(['web/owner-operations.js']), [
    'tests/mutants.test.mjs',
    'tests/web-locale-chunks.test.mjs',
  ]);
  assert.deepEqual(dynamic(['web/locales/ar.json']), ['tests/mutants.test.mjs', 'tests/web-locale-chunks.test.mjs']);
  // A test could spawn the admin CLI bare, and a tool could check for root.
  assert.deepEqual(dynamic(['tests/operations.test.ts']), ['tests/root-independent-cli.test.mjs']);
  assert.deepEqual(dynamic(['tools/docs-index.mjs']), ['tests/root-independent-cli.test.mjs']);
  // So could a deploy script.
  assert.deepEqual(dynamic(['deploy/smoke.mjs']), ['tests/root-independent-cli.test.mjs']);
  // Documentation is none of their inputs.
  assert.deepEqual(dynamic(['docs/OPERATIONS.md']), []);
  const reasons = relatedPlan({changed: ['src/csv-safety.ts']});
  assert.ok(reasons.reasons.dynamic_inputs >= 1);
  // --direct keeps the earlier literal selection.
  assert.equal(relatedPlan({changed: ['web/owner-operations.js'], direct: true}).selected.length, 0);
});

// Package closing-small, item 7. Merge C's selection missed 79 of 1,130 test files. Some of them read web/ by a path they build
// when they run (`'web/' + name`, a directory listing, createPublicAssets('web')), in their own text or in a helper, fixture,
// tool or website module they import (tests/helpers/web-ui-dom.mjs serves five component suites, server/website.ts snapshots
// the whole directory for every test that boots the website), so no needle named the changed file. Every change under web/ now
// selects them: the planner may over-select, never under-select. An fs trace of every test file (scratch, not committed: 324 of
// 1,142 touched web/) found no web/ file read by a test that neither these rules nor a literal name select.
const temporaryTree = (t, files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-related-web-'));
  t.after(() => removeTestDirectory(root, 'amcp-related-web-'));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
};
const syntheticWebTree = {
  // Builds the path itself.
  'tests/own.test.mjs': "import fs from 'node:fs';\nconst read = name => fs.readFileSync('web/' + name, 'utf8');\n",
  // Reads through a helper it imports.
  'tests/helped.test.mjs': "import {load} from './helpers/load.mjs';\nload('x');\n",
  'tests/helpers/load.mjs':
    "import fs from 'node:fs';\nimport path from 'node:path';\nexport const load = name => fs.readFileSync(path.join('web', name));\n",
  // Reads through a tool it imports, which lists the directory.
  'tests/tooled.test.mjs': "import {scan} from '../tools/scan.mjs';\nscan();\n",
  'tools/scan.mjs': "import fs from 'node:fs';\nexport const scan = () => fs.readdirSync('web');\n",
  // Serves the directory with the website's own asset server.
  'tests/served.test.mjs':
    "import {createPublicAssets} from '../dist/server/public-assets.js';\ncreatePublicAssets('web');\n",
  // Imports a website module that serves its directory by default.
  'tests/booting.test.mjs': "import {site} from '../dist/server/site.js';\nsite();\n",
  'server/site.ts':
    "export const site = (options: {staticDirectory?: string} = {}) => path.resolve(options.staticDirectory ?? 'web');\n",
  // Names one file: only a change to that file selects it. A source module that names a file is the same: its importers.
  'tests/literal.test.mjs': "import fs from 'node:fs';\nfs.readFileSync('web/x.js', 'utf8');\n",
  'tests/font.test.mjs': "import {font} from '../dist/src/font.js';\nfont();\n",
  'src/font.ts': "export const font = () => resolve('web/fonts/x.ttf');\n",
  // Uses 'web' as data, in a source module, or names no path at all: selected by no web change.
  'tests/plain.test.mjs': "const surface = 'web';\nconsole.log('the web surface', surface);\n",
  'tests/data.test.mjs': "import {kinds} from '../dist/src/kinds.js';\nkinds();\n",
  'src/kinds.ts': "export const kinds = () => ['dist', 'generated', 'web', 'Skills'];\n",
  'tests/helped-plain.test.mjs': "import {value} from './helpers/plain.mjs';\nvalue();\n",
  'tests/helpers/plain.mjs': 'export const value = () => 1;\n',
};
const webDynamic = [
  'tests/booting.test.mjs',
  'tests/helped.test.mjs',
  'tests/own.test.mjs',
  'tests/served.test.mjs',
  'tests/tooled.test.mjs',
];

test('a change under web/ selects the tests that build web/ paths when they run, in their own text, a helper or a tool', t => {
  const root = temporaryTree(t, syntheticWebTree);
  // A stylesheet no test names: only the readers that build their paths are selected.
  const css = relatedPlan({root, changed: ['web/y.css']});
  assert.deepEqual(css.selected, webDynamic);
  assert.deepEqual(
    Object.keys(css.reasons),
    ['web_dynamic'],
    'a reader that names no file is selected for the whole directory',
  );
  // A file one test names: that test too, as before.
  const named = relatedPlan({root, changed: ['web/x.js']});
  assert.deepEqual(named.selected, [...webDynamic, 'tests/literal.test.mjs'].sort());
  assert.equal(named.reasons.web_reader, 1);
  // A file a source module names: the tests that reach the module.
  assert.deepEqual(
    relatedPlan({root, changed: ['web/fonts/x.ttf']}).selected,
    [...webDynamic, 'tests/font.test.mjs'].sort(),
  );
  // Nothing under web/ changed: none of them.
  assert.deepEqual(relatedPlan({root, changed: ['src/x.ts']}).selected, []);
  assert.deepEqual(relatedPlan({root, changed: ['docs/OPERATIONS.md']}).selected, []);
  // --direct is the earlier literal selection and stays so.
  assert.deepEqual(relatedPlan({root, changed: ['web/y.css'], direct: true}).selected, []);
  // The static test DOM serves five suites through its helper: reading it is how they read web/components.js.
  const live = relatedPlan({changed: ['web/components.js']});
  for (const file of ['core', 'controls', 'overlays', 'table', 'dom'])
    assert.ok(live.selected.includes(`tests/web-ui-${file}.test.mjs`), file);
});

test('the readers Merge C missed are selected for any change under web/, and tests with no business there are not', () => {
  // Some of the 79, by how they read web/: through tests/helpers/web-ui-dom.mjs (web/components*.js), by a path built from a
  // name, through tools/first-party-fixtures.mjs and tools/docs-links.mjs (a list of roots), and the tests that boot the website
  // (server/website.ts reads the whole directory into one snapshot when it starts).
  const missed = [
    'tests/web-ui-controls.test.mjs',
    'tests/web-ui-core.test.mjs',
    'tests/web-ui-dom.test.mjs',
    'tests/web-ui-overlays.test.mjs',
    'tests/web-ui-table.test.mjs',
    'tests/locale-persistence.test.mjs',
    'tests/product-browser-helpers.test.mjs',
    'tests/report-library-ui.test.mjs',
    'tests/report-retry-deep-link.test.mjs',
    'tests/web-tokens-v2-components.test.mjs',
    'tests/first-party-contracts.test.mjs',
    'tests/docs-links.test.mjs',
    'tests/website.test.ts',
    'tests/user-accounts.test.ts',
    'tests/deployment-smoke.test.ts',
  ];
  for (const changed of ['web/app.js', 'web/identity.css', 'web/locales/ar/shell.json', 'web/mark.svg']) {
    const {selected} = relatedPlan({changed: [changed]});
    for (const file of missed) assert.ok(selected.includes(file), `${changed} selects ${file}`);
    // Neither reads web/: the stdio transport, the test-oracle check and the TypeScript build stay out of a web-only change.
    for (const file of ['tests/stdio.test.ts', 'tests/test-oracles.test.mjs', 'tests/http-startup.test.ts'])
      assert.ok(!selected.includes(file), `${changed} selects ${file}`);
  }
  // The font the PDF and workbook writers embed is named in src/report-artifacts.ts: its change selects the tests that reach it.
  assert.ok(
    relatedPlan({changed: ['web/fonts/NotoSansArabic.ttf']}).selected.includes(
      'tests/report-artifact-language.test.mjs',
    ),
  );
});

test('the patterns that say a file builds web/ paths when it runs', async () => {
  const {readsWebDynamically} = await import('../tools/related-tests.mjs');
  assert.equal(typeof readsWebDynamically, 'function');
  // Tests, helpers, fixtures and tools.
  for (const text of [
    "fs.readFileSync('web/' + file, 'utf8')",
    "readFileSync('web/' + file + '.js', 'utf8')",
    'readFileSync(`web/${name}`)',
    "path.join(root, 'web', 'app.js')",
    "fs.readdirSync('web', {recursive: true})",
    "fs.readdirSync('web/locales/ar')",
    "createPublicAssets('web')",
    "new URL('../web/', import.meta.url)",
    "new URL('../web', import.meta.url)",
    "process.env.AMCP_TEST_WEB_ROOT ?? 'web'",
    "const roots = ['README.md', 'docs', 'Skills', 'web'];",
    "add('web', name => /\\.js$/.test(name));",
    "'/assets/' + name",
    'fetch(`/assets/${name}`)',
  ])
    assert.equal(readsWebDynamically(text), true, text);
  for (const text of [
    "fs.readFileSync('web/app.js', 'utf8')",
    "readFileSync('../web/app.js')",
    "const surface = 'web';",
    'the web page and the webcrypto API',
    "fetch('/assets/app.js')",
  ])
    assert.equal(readsWebDynamically(text), false, text);
  // Wide on purpose: a bare 'web' that is data in a test is selected too (a test selected without need costs one run).
  assert.equal(readsWebDynamically("{type: 'web', submitted: '120'}"), true);
  // src/ and server/: only the modules that serve or snapshot the directory, never a bare 'web' that is data.
  for (const text of [
    "path.resolve(options.staticDirectory ?? 'web')",
    "createPublicAssets(path.join(releaseRoot, 'web'))",
    "const web = path.join(root, 'web');",
    'export function createPublicAssets(directory: string) {',
  ])
    assert.equal(readsWebDynamically(text, true), true, text);
  for (const text of [
    "const directories = ['dist', 'generated', 'web', 'Skills'];",
    "contentTypes = ['androidApp', 'image', 'web'];",
    "{type: 'web', submitted: '120'}",
    "'customers/' + id + '/assets/' + asset",
    "resolve('web/fonts/x.ttf')",
  ])
    assert.equal(readsWebDynamically(text, true), false, text);
});

test('--plan prints the selection without building or running anything', () => {
  const result = spawnSync(process.execPath, ['tools/related-tests.mjs', '--plan', 'src/write-state.ts'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.mode, 'closure');
  assert.ok(plan.selected.length > 3);
});
