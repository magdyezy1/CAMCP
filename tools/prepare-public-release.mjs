import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
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
const single = new Set([
  'README.md',
  'LICENSE',
  'Dockerfile',
  'railway.toml',
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
]);
export function releasePathAllowed(file) {
  return (
    !/(?:^|\/)(?:node_modules|dist|\.git|\.runtime|\.release|PRIVATE|REVIEW_SNAPSHOT|secrets)(?:\/|$)/i.test(file) &&
    !/(?:^|\/)(?:auth|tokens)\.json$|\.(?:sqlite(?:-wal|-shm)?|db|key|token|pem|log|jsonl)$/i.test(file) &&
    (!(file.split('/').at(-1) ?? '').startsWith('.env') || file === '.env.example') &&
    (single.has(file) || directories.some(d => file.startsWith(d)))
  );
}
export function assembleRelease(root, output) {
  root = fs.realpathSync(root);
  const releaseRoot = path.join(root, '.release');
  output = path.resolve(root, output);
  if (!output.startsWith(releaseRoot + path.sep) || fs.existsSync(output))
    throw Error(
      'Use a new output directory inside this checkout .release directory. Existing output is never overwritten.',
    );
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
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
    entries.push({path: file, sha256: sha(bytes), bytes: bytes.length});
  }
  for (const required of [
    'package-lock.json',
    'src/service.ts',
    'server/http.ts',
    'tools/guidance-coverage.ts',
    'Skills/amcp-campaign-builder/SKILL.md',
    'docs/REPORTING-OVERVIEW.md',
    '.mirror/REPORTS/evidence-hashes.json',
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
  entries.push({
    path: '.mirror/RESULTS/live-read-samples.json',
    sha256: sha('[]\n'),
    bytes: 3,
    generated: 'Historical account responses are never included in a release.',
  });
  const manifest = {
    version: 1,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
    branch: execFileSync('git', ['branch', '--show-current'], {cwd: root, encoding: 'utf8'}).trim(),
    source_tree_hash: sha(JSON.stringify(entries)),
    files: entries,
  };
  fs.writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return {output, source_tree_hash: manifest.source_tree_hash, files: entries.length};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2] ?? '.release/candidate';
  console.log(JSON.stringify(assembleRelease(process.cwd(), output)));
}
