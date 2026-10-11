import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {ReportingService} from '../dist/src/reporting.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertRefused} from './helpers/assert-refused.mjs';
function fixture(t) {
  const actor = {tenantId: 'retirement-workspace', userId: 'member', role: 'operator'},
    store = new Store(':memory:', Buffer.alloc(32, 95).toString('base64'));
  t.after(() => store.close());
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
  const book = (id, creator = actor.userId) =>
    store.putDocument(actor.tenantId, 'workbook', id, {
      created_by: creator,
      spreadsheet_id: 'SHEET-' + id,
      spreadsheet_name: 'Book ' + id,
      preferences: {secret: 'PRIVATE-SETTINGS', freeze_headers: true},
      spreadsheet_url: 'https://example.invalid/private',
    });
  book('empty');
  book('used');
  book('foreign', 'someone-else');
  const config = {
    platform: 'meta',
    connection_id: 'meta',
    account_id: '100',
    date_range: {since: '2026-09-01', until: '2026-09-07'},
  };
  store.putDocument(actor.tenantId, 'reporting_query', 'query', {
    name: 'Current query',
    workbook_binding_id: 'used',
    query_config: config,
  });
  const call = (args, user = actor) => service.call('amcp_workspace', args, user);
  const detail = (id = 'empty', user = actor) => call({action: 'report_binding', id}, user);
  const preview = async (active = false, id = 'empty') => {
    const r = await detail(id);
    assert.equal(r.success, true, JSON.stringify(r));
    const p = await call({action: 'preview_report_binding_state', id, binding_version: r.data.binding_version, active});
    assert.equal(p.success, true, JSON.stringify(p));
    return p.data;
  };
  const save = (p, extra = {}, user = actor) =>
    call(
      {
        action: 'save_report_binding_state',
        id: p.id,
        binding_version: p.binding_version,
        active: p.active,
        confirmed: true,
        ...extra,
      },
      user,
    );
  const doc = (id = 'empty') => store.document(actor.tenantId, 'workbook', id);
  return {actor, store, reporting, call, detail, preview, save, doc, config, network: () => network};
}
test('empty workbook retirement is reviewed, reversible, hidden by default and preserves all stored settings', async t => {
  const f = fixture(t),
    before = f.doc(),
    p = await f.preview();
  assert.equal(p.active, false);
  assert.equal(p.external_writes, false);
  assert.equal(f.doc().revision, before.revision);
  assert.doesNotMatch(JSON.stringify(p), /PRIVATE-SETTINGS|example.invalid|preferences/);
  let r = await f.save(p);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.data.retired, true);
  assert.equal(r.data.can_edit, false);
  assert.deepEqual(f.doc().preferences, before.preferences);
  assert.equal(f.doc().spreadsheet_url, before.spreadsheet_url);
  assert.equal(
    (await f.call({action: 'report_bindings'})).data.bindings.some(b => b.id === 'empty'),
    false,
  );
  assert.deepEqual(
    (await f.call({action: 'report_bindings', state: 'retired'})).data.bindings.map(b => b.id),
    ['empty'],
  );
  assert.equal((await f.call({action: 'report_bindings', state: 'all'})).data.bindings.length, 2);
  assert.equal(
    f.reporting.handle('get_reporting_bootstrap', {}, f.actor).workbooks.some(b => b.id === 'empty'),
    false,
  );
  assert.equal((await f.detail()).data.retired, true);
  r = await f.save(await f.preview(true));
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.data.retired, false);
  assert.equal(
    (await f.call({action: 'report_bindings'})).data.bindings.some(b => b.id === 'empty'),
    true,
  );
  assert.deepEqual(f.doc().preferences, before.preferences);
  assert.equal(f.network(), 0);
});
test('binding lifecycle requires current version, confirmation and creator/admin write access', async t => {
  const f = fixture(t),
    p = await f.preview();
  assertRefused(await f.save(p, {confirmed: false}), 'CONFIRMATION_REQUIRED');
  assertRefused(await f.save(p, {}, {...f.actor, role: 'reader'}), 'FORBIDDEN');
  assertRefused(await f.save(p, {}, {...f.actor, userId: 'different'}), 'REPORT_BINDING_ACCESS_REQUIRED');
  assertRefused(await f.save(p, {}, {...f.actor, tenantId: 'other'}), 'NOT_FOUND');
  f.store.putDocument(f.actor.tenantId, 'workbook', 'empty', {...f.doc(), spreadsheet_name: 'Changed'});
  assertRefused(await f.save(p), 'STALE_REPORT_BINDING');
  assert.equal(f.doc().retired_at, undefined);
  assertRefused(await f.detail('foreign'), 'REPORT_BINDING_ACCESS_REQUIRED');
  assert.equal((await f.detail('foreign', {...f.actor, role: 'admin'})).success, true);
});
test('retirement refuses every linked query or schedule, including orphaned schedules, before mutation', async t => {
  const f = fixture(t),
    used = (await f.detail('used')).data;
  assert.equal(
    (
      await f.call({
        action: 'preview_report_binding_state',
        id: 'used',
        binding_version: used.binding_version,
        active: false,
      })
    ).success,
    false,
  );
  const p = await f.preview();
  f.store.putDocument(f.actor.tenantId, 'reporting_schedule', 'orphan', {
    workbook_binding_id: 'empty',
    schedule_config: {query_id: 'missing'},
    is_active: false,
    private_value: 'WITHHOLD',
  });
  const r = await f.save(p);
  assertRefused(r, 'REPORT_BINDING_IN_USE');
  assert.doesNotMatch(JSON.stringify(r), /WITHHOLD/);
  assert.equal(f.doc().retired_at, undefined);
  f.store.deleteDocument(f.actor.tenantId, 'reporting_schedule', 'orphan');
  f.store.putDocument(f.actor.tenantId, 'reporting_query', 'new-query', {
    name: 'new',
    workbook_binding_id: 'empty',
    query_config: f.config,
  });
  assertRefused(await f.save(p), 'STALE_REPORT_BINDING');
  assert.equal(f.doc().retired_at, undefined);
});
test('retired associations cannot silently receive new queries, preferences, legacy binds or reviewed moves', async t => {
  const f = fixture(t);
  assert.equal((await f.save(await f.preview())).success, true);
  for (const [operation, args] of [
    ['create_reporting_query', {workbook_binding_id: 'empty', name: 'new', query_config: f.config}],
    ['bind_reporting_workbook', {spreadsheet_id: 'SHEET-empty', spreadsheet_name: 'Resurrect'}],
    ['save_workbook_preferences', {workbook_binding_id: 'empty', preferences: {freeze_headers: false}}],
  ])
    for (const dry_run of [true, false])
      assert.throws(() => f.reporting.handle(operation, {...args, dry_run}, f.actor), /retired|restore/i);
  const q = (await f.call({action: 'report_query', id: 'query'})).data;
  assert.equal(
    (
      await f.call({
        action: 'preview_report_query_move',
        id: q.id,
        query_version: q.query_version,
        target_binding_id: 'empty',
      })
    ).success,
    false,
  );
  const d = (await f.detail()).data;
  assert.equal(
    (
      await f.call({
        action: 'preview_report_binding',
        id: d.id,
        binding_version: d.binding_version,
        binding: {spreadsheet_name: 'Changed'},
      })
    ).success,
    false,
  );
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
  assert.equal(f.network(), 0);
});
test('replay, malformed lifecycle values and invalid state filters cannot create extra revisions', async t => {
  const f = fixture(t),
    p = await f.preview();
  assert.equal((await f.save(p)).success, true);
  const revision = f.doc().revision;
  assertRefused(await f.save(p), 'STALE_REPORT_BINDING');
  for (const active of ['false', null, 0]) assertRefused(await f.save(p, {active}), 'STALE_REPORT_BINDING');
  assertRefused(await f.call({action: 'report_bindings', state: 'unknown'}), 'INVALID_ARGUMENT');
  assert.equal(f.doc().revision, revision);
});
