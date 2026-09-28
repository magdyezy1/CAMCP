import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {sha256, stable} from '../dist/src/security.js';

const actor = {tenantId: 'audit-minimization', userId: 'operator', role: 'reader'};
const connection = {
  id: '00000000-0000-4000-8000-000000000001',
  tenantId: actor.tenantId,
  gateway: 'reddit_native_action',
  accounts: ['a2_111'],
  enabled: true,
  label: 'test',
  scopes: ['adsread'],
  userAgent: 'server:amcp-mirror-test:0.1.0 (local mock)',
};
const rows = [
  {id: '111', name: 'Lead form for jane.doe@example.test'},
  {id: '222', name: 'Second campaign'},
];

test('a completed read is audited by size, hash and row counts, without the provider content', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 11).toString('base64'));
  try {
    store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
    const service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(
        async () => new Response(JSON.stringify({data: rows, pagination: {}})),
        async () => {},
      ),
    );
    const r = await service.call(
      'reddit_native_action',
      {operation: 'reddit_campaign_ops', arguments: {action: 'FETCH_CAMPAIGNS', account_id: 'a2_111'}},
      actor,
    );
    assert.equal(r.success, true, JSON.stringify(r.error));
    // The caller still receives everything the provider returned.
    assert.ok(JSON.stringify(r.data).includes('jane.doe@example.test'));
    const trail = JSON.stringify(store.audit(actor.tenantId));
    assert.ok(!trail.includes('jane.doe@example.test'), 'provider content stays out of the audit trail');
    assert.ok(!trail.includes('Second campaign'));
    const done = store
      .audit(actor.tenantId)
      .map(row => JSON.parse(row.event))
      .find(e => e.event === 'request_completed');
    const returned = r.data.data ?? r.data;
    assert.equal(done.outcome.data, undefined);
    assert.equal(done.outcome.success, true);
    assert.equal(done.outcome.data_summary.content_retained, false);
    assert.equal(done.outcome.data_summary.sha256, sha256(stable(returned)));
    assert.ok(done.outcome.data_summary.bytes > 0);
    assert.deepEqual(done.outcome.data_summary.rows ?? done.outcome.data_summary.arrays?.data, 2);
    // The chain still verifies.
    store.verifyAudit();
  } finally {
    store.close();
  }
});
