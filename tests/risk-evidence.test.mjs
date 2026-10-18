// QA-02 step 6: the qualification record reports each risk class of the qualification plan against its fixture,
// conformance, mutant and live evidence (tools/risk-evidence.mjs, tests/fixtures/risk-classes.json) instead of headline
// totals. These tests read the tree's own definitions and descriptors and feed synthetic stage results; no suite,
// mutant run, network or provider is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  catalogueFile,
  checkDefinition,
  conformanceTest,
  definitionFile,
  failingFiles,
  familyConformance,
  mutantStatuses,
  riskEvidence,
  sourceTestFile,
} from '../tools/risk-evidence.mjs';
import {qualify} from '../tools/qualify.mjs';

const root = process.cwd(),
  read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')),
  definition = read(definitionFile),
  catalogue = read(catalogueFile),
  allKilled = Object.fromEntries(catalogue.mutants.map(m => [m.id, 'killed'])),
  byId = matrix => Object.fromEntries(matrix.classes.map(c => [c.id, c]));
const suite = (status, failing = []) => ({name: 'test_suite', status, tests: {}, failing_files: failing});
const mutantStage = (outcomes, status = 'passed') => ({name: 'mutant_catalogue', status, mutants: outcomes});

test('the risk classes name existing test files and catalogued mutants; every catalogued mutant has a class', () => {
  assert.deepEqual(checkDefinition(definition, {root, catalogue}), []);
  assert.deepEqual(
    definition.classes.map(c => c.id),
    ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'],
    'the eight risk classes of the qualification plan',
  );
  // The money and deletion class is the one the reviewed-family conformance harness proves.
  assert.ok(definition.classes.find(c => c.id === 'R1').fixture.includes(conformanceTest));
});

test('an unclassified new mutant, an unknown test file or mutant and an unknown risk fail the definition check', () => {
  const withMutant = {mutants: [...catalogue.mutants, {id: 'M99-synthetic-new-guard'}]};
  assert.deepEqual(checkDefinition(definition, {root, catalogue: withMutant}), [
    'mutant M99-synthetic-new-guard belongs to no risk class; classify it in ' + definitionFile,
  ]);
  const broken = structuredClone(definition);
  broken.classes[0].fixture.push('tests/no-such-file.test.mjs');
  broken.classes[1].mutants.push('M98-not-catalogued');
  broken.classes[2].conformance = ['spend'];
  broken.classes[3].live = [{ref: 'ACC-02'}];
  broken.classes.push({...broken.classes[4]});
  assert.deepEqual(checkDefinition(broken, {root, catalogue}), [
    'risk class IDs repeat',
    'R1: fixture test file tests/no-such-file.test.mjs does not exist',
    'R2: mutant M98-not-catalogued is not in the catalogue',
    'R3: unknown descriptor risk spend',
    'R4: live lists {ref, what} acceptance items',
  ]);
  assert.deepEqual(checkDefinition({classes: []}, {root, catalogue: {mutants: []}}), ['no risk classes are defined']);
});

