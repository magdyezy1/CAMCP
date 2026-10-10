// OPS-08 measured scaling: the global due-schedule query that replaced one query per workspace on every worker cycle.
// Synthetic in-memory stores only; no provider request, credential or production database is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {dueScheduleTenants, dueSchedules, dueTenantSQL} from '../dist/src/scheduled-work.js';

const key = Buffer.alloc(32, 63).toString('base64'),
  kinds = ['reporting_schedule', 'overview_schedule'];

test('the global due query names exactly the workspaces a per-workspace scan selects from, in workspace order', () => {
  const store = new Store(':memory:', key),
    at = 1791000000000;
  try {
    store.transaction(() => {
      for (let t = 0; t < 300; t++) store.ensureTenant('w-' + String(t).padStart(3, '0'));
      const put = (tenant, kind, id, data) => store.putDocument(tenant, kind, id, data);
      // Due, in two workspaces listed out of order.
      put('w-250', 'reporting_schedule', 's1', {is_active: true, next_run_at: at - 1});
      put('w-007', 'reporting_schedule', 's1', {is_active: 1, next_run_at: at});
      // Legacy declarations the exact predicate still treats as due.
      put('w-100', 'overview_schedule', 's1', {is_active: 'yes', next_run_at: String(at - 5)});
      // Not due: inactive, in the future, falsy legacy values, another kind.
      put('w-001', 'reporting_schedule', 's1', {is_active: false, next_run_at: at - 1});
      put('w-002', 'reporting_schedule', 's1', {is_active: true, next_run_at: at + 1});
      put('w-003', 'reporting_schedule', 's1', {is_active: '', next_run_at: at - 1});
      put('w-004', 'reporting_schedule', 's1', {is_active: 0, next_run_at: at - 1});
      put('w-005', 'unrelated', 's1', {is_active: true, next_run_at: 0});
      // A document of a workspace that no longer exists is never named (listTenants parity).
      store.db
        .prepare("INSERT INTO documents(tenant_id,kind,id,data) VALUES('gone','reporting_schedule','s1',?)")
        .run(JSON.stringify({is_active: true, next_run_at: at - 1}));
    });
    for (const kind of kinds) {
      const scanned = store.listTenants().filter(tenant => dueSchedules(store, tenant, kind, at).length);
      assert.deepEqual(dueScheduleTenants(store, kind, at), scanned, kind);
      const plan = store.db
        .prepare('EXPLAIN QUERY PLAN ' + dueTenantSQL[kind])
        .all(at)
        .map(row => row.detail)
        .join('\n');
      assert.match(plan, new RegExp('USING (COVERING )?INDEX ' + kind + '_due_global'), plan);
      assert.doesNotMatch(plan, /SCAN documents\b(?! USING)/, plan);
    }
    assert.deepEqual(dueScheduleTenants(store, 'reporting_schedule', at), ['w-007', 'w-250']);
    assert.deepEqual(dueScheduleTenants(store, 'overview_schedule', at), ['w-100']);
    assert.deepEqual(dueScheduleTenants(store, 'reporting_schedule', at - 1), ['w-250']);
  } finally {
    store.close();
  }
});

test('the per-workspace selection keeps its own index beside the global one', () => {
  const store = new Store(':memory:', key);
  try {
    for (const kind of kinds)
      assert.match(
        store.db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT id FROM documents WHERE tenant_id=? AND kind='" +
              kind +
              "' AND json_extract(data,'$.is_active') IS NOT NULL AND json_extract(data,'$.is_active')<>0 AND json_extract(data,'$.is_active')<>'' AND coalesce(CAST(json_extract(data,'$.next_run_at') AS REAL),0)<=? ORDER BY id",
          )
          .all('w', 1)
          .map(row => row.detail)
          .join('\n'),
        new RegExp('USING INDEX ' + kind + '_due \\('),
      );
  } finally {
    store.close();
  }
});
