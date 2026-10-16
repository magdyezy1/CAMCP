// ACC-05 (R07 live-qualification-unrepresentable): live_qualification was the literal 'unverified' on every one of the
// 3,247 action rows, with no place to record that a contract at a version was accepted live, nor to invalidate that
// after a change. The ledger records owner-authorized acceptance by reference only; a row applies only to the exact
// contract digest and version it ran under, and an action without one stays unverified.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {
  acceptanceLayers,
  acceptanceRows,
  contractAcceptance,
  ledgerProblems,
  liveQualification,
  validateAcceptanceLedger,
} from '../dist/src/acceptance-ledger.js';
import {actionContractPage, actionContracts} from '../dist/src/action-contracts.js';
import {effectiveProviderContract} from '../dist/src/provider-contracts.js';
import {Registry} from '../dist/src/catalog.js';
import {appendRows} from '../tools/acceptance/ledger.mjs';

const google = effectiveProviderContract('google'),
  action = {gateway: 'google_ads_native_action', action: 'google_ads_v23_google_ads_mutate'};
const row = (patch = {}) => ({
  id: 'acc-01-google-test-1',
  ticket: 'ACC-01',
  ...action,
  family: 'google_entities',
  effect: 'mutation',
  contract_digest: google.contract_digest,
  api_version: google.api_version,
  account_type: 'test',
  environment: 'native',
  scope: {account_label: 'google-test-a', accounts: 1},
  checked_at: '2026-10-20T10:00:00Z',
  release: {revision: '40ed7a5', package_sha256: 'a'.repeat(64)},
  authorization_ref: 'owner-auth-2026-10-20-1',
  evidence: {review_id: 'review-1', receipt_refs: ['receipt-1'], readback_sha256: 'b'.repeat(64)},
  outcome: 'accepted',
  ...patch,
});
const ledger = rows => ({schema_version: 1, rows});

test('the committed ledger validates, and every action row without a ledger row stays unverified', () => {
  const committed = JSON.parse(fs.readFileSync('src/acceptance-ledger.json', 'utf8'));
  assert.deepEqual(validateAcceptanceLedger(committed), []);
  assert.deepEqual(ledgerProblems, []);
  const rows = actionContracts(new Registry()),
    listed = new Set(acceptanceRows.map(r => [r.gateway, r.operation ?? '', r.action].join('/')));
  for (const r of rows)
    if (!listed.has([r.gateway, r.operation ?? '', r.action].join('/'))) {
      assert.equal(r.live_qualification, 'unverified');
      assert.equal(r.acceptance, undefined);
    }
});

test('the schema keeps references only, requires a scope and refuses unsupported claims', () => {
  assert.deepEqual(validateAcceptanceLedger(ledger([row()])), []);
  const cases = [
    ['a payload body', {payload: {name: 'x'}}, /unknown field payload/],
    ['a token in evidence', {evidence: {...row().evidence, access_token: 'x'}}, /unknown evidence field access_token/],
    ['no scope', {scope: undefined}, /scope is/],
    ['an account ID as the label', {scope: {account_label: '1234567890', accounts: 1}}, /never an account ID/],
    ['a label that embeds an ID', {scope: {account_label: 'acct-1234567', accounts: 1}}, /never an account ID/],
    ['a write without read-back', {evidence: {receipt_refs: ['r']}}, /cites its receipts and its read-back/],
    ['a write without receipts', {evidence: {readback_sha256: 'b'.repeat(64)}}, /cites its receipts/],
    ['a read without shape or status', {effect: 'read', evidence: {}}, /response-shape digest or status/],
    ['an unknown account type', {account_type: 'production'}, /account_type/],
    ['a gateway without a provider contract', {gateway: 'amcp_workspace'}, /provider gateway/],
    ['a malformed digest', {contract_digest: 'sha256:abc'}, /contract_digest/],
    ['a local time', {checked_at: '2026-10-20 10:00'}, /UTC timestamp/],
    ['a multi-line note', {note: 'a\nb'}, /one line/],
    ['an unknown outcome', {outcome: 'passed'}, /outcome/],
    ['no authorization', {authorization_ref: undefined}, /authorization/],
  ];
  for (const [label, patch, pattern] of cases) {
    const problems = validateAcceptanceLedger(ledger([row(patch)]));
    assert.ok(
      problems.some(p => pattern.test(p)),
      label + ': ' + problems.join('; '),
    );
  }
  assert.ok(validateAcceptanceLedger(ledger([row(), row()])).some(p => /recorded twice/.test(p)));
  assert.deepEqual(validateAcceptanceLedger({rows: []}), ['the ledger is {schema_version: 1, rows: [...]}']);
});

