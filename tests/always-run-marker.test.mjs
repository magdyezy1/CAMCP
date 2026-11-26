// r25-testhyg: two pins went red unseen during a merge because the related-test selection (tools/related-tests.mjs) could
// not see them. A test that lists src/, server/ or web/ when it runs, or counts something out of many files, has no import
// edge to the file a package changes, so a change to that file selected nothing that would have failed. The rule is one
// line in the test's leading comments, `// always-run: <why it reads across the code base>`, and the selection runs every
// marked test whenever anything changed. This file holds the rule and finds the test that lists those directories
// without it, so a new one cannot escape.
// always-run: it lists every test file for the readers that carry no marker, whatever else a change touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {alwaysRunReason, criticalTests, relatedPlan} from '../tools/related-tests.mjs';
import {removeTestDirectory} from '../dist/tests/temp.js';

const testFiles = () =>
  fs
    .readdirSync('tests')
    .filter(name => /\.test\.(?:mjs|ts)$/.test(name))
    .sort();
const marked = name => alwaysRunReason(fs.readFileSync(path.join('tests', name), 'utf8'));

test('the marker is a line comment among the leading comments of a test, with a reason', () => {
  assert.equal(
    alwaysRunReason('// always-run: reads every web script\nimport x from "y";\n'),
    'reads every web script',
  );
  assert.equal(
    alwaysRunReason(
      '// A header.\n\n/**\n * A block.\n */\n  // always-run: counts the catalogue\nimport x from "y";\n',
    ),
    'counts the catalogue',
    'after other comments, indented',
  );
  assert.equal(
    alwaysRunReason('/* one line */\n// always-run: after a one-line block\ntest();\n'),
    'after a one-line block',
  );
  assert.equal(alwaysRunReason('#!/usr/bin/env node\n// always-run: after a shebang\n'), 'after a shebang');
  // Not a marker: no reason, a statement before it, text in a string, inside a block comment, another spelling.
  for (const text of [
    '// always-run:\nimport x from "y";\n',
    '// always-run:    \nimport x from "y";\n',
    'import x from "y";\n// always-run: too late\n',
    'const note = "// always-run: in a string";\n',
    '/*\n// always-run: inside a block comment\n*/\nimport x from "y";\n',
    '// always run: another spelling\n',
    '// Always-Run: another case\n',
    '//always-run: no space\n',
    '',
  ])
    assert.equal(alwaysRunReason(text), null, JSON.stringify(text));
});

test('a marked test is selected whatever changed, once anything has; an unmarked one only for its own reasons', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-always-run-'));
  t.after(() => removeTestDirectory(root, 'amcp-always-run-'));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
    fs.writeFileSync(path.join(root, file), text);
  };
  write('src/a.ts', 'export const a = 1;\n');
  write('src/b.ts', 'export const b = 1;\n');
  write('tests/reads-all.test.mjs', "// always-run: lists src/\nimport fs from 'node:fs';\nfs.readdirSync('src');\n");
  write('tests/uses-a.test.mjs', "import {a} from '../src/a.js';\nconsole.log(a);\n");
  write('tests/other.test.mjs', "// A header.\nimport fs from 'node:fs';\nfs.readdirSync('tests');\n");
  // A change nothing imports: only the marked test runs.
  const plan = relatedPlan({root, changed: ['src/b.ts']});
  assert.deepEqual(plan.selected, ['tests/reads-all.test.mjs']);
  assert.equal(plan.reasons.always_run, 1);
  // A file another test imports: that test for its own reason, the marked one for the marker.
  const imported = relatedPlan({root, changed: ['src/a.ts']});
  assert.deepEqual(imported.selected, ['tests/reads-all.test.mjs', 'tests/uses-a.test.mjs']);
  assert.deepEqual(imported.reasons, {direct: 1, always_run: 1}, 'a test selected for another reason keeps it');
  // A changed marked test is selected as a change, not twice.
  assert.deepEqual(relatedPlan({root, changed: ['tests/reads-all.test.mjs']}).reasons, {changed: 1});
  // Nothing changed, nothing runs; --direct is the old behaviour, without extras.
  assert.deepEqual(relatedPlan({root, changed: []}).selected, []);
  assert.deepEqual(relatedPlan({root, changed: ['src/b.ts'], direct: true}).selected, []);
});

