#!/usr/bin/env node
// Railway build evidence (ACC-04). Railway builds the Dockerfile on Linux, and its build stage runs the full check with
// FFmpeg required, so every deployed revision already has a Linux full-suite run behind it. This tool turns a build log
// the owner exported read-only from Railway into a counts-only evidence record, so B16's Linux evidence is harvested
// per release instead of waiting for a local Docker host:
//   node tools/railway-build-evidence.mjs --log <saved build log> [--commit <40-hex>] [--versionz <saved /versionz JSON>]
//          [--image-digest sha256:<hex>] [--deployed-at <ISO time>] [--record <new .json>] [--excerpt <new .txt>]
// It reads only the files named, sends nothing and never overwrites a file. The record keeps hashes, counts, digests and
// step facts, never log text. --excerpt writes a sanitized excerpt rebuilt from the parsed facts (the check command with
// environment values replaced, step markers, test totals, digests), and the record names its SHA-256.
// Exit 0: the log shows the full check executed (not reused from cache) with FFmpeg required and zero failed tests (and,
// when given, /versionz matches the build); 1: it does not, and `reasons` says why; 2: usage or input error.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const sha = value => createHash('sha256').update(value).digest('hex');
const imageDigest = /^sha256:[0-9a-f]{64}$/;
/** The Dockerfile's build-stage check: a `RUN` step that runs `npm run check` (its totals are the evidence). */
export const checkStep = /^(?:\[[^\]]+\]\s+)?RUN\s.*\bnpm run check\b/;
/** Build flags whose values are fixed in the Dockerfile and safe to keep; every other assignment loses its value. */
const keptValues = new Set(['AMCP_REQUIRE_FFMPEG', 'AMCP_TEST_CONCURRENCY', 'AMCP_DOCKER_CHECK']);

