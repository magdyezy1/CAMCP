// QA-02: the refusal-oracle ratchet and the typed refusal helper. The ratchet fails on a newly added weak oracle (a
// bare assert.throws or a code-less `success, false`), passes on the committed baseline, and holds write, auth and
// export test files at zero. assertRefused names the refusal and never accepts a crash.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  allowanceFile,
  callArguments,
  compareAllowance,
  counts,
  scan,
  testFiles,
  zeroAllowance,
} from '../tools/check-test-oracles.mjs';
import {decide, instrument, refusalAssertion, rewrite} from '../tools/oracle-burndown.mjs';
import {MirrorError} from '../dist/src/errors.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {removeTestDirectory} from '../dist/tests/temp.js';

// Synthetic test text is assembled from parts so this file's own source holds no weak oracle for the scan to find.
const A = (call, rest) => 'assert.' + call + rest;

test('the scan finds bare throws/rejects and code-less refusals, and accepts named ones', () => {
  const text = [
    A('throws', '(() => f(1));'),
    'await ' + A('rejects', "(f(2), 'only a message');"),
    A('throws', "(() => f(3), {code: 'INVALID_ARGUMENT'});"),
    A('throws', '(() => f(4), /refused/);'),
    'await ' + A('rejects', "(() => f(5), e => assertRefused(e, 'FORBIDDEN'));"),
    A('throws', '(() => f(6), TypeError);'),
    A('equal', '(result.success, false);'),
    A('equal', '(other.success, false);'),
    "assert.equal(other.error.code, 'STATE_CHANGED');",
    "assertRefused(third, 'STATE_CHANGED');",
  ].join('\n');
  const sites = scan(text);
  assert.deepEqual(
    sites.filter(s => s.kind === 'bare').map(s => s.line),
    [1, 2],
  );
  // Lines 7 and 8 are accepted: a code is named within the next four lines (a textual window, so a heuristic).
  assert.deepEqual(
    sites.filter(s => s.kind === 'codeless').map(s => s.line),
    [],
  );
  assert.deepEqual(
    scan(A('equal', '(r.success, false);\n') + A('equal', '(writes, 0);\n\n\n\nnext();')).map(s => s.kind),
    ['codeless'],
  );
  assert.deepEqual(scan(A('equal', '(r.success, false);\n') + A('equal', '(r.error.code, "X_Y_Z");')), []);
});

test('call arguments split past strings, templates, regular expressions and nested calls', () => {
  const text = A('throws', "(() => g('a,b', `x${[1, 2]}`, /,/), {code: 'A_B_C'}, 'why')");
  const args = callArguments(text, text.indexOf('('));
  assert.equal(args.length, 3);
  assert.equal(args[1], "{code: 'A_B_C'}");
  assert.equal(callArguments('assert.throws(() => f(', 13), null);
});

test('the ratchet fails on a deliberately added bare assert.throws and passes on the committed baseline', () => {
  const files = testFiles(),
    allowance = JSON.parse(fs.readFileSync(allowanceFile, 'utf8')).allowance;
  const baseline = compareAllowance(counts(files), allowance);
  assert.deepEqual(baseline.over, [], 'the committed tests stay within their allowance');
  // A synthetic file with one more bare oracle than its allowance.
  const found = {'tests/synthetic-family.test.mjs': {codeless: 0, bare: 1, sites: [{kind: 'bare', line: 3}]}};
  const added = compareAllowance(found, {'tests/synthetic-family.test.mjs': {codeless: 0, bare: 0}});
  assert.deepEqual(
    added.over.map(o => [o.file, o.kind, o.found, o.allowed]),
    [['tests/synthetic-family.test.mjs', 'bare', 1, 0]],
  );
  // Write, auth and export files are held at zero whatever the allowance file says.
  const write = compareAllowance(
    {'tests/write-synthetic.test.mjs': {codeless: 1, bare: 0, sites: [{kind: 'codeless', line: 9}]}},
    {'tests/write-synthetic.test.mjs': {codeless: 5, bare: 5}},
  );
  assert.equal(write.over.length, 1);
  // A lowered count is reported so the allowance follows the burn-down.
  assert.deepEqual(
    compareAllowance({}, {'tests/synthetic-family.test.mjs': {codeless: 2, bare: 0}}).under.map(u => u.kind),
    ['codeless'],
  );
});

test('write, auth and export test files have no allowance entry', () => {
  const allowance = JSON.parse(fs.readFileSync(allowanceFile, 'utf8')).allowance;
  for (const file of Object.keys(allowance)) assert.ok(!zeroAllowance.test(file), file);
  for (const file of [
    'tests/write-review.test.ts',
    'tests/sheets-authority.test.mjs',
    'tests/account-security.test.ts',
    'tests/workbook-retirement.test.mjs',
    'tests/x-draft-writes.test.ts',
    'tests/tiktok-deletions.test.mjs',
    'tests/connection-disconnect.test.ts',
  ])
    assert.ok(zeroAllowance.test(file), file);
});

test('the command exits non-zero when a named file exceeds its allowance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-oracle-probe-'));
  try {
    const file = path.join(dir, 'write-probe.test.mjs');
    const header = "import assert from 'node:assert/strict';\n";
    fs.writeFileSync(file, header + A('throws', "(() => JSON.parse('{'));\n"));
    const run = spawnSync(process.execPath, ['tools/check-test-oracles.mjs', file], {encoding: 'utf8'});
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /NEW WEAK ORACLE .*write-probe\.test\.mjs bare 1 > 0/);
    fs.writeFileSync(file, header + A('throws', "(() => JSON.parse('{'), SyntaxError);\n"));
    const fixed = spawnSync(process.execPath, ['tools/check-test-oracles.mjs', file], {encoding: 'utf8'});
    assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
  } finally {
    removeTestDirectory(dir, 'amcp-oracle-probe-');
  }
});

