// B13 (DOC-02): the Operations feed silently withheld workbook runs and schedules whose retained scope cannot be
// established, so nobody could tell whether the path-only and opaque-format adapters were needed. Owner health now
// counts them by bounded reason, without identifiers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {Registry} from '../dist/src/catalog.js';
import {withheldWorkbookRecords} from '../dist/src/owner-operations.js';

const owner = {tenantId: 'withheld-workbooks', userId: 'owner', role: 'admin'},
  connection = '33333333-3333-4333-8333-333333333333',
  gateway = 'x_ads_native_action';
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 97).toString('base64'));
  store.putConnection(
    owner,
    {
      id: connection,
      tenantId: owner.tenantId,
      gateway,
      accounts: ['100'],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  return store;
}
const config = args => ({gateway, arguments: {action: 'retained-synthetic-read', ...args}});
const valid = config({account_id: '100', connection_id: connection}),
  pathOnly = config({path: '/12/stats/accounts/100', connection_id: connection}),
  opaque = config({account_id: '100', connection_id: connection, payload: '{"DO-NOT-PROJECT":'}),
  departed = config({account_id: '999', connection_id: connection});

test('owner health counts withheld workbook runs and schedules by reason and exposes no identifiers', async () => {
  const store = fixture();
  try {
    const runs = [valid, pathOnly, opaque, departed].map(c =>
      store.enqueueReport(owner, {query_name: 'Synthetic run', query_config: c}, Number.MAX_SAFE_INTEGER),
    );
    const book = '44444444-4444-4444-8444-444444444444';
    store.putDocument(owner.tenantId, 'workbook', book, {spreadsheet_id: 'synthetic-book', created_by: owner.userId});
    const queries = {
      '55555555-5555-4555-8555-555555555551': valid,
      '55555555-5555-4555-8555-555555555552': pathOnly,
    };
    for (const [id, query_config] of Object.entries(queries))
      store.putDocument(owner.tenantId, 'reporting_query', id, {name: 'Q', workbook_binding_id: book, query_config});
    for (const [index, query_id] of Object.keys(queries).entries())
      store.putDocument(owner.tenantId, 'reporting_schedule', '66666666-6666-4666-8666-66666666666' + index, {
        name: 'S',
        workbook_binding_id: book,
        is_active: false,
        schedule_config: {query_id},
      });
    const service = new MirrorService(new Registry(), store),
      health = await service.call('amcp_workspace', {action: 'health'}, owner);
    assert.equal(health.success, true, JSON.stringify(health).slice(0, 500));
    const counted = health.data.withheld_workbook_records;
    assert.deepEqual(counted.runs, {
      checked: 4,
      truncated: false,
      withheld: 3,
      reasons: {scope_unavailable: 2, connection_unavailable: 1, metadata_unreadable: 0},
    });
    assert.deepEqual(counted.schedules, {
      checked: 2,
      truncated: false,
      withheld: 1,
      reasons: {scope_unavailable: 1, connection_unavailable: 0, metadata_unreadable: 0},
    });
    const text = JSON.stringify(counted);
    for (const secret of [...runs, ...Object.keys(queries), connection, book, '/12/stats', 'DO-NOT-PROJECT', '999'])
      assert.equal(text.includes(secret), false, secret);
    // Only valid records: nothing is withheld.
    const clean = fixture();
    try {
      clean.enqueueReport(owner, {query_config: valid}, Number.MAX_SAFE_INTEGER);
      assert.equal(withheldWorkbookRecords(clean, owner).runs.withheld, 0);
    } finally {
      clean.close();
    }
    // A reader never sees the owner's health.
    const reader = await service.call('amcp_workspace', {action: 'health'}, {...owner, userId: 'r', role: 'reader'});
    assert.equal(reader.success, false);
  } finally {
    store.close();
  }
});
