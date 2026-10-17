import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {DecisionReporting, decisionTool} from '../dist/src/decision-reporting.js';
import {actionHandler} from '../dist/src/tool-actions.js';

// ARC-04 stage D: a composite tool's actions are entries of action tables (src/tool-actions.ts) instead of branches of
// an if-chain; amcp_reporting (DecisionReporting.handle, 899 lines before) is the first. These tests hold what the
// if-chain decided by its order: which checks run before which actions, and that only a listed action runs.
const actor = {tenantId: 'tool-actions', userId: 'owner', role: 'admin'};
const report = {
  gateway: 'google_ads_native_action',
  account_id: '100',
  connection_id: 'login',
  source: 'provider_read',
  captured_at: Date.now(),
  source_hash: 'a'.repeat(64),
  semantics: {currency: 'USD', timezone: 'UTC', date_from: '2026-09-01', date_to: '2026-09-02', complete: true},
  mapping: {spend: '/metrics/costMicros', entity_name: '/campaign/name'},
  totals: {spend: '10', clicks: null, conversions: null, impressions: null, conversion_value: null},
  rows: [
    {entity_id: '1', entity_name: 'Spring', date: '2026-09-01', spend: '4'},
    {entity_id: '2', entity_name: 'Autumn', date: '2026-09-01', spend: '6'},
  ],
};
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64'));
  store.putConnection(
    actor,
    {
      id: 'login',
      tenantId: actor.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  store.putDocument(actor.tenantId, 'decision_report', 'kept', report);
  const service = new DecisionReporting(store, async () => {
    throw Error('These checks make no provider read');
  });
  return {store, service, run: input => service.handle(input, actor)};
}

test('an action table answers only its own entries: an inherited name or a non-string is no action', () => {
  const table = {list: () => ({listed: true})};
  assert.equal(actionHandler(table, 'list'), table.list);
  for (const action of [
    'constructor',
    'toString',
    '__proto__',
    'hasOwnProperty',
    'valueOf',
    undefined,
    null,
    1,
    ['list'],
  ])
    assert.equal(actionHandler(table, action), undefined, String(action));
});

test('every amcp_reporting action has one table entry, in the stage whose checks the if-chain ran before it', () => {
  const f = fixture();
  try {
    const stages = {
      unpaged: f.service.unpagedActions,
      paged: f.service.pagedActions,
      report: f.service.reportActions,
    };
    const placed = Object.entries(stages).flatMap(([stage, table]) =>
      Object.keys(table).map(action => [action, stage]),
    );
    assert.deepEqual(
      placed.map(([action]) => action).sort(),
      [...decisionTool.inputSchema.properties.action.enum].sort(),
    );
    assert.equal(new Set(placed.map(([action]) => action)).size, placed.length);
    // Before the page bounds; after them; after the read of the report the call names.
    assert.deepEqual(Object.fromEntries(placed), {
      capture_presets: 'unpaged',
      serving_diagnostics: 'unpaged',
      launch_check: 'unpaged',
      capture_preset: 'unpaged',
      list: 'paged',
      get: 'paged',
      overview_sources: 'paged',
      capture_overview: 'paged',
      capture: 'paged',
      allocation_outcome: 'paged',
      capture_allocation_outcome: 'paged',
      scenarios: 'report',
      allocation_candidates: 'report',
      calibrate_allocation: 'report',
      allocation: 'report',
      preview_allocation_plan: 'report',
      create_allocation_plan: 'report',
      search_exclusion_candidates: 'report',
      preview_search_exclusions: 'report',
      create_search_exclusion_plan: 'report',
      reconcile_report: 'report',
      reconcile: 'report',
      combine: 'report',
      analyze: 'report',
    });
  } finally {
    f.store.close?.();
  }
});

test('the page bounds apply from list on: capture_presets ignores them, list and get refuse them before any read', async () => {
  const f = fixture();
  try {
    assert.ok(Array.isArray((await f.run({action: 'capture_presets', limit: 1000})).presets));
    for (const input of [
      {action: 'list', limit: 1000},
      {action: 'get', id: 'missing', offset: -1},
    ])
      await assert.rejects(f.run(input), e => e.message === 'Invalid report pagination.', input.action);
  } finally {
    f.store.close?.();
  }
});

test('get pages the retained rows through the paged table: row search, bounds and the access check', async () => {
  const f = fixture();
  try {
    const page = await f.run({action: 'get', id: 'kept', row_query: 'autumn', limit: 1});
    assert.deepEqual(
      [page.row_count, page.matched_row_count, page.rows.map(r => r.entity_id), page.has_more],
      [2, 1, ['2'], false],
    );
    assert.equal(page.xlsx_path, '/api/reporting-evidence/kept.xlsx');
    // The report's connection is checked for this caller before its rows are shown: retained evidence of a login that
    // is gone is not shown.
    f.store.putDocument(actor.tenantId, 'decision_report', 'orphan', {...report, connection_id: 'gone'});
    await assert.rejects(f.run({action: 'get', id: 'orphan'}), e => typeof e.code === 'string' && e.status >= 400);
  } finally {
    f.store.close?.();
  }
});

test('an unknown or inherited action reads the report it names first, then is refused as unknown; nothing else runs', async () => {
  const f = fixture();
  try {
    for (const action of ['nope', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      await assert.rejects(f.run({action, id: 'missing'}), e => e.code === 'NOT_FOUND', action);
      await assert.rejects(f.run({action, id: 'kept'}), e => e.message === 'Unknown reporting action.', action);
    }
  } finally {
    f.store.close?.();
  }
});
