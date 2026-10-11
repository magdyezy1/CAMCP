import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertRefused} from './helpers/assert-refused.mjs';

function fixture(t) {
  const actor = {tenantId: 'binding-workspace', userId: 'member', role: 'operator'};
  const store = new Store(':memory:', Buffer.alloc(32, 92).toString('base64'));
  t.after(() => store.close());
  let network = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      network++;
      throw Error('Unexpected native request');
    }),
  );
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
  const query = (id, binding, account = '100') =>
    store.putDocument(actor.tenantId, 'reporting_query', id, {
      name: 'Query ' + id,
      workbook_binding_id: binding,
      query_config: {
        platform: 'meta',
        connection_id: 'meta',
        account_id: account,
        date_range: {since: '2026-09-01', until: '2026-09-07'},
      },
    });
  for (const [id, account] of [
    ['a-denied', '200'],
    ['b-allowed', '100'],
  ]) {
    store.putDocument(actor.tenantId, 'workbook', id, {
      spreadsheet_id: 'SHEET-' + id,
      spreadsheet_name: 'Book ' + id,
      created_by: actor.userId,
      spreadsheet_url: 'https://evil.example/private',
      local_config: {access_token: 'PRIVATE-SETTING'},
      freeze_headers: true,
    });
    query(id, id, account);
  }
  store.putDocument(actor.tenantId, 'workbook', 'c-empty', {
    spreadsheet_id: 'SHEET-empty',
    spreadsheet_name: 'Empty workbook',
    created_by: actor.userId,
  });
  store.putDocument(actor.tenantId, 'workbook', 'd-foreign-empty', {
    spreadsheet_id: 'SHEET-other',
    created_by: 'someone-else',
  });
  const call = (input, user = actor) => service.call('amcp_workspace', input, user);
  const get = () => call({action: 'report_binding', id: 'b-allowed'});
  return {store, actor, connection, query, call, get, network: () => network};
}

test('workbook binding discovery is scoped, paginated, metadata-only and does not imply external access', async t => {
  const f = fixture(t);
  const first = await f.call({action: 'report_bindings', limit: 1});
  assert.equal(first.success, true, JSON.stringify(first));
  assert.deepEqual(
    first.data.bindings.map(b => b.id),
    ['b-allowed'],
  );
  assert.ok(first.data.next_offset > 0);
  const second = await f.call({action: 'report_bindings', limit: 1, offset: first.data.next_offset});
  assert.deepEqual(
    second.data.bindings.map(b => b.id),
    ['c-empty'],
  );
  const filtered = await f.call({action: 'report_bindings', spreadsheet_id: 'SHEET-b-allowed', search: 'Book'});
  assert.deepEqual(
    filtered.data.bindings.map(b => b.id),
    ['b-allowed'],
  );
  assert.doesNotMatch(
    JSON.stringify([first, second, filtered]),
    /PRIVATE-SETTING|evil\.example|a-denied|foreign-empty/,
  );
  assert.equal(first.data.bindings[0].external_access_verified, false);
  assert.equal(f.network(), 0);
});

test('binding detail links current queries and returns a version without private preferences or provider requests', async t => {
  const f = fixture(t),
    r = await f.get();
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.data.spreadsheet_name, 'Book b-allowed');
  assert.equal(r.data.query_count, 1);
  assert.equal(r.data.queries[0].account_id, '100');
  assert.equal(r.data.queries[0].website_path, '/operations?query_id=b-allowed');
  assert.match(r.data.binding_version, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE-SETTING|local_config|evil\.example|access_token/);
  const reader = await f.call({action: 'report_binding', id: 'b-allowed'}, {...f.actor, role: 'reader'});
  assert.equal(reader.data.can_edit, false);
  assert.equal(f.network(), 0);
});

