// QA-01: the local qualification runner binds stage outcomes to the bytes that were tested. These tests use a
// synthetic Git repository under the ignored .runtime directory and synthetic stages; no suite, network or provider runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {profileStages, pruneDryRun, qualify, skippedTests, sourceFacts, testSummary} from '../tools/qualify.mjs';
import {assembleRelease} from '../tools/prepare-public-release.mjs';
import {probeMediaProcessor} from '../dist/src/runtime-toolchain.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const buildIdentity = path.resolve('tools/build-release-identity.mjs'),
  qualifyCli = path.resolve('tools/qualify.mjs');
const ffmpegLine = 'ffmpeg version 9.0 Copyright (c) 2000-2026 the FFmpeg developers';
const present = async () => ({status: 'available', version: ffmpegLine}),
  absent = async () => ({status: 'unavailable', version: 'unavailable'});
const tap = lines => ['-e', 'console.log(' + JSON.stringify(lines.join('\n')) + ')'];
const identityStage = {
  name: 'build_release_identity',
  command: 'node',
  args: [buildIdentity],
  blocking: true,
  freshness: true,
};
const suiteStage = {
  name: 'synthetic_suite',
  command: 'node',
  args: tap(['ok 1 - synthetic', '# tests 1', '# pass 1', '# fail 0', '# skipped 0', '# cancelled 0']),
  blocking: true,
  tests: true,
};

