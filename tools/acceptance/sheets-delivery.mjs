// ACC-03: the live Google Sheets delivery acceptance on a disposable, AMCP-created spreadsheet. The owner runs the steps
// of docs/acceptance/SHEETS-DELIVERY.md on the deployed revision; this tool prints the blank evidence record, runs the
// synthetic Sheets suites, and validates a filled record, turning an accepted one into acceptance ledger rows. It never
// calls Google and never stores a spreadsheet ID, token or cell value.
// Usage:
//   node tools/acceptance/sheets-delivery.mjs template                      a blank evidence record
//   node tools/acceptance/sheets-delivery.mjs synthetic                     the synthetic Sheets suites (needs npm run build)
//   node tools/acceptance/sheets-delivery.mjs check <record.json> [--out <file>]
//       validate a filled record; with --out, write {ledger_rows} for `node tools/acceptance/ledger.mjs add <file>`
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
export const syntheticSuites = ['tests/sheets-authority.test.mjs', 'tests/sheets-delivery-recovery.test.mjs'];
/** The steps of the run, in order (ACC-03 steps 1 to 9). */
export const sheetsSteps = [
  'create_bind',
  'export',
  'typed_cells',
  'replay',
  'schedule',
  'deselect',
  'revoke',
  'request_counts',
  'forced_timeout',
];
const reference = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,119}$/,
  hex64 = /^[0-9a-f]{64}$/,
  count = v => Number.isSafeInteger(v) && v >= 0,
  label = /^[a-z][a-z0-9-]{2,39}$/;

/** A blank record: every step not run, every manual confirmation open. */
export function sheetsTemplate() {
  return {
    schema_version: 1,
    ticket: 'ACC-03',
    authorization_ref: 'REPLACE',
    release: {revision: 'REPLACE', package_sha256: 'REPLACE'},
    environment: 'deployed',
    checked_at: 'REPLACE: the UTC start of the run, such as 2026-10-20T10:00:00Z',
    spreadsheet_label: 'REPLACE: an owner label such as sheets-disposable-a, never the spreadsheet ID',
    quota_reference: {
      requests_per_minute_per_user: null,
      checked_on: null,
      source: 'Google Sheets API usage limits page, read on the day of the run',
    },
    steps: {
      create_bind: {result: 'not_run', created_by_amcp: null, scope: 'drive.file', evidence_ref: null},
      export: {result: 'not_run', evidence_ref: null, write_requests: null, read_requests: null, elapsed_ms: null},
      typed_cells: {
        result: 'not_run',
        formula_text_stays_text: null,
        numbers_are_number_cells: null,
        marker_matches_fingerprint: null,
        marker_sha256: null,
      },
      replay: {result: 'not_run', writes: null, evidence_ref: null},
      schedule: {result: 'not_run', occurrences: []},
      deselect: {result: 'not_run', refusal_code: null, evidence_ref: null},
      revoke: {result: 'not_run', refusal_code: null, evidence_ref: null},
      request_counts: {result: 'not_run', max_requests_in_a_minute: null},
      forced_timeout: {result: 'not_run', reason: ''},
    },
    manual: {tab_content_confirmed: null, other_tabs_untouched: null, file_deleted_after: null},
  };
}

