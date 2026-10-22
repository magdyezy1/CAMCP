// QA-01: `test:related` selected only tests whose text named a changed module (src/errors.ts: 35 of ~515 dependents;
// web/app.js: none). It now selects by import-graph closure, maps web/ files to the tests that read them, always adds
// a small critical set, and appends the freshness checks that otherwise first fail inside Railway's build.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {
  buildSteps,
  criticalTests,
  dynamicSuites,
  freshnessChecks,
  mutantCatalogue,
  relatedPlan,
  runBuild,
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
  // Every backend module is scanned for SQL and for the literals that assign Arabic messages to chunks.
  assert.deepEqual(dynamic(['src/guidance.ts']), [
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
  // A page script or a locale file changes which chunk carries a message.
  assert.deepEqual(dynamic(['web/owner-operations.js']), ['tests/web-locale-chunks.test.mjs']);
  assert.deepEqual(dynamic(['web/locales/ar.json']), ['tests/web-locale-chunks.test.mjs']);
  // A test could spawn the admin CLI bare, and a tool could check for root.
  assert.deepEqual(dynamic(['tests/operations.test.ts']), ['tests/root-independent-cli.test.mjs']);
  assert.deepEqual(dynamic(['tools/docs-index.mjs']), ['tests/root-independent-cli.test.mjs']);
  // Documentation is none of their inputs.
  assert.deepEqual(dynamic(['docs/OPERATIONS.md']), []);
  const reasons = relatedPlan({changed: ['src/csv-safety.ts']});
  assert.ok(reasons.reasons.dynamic_inputs >= 1);
  // --direct keeps the earlier literal selection.
  assert.equal(relatedPlan({changed: ['web/owner-operations.js'], direct: true}).selected.length, 0);
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
