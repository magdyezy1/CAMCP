// ACC-04 container parity: tests run from a copy of the release scope minus .dockerignore, outside any Git repository,
// as Railway's Dockerfile build runs them. Synthetic candidates and a stand-in dependency directory only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {containerParity, contextFiles, dockerignore, removeLink} from '../tools/container-parity.mjs';
import {ownEntries, removeTestDirectory} from '../dist/tests/temp.js';

const repositoryIgnore = fs.readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8');
// The scratch folders of the OS temporary folder that still hold the copy made from a test source carrying `marker`.
// Another run's scratch copy (the release gate's own container step, on the same machine) is not this call's, so the
// check names its own copy by a line only its test source has, instead of counting every amcp-container-* folder.
const scratchHolding = marker =>
  ownEntries(os.tmpdir(), name => name.startsWith('amcp-container-')).filter(name => {
    try {
      return fs.readFileSync(path.join(os.tmpdir(), name, 'app', 'tests', 'parity.test.mjs'), 'utf8').includes(marker);
    } catch {
      return false;
    }
  });

test('.dockerignore follows Docker: root-anchored patterns, parent directories and exceptions', () => {
  const ignored = dockerignore(repositoryIgnore);
  for (const file of ['node_modules/x/index.js', 'dist/src/a.js', '.git/HEAD', '.env', '.env.local', 'a.key', 'x.log'])
    assert.equal(ignored(file), true, file);
  for (const file of ['.mirror/PRIVATE/a.json', '.runtime/mirror.sqlite', '.release/candidate/package.json'])
    assert.equal(ignored(file), true, file);
  for (const file of ['.env.example', 'src/store.ts', 'tests/x.test.mjs', 'docs/OPERATIONS.md', 'Dockerfile'])
    assert.equal(ignored(file), false, file);
  // Docker matches `*.log` at the root only (unlike .gitignore); `**/` reaches every directory.
  assert.equal(ignored('tests/fixtures/run.log'), false);
  const nested = dockerignore('**/*.log\n# comment\n\n/tmp/\n!tmp/keep');
  assert.equal(nested('tests/fixtures/run.log'), true);
  assert.equal(nested('tmp/a'), true);
  assert.equal(nested('tmp/keep'), false);
  assert.equal(nested('tmpx'), false);
});

function candidate(testSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-parity-candidate-')),
    modules = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-parity-modules-'));
  const files = {
    'tests/parity.test.mjs': testSource,
    'src/a.ts': 'export const a = 1;\n',
    '.env.example': 'MIRROR_DB=\n',
    '.env': 'MIRROR_MASTER_KEY=not-copied\n',
    'dist/stale.js': 'throw new Error("stale build output is never copied");\n',
    '.mirror/RESULTS/live-read-samples.json': '[]\n',
    '.dockerignore': repositoryIgnore,
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
    fs.writeFileSync(path.join(root, file), text);
  }
  // A release candidate lists its files in its manifest; a file it does not list is never copied.
  fs.writeFileSync(path.join(root, 'unlisted.txt'), 'not in the release scope\n');
  fs.writeFileSync(
    path.join(root, 'release-manifest.json'),
    JSON.stringify({version: 2, files: Object.keys(files).map(p => ({path: p}))}),
  );
  fs.writeFileSync(path.join(modules, 'sentinel.txt'), 'dependency target\n');
  return {
    root,
    modules,
    cleanup: () => {
      removeTestDirectory(root, 'amcp-parity-candidate-');
      removeTestDirectory(modules, 'amcp-parity-modules-');
    },
  };
}
const inside = `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
test('runs as the container build does', () => {
  assert.equal(path.basename(process.cwd()), 'app');
  assert.equal(fs.existsSync('.git'), false);
  assert.notEqual(spawnSync('git', ['rev-parse', '--git-dir'], {windowsHide: true}).status, 0, 'no repository above');
  assert.equal(process.env.AMCP_REQUIRE_FFMPEG, 'true');
  assert.equal(process.env.AMCP_TEST_CONCURRENCY, '2');
  assert.equal(fs.readFileSync('node_modules/sentinel.txt', 'utf8'), 'dependency target\\n');
  assert.equal(fs.existsSync('.env'), false);
  assert.equal(fs.existsSync('.env.example'), true);
  assert.equal(fs.existsSync('dist'), false);
  assert.equal(fs.existsSync('unlisted.txt'), false);
  assert.equal(fs.readFileSync('.mirror/RESULTS/live-read-samples.json', 'utf8'), '[]\\n');
});
`;

