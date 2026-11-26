// QA-02 mutant catalogue (tools/mutants.mjs, tests/fixtures/mutant-catalogue.json): the catalogue stays applicable to
// the built candidate, and the runner tells a killed mutant from a surviving one, a stale edit and a broken module.
// The full catalogue runs in release qualification (tools/qualify.mjs, full profile), not in this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {applyMutant, catalogueFile, checkCatalogue, compiledPath, locate, runMutants} from '../tools/mutants.mjs';
import {profileStages} from '../tools/qualify.mjs';
import {ownEntries, removeTestDirectory} from '../dist/tests/temp.js';

const catalogue = JSON.parse(fs.readFileSync(catalogueFile, 'utf8'));

test('every catalogued mutant applies exactly once to the built module and names an existing killing test', () => {
  assert.deepEqual(checkCatalogue(catalogue), []);
  assert.ok(catalogue.mutants.length >= 30, 'about thirty catalogued mutants: ' + catalogue.mutants.length);
  // The review's probe mutants and the acceptance mutants are catalogued.
  for (const id of ['M1-', 'M2-', 'M4-', 'M5-'])
    assert.ok(
      catalogue.mutants.some(m => m.id.startsWith(id)),
      id,
    );
  assert.ok(catalogue.mutants.some(m => m.tests.includes('tests/reviewed-family-conformance.test.mjs')));
  for (const m of catalogue.mutants) {
    const text = fs.readFileSync(compiledPath(m.file), 'utf8');
    assert.notEqual(applyMutant(text, m), text, m.id);
  }
});

test('an edit matches across reformatted whitespace but never twice or not at all', () => {
  assert.equal(locate('if (a)\n      return null;', 'if (a) return null;').length, 1);
  assert.equal(locate('x <= y; x <= y;', 'x <= y').length, 2);
  assert.throws(() => applyMutant('x <= y; x <= y;', {id: 'M0-x', find: 'x <= y', replace: 'x < y'}), /2 times/);
  assert.throws(() => applyMutant('a', {id: 'M0-x', find: 'b', replace: 'c'}), /0 times/);
  assert.equal(applyMutant('a [=+] b', {id: 'M0-x', find: '[=+]', replace: '[=]'}), 'a [=] b');
  const problems = checkCatalogue({
    mutants: [
      {id: 'bad id', guards: 'g', file: 'src/csv-safety.ts', find: 'x', replace: 'y', tests: ['tests/none.test.mjs']},
      {id: 'M0-no-match', guards: 'g', file: 'src/csv-safety.ts', find: 'NO SUCH TEXT', replace: '', tests: []},
    ],
  });
  assert.ok(problems.some(p => /id must look like/.test(p)));
  assert.ok(problems.some(p => /killing test missing: tests\/none\.test\.mjs/.test(p)));
  assert.ok(problems.some(p => /M0-no-match: name at least one killing test/.test(p)));
  assert.ok(problems.some(p => /M0-no-match: the edit matches 0 times/.test(p)));
});

test('the runner reports killed, survived and invalid mutants in a scratch copy and restores nothing in the candidate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-mutants-'));
  try {
    fs.mkdirSync(path.join(root, 'dist/src'), {recursive: true});
    fs.mkdirSync(path.join(root, 'src'), {recursive: true});
    fs.mkdirSync(path.join(root, 'tests'), {recursive: true});
    const module =
      'export const guard = n => n >= 10 && n <= 20;\nexport const label = n => (n < 0 ? "negative" : "ok");\n';
    fs.writeFileSync(path.join(root, 'src/guard.ts'), '// source\n');
    fs.writeFileSync(path.join(root, 'dist/src/guard.js'), module);
    fs.writeFileSync(
      path.join(root, 'tests/guard.test.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {guard} from '../dist/src/guard.js';\n" +
        "test('bounds', () => { assert.equal(guard(10), true); assert.equal(guard(21), false); });\n",
    );
    const report = runMutants({
      root,
      critical: [],
      timeout: 60000,
      catalogue: {
        mutants: [
          {
            id: 'M1-lower-bound',
            file: 'src/guard.ts',
            find: 'n >= 10',
            replace: 'n > 10',
            tests: ['tests/guard.test.mjs'],
          },
          {id: 'M2-label', file: 'src/guard.ts', find: 'n < 0', replace: 'n <= 0', tests: ['tests/guard.test.mjs']},
          {id: 'M3-stale', file: 'src/guard.ts', find: 'n === 99', replace: 'x', tests: ['tests/guard.test.mjs']},
          {
            id: 'M4-syntax',
            file: 'src/guard.ts',
            find: '&& n <= 20;',
            replace: '&& (',
            tests: ['tests/guard.test.mjs'],
          },
        ],
      },
    });
    assert.equal(report.baseline.passed, true);
    assert.deepEqual(
      report.mutants.map(m => [m.id, m.status]),
      [
        ['M1-lower-bound', 'killed'],
        ['M2-label', 'survived'],
        ['M3-stale', 'invalid'],
        ['M4-syntax', 'invalid'],
      ],
    );
    assert.deepEqual(report.mutants[0].failing, ['bounds']);
    assert.deepEqual(report.totals, {catalogued: 4, killed: 1, timeout: 0, survived: 1, invalid: 2});
    assert.equal(report.passed, false, 'a surviving or stale mutant fails the run');
    assert.equal(fs.readFileSync(path.join(root, 'dist/src/guard.js'), 'utf8'), module, 'the candidate is untouched');
    const scratch = path.join(root, '.runtime/mutants');
    // Another program's file in the scratch folder is not a copy the run left behind (r25-testhyg).
    fs.mkdirSync(scratch, {recursive: true});
    fs.writeFileSync(path.join(scratch, 'MIRROR.SQLITE-SHM.tmp'), '');
    // The run's own scratch copy is a folder named by a UUID (tools/mutants.mjs).
    assert.deepEqual(
      ownEntries(scratch, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
      [],
      'the scratch copy is removed',
    );
  } finally {
    removeTestDirectory(root, 'amcp-mutants-');
  }
});

test('release qualification runs the mutant catalogue after the suite', () => {
  const full = profileStages('full').map(s => s.name);
  assert.ok(full.indexOf('mutant_catalogue') > full.indexOf('test_suite'));
  assert.ok(!profileStages('fast').some(s => s.name === 'mutant_catalogue'));
  assert.equal(profileStages('full').find(s => s.name === 'mutant_catalogue').blocking, true);
  // PRV-05: the wire-contract fixture sweep is a blocking full-qualification stage, never part of the fast gate.
  assert.equal(profileStages('full').find(s => s.name === 'wire_contract_sweep').blocking, true);
  assert.ok(!profileStages('fast').some(s => s.name === 'wire_contract_sweep'));
});
