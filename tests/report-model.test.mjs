// DOC-01: tools/report.ts typed some of its numbers by hand and classified workflows on its own. Reddit claimed a
// literal 8 reviewed mutations of 2 actions, .mirror/PARITY.md said "12 reviewed Search mutation routes" while the JSON
// computed Microsoft's count, and "Unfinished workflows" listed nine operations the action ledger classifies as
// implemented local workflows while missing one it counts as unmapped. The report now takes every number from the code
// and the ledger (tools/report-model.ts), and PARITY renders the JSON's values.
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertExtensions, ledgerCount, parityMarkdown, unfinishedWorkflows} from '../dist/tools/report-model.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {Registry} from '../dist/src/catalog.js';
import {microsoftActions, microsoftGateway} from '../dist/src/microsoft-native.js';

const registry = new Registry(),
  contracts = actionContracts(registry),
  delegated = gateway => registry.tools.get(gateway)?.mode === 'delegated';

test('the unfinished workflows are the delegated operations with an unmapped ledger action, never an implemented one', () => {
  const gaps = unfinishedWorkflows(contracts, delegated),
    listed = new Set(gaps.map(g => g.gateway + '/' + g.operation));
  // Independently of the model: group the ledger's delegated rows by operation.
  const operations = new Map();
  for (const c of contracts)
    if (c.operation && delegated(c.gateway))
      operations.set(c.gateway + '/' + c.operation, [...(operations.get(c.gateway + '/' + c.operation) ?? []), c]);
  for (const [key, rows] of operations) {
    const unmapped = rows.filter(r => r.status === 'unmapped').map(r => r.action);
    assert.equal(listed.has(key), unmapped.length > 0, key);
    // The regression: an operation whose every action is implemented was listed as unfinished.
    if (rows.every(r => r.status === 'local_workflow')) assert.ok(!listed.has(key), key);
  }
  for (const g of gaps) {
    assert.ok(g.unmapped_actions.length > 0 && g.unmapped_actions.length <= g.actions, g.operation);
    assert.match(g.reason, /action ledger: unmapped/);
  }
  assert.deepEqual(
    gaps.map(g => g.gateway + '/' + g.operation),
    [...listed].sort((a, b) => a.split('/')[0].localeCompare(b.split('/')[0]) || a.localeCompare(b)),
  );
});

test('the model lists exactly the operations with an unmapped action, sorted, and counts partial ones', () => {
  const row = (gateway, operation, action, status) => ({gateway, operation, action, status});
  const gaps = unfinishedWorkflows(
    [
      row('b_native_action', 'ops', 'READ', 'native_read'),
      row('b_native_action', 'ops', 'SEND', 'unmapped'),
      row('a_native_action', 'jobs', 'RUN', 'unmapped'),
      row('a_native_action', 'local', 'LIST', 'local_workflow'),
      row('direct_native_action', 'x', 'GET', 'unmapped'),
    ],
    gateway => gateway !== 'direct_native_action',
  );
  assert.deepEqual(
    gaps.map(g => [g.gateway, g.operation, g.unmapped_actions, g.actions]),
    [
      ['a_native_action', 'jobs', ['RUN'], 1],
      ['b_native_action', 'ops', ['SEND'], 2],
    ],
  );
  assert.match(gaps[1].reason, /1 of its 2 actions/);
});

test('an extension cannot claim more reviewed mutations than actions, and the counts come from the ledger', () => {
  const extension = (actions, reviewed) => ({
    gateway: 'reddit_native_action',
    actions,
    reviewed_mutation_actions: reviewed,
    write_scope: 'Synthetic',
    live_qualified: false,
  });
  // The report's former Reddit entry.
  assert.throws(
    () => assertExtensions([extension(2, 8)]),
    /reddit_native_action claims 8 reviewed mutation actions of 2 actions/,
  );
  assert.doesNotThrow(() => assertExtensions([extension(55, 13)]));
  const reddit = ledgerCount(contracts, 'reddit_native_action'),
    reviewed = ledgerCount(contracts, 'reddit_native_action', 'reviewed_write_family');
  assert.ok(reviewed > 0 && reviewed <= reddit);
  // The JSON's Microsoft count (from the action list) is the ledger's, which PARITY renders.
  assert.equal(
    ledgerCount(contracts, microsoftGateway, 'reviewed_write_family'),
    microsoftActions.filter(a => !a.read_only).length,
  );
});

test("PARITY renders the report's own values: Microsoft's mutations, the legacy total and the workflow gaps", () => {
  const extensions = [
    {
      gateway: 'microsoft_ads_native_action',
      actions: 31,
      reviewed_mutation_actions: 16,
      write_scope: 'x',
      live_qualified: false,
    },
  ];
  const text = parityMarkdown({
    gateways: [
      {
        gateway: 'x_ads_native_action',
        catalog_records: 3,
        known_denominator: 3,
        captured_http_routes: 3,
        vendor_documented_routes: 0,
      },
    ],
    legacyAdapters: 285,
    extensions,
    guidanceResources: 13,
    workflowGaps: [
      {gateway: 'a_native_action', operation: 'jobs', reason: 'r', unmapped_actions: ['RUN'], actions: 1},
      {gateway: 'b_native_action', operation: 'ops', reason: 'r', unmapped_actions: ['SEND'], actions: 2},
    ],
    limitations: ['Synthetic limit.'],
  });
  assert.match(text, /Microsoft Advertising: 31 actions, including 16 reviewed mutation actions\./);
  assert.doesNotMatch(text, /12 reviewed Search mutation routes/);
  assert.match(text, /Google has 285 independently specified legacy adapters\./);
  assert.match(text, /- a_native_action\/jobs\n- b_native_action\/ops \(1 of 2 actions\)\n/);
  assert.match(text, /\| x_ads_native_action \| 3 \| 3 \| 0 \| No \|/);
  assert.throws(
    () =>
      parityMarkdown({
        gateways: [],
        legacyAdapters: 0,
        extensions: [],
        guidanceResources: 0,
        workflowGaps: [],
        limitations: [],
      }),
    /no Microsoft Advertising extension/,
  );
});
