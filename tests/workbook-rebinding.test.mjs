import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {ReportingService} from '../dist/src/reporting.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertRefused} from './helpers/assert-refused.mjs';

function fixture(t) {
  const actor = {tenantId: 'rebind-workspace', userId: 'member', role: 'operator'};
  const store = new Store(':memory:', Buffer.alloc(32, 94).toString('base64'));
  t.after(() => store.close());
  const connection = {
    id: 'meta',
    tenantId: actor.tenantId,
    gateway: 'meta_native_action',
    accounts: ['100'],
    enabled: true,
    label: 'Synthetic',
    scopes: [],
  };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  let network = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      network++;
      throw Error('Unexpected request');
    }),
  );
  const reporting = new ReportingService(store);
  for (const id of ['source', 'target'])
    store.putDocument(actor.tenantId, 'workbook', id, {
      spreadsheet_id: 'SHEET-' + id,
      spreadsheet_name: 'Workbook ' + id,
      created_by: actor.userId,
      spreadsheet_url: 'https://example.invalid/private',
      preferences: {access_token: 'PRIVATE-SETTING'},
    });
  const config = account => ({
    platform: 'meta',
    connection_id: 'meta',
    account_id: account,
    date_range: {since: '2026-09-01', until: '2026-09-07'},
  });
  const query = (id, binding = 'source', account = '100') =>
    store.putDocument(actor.tenantId, 'reporting_query', id, {
      name: 'Query ' + id,
      workbook_binding_id: binding,
      query_config: config(account),
    });
  query('query-001');
  for (const [id, active] of [
    ['active', true],
    ['paused', false],
  ])
    store.putDocument(actor.tenantId, 'reporting_schedule', id, {
      name: id,
      workbook_binding_id: 'source',
      schedule_config: {query_id: 'query-001', minute: 12, hour: 8},
      schedule_kind: 'daily',
      timezone: 'UTC',
      is_active: active,
      next_run_at: 123,
      actor_binding: 'PRIVATE-AUTHORITY',
      last_run_id: 'retained-run',
    });
  const retained = store.enqueueReport(
    actor,
    {query_id: 'query-001', query_revision: 1, query_config: config('100')},
    Number.MAX_SAFE_INTEGER,
  );
  const call = (args, user = actor) => service.call('amcp_workspace', args, user);
  const preview = async () => {
    const q = await call({action: 'report_query', id: 'query-001'});
    const result = await call({
      action: 'preview_report_query_move',
      id: 'query-001',
      query_version: q.data.query_version,
      target_binding_id: 'target',
    });
    assert.equal(result.success, true, JSON.stringify(result));
    return result.data;
  };
  const save = (p, extra = {}, user = actor) =>
    call(
      {
        action: 'move_report_query',
        id: 'query-001',
        query_version: p.query_version,
        target_binding_id: p.target.id,
        rebinding_version: p.rebinding_version,
        confirmed: true,
        ...extra,
      },
      user,
    );
  const doc = (kind, id) => store.document(actor.tenantId, kind, id);
  const jobs = () => store.db.prepare('SELECT * FROM jobs ORDER BY id').all();
  return {
    actor,
    store,
    connection,
    reporting,
    call,
    query,
    config,
    preview,
    save,
    doc,
    jobs,
    retained,
    network: () => network,
  };
}

