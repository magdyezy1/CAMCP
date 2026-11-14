// F-L10-01: the evidence package of the Codex session holds the owner's private conversation history and logs full of
// workstation paths. It stays off every pushed branch and out of every release candidate. `.gitignore` names its two paths, and
// this test fails when either exists in the tree, on disk or tracked, so a candidate cannot carry them. The pre-push scan refuses
// the same paths in a pushed range (the lead's `prepush-scan.mjs`); this is the guard inside the repository. Nothing under
// those paths is ever read here: only whether a name exists is looked at.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {removeTestDirectory} from '../dist/tests/temp.js';

const directory = 'codex-changes-evidence',
  file = 'Codex changes.md';
const isPrivate = name => name === file || name === directory || name.startsWith(directory + '/');
/** The paths Git tracks under `root`, or none where `root` is no Git checkout (a release candidate has no .git). */
function tracked(root) {
  try {
    return execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\0')
      .filter(Boolean);
  } catch {
    return [];
  }
}
/** The private paths under `root`: names on disk (a link counts, nothing is followed) and names the index tracks. */
function privatePaths(root) {
  const onDisk = [directory, file].filter(name => {
    try {
      fs.lstatSync(path.join(root, name));
      return true;
    } catch {
      return false;
    }
  });
  return {on_disk: onDisk, tracked: tracked(root).filter(isPrivate)};
}
const temporaryRoot = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-private-paths-'));
  t.after(() => removeTestDirectory(root, 'amcp-private-paths-'));
  return root;
};

test('.gitignore names both private paths, each on a line of its own and not negated', () => {
  const lines = fs
    .readFileSync('.gitignore', 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim());
  assert.ok(lines.includes(directory + '/'), directory + '/ is not in .gitignore');
  assert.ok(lines.includes(file), file + ' is not in .gitignore');
  assert.deepEqual(
    lines.filter(line => line.startsWith('!') && (line.includes(directory) || line.includes('Codex'))),
    [],
    'a negated rule would take a private path back',
  );
});

test('neither private path exists in this tree: not on disk and not tracked', () => {
  assert.deepEqual(privatePaths(process.cwd()), {on_disk: [], tracked: []});
});

test('the guard sees each private path when one is present, on disk or tracked, and a clean tree passes', t => {
  const clean = temporaryRoot(t);
  fs.writeFileSync(path.join(clean, 'README.md'), 'a public file\n');
  assert.deepEqual(privatePaths(clean), {on_disk: [], tracked: []});
  // The directory, with a file in it, and the markdown file: empty files made for the check, never read.
  const present = temporaryRoot(t);
  fs.mkdirSync(path.join(present, directory));
  fs.writeFileSync(path.join(present, directory, 'a.txt'), '');
  fs.writeFileSync(path.join(present, file), '');
  assert.deepEqual(privatePaths(present).on_disk, [directory, file]);
  // Only the directory: a candidate that carried a history folder is refused too.
  const folder = temporaryRoot(t);
  fs.mkdirSync(path.join(folder, directory));
  assert.deepEqual(privatePaths(folder).on_disk, [directory]);
  // Tracked: Git lists the path even where the file is gone from the disk.
  const repository = temporaryRoot(t);
  execFileSync('git', ['init', '-q'], {cwd: repository, stdio: 'ignore'});
  fs.mkdirSync(path.join(repository, directory));
  fs.writeFileSync(path.join(repository, directory, 'b.txt'), '');
  fs.writeFileSync(path.join(repository, file), '');
  fs.writeFileSync(path.join(repository, 'src.txt'), '');
  execFileSync('git', ['add', '--', directory + '/b.txt', file, 'src.txt'], {cwd: repository, stdio: 'ignore'});
  fs.rmSync(path.join(repository, file));
  fs.rmSync(path.join(repository, directory), {recursive: true});
  const seen = privatePaths(repository);
  assert.deepEqual(seen.on_disk, []);
  assert.deepEqual(seen.tracked.sort(), [directory + '/b.txt', file].sort());
});
