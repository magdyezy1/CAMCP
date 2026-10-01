import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {WebStore} from '../dist/server/web-store.js';
import {UserAccounts} from '../dist/server/user-accounts.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

function fixture(t) {
  const actor = {tenantId: 'history-scope', userId: 'reader', role: 'reader'},
    store = new Store(':memory:', Buffer.alloc(32, 98).toString('base64'));
  t.after(() => store.close());
  const connection = {
    id: 'login',
    tenantId: actor.tenantId,
    gateway: 'meta_native_action',
    accounts: ['100'],
    enabled: true,
    label: 'Synthetic',
    scopes: [],
  };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('No provider access');
    }),
  );
  const append = (event, tenant = actor.tenantId) =>
    store.appendAudit(tenant, 'request-' + store.audit(tenant, 1000).length, event);
  const event = (account = '100', extra = {}) => ({
    event: 'request_completed',
    connection_id: 'login',
    request: {gateway: 'meta_native_action', accountId: account, action: 'native_read', body: {canary: 'PRIVATE-BODY'}},
    outcome: {data: {canary: 'PRIVATE-RECEIPT'}},
    ...extra,
  });
  const call = (input = {}, as = actor) => service.call('amcp_workspace', {action: 'history', ...input}, as);
  return {actor, store, connection, service, append, event, call};
}
function ok(r) {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
}

test('history withholds other accounts and unscoped colleague events and never returns request bodies or receipts', async t => {
  const f = fixture(t);
  f.append(f.event());
  f.append(f.event('200'));
  f.append({event: 'local_saved', actor: 'someone-else', private: 'PRIVATE-COLLEAGUE'});
  f.append({event: 'local_saved', actor: 'reader', private: 'PRIVATE-LOCAL'});
  f.append(f.event(), 'other-tenant');
  const out = ok(await f.call());
  assert.equal(out.events.length, 2);
  assert.equal(out.record_kind, 'audit_history');
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE-|someone-else|"200"|"request":|"outcome":/);
  assert.equal(out.events.find(e => e.event === 'request_completed').account_id, '100');
  const owner = ok(await f.call({}, {...f.actor, role: 'admin'}));
  assert.equal(owner.events.length, 4);
  assert.doesNotMatch(JSON.stringify(owner), /PRIVATE-|"request":|"outcome":/);
  assert.equal(f.store.verifyAudit(), true);
});

test('history pages retain a fixed sequence boundary, exact filters and empty-page continuation through hidden rows', async t => {
  const f = fixture(t);
  f.append(f.event());
  for (let i = 0; i < 501; i++) f.append(f.event('200'));
  const first = ok(await f.call({limit: 2}));
  assert.equal(first.events.length, 0);
  assert.equal(first.has_more, true);
  f.append(f.event('100', {event: 'later_event'}));
  const next = ok(await f.call({limit: 2, cursor: first.next_cursor}));
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].event, 'request_completed');
  assert.equal(next.has_more, false);
  assert.equal((await f.call({limit: 3, cursor: first.next_cursor})).success, false);
  assert.equal((await f.call({limit: 2, account_id: '100', cursor: first.next_cursor})).success, false);
  assert.equal((await f.call({limit: 2, cursor: first.next_cursor}, {...f.actor, userId: 'other'})).success, false);
  assert.equal((await f.call({cursor: 'bad-cursor'})).success, false);
});

test('every history continuation rechecks current grants and malformed or conflicting scopes fail closed', async t => {
  const f = fixture(t);
  f.append(f.event());
  f.append(f.event());
  const first = ok(await f.call({limit: 1}));
  f.store.putConnection({...f.actor, role: 'admin'}, {...f.connection, enabled: false}, {accessToken: 'synthetic'});
  assert.equal(ok(await f.call({limit: 1, cursor: first.next_cursor})).events.length, 0);
  f.store.putConnection({...f.actor, role: 'admin'}, f.connection, {accessToken: 'synthetic'});
  f.append(f.event('100', {account_id: '200'}));
  f.append(f.event('100', {connection_id: 42}));
  f.append({event: 'bad_scope', actor: 'reader', gateway: 'meta_native_action', account_id: {id: '100'}});
  const out = ok(await f.call());
  assert.equal(out.events.length, 2);
});