test('a copy without Git runs the named tests and is removed, leaving the dependency target untouched', async () => {
  const marker = 'copy ' + randomUUID(),
    c = candidate(inside + '// ' + marker + '\n');
  try {
    const listed = contextFiles(c.root);
    // Docker's context keeps .dockerignore itself; .env, dist and unlisted files stay out.
    assert.deepEqual(listed.files, [
      '.dockerignore',
      '.env.example',
      '.mirror/RESULTS/live-read-samples.json',
      'src/a.ts',
      'tests/parity.test.mjs',
    ]);
    const record = await containerParity({
      from: c.root,
      nodeModules: c.modules,
      tests: ['tests/parity.test.mjs'],
      build: false,
    });
    assert.equal(record.passed, true, JSON.stringify(record.steps));
    assert.deepEqual(record.tests, {total: 1, pass: 1, fail: 0, skipped: 0, cancelled: 0});
    assert.equal(record.files, 5);
    assert.equal(record.git_repository, false);
    assert.match(record.source_tree_hash, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(record), new RegExp(os.tmpdir().replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
    assert.equal(fs.readFileSync(path.join(c.modules, 'sentinel.txt'), 'utf8'), 'dependency target\n');
    // Another run's scratch copy appearing meanwhile, as when the release gate runs its own container step on the same
    // machine: not the copy this call made, so it must not fail the check that this one is removed (r25-testhyg).
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-container-foreign-'));
    try {
      assert.deepEqual(scratchHolding(marker), [], 'the copy is removed');
      // The check still finds a copy of this call left behind, whatever else is in the folder.
      fs.mkdirSync(path.join(foreign, 'app', 'tests'), {recursive: true});
      fs.writeFileSync(path.join(foreign, 'app', 'tests', 'parity.test.mjs'), '// ' + marker + '\n');
      assert.deepEqual(scratchHolding(marker), [path.basename(foreign)]);
    } finally {
      removeTestDirectory(foreign, 'amcp-container-foreign-');
    }
  } finally {
    c.cleanup();
  }
});

test('from a checkout, the copy holds the empty generated sample, never the historical one (regression)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-parity-checkout-')),
    modules = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-parity-modules-'));
  try {
    const files = {
      'tests/parity.test.mjs': inside,
      'src/a.ts': 'export const a = 1;\n',
      '.env.example': 'MIRROR_DB=\n',
      '.dockerignore': repositoryIgnore,
      // A checkout's sample may hold historical account responses (synthetic here); they must not reach the copy.
      '.mirror/RESULTS/live-read-samples.json': '[{"account_id":"synthetic-historical-response"}]\n',
    };
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
      fs.writeFileSync(path.join(root, file), text);
    }
    fs.writeFileSync(path.join(modules, 'sentinel.txt'), 'dependency target\n');
    // A checkout (no release manifest): the release scope comes from Git.
    execFileSync('git', ['init', '-q'], {cwd: root, stdio: 'ignore', windowsHide: true});
    const listed = contextFiles(root);
    assert.ok(listed.files.includes('.mirror/RESULTS/live-read-samples.json'));
    const record = await containerParity({
      from: root,
      nodeModules: modules,
      tests: ['tests/parity.test.mjs'],
      build: false,
    });
    // The test inside the copy asserts the sample there is exactly "[]\n".
    assert.equal(record.passed, true, JSON.stringify(record.steps));
    const sha = text => createHash('sha256').update(text).digest('hex'),
      entries = listed.files.map(file => ({
        path: file,
        sha256: sha(file === '.mirror/RESULTS/live-read-samples.json' ? '[]\n' : files[file]),
      }));
    assert.equal(record.source_tree_hash, sha(JSON.stringify(entries)), 'the record hashes the empty sample');
    assert.equal(
      fs.readFileSync(path.join(root, '.mirror/RESULTS/live-read-samples.json'), 'utf8'),
      files['.mirror/RESULTS/live-read-samples.json'],
      'the checkout itself is untouched',
    );
  } finally {
    removeTestDirectory(root, 'amcp-parity-checkout-');
    removeTestDirectory(modules, 'amcp-parity-modules-');
  }
});

test('a failing test fails the parity record with its counts', async () => {
  const c = candidate(
    "import test from 'node:test';\nimport fs from 'node:fs';\ntest('needs Git metadata', () => fs.readFileSync('.git/HEAD'));\n",
  );
  try {
    const record = await containerParity({
      from: c.root,
      nodeModules: c.modules,
      tests: ['tests/parity.test.mjs'],
      build: false,
    });
    assert.equal(record.passed, false);
    assert.equal(record.tests.fail, 1);
    assert.equal(record.steps.at(-1).exit_code, 1);
    assert.equal(fs.readFileSync(path.join(c.modules, 'sentinel.txt'), 'utf8'), 'dependency target\n');
  } finally {
    c.cleanup();
  }
});

test('only a link is removed as a link, and arguments are validated before anything is copied', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-parity-link-'));
  try {
    fs.writeFileSync(path.join(directory, 'kept.txt'), 'x');
    assert.equal(removeLink(directory), false, 'a real directory is not a link');
    assert.equal(fs.existsSync(path.join(directory, 'kept.txt')), true);
    assert.equal(removeLink(path.join(directory, 'absent')), true);
    await assert.rejects(containerParity({from: directory, script: 'check; rm -rf /'}), /USAGE/);
    await assert.rejects(containerParity({from: directory, tests: ['../outside.test.mjs']}), /USAGE/);
    await assert.rejects(containerParity({from: directory, revision: 'HEAD'}), /USAGE/);
  } finally {
    removeTestDirectory(directory, 'amcp-parity-link-');
  }
});