test('failing test files and mutant outcomes are read from the runner output', () => {
  const output = [
    '✖ failing tests:',
    'test at tests\\csv-neutralization.test.mjs:33:10',
    'test at dist\\tests\\spend-policy.test.js:12:3',
    "  location: '" + path.join(root, 'tests', 'liveness-exits.test.mjs') + ":4:1'",
    'test at tests\\csv-neutralization.test.mjs:90:1',
  ].join('\n');
  assert.deepEqual(failingFiles(output, root), [
    'tests/csv-neutralization.test.mjs',
    'tests/liveness-exits.test.mjs',
    'tests/spend-policy.test.ts',
  ]);
  assert.equal(sourceTestFile('file:///C:/work/tests/a.test.mjs:1:2', 'C:/work'), 'tests/a.test.mjs');
  assert.deepEqual(failingFiles('ℹ tests 3\nℹ pass 3\n'), []);
  // On Windows `node --test --test-reporter=tap` doubles every backslash of a location. Regression: they became `//`,
  // the root no longer matched and the failing fixture file was reported as passed.
  const tap = "  location: 'C:\\\\work\\\\tests\\\\liveness-exits.test.mjs:4:1'";
  assert.equal(tap.split('\\').length - 1, 6, 'the doubled form TAP prints');
  assert.deepEqual(failingFiles(tap, 'C:\\work'), ['tests/liveness-exits.test.mjs']);
  assert.deepEqual(failingFiles(tap, 'C:/work/'), ['tests/liveness-exits.test.mjs']);
  assert.deepEqual(
    mutantStatuses(
      [
        'baseline: 3 named test files',
        'M2-csv-guard-equals-only: survived',
        'M3-csv-guard-full-width-missed: killed (tests/csv-neutralization.test.mjs)',
        'M6-dst-gap-skipped: timeout',
        '3 mutants: 1 killed, 1 timed out, 1 survived, 0 invalid',
        'SURVIVED M2-csv-guard-equals-only: SEC-04',
      ].join('\n'),
    ),
    {
      'M2-csv-guard-equals-only': 'survived',
      'M3-csv-guard-full-width-missed': 'killed',
      'M6-dst-gap-skipped': 'timeout',
    },
  );
});

test('a passing run reports every class against its fixture, conformance, mutant and live evidence', async () => {
  const matrix = await riskEvidence({root, stages: [suite('passed'), mutantStage(allKilled)]}),
    classes = byId(matrix),
    descriptors = fs.readdirSync('tests/family-descriptors').filter(n => n.endsWith('.mjs') && !n.startsWith('_'));
  assert.equal(matrix.definition_problems, undefined);
  for (const c of matrix.classes) {
    assert.equal(c.fixture.status, 'passed', c.id);
    assert.equal(c.mutants.status, c.mutants.catalogued ? 'passed' : 'none', c.id);
    assert.equal(c.live.status, 'owner_step', c.id);
    assert.ok(c.live.required.length > 0, c.id);
  }
  // Every descriptor is counted by its risk; R1 holds the activation, budget and destructive ones.
  assert.equal(matrix.family_conformance.descriptors, descriptors.length);
  assert.equal(matrix.family_conformance.status, 'passed');
  const {by_risk} = matrix.family_conformance;
  assert.equal(classes.R1.conformance.descriptors, by_risk.activation + by_risk.budget + by_risk.destructive);
  assert.equal(classes.R1.conformance.status, 'passed');
  assert.equal(classes.R2.conformance, null);
  assert.equal(classes.R1.mutants.killed, definition.classes[0].mutants.length);
  assert.ok(matrix.gaps.includes('R6: no catalogued mutant'));
  assert.ok(matrix.gaps.includes('R2: no reviewed-family conformance applies'));
  assert.ok(matrix.gaps.some(g => g.startsWith('R1: live acceptance (ACC-01, ACC-05)')));
});

