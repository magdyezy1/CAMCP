import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
function fixture(t, count = 3) {
  const actor = {tenantId: 'synthetic-evidence-index', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 122).toString('base64'));
  t.after(() => store.close());
  const connection = {
    id: 'synthetic',
    tenantId: actor.tenantId,
    gateway: 'meta_native_action',
    accounts: ['100'],
    enabled: true,
    label: 'Synthetic',
    scopes: [],
  };
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  const put = (id, changes = {}, tenant = actor.tenantId) =>
    store.putDocument(tenant, 'decision_report', id, {
      gateway: 'meta_native_action',
      account_id: '100',
      connection_id: 'synthetic',
      source: 'provider_read',
      preset: 'meta_campaign',
      grain: 'campaign × day',
      captured_at: 1790900000000,
      source_hash: 'a'.repeat(64),
      semantics: {
        source_name: 'Original العربية ' + id,
        currency: 'USD',
        timezone: 'UTC',
        date_from: '2026-09-01',
        date_to: '2026-09-02',
        conversion_definition: 'purchase',
        attribution: 'declared',
        complete: true,
      },
      rows: [{entity_id: '100', spend: '9007199254740993.000001', marker: 'RAW-ROW-MARKER'}],
      source_request: {synthetic: 'REQUEST-MARKER'},
      source_pages: [{synthetic: 'PAGE-MARKER'}],
      arbitrary: 'PRIVATE-DOCUMENT-MARKER',
      ...changes,
    });
  for (let i = 0; i < count; i++) put('report-' + String(i).padStart(4, '0'));
  let network = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      network++;
      throw Error('Provider calls forbidden');
    }),
  );
  return {
    actor,
    store,
    connection,
    service,
    put,
    network: () => network,
    call: (input = {}, caller = actor) => service.call('amcp_reporting', {action: 'list', ...input}, caller),
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};
test('saved evidence list honors bounds and projects metadata without materializing rows or native requests', async t => {
  const f = fixture(t);
  f.store.documents = () => {
    throw Error('Full document loading forbidden');
  };
  f.store.document = () => {
    throw Error('Full document loading forbidden');
  };
  const out = ok(await f.call({limit: 1}));
  assert.equal(out.reports.length, 1);
  assert.equal(out.reports[0].row_count, 1);
  assert.equal(out.reports[0].semantics.complete, true);
  assert.equal(out.has_more, true);
  assert.ok(out.next_cursor);
  assert.doesNotMatch(JSON.stringify(out), /RAW-ROW-MARKER|REQUEST-MARKER|PAGE-MARKER|PRIVATE-DOCUMENT-MARKER/);
  assert.equal(f.network(), 0);
});
test('opaque evidence continuations visit every authorized report once under the original filters', async t => {
  const f = fixture(t, 5);
  f.put('foreign', {account_id: '200'});
  f.put('other-tenant', {}, 'other-tenant');
  let cursor,
    ids = [];
  do {
    const page = ok(await f.call({limit: 2, ...(cursor ? {cursor} : {})}));
    ids.push(...page.reports.map(r => r.id));
    cursor = page.next_cursor;
    assert.equal(page.has_more, Boolean(cursor));
  } while (cursor);
  assert.deepEqual(
    ids,
    Array.from({length: 5}, (_, i) => 'report-' + String(i).padStart(4, '0')),
  );
  assert.equal(new Set(ids).size, 5);
  assert.equal(f.network(), 0);
});
test('evidence continuations refuse tampering, identity, filters, scope changes and expiration before results', async t => {
  const f = fixture(t),
    first = ok(await f.call({limit: 1})),
    cursor = first.next_cursor;
  assert.ok(cursor);
  for (const [input, actor] of [
    [{cursor: cursor.slice(0, -2) + 'AA'}, f.actor],
    [{cursor, search: 'different'}, f.actor],
    [{cursor}, {...f.actor, userId: 'other'}],
    [{cursor}, {...f.actor, role: 'reader'}],
  ])
    assert.equal((await f.call(input, actor)).success, false);
  f.store.putConnection(f.actor, {...f.connection, accounts: ['100', '200']}, {accessToken: 'synthetic'});
  assert.equal((await f.call({cursor})).success, false);
  const renewed = ok(await f.call({limit: 1})).next_cursor,
    now = Date.now;
  try {
    Date.now = () => now() + 900001;
    assert.equal((await f.call({cursor: renewed})).success, false);
  } finally {
    Date.now = now;
  }
  assert.equal(f.network(), 0);
});
test('evidence search uses exact text matching and normalized account scope without changing source labels', async t => {
  const f = fixture(t, 0);
  f.put('alpha');
  f.put('beta', {
    account_id: 'act_100',
    semantics: {
      source_name: 'Arabic رمضان <source>',
      currency: 'USD',
      timezone: 'UTC',
      date_from: '2026-09-01',
      date_to: '2026-09-02',
      attribution: 'declared',
      conversion_definition: 'purchase',
      complete: true,
    },
  });
  const out = ok(
    await f.call({
      search: 'رمضان',
      gateway: 'meta_native_action',
      account_id: '100',
      connection_id: 'synthetic',
      limit: 10,
    }),
  );
  assert.deepEqual(
    out.reports.map(r => r.id),
    ['beta'],
  );
  assert.equal(out.reports[0].semantics.source_name, 'Arabic رمضان <source>');
  assert.equal(out.reports[0].account_id, 'act_100');
  assert.deepEqual(
    ok(await f.call({search: 'BETA'})).reports.map(r => r.id),
    ['beta'],
  );
  assert.equal(ok(await f.call({preset: 'google_ad'})).reports.length, 0);
});
test('bounded inaccessible scans return a continuation rather than false completion', async t => {
  const f = fixture(t, 0);
  f.store.transaction(() => {
    for (let i = 0; i < 502; i++) f.put('a-' + String(i).padStart(4, '0'), {account_id: '200'});
    f.put('z-accessible');
  });
  const first = ok(await f.call({limit: 1}));
  assert.equal(first.reports.length, 0);
  assert.equal(first.has_more, true);
  assert.ok(first.next_cursor);
  const second = ok(await f.call({limit: 1, cursor: first.next_cursor}));
  assert.deepEqual(
    second.reports.map(r => r.id),
    ['z-accessible'],
  );
  assert.equal(second.has_more, false);
});
test('incomplete legacy metadata remains unknown and cannot expand the discovery response with arbitrary values', async t => {
  const f = fixture(t, 0);
  f.put('legacy', {rows: null, semantics: {source_name: 'x'.repeat(100000), complete: 'true'}});
  const out = ok(await f.call({limit: 1}));
  assert.equal(out.reports[0].row_count, null);
  assert.equal(out.reports[0].semantics.complete, null);
  assert.equal(out.reports[0].semantics.source_name, null);
  assert.ok(JSON.stringify(out).length < 3000);
});
test('evidence index rejects unsafe bounds and unsupported offsets before provider reads', async t => {
  const f = fixture(t);
  for (const input of [
    {limit: 0},
    {limit: 101},
    {limit: 1.5},
    {offset: 1},
    {search: 'bad\nquery'},
    {search: 'x'.repeat(151)},
    {account_id: '100'},
    {gateway: []},
  ])
    assert.equal((await f.call(input)).success, false, JSON.stringify(input));
  assert.equal(f.network(), 0);
});

