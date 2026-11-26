// QA-01: release manifest v2 records whether the copied bytes are the revision's, the single-file allow-list names
// only tracked files (NOTICE.md and .gitattributes ship), and file-system failures print fixed codes, never paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {
  assembleRelease,
  releaseErrorCode,
  releasePathAllowed,
  releaseSingleFiles,
  worktreeState,
} from '../tools/prepare-public-release.mjs';
import {verifyPublicRelease} from '../tools/verify-public-release.mjs';
import {removeFixture, removeTestDirectory, removeTestPath} from '../dist/tests/temp.js';

const prepareCli = path.resolve('tools/prepare-public-release.mjs'),
  verifyCli = path.resolve('tools/verify-public-release.mjs');

function repository(t) {
  const base = path.resolve('.runtime');
  fs.mkdirSync(base, {recursive: true});
  const parent = fs.realpathSync(base),
    root = fs.mkdtempSync(path.join(parent, 'release-v2-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.ok(resolved.startsWith(parent + path.sep));
    removeTestPath(resolved, {inside: parent});
  });
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {cwd: root, encoding: 'utf8', stdio: 'pipe'}).trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
    fs.writeFileSync(path.join(root, file), text);
  };
  const files = {
    'README.md': 'Synthetic release fixture.\n',
    'NOTICE.md': 'Synthetic notice.\n',
    '.gitattributes': '* text eol=lf\n',
    '.gitignore': '.release/\n',
    'package-lock.json': '{"lockfileVersion":3}\n',
    'src/service.ts': 'export {};\n',
    'server/http.ts': 'export {};\n',
    'tools/guidance-coverage.ts': 'export {};\n',
    'Skills/amcp-campaign-builder/SKILL.md': 'Synthetic skill.\n',
    'docs/REPORTING-OVERVIEW.md': 'Synthetic guide.\n',
    'web/fonts/NotoSansArabic.ttf': 'synthetic font\n',
    'web/fonts/OFL.txt': 'synthetic license\n',
    '.mirror/REPORTS/evidence-hashes.json': '{}\n',
    '.mirror/REPORTS/implementation-status.json': '{"live_read_samples":[]}\n',
    '.mirror/REPORTS/compatibility-verification.json': '{}\n',
    '.mirror/PARITY.md': 'Synthetic parity.\n',
  };
  for (const [file, text] of Object.entries(files)) write(file, text);
  git('init', '-q', '--initial-branch=Work-here');
  git('add', '--', ...Object.keys(files));
  git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-q', '-m', 'Synthetic source');
  return {root, git, write};
}

// The files of the source this check runs in. `npm run check` runs in three places: the Git checkout (the Git index),
// a public candidate assembled from it inside an ignored directory of the checkout (its release-manifest.json lists the
// assembled files), and the container build, whose context has no Git metadata (.dockerignore excludes .git) and holds
// only the checked-out files.
function sourceFiles(files) {
  let prefix = null;
  try {
    prefix = execFileSync('git', ['rev-parse', '--show-prefix'], {encoding: 'utf8', stdio: 'pipe'}).trim();
  } catch {
    // Not inside a Git work tree.
  }
  if (prefix === '')
    return new Set(
      execFileSync('git', ['ls-files', '-z', '--', ...files], {encoding: 'utf8'})
        .split('\0')
        .filter(Boolean),
    );
  if (fs.existsSync('release-manifest.json'))
    return new Set(JSON.parse(fs.readFileSync('release-manifest.json', 'utf8')).files.map(file => file.path));
  return new Set(files.filter(file => fs.existsSync(file)));
}

test('every allow-listed single file is tracked here; NOTICE.md and .gitattributes ship, LICENSE and railway.toml are gone', () => {
  const tracked = sourceFiles(releaseSingleFiles);
  assert.deepEqual(
    releaseSingleFiles.filter(file => !tracked.has(file)),
    [],
  );
  for (const file of ['NOTICE.md', '.gitattributes']) assert.equal(releasePathAllowed(file), true, file);
  for (const file of ['LICENSE', 'railway.toml']) assert.equal(releaseSingleFiles.includes(file), false, file);
});