test('legacy query rebinding moves all schedules atomically, pauses active clocks and preserves retained jobs', t => {
  const f = fixture(t),
    before = f.jobs();
  const preview = f.reporting.handle(
    'update_reporting_query',
    {query_id: 'query-001', workbook_binding_id: 'target'},
    f.actor,
  );
  assert.equal(preview.schedules_to_rebind, 2);
  assert.equal(preview.schedules_to_pause, 1);
  assert.equal(f.doc('reporting_query', 'query-001').workbook_binding_id, 'source');
  const result = f.reporting.handle(
    'update_reporting_query',
    {query_id: 'query-001', workbook_binding_id: 'target', dry_run: false},
    f.actor,
  );
  assert.equal(result.schedules_rebound, 2);
  assert.equal(result.schedules_paused, 1);
  for (const id of ['active', 'paused']) {
    const schedule = f.doc('reporting_schedule', id);
    assert.equal(schedule.workbook_binding_id, 'target');
    assert.equal(schedule.is_active, false);
    assert.equal(schedule.next_run_at, 123);
    assert.equal(schedule.actor_binding, 'PRIVATE-AUTHORITY');
    assert.equal(schedule.last_run_id, 'retained-run');
  }
  assert.deepEqual(
    f.jobs().filter(j => j.id === f.retained),
    before,
  );
  assert.equal(f.jobs().length, 2);
  assert.equal(f.network(), 0);
});

test('legacy rebind cannot move a query out of an association containing another unauthorized account', t => {
  const f = fixture(t);
  f.query('other-query', 'source', '200');
  for (const dry_run of [true, false])
    assert.throws(
      () =>
        f.reporting.handle(
          'update_reporting_query',
          {query_id: 'query-001', workbook_binding_id: 'target', dry_run},
          f.actor,
        ),
      /authorized|scope|access/i,
    );
  assert.equal(f.doc('reporting_query', 'query-001').workbook_binding_id, 'source');
  assert.equal(f.jobs().length, 1);
});

test('reviewed move exposes bounded source/target identity and schedule impact without private settings or mutation', async t => {
  const f = fixture(t),
    before = f.jobs(),
    p = await f.preview();
  assert.equal(p.source.id, 'source');
  assert.equal(p.target.id, 'target');
  assert.equal(p.source.spreadsheet_id, 'SHEET-source');
  assert.equal(p.target.spreadsheet_id, 'SHEET-target');
  assert.equal(p.schedules_to_rebind, 2);
  assert.equal(p.schedules_to_pause, 1);
  assert.equal(p.external_access_verified, false);
  assert.equal(p.external_writes, false);
  assert.match(p.rebinding_version, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(p), /PRIVATE-|example.invalid|query_config|actor_binding/);
  assert.deepEqual(f.jobs(), before);
  assert.equal(f.network(), 0);
});

test('confirmed move binds exact versions, preserves configuration, prepares one local run and refuses replay', async t => {
  const f = fixture(t),
    p = await f.preview(),
    oldQuery = f.doc('reporting_query', 'query-001'),
    oldJobs = f.jobs();
  assertRefused(await f.save(p, {confirmed: false}), 'CONFIRMATION_REQUIRED');
  assertRefused(await f.save(p, {}, {...f.actor, role: 'reader'}), 'FORBIDDEN');
  const result = await f.save(p);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.data.workbook_binding_id, 'target');
  assert.equal(result.data.schedules_paused, 1);
  assert.equal(result.data.schedules_rebound, 2);
  assert.ok(result.data.prepared_run_id);
  assert.deepEqual(f.doc('reporting_query', 'query-001').query_config, oldQuery.query_config);
  assert.deepEqual(
    f.jobs().filter(j => j.id === f.retained),
    oldJobs,
  );
  assertRefused(await f.save(p), 'STALE_REPORT_QUERY');
  assert.equal(f.jobs().length, 2);
  const bootstrap = f.reporting.handle('get_reporting_bootstrap', {spreadsheet_id: 'SHEET-target'}, f.actor);
  assert.equal(bootstrap.schedules.length, 2);
  assert.equal(bootstrap.queries.length, 1);
  assert.equal(f.network(), 0);
});