test('every marked test of the repository is selected for a change nothing imports, beside the critical set', () => {
  const plan = relatedPlan({changed: ['docs/OPERATIONS.md']}),
    marks = testFiles().filter(marked);
  assert.ok(marks.length >= 40, 'the repository marks its readers: ' + marks.length);
  for (const name of marks) assert.ok(plan.selected.includes('tests/' + name), name);
  for (const file of criticalTests) assert.ok(plan.selected.includes(file), file);
  for (const name of marks) assert.ok(marked(name).length >= 12, name + ': say why in the reason');
});

// The tests the owner's list names, each read across the code base: the catalogue, localization and inventory counts, the
// router's layers, the contract ledgers, the tool-surface golden, the capability claims, the toast tones, the website
// diagnostics, the remedyUses and copiedMessages tripwires (web-locale-chunks), and the docs-lint style checks.
const named = [
  'backend-contract-localization.test.mjs',
  'backend-wrapper-localization.test.mjs',
  'shared-recovery-localization.test.mjs',
  'linkedin-conversion-diagnostics-localization.test.mjs',
  'website-diagnostics-localization.test.mjs',
  'website-routes.test.mjs',
  'action-contracts.test.ts',
  'action-contract-artifacts.test.ts',
  'acceptance-ledger.test.mjs',
  'tool-surface-golden.test.mjs',
  'capability-claims.test.mjs',
  'shell-toast-tone.test.mjs',
  'web-locale-chunks.test.mjs',
  'docs-lint.test.mjs',
  'report-collect-golden.test.mjs',
  'temp-hygiene.test.mjs',
];
test('the tests that read across the code base by name carry the marker', () => {
  for (const name of named) {
    assert.ok(fs.existsSync(path.join('tests', name)), name + ' exists');
    assert.ok(marked(name), name + ' carries // always-run: <reason>');
  }
});

// A test that lists a directory of src/, server/ or web/ when it runs reads across the code base. The scan is wide on
// purpose, like the planner's (tools/related-tests.mjs readsWebDynamically): a listing call (readdirSync, readdir, opendir,
// glob) anywhere in the file and a path literal that names one of those directories anywhere in it. A test selected
// without need costs one run; one missed costs a late failure. The few that only list a folder they made themselves, and
// merely name a path of the code base in a fixture, are named here with the reason, so the list cannot go stale unseen.
const listing = /\b(?:readdirSync|readdir|opendirSync|opendir|globSync|glob)\s*\(/;
const codebase = /(['"`])(?:[^'"`\n]*[\\/])?(?:src|server|web)(?:[\\/][^'"`\n]*)?\1/;
const listsOnlyItsOwnFolder = {
  'backup-recovery.test.mjs': 'lists the backup folder it made (amcp-backup-*)',
  'docs-status.test.mjs': 'lists the docs/records of a fixture tree it made',
  'meta-provision.test.ts': 'reads the data folder it made',
};
const readers = () =>
  testFiles().filter(name => {
    const text = fs.readFileSync(path.join('tests', name), 'utf8');
    return listing.test(text) && codebase.test(text);
  });
test('a test that lists src/, server/ or web/ carries the marker, or is named as listing only its own folder', () => {
  const unmarked = readers().filter(name => !marked(name) && !(name in listsOnlyItsOwnFolder));
  assert.deepEqual(
    unmarked,
    [],
    'add `// always-run: <why it reads across the code base>` to the leading comments of each, so a change to a file it does not import still runs it',
  );
  // The list names real readers of a folder of their own, and drops out when a test stops being one.
  for (const [name, reason] of Object.entries(listsOnlyItsOwnFolder)) {
    assert.ok(readers().includes(name), name + ' no longer matches the scan: remove it from the list');
    assert.equal(marked(name), null, name + ' is marked: remove it from the list (' + reason + ')');
  }
});
