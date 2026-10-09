import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// Git's own diagnostics can name absolute paths; they are captured, never printed (QA-01).
const gitStdio = ['ignore', 'pipe', 'pipe'];
const directories = [
  'src/',
  'server/',
  'tests/',
  'tools/',
  'codegen/',
  'generated/',
  'web/',
  'deploy/',
  'docs/',
  'Skills/amcp-campaign-builder/',
  '.github/',
  '.mirror/CATALOG/',
  '.mirror/RAW/',
  '.mirror/VENDOR/',
];
// Every entry is a tracked file (tests/release-candidate-v2.test.mjs checks it): NOTICE.md and .gitattributes ship;
// LICENSE and railway.toml were listed but never existed (QA-01). A license file is an owner decision (docs/DECISIONS.md).
export const releaseSingleFiles = Object.freeze([
  'README.md',
  'NOTICE.md',
  '.gitattributes',
  'Dockerfile',
  'railway.json',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  '.prettierrc.json',
  '.prettierignore',
  '.editorconfig',
  '.npmrc',
  '.gitignore',
  '.dockerignore',
  '.env.example',
  '.mirror/TOOLS.json',
  '.mirror/REPORTS/evidence-hashes.json',
  '.mirror/REPORTS/implementation-status.json',
  '.mirror/REPORTS/compatibility-verification.json',
  '.mirror/PARITY.md',
]);
const single = new Set(releaseSingleFiles);
export function assertPublicImplementationReport(bytes) {
  let report;
  try {
    report = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw Error('Public implementation report must be valid JSON with an empty live_read_samples array.');
  }
  if (!report || !Array.isArray(report.live_read_samples) || report.live_read_samples.length !== 0)
    throw Error('Public implementation report must contain an empty live_read_samples array.');
}
export function releasePathAllowed(file) {
  return (
    !/(?:^|\/)(?:node_modules|dist|\.git|\.runtime|\.release|PRIVATE|REVIEW_SNAPSHOT|secrets)(?:\/|$)/i.test(file) &&
    !/(?:^|\/)(?:auth|tokens)\.json$|\.(?:sqlite(?:-wal|-shm)?|db|key|token|pem|log|jsonl)$/i.test(file) &&
    (!(file.split('/').at(-1) ?? '').startsWith('.env') || file === '.env.example') &&
    (single.has(file) || directories.some(d => file.startsWith(d)))
  );
}
const generatedSample = {
  path: '.mirror/RESULTS/live-read-samples.json',
  sha256: sha('[]\n'),
  bytes: 3,
  generated: 'Historical account responses are never included in a release.',
};
/** At most this many differing paths are listed in a manifest; any difference already refuses exact verification. */
export const maxDifferingPaths = 1000;
/**
 * How the working tree differs from HEAD (manifest v2, QA-01): `worktree_clean` is repository-wide (strict), and
 * `differs_from_revision` lists the release-scope paths whose working bytes are not the revision's.
 */
