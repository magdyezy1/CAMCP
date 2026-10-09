// DOC-02: one status label collapsed source completeness, provider eligibility, blocked live acceptance and optional
// expansion, so no package could ever close. The status data reports three separate axes, cites test files that
// exist, names finite remainders, and generates a byte-identical table checked by docs:index:check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {
  manualStates,
  nativeStates,
  packageStatusTable,
  renderPackageStatus,
  statusFile,
  tableFile,
  validatePackageStatus,
} from '../tools/package-status.mjs';

const data = () => JSON.parse(fs.readFileSync(statusFile, 'utf8'));
const problems = mutate => {
  const copy = data();
  mutate(copy);
  return validatePackageStatus(copy, process.cwd());
};

test('the committed status validates, cites existing test files and generates the committed table byte for byte', () => {
  const {problems: found, table} = packageStatusTable(process.cwd());
  assert.deepEqual(found, []);
  assert.equal(fs.readFileSync(tableFile, 'utf8'), table);
  assert.equal(renderPackageStatus(data()), renderPackageStatus(data()));
  const status = data();
  assert.deepEqual(
    status.packages.map(p => p.id),
    Array.from({length: 28}, (_, i) => 'B' + String(i + 1).padStart(2, '0')),
  );
  for (const p of status.packages) {
    for (const file of p.source.tests) assert.ok(fs.existsSync(file), p.id + ' ' + file);
    // A package that is not source-met always names what is missing and where the remainder goes.
    if (!p.source.met) assert.ok(p.source.gap && p.remainders.length, p.id);
  }
  // The axes are counted separately; no single "done" figure is published.
  assert.match(table, /\| Source acceptance \(of 28\) \| met \d+ · not met \d+ \|/);
  assert.match(table, new RegExp('\\| Native/live acceptance \\| ' + nativeStates.map(s => s + ' \\d+').join(' · ')));
  assert.match(
    table,
    new RegExp('\\| Manual/deployed acceptance \\| ' + manualStates.map(s => s + ' \\d+').join(' · ')),
  );
  assert.doesNotMatch(table, /\b\d+ (?:done|complete|implemented) \/ \d+/i);
});

test('the validator refuses unsupported claims and open-ended remainders', () => {
  const first = p => p.packages[0],
    unmet = p => p.packages.find(x => !x.source.met);
  const cases = [
    ['source met without tests', p => (first(p).source.tests = []), /cites at least one test file/],
    ['a test file that does not exist', p => first(p).source.tests.push('tests/missing.test.mjs'), /does not exist/],
    ['source met without a commit', p => delete first(p).source.commit, /commit/],
    ['an unknown native state', p => (first(p).native.state = 'live'), /native\.state/],
    ['read-verified without evidence', p => (first(p).native.state = 'read_verified'), /native read_verified cites/],
    ['manual accepted without evidence', p => (first(p).manual.state = 'accepted'), /manual accepted cites/],
    ['not met without a gap', p => delete unmet(p).source.gap, /names the gap/],
    ['not met without remainders', p => (unmet(p).remainders = []), /names its finite remainders/],
    ['a remainder without a canonical reference', p => (first(p).remainders[0].ref = 'later'), /not a register item/],
    ['an unknown disposition', p => (first(p).remainders[0].disposition = 'someday'), /disposition/],
    ['a missing package', p => p.packages.pop(), /B01 to B28/],
    [
      'an unlisted finite package',
      p => (first(p).remainders[0] = {text: 'x', disposition: 'finite_package', ref: 'B40'}),
      /not a listed finite package/,
    ],
    [
      'an orphaned finite package',
      p => (p.finite_packages[0].id = 'B39'),
      /no package remainder points|not a listed finite/,
    ],
  ];
  for (const [label, mutate, pattern] of cases) {
    const found = problems(mutate);
    assert.ok(
      found.some(problem => pattern.test(problem)),
      label + ': ' + found.join('; '),
    );
  }
});

test('docs:index:check validates the status data and the generated table without writing anything', () => {
  const before = fs.readFileSync(tableFile, 'utf8'),
    run = spawnSync(process.execPath, ['tools/docs-index.mjs', '--check'], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(tableFile, 'utf8'), before);
  // The standalone check compares the same bytes.
  const standalone = spawnSync(process.execPath, ['tools/package-status.mjs', '--check'], {encoding: 'utf8'});
  assert.equal(standalone.status, 0, standalone.stderr);
});
