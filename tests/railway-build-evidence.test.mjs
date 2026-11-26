// ACC-04: Railway build logs as per-release Linux evidence. Synthetic saved logs only (BuildKit plain progress and a
// log view without step numbers); nothing is fetched from Railway and no real build log or digest is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildEvidence, parseBuildLog, sanitizeCommand} from '../tools/railway-build-evidence.mjs';
import {removeTestDirectory} from '../dist/tests/temp.js';

const tool = fileURLToPath(new URL('../tools/railway-build-evidence.mjs', import.meta.url)),
  hex = c => c.repeat(64),
  commit = 'a'.repeat(40),
  packaged = hex('b'),
  check = 'AMCP_REQUIRE_FFMPEG=true AMCP_TEST_CONCURRENCY=2 npm run check';
function buildkit({cached = false, fail = 0, command = check, error = false, revision = commit} = {}) {
  return [
    '#1 [internal] load build definition from Dockerfile',
    '#3 [internal] load metadata for docker.io/library/node:24-bookworm-slim',
    '#5 [build 1/9] FROM docker.io/library/node:24-bookworm-slim@sha256:' + hex('c'),
    '#5 resolve docker.io/library/node:24-bookworm-slim@sha256:' + hex('c') + ' done',
    '#9 [build 5/9] RUN npm ci',
    '#9 DONE 41.2s',
    '#12 [build 7/9] RUN ' + command,
    ...(cached
      ? ['#12 CACHED']
      : [
          '#12 0.512 > amcp@0.1.0 check',
          '#12 3.104 {"event":"release_identity_written","schema_version":2,"sha256":"' +
            packaged +
            '","files":1493,"bytes":54161551,"source_revision":"' +
            revision +
            '"}',
          // Another step's output interleaved under its own number never counts.
          '#13 1.000 ℹ tests 3',
          '#12 9.500 MIRROR_MASTER_KEY=c3ludGhldGljLW5vdC1hLXJlYWwta2V5LXZhbHVlLTEyMzQ1Ng== node /app/dist/tools/x.js',
          '#12 600.1 ✔ a test that mentions exit code 1 in its name (2.1ms)',
          '#12 801.0 ℹ tests 5096',
          '#12 801.0 ℹ suites 0',
          '#12 801.0 ℹ pass ' + (5096 - fail),
          '#12 801.0 ℹ fail ' + fail,
          '#12 801.0 ℹ cancelled 0',
          '#12 801.0 ℹ skipped 0',
          '#12 801.0 ℹ todo 0',
          '#12 805.5 ℹ tests 12',
          '#12 805.5 ℹ pass 12',
          '#12 805.5 ℹ fail 0',
          '#12 805.5 ℹ cancelled 0',
          '#12 805.5 ℹ skipped 0',
          error ? '#12 ERROR: process "/bin/sh -c ' + command + '" did not complete successfully: exit code: 1' : '',
          error ? '' : '#12 DONE 812.4s',
        ]),
    '#14 [build 8/9] RUN npm prune --omit=dev',
    '#14 DONE 3.1s',
    ...(error
      ? ['ERROR: failed to solve: process "/bin/sh -c ' + command + '" did not complete successfully: exit code: 1']
      : ['#20 exporting to image', '#20 exporting manifest sha256:' + hex('d') + ' done']),
  ].join('\n');
}
const versionz = (revision = commit, status = 'matches_build') => ({
  schema_version: 1,
  status,
  observed_at: '2026-10-11T00:00:00.000Z',
  build: {schema_version: 2, sha256: packaged, source_revision: revision},
  runtime: {schema_version: 2, sha256: packaged, source_revision: null},
});

test('a completed full check yields pass and fail counts, digests and the build identity, and no log text', () => {
  const {record, excerpt} = buildEvidence({
    log: buildkit(),
    commit,
    versionz: versionz(),
    deployedAt: '2026-10-11T10:00:00Z',
  });
  assert.equal(record.linux_full_check_passed, true, record.reasons.join());
  assert.deepEqual(record.tests.total, {tests: 5108, pass: 5108, fail: 0, skipped: 0, cancelled: 0});
  assert.deepEqual(
    record.tests.runs.map(run => [run.tests, run.pass, run.fail]),
    [
      [5096, 5096, 0],
      [12, 12, 0],
    ],
  );
  assert.deepEqual(record.check_step, {
    found: true,
    executed: true,
    cached: false,
    failed: false,
    duration_s: 812.4,
    ffmpeg_required: true,
    command: 'RUN ' + check,
  });
  assert.deepEqual(record.base_image, {reference: 'node:24-bookworm-slim', digest: 'sha256:' + hex('c')});
  assert.equal(record.image_digest, 'sha256:' + hex('d'));
  assert.equal(record.image_digest_source, 'build_log');
  assert.deepEqual(record.release_identity, {schema_version: 2, sha256: packaged, source_revision: commit});
  assert.equal(record.versionz.status, 'matches_build');
  assert.equal(record.deployed_at, '2026-10-11T10:00:00.000Z');
  // Counts, digests and hashes only: no environment value, path or test name leaves the log.
  for (const text of [JSON.stringify(record), excerpt]) {
    assert.doesNotMatch(text, /c3ludGhldGlj|MIRROR_MASTER_KEY|\/app\/|mentions exit code/);
  }
  assert.match(excerpt, /^ℹ tests 5096$/m);
  assert.match(record.excerpt_sha256, /^[0-9a-f]{64}$/);
});

