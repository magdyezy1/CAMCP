// Wire-contract fixture sweep (PRV-05): runs the test files of every gateway whose routes have a pinned request schema
// (Tag Manager, GA4, Search Console, Business Profile, Display & Video 360, Microsoft Advertising, Data Manager) in
// shadow mode with AMCP_WIRE_CONTRACT_LOG set, then compares the violations their fixture bodies produced with the
// reviewed exceptions in tests/fixtures/wire-contract-exceptions.json, each of which names its vendor evidence.
//   node tools/wire-contract-sweep.mjs [--json]
// Run `npm run build` first. Exit 1 on a failing test, on a violation no exception lists, or on an exception no fixture
// produces any longer (stale). No network: the suites use synthetic transports only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
/** Test files of the covered gateways, by name. */
export const sweptTests = new RegExp(
  '^(?:delegated|dv360|ga4|google-business|google-data-manager|google-place|google-user-access|gtm|measurement|microsoft|write-platforms)',
);
export function sweepFiles(dir = path.join(root, 'tests')) {
  return fs
    .readdirSync(dir)
    .filter(name => sweptTests.test(name) && /\.test\.(?:ts|mjs)$/.test(name))
    .sort()
    .map(name => (name.endsWith('.ts') ? 'dist/tests/' + name.replace(/\.ts$/, '.js') : 'tests/' + name));
}
/** One violation as the exceptions list keys it: array indices are not part of a field's identity. */
export const violationKey = v => [v.gateway, v.action, v.field.replace(/\/\d+(?=\/|$)/g, '/*'), v.reason].join(' | ');
export function compare(lines, exceptions) {
  const seen = new Map();
  for (const line of lines) {
    const entry = JSON.parse(line);
    for (const issue of entry.issues) {
      const v = {gateway: entry.gateway, action: entry.action, field: issue.field, reason: issue.reason};
      seen.set(violationKey(v), {...v, field: v.field.replace(/\/\d+(?=\/|$)/g, '/*'), contract: entry.contract});
    }
  }
  const listed = new Map(exceptions.map(e => [violationKey(e), e]));
  return {
    unlisted: [...seen].filter(([k]) => !listed.has(k)).map(([, v]) => v),
    stale: [...listed].filter(([k]) => !seen.has(k)).map(([, v]) => v),
    listed: [...seen.keys()].filter(k => listed.has(k)).length,
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-wire-')), 'violations.jsonl');
  fs.writeFileSync(log, '');
  const files = sweepFiles();
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=dot', ...files], {
    cwd: root,
    env: {...process.env, AMCP_WIRE_CONTRACTS: 'shadow', AMCP_WIRE_CONTRACT_LOG: log},
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  const exceptions = JSON.parse(
    fs.readFileSync(path.join(root, 'tests/fixtures/wire-contract-exceptions.json'), 'utf8'),
  ).exceptions;
  const result = compare(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean), exceptions);
  fs.rmSync(path.dirname(log), {recursive: true, force: true});
  const summary = {
    test_files: files.length,
    tests_passed: run.status === 0,
    violations_listed: result.listed,
    unlisted: result.unlisted,
    stale_exceptions: result.stale,
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(files.length + ' test files; tests ' + (run.status === 0 ? 'passed' : 'FAILED'));
    console.log(result.listed + ' fixture violations listed with vendor evidence');
    for (const v of result.unlisted) console.log('UNLISTED ' + violationKey(v) + ' (' + v.contract + ')');
    for (const v of result.stale) console.log('STALE ' + violationKey(v));
  }
  if (run.status !== 0) process.stdout.write(run.stdout.slice(-20000) + run.stderr.slice(-5000));
  process.exitCode = run.status !== 0 || result.unlisted.length || result.stale.length ? 1 : 0;
}