test('an accepted row applies only to the exact digest and version; any change makes it stale', () => {
  const current = {contract_digest: google.contract_digest, api_version: google.api_version};
  const accepted = contractAcceptance(action, [row()], current);
  assert.equal(accepted.status, 'write_accepted');
  assert.deepEqual(accepted.scope, {
    account_label: 'google-test-a',
    accounts: 1,
    account_type: 'test',
    environment: 'native',
  });
  assert.equal(accepted.checked_at, '2026-10-20T10:00:00Z');
  assert.equal(liveQualification(accepted), 'write_accepted');
  // The contract content changed after the run.
  const changed = contractAcceptance(action, [row()], {...current, contract_digest: 'sha256:' + 'c'.repeat(64)});
  assert.equal(changed.status, 'stale');
  assert.equal(changed.invalidated_by, 'contract_digest');
  assert.equal(liveQualification(changed), 'unverified');
  // The version AMCP sends changed after the run.
  const moved = contractAcceptance(action, [row()], {...current, api_version: 'v26'});
  assert.equal(moved.status, 'stale');
  assert.equal(moved.invalidated_by, 'api_version');
  // A read acceptance is a read acceptance; a write acceptance outranks it.
  const read = row({id: 'acc-06-read', effect: 'read', evidence: {shape_sha256: 'd'.repeat(64)}});
  assert.equal(contractAcceptance(action, [read], current).status, 'read_accepted');
  assert.equal(contractAcceptance(action, [read, row()], current).status, 'write_accepted');
  // A refusal is recorded as a refusal; an inconclusive run is no evidence either way.
  assert.equal(
    contractAcceptance(
      action,
      [row({id: 'acc-08-refused', outcome: 'refused', evidence: {status_codes: [403]}})],
      current,
    ).status,
    'refused',
  );
  assert.equal(
    contractAcceptance(action, [row({id: 'acc-x-inconclusive', outcome: 'inconclusive', evidence: {}})], current)
      .status,
    'unverified',
  );
  // Another action, operation or gateway is not covered by this row.
  for (const other of [
    {...action, action: 'google_ads_v23_campaign_mutate_campaigns'},
    {...action, operation: 'x'},
    {gateway: 'meta_native_action', action: action.action},
  ])
    assert.equal(contractAcceptance(other, [row()], current).status, 'unverified', JSON.stringify(other));
});

test('a newer refusal of the same contract outranks an older acceptance (regression: the oldest acceptance won)', () => {
  const current = {contract_digest: google.contract_digest, api_version: google.api_version},
    refused = (id, at) =>
      row({
        id,
        outcome: 'refused',
        checked_at: at,
        evidence: {status_codes: [403], provider_codes: ['PERMISSION_DENIED']},
      });
  // Accepted on 2026-10-20, refused on 2026-10-25 (the provider withdrew a permission): the contract is refused now.
  const withdrawn = contractAcceptance(
    action,
    [row(), refused('acc-01-google-refused', '2026-10-25T10:00:00Z')],
    current,
  );
  assert.equal(withdrawn.status, 'refused');
  assert.equal(withdrawn.ledger_row, 'acc-01-google-refused');
  assert.equal(liveQualification(withdrawn), 'unverified');
  // An acceptance after the refusal counts again.
  const restored = contractAcceptance(
    action,
    [
      row(),
      refused('acc-01-google-refused', '2026-10-25T10:00:00Z'),
      row({id: 'acc-01-google-again', checked_at: '2026-10-27T10:00:00Z'}),
    ],
    current,
  );
  assert.equal(restored.status, 'write_accepted');
  assert.equal(restored.ledger_row, 'acc-01-google-again');
  // A write accepted before the refusal never lifts a read accepted after it to write_accepted.
  const readAfter = contractAcceptance(
    action,
    [
      row(),
      refused('acc-01-google-refused', '2026-10-25T10:00:00Z'),
      row({
        id: 'acc-06-google-read',
        effect: 'read',
        checked_at: '2026-10-26T10:00:00Z',
        evidence: {shape_sha256: 'd'.repeat(64)},
      }),
    ],
    current,
  );
  assert.equal(readAfter.status, 'read_accepted');
  assert.equal(readAfter.ledger_row, 'acc-06-google-read');
  // An inconclusive run after a refusal is evidence of neither: the refusal stands.
  assert.equal(
    contractAcceptance(
      action,
      [
        refused('acc-01-google-refused', '2026-10-25T10:00:00Z'),
        row({id: 'acc-x-inconclusive', outcome: 'inconclusive', checked_at: '2026-10-26T10:00:00Z', evidence: {}}),
      ],
      current,
    ).status,
    'refused',
  );
});

test('the contracts page states acceptance per row and counts each evidence layer, with no network request', () => {
  const registry = new Registry(),
    page = actionContractPage(registry, {gateway: 'google_ads_native_action', limit: 5});
  assert.equal(page.network_requests, 0);
  assert.ok(page.actions.every(a => a.acceptance.status === 'unverified' && a.live_qualification === 'unverified'));
  const layers = page.acceptance_layers;
  assert.equal(layers.catalog, page.total);
  assert.ok(
    layers.catalog >= layers.pinned && layers.pinned >= layers.locally_qualified && layers.locally_qualified > 0,
  );
  assert.equal(layers.read_accepted + layers.write_accepted + layers.refused + layers.stale, 0);
  assert.match(page.acceptance_meaning, /never grants access/);
  // The layers count ledger statuses when they exist.
  const counted = acceptanceLayers([
    {status: 'reviewed_write_family', tests: ['t'], acceptance: {status: 'write_accepted'}},
    {status: 'native_read', tests: ['t'], acceptance: {status: 'read_accepted'}},
    {status: 'native_read', tests: ['t'], acceptance: {status: 'stale'}},
    {status: 'unmapped', tests: []},
  ]);
  assert.deepEqual(counted, {
    catalog: 4,
    pinned: 3,
    locally_qualified: 3,
    read_accepted: 1,
    write_accepted: 1,
    refused: 0,
    stale: 1,
  });
});

test('ledger.mjs validates the committed ledger and refuses a record whose rows break the schema, writing nothing', async () => {
  const check = spawnSync(process.execPath, ['tools/acceptance/ledger.mjs', '--check'], {encoding: 'utf8'});
  assert.equal(check.status, 0, check.stderr);
  const appended = await appendRows(ledger([]), [row()]);
  assert.deepEqual(appended.problems, []);
  assert.equal(appended.ledger.rows.length, 1);
  const refused = await appendRows(ledger([]), [row({payload: {secret: 'x'}})]);
  assert.equal(refused.ledger, undefined);
  assert.ok(refused.problems.some(p => /unknown field payload/.test(p)));
  assert.deepEqual((await appendRows(ledger([]), undefined)).problems, ['the record has no ledger_rows']);
});
