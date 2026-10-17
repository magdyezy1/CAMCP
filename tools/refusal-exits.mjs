// Refusal-to-exit listing (QA-02). A refusal that leaves something blocked, paused, busy or uncertain needs a
// documented way out, and a test that proves it, or the state can strand a user while every test stays green. This
// lists every such refusal raised on the reviewed-write, export and schedule paths and checks it against
// tests/fixtures/refusal-exits.json, where each code either names its exit test (a test file and a fragment of the test
// title; the file must also name the code) or is declared terminal with the reason no automatic exit exists.
//   node tools/refusal-exits.mjs [--json]
// It fails on a blocking code with no entry, an entry whose test is missing, and an entry for a code no longer raised.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const registryFile = 'tests/fixtures/refusal-exits.json';
/** Codes naming a state that holds something: paused, unresolved, uncertain, busy, expired, conflicting, stale. */
export const blockingState =
  /(?:^|_)(?:PAUSED|UNRESOLVED|UNCERTAIN|OUTCOME_UNKNOWN|BUSY|LEASE_LOST|EXPIRED|SETTLE_WINDOW|RELEASE_REQUIRED|REAUTHORIZATION_REQUIRED|IN_PROGRESS|CIRCUIT_OPEN|RATE_LIMIT|CANCELLED|BLOCKED|CONFLICT|SUPERSEDED|COOLDOWN|LOCKED)$|^STALE_/;
/**
 * The write path is every module reachable by runtime imports from its entry points (the same derivation as
 * tools/guidance-coverage.ts). The export and schedule paths are their own modules: following their imports would
 * reach the whole service and list every write refusal twice.
 */
export const paths = {
  write: {roots: ['write-review.ts', 'media-upload.ts'], closure: true},
  export: {
    roots: [
      'google-sheets.ts',
      'report-file-delivery.ts',
      'monitor-delivery.ts',
      'workbook-bindings.ts',
      'workbook-queries.ts',
      'workbook-schedules.ts',
      'withheld-workbook-records.ts',
      'export-policy.ts',
      'reporting-overview.ts',
    ],
    closure: false,
  },
  schedule: {
    roots: ['schedule-clock.ts', 'scheduled-work.ts', 'workbook-schedules.ts', 'report-periods.ts'],
    closure: false,
  },
};

export function pathModules({roots, closure}, src = path.join(root, 'src')) {
  const seen = new Set();
  const visit = file => {
    if (seen.has(file) || !fs.existsSync(path.join(src, file))) return;
    seen.add(file);
    if (!closure) return;
    for (const m of fs
      .readFileSync(path.join(src, file), 'utf8')
      .matchAll(/\b(?:import|export)\s+(type\s+)?[^'";]*?\bfrom\s+'\.\/([A-Za-z0-9._-]+)\.js'/g))
      if (!m[1]) visit(m[2] + '.ts');
  };
  for (const file of roots) visit(file);
  return [...seen].sort();
}
/** Blocking codes raised on each path: code -> sorted list of `path:module`. */
export function blockingCodes(src = path.join(root, 'src')) {
  const out = new Map();
  for (const [name, spec] of Object.entries(paths))
    for (const file of pathModules(spec, src))
      // As in tools/guidance-coverage.ts, a one-code refusal the family kit builds (`familyCodeError('CODE')`) names its code.
      for (const m of fs
        .readFileSync(path.join(src, file), 'utf8')
        .matchAll(/(?:new MirrorError\(|fail\(|familyCodeError\()\s*'([A-Z][A-Z0-9_]{3,})'/g))
        if (blockingState.test(m[1])) out.set(m[1], [...new Set([...(out.get(m[1]) ?? []), name + ':' + file])].sort());
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}
export function checkExits(registry, codes = blockingCodes(), base = root) {
  const exits = registry.exits ?? {},
    terminal = registry.terminal ?? {},
    problems = [];
  for (const code of codes.keys())
    if (!exits[code] && !terminal[code]) problems.push({code, problem: 'unlisted', where: codes.get(code)});
  for (const code of Object.keys(exits)) {
    if (terminal[code]) problems.push({code, problem: 'listed as both an exit and terminal'});
    const e = exits[code];
    if (!e.exit || !e.test || !e.title) {
      problems.push({code, problem: 'an exit needs exit, test and title'});
      continue;
    }
    const file = path.join(base, e.test);
    if (!fs.existsSync(file)) {
      problems.push({code, problem: 'exit test file missing: ' + e.test});
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(e.title))
      problems.push({code, problem: 'exit test title not found in ' + e.test + ': ' + e.title});
    if (!text.includes(code)) problems.push({code, problem: e.test + ' never names the code it is the exit for'});
  }
  for (const [code, reason] of Object.entries(terminal))
    if (typeof reason !== 'string' || reason.length < 20)
      problems.push({code, problem: 'a terminal entry needs its reason'});
  for (const code of [...Object.keys(exits), ...Object.keys(terminal)])
    if (!codes.has(code))
      problems.push({code, problem: 'stale: no longer raised on the write, export or schedule path'});
  return {
    codes: codes.size,
    with_exit_test: Object.keys(exits).filter(c => codes.has(c)).length,
    terminal: Object.keys(terminal).filter(c => codes.has(c)).length,
    problems,
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkExits(JSON.parse(fs.readFileSync(path.join(root, registryFile), 'utf8')));
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      result.codes +
        ' blocking refusals on the write, export and schedule paths: ' +
        result.with_exit_test +
        ' with an exit test, ' +
        result.terminal +
        ' terminal',
    );
    for (const p of result.problems)
      console.log(p.code + ': ' + p.problem + (p.where ? ' (' + p.where.join(', ') + ')' : ''));
  }
  process.exitCode = result.problems.length ? 1 : 0;
}
