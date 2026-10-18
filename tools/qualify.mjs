// Local qualification runner (QA-01). It composes the existing commands, never replaces them, and turns their outcomes
// into one durable record keyed by the bytes that were tested:
//   node tools/qualify.mjs [--profile fast|full] [--records <dir>] [--reuse] [--allow-skip <test name>] [--now <date>]
//                          [--attach-browser <results.json>] [--no-record]
//   node tools/qualify.mjs --prune --dry-run [--keep-last <n>] [--keep-package <sha256>] [--records <dir>]
// Freshness checks run first, then the suites. The full profile requires FFmpeg (AMCP_REQUIRE_FFMPEG=true) and fails on
// any skipped test that is not explicitly allowed. Records are written atomically to <records>/<source_tree_hash>.json
// (default .runtime/qualifications, never committed) with one index.jsonl line each. Nothing here deletes anything:
// pruning is a dry-run list for the owner to review (docs/OPERATIONS.md, "Qualification records").
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {releaseSourceEntries, worktreeState} from './prepare-public-release.mjs';
import {failingFiles, mutantStatuses, riskEvidence} from './risk-evidence.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const tool = file => fileURLToPath(new URL('../' + file, import.meta.url));
const refused = code => Object.assign(new Error(code), {diagnosticCode: code});
const formatGlobs = [
  'src/**/*.ts',
  'server/**/*.ts',
  'tools/**/*.{ts,mjs}',
  'tests/**/*.{ts,mjs}',
  'codegen/**/*.mjs',
  'deploy/**/*.mjs',
  'web/**/*.{js,css}',
];
/** Paths whose change can alter what was qualified; a diff touching none of them may reuse an earlier record. */
export const reuseSensitive = [
  'src/',
  'server/',
  'tests/',
  'tools/',
  'codegen/',
  'generated/',
  'web/',
  'deploy/',
  'Skills/amcp-campaign-builder/',
  '.mirror/',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'Dockerfile',
  'railway.json',
  'docs/REPORTING-OVERVIEW.md',
];
const sensitive = file =>
  reuseSensitive.some(prefix => (prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix));

