#!/usr/bin/env node
// Container-parity qualification (ACC-04). Railway builds the Dockerfile from a checkout without `.git`: `COPY . .`
// copies the build context minus `.dockerignore`, `npm ci` supplies node_modules, and the check runs with FFmpeg
// required and two test workers. A test that quietly depends on Git metadata, an ignored file or a path outside the
// release scope passes locally and fails only in Railway's build. This step reproduces that layout locally:
//   node tools/container-parity.mjs [--from <checkout or release candidate>] [--node-modules <dir>]
//        [--script <npm script>] | [--test <test file> ...] [--no-build] [--revision <40-hex>] [--record <new .json>]
// It copies the public release scope (the files a release candidate holds, with the empty generated sample) minus
// `.dockerignore` into a new directory under the system temporary directory, outside any Git repository, links the
// dependencies, and runs `npm run check` there (the Dockerfile's command) or, with --test, the build and the named
// tests. Git discovery is stopped at the copy (GIT_CEILING_DIRECTORIES). The record holds counts, hashes and exit codes,
// never absolute paths or output text. The dependency link is removed without following it before the copy is deleted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {releasePathAllowed, releaseSourceEntries} from './prepare-public-release.mjs';
import {testSummary} from './qualify.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const sample = '.mirror/RESULTS/live-read-samples.json';
/** Docker's `.dockerignore` rules (moby patternmatcher): root-anchored, `*`, `?`, `**`, `!` exceptions, last match wins. */
export function dockerignore(text) {
  const rules = [];
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const exception = line.startsWith('!');
    if (exception) line = line.slice(1).trim();
    line = path.posix.normalize(line.replace(/\\/g, '/')).replace(/^\/+/, '').replace(/\/+$/, '');
    if (!line || line === '.') continue;
    let source = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '*' && line[i + 1] === '*') {
        // `**/` matches zero or more directories; a trailing `**` matches everything below.
        source += line[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += line[i + 2] === '/' ? 2 : 1;
      } else if (c === '*') source += '[^/]*';
      else if (c === '?') source += '[^/]';
      else source += /[.+^${}()|[\]\\]/.test(c) ? '\\' + c : c;
    }
    rules.push({exception, pattern: new RegExp('^' + source + '$')});
  }
  /** Whether Docker leaves `file` (a repository-relative path) out of the build context. */
  return file => {
    const parts = file.split('/');
    let excluded = false;
    for (const rule of rules) {
      // A pattern that matches a parent directory excludes (or re-includes) everything below it.
      let hit = false;
      for (let n = 1; n <= parts.length && !hit; n++) hit = rule.pattern.test(parts.slice(0, n).join('/'));
      if (hit) excluded = !rule.exception;
    }
    return excluded;
  };
}
/** The files Railway's `COPY . .` would see: the release scope of a checkout or a candidate, minus `.dockerignore`. */
export function contextFiles(from) {
  from = fs.realpathSync(from);
  const manifest = path.join(from, 'release-manifest.json');
  let files;
  if (fs.existsSync(manifest)) {
    const listed = JSON.parse(fs.readFileSync(manifest, 'utf8')).files;
    if (!Array.isArray(listed)) throw Error('PARITY_SOURCE_UNAVAILABLE');
    files = listed.map(entry => entry.path).filter(file => file === sample || releasePathAllowed(file));
  } else files = [...releaseSourceEntries(from).entries.map(entry => entry.path), sample];
  const ignored = dockerignore(
    fs.existsSync(path.join(from, '.dockerignore')) ? fs.readFileSync(path.join(from, '.dockerignore'), 'utf8') : '',
  );
  const kept = files.filter(file => !ignored(file));
  return {from, files: [...new Set(kept)].sort(), excluded: files.length - kept.length};
}
/** Removes the dependency link itself, never what it points to; true when it is gone. */
export function removeLink(link) {
  let info;
  try {
    info = fs.lstatSync(link);
  } catch (error) {
    return error.code === 'ENOENT';
  }
  if (!info.isSymbolicLink()) return false;
  try {
    fs.unlinkSync(link);
  } catch {
    try {
      // A Windows directory junction is removed as a directory entry; its target is untouched.
      fs.rmdirSync(link);
    } catch {}
  }
  try {
    fs.lstatSync(link);
    return false;
  } catch (error) {
    return error.code === 'ENOENT';
  }
}
function run(command, args, options) {
  return new Promise(resolve => {
    const started = Date.now(),
      chunks = [];
    const child = spawn(command, args, {...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => chunks.push(chunk));
    child.once('error', () => resolve({code: 127, output: Buffer.concat(chunks), ms: Date.now() - started}));
    child.once('close', code => resolve({code: code ?? 1, output: Buffer.concat(chunks), ms: Date.now() - started}));
  });
}
/**
 * Copies the context into a new temporary directory, links the dependencies, runs the check (or the build and named
 * tests) there and returns a counts-only record. `echo` receives the output as it arrives (the command line prints it).
 */
export async function containerParity({
  from = process.cwd(),
  nodeModules,
  script = 'check',
  tests = [],
  build = true,
  revision = null,
  echo,
} = {}) {
  if (!/^[a-z][a-z0-9:_-]{0,40}$/.test(script)) throw Error('USAGE: --script takes an npm script name');
  if (revision !== null && !/^[0-9a-f]{40}$/.test(revision)) throw Error('USAGE: --revision takes 40 hex characters');
  for (const file of tests)
    if (!/^(?:tests|dist\/tests|tools\/catalog)\/[\w.-]+\.test\.(?:mjs|js)$/.test(file))
      throw Error('USAGE: --test takes repository test files such as tests/x.test.mjs');
  const context = contextFiles(from),
    modules = path.resolve(nodeModules ?? path.join(context.from, 'node_modules'));
  if (!fs.statSync(modules).isDirectory()) throw Error('PARITY_DEPENDENCIES_UNAVAILABLE');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-container-')),
    app = path.join(scratch, 'app'),
    link = path.join(app, 'node_modules');
  const entries = [];
  let cleanup = 'removed';
  try {
    for (const file of context.files) {
      const source = path.join(context.from, file),
        target = path.join(app, file);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      // Historical account responses are never copied: the sample is always the empty generated one, as in a release
      // candidate (tools/prepare-public-release.mjs), and the source file is never read.
      if (file === sample) fs.writeFileSync(target, '[]\n');
      else fs.copyFileSync(source, target);
      entries.push({path: file, sha256: sha(fs.readFileSync(target))});
    }
    fs.symlinkSync(modules, link, 'junction');
    // Like the container: no Git repository at or above the working directory.
    const env = {
      ...process.env,
      AMCP_REQUIRE_FFMPEG: 'true',
      AMCP_TEST_CONCURRENCY: '2',
      GIT_CEILING_DIRECTORIES: scratch,
      ...(revision ? {RAILWAY_GIT_COMMIT_SHA: revision} : {}),
    };
    // NODE_TEST_CONTEXT would turn the copy's own test run into a child of a calling test runner (exit 0, no totals).
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'NODE_TEST_CONTEXT', 'RAILWAY_GIT_COMMIT_SHA'])
      if (!(name === 'RAILWAY_GIT_COMMIT_SHA' && revision)) delete env[name];
    const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {cwd: app, env, windowsHide: true});
    const repository = git.status === 0 && String(git.stdout).trim() === 'true';
    if (repository) throw Error('PARITY_GIT_PRESENT');
    const steps = [];
    const step = async (name, command, args, shell = false) => {
      const result = await run(command, args, {cwd: app, env, shell});
      echo?.(result.output);
      steps.push({
        name,
        exit_code: result.code,
        duration_ms: result.ms,
        output_sha256: sha(result.output),
        tests: testSummary(result.output.toString('utf8')),
      });
      return result.code === 0;
    };
    if (tests.length) {
      if (build)
        (await step('build_typescript', process.execPath, [
          'node_modules/typescript/bin/tsc',
          '-p',
          'tsconfig.json',
        ])) && (await step('build_release_identity', process.execPath, ['tools/build-release-identity.mjs']));
      if (steps.every(s => s.exit_code === 0))
        await step('tests', process.execPath, ['--test', '--test-concurrency=2', ...tests]);
    } else {
      const npm = process.env.npm_execpath;
      if (npm && /\.c?js$/.test(npm)) await step('npm_run_' + script, process.execPath, [npm, 'run', script]);
      else await step('npm_run_' + script, 'npm', ['run', script], process.platform === 'win32');
    }
    const totals = steps.map(s => s.tests).filter(Boolean),
      sum = name => totals.reduce((n, t) => n + t[name], 0);
    return {
      record_kind: 'container_parity',
      version: 1,
      at: new Date().toISOString(),
      source_tree_hash: sha(JSON.stringify(entries)),
      files: entries.length,
      excluded_by_dockerignore: context.excluded,
      git_repository: false,
      command: tests.length ? {tests, build} : {script},
      environment: {node: process.version, platform: process.platform, ffmpeg_required: true, test_workers: 2},
      steps,
      tests: totals.length
        ? {
            total: sum('total'),
            pass: sum('pass'),
            fail: sum('fail'),
            skipped: sum('skipped'),
            cancelled: sum('cancelled'),
          }
        : null,
      passed: steps.length > 0 && steps.every(s => s.exit_code === 0),
      scope:
        'The public release scope minus .dockerignore, copied outside any Git repository with linked dependencies, as Railway builds the Dockerfile. Same files and no .git; not the Linux image, its FFmpeg build or its operating system.',
    };
  } finally {
    // The dependency link goes first and on its own; the copy is deleted only once the link is gone.
    if (removeLink(link)) fs.rmSync(scratch, {recursive: true, force: true});
    else cleanup = 'left_in_place';
    if (cleanup !== 'removed') process.stderr.write('PARITY_CLEANUP_REQUIRED amcp-container-*\n');
  }
}
function parse(argv) {
  const options = {tests: [], build: true};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i],
      value = () => {
        const v = argv[++i];
        if (v === undefined) throw Error('USAGE: ' + name + ' needs a value');
        return v;
      };
    if (name === '--from') options.from = value();
    else if (name === '--node-modules') options.nodeModules = value();
    else if (name === '--script') options.script = value();
    else if (name === '--test') options.tests.push(value());
    else if (name === '--no-build') options.build = false;
    else if (name === '--revision') options.revision = value();
    else if (name === '--record') options.record = value();
    else throw Error('USAGE: unknown option ' + String(name).slice(0, 40));
  }
  if (options.script && options.tests.length) throw Error('USAGE: use --script or --test, not both');
  return options;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  try {
    const {record: file, ...options} = parse(process.argv.slice(2));
    const record = await containerParity({...options, echo: chunk => process.stderr.write(chunk)});
    if (file) fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', {flag: 'wx'});
    process.stdout.write(JSON.stringify(record, null, 2) + '\n');
    process.exitCode = record.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write((/^(?:USAGE:|PARITY_)/.test(message) ? message : 'PARITY_UNAVAILABLE') + '\n');
    process.exitCode = 2;
  }
