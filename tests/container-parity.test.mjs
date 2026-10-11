// ACC-04 container parity: tests run from a copy of the release scope minus .dockerignore, outside any Git repository,
// as Railway's Dockerfile build runs them. Synthetic candidates and a stand-in dependency directory only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {containerParity, contextFiles, dockerignore, removeLink} from '../tools/container-parity.mjs';

const repositoryIgnore = fs.readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8');
const scratchCount = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('amcp-container-')).length;

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
      fs.rmSync(root, {recursive: true, force: true});
      fs.rmSync(modules, {recursive: true, force: true});
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
  const c = candidate(inside),
    before = scratchCount();
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
    assert.equal(scratchCount(), before, 'the copy is removed');
  } finally {
    c.cleanup();
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
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