/** Stage lists. Freshness gates (cheap, deterministic) come first; `sunset_alarms` is recorded but never blocks. */
export function profileStages(profile, {now} = {}) {
  const node = (name, args, extra = {}) => ({name, command: 'node', args, blocking: true, ...extra});
  // Every fast stage is a freshness gate: a reused qualification still runs all of them.
  const gate = (name, args, extra = {}) => node(name, args, {freshness: true, ...extra});
  const fast = [
    gate('build_typescript', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']),
    gate('build_release_identity', ['tools/build-release-identity.mjs']),
    gate('format_check', ['node_modules/prettier/bin/prettier.cjs', '--check', ...formatGlobs]),
    gate('test_oracles_check', ['tools/check-test-oracles.mjs']),
    gate('generate_check', ['codegen/generate.mjs', '--check']),
    // ARC-03: the capture evidence, the frozen captured catalog, the Apple SDK evidence and the generated-artifact
    // inventory, which also requires every artifact's own check to be one of these gates.
    gate('generated_provenance_check', ['tools/generated-provenance.mjs', '--check']),
    gate('generate_vendor_check', ['tools/fetch-vendor-specs.mjs', '--generate-only', '--check']),
    gate('generate_wsdl_check', ['tools/microsoft-specs.mjs', '--generate-only', '--check']),
    gate('generate_feeds_check', ['tools/google-asset-set-fields.mjs', '--check']),
    gate('generate_cloudflare_check', ['tools/cloudflare-ranges.mjs', '--check']),
    gate('generate_bids_check', ['tools/google-bid-fields.mjs', '--check']),
    gate('report_check', ['dist/tools/report.js', '--check']),
    gate('contracts_check', ['dist/tools/generate-contracts.js', '--check']),
    gate('contracts_actions_check', ['dist/tools/action-contracts.js', '--check']),
    gate('docs_index_check', ['tools/docs-index.mjs', '--check']),
    // ARC-01/ARC-04 (owner decision D26): import cycles and provider coupling may only fall.
    gate('architecture_check', ['tools/architecture-map.mjs', '--check']),
    gate('sunset_alarms', ['dist/tools/provider-sunsets.js', '--alarm', ...(now ? ['--now', now] : [])], {
      blocking: false,
      json: true,
    }),
  ];
  if (profile === 'fast') return fast;
  if (profile !== 'full') throw refused('QUALIFY_PROFILE_UNKNOWN');
  return [
    ...fast,
    {name: 'ffmpeg_probe', internal: 'ffmpeg', blocking: true},
    node('test_suite', ['tools/test-suite.mjs'], {tests: true, env: {AMCP_REQUIRE_FFMPEG: 'true'}}),
    node('test_capture', ['--test', 'tools/catalog/core.test.mjs'], {tests: true}),
    // QA-02: every catalogued mutant must be killed by its named tests (tests/fixtures/mutant-catalogue.json).
    node('mutant_catalogue', ['tools/mutants.mjs'], {mutants: true}),
    // PRV-05: every reviewed-family fixture body conforms to its pinned vendor contract or is a listed exception with
    // vendor evidence; a new unlisted violation or a stale exception fails release qualification.
    node('wire_contract_sweep', ['tools/wire-contract-sweep.mjs']),
    // PRV-06 C: the Advantage+ creative feature allowlist is the hashed SDK 26.0.2 pin (pinned 2026-10-16); release
    // qualification fails here if the fixture stops being that evidence, for example a record transcribed without
    // hashes (`npm run check` and the fast gate do not run it).
    node('meta_creative_features_pinned', ['tools/meta-creative-features.mjs', '--require-pinned']),
    node('check_web', ['tools/check-web.mjs']),
    // QA-04: the journey and MCP evaluation compared with its committed baseline (counts may not rise).
    node('journey_evaluation', ['tools/mcp-eval.mjs', '--check']),
    node('providers_check', ['dist/tools/provider-drift.js']),
    node('providers_lifecycle', ['dist/tools/provider-lifecycle.js']),
    node('providers_sunsets', ['dist/tools/provider-sunsets.js']),
  ];
}

/** Test counts from Node test runner summary lines (spec `ℹ name n` or TAP `# name n`); null when there are none. */
export function testSummary(output) {
  const counts = {};
  for (const match of String(output).matchAll(/^(?:ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm))
    counts[match[1]] = (counts[match[1]] ?? 0) + Number(match[2]);
  if (counts.tests === undefined) return null;
  return {
    total: counts.tests,
    pass: counts.pass ?? 0,
    fail: counts.fail ?? 0,
    skipped: counts.skipped ?? 0,
    cancelled: counts.cancelled ?? 0,
    todo: counts.todo ?? 0,
  };
}
/** Names of skipped tests from spec (`﹣ name (…) # reason`) or TAP (`ok n - name # SKIP …`) output. */
export function skippedTests(output) {
  const names = new Set();
  for (const line of String(output).split(/\r?\n/)) {
    const spec = /^\s*﹣ (.+?) \([\d.]+m?s\)(?: # .*)?$/.exec(line),
      tap = /^\s*ok \d+ - (.+?) # SKIP\b/i.exec(line);
    const name = spec?.[1] ?? tap?.[1];
    if (name) names.add(name.trim().slice(0, 300));
  }
  return [...names].sort();
}

function runCommand(stage, {root, env, timeoutMs}) {
  return new Promise(resolve => {
    const started = Date.now(),
      chunks = [];
    let bytes = 0,
      timedOut = false;
    const child = spawn(stage.command === 'node' ? process.execPath : stage.command, stage.args, {
      cwd: root,
      env: {...process.env, ...env, ...(stage.env ?? {})},
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const collect = chunk => {
      bytes += chunk.length;
      if (bytes <= 256 * 1024 * 1024) chunks.push(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const finish = code => {
      clearTimeout(timer);
      resolve({output: Buffer.concat(chunks), exit_code: timedOut ? null : code, timed_out: timedOut, started});
    };
    child.once('error', () => finish(127));
    child.once('close', code => finish(code ?? 1));
  });
}

async function importDist(root, file) {
  const local = path.join(root, file);
  return import(pathToFileURL(fs.existsSync(local) ? local : tool(file)).href);
}
/** FFmpeg and ffprobe as the suites will find them; `probe` replaces the real `-version` probe in tests. */
async function ffmpegFacts(root, env = {}, probe) {
  const variables = {...process.env, ...env};
  try {
    probe ??= (await importDist(root, 'dist/src/runtime-toolchain.js')).probeMediaProcessor;
    const [ffmpeg, ffprobe] = await Promise.all([
      probe({command: variables.AMCP_FFMPEG_PATH ?? 'ffmpeg'}),
      probe({command: variables.AMCP_FFPROBE_PATH ?? 'ffprobe'}),
    ]);
    return {ffmpeg: ffmpeg.version, ffprobe: ffprobe.status};
  } catch {
    return {ffmpeg: 'unavailable', ffprobe: 'unavailable'};
  }
}
function npmVersion() {
  const agent = /(?:^|\s)npm\/(\d+\.\d+\.\d+)(?:\s|$)/.exec(process.env.npm_config_user_agent ?? '')?.[1];
  if (agent) return agent;
  try {
    const version = spawnSync('npm -v', {shell: true, encoding: 'utf8', timeout: 15000, windowsHide: true}).stdout;
    return /^\d+\.\d+\.\d+$/.test(String(version).trim()) ? String(version).trim() : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
/** Node, npm, OS and FFmpeg facts, each validated or `unavailable`. */
export async function toolchainFacts(root, env = {}, probe) {
  let nodeVersion = () => 'unavailable',
    osRelease = () => 'unavailable';
  try {
    ({nodeVersion, osRelease} = await importDist(root, 'dist/src/runtime-toolchain.js'));
  } catch {}
  let release = 'unavailable';
  try {
    release = osRelease(fs.readFileSync('/etc/os-release', 'utf8'));
  } catch {}
  return {
    node: nodeVersion(process.version),
    npm: npmVersion(),
    os: {
      platform: process.platform,
      arch: process.arch,
      release: /^[\w.-]{1,64}$/.test(os.release()) ? os.release() : 'unavailable',
      distribution: release,
    },
    ...(await ffmpegFacts(root, env, probe)),
  };
}
/** The packaged identity (`dist/release-identity.json`) and public asset version a build produced, or nulls. */
export async function packageFacts(root) {
  let packaged = null,
    record_sha256 = null,
    asset = 'unavailable';
  try {
    const {identityRecord} = await importDist(root, 'dist/src/release-identity.js');
    const bytes = fs.readFileSync(path.join(root, 'dist', 'release-identity.json'));
    const record = identityRecord(JSON.parse(bytes.toString('utf8')));
    if (record) {
      packaged = {
        schema_version: record.schema_version,
        sha256: record.sha256,
        files: record.files,
        bytes: record.bytes,
        components: record.components,
      };
      record_sha256 = sha(bytes);
    }
  } catch {}
  try {
    const {createPublicAssets} = await importDist(root, 'dist/server/public-assets.js');
    asset = createPublicAssets(path.join(root, 'web')).version;
  } catch {}
  return {package: packaged, release_identity_record_sha256: record_sha256, public_asset_version: asset};
}
/** The tested source: from a candidate's manifest when present, otherwise computed exactly as a manifest would be. */
export function sourceFacts(root) {
  const manifestFile = path.join(root, 'release-manifest.json');
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    return {
      origin: 'candidate_manifest',
      manifest_version: manifest.version,
      source_tree_hash: manifest.source_tree_hash,
      revision: manifest.revision,
      branch: manifest.branch,
      worktree_clean: manifest.version === 2 ? manifest.worktree_clean : null,
      differs_from_revision: manifest.version === 2 ? manifest.differs_from_revision : null,
    };
  }
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
  const state = worktreeState(root);
  return {
    origin: 'checkout',
    manifest_version: 2,
    source_tree_hash: releaseSourceEntries(root).source_tree_hash,
    revision: git(['rev-parse', 'HEAD']),
    branch: git(['branch', '--show-current']),
    ...state,
  };
}
function readIndex(recordsDir) {
  try {
    return fs
      .readFileSync(path.join(recordsDir, 'index.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
/**
 * The mechanical reuse rule: the newest passed full record of an ancestor revision is reusable when every path changed
 * since then lies outside `reuseSensitive` and the rebuilt package digest and public asset version are equal.
 */
export function reuseDecision({root, recordsDir, source, facts}) {
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
  const candidates = readIndex(recordsDir)
    .filter(entry => entry.result === 'passed' && entry.profile === 'full' && !entry.reuse_of)
    .reverse();
  for (const previous of candidates) {
    if (!/^[0-9a-f]{40}$/.test(previous.revision ?? '')) continue;
    try {
      git(['merge-base', '--is-ancestor', previous.revision, 'HEAD']);
    } catch {
      continue;
    }
    const changed = [
      ...new Set([
        ...git(['diff', '--name-only', previous.revision, 'HEAD']).split('\n').filter(Boolean),
        ...(source.differs_from_revision ?? []),
      ]),
    ].sort();
    const blocking = changed.filter(sensitive);
    if (blocking.length)
      return {
        eligible: false,
        reason: 'package_scope_changed',
        previous: previous.source_tree_hash,
        paths: blocking.slice(0, 50),
      };
    if (!facts.package || previous.package_sha256 !== facts.package.sha256)
      return {eligible: false, reason: 'package_digest_changed', previous: previous.source_tree_hash};
    if (previous.public_asset_version !== facts.public_asset_version)
      return {eligible: false, reason: 'asset_version_changed', previous: previous.source_tree_hash};
    return {
      eligible: true,
      reuse_of: {
        source_tree_hash: previous.source_tree_hash,
        revision: previous.revision,
        changed_paths: changed.slice(0, 200),
        package_sha256: previous.package_sha256,
        public_asset_version: previous.public_asset_version,
      },
    };
  }
  return {eligible: false, reason: 'no_reusable_record'};
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = path.join(path.dirname(file), '.qualify-' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temporary, text, {flag: 'wx'});
    fs.renameSync(temporary, file);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
}
/** Writes the record and appends its index line; returns the record path relative to the records directory. */
export function writeRecord(recordsDir, record) {
  if (!/^[0-9a-f]{64}$/.test(record.source.source_tree_hash ?? '')) throw refused('QUALIFY_SOURCE_UNAVAILABLE');
  const name = record.source.source_tree_hash + '.json';
  writeAtomic(path.join(recordsDir, name), JSON.stringify(record, null, 2) + '\n');
  fs.appendFileSync(
    path.join(recordsDir, 'index.jsonl'),
    JSON.stringify({
      source_tree_hash: record.source.source_tree_hash,
      revision: record.source.revision,
      worktree_clean: record.source.worktree_clean,
      profile: record.profile,
      result: record.result,
      finished_at: record.finished_at,
      package_sha256: record.package?.sha256 ?? null,
      public_asset_version: record.public_asset_version,
      reuse_of: record.reuse_of?.source_tree_hash ?? null,
    }) + '\n',
  );
  return name;
}
/** Summarizes a browser runner results.json and checks it was produced against the same packaged identity. */
export function browserAttachment(file, packaged) {
  const results = JSON.parse(fs.readFileSync(file, 'utf8'));
  const identity = results.release_identity ?? null;
  return {
    name: 'browser_qualification',
    record_kind: results.record_kind ?? null,
    total: Number.isSafeInteger(results.total) ? results.total : null,
    passed: Number.isSafeInteger(results.passed) ? results.passed : null,
    failed: Number.isSafeInteger(results.failed) ? results.failed : null,
    release_identity_sha256: identity?.sha256 ?? null,
    input_map_sha256: results.input_map_sha256 ?? null,
    bound_to_package: !!identity && !!packaged && identity.sha256 === packaged.sha256,
    results_sha256: sha(fs.readFileSync(file)),
  };
}

/** Runs one stage and returns its result entry. */
async function runStage(stage, {root, env, timeoutMs, allowSkips, probe}) {
  if (stage.internal === 'ffmpeg') {
    const facts = await ffmpegFacts(root, env, probe),
      ok = facts.ffmpeg !== 'unavailable' && facts.ffprobe === 'available';
    return {
      name: stage.name,
      status: ok ? 'passed' : 'failed',
      blocking: true,
      ffmpeg: facts.ffmpeg,
      ...(ok
        ? {}
        : {
            error_code: 'FFMPEG_UNAVAILABLE',
            message: 'Qualification requires FFmpeg and ffprobe; set AMCP_FFMPEG_PATH and AMCP_FFPROBE_PATH.',
          }),
    };
  }
  const run = await runCommand(stage, {root, env, timeoutMs});
  const output = run.output.toString('utf8'),
    tests = testSummary(output),
    skips = stage.tests ? skippedTests(output) : [],
    unexpectedSkips = skips.filter(name => !allowSkips.includes(name)),
    // Every skip must be named and allowed; an unnamed skip (count above the names found) also fails.
    skipFailure =
      !!stage.tests && !!tests && tests.skipped > 0 && (unexpectedSkips.length > 0 || tests.skipped > skips.length),
    passed = run.exit_code === 0 && !skipFailure && (!tests || (tests.fail === 0 && tests.cancelled === 0));
  const result = {
    name: stage.name,
    argv: [stage.command, ...stage.args],
    exit_code: run.exit_code,
    ...(run.timed_out ? {timed_out: true} : {}),
    duration_ms: Date.now() - run.started,
    stdout_sha256: sha(run.output),
    tests,
    ...(stage.tests ? {skipped_tests: skips, unexpected_skips: unexpectedSkips} : {}),
    // QA-02 step 6: which test files failed and which mutants were killed feed the risk-class by evidence matrix.
    ...(stage.tests ? {failing_files: failingFiles(output, root)} : {}),
    ...(stage.mutants ? {mutants: mutantStatuses(output)} : {}),
    blocking: stage.blocking !== false,
    status: passed ? 'passed' : 'failed',
  };
  if (stage.json) {
    try {
      const parsed = JSON.parse(output.slice(output.indexOf('{')));
      result.json = {
        checked_at: parsed.checked_at ?? null,
        alarms: Array.isArray(parsed.alarms) ? parsed.alarms : [],
        dated: Array.isArray(parsed.dated) ? parsed.dated : [],
      };
      // An alarm is a recorded finding (PRV-04), never a build failure: the stage reports `alarm`, not `failed`.
      if (run.exit_code === 1 && result.json.alarms.length) result.status = 'alarm';
    } catch {
      result.json = {error_code: 'SUNSET_ALARMS_UNAVAILABLE'};
    }
  }
  return result;
}

/** Runs one qualification and returns its record (and writes it unless `record` is false). */
export async function qualify({
  root = process.cwd(),
  profile = 'full',
  stages,
  recordsDir,
  record: keep = true,
  reuse = false,
  allowSkips = [],
  now,
  attachBrowser,
  env = {},
  timeoutMs = 60 * 60 * 1000,
  log = () => {},
  probe,
  // Where the tree's source facts come from; a test of the stage matrix that needs no Git checkout injects its own,
  // since Railway's build has no .git (ACC-04).
  source: readSource = sourceFacts,
} = {}) {
  root = fs.realpathSync(root);
  recordsDir = path.resolve(root, recordsDir ?? '.runtime/qualifications');
  const source = readSource(root),
    started_at = new Date().toISOString(),
    plan = stages ?? profileStages(profile, {now}),
    // Reuse never skips the cheap freshness gates: they run first, and the rebuilt digests decide.
    first = reuse ? plan.filter(stage => stage.freshness) : plan,
    results = [];
  let failed = false,
    buildFailed = false,
    reuseResult = null;
  const execute = async list => {
    for (const stage of list) {
      // The cheap freshness gates all run, so one pass reports every stale output; nothing else runs after a failure,
      // and nothing at all after a failed build.
      if (buildFailed || (failed && !stage.freshness)) {
        results.push({name: stage.name, status: 'not_run', blocking: stage.blocking !== false});
        continue;
      }
      const result = await runStage(stage, {root, env, timeoutMs, allowSkips, probe});
      results.push(result);
      log(
        stage.name +
          ': ' +
          result.status +
          (result.duration_ms === undefined ? '' : ' (' + result.duration_ms + ' ms)'),
      );
      if (result.status !== 'passed' && result.blocking) {
        failed = true;
        if (stage.name.startsWith('build_')) buildFailed = true;
      }
    }
  };
  await execute(first);
  let facts = await packageFacts(root);
  if (reuse && !failed) {
    reuseResult = reuseDecision({root, recordsDir, source, facts});
    // Not reusable: run the remaining stages of the profile.
    if (!reuseResult.eligible) {
      await execute(plan.filter(stage => !first.includes(stage)));
      facts = await packageFacts(root);
    }
  }
  const sunset = results.find(stage => stage.json);
  const sunsetAlarms = sunset?.json ?? null;
  if (sunset) delete sunset.json;
  const lockfile = path.join(root, 'package-lock.json'),
    browser = attachBrowser ? browserAttachment(attachBrowser, facts.package) : undefined;
  // The risk-class by evidence matrix (QA-02 step 6): reported per class instead of headline totals.
  let risk_evidence;
  try {
    risk_evidence = await riskEvidence({root, stages: results, browser});
  } catch {
    risk_evidence = {error_code: 'RISK_EVIDENCE_UNAVAILABLE'};
  }
  const record = {
    record_kind: 'amcp_local_qualification',
    schema_version: 1,
    profile,
    started_at,
    finished_at: new Date().toISOString(),
    result: failed ? 'failed' : 'passed',
    source,
    lockfile_sha256: fs.existsSync(lockfile) ? sha(fs.readFileSync(lockfile)) : null,
    toolchain: await toolchainFacts(root, env, probe),
    ...facts,
    stages: results,
    totals: results.reduce(
      (sum, stage) => {
        for (const key of ['total', 'pass', 'fail', 'skipped', 'cancelled']) sum[key] += stage.tests?.[key] ?? 0;
        return sum;
      },
      {total: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0},
    ),
    sunset_alarms: sunsetAlarms,
    reuse_of: reuseResult?.eligible ? reuseResult.reuse_of : null,
    ...(reuseResult && !reuseResult.eligible ? {reuse_refused: reuseResult} : {}),
    ...(browser ? {browser} : {}),
    risk_evidence,
    deployed_observations: [],
    scope:
      'Local synthetic qualification only: no provider, live account, Linux container or deployed acceptance is implied.',
  };
  if (keep) record.record_file = writeRecord(recordsDir, record);
  return record;
}

/**
 * Lists `.release` candidates that no retention rule keeps: the deployed package digest, the newest `keepLast` records,
 * or a `.retain` marker file in the candidate. It never deletes; the owner reviews the list and deletes by hand.
 */
export function pruneDryRun({root = process.cwd(), recordsDir, keepLast = 5, keepPackages = []} = {}) {
  root = fs.realpathSync(root);
  recordsDir = path.resolve(root, recordsDir ?? '.runtime/qualifications');
  const releaseDir = path.join(root, '.release'),
    recent = new Set(
      readIndex(recordsDir)
        .slice(-keepLast)
        .map(entry => entry.source_tree_hash),
    ),
    keep = [],
    prune = [];
  let names = [];
  try {
    names = fs.readdirSync(releaseDir, {withFileTypes: true}).filter(d => d.isDirectory() && !d.isSymbolicLink());
  } catch {}
  for (const entry of names.map(d => d.name).sort()) {
    const directory = path.join(releaseDir, entry),
      item = {name: entry, revision: null, source_tree_hash: null, package_sha256: null};
    try {
      const file = path.join(directory, 'release-manifest.json');
      if (fs.statSync(file).size <= 8 * 1024 * 1024) {
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        item.revision = typeof manifest.revision === 'string' ? manifest.revision : null;
        item.source_tree_hash = typeof manifest.source_tree_hash === 'string' ? manifest.source_tree_hash : null;
      }
    } catch {}
    try {
      const record = JSON.parse(fs.readFileSync(path.join(directory, 'dist', 'release-identity.json'), 'utf8'));
      item.package_sha256 = typeof record.sha256 === 'string' ? record.sha256 : null;
    } catch {}
    const reason = fs.existsSync(path.join(directory, '.retain'))
      ? 'retain_mark'
      : item.package_sha256 && keepPackages.includes(item.package_sha256)
        ? 'deployed_package'
        : item.source_tree_hash && recent.has(item.source_tree_hash)
          ? 'recent_record'
          : null;
    (reason ? keep : prune).push(reason ? {...item, reason} : item);
  }
  return {
    mode: 'prune_dry_run',
    candidates: keep.length + prune.length,
    keep,
    prune_candidates: prune,
    deleted: 0,
    note: 'Nothing was deleted. Deletion is a manual owner action after reviewing this list.',
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
async function cli(args) {
  if (args.includes('--prune')) {
    if (!args.includes('--dry-run')) {
      console.error('QUALIFY_PRUNE_DRY_RUN_ONLY: pruning only lists candidates (--prune --dry-run); delete by hand.');
      return 2;
    }
    const keepLast = Number(option(args, '--keep-last') ?? 5);
    if (!Number.isInteger(keepLast) || keepLast < 0 || keepLast > 1000) {
      console.error('QUALIFY_ARGUMENT_INVALID');
      return 2;
    }
    const keepPackages = args.flatMap((arg, i) => (arg === '--keep-package' ? [args[i + 1]] : [])).filter(Boolean);
    console.log(JSON.stringify(pruneDryRun({recordsDir: option(args, '--records'), keepLast, keepPackages}), null, 2));
    return 0;
  }
  const profile = option(args, '--profile') ?? 'full',
    allowSkips = args.flatMap((arg, i) => (arg === '--allow-skip' ? [args[i + 1]] : [])).filter(Boolean);
  const record = await qualify({
    profile,
    recordsDir: option(args, '--records'),
    record: !args.includes('--no-record'),
    reuse: args.includes('--reuse'),
    allowSkips,
    now: option(args, '--now'),
    attachBrowser: option(args, '--attach-browser'),
    log: line => console.error(line),
  });
  console.log(
    JSON.stringify(
      {
        result: record.result,
        profile: record.profile,
        source_tree_hash: record.source.source_tree_hash,
        revision: record.source.revision,
        worktree_clean: record.source.worktree_clean,
        package_sha256: record.package?.sha256 ?? null,
        public_asset_version: record.public_asset_version,
        totals: record.totals,
        sunset_alarms: record.sunset_alarms?.alarms?.length ?? null,
        reuse_of: record.reuse_of?.source_tree_hash ?? null,
        record_file: record.record_file ?? null,
        failed_stages: record.stages.filter(stage => stage.status === 'failed').map(stage => stage.name),
      },
      null,
      2,
    ),
  );
  return record.result === 'passed' ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await cli(process.argv.slice(2));
  } catch (error) {
    console.error(error?.diagnosticCode ?? 'QUALIFY_FAILED');
    process.exitCode = 2;
  }
}