test('a failing file, a surviving mutant and an unrun stage show in their own class only', async () => {
  const outcomes = {...allKilled, 'M2-csv-guard-equals-only': 'survived'};
  delete outcomes['M6-dst-gap-skipped'];
  const failed = byId(
    await riskEvidence({
      root,
      stages: [
        suite('failed', ['tests/csv-neutralization.test.mjs', conformanceTest]),
        mutantStage(outcomes, 'failed'),
      ],
    }),
  );
  assert.equal(failed.R5.fixture.status, 'failed');
  assert.deepEqual(failed.R5.fixture.failing, ['tests/csv-neutralization.test.mjs']);
  assert.equal(failed.R5.mutants.status, 'failed');
  assert.deepEqual(failed.R5.mutants.survived, ['M2-csv-guard-equals-only']);
  // The conformance test failed, so R1's fixture and conformance both fail; R2 is untouched.
  assert.equal(failed.R1.fixture.status, 'failed');
  assert.equal(failed.R1.conformance.status, 'failed');
  assert.equal(failed.R2.fixture.status, 'passed');
  // A mutant the run did not report leaves its class incomplete rather than passed.
  assert.equal(failed.R3.mutants.status, 'incomplete');
  assert.deepEqual(failed.R3.mutants.unreported, ['M6-dst-gap-skipped']);
  // A fast profile runs neither stage: nothing is claimed.
  const fast = byId(await riskEvidence({root, stages: []}));
  assert.equal(fast.R1.fixture.status, 'not_run');
  assert.equal(fast.R1.conformance.status, 'not_run');
  assert.equal(fast.R1.mutants.status, 'not_run');
  assert.equal(fast.R6.mutants.status, 'none');
  // A suite that crashed without naming a failing file proves nothing about any file.
  assert.equal(byId(await riskEvidence({root, stages: [suite('failed')]})).R2.fixture.status, 'unknown');
  // The browser qualification is evidence of the website class only, when attached.
  const browser = byId(
    await riskEvidence({root, stages: [suite('passed')], browser: {bound_to_package: true, failed: 0}}),
  );
  assert.deepEqual(browser.R8.fixture.browser_qualification, {attached: true, bound_to_package: true, failed: 0});
  assert.equal(browser.R1.fixture.browser_qualification, undefined);
});

test('the family conformance counts come from the descriptors and the pending ratchet of the tree', async () => {
  const counts = await familyConformance(root),
    pending = read('tests/fixtures/family-conformance-pending.json');
  assert.equal(counts.pending, pending.families.length);
  assert.equal(
    Object.values(counts.by_risk).reduce((a, b) => a + b, 0),
    counts.descriptors,
  );
  assert.ok(Number.isInteger(counts.pending_spend_affecting));
});

test('qualify records the matrix with the failing files and mutant outcomes of its stages', async () => {
  const print = lines => ['-e', 'console.log(' + JSON.stringify(lines.join('\n')) + ')'];
  const record = await qualify({
    root,
    record: false,
    probe: async () => ({status: 'available', version: 'ffmpeg version synthetic'}),
    // The matrix needs no Git checkout. The real source facts ask Git for the worktree state, which Railway's build
    // cannot answer: the container-parity run (ACC-04) failed this test with "not a git repository".
    source: () => ({
      origin: 'checkout',
      manifest_version: 2,
      source_tree_hash: 'synthetic',
      revision: null,
      branch: null,
      worktree_clean: null,
      differs_from_revision: null,
    }),
    stages: [
      {
        name: 'test_suite',
        command: 'node',
        args: print([
          'test at tests\\csv-neutralization.test.mjs:12:1',
          '# tests 2',
          '# pass 1',
          '# fail 1',
          '# skipped 0',
          '# cancelled 0',
        ]),
        // Not blocking, so the mutant stage still runs after the failure and both feed the matrix.
        blocking: false,
        tests: true,
      },
      {
        name: 'mutant_catalogue',
        command: 'node',
        args: print(['M2-csv-guard-equals-only: survived', 'M3-csv-guard-full-width-missed: killed']),
        blocking: false,
        mutants: true,
      },
    ],
  });
  assert.deepEqual(record.stages[0].failing_files, ['tests/csv-neutralization.test.mjs']);
  assert.deepEqual(record.stages[1].mutants, {
    'M2-csv-guard-equals-only': 'survived',
    'M3-csv-guard-full-width-missed': 'killed',
  });
  const classes = byId(record.risk_evidence);
  assert.equal(classes.R5.fixture.status, 'failed');
  assert.equal(classes.R5.mutants.status, 'failed');
  assert.equal(classes.R4.fixture.status, 'passed');
  assert.equal(classes.R1.mutants.status, 'incomplete');
});
