// QA-01: `test:related` selected only tests whose text named a changed module (src/errors.ts: 35 of ~515 dependents;
// web/app.js: none). It now selects by import-graph closure, maps web/ files to the tests that read them, always adds
// a small critical set, and appends the freshness checks that otherwise first fail inside Railway's build.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {criticalTests, freshnessChecks, relatedPlan} from '../tools/related-tests.mjs';

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

test('--plan prints the selection without building or running anything', () => {
  const result = spawnSync(process.execPath, ['tools/related-tests.mjs', '--plan', 'src/write-state.ts'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.mode, 'closure');
  assert.ok(plan.selected.length > 3);
});