test('reviewed binding names save only the displayed local metadata, retaining settings, queries and job counts', async t => {
  const f = fixture(t),
    original = f.store.document(f.actor.tenantId, 'workbook', 'b-allowed'),
    before = await f.get();
  const args = {
    id: 'b-allowed',
    binding_version: before.data?.binding_version,
    binding: {spreadsheet_name: 'اسم العميل - ID 001'},
  };
  const preview = await f.call({action: 'preview_report_binding', ...args});
  assert.equal(preview.success, true, JSON.stringify(preview));
  assert.equal(preview.data.changes[0].before, original.spreadsheet_name);
  assert.equal(f.store.document(f.actor.tenantId, 'workbook', 'b-allowed').revision, original.revision);
  assertRefused(await f.call({action: 'save_report_binding', ...args}), 'CONFIRMATION_REQUIRED');
  const saved = await f.call({action: 'save_report_binding', ...args, confirmed: true});
  assert.equal(saved.success, true, JSON.stringify(saved));
  const row = f.store.document(f.actor.tenantId, 'workbook', 'b-allowed');
  assert.equal(row.spreadsheet_name, args.binding.spreadsheet_name);
  assert.deepEqual(row.local_config, original.local_config);
  assert.equal(row.spreadsheet_id, original.spreadsheet_id);
  assert.equal(row.spreadsheet_url, original.spreadsheet_url);
  assert.equal(row.freeze_headers, true);
  assert.equal(f.store.document(f.actor.tenantId, 'reporting_query', 'b-allowed').revision, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM jobs').get().n, 0);
  assert.equal(f.network(), 0);
});

test('binding edits require the current binding and query membership revisions and current complete account access', async t => {
  const f = fixture(t),
    r = await f.get();
  assert.equal(r.success, true, JSON.stringify(r));
  const args = {
    action: 'save_report_binding',
    id: 'b-allowed',
    binding_version: r.data.binding_version,
    binding: {spreadsheet_name: 'Changed'},
    confirmed: true,
  };
  f.query('new-query', 'b-allowed');
  assert.equal((await f.call(args)).error.code, 'STALE_REPORT_BINDING');
  args.binding_version = (await f.get()).data.binding_version;
  f.query('new-query', 'b-allowed', '200');
  assertRefused(await f.call(args), 'CONNECTION_REQUIRED');
  assertRefused(await f.get(), 'CONNECTION_REQUIRED');
  assert.equal(f.store.document(f.actor.tenantId, 'workbook', 'b-allowed').spreadsheet_name, 'Book b-allowed');
  assertRefused(await f.call({...args, id: 'b-allowed'}, {...f.actor, tenantId: 'other'}), 'NOT_FOUND');
  assert.equal(f.network(), 0);
});

test('binding changes reject reader writes, unexpected fields, malformed names and invalid pagination', async t => {
  const f = fixture(t),
    r = await f.get();
  assert.equal(r.success, true, JSON.stringify(r));
  const args = {
    action: 'save_report_binding',
    id: 'b-allowed',
    binding_version: r.data.binding_version,
    confirmed: true,
  };
  for (const binding of [
    {spreadsheet_name: ''},
    {spreadsheet_name: 'bad\nname'},
    {spreadsheet_name: 'x'.repeat(121)},
    {spreadsheet_name: 'Good', spreadsheet_id: 'other'},
    {spreadsheet_name: 'Good', local_config: {password: 'never'}},
  ])
    assertRefused(await f.call({...args, binding}), 'INVALID_ARGUMENT');
  assert.equal(
    (await f.call({...args, binding: {spreadsheet_name: 'Good'}}, {...f.actor, role: 'reader'})).success,
    false,
  );
  for (const input of [{limit: 0}, {offset: -1}, {search: 'x'.repeat(201)}])
    assertRefused(await f.call({action: 'report_bindings', ...input}), 'INVALID_ARGUMENT');
  assert.equal(f.store.document(f.actor.tenantId, 'workbook', 'b-allowed').revision, 1);
});

test('empty workbook setup remains creator/admin-only and oversized legacy records are withheld', async t => {
  const f = fixture(t);
  const own = await f.call({action: 'report_binding', id: 'c-empty'});
  assert.equal(own.success, true, JSON.stringify(own));
  assertRefused(await f.call({action: 'report_binding', id: 'd-foreign-empty'}), 'REPORT_BINDING_ACCESS_REQUIRED');
  assert.equal(
    (await f.call({action: 'report_binding', id: 'd-foreign-empty'}, {...f.actor, role: 'admin'})).success,
    true,
  );
  const row = f.store.document(f.actor.tenantId, 'workbook', 'c-empty');
  f.store.putDocument(f.actor.tenantId, 'workbook', 'c-empty', {...row, padding: 'x'.repeat(70000)});
  assertRefused(await f.call({action: 'report_binding', id: 'c-empty'}), 'REPORT_BINDING_TOO_LARGE');
  const list = await f.call({action: 'report_bindings'});
  assert.equal(list.success, true, JSON.stringify(list));
  assert.deepEqual(
    list.data.bindings.map(b => b.id),
    ['b-allowed'],
  );
});