test('assertRefused accepts the named refusal and rejects success, another code, a crash and a sent write', () => {
  const refusal = {success: false, error: {code: 'STATE_CHANGED', message: 'The target changed.'}};
  assert.equal(assertRefused(refusal, 'STATE_CHANGED', {writes: 0}), true);
  assert.equal(assertRefused(refusal, ['FORBIDDEN', 'STATE_CHANGED']), true);
  assert.equal(assertRefused(new MirrorError('FORBIDDEN', 'No.', {}, 403), 'FORBIDDEN', {status: 403}), true);
  assert.throws(() => assertRefused({success: true, data: {}}, 'STATE_CHANGED'), /expected a refusal/);
  assert.throws(() => assertRefused(refusal, 'FORBIDDEN'), /refusal code/);
  assert.throws(
    () => assertRefused({success: false, error: {code: 'INTERNAL_ERROR', message: 'x'}}, 'STATE_CHANGED'),
    /crash/,
  );
  assert.throws(() => assertRefused(refusal, 'INTERNAL_ERROR'), /a crash is not a refusal/);
  assert.throws(() => assertRefused(refusal, 'STATE_CHANGED', {writes: () => 1}), /provider writes sent/);
  assert.throws(() => assertRefused(refusal, 'STATE_CHANGED', {message: /deleted/}), /match/);
  assert.throws(() => assertRefused(new TypeError('boom'), 'INVALID_ARGUMENT'), /refusal code/);
  // Regression: a requested status was silently ignored for a service result; it is now checked or fails.
  const withStatus = {success: false, error: {code: 'FORBIDDEN', message: 'No.', status: 403}};
  assert.equal(assertRefused(withStatus, 'FORBIDDEN', {status: 403}), true);
  assert.throws(() => assertRefused(withStatus, 'FORBIDDEN', {status: 401}), /refusal status/);
  assert.throws(() => assertRefused(refusal, 'STATE_CHANGED', {status: 409}), /carries no HTTP status/);
});

test('the burn-down instruments weak sites, rewrites only named refusals and leaves crashes for review', () => {
  const file = 'tests/synthetic.test.mjs',
    text = [
      "import assert from 'node:assert/strict';",
      "import {x} from '../dist/src/x.js';",
      "test('t', async () => {",
      '  ' + A('equal', '((await f.execute(p)).success, false, mode);'),
      '  ' + A('equal', '(out.success, false);'),
      '  ' + A('throws', '(() => compile(bad));'),
      '  await ' + A('rejects', "(run(), 'why');"),
      '  ' + A('equal', '(audited.success, false);'),
      '});',
    ].join('\n');
  assert.deepEqual(refusalAssertion(text, 4).value, '(await f.execute(p))');
  const plan = instrument(file, text);
  assert.equal(plan.sites.length, 5);
  assert.match(plan.text, /__oracleRefusal\("tests\/synthetic\.test\.mjs#0", \(await f\.execute\(p\)\)\)\.success/);
  assert.match(plan.text, /compile\(bad\), __oracleThrown\("tests\/synthetic\.test\.mjs#2"\)\)/);
  assert.match(plan.text, /run\(\), __oracleThrown\("tests\/synthetic\.test\.mjs#3"\), 'why'\)/);
  assert.match(plan.text, /import \{__oracleRefusal, __oracleThrown\} from '\.\/helpers\/oracle-capture\.mjs';/);
  const refusal = code => ({kind: 'refusal', code, success: false}),
    thrown = (code, name = 'MirrorError') => ({kind: 'thrown', code, name, message: 'm'});
  const decisions = [
    decide(plan.sites[0], [refusal('STATE_CHANGED'), refusal('FORBIDDEN')]),
    decide(plan.sites[1], [refusal('CONFIRMATION_REQUIRED')]),
    decide(plan.sites[2], [thrown('INVALID_ARGUMENT')]),
    decide(plan.sites[3], [thrown('ERR_INVALID_ARG_TYPE', 'TypeError')]),
    decide(plan.sites[4], [refusal('INTERNAL_ERROR')]),
  ];
  assert.ok(decisions[3].manual && decisions[4].manual, 'a crash is never written down as the expected refusal');
  assert.equal(decide(plan.sites[1], []).manual, 'not reached in this run');
  assert.deepEqual(decide(plan.sites[2], [thrown(null, 'InvalidGrantError')]), {
    matcher: "{name: 'InvalidGrantError'}",
    codes: ['InvalidGrantError'],
  });
  assert.ok(decide(plan.sites[2], [thrown(null, 'Error')]).manual);
  const out = rewrite(file, text, plan.sites, decisions);
  assert.match(out, /assertRefused\(await f\.execute\(p\), \['STATE_CHANGED', 'FORBIDDEN'\]\);/);
  assert.match(out, /assertRefused\(out, 'CONFIRMATION_REQUIRED'\);/);
  assert.ok(out.includes(A('throws', "(() => compile(bad), {code: 'INVALID_ARGUMENT'});")));
  assert.ok(out.includes(A('rejects', "(run(), 'why');")), 'the crash site is left for review');
  assert.ok(out.includes(A('equal', '(audited.success, false);')), 'the INTERNAL_ERROR site is left for review');
  assert.match(
    out,
    /^import \{x\} from '\.\.\/dist\/src\/x\.js';\nimport \{assertRefused\} from '\.\/helpers\/assert-refused\.mjs';$/m,
  );
});

test('committed tests never import the burn-down instrumentation', () => {
  for (const file of testFiles()) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /helpers\/oracle-capture/, file);
});