export function worktreeState(root) {
  const records = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: gitStdio,
  }).split('\0');
  const paths = new Set();
  let any = false;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    any = true;
    const status = record.slice(0, 2),
      file = record.slice(3);
    paths.add(file);
    // A rename or copy is followed by its original path, which also differs from the revision.
    if (/[RC]/.test(status) && records[i + 1]) paths.add(records[++i]);
  }
  return {
    worktree_clean: !any,
    differs_from_revision: [...paths].filter(releasePathAllowed).sort().slice(0, maxDifferingPaths),
  };
}
/** The release source entries (path, sha256, bytes) and their source_tree_hash, without copying anything. */
export function releaseSourceEntries(root) {
  root = fs.realpathSync(root);
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: gitStdio,
  })
    .split('\0')
    .filter(Boolean)
    .filter(releasePathAllowed)
    .sort();
  const entries = [];
  for (const file of [...new Set(files)]) {
    const source = path.join(root, file);
    if (!fs.existsSync(source)) throw Error('Release source was deleted: ' + file);
    let segment = root;
    for (const part of file.split('/')) {
      segment = path.join(segment, part);
      if (fs.lstatSync(segment).isSymbolicLink()) throw Error('Release links are not allowed: ' + file);
    }
    if (!fs.statSync(source).isFile()) throw Error('Not a regular release file: ' + file);
    const bytes = fs.readFileSync(source);
    if (file === '.mirror/REPORTS/implementation-status.json') assertPublicImplementationReport(bytes);
    entries.push({path: file, sha256: sha(bytes), bytes: bytes.length});
  }
  const all = [...entries, generatedSample];
  return {entries, source_tree_hash: sha(JSON.stringify(all))};
}
/** Fixed public diagnostics: file-system and Git failures never print absolute paths or tool output. */
export function releaseErrorCode(error) {
  if (error && typeof error === 'object') {
    if (typeof error.syscall === 'string' || (typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code)))
      return 'RELEASE_PATH_UNAVAILABLE';
    if ('status' in error && ('stderr' in error || 'signal' in error)) return 'RELEASE_GIT_UNAVAILABLE';
  }
  const message = error instanceof Error ? error.message : String(error);
  return /[A-Za-z]:[\\/]|(?:^|\s)\/(?:Users|home|tmp|var|private|root|mnt|data)\//.test(message)
    ? 'RELEASE_PATH_UNAVAILABLE'
    : message;
}
export function assembleRelease(root, output) {
  root = fs.realpathSync(root);
  const releaseRoot = path.join(root, '.release');
  output = path.resolve(root, output);
  if (!output.startsWith(releaseRoot + path.sep) || fs.existsSync(output))
    throw Error(
      'Use a new output directory inside this checkout .release directory. Existing output is never overwritten.',
    );
  const state = worktreeState(root);
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: gitStdio,
  })
    .split('\0')
    .filter(Boolean)
    .filter(releasePathAllowed)
    .sort();
  const entries = [];
  for (const file of [...new Set(files)]) {
    const source = path.join(root, file);
    if (!fs.existsSync(source)) throw Error('Release source was deleted: ' + file);
    // Reject links at every component; a public source path cannot traverse into private data.
    let segment = root;
    for (const part of file.split('/')) {
      segment = path.join(segment, part);
      if (fs.lstatSync(segment).isSymbolicLink()) throw Error('Release links are not allowed: ' + file);
    }
    if (!fs.statSync(source).isFile()) throw Error('Not a regular release file: ' + file);
    const bytes = fs.readFileSync(source);
    if (file === '.mirror/REPORTS/implementation-status.json') assertPublicImplementationReport(bytes);
    entries.push({path: file, sha256: sha(bytes), bytes: bytes.length});
  }
  for (const required of [
    'package-lock.json',
    'src/service.ts',
    'server/http.ts',
    'tools/guidance-coverage.ts',
    'Skills/amcp-campaign-builder/SKILL.md',
    'docs/REPORTING-OVERVIEW.md',
    'web/fonts/NotoSansArabic.ttf',
    'web/fonts/OFL.txt',
    '.mirror/REPORTS/evidence-hashes.json',
    '.mirror/REPORTS/implementation-status.json',
    '.mirror/REPORTS/compatibility-verification.json',
    '.mirror/PARITY.md',
  ])
    if (!entries.some(e => e.path === required)) throw Error('Release dependency missing: ' + required);
  fs.mkdirSync(output, {recursive: true});
  for (const e of entries) {
    const destination = path.join(output, e.path);
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.copyFileSync(path.join(root, e.path), destination);
    if (sha(fs.readFileSync(destination)) !== e.sha256) throw Error('Release changed while copying: ' + e.path);
  }
  const samples = path.join(output, '.mirror/RESULTS/live-read-samples.json');
  fs.mkdirSync(path.dirname(samples), {recursive: true});
  fs.writeFileSync(samples, '[]\n');
  entries.push({...generatedSample});
  // Manifest v2 (QA-01): the revision label is accompanied by whether the copied bytes are that revision's.
  const manifest = {
    version: 2,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8', stdio: gitStdio}).trim(),
    branch: execFileSync('git', ['branch', '--show-current'], {cwd: root, encoding: 'utf8', stdio: gitStdio}).trim(),
    worktree_clean: state.worktree_clean,
    differs_from_revision: state.differs_from_revision,
    source_tree_hash: sha(JSON.stringify(entries)),
    files: entries,
  };
  fs.writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return {
    output: path.relative(root, output).replaceAll('\\', '/'),
    source_tree_hash: manifest.source_tree_hash,
    files: entries.length,
    worktree_clean: manifest.worktree_clean,
    differs_from_revision: manifest.differs_from_revision.length,
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = process.argv[2] ?? '.release/candidate';
    console.log(JSON.stringify(assembleRelease(process.cwd(), output)));
  } catch (error) {
    console.error(releaseErrorCode(error));
    process.exitCode = 1;
  }
}