test('evidence continuations survive synthetic database restore with the same key and credential, but reject other sessions and keys', async t => {
  const f = fixture(t),
    token = f.store.createKey(f.actor),
    actor = f.store.authenticate(token),
    cursor = ok(await f.call({limit: 1}, actor)).next_cursor,
    other = f.store.authenticate(f.store.createKey(f.actor)),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-evidence-index-')),
    filename = path.join(dir, 'synthetic.sqlite');
  assert.equal((await f.call({limit: 1, cursor}, other)).success, false);
  try {
    f.store.db.prepare('VACUUM INTO ?').run(filename);
    for (const key of [122, 124]) {
      const restored = new Store(filename, Buffer.alloc(32, key).toString('base64'));
      try {
        const caller = restored.authenticate(token),
          service = new MirrorService(
            new Registry(),
            restored,
            new NativeTransport(async () => {
              throw Error('Provider calls forbidden');
            }),
          ),
          out = await service.call('amcp_reporting', {action: 'list', limit: 1, cursor}, caller);
        if (key === 122)
          assert.deepEqual(
            ok(out).reports.map(r => r.id),
            ['report-0001'],
          );
        else assert.equal(out.success, false);
      } finally {
        restored.close();
      }
    }
  } finally {
    // Verify the unique disposable directory before recursive cleanup; closed SQLite sidecars can linger
    // briefly on Windows. Bounded native retries handle transient EPERM/EBUSY/ENOTEMPTY without widening the target.
    const disposable = fs.realpathSync(dir);
    assert.equal(path.dirname(disposable), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(disposable), /^amcp-evidence-index-[a-zA-Z0-9]+$/);
    assert.equal(fs.lstatSync(dir).isSymbolicLink(), false);
    fs.rmSync(disposable, {recursive: true, force: false, maxRetries: 10, retryDelay: 100});
  }
  assert.equal(f.network(), 0);
});

test('evidence index refuses a grant change during page projection without returning partial metadata', async t => {
  const f = fixture(t),
    resolve = f.store.resolveConnection.bind(f.store);
  let changed = false;
  f.store.resolveConnection = (...args) => {
    const out = resolve(...args);
    if (!changed) {
      changed = true;
      f.store.putConnection(f.actor, {...f.connection, accounts: ['200']}, {accessToken: 'synthetic'});
    }
    return out;
  };
  const out = await f.call({limit: 1});
  assert.equal(out.success, false);
  assert.doesNotMatch(JSON.stringify(out), /Original العربية|RAW-ROW-MARKER/);
  assert.equal(f.network(), 0);
});

test('evidence index refuses credential revocation during page projection', async t => {
  const f = fixture(t),
    token = f.store.createKey(f.actor),
    actor = f.store.authenticate(token),
    resolve = f.store.resolveConnection.bind(f.store);
  f.store.resolveConnection = (...args) => {
    const out = resolve(...args);
    f.store.revokeKey(token);
    return out;
  };
  const out = await f.call({limit: 1}, actor);
  assert.equal(out.success, false);
  assert.doesNotMatch(JSON.stringify(out), /Original العربية|RAW-ROW-MARKER/);
  assert.equal(f.network(), 0);
});