/** The BuildKit step number of a line (`#12 …`), after an optional timestamp; null for other lines. */
const stepOf = line => /^#(\d+)\s/.exec(line)?.[1] ?? null;
/** A log line without its timestamp, then without BuildKit's `#<step> <seconds>` output prefix. */
function strip(line) {
  const bare = line.replace(/^﻿/, '').replace(/^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s+/, '');
  return {step: stepOf(bare), text: bare.replace(/^#\d+\s+\d+(?:\.\d+)?\s/, '').replace(/\s+$/, '')};
}
/** Replaces environment assignment values (except fixed build flags) and URL credentials in a command. */
export function sanitizeCommand(command) {
  return command
    .replace(/\b([A-Z][A-Z0-9_]{0,63})=("[^"]*"|'[^']*'|\S+)/g, (match, name) =>
      keptValues.has(name) ? match : name + '=<value>',
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1<credentials>@')
    .slice(0, 400);
}
const totalsLine = /^(?:ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/;
/** Node test runner totals (spec `ℹ tests 5` or TAP `# tests 5`), one block per run, plus their sum. */
function testRuns(lines) {
  const runs = [];
  let current;
  for (const line of lines) {
    const m = totalsLine.exec(line);
    if (!m) continue;
    if (m[1] === 'tests') runs.push((current = {tests: Number(m[2])}));
    else if (current && current[m[1]] === undefined) current[m[1]] = Number(m[2]);
  }
  const value = (run, name) => run[name] ?? null;
  return {
    runs: runs.map(run => ({
      tests: run.tests,
      pass: value(run, 'pass'),
      fail: value(run, 'fail'),
      skipped: value(run, 'skipped'),
      cancelled: value(run, 'cancelled'),
    })),
    total: runs.length
      ? runs.reduce(
          (sum, run) => ({
            tests: sum.tests + run.tests,
            pass: sum.pass + (run.pass ?? 0),
            fail: sum.fail + (run.fail ?? 0),
            skipped: sum.skipped + (run.skipped ?? 0),
            cancelled: sum.cancelled + (run.cancelled ?? 0),
          }),
          {tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0},
        )
      : null,
  };
}
/**
 * Parses a saved Railway (BuildKit) build log. Understands BuildKit's plain progress (`#12 [build 7/9] RUN …`,
 * `#12 CACHED`, `#12 DONE 812.4s`, `#12 ERROR`) and step headers without a step number that end in `cached`, as a
 * log view may show them. Anything it cannot establish stays null or false; it never infers a pass.
 */
export function parseBuildLog(text) {
  const lines = String(text).split(/\r?\n/).map(strip);
  const check = {found: false, step: null, cached: false, done: false, failed: false, duration_s: null};
  let command = null,
    start = -1,
    end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].text.replace(/^#\d+\s+/, '');
    if (!checkStep.test(header)) continue;
    check.found = true;
    if (start < 0) {
      start = i;
      check.step = lines[i].step;
      command = header.replace(/^\[[^\]]+\]\s+/, '').replace(/\s+cached$/i, '');
    }
    if (/\scached$/i.test(header)) check.cached = true;
  }
  if (check.found)
    for (let i = start + 1; i < lines.length; i++) {
      const {step, text} = lines[i];
      if (check.step !== null && step === check.step) {
        if (/^#\d+ CACHED$/.test(text)) check.cached = true;
        const done = /^#\d+ DONE (\d+(?:\.\d+)?)s$/.exec(text);
        if (done) {
          check.done = true;
          check.duration_s = Number(done[1]);
          end = i + 1;
          break;
        }
        if (/^#\d+ ERROR\b/.test(text)) {
          check.failed = true;
          end = i + 1;
          break;
        }
      } else if (check.step === null && /^\[[^\]]+\]\s+(?:RUN|COPY|FROM)\b/.test(text)) {
        end = i;
        break;
      }
    }
  // BuildKit's final error names the failed command; a test's own output saying "exit code 1" never counts.
  if (
    lines.some(({text}) => /did not complete successfully: exit code: [1-9]/.test(text) && /npm run check\b/.test(text))
  )
    check.failed = true;
  // Only lines of the check step: BuildKit interleaves other steps' output under their own numbers.
  const scope = check.found
    ? lines.slice(start, end).filter(line => check.step === null || line.step === null || line.step === check.step)
    : [];
  const tests = testRuns(scope.map(line => line.text));
  let identity = null;
  for (const {text} of scope) {
    const at = text.indexOf('{"event":"release_identity_written"');
    if (at < 0) continue;
    try {
      const record = JSON.parse(text.slice(at));
      identity = {
        schema_version: Number.isSafeInteger(record.schema_version) ? record.schema_version : null,
        sha256: /^[0-9a-f]{64}$/.test(record.sha256 ?? '') ? record.sha256 : null,
        source_revision: /^[0-9a-f]{40}$/.test(record.source_revision ?? '') ? record.source_revision : null,
      };
    } catch {}
  }
  let base = null,
    image = null;
  for (const {text} of lines) {
    const from =
      /\bFROM\s+([\w.\-/:]+?)@(sha256:[0-9a-f]{64})/.exec(text) ??
      /\bresolve\s+([\w.\-/:]+?)@(sha256:[0-9a-f]{64})/.exec(text);
    if (from && !base) base = {reference: from[1].replace(/^docker\.io\/library\//, ''), digest: from[2]};
    const exported =
      /\b(?:exporting manifest(?: list)?|writing image|containerimage\.digest|image digest|pushed digest)[:\s]+(sha256:[0-9a-f]{64})/i.exec(
        text,
      );
    if (exported) image = exported[1];
  }
  return {
    check: {
      ...check,
      ffmpeg_required: !!command && /(?:^|\s)AMCP_REQUIRE_FFMPEG=true\s/.test(command),
      command: command ? sanitizeCommand(command) : null,
    },
    tests,
    release_identity: identity,
    base_image: base,
    image_digest: image,
  };
}
/** /versionz as saved by the owner: status, build and runtime package digests and the build's Git claim. */
function versionzFacts(value) {
  const object = v => !!v && typeof v === 'object' && !Array.isArray(v),
    hex = (v, n) => (typeof v === 'string' && new RegExp('^[0-9a-f]{' + n + '}$').test(v) ? v : null);
  if (!object(value) || typeof value.status !== 'string') return null;
  return {
    status: value.status.slice(0, 40),
    build_sha256: hex(value.build?.sha256, 64),
    runtime_sha256: hex(value.runtime?.sha256, 64),
    source_revision: hex(value.build?.source_revision, 40),
  };
}
/** The sanitized excerpt, rebuilt from validated facts only, so no other log text can reach it. */
function excerptOf(parsed, digest) {
  const out = [];
  if (parsed.base_image) out.push('FROM ' + parsed.base_image.reference + '@' + parsed.base_image.digest);
  if (parsed.check.command) out.push('RUN ' + parsed.check.command.replace(/^RUN\s+/, ''));
  if (parsed.check.cached) out.push('CACHED');
  if (parsed.check.done) out.push('DONE ' + parsed.check.duration_s + 's');
  if (parsed.check.failed) out.push('ERROR');
  for (const run of parsed.tests.runs)
    for (const name of ['tests', 'pass', 'fail', 'skipped', 'cancelled'])
      if (run[name] !== null) out.push('ℹ ' + name + ' ' + run[name]);
  if (parsed.release_identity)
    out.push(JSON.stringify({event: 'release_identity_written', ...parsed.release_identity}));
  if (digest) out.push('image ' + digest);
  return out.join('\n') + '\n';
}
/** The evidence record and its verdict. Nothing is inferred: a missing fact is a reason, never a pass. */
export function buildEvidence({log, commit = null, versionz = null, imageDigest: given = null, deployedAt = null}) {
  if (commit !== null && !/^[0-9a-f]{40}$/.test(commit)) throw Error('USAGE: --commit takes a 40-character revision');
  if (given !== null && !imageDigest.test(given)) throw Error('USAGE: --image-digest takes sha256:<64 hex>');
  if (deployedAt !== null && !Number.isFinite(Date.parse(deployedAt)))
    throw Error('USAGE: --deployed-at takes an ISO time');
  const parsed = parseBuildLog(log),
    c = parsed.check,
    t = parsed.tests.total,
    reasons = [];
  if (!c.found) reasons.push('CHECK_STEP_NOT_FOUND');
  if (c.cached) reasons.push('CHECK_STEP_CACHED');
  if (c.failed) reasons.push('CHECK_STEP_FAILED');
  else if (c.found && !c.cached && !c.done) reasons.push('CHECK_STEP_NOT_COMPLETED');
  if (c.found && !c.ffmpeg_required) reasons.push('FFMPEG_NOT_REQUIRED');
  if (!t) reasons.push('TEST_TOTALS_NOT_FOUND');
  else {
    if (t.tests === 0) reasons.push('NO_TESTS');
    if (t.fail || t.cancelled) reasons.push('TESTS_FAILED');
    if (t.pass + t.skipped < t.tests - t.fail - t.cancelled) reasons.push('TEST_TOTALS_INCONSISTENT');
  }
  const claimed = parsed.release_identity?.source_revision ?? null;
  if (commit && claimed && claimed !== commit) reasons.push('BUILD_COMMIT_MISMATCH');
  const facts = versionz === null ? null : versionzFacts(versionz);
  if (versionz !== null && !facts) reasons.push('VERSIONZ_INVALID');
  if (facts) {
    if (facts.status !== 'matches_build') reasons.push('VERSIONZ_NOT_MATCHING_BUILD');
    const revision = commit ?? claimed;
    if (revision && facts.source_revision !== revision) reasons.push('VERSIONZ_COMMIT_MISMATCH');
    if (parsed.release_identity?.sha256 && facts.build_sha256 !== parsed.release_identity.sha256)
      reasons.push('VERSIONZ_PACKAGE_MISMATCH');
  }
  const digest = given ?? parsed.image_digest,
    excerpt = excerptOf(parsed, digest);
  return {
    record: {
      record_kind: 'railway_build_evidence',
      version: 1,
      build_commit: commit ?? claimed,
      deployed_at: deployedAt === null ? null : new Date(deployedAt).toISOString(),
      log_sha256: sha(String(log)),
      excerpt_sha256: sha(excerpt),
      check_step: {
        found: c.found,
        executed: c.found && !c.cached && c.done,
        cached: c.cached,
        failed: c.failed,
        duration_s: c.duration_s,
        ffmpeg_required: c.ffmpeg_required,
        command: c.command,
      },
      tests: parsed.tests,
      release_identity: parsed.release_identity,
      base_image: parsed.base_image,
      image_digest: digest ?? null,
      image_digest_source: given ? 'owner' : parsed.image_digest ? 'build_log' : null,
      versionz: facts,
      linux_full_check_passed: reasons.length === 0,
      reasons,
      scope:
        'Counts and digests from a Railway build log the owner exported read-only. It shows that the Dockerfile check ran on Linux for this build; it is not a deployed smoke test, and it holds only while the Railway dashboard does not override the repository build settings (owner confirmation, D1).',
    },
    excerpt,
  };
}
const writeNew = (file, text) => fs.writeFileSync(file, text, {flag: 'wx', mode: 0o600});
function main(argv) {
  const options = {},
    names = ['--log', '--commit', '--versionz', '--image-digest', '--deployed-at', '--record', '--excerpt'];
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (!names.includes(name)) throw Error('USAGE: unknown option ' + String(name).slice(0, 40));
    const value = argv[++i];
    if (value === undefined || options[name.slice(2)] !== undefined) throw Error('USAGE: ' + name + ' needs one value');
    options[name.slice(2)] = value;
  }
  if (!options.log) throw Error('USAGE: --log <saved Railway build log> is required');
  const stat = fs.statSync(options.log);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw Error('USAGE: the build log must be a file under 64 MiB');
  const {record, excerpt} = buildEvidence({
    log: fs.readFileSync(options.log, 'utf8'),
    commit: options.commit ?? null,
    versionz: options.versionz ? JSON.parse(fs.readFileSync(options.versionz, 'utf8')) : null,
    imageDigest: options['image-digest'] ?? null,
    deployedAt: options['deployed-at'] ?? null,
  });
  if (options.excerpt) writeNew(options.excerpt, excerpt);
  if (options.record) writeNew(options.record, JSON.stringify(record, null, 2) + '\n');
  process.stdout.write(JSON.stringify(record, null, 2) + '\n');
  return record.linux_full_check_passed ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // File-system and JSON messages can name absolute paths or content; print a fixed code instead.
    process.stderr.write(
      (message.startsWith('USAGE:')
        ? message
        : error?.code === 'EEXIST'
          ? 'OUTPUT_EXISTS'
          : 'EVIDENCE_INPUT_UNAVAILABLE') + '\n',
    );
    process.exitCode = 2;
  }