test('history bounds metadata and diagnostics and omits arbitrary nested provider fields', async t => {
  const f = fixture(t);
  f.append({
    event: 'website_asset_sync',
    actor: 'reader',
    platform: 'meta',
    connection_id: 'login',
    complete: false,
    vendor_writes: 0,
    error: {code: 'ASSET_SYNC_INCOMPLETE', message: 'Failure', private: 'PRIVATE-ERROR'},
    diagnostics: [
      {
        operation: 'account_sync',
        platform: 'meta',
        account_id: '100',
        connection_id: 'login',
        code: 'ERROR',
        provider: {code: 'NATIVE_CODE', message: 'Problem', private: 'PRIVATE-PROVIDER'},
        arbitrary: 'PRIVATE-DIAGNOSTIC',
      },
      {
        operation: 'account_sync',
        platform: 'meta',
        account_id: '200',
        connection_id: 'login',
        code: 'FOREIGN_DIAGNOSTIC',
      },
    ],
    private: 'PRIVATE-ROOT',
  });
  const out = ok(await f.call());
  assert.equal(out.events.length, 1);
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE-|FOREIGN_DIAGNOSTIC/);
  assert.equal(out.events[0].diagnostics.length, 1);
  assert.equal(out.events[0].diagnostics[0].provider.code, 'NATIVE_CODE');
  assert.equal(out.events[0].complete, false);
  assert.equal(out.events[0].vendor_writes, 0);
  f.store.document =
    f.store.documents =
    f.store.audit =
    f.store.recentAudit =
      () => {
        throw Error('Full audit/document reads forbidden');
      };
  assert.equal(ok(await f.call()).events.length, 1);
});

test('history validates filters before database scanning and cannot expand read authority', async t => {
  const f = fixture(t);
  f.append(f.event());
  for (const args of [
    {limit: 0},
    {limit: 101},
    {search: 'x'.repeat(201)},
    {gateway: []},
    {connection_id: 7},
    {account_id: ''},
  ])
    assert.equal((await f.call(args)).success, false, JSON.stringify(args));
  assert.equal(ok(await f.call({account_id: '200'})).events.length, 0);
  assert.equal(
    ok(await f.call({account_id: 'act_100', gateway: 'meta_native_action', search: 'native_read'})).events.length,
    1,
  );
});

test('authenticated Activity shares account-scoped history and refuses invalid filters without provider access', async t => {
  const f = fixture(t),
    options = {origin: 'https://history.example.test', masterKey: Buffer.alloc(32, 98).toString('base64'), authEnv: {}};
  const web = new WebStore(f.store, options),
    accounts = new UserAccounts(web),
    user = accounts.newUser('History reader', 'history@example.test', null, true);
  Object.assign(f.actor, {tenantId: user.tenant_id, userId: user.id, ownerUserId: user.id});
  f.store.db
    .prepare("UPDATE workspace_memberships SET role='viewer' WHERE tenant_id=? AND user_id=?")
    .run(user.tenant_id, user.id);
  f.store.putConnection(
    {tenantId: f.actor.tenantId, userId: 'synthetic-provisioner', role: 'admin'},
    {...f.connection, tenantId: f.actor.tenantId},
    {accessToken: 'synthetic'},
  );
  const session = web.createSession(f.actor),
    listener = await listenForFetch(createHttpApp(f.service, f.store, {website: options}));
  try {
    f.append(f.event());
    f.append(f.event('200'));
    const base = 'http://127.0.0.1:' + listener.address().port,
      headers = {Cookie: web.cookie(session.id)};
    assert.equal((await fetch(base + '/api/activity')).status, 401);
    const response = await fetch(base + '/api/activity?limit=1', {headers}),
      result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].event.account_id, '100');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|"200"/);
    f.store.db
      .prepare("UPDATE workspace_memberships SET role='admin' WHERE tenant_id=? AND user_id=?")
      .run(user.tenant_id, user.id);
    const admin = await fetch(base + '/api/activity', {headers});
    const adminPage = await admin.json();
    assert.equal(admin.status, 200);
    assert.equal(adminPage.events.length, 1, 'Generic workspace administration is not ownership');
    assert.doesNotMatch(JSON.stringify(adminPage), /PRIVATE-|"200"/);
    const bad = await fetch(base + '/api/activity?limit=101', {headers});
    assert.equal(bad.status, 400);
    await bad.text();
    f.store.db
      .prepare('UPDATE workspace_memberships SET active=0 WHERE tenant_id=? AND user_id=?')
      .run(user.tenant_id, user.id);
    const revoked = await fetch(base + '/api/activity', {headers});
    assert.equal(revoked.status, 401);
    await revoked.text();
  } finally {
    await new Promise(resolve => {
      listener.close(resolve);
      listener.closeAllConnections();
    });
  }
});
