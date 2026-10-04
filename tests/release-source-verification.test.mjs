import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {releasePathAllowed} from '../tools/prepare-public-release.mjs';

const script = path.resolve('tools/verify-public-release.mjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sample = '.mirror/RESULTS/live-read-samples.json';
function fixture(t) {
  const base = path.resolve('.runtime');
  fs.mkdirSync(base, {recursive: true});
  const parent = fs.realpathSync(base),
    root = fs.mkdtempSync(path.join(parent, 'release-source-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.ok(resolved.startsWith(parent + path.sep));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  const git = (args, input) =>
    execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
      cwd: root,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  const write = (file, bytes) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, bytes);
  };
  const files = {
    'README.md': 'Synthetic release fixture.\n',
    '.gitignore': '.release/\nprivate/\n',
    '.gitattributes': '* text eol=lf\n',
    'docs/وصف المشروع.md': 'Synthetic source with spaces and Arabic filename.\n',
    '.mirror/REPORTS/implementation-status.json': '{"live_read_samples":[]}\n',
    '.mirror/REPORTS/compatibility-verification.json': '{"synthetic":true}\n',
    '.mirror/PARITY.md': 'Synthetic parity.\n',
  };
  for (const [file, bytes] of Object.entries(files)) write(file, bytes);
  git(['init', '--initial-branch=Work-here']);
  git(['add', '--', ...Object.keys(files)]);
  git([
    '-c',
    'user.name=Synthetic release fixture',
    '-c',
    'user.email=synthetic@example.test',
    'commit',
    '-m',
    'Synthetic public source',
  ]);
  const output = path.join(root, '.release', 'candidate');
  fs.mkdirSync(output, {recursive: true});
  let entries = Object.keys(files)
    .filter(releasePathAllowed)
    .sort()
    .map(file => {
      const bytes = fs.readFileSync(path.join(root, file)),
        target = path.join(output, file);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.writeFileSync(target, bytes);
      return {path: file, sha256: sha(bytes), bytes: bytes.length};
    });
  fs.mkdirSync(path.dirname(path.join(output, sample)), {recursive: true});
  fs.writeFileSync(path.join(output, sample), '[]\n');
  entries.push({
    path: sample,
    sha256: sha('[]\n'),
    bytes: 3,
    generated: 'Historical account responses are never included in a release.',
  });
  const original = {
    version: 1,
    revision: git(['rev-parse', 'HEAD']),
    branch: 'Work-here',
    source_tree_hash: sha(JSON.stringify(entries)),
    files: entries,
  };
  const seal = manifest => {
    manifest.source_tree_hash = sha(JSON.stringify(manifest.files));
    fs.writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  };
  seal(original);
  const call = () =>
    JSON.parse(
      execFileSync(process.execPath, [script, output], {cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']}),
    );
  const failure = pattern =>
    assert.throws(
      call,
      error => pattern.test(String(error.stderr)) && !String(error.stderr).includes('PRIVATE_SENTINEL'),
    );
  return {root, output, original, git, write, seal, call, failure, sources: entries.length - 1};
}

test('release source verifier proves every public Git blob, exact manifest and three reports without writing source', t => {
  const f = fixture(t),
    before = f.git(['rev-parse', 'HEAD']),
    proof = f.call();
  assert.equal(proof.revision, before);
  assert.equal(proof.branch, 'Work-here');
  assert.equal(proof.source_tree_hash, f.original.source_tree_hash);
  assert.equal(proof.source_files_equal_head, f.sources);
  assert.equal(proof.generated_empty_samples, 1);
  assert.equal(proof.tracked_reports_equal_head, 3);
  assert.equal(f.git(['status', '--porcelain']), '');
  assert.equal(f.git(['rev-parse', 'HEAD']), before);
});

test('release verifier refuses raw CRLF bytes even when Git input filters would match the original LF commit', t => {
  const f = fixture(t),
    bytes = Buffer.from('Synthetic release fixture.\r\n');
  fs.writeFileSync(path.join(f.output, 'README.md'), bytes);
  assert.equal(f.git(['status', '--porcelain']), '');
  const filtered = f.git(['hash-object', '--path=README.md', '--stdin'], bytes),
    raw = f.git(['hash-object', '--no-filters', '--stdin'], bytes);
  assert.equal(filtered, f.git(['rev-parse', 'HEAD:README.md']));
  assert.notEqual(filtered, raw);
  const manifest = structuredClone(f.original),
    entry = manifest.files.find(f => f.path === 'README.md');
  entry.bytes = bytes.length;
  entry.sha256 = sha(bytes);
  f.seal(manifest);
  f.failure(/Bytes differ from HEAD/);
});

test('release verifier refuses omitted, duplicated, private, traversing or altered metadata before trusting candidate bytes', t => {
  const f = fixture(t);
  f.write('private/secret.json', 'PRIVATE_SENTINEL');
  for (const [mutate, pattern] of [
    [m => m.files.splice(0, 1), /Missing public HEAD files/],
    [m => m.files.push({...m.files[0]}), /Repeated release path/],
    [m => (m.files[0].path = 'docs/../private/secret.json'), /Unsafe release path/],
    [m => (m.files[0].path = 'private/secret.json'), /Disallowed source path/],
    [m => (m.files[0].bytes = -1), /Invalid release file metadata/],
    [m => (m.files[0].sha256 = [m.files[0].sha256]), /Invalid release file metadata/],
    [m => (m.revision = 'a'.repeat(40)), /Wrong revision/],
    [m => (m.branch = 'other'), /Wrong branch/],
    [m => (m.version = 2), /Unsupported release manifest/],
  ]) {
    const manifest = structuredClone(f.original);
    mutate(manifest);
    f.seal(manifest);
    f.failure(pattern);
  }
  const wrong = structuredClone(f.original);
  wrong.source_tree_hash = 'a'.repeat(64);
  fs.writeFileSync(path.join(f.output, 'release-manifest.json'), JSON.stringify(wrong));
  f.failure(/Source tree hash mismatch/);
});

test('release verifier refuses dirty source, changed candidate content and public reports containing samples', t => {
  const f = fixture(t);
  f.write('README.md', 'Changed source.\n');
  f.failure(/Commit the current source/);
  f.write('README.md', 'Synthetic release fixture.\n');
  fs.writeFileSync(path.join(f.output, 'README.md'), 'Changed candidate.\n');
  f.failure(/Manifest mismatch/);
  fs.writeFileSync(path.join(f.output, 'README.md'), 'Synthetic release fixture.\n');
  const report = '.mirror/REPORTS/implementation-status.json',
    bytes = Buffer.from('{"live_read_samples":[{"value":"PRIVATE_SENTINEL"}]}\n');
  fs.writeFileSync(path.join(f.output, report), bytes);
  const manifest = structuredClone(f.original),
    entry = manifest.files.find(f => f.path === report);
  entry.sha256 = sha(bytes);
  entry.bytes = bytes.length;
  f.seal(manifest);
  f.failure(/Public implementation report must/);
});

test('release verifier withholds nonempty, missing or additional generated samples', t => {
  const f = fixture(t),
    bytes = Buffer.from('[{"value":"PRIVATE_SENTINEL"}]\n');
  fs.writeFileSync(path.join(f.output, sample), bytes);
  const manifest = structuredClone(f.original),
    entry = manifest.files.at(-1);
  entry.sha256 = sha(bytes);
  entry.bytes = bytes.length;
  f.seal(manifest);
  f.failure(/Release sample must be empty/);
  fs.writeFileSync(path.join(f.output, sample), '[]\n');
  for (const mutate of [m => m.files.pop(), m => m.files.push({...m.files.at(-1), path: 'docs/generated.md'})]) {
    const m = structuredClone(f.original);
    mutate(m);
    f.seal(m);
    f.failure(/Unexpected generated release input/);
  }
});

test('release verifier rejects linked candidate directories without reading their target or modifying the fixture', t => {
  const f = fixture(t),
    old = path.join(f.output, 'docs'),
    target = path.join(f.root, 'private', 'linked-docs');
  fs.mkdirSync(path.dirname(target), {recursive: true});
  assert.ok(path.resolve(old).startsWith(f.root + path.sep) && path.resolve(target).startsWith(f.root + path.sep));
  fs.renameSync(old, target);
  fs.symlinkSync(target, old, 'junction');
  f.failure(/Release links are not allowed/);
  assert.equal(f.git(['status', '--porcelain']), '');
});