test('a candidate from a clean tree is manifest v2, contains NOTICE.md and .gitattributes, and verifies', t => {
  const r = repository(t);
  const summary = assembleRelease(r.root, '.release/candidate');
  assert.equal(summary.output, '.release/candidate', 'the summary names no absolute path');
  assert.equal(summary.worktree_clean, true);
  assert.equal(summary.differs_from_revision, 0);
  const candidate = path.join(r.root, '.release/candidate'),
    manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'release-manifest.json'), 'utf8'));
  assert.equal(manifest.version, 2);
  assert.equal(manifest.worktree_clean, true);
  assert.deepEqual(manifest.differs_from_revision, []);
  for (const file of ['NOTICE.md', '.gitattributes']) {
    assert.ok(fs.existsSync(path.join(candidate, file)), file);
    assert.ok(
      manifest.files.some(entry => entry.path === file),
      file,
    );
  }
  const proof = verifyPublicRelease(r.root, '.release/candidate');
  assert.equal(proof.source_tree_hash, manifest.source_tree_hash);
  assert.equal(proof.source_files_equal_head, manifest.files.length - 1);
});

test('a dirty tree yields worktree_clean false with the differing release paths, and the verifier refuses it', t => {
  const r = repository(t);
  r.write('README.md', 'Edited, not committed.\n');
  r.write('src/new.ts', 'export const untracked = true;\n');
  const summary = assembleRelease(r.root, '.release/dirty');
  assert.equal(summary.worktree_clean, false);
  const manifest = JSON.parse(fs.readFileSync(path.join(r.root, '.release/dirty/release-manifest.json'), 'utf8'));
  assert.equal(manifest.worktree_clean, false);
  assert.deepEqual(manifest.differs_from_revision, ['README.md', 'src/new.ts']);
  // Restore the checkout so only the recorded difference (not the current tree) can refuse verification.
  r.git('checkout', '--', 'README.md');
  removeFixture(path.join(r.root, 'src/new.ts'));
  assert.throws(() => verifyPublicRelease(r.root, '.release/dirty'), /differs from its revision/);
});

test('strict cleanliness: an untracked file outside the release scope dirties the tree without being listed', t => {
  const r = repository(t);
  r.write('scratch.txt', 'local note\n');
  assert.deepEqual(worktreeState(r.root), {worktree_clean: false, differs_from_revision: []});
  r.write('server/extra.ts', 'export {};\n');
  assert.deepEqual(worktreeState(r.root), {worktree_clean: false, differs_from_revision: ['server/extra.ts']});
});

test('release tooling prints a fixed code without an absolute path when a path or Git is unavailable', t => {
  const r = repository(t);
  const missing = spawnSync(process.execPath, [verifyCli, '.release/missing'], {cwd: r.root, encoding: 'utf8'});
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr.trim(), 'RELEASE_PATH_UNAVAILABLE');
  assert.ok(!missing.stderr.includes(r.root) && !missing.stderr.includes(path.basename(r.root)));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-not-git-'));
  t.after(() => removeTestDirectory(outside, 'amcp-not-git-'));
  const notGit = spawnSync(process.execPath, [prepareCli, '.release/candidate'], {cwd: outside, encoding: 'utf8'});
  assert.equal(notGit.status, 1);
  assert.equal(notGit.stderr.trim(), 'RELEASE_GIT_UNAVAILABLE');
  assert.ok(!notGit.stderr.includes(outside));
  assert.equal(
    releaseErrorCode(Object.assign(new Error('ENOENT: lstat C:\\x'), {code: 'ENOENT', syscall: 'lstat'})),
    'RELEASE_PATH_UNAVAILABLE',
  );
  assert.equal(releaseErrorCode(new Error('cannot open /home/owner/private')), 'RELEASE_PATH_UNAVAILABLE');
  assert.equal(
    releaseErrorCode(new Error('Wrong revision: release must match current HEAD.')),
    'Wrong revision: release must match current HEAD.',
  );
});