/** Every problem with a filled record; an empty list means it is valid (accepted only when every step passed). */
export function validateSheetsRecord(record) {
  const problems = [],
    at = (step, message) => problems.push(step + ': ' + message);
  if (!record || record.schema_version !== 1 || record.ticket !== 'ACC-03') return ['the record is an ACC-03 record'];
  // No spreadsheet ID, token or cell value: a Google file ID is a run of 25 or more URL-safe characters.
  // Free text and references only: notes, reasons, evidence references and the label.
  const texts = [
    record.spreadsheet_label,
    record.quota_reference?.source,
    ...Object.values(record.steps ?? {}).flatMap(s => [
      s?.evidence_ref,
      s?.note,
      s?.reason,
      ...(Array.isArray(s?.occurrences) ? s.occurrences.map(o => o?.evidence_ref) : []),
    ]),
  ].filter(v => typeof v === 'string');
  if (
    texts.some(
      text =>
        /docs\.google\.com|bearer\s|ya29\./i.test(text) ||
        // A run of 25 or more URL-safe characters is a file ID or token, unless it is a hex digest or a UUID.
        (text.match(/[A-Za-z0-9_-]{25,}/g) ?? []).some(run => !/^[0-9a-f-]+$/.test(run)),
    )
  )
    problems.push('the record holds a spreadsheet ID, URL or token; keep the owner label and references only');
  if (
    typeof record.authorization_ref !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/.test(record.authorization_ref)
  )
    problems.push("authorization_ref names the owner's written authorization of this export");
  if (!/^[0-9a-f]{7,40}$/.test(String(record.release?.revision)) || !hex64.test(String(record.release?.package_sha256)))
    problems.push('release is the /versionz revision and package_sha256 of the deployed run');
  if (record.environment !== 'deployed') problems.push('environment is deployed: the run is on the deployed revision');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z$/.test(String(record.checked_at)))
    problems.push('checked_at is the UTC start of the run');
  if (
    typeof record.spreadsheet_label !== 'string' ||
    !label.test(record.spreadsheet_label) ||
    /\d{6}/.test(record.spreadsheet_label)
  )
    problems.push('spreadsheet_label is an owner label, never the spreadsheet ID');
  const quota = record.quota_reference ?? {};
  if (
    !count(quota.requests_per_minute_per_user) ||
    !quota.requests_per_minute_per_user ||
    !/^\d{4}-\d{2}-\d{2}$/.test(String(quota.checked_on))
  )
    problems.push("quota_reference states Google's current per-user per-minute limit and the day it was read");
  const s = record.steps ?? {};
  for (const step of sheetsSteps) {
    const row = s[step];
    if (!row || !['pass', 'fail', 'skipped', 'not_run'].includes(row.result)) {
      at(step, 'result is pass, fail, skipped or not_run');
      continue;
    }
    if (row.result === 'skipped' && step !== 'forced_timeout') at(step, 'only the forced-timeout drill may be skipped');
    if (row.result === 'fail' && typeof row.note !== 'string') at(step, 'a failed step says why in note');
  }
  for (const step of ['export', 'replay', 'deselect', 'revoke', 'create_bind'])
    if (s[step]?.result === 'pass' && !reference.test(String(s[step].evidence_ref)))
      at(step, 'evidence_ref names the delivery receipt, request ID or activity entry');
  if (
    s.create_bind?.result === 'pass' &&
    (s.create_bind.created_by_amcp !== true || s.create_bind.scope !== 'drive.file')
  )
    at('create_bind', 'only a disposable spreadsheet AMCP created under drive.file is used, never a client file');
  if (s.export?.result === 'pass' && !['write_requests', 'read_requests', 'elapsed_ms'].every(k => count(s.export[k])))
    at('export', 'records its write and read requests and elapsed time');
  if (
    s.typed_cells?.result === 'pass' &&
    !(
      s.typed_cells.formula_text_stays_text === true &&
      s.typed_cells.numbers_are_number_cells === true &&
      s.typed_cells.marker_matches_fingerprint === true &&
      hex64.test(String(s.typed_cells.marker_sha256))
    )
  )
    at(
      'typed_cells',
      'passes only when =1+1 stayed text, metrics are number cells and the marker matches its fingerprint',
    );
  if (s.replay?.result === 'pass' && s.replay.writes !== 0) at('replay', 'passes only when the replay wrote nothing');
  if (s.schedule?.result === 'pass') {
    const occurrences = Array.isArray(s.schedule.occurrences) ? s.schedule.occurrences : [];
    if (
      occurrences.length < 3 ||
      !occurrences.every(
        o =>
          o?.delivered === true &&
          reference.test(String(o.evidence_ref)) &&
          count(o.write_requests) &&
          count(o.elapsed_ms),
      )
    )
      at('schedule', 'passes only with three delivered hourly occurrences, each with its receipt, requests and time');
  }
  if (s.deselect?.result === 'pass' && !/^[A-Z][A-Z0-9_]{2,63}$/.test(String(s.deselect.refusal_code)))
    at('deselect', "passes only when AMCP refused the deselected spreadsheet; record the refusal's code");
  if (s.revoke?.result === 'pass' && s.revoke.refusal_code !== 'REAUTHORIZATION_REQUIRED')
    at('revoke', 'passes only when the revoked login answered REAUTHORIZATION_REQUIRED');
  if (s.request_counts?.result === 'pass') {
    const max = s.request_counts.max_requests_in_a_minute;
    if (!count(max) || !(max <= quota.requests_per_minute_per_user))
      at('request_counts', 'passes only within the per-user per-minute limit');
  }
  if (
    s.forced_timeout?.result === 'skipped' &&
    (typeof s.forced_timeout.reason !== 'string' || s.forced_timeout.reason.length < 10)
  )
    at('forced_timeout', 'a skipped drill records why');
  for (const [key, value] of Object.entries(record.manual ?? {}))
    if (value !== null && typeof value !== 'boolean') problems.push('manual.' + key + ' is true, false or null');
  return problems;
}

