// ACC-03: live Sheets delivery had only synthetic evidence. The owner runs the steps on a disposable AMCP-created
// spreadsheet; the harness validates the evidence record (owner label, references and counts only), accepts it only when
// typed cells, the marker, a replay that wrote nothing, three scheduled deliveries, the deselection and revocation
// refusals and the request counts all passed and the owner confirmed the tabs, and only then yields ledger rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {effectiveProviderContract} from '../dist/src/provider-contracts.js';
import {appendRows} from '../tools/acceptance/ledger.mjs';
import {
  sheetsLedgerRows,
  sheetsOutcome,
  sheetsSteps,
  sheetsTemplate,
  syntheticSuites,
  validateSheetsRecord,
} from '../tools/acceptance/sheets-delivery.mjs';
import {removeTestPath} from '../dist/tests/temp.js';

const receipt = n => 'sheets-delivery/' + n;
const filled = () => ({
  ...sheetsTemplate(),
  authorization_ref: 'owner-auth-2026-10-21-sheets',
  release: {revision: '52190e9', package_sha256: 'd'.repeat(64)},
  checked_at: '2026-10-21T09:00:00Z',
  spreadsheet_label: 'sheets-disposable-a',
  quota_reference: {
    requests_per_minute_per_user: 60,
    checked_on: '2026-10-21',
    source: 'Google Sheets API usage limits',
  },
  steps: {
    create_bind: {result: 'pass', created_by_amcp: true, scope: 'drive.file', evidence_ref: 'activity/sheet-created'},
    export: {result: 'pass', evidence_ref: receipt(1), write_requests: 1, read_requests: 3, elapsed_ms: 2400},
    typed_cells: {
      result: 'pass',
      formula_text_stays_text: true,
      numbers_are_number_cells: true,
      marker_matches_fingerprint: true,
      marker_sha256: 'e'.repeat(64),
    },
    replay: {result: 'pass', writes: 0, evidence_ref: receipt(2)},
    schedule: {
      result: 'pass',
      occurrences: [3, 4, 5].map(n => ({
        evidence_ref: receipt(n),
        delivered: true,
        write_requests: 1,
        elapsed_ms: 2100,
      })),
    },
    deselect: {result: 'pass', refusal_code: 'FORBIDDEN', evidence_ref: 'c75cc43f-7be5-4a56-93ec-37b0273cb0fd'},
    revoke: {result: 'pass', refusal_code: 'REAUTHORIZATION_REQUIRED', evidence_ref: 'activity/reauthorization'},
    request_counts: {result: 'pass', max_requests_in_a_minute: 6},
    forced_timeout: {result: 'skipped', reason: 'Lost-response drills stay local; the settle rule is covered there.'},
  },
  manual: {tab_content_confirmed: true, other_tabs_untouched: true, file_deleted_after: true},
});

test('the blank record lists every step not run and accepts nothing', () => {
  const template = sheetsTemplate();
  assert.deepEqual(Object.keys(template.steps), sheetsSteps);
  assert.ok(Object.values(template.steps).every(s => s.result === 'not_run'));
  assert.ok(validateSheetsRecord(template).length > 0);
  assert.equal(sheetsOutcome(template), 'inconclusive');
  assert.deepEqual(sheetsLedgerRows(template, effectiveProviderContract('sheets')), []);
  for (const suite of syntheticSuites) assert.ok(fs.existsSync(suite), suite);
});

test('an accepted run yields ledger rows for the export and the schedule, by reference, that the ledger takes', async () => {
  const record = filled();
  assert.deepEqual(validateSheetsRecord(record), []);
  assert.equal(sheetsOutcome(record), 'accepted');
  const rows = sheetsLedgerRows(record, effectiveProviderContract('sheets'));
  assert.deepEqual(
    rows.map(r => [r.gateway, r.action, r.environment, r.account_type, r.scope.account_label]),
    [
      ['google_sheets_native_action', 'amcp_sheets_export', 'deployed', 'real', 'sheets-disposable-a'],
      ['google_sheets_native_action', 'amcp_sheets_scheduled_delivery', 'deployed', 'real', 'sheets-disposable-a'],
    ],
  );
  const added = await appendRows({schema_version: 1, rows: []}, rows);
  assert.deepEqual(added.problems, []);
});

