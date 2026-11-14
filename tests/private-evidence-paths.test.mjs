// F-L10-01 and P2C-03: the evidence package of the Codex session holds the owner's private conversation history and logs full
// of workstation paths. It is in no commit of the integration branch, it is never pushed from it, and it stays out of every
// release candidate. (It is in the history of two local branches, `codex/v2-round2` and `claude/v2-target-record`, which are
// never pushed; a branch that carries it and is pushed, or merged into the integration, publishes it, which is what the
// history guard below refuses for HEAD.) `.gitignore` names its two paths, and this test fails when either exists in the tree,
// on disk or tracked, and when any commit reachable from HEAD touches either, so a candidate cannot carry them in its files or
// in its history. The pre-push scan refuses the same paths in a pushed range (the lead's `prepush-scan.mjs`); this is the guard
// inside the repository. Nothing under those paths is ever read here: only whether a name exists, and which commits list it,
// is looked at.
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
/**
 * The commits reachable from HEAD of `root` that touch a private path: one that adds, changes or removes it, since once it is in
 * history its blobs are. Git lists commits and path names here, never the content of a path. It throws where Git cannot say,
 * so a checkout whose history cannot be read fails the guard and does not pass it.
 */
function privateCommits(root) {
  return execFileSync('git', ['rev-list', 'HEAD', '--', directory, file], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\n')
    .filter(Boolean);
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

test('no commit reachable from HEAD touches a private path (P2C-03)', t => {
  // A copy of the tree without .git (a container image, a release candidate) has no history to read: the pre-push scan holds the
  // range where it is pushed from. Where .git exists (a checkout, or a linked worktree whose .git is a file) the history is asserted.
  if (!fs.existsSync('.git')) return t.skip('no .git here: a copy of the tree has no history to read');
  assert.deepEqual(
    privateCommits(process.cwd()),
    [],
    'a commit reachable from HEAD touches a private path: the package is in this branch’s history, and pushing it publishes it',
  );
});

test('the history guard lists a commit that adds a private path and one that removes it, and passes a clean history (P2C-03)', t => {
  const git = (cwd, ...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args],
      {cwd, stdio: 'ignore'},
    );
  const repository = temporaryRoot(t);
  git(repository, 'init', '-q');
  fs.writeFileSync(path.join(repository, 'src.txt'), 'a public file\n');
  git(repository, 'add', '--', 'src.txt');
  git(repository, 'commit', '-q', '-m', 'a public commit');
  assert.deepEqual(privateCommits(repository), [], 'a clean history lists nothing');
  const clean = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repository, encoding: 'utf8'}).trim();
  // The markdown file, an empty file made for the check and never read, then the directory, then a commit that removes both.
  fs.writeFileSync(path.join(repository, file), '');
  git(repository, 'add', '--', file);
  git(repository, 'commit', '-q', '-m', 'adds the markdown file');
  assert.equal(privateCommits(repository).length, 1, 'a commit that adds the file is listed');
  fs.mkdirSync(path.join(repository, directory));
  fs.writeFileSync(path.join(repository, directory, 'a.txt'), '');
  git(repository, 'add', '--', directory + '/a.txt');
  git(repository, 'commit', '-q', '-m', 'adds the directory');
  assert.equal(privateCommits(repository).length, 2, 'a commit that adds a file under the directory is listed');
  git(repository, 'rm', '-q', '-r', '--', file, directory);
  git(repository, 'commit', '-q', '-m', 'removes both');
  assert.equal(
    privateCommits(repository).length,
    3,
    'a commit that removes them is listed: their blobs stay in history',
  );
  // Only what HEAD reaches counts: a branch cut before the first of them is clean.
  git(repository, 'checkout', '-q', '-b', 'before', clean);
  assert.deepEqual(privateCommits(repository), [], 'a branch that does not reach them lists nothing');
  // A directory that is no repository has no history to read; the guard says so by failing, never by listing nothing.
  assert.throws(() => privateCommits(temporaryRoot(t)), /not a git repository/i);
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
