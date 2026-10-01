import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const actor = {tenantId: 'operations', userId: 'operator', role: 'operator'};
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 67).toString('base64'));
  const connection = {
    id: 'meta',
    tenantId: actor.tenantId,
    gateway: 'meta_native_action',
    accounts: ['100'],
    writeAccounts: ['100'],
    enabled: true,
    label: 'Synthetic',
    scopes: [],
  };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('Operations must never use the network');
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const source = {platform: 'meta', connection_id: 'meta', account_id: '100'};
  const put = (kind, id, value, tenant = actor.tenantId) => store.putDocument(tenant, kind, id, value);
  const call = (args = {}, as = actor) => service.call('amcp_workspace', {action: 'operations', ...args}, as);
  return {store, service, connection, source, put, call};
}
test('operations continues through every engine, keeps exact handoffs and never exposes source payloads', async () => {
  const f = fixture();
  try {
    const {put, source, store} = f;
    put('campaign_run', 'plan', {
      user_id: actor.userId,
      name: 'Launch',
      state: 'attention',
      updated_at: 900,
      steps: [{gateway: 'meta_native_action', ...source, arguments: {private: 'CANARY'}, status: 'uncertain'}],
    });
    put('media_review', 'upload', {
      user_id: actor.userId,
      plan: {...source, name: 'Film', source_url: 'https://private.invalid/CANARY'},
      created_at: 800,
      expires_at: Date.now() + 300000,
      state: {private: 'CANARY'},
    });
    store.claim(actor.tenantId, 'upload', 'hash');
    store.uncertain(actor.tenantId, 'upload');
    put('overview_report', 'report', {
      state: 'complete',
      created_at: 700,
      config: {name: 'Results', sources: [source]},
      rows: [{private: 'CANARY'}],
      checkpoints: {private: 'CANARY'},
      actor_binding: 'CANARY',
    });
    const job = store.enqueue(actor.tenantId, 'sheets_export', {
      report_id: 'report',
      export_id: 'export',
      private: 'CANARY',
    });
    store.db
      .prepare("UPDATE jobs SET state='failed',error=?,updated_at=600 WHERE id=?")
      .run(JSON.stringify({code: 'ACCESS_REQUIRED', message: 'CANARY'}), job);
    put('overview_export', 'export', {report_id: 'report', job_id: job, actor_binding: 'CANARY'});
    put('overview_schedule', 'schedule', {
      config: {name: 'Weekly report', sources: [source]},
      is_active: false,
      updated_at: 500,
      view_id: 'view',
    });
    put('report_incident', 'incident', {
      ...source,
      monitor_name: 'Spend ceiling',
      state: 'open',
      updated_at: 400,
      last_report_id: 'report',
    });
    // Force metadata-only reads: loading complete source documents is neither necessary nor safe for this feed.
    store.documents = () => {
      throw Error('Unbounded document load');
    };
    store.document = () => {
      throw Error('Full source document load');
    };
    const rows = [];
    let cursor;
    do {
      const r = await f.call({limit: 2, ...(cursor ? {cursor} : {})});
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(r.data.network_requests, 0);
      assert.equal(r.data.coverage.length, 8);
      assert.ok(r.data.operations.length <= 2);
      assert.doesNotMatch(JSON.stringify(r), /CANARY|source_url|actor_binding|checkpoints/);
      rows.push(...r.data.operations);
      cursor = r.data.next_cursor;
      assert.equal(r.data.has_more, Boolean(cursor));
    } while (cursor);
    assert.deepEqual(
      new Set(rows.map(r => r.kind)),
      new Set(['campaign', 'upload', 'report', 'export', 'schedule', 'incident']),
    );
    assert.equal(new Set(rows.map(r => r.key)).size, 6);
    const upload = rows.find(r => r.id === 'upload');
    assert.equal(upload.state, 'uncertain');
    assert.equal(upload.automatic_retry_of_mutation, false);
    assert.deepEqual(upload.next_call, {tool: 'amcp_media', arguments: {action: 'recovery', review_id: 'upload'}});
    assert.equal(upload.website_path, '/media?review_id=upload');
    const delivery = rows.find(r => r.kind === 'export');
    assert.equal(delivery.state, 'failed');
    assert.equal(delivery.error_code, 'ACCESS_REQUIRED');
    assert.deepEqual(delivery.next_call, {
      tool: 'amcp_reporting_overview',
      arguments: {action: 'export_status', id: 'export'},
    });
  } finally {
    f.store.close();
  }
});
test('operations rechecks tenant, actor ownership and every current account grant on each page', async () => {
  const f = fixture();
  try {
    const plan = {
      user_id: actor.userId,
      name: 'Scoped',
      state: 'draft',
      updated_at: 50,
      steps: [{gateway: 'meta_native_action', ...f.source}],
    };
    f.put('campaign_run', 'mine', plan);
    f.put('campaign_run', 'someone-else', {...plan, user_id: 'other'});
    f.put('campaign_run', 'other-tenant', plan, 'other-tenant');
    f.put('campaign_run', 'mixed-access', {
      ...plan,
      steps: [...plan.steps, {gateway: 'meta_native_action', ...f.source, account_id: '200'}],
    });
    f.put('media_review', 'other-upload', {
      user_id: 'other',
      plan: {...f.source, name: 'Private'},
      expires_at: Date.now() + 300000,
    });
    const r = await f.call();
    assert.equal(r.success, true, JSON.stringify(r));
    assert.deepEqual(
      r.data.operations.map(r => r.id),
      ['mine'],
    );
    const admin = await f.call({}, {...actor, role: 'admin'});
    assert.deepEqual(admin.data.operations.map(r => r.id).sort(), ['mine', 'someone-else']);
    f.store.putConnection({...actor, role: 'admin'}, {...f.connection, enabled: false}, {accessToken: 'synthetic'});
    assert.deepEqual((await f.call()).data.operations, []);
  } finally {
    f.store.close();
  }
});
test('operations binds cursors to identity and filters, keeps tied rows unique and continues past a full hidden scan', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 505; i++)
      f.put('report_incident', 'hidden-' + String(i).padStart(3, '0'), {
        ...f.source,
        account_id: '200',
        monitor_name: 'Hidden',
        state: 'open',
        updated_at: 100,
      });
    f.put('report_incident', 'visible-a', {...f.source, monitor_name: 'Spend', state: 'open', updated_at: 1});
    f.put('report_incident', 'visible-b', {...f.source, monitor_name: 'Spend', state: 'open', updated_at: 1});
    let r = await f.call({kind: 'incident', search: 'Spend', limit: 1});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.operations.length, 0);
    assert.equal(r.data.has_more, true);
    const cursor = r.data.next_cursor;
    for (const args of [
      {kind: 'upload', search: 'Spend'},
      {kind: 'incident', search: 'Other'},
    ]) {
      assert.equal((await f.call({...args, cursor})).error.code, 'INVALID_CURSOR');
    }
    assert.equal(
      (await f.call({kind: 'incident', search: 'Spend', cursor}, {...actor, userId: 'other'})).error.code,
      'INVALID_CURSOR',
    );
    r = await f.call({kind: 'incident', search: 'Spend', cursor, limit: 1});
    assert.equal(r.data.operations[0].id, 'visible-a');
    const last = await f.call({kind: 'incident', search: 'Spend', cursor: r.data.next_cursor, limit: 1});
    assert.equal(last.data.operations[0].id, 'visible-b');
    assert.equal(last.data.next_cursor, null);
    for (const args of [{cursor: 'bad'}, {limit: 101}, {kind: 'anything'}, {state: 'unknown-filter'}])
      assert.equal((await f.call(args)).success, false);
  } finally {
    f.store.close();
  }
});
test('upload feed reflects the durable job, preserves uncertainty, and honors media write-grant and viewer restrictions', async () => {
  const f = fixture();
  try {
    const job = f.store.enqueue(actor.tenantId, 'media_upload', {review_id: 'upload'});
    f.put('media_review', 'upload', {
      user_id: actor.userId,
      plan: {...f.source, name: 'Image'},
      job_id: job,
      expires_at: Date.now() + 300000,
    });
    f.store.claim(actor.tenantId, 'upload', 'fingerprint');
    f.store.db.prepare("UPDATE jobs SET state='failed',error='Legacy non-JSON error' WHERE id=?").run(job);
    let r = await f.call({kind: 'upload'});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.operations[0].state, 'failed');
    f.store.uncertain(actor.tenantId, 'upload');
    r = await f.call({kind: 'upload'});
    assert.equal(r.data.operations[0].state, 'uncertain');
    assert.equal((await f.call({kind: 'upload'}, {...actor, role: 'reader'})).data.operations.length, 0);
    f.store.putConnection({...actor, role: 'admin'}, {...f.connection, writeAccounts: []}, {accessToken: 'synthetic'});
    assert.equal((await f.call({kind: 'upload'})).data.operations.length, 0);
  } finally {
    f.store.close();
  }
});