test('a check reused from the build cache, a failed suite or a check without FFmpeg is never evidence', () => {
  const cached = buildEvidence({log: buildkit({cached: true})}).record;
  assert.equal(cached.linux_full_check_passed, false);
  assert.ok(cached.reasons.includes('CHECK_STEP_CACHED'));
  assert.ok(cached.reasons.includes('TEST_TOTALS_NOT_FOUND'));
  assert.equal(cached.check_step.executed, false);

  const failed = buildEvidence({log: buildkit({fail: 2, error: true})}).record;
  assert.equal(failed.tests.total.fail, 2);
  assert.ok(failed.reasons.includes('TESTS_FAILED'));
  assert.ok(failed.reasons.includes('CHECK_STEP_FAILED'));

  const unrequired = buildEvidence({log: buildkit({command: 'AMCP_TEST_CONCURRENCY=2 npm run check'})}).record;
  assert.deepEqual(unrequired.reasons, ['FFMPEG_NOT_REQUIRED']);

  assert.deepEqual(buildEvidence({log: 'Using Detected Dockerfile\n'}).record.reasons, [
    'CHECK_STEP_NOT_FOUND',
    'TEST_TOTALS_NOT_FOUND',
  ]);
});

test('the build commit, /versionz and the build log must agree', () => {
  const other = 'e'.repeat(40);
  assert.ok(buildEvidence({log: buildkit(), commit: other}).record.reasons.includes('BUILD_COMMIT_MISMATCH'));
  const stale = buildEvidence({log: buildkit(), commit, versionz: versionz(other)}).record;
  assert.deepEqual(stale.reasons, ['VERSIONZ_COMMIT_MISMATCH']);
  const mismatch = buildEvidence({log: buildkit(), versionz: versionz(commit, 'payload_mismatch')}).record;
  assert.deepEqual(mismatch.reasons, ['VERSIONZ_NOT_MATCHING_BUILD']);
  assert.deepEqual(buildEvidence({log: buildkit(), versionz: {status: 1}}).record.reasons, ['VERSIONZ_INVALID']);
  // The owner may supply the image digest from Railway's deployment view.
  const owner = buildEvidence({log: buildkit(), imageDigest: 'sha256:' + hex('9')}).record;
  assert.equal(owner.image_digest_source, 'owner');
  assert.throws(() => buildEvidence({log: '', imageDigest: 'latest'}), /USAGE/);
  assert.throws(() => buildEvidence({log: '', commit: 'HEAD'}), /USAGE/);
});

test('a log view without step numbers is read the same way, including a cached header', () => {
  const lines = [
    '[build 1/9] FROM docker.io/library/node:24-bookworm-slim@sha256:' + hex('c'),
    '[build 7/9] RUN ' + check,
    'ℹ tests 40',
    'ℹ pass 40',
    'ℹ fail 0',
    'ℹ cancelled 0',
    'ℹ skipped 0',
    '[build 8/9] RUN npm prune --omit=dev',
    'ℹ tests 1',
  ];
  const parsed = parseBuildLog(lines.join('\r\n'));
  assert.equal(parsed.check.found, true);
  assert.deepEqual(parsed.tests.total, {tests: 40, pass: 40, fail: 0, skipped: 0, cancelled: 0});
  // Without BuildKit's DONE marker completion is not established, so it is not claimed.
  assert.deepEqual(buildEvidence({log: lines.join('\n')}).record.reasons, ['CHECK_STEP_NOT_COMPLETED']);
  const cached = parseBuildLog('[build 7/9] RUN ' + check + '  cached\n');
  assert.equal(cached.check.cached, true);
  assert.equal(
    sanitizeCommand('RUN TOKEN=abc https://user:pw@example.test AMCP_REQUIRE_FFMPEG=true npm run check'),
    'RUN TOKEN=<value> https://<credentials>@example.test AMCP_REQUIRE_FFMPEG=true npm run check',
  );
});

test('the command line writes new record and excerpt files only, with fixed exit codes and no paths', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-railway-evidence-'));
  try {
    const log = path.join(directory, 'build.log'),
      record = path.join(directory, 'record.json'),
      excerpt = path.join(directory, 'excerpt.txt');
    fs.writeFileSync(log, buildkit());
    const run = (...args) => spawnSync(process.execPath, [tool, ...args], {encoding: 'utf8', windowsHide: true});
    const ok = run('--log', log, '--commit', commit, '--record', record, '--excerpt', excerpt);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).linux_full_check_passed, true);
    assert.match(fs.readFileSync(excerpt, 'utf8'), /ℹ pass 5096/);
    const again = run('--log', log, '--record', record);
    assert.equal(again.status, 2);
    assert.equal(again.stderr.trim(), 'OUTPUT_EXISTS');
    fs.writeFileSync(log, buildkit({cached: true}));
    assert.equal(run('--log', log).status, 1);
    const missing = run('--log', path.join(directory, 'absent.log'));
    assert.equal(missing.status, 2);
    assert.equal(missing.stderr.trim(), 'EVIDENCE_INPUT_UNAVAILABLE');
    assert.ok(!missing.stderr.includes(directory));
    assert.equal(run('--bogus', 'x').status, 2);
  } finally {
    removeTestDirectory(directory, 'amcp-railway-evidence-');
  }
});
