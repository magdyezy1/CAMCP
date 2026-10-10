import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  assertPublicImplementationReport,
  maxDifferingPaths,
  releaseErrorCode,
  releasePathAllowed,
} from './prepare-public-release.mjs';

const sample = '.mirror/RESULTS/live-read-samples.json';
const reports = [
  '.mirror/REPORTS/implementation-status.json',
  '.mirror/REPORTS/compatibility-verification.json',
  '.mirror/PARITY.md',
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const safePath = file =>
  typeof file === 'string' &&
  !/[\\\x00-\x1f\x7f]/.test(file) &&
  !file.startsWith('/') &&
  !file.split('/').some(part => !part || part === '.' || part === '..');
function regularPath(root, file, directory = false) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw Error('Release path is outside its selected directory.');
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw Error('Release links are not allowed.');
    if (current !== file && !stat.isDirectory()) throw Error('Release parent must be a directory.');
    if (current === file && (directory ? !stat.isDirectory() : !stat.isFile()))
      throw Error('Not a regular release file or directory.');
  }
}

/** Read-only manifest/source proof. Qualification and previous CI remain separate release gates. */
export function verifyPublicRelease(root, output) {
  root = fs.realpathSync(root);
  const candidate = path.resolve(root, output);
  if (!candidate.startsWith(path.join(root, '.release') + path.sep))
    throw Error('Select a candidate inside this checkout .release directory.');
  regularPath(root, candidate, true);
  const git = (args, input) =>
    execFileSync('git', args, {
      cwd: root,
      input,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: {...process.env, GIT_OPTIONAL_LOCKS: '0'},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  if (fs.realpathSync(git(['rev-parse', '--show-toplevel']).trim()) !== root)
    throw Error('Run source verification from the repository root.');
  if (git(['status', '--porcelain', '--untracked-files=all']).trim())
    throw Error('Commit the current source before exact release verification.');
  const revision = git(['rev-parse', 'HEAD']).trim(),
    branch = git(['branch', '--show-current']).trim();
  const format = git(['rev-parse', '--show-object-format']).trim();
  if (!['sha1', 'sha256'].includes(format)) throw Error('Unsupported Git object format.');
  const manifestFile = path.join(candidate, 'release-manifest.json');
  regularPath(candidate, manifestFile);
  if (fs.statSync(manifestFile).size > 8 * 1024 * 1024) throw Error('Release manifest exceeds its size limit.');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  // v1 manifests stay readable; v2 (QA-01) adds whether the copied bytes were the revision's.
  const keys = {
    1: ['version', 'revision', 'branch', 'source_tree_hash', 'files'],
    2: ['version', 'revision', 'branch', 'worktree_clean', 'differs_from_revision', 'source_tree_hash', 'files'],
  }[manifest?.version];
  if (
    !manifest ||
    !keys ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 20000 ||
    Object.keys(manifest).length !== keys.length ||
    Object.keys(manifest).some(k => !keys.includes(k)) ||
    (manifest.version === 2 &&
      (typeof manifest.worktree_clean !== 'boolean' ||
        !Array.isArray(manifest.differs_from_revision) ||
        manifest.differs_from_revision.length > maxDifferingPaths ||
        !manifest.differs_from_revision.every(safePath)))
  )
    throw Error('Unsupported release manifest.');
  if (manifest.version === 2 && (!manifest.worktree_clean || manifest.differs_from_revision.length))
    throw Error('The candidate was assembled from a working tree that differs from its revision; assemble it again.');
  if (manifest.revision !== revision) throw Error('Wrong revision: release must match current HEAD.');
  if (manifest.branch !== branch) throw Error('Wrong branch: release must match the current checkout.');
  if (manifest.source_tree_hash !== sha(JSON.stringify(manifest.files))) throw Error('Source tree hash mismatch.');
  const seen = new Set(),
    sources = [],
    generated = [];
  let total = 0;
  for (const entry of manifest.files) {
    if (!entry || !safePath(entry.path)) throw Error('Unsafe release path.');
    if (seen.has(entry.path)) throw Error('Repeated release path.');
    seen.add(entry.path);
    if (
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > 256 * 1024 * 1024 ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '') ||
      Object.keys(entry).some(k => !['path', 'bytes', 'sha256', 'generated'].includes(k))
    )
      throw Error('Invalid release file metadata.');
    total += entry.bytes;
    if (total > 1024 * 1024 * 1024) throw Error('Release sources exceed their byte limit.');
    if (entry.generated !== undefined) generated.push(entry);
    else {
      if (!releasePathAllowed(entry.path)) throw Error('Disallowed source path.');
      sources.push(entry);
    }
  }
  if (
    generated.length !== 1 ||
    generated[0].path !== sample ||
    typeof generated[0].generated !== 'string' ||
    !generated[0].generated
  )
    throw Error('Unexpected generated release input.');
  const committed = new Map();
  for (const line of git(['ls-tree', '-rz', 'HEAD']).split('\0').filter(Boolean)) {
    const tab = line.indexOf('\t'),
      file = line.slice(tab + 1),
      [mode, type, oid] = line.slice(0, tab).split(' ');
    if (!releasePathAllowed(file)) continue;
    if (!safePath(file) || type !== 'blob' || !['100644', '100755'].includes(mode))
      throw Error('Unsupported public Git source.');
    committed.set(file, oid);
  }
  if ([...committed.keys()].some(file => !sources.some(entry => entry.path === file)))
    throw Error('Missing public HEAD files.');
  if (sources.length !== committed.size || sources.some(entry => !committed.has(entry.path)))
    throw Error('Unexpected public release source.');
  if (reports.some(file => !committed.has(file))) throw Error('Missing tracked public reports.');
  const observed = new Map();
  for (const entry of [...sources, ...generated]) {
    const file = path.join(candidate, entry.path);
    regularPath(candidate, file);
    if (fs.statSync(file).size !== entry.bytes) throw Error('Manifest mismatch: ' + entry.path);
    const bytes = fs.readFileSync(file);
    if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) throw Error('Manifest mismatch: ' + entry.path);
    if (entry.path === sample) {
      if (!bytes.equals(Buffer.from('[]\n'))) throw Error('Release sample must be empty.');
      continue;
    }
    if (entry.path === reports[0]) assertPublicImplementationReport(bytes);
    // Bind exactly the captured buffer to the committed blob, independent of any Git input filters.
    const oid = createHash(format)
      .update(Buffer.from('blob ' + bytes.length + '\0'))
      .update(bytes)
      .digest('hex');
    if (oid !== committed.get(entry.path)) throw Error('Bytes differ from HEAD: ' + entry.path);
    observed.set(entry.path, oid);
  }
  const hashes = git(
    ['hash-object', '--no-filters', '--stdin-paths'],
    sources.map(entry => JSON.stringify(path.resolve(candidate, entry.path).replaceAll('\\', '/'))).join('\n') + '\n',
  )
    .trim()
    .split(/\r?\n/);
  if (hashes.length !== sources.length || sources.some((entry, i) => hashes[i] !== observed.get(entry.path)))
    throw Error('Release sources changed during verification.');
  if (
    git(['rev-parse', 'HEAD']).trim() !== revision ||
    git(['branch', '--show-current']).trim() !== branch ||
    git(['status', '--porcelain', '--untracked-files=all']).trim()
  )
    throw Error('The checkout changed during release verification.');
  return {
    record_kind: 'public_release_source_verification',
    revision,
    branch,
    source_tree_hash: manifest.source_tree_hash,
    source_files_equal_head: sources.length,
    generated_empty_samples: 1,
    tracked_reports_equal_head: reports.length,
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw Error('Usage: node tools/verify-public-release.mjs .release/candidate');
    console.log(JSON.stringify(verifyPublicRelease(process.cwd(), process.argv[2] ?? '.release/candidate')));
  } catch (error) {
    // File-system and Git failures print a fixed code, never an absolute path (QA-01).
    console.error(releaseErrorCode(error));
    process.exitCode = 1;
  }
}