/** Accepted when every required step passed (the timeout drill may be skipped with a reason) and the owner confirmed. */
export function sheetsOutcome(record) {
  const s = record.steps ?? {},
    required = sheetsSteps.filter(step => step !== 'forced_timeout');
  if (required.some(step => s[step]?.result === 'fail')) return 'refused';
  const passed =
      required.every(step => s[step]?.result === 'pass') && ['pass', 'skipped'].includes(s.forced_timeout?.result),
    confirmed = record.manual?.tab_content_confirmed === true && record.manual?.other_tabs_untouched === true;
  return passed && confirmed ? 'accepted' : 'inconclusive';
}

/** The acceptance ledger rows of an accepted run: the manual export and the scheduled delivery, references only. */
export function sheetsLedgerRows(record, contract) {
  if (sheetsOutcome(record) !== 'accepted') return [];
  const s = record.steps,
    base = {
      ticket: 'ACC-03',
      gateway: 'google_sheets_native_action',
      effect: 'mutation',
      contract_digest: contract.contract_digest,
      api_version: contract.api_version,
      account_type: 'real',
      environment: 'deployed',
      scope: {account_label: record.spreadsheet_label, accounts: 1},
      checked_at: record.checked_at,
      release: record.release,
      authorization_ref: record.authorization_ref,
      outcome: 'accepted',
    },
    stamp = record.checked_at.slice(0, 10);
  return [
    {
      ...base,
      id: 'acc-03-' + stamp + '-export',
      action: 'amcp_sheets_export',
      evidence: {
        receipt_refs: [s.export.evidence_ref, s.replay.evidence_ref],
        readback_sha256: s.typed_cells.marker_sha256,
      },
      note: 'Export to a disposable AMCP-created spreadsheet: typed cells, matching marker, a replay that wrote nothing.',
    },
    {
      ...base,
      id: 'acc-03-' + stamp + '-schedule',
      action: 'amcp_sheets_scheduled_delivery',
      evidence: {
        receipt_refs: s.schedule.occurrences.map(o => o.evidence_ref),
        readback_sha256: s.typed_cells.marker_sha256,
      },
      note: 'Three hourly scheduled deliveries to the same disposable spreadsheet.',
    },
  ];
}

async function main(argv) {
  const [command, file] = argv;
  if (command === 'template') {
    console.log(JSON.stringify(sheetsTemplate(), null, 2));
    return;
  }
  if (command === 'synthetic') {
    const run = spawnSync(process.execPath, ['--test', ...syntheticSuites], {encoding: 'utf8', cwd: root});
    console.log(
      JSON.stringify({suites: syntheticSuites, passed: run.status === 0, network: 'none: fetch stubs only'}, null, 2),
    );
    if (run.status !== 0) process.exitCode = 1;
    return;
  }
  if (command === 'check') {
    if (!file) throw Error('Name the filled record: node tools/acceptance/sheets-delivery.mjs check <record.json>');
    const record = JSON.parse(fs.readFileSync(file, 'utf8')),
      problems = validateSheetsRecord(record),
      {effectiveProviderContract} = await import(pathToFileURL(path.join(root, 'dist/src/provider-contracts.js')).href),
      contract = effectiveProviderContract('sheets'),
      outcome = problems.length ? 'invalid' : sheetsOutcome(record),
      ledger_rows = problems.length ? [] : sheetsLedgerRows(record, contract);
    console.log(JSON.stringify({valid: !problems.length, problems, outcome, ledger_rows: ledger_rows.length}, null, 2));
    const out = argv.indexOf('--out');
    if (out > 0 && argv[out + 1] && ledger_rows.length)
      fs.writeFileSync(
        argv[out + 1],
        JSON.stringify({record_kind: 'acceptance_sheets_run', outcome, ledger_rows}, null, 2) + '\n',
      );
    if (problems.length) process.exitCode = 1;
    return;
  }
  throw Error(
    'Usage: node tools/acceptance/sheets-delivery.mjs template | synthetic | check <record.json> [--out <file>]',
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch(e => {
    console.error(e.message);
    process.exitCode = 1;
  });