test('changes to query, schedules, either binding or target membership invalidate the displayed move', async t => {
  for (const change of ['query', 'schedule', 'source', 'target', 'membership']) {
    const f = fixture(t),
      p = await f.preview();
    if (change === 'membership') f.query('new-target-query', 'target');
    else {
      const [kind, id] =
        change === 'query'
          ? ['reporting_query', 'query-001']
          : change === 'schedule'
            ? ['reporting_schedule', 'paused']
            : ['workbook', change];
      f.store.putDocument(f.actor.tenantId, kind, id, {...f.doc(kind, id), name: 'Changed'});
    }
    const before = f.jobs();
    assertRefused(await f.save(p), ['STALE_REPORT_QUERY', 'STALE_REPORT_REBINDING']);
    assert.equal(f.doc('reporting_query', 'query-001').workbook_binding_id, 'source');
    assert.deepEqual(f.jobs(), before);
  }
});

test('current revocation, foreign empty target, target capacity and inconsistent legacy schedules refuse a move', async t => {
  for (const change of [
    'revocation',
    'foreign-empty',
    'target-scope',
    'full',
    'mismatch',
    'oversized',
    'schedule-limit',
  ]) {
    const f = fixture(t),
      p = await f.preview();
    if (change === 'revocation')
      f.store.putConnection({...f.actor, role: 'admin'}, {...f.connection, enabled: false}, {accessToken: 'synthetic'});
    if (change === 'foreign-empty')
      f.store.putDocument(f.actor.tenantId, 'workbook', 'target', {
        ...f.doc('workbook', 'target'),
        created_by: 'someone-else',
      });
    if (change === 'target-scope') f.query('denied', 'target', '200');
    if (change === 'full') for (let i = 0; i < 500; i++) f.query('target-' + i, 'target');
    if (change === 'mismatch')
      f.store.putDocument(f.actor.tenantId, 'reporting_schedule', 'active', {
        ...f.doc('reporting_schedule', 'active'),
        workbook_binding_id: 'other',
      });
    if (change === 'oversized')
      f.store.putDocument(f.actor.tenantId, 'reporting_schedule', 'active', {
        ...f.doc('reporting_schedule', 'active'),
        padding: 'x'.repeat(65536),
      });
    if (change === 'schedule-limit')
      for (let i = 0; i < 99; i++)
        f.store.putDocument(f.actor.tenantId, 'reporting_schedule', 'extra-' + i, {
          ...f.doc('reporting_schedule', 'paused'),
        });
    assertRefused(await f.save(p), [
      'CONNECTION_REQUIRED',
      'REPORT_BINDING_ACCESS_REQUIRED',
      'REPORT_BINDING_QUERY_LIMIT',
      'STALE_REPORT_QUERY',
    ]);
    assert.equal(f.doc('reporting_query', 'query-001').workbook_binding_id, 'source');
    assert.equal(f.jobs().length, 1);
  }
  const f = fixture(t),
    q = (await f.call({action: 'report_query', id: 'query-001'})).data;
  for (const target_binding_id of ['source', 'missing', 'x'.repeat(161)])
    assert.equal(
      (await f.call({action: 'preview_report_query_move', id: q.id, query_version: q.query_version, target_binding_id}))
        .success,
      false,
    );
});

test('an audit failure rolls the complete rebind back, including schedules and prepared jobs', async t => {
  const f = fixture(t),
    p = await f.preview(),
    before = f.jobs(),
    query = f.doc('reporting_query', 'query-001'),
    schedule = f.doc('reporting_schedule', 'active');
  const audit = f.store.appendAudit.bind(f.store);
  f.store.appendAudit = (tenant, stream, payload) => {
    if (payload.event === 'update_reporting_query') throw Error('synthetic audit failure');
    return audit(tenant, stream, payload);
  };
  const failed = await f.save(p);
  // The injected audit failure is a crash by design, so INTERNAL_ERROR is the expected code here; its text stays private.
  assert.equal(failed.success, false);
  assert.equal(failed.error.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(failed.error.message, /synthetic audit failure/);
  assert.deepEqual(f.doc('reporting_query', 'query-001'), query);
  assert.deepEqual(f.doc('reporting_schedule', 'active'), schedule);
  assert.deepEqual(f.jobs(), before);
});