function repository(t) {
  const base = path.resolve('.runtime');
  fs.mkdirSync(base, {recursive: true});
  const parent = fs.realpathSync(base),
    root = fs.mkdtempSync(path.join(parent, 'qualify-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.ok(resolved.startsWith(parent + path.sep));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {cwd: root, encoding: 'utf8', stdio: 'pipe'}).trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
    fs.writeFileSync(path.join(root, file), text);
  };
  const commit = message =>
    git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-q', '-m', message);
  const files = {
    'README.md': 'Synthetic qualification fixture.\n',
    '.gitignore': 'dist/\n.release/\n.runtime/\n',
    'package.json': '{"name":"synthetic"}\n',
    'package-lock.json': '{"lockfileVersion":3}\n',
    'generated/schema.json': '{}\n',
    '.mirror/VENDOR/native.json': '{}\n',
    '.mirror/REPORTS/implementation-status.json': '{"live_read_samples":[]}\n',
    'web/app.js': 'console.log("synthetic");\n',
    'web/index.html': '<!doctype html><title>Synthetic</title>\n',
    'Skills/amcp-campaign-builder/SKILL.md': 'Synthetic skill.\n',
    'docs/REPORTING-OVERVIEW.md': 'Synthetic guide.\n',
    'docs/NOTES.md': 'Synthetic notes.\n',
    'src/module.ts': 'export const value = 1;\n',
    // The files a release candidate requires (tools/prepare-public-release.mjs).
    'src/service.ts': 'export {};\n',
    'server/http.ts': 'export {};\n',
    'tools/guidance-coverage.ts': 'export {};\n',
    'web/fonts/NotoSansArabic.ttf': 'synthetic font\n',
    'web/fonts/OFL.txt': 'synthetic license\n',
    '.mirror/REPORTS/evidence-hashes.json': '{}\n',
    '.mirror/REPORTS/compatibility-verification.json': '{}\n',
    '.mirror/PARITY.md': 'Synthetic parity.\n',
  };
  for (const [file, text] of Object.entries(files)) write(file, text);
  write('dist/server/app.js', 'compiled\n');
  git('init', '-q', '--initial-branch=main');
  git('add', '--', ...Object.keys(files));
  commit('Synthetic source');
  return {root, git, write, commit, records: path.join(root, '.runtime', 'qualifications')};
}

test('qualify on a clean HEAD records the manifest source_tree_hash and the built package SHA-256', async t => {
  const r = repository(t);
  const record = await qualify({
    root: r.root,
    stages: [identityStage, suiteStage],
    recordsDir: r.records,
    probe: present,
  });
  assert.equal(record.result, 'passed');
  assert.equal(record.source.worktree_clean, true);
  assert.deepEqual(record.source.differs_from_revision, []);
  assert.equal(record.source.revision, r.git('rev-parse', 'HEAD'));
  // The record is keyed by exactly the hash a release candidate of the same tree carries.
  const candidate = assembleRelease(r.root, '.release/candidate'),
    manifest = JSON.parse(fs.readFileSync(path.join(r.root, '.release/candidate/release-manifest.json'), 'utf8'));
  assert.equal(manifest.version, 2);
  assert.equal(record.source.source_tree_hash, manifest.source_tree_hash);
  assert.equal(record.source.source_tree_hash, candidate.source_tree_hash);
  const identity = JSON.parse(fs.readFileSync(path.join(r.root, 'dist/release-identity.json'), 'utf8'));
  assert.equal(record.package.sha256, identity.sha256);
  assert.deepEqual(record.package.components, identity.components);
  assert.equal(record.lockfile_sha256, sha(fs.readFileSync(path.join(r.root, 'package-lock.json'))));
  assert.match(record.public_asset_version, /^[0-9a-f]{64}$/);
  assert.equal(record.toolchain.ffmpeg, ffmpegLine);
  assert.match(record.toolchain.node, /^v\d+\.\d+\.\d+$/);
  assert.deepEqual(record.totals, {total: 1, pass: 1, fail: 0, skipped: 0, cancelled: 0});
  const stage = record.stages.find(s => s.name === 'synthetic_suite');
  assert.equal(stage.exit_code, 0);
  assert.match(stage.stdout_sha256, /^[0-9a-f]{64}$/);
  assert.ok(Number.isInteger(stage.duration_ms));
  assert.deepEqual(stage.argv.slice(0, 1), ['node']);
  // Written atomically under its hash, with one index line.
  const file = path.join(r.records, record.source.source_tree_hash + '.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).source.source_tree_hash, record.source.source_tree_hash);
  const index = fs.readFileSync(path.join(r.records, 'index.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(index.length, 1);
  assert.equal(index[0].result, 'passed');
  assert.equal(index[0].package_sha256, identity.sha256);
  assert.deepEqual(
    fs.readdirSync(r.records).filter(name => name.endsWith('.tmp')),
    [],
    'no temporary record remains',
  );
});

test('a dirty tree is recorded as worktree_clean false with the differing release paths', async t => {
  const r = repository(t);
  r.write('README.md', 'Changed after the commit.\n');
  r.write('src/new.ts', 'export const added = 2;\n');
  r.write('scratch.txt', 'outside the release scope\n');
  const facts = sourceFacts(r.root);
  assert.equal(facts.worktree_clean, false);
  // scratch.txt is not a release path, so it makes the tree dirty without being listed.
  assert.deepEqual(facts.differs_from_revision, ['README.md', 'src/new.ts']);
  const record = await qualify({root: r.root, stages: [suiteStage], record: false, probe: present});
  assert.equal(record.source.worktree_clean, false);
  assert.deepEqual(record.source.differs_from_revision, ['README.md', 'src/new.ts']);
  assert.equal(record.record_file, undefined);
});

test('a docs-only follow-up commit is recorded as reuse_of with equal package and asset version; a src change is not', async t => {
  const r = repository(t);
  const first = await qualify({
    root: r.root,
    stages: [identityStage, suiteStage],
    recordsDir: r.records,
    probe: present,
  });
  assert.equal(first.result, 'passed');
  r.write('docs/NOTES.md', 'Corrected notes.\n');
  r.git('add', 'docs/NOTES.md');
  r.commit('Docs only');
  const reused = await qualify({
    root: r.root,
    stages: [identityStage, suiteStage],
    recordsDir: r.records,
    reuse: true,
    probe: present,
  });
  assert.equal(reused.result, 'passed');
  assert.notEqual(reused.source.source_tree_hash, first.source.source_tree_hash);
  assert.equal(reused.reuse_of.source_tree_hash, first.source.source_tree_hash);
  assert.equal(reused.reuse_of.revision, first.source.revision);
  assert.deepEqual(reused.reuse_of.changed_paths, ['docs/NOTES.md']);
  assert.equal(reused.package.sha256, first.package.sha256);
  assert.equal(reused.public_asset_version, first.public_asset_version);
  // Freshness gates still ran; the suite was reused, not rerun.
  assert.deepEqual(
    reused.stages.map(s => s.name),
    ['build_release_identity'],
  );
  r.write('src/module.ts', 'export const value = 2;\n');
  r.git('add', 'src/module.ts');
  r.commit('Source change');
  const fresh = await qualify({
    root: r.root,
    stages: [identityStage, suiteStage],
    recordsDir: r.records,
    reuse: true,
    probe: present,
  });
  assert.equal(fresh.reuse_of, null);
  assert.equal(fresh.reuse_refused.reason, 'package_scope_changed');
  assert.ok(fresh.reuse_refused.paths.includes('src/module.ts'));
  assert.deepEqual(
    fresh.stages.map(s => s.name),
    ['build_release_identity', 'synthetic_suite'],
  );
});

test('qualification with FFmpeg absent fails clearly and runs nothing after the probe', async t => {
  const r = repository(t);
  const record = await qualify({
    root: r.root,
    stages: [{name: 'ffmpeg_probe', internal: 'ffmpeg', blocking: true}, suiteStage],
    record: false,
    probe: absent,
  });
  assert.equal(record.result, 'failed');
  assert.equal(record.stages[0].status, 'failed');
  assert.equal(record.stages[0].error_code, 'FFMPEG_UNAVAILABLE');
  assert.equal(record.stages[1].status, 'not_run');
  assert.equal(record.toolchain.ffmpeg, 'unavailable');
  const passed = await qualify({
    root: r.root,
    stages: [{name: 'ffmpeg_probe', internal: 'ffmpeg', blocking: true}, suiteStage],
    record: false,
    probe: present,
  });
  assert.equal(passed.result, 'passed');
  assert.equal(passed.stages[0].ffmpeg, ffmpegLine);
  assert.equal(passed.totals.skipped, 0);
});

test('the FFmpeg stage probes ffprobe as ffprobe, so an installed ffprobe passes it', async t => {
  const r = repository(t);
  const printed = {
    'synthetic-ffmpeg': ffmpegLine,
    'synthetic-ffprobe': 'ffprobe version 9.0 Copyright (c) 2007-2026 the FFmpeg developers',
  };
  const asked = [];
  // The runtime's own probe of each synthetic program's output. Regression: the stage asked for no program, so ffprobe's
  // line was matched as ffmpeg's and full qualification failed wherever ffprobe was installed.
  const probe = ({command, program}) => {
    asked.push(program);
    return probeMediaProcessor({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(' + JSON.stringify(printed[command]) + ')'],
      program,
    });
  };
  const record = await qualify({
    root: r.root,
    stages: [{name: 'ffmpeg_probe', internal: 'ffmpeg', blocking: true}, suiteStage],
    record: false,
    env: {AMCP_FFMPEG_PATH: 'synthetic-ffmpeg', AMCP_FFPROBE_PATH: 'synthetic-ffprobe'},
    probe,
  });
  assert.equal(record.stages[0].status, 'passed', JSON.stringify(record.stages[0]));
  assert.equal(record.stages[0].ffmpeg, ffmpegLine);
  assert.equal(record.result, 'passed');
  assert.ok(asked.includes('ffprobe') && asked.every(program => ['ffmpeg', 'ffprobe'].includes(program)), asked);
});

test('a skipped test fails qualification unless it is named in the allow-list, and unnamed skips always fail', async t => {
  const r = repository(t);
  const skipped = {
    ...suiteStage,
    args: tap([
      'ok 1 - converts media # SKIP FFmpeg unavailable',
      'ok 2 - plain',
      '# tests 2',
      '# pass 1',
      '# fail 0',
      '# skipped 1',
    ]),
  };
  const refused = await qualify({root: r.root, stages: [skipped], record: false, probe: present});
  assert.equal(refused.result, 'failed');
  assert.deepEqual(refused.stages[0].unexpected_skips, ['converts media']);
  const allowed = await qualify({
    root: r.root,
    stages: [skipped],
    record: false,
    allowSkips: ['converts media'],
    probe: present,
  });
  assert.equal(allowed.result, 'passed');
  const unnamed = {
    ...suiteStage,
    args: tap(['ok 1 - converts media # SKIP FFmpeg unavailable', '# tests 3', '# pass 1', '# skipped 2']),
  };
  const counted = await qualify({
    root: r.root,
    stages: [unnamed],
    record: false,
    allowSkips: ['converts media'],
    probe: present,
  });
  assert.equal(counted.result, 'failed');
});

test('prune dry-run lists unretained candidates and deletes nothing; deletion without --dry-run is refused', async t => {
  const r = repository(t);
  const first = await qualify({root: r.root, stages: [identityStage], recordsDir: r.records, probe: present});
  const candidate = (name, manifest, extra = {}) => {
    const directory = path.join(r.root, '.release', name);
    fs.mkdirSync(path.join(directory, 'dist'), {recursive: true});
    if (manifest) fs.writeFileSync(path.join(directory, 'release-manifest.json'), JSON.stringify(manifest));
    for (const [file, text] of Object.entries(extra)) fs.writeFileSync(path.join(directory, file), text);
    return directory;
  };
  const recent = candidate('recent', {
      revision: first.source.revision,
      source_tree_hash: first.source.source_tree_hash,
    }),
    retained = candidate('retained', {revision: 'x', source_tree_hash: 'y'}, {'.retain': ''}),
    deployed = candidate('deployed', null, {'dist/release-identity.json': JSON.stringify({sha256: 'c'.repeat(64)})}),
    stale = candidate('stale', {revision: 'old', source_tree_hash: 'z'.repeat(64)});
  const list = pruneDryRun({root: r.root, recordsDir: r.records, keepLast: 5, keepPackages: ['c'.repeat(64)]});
  assert.equal(list.mode, 'prune_dry_run');
  assert.equal(list.deleted, 0);
  assert.equal(list.candidates, 4);
  assert.deepEqual(
    list.keep.map(k => [k.name, k.reason]),
    [
      ['deployed', 'deployed_package'],
      ['recent', 'recent_record'],
      ['retained', 'retain_mark'],
    ],
  );
  assert.deepEqual(
    list.prune_candidates.map(k => k.name),
    ['stale'],
  );
  for (const directory of [recent, retained, deployed, stale]) assert.ok(fs.existsSync(directory), directory);
  const cli = spawnSync(process.execPath, [qualifyCli, '--prune'], {cwd: r.root, encoding: 'utf8'});
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /QUALIFY_PRUNE_DRY_RUN_ONLY/);
  assert.ok(fs.existsSync(stale));
});

test('profiles run freshness gates first, require FFmpeg for the suites, and record sunset alarms without blocking', () => {
  const fast = profileStages('fast');
  assert.ok(fast.every(stage => stage.freshness));
  for (const name of [
    'build_typescript',
    'build_release_identity',
    'format_check',
    'generate_check',
    'report_check',
    'contracts_check',
    'contracts_actions_check',
    'docs_index_check',
  ])
    assert.ok(
      fast.some(stage => stage.name === name),
      name,
    );
  const sunset = fast.find(stage => stage.name === 'sunset_alarms');
  assert.equal(sunset.blocking, false);
  assert.deepEqual(profileStages('fast', {now: '2027-06-01'}).at(-1).args.slice(-2), ['--now', '2027-06-01']);
  const full = profileStages('full'),
    probe = full.findIndex(stage => stage.name === 'ffmpeg_probe'),
    suite = full.findIndex(stage => stage.name === 'test_suite');
  assert.ok(probe > fast.length - 1 && probe < suite);
  assert.equal(full[suite].env.AMCP_REQUIRE_FFMPEG, 'true');
  assert.throws(() => profileStages('everything'), /QUALIFY_PROFILE_UNKNOWN/);
});

// Package closing-small, item 4: the Arabic chunks (web/locales/ar/) are generated from the catalogue and from the messages
// the scripts write, and a stale one is a missing translation in the browser. Only check-web, a stage of the full profile,
// compared them, so a catalogue or script change that left one stale passed `npm run check:fast` (the gate before a push)
// and failed later. The fast profile now runs the chunk check, read-only, with the other freshness gates.
test('the fast profile checks the Arabic chunks without writing them, as a blocking freshness gate', () => {
  const fast = profileStages('fast'),
    stage = fast.find(s => s.name === 'locale_chunks_check');
  assert.ok(stage, 'check:fast has a stage for the Arabic chunks');
  assert.deepEqual(stage.args, ['tools/locale-chunks.mjs'], 'check mode: --write regenerates them, which no gate does');
  assert.ok(fs.existsSync(stage.args[0]), stage.args[0]);
  assert.equal(stage.blocking, true);
  assert.equal(stage.freshness, true, 'a reused qualification runs it too');
  assert.equal(fast.at(-1).name, 'sunset_alarms', 'the alarm, which never blocks, stays last');
  assert.ok(
    profileStages('full').some(s => s.name === 'locale_chunks_check'),
    'the full profile starts with the same gates',
  );
});

test('the full profile runs the journey and MCP evaluation against its committed baseline as a blocking stage (QA-04)', () => {
  const stage = profileStages('full').find(item => item.name === 'journey_evaluation');
  assert.deepEqual(stage && [stage.args, stage.blocking], [['tools/mcp-eval.mjs', '--check'], true]);
  assert.equal(
    profileStages('fast').some(item => item.name === 'journey_evaluation'),
    false,
    'the fast profile stays freshness-only',
  );
});

// PRV-04 step 6: the sunset and deprecation alarms run offline inside qualification and are recorded, never failing it.
test('a synthetic date inside 90 days of a dated change records sunset_alarms without failing qualification', async t => {
  const r = repository(t);
  const stage = profileStages('fast', {now: '2026-11-01'}).find(s => s.name === 'sunset_alarms');
  const record = await qualify({
    root: r.root,
    stages: [identityStage, {...stage, args: [path.resolve(stage.args[0]), ...stage.args.slice(1)]}],
    record: false,
    probe: present,
  });
  assert.equal(record.result, 'passed');
  const recorded = record.stages.find(s => s.name === 'sunset_alarms');
  assert.deepEqual([recorded.status, recorded.blocking, recorded.exit_code], ['alarm', false, 1]);
  assert.equal(recorded.json, undefined, 'the parsed output moves to the record');
  assert.equal(record.sunset_alarms.checked_at, '2026-11-01T00:00:00.000Z');
  assert.ok(
    record.sunset_alarms.alarms.some(a => a.kind === 'deprecation' && a.effective_date === '2026-12-08'),
    JSON.stringify(record.sunset_alarms.alarms),
  );
  assert.ok(record.sunset_alarms.dated.length > 0);
});

test('summary lines and skipped names are parsed from both spec and TAP output', () => {
  assert.deepEqual(testSummary('ℹ tests 5\nℹ suites 0\nℹ pass 4\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\n'), {
    total: 5,
    pass: 4,
    fail: 0,
    skipped: 1,
    cancelled: 0,
    todo: 0,
  });
  assert.deepEqual(testSummary('# tests 2\n# pass 2\n'), {
    total: 2,
    pass: 2,
    fail: 0,
    skipped: 0,
    cancelled: 0,
    todo: 0,
  });
  assert.equal(testSummary('no summary here'), null);
  assert.deepEqual(
    skippedTests('﹣ media conversion (0.4ms) # FFmpeg unavailable\nok 3 - other case # SKIP reason\n'),
    ['media conversion', 'other case'],
  );
});

test('every freshness gate reports in one pass, while the suites and anything after a failed build do not run', async t => {
  const r = repository(t);
  const gate = (name, code) => ({
    name,
    command: 'node',
    args: ['-e', 'process.exit(' + code + ')'],
    blocking: true,
    freshness: true,
  });
  const record = await qualify({
    root: r.root,
    stages: [gate('report_check', 1), gate('docs_index_check', 0), suiteStage],
    record: false,
    probe: present,
  });
  assert.equal(record.result, 'failed');
  assert.deepEqual(
    record.stages.map(s => [s.name, s.status]),
    [
      ['report_check', 'failed'],
      ['docs_index_check', 'passed'],
      ['synthetic_suite', 'not_run'],
    ],
  );
  const broken = await qualify({
    root: r.root,
    stages: [gate('build_typescript', 2), gate('report_check', 0)],
    record: false,
    probe: present,
  });
  assert.deepEqual(
    broken.stages.map(s => s.status),
    ['failed', 'not_run'],
  );
});