test('the record refuses IDs, client files and every unproven step; failures and open confirmations accept nothing', () => {
  const cases = [
    [
      'a spreadsheet URL',
      r => (r.steps.export.note = 'https://docs.google.com/spreadsheets/d/x'),
      /spreadsheet ID, URL/,
    ],
    [
      'a file ID',
      r => (r.steps.export.evidence_ref = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'),
      /spreadsheet ID/,
    ],
    ['an ID as label', r => (r.spreadsheet_label = 'sheet-1234567'), /owner label/],
    ['a client file', r => (r.steps.create_bind.created_by_amcp = false), /disposable spreadsheet AMCP created/],
    ['a replay that wrote', r => (r.steps.replay.writes = 1), /wrote nothing/],
    ['two occurrences', r => r.steps.schedule.occurrences.pop(), /three delivered/],
    ['an undelivered occurrence', r => (r.steps.schedule.occurrences[1].delivered = false), /three delivered/],
    ['the wrong revocation answer', r => (r.steps.revoke.refusal_code = 'AUTH_EXPIRED'), /REAUTHORIZATION_REQUIRED/],
    ['no deselection refusal', r => (r.steps.deselect.refusal_code = null), /refused the deselected/],
    ['a formula that ran', r => (r.steps.typed_cells.formula_text_stays_text = false), /stayed text/],
    ['above the quota', r => (r.steps.request_counts.max_requests_in_a_minute = 61), /within the per-user/],
    ['no quota reference', r => (r.quota_reference.checked_on = null), /quota_reference/],
    ['a skipped export', r => (r.steps.export.result = 'skipped'), /only the forced-timeout drill/],
    ['a drill skipped without reason', r => (r.steps.forced_timeout.reason = ''), /records why/],
    ['a local run', r => (r.environment = 'native'), /deployed/],
    ['no authorization', r => (r.authorization_ref = ''), /authorization_ref/],
  ];
  for (const [label, change, pattern] of cases) {
    const record = filled();
    change(record);
    assert.ok(
      validateSheetsRecord(record).some(p => pattern.test(p)),
      label + ': ' + validateSheetsRecord(record).join('; '),
    );
  }
  const failed = filled();
  Object.assign(failed.steps.typed_cells, {result: 'fail', note: 'A metric arrived as text.'});
  assert.deepEqual(validateSheetsRecord(failed), []);
  assert.equal(sheetsOutcome(failed), 'refused');
  assert.deepEqual(sheetsLedgerRows(failed, effectiveProviderContract('sheets')), []);
  const open = filled();
  open.manual.other_tabs_untouched = null;
  assert.equal(sheetsOutcome(open), 'inconclusive');
  assert.deepEqual(sheetsLedgerRows(open, effectiveProviderContract('sheets')), []);
});

test('the check command writes ledger rows only for an accepted record, and fails an invalid one', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acc03-'));
  t.after(() => removeTestPath(directory));
  const run = (record, name) => {
    const file = path.join(directory, name + '.json'),
      out = path.join(directory, name + '-rows.json');
    fs.writeFileSync(file, JSON.stringify(record));
    const result = spawnSync(process.execPath, ['tools/acceptance/sheets-delivery.mjs', 'check', file, '--out', out], {
      encoding: 'utf8',
    });
    return {result, out};
  };
  const accepted = run(filled(), 'accepted');
  assert.equal(accepted.result.status, 0, accepted.result.stderr);
  assert.equal(JSON.parse(accepted.result.stdout).outcome, 'accepted');
  assert.equal(JSON.parse(fs.readFileSync(accepted.out, 'utf8')).ledger_rows.length, 2);
  const invalid = filled();
  invalid.steps.replay.writes = 2;
  const refused = run(invalid, 'invalid');
  assert.equal(refused.result.status, 1);
  assert.equal(fs.existsSync(refused.out), false);
});
