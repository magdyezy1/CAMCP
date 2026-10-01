import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../dist/src/store.js';
import {reportQuerySQL} from '../dist/src/report-query-access.js';
import {workbookBindingPage} from '../dist/src/workbook-bindings.js';
import {removeTestDirectory} from '../dist/tests/temp.js';
import {createEncryptedBackup, restoreEncryptedBackup} from '../dist/src/backup.js';
const key = Buffer.alloc(32, 96).toString('base64'),
  actor = {tenantId: 'index-workspace', userId: 'member', role: 'operator'};
function seed(store) {
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: 'meta',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  store.putDocument(actor.tenantId, 'workbook', 'original-book', {
    spreadsheet_id: 'SHEET-001',
    spreadsheet_name: 'Retained name',
    created_by: actor.userId,
  });
  store.putDocument(actor.tenantId, 'reporting_query', 'original-query', {
    name: 'Retained query',
    workbook_binding_id: 'original-book',
    query_config: {
      platform: 'meta',
      connection_id: 'meta',
      account_id: '100',
      date_range: {since: '2026-09-01', until: '2026-09-07'},
    },
  });
  store.appendAudit(actor.tenantId, 'fixture', {event: 'original_checkpoint'});
}
const plan = store =>
  store.db
    .prepare(
      'EXPLAIN QUERY PLAN ' +
        reportQuerySQL +
        " AND json_extract(q.data,'$.workbook_binding_id')=? ORDER BY q.id LIMIT 501",
    )
    .all(actor.tenantId, 'original-book')
    .map(r => r.detail)
    .join('\n');
test('workbook membership uses an exact tenant/expression lookup with identical authorized output without the index', () => {
  const store = new Store(':memory:', key);
  try {
    seed(store);
    assert.match(plan(store), /reporting_query_workbook.*tenant_id=\?.*<expr>=\?/);
    const indexed = workbookBindingPage(store, actor, {limit: 20});
    store.db.exec('DROP INDEX reporting_query_workbook');
    assert.deepEqual(workbookBindingPage(store, actor, {limit: 20}), indexed);
    assert.doesNotMatch(plan(store), /reporting_query_workbook/);
  } finally {
    store.close();
  }
});
test('an existing schema-2 database receives the additive index without rewriting records, revisions or audit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-report-index-')),
    file = path.join(dir, 'legacy.sqlite');
  let store = new Store(file, key);
  try {
    seed(store);
    const before = store.db
      .prepare('SELECT tenant_id,kind,id,data,revision FROM documents ORDER BY tenant_id,kind,id')
      .all();
    const audit = store.db.prepare('SELECT * FROM audit ORDER BY seq').all();
    store.db.exec('DROP INDEX IF EXISTS reporting_query_workbook');
    store.close();
    store = new Store(file, key);
    assert.match(plan(store), /reporting_query_workbook/);
    assert.equal(store.db.prepare('SELECT version FROM schema_version').get().version, 2);
    assert.deepEqual(
      store.db.prepare('SELECT tenant_id,kind,id,data,revision FROM documents ORDER BY tenant_id,kind,id').all(),
      before,
    );
    assert.deepEqual(store.db.prepare('SELECT * FROM audit ORDER BY seq').all(), audit);
    assert.equal(store.verifyAudit(), true);
    store.close();
    store = new Store(file, key);
    assert.match(plan(store), /reporting_query_workbook/);
  } finally {
    store.close();
    removeTestDirectory(dir, 'amcp-report-index-');
  }
});
test('encrypted backup/restore retains indexed membership and current source authorization', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-report-index-')),
    source = path.join(dir, 'source.amcp'),
    target = path.join(dir, 'restored.sqlite');
  const store = new Store(':memory:', key);
  let restored;
  try {
    seed(store);
    const before = workbookBindingPage(store, actor, {limit: 20});
    await createEncryptedBackup(store, source, key);
    await restoreEncryptedBackup(source, target, key);
    restored = new Store(target, key);
    assert.match(plan(restored), /reporting_query_workbook/);
    assert.deepEqual(workbookBindingPage(restored, actor, {limit: 20}), before);
    const connection = restored.resolveConnection(actor, 'meta_native_action', '100', 'meta');
    restored.putConnection({...actor, role: 'admin'}, {...connection, enabled: false}, {accessToken: 'synthetic'});
    assert.equal(workbookBindingPage(restored, actor, {limit: 20}).bindings.length, 0);
    assert.equal(restored.verifyAudit(), true);
  } finally {
    restored?.close();
    store.close();
    removeTestDirectory(dir, 'amcp-report-index-');
  }
});
