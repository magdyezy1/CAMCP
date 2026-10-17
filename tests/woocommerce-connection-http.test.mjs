import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebsite} from '../dist/server/website.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {wooConnectionFixture, wooConnectionInput} from './fixtures/woocommerce-connection-data.mjs';
import {offerParkedProviders} from './helpers/parked-providers.mjs';

// WooCommerce is parked (ARC-01, P9): this suite exercises it, so it offers it like a
// deployment whose AMCP_PROVIDERS names it.
offerParkedProviders('woocommerce');

async function fixture(t, {role = 'owner', testAccount = false, encryption = true} = {}) {
  const f = wooConnectionFixture({encryption}),
    origin = 'https://synthetic-setup.amcp.invalid',
    options = {
      origin,
      masterKey: Buffer.alloc(32, f.keyByte).toString('base64'),
      tenantId: f.actor.tenantId,
      authEnv: {},
      fetcher: async () => {
        throw Error('Unexpected generic egress');
      },
    },
    {web, accounts} = createWebsite(f.store, options, true, f.service),
    user = accounts.newUser('Synthetic setup owner', null, null, true);
  if (testAccount) f.store.db.prepare('UPDATE amcp_users SET test_account=1 WHERE id=?').run(user.id);
  f.store.db
    .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
    .run(f.actor.tenantId, user.id, role, Date.now());
  const session = accounts.session(accounts.user(user.id), f.actor.tenantId),
    listener = await listenForFetch(createHttpApp(f.service, f.store, {website: options}));
  t.after(async () => {
    listener.closeAllConnections();
    await new Promise(r => listener.close(r));
    f.close();
  });
  const request = async (path = '/api/commerce/stores', method = 'POST', body = wooConnectionInput(), extra = {}) => {
    const response = await fetch('http://127.0.0.1:' + listener.address().port + path, {
        method,
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          Cookie: web.cookieName + '=' + session.id,
          'X-AMCP-CSRF': session.csrf,
          ...extra,
        },
        body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(body),
        redirect: 'manual',
      }),
      bytes = await response.arrayBuffer();
    return {status: response.status, headers: response.headers, body: JSON.parse(Buffer.from(bytes).toString())};
  };
  return {...f, web, accounts, user, session, request};
}
test('HTTP setup has administrator, Origin, CSRF, no-store and encrypted source-only boundaries with idempotent recovery', async t => {
  const f = await fixture(t);
  for (const headers of [{'X-AMCP-CSRF': 'wrong'}, {Origin: 'https://other.invalid'}, {Cookie: ''}]) {
    const out = await f.request(undefined, undefined, undefined, headers);
    assert.ok([401, 403].includes(out.status));
    assert.equal(f.calls.length, 0);
  }
  const out = await f.request();
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.headers.get('cache-control'), 'no-store');
  assert.equal(out.body.read_access_verified, true);
  assert.equal(out.body.writes_enabled, false);
  assert.equal(f.calls.length, 3);
  const replay = await f.request();
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(f.calls.length, 3);
  const platforms = await f.request('/api/platforms', 'GET');
  assert.equal(platforms.body.commerce_sources.length, 1);
  assert.equal(platforms.body.commerce_sources[0].connection_id, out.body.connection_id);
  assert.doesNotMatch(
    JSON.stringify([out.body, replay.body, platforms.body.commerce_sources]),
    /setupSynthetic|PRIVATE-SETUP-NATIVE|consumer_secret|consumerSecret|Authorization/,
  );
});
for (const role of ['viewer', 'operator'])
  test('HTTP WooCommerce setup is unavailable to ' + role, async t => {
    const f = await fixture(t, {role}),
      out = await f.request();
    assert.equal(out.status, 403);
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.listConnections(f.actor.tenantId).length, 0);
  });
test('evaluator owners cannot access the new setup or removal routes through spelling variations', async t => {
  const f = await fixture(t, {testAccount: true});
  for (const path of ['/api/commerce/stores', '/API/commerce/stores', '/api/Commerce/stores']) {
    const out = await f.request(path);
    assert.equal(out.status, 403);
    assert.equal(out.body.error.code, 'TEST_ACCOUNT_SCOPE');
  }
  const removed = await f.request('/api/commerce/stores/' + wooConnectionInput().connection_id, 'DELETE', {
    confirmed: true,
  });
  assert.equal(removed.status, 403);
  assert.equal(f.calls.length, 0);
});
test('even a write-enabled deployment cannot turn a WooCommerce source into write access or generic asset discovery', async t => {
  const f = await fixture(t),
    connected = await f.request(),
    id = connected.body.connection_id;
  for (const [suffix, method, body] of [
    ['sync', 'POST', {}],
    ['assets', 'PATCH', {selected: ['ad_accounts:' + connected.body.account_id], write_access: true}],
    ['write-access', 'PATCH', {accounts: [connected.body.account_id], confirmed: true}],
  ]) {
    const out = await f.request('/api/connections/' + id + '/' + suffix, method, body);
    assert.equal(out.status, 400);
    assert.equal(out.body.error.code, 'SOURCE_READ_ONLY');
  }
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.store.listConnections(f.actor.tenantId)[0].writeAccounts, []);
});
test('HTTP local disconnect requires explicit confirmation, changes no native key, purges encrypted proof and replays its receipt', async t => {
  const f = await fixture(t),
    connected = await f.request(),
    id = connected.body.connection_id;
  const notConfirmed = await f.request('/api/commerce/stores/' + id, 'DELETE', {confirmed: false});
  assert.equal(notConfirmed.status, 400);
  assert.equal(f.store.listConnections(f.actor.tenantId).length, 1);
  const out = await f.request('/api/commerce/stores/' + id, 'DELETE', {confirmed: true});
  assert.equal(out.status, 200);
  assert.equal(out.body.disconnected, true);
  assert.equal(out.body.provider_changes, 0);
  assert.equal(out.body.network_requests, 0);
  assert.equal(f.store.listConnections(f.actor.tenantId).length, 0);
  assert.equal(f.store.documents(f.actor.tenantId, 'website_connection').length, 0);
  assert.equal(f.calls.length, 3);
  const replay = await f.request('/api/commerce/stores/' + id, 'DELETE', {confirmed: true});
  assert.equal(replay.body.replayed, true);
  const restore = await f.request();
  assert.equal(restore.status, 409);
  assert.equal(restore.body.error.code, 'WOOCOMMERCE_CONNECTION_CONFLICT');
  assert.equal(f.calls.length, 3);
});
for (const mode of ['session', 'membership', 'role'])
  test('HTTP setup stops on current ' + mode + ' withdrawal before saving and cancels the response body', async t => {
    const f = await fixture(t);
    let cancelled = 0;
    f.respond((url, options, n, native) => {
      if (n !== 2) return native(url);
      if (mode === 'session') f.web.signOut(f.session.id);
      if (mode === 'membership')
        f.store.db
          .prepare('UPDATE workspace_memberships SET active=0 WHERE tenant_id=? AND user_id=?')
          .run(f.actor.tenantId, f.user.id);
      if (mode === 'role')
        f.store.db
          .prepare("UPDATE workspace_memberships SET role='viewer' WHERE tenant_id=? AND user_id=?")
          .run(f.actor.tenantId, f.user.id);
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        {headers: {'content-type': 'application/json'}},
      );
    });
    const out = await f.request();
    assert.ok([401, 403].includes(out.status));
    assert.equal(f.calls.length, 2);
    assert.equal(cancelled, 1);
    assert.equal(f.store.listConnections(f.actor.tenantId).length, 0);
    assert.equal(f.store.documents(f.actor.tenantId, 'website_connection').length, 0);
    assert.doesNotMatch(JSON.stringify(out.body), /setupSynthetic|PRIVATE|read_access_verified|native_currency/);
  });
test('HTTP setup refuses unexpected body keys and excessive body size without credential egress', async t => {
  const f = await fixture(t);
  const extra = await f.request(undefined, undefined, wooConnectionInput({provider_mutations: 1}));
  assert.equal(extra.status, 400);
  const oversized = await f.request(undefined, undefined, wooConnectionInput({label: 'x'.repeat(5000)}));
  assert.equal(oversized.status, 413);
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.listConnections(f.actor.tenantId).length, 0);
});

test('HTTP setup checks store encryption before sending a key even when website account security is configured', async t => {
  const f = await fixture(t, {encryption: false}),
    out = await f.request();
  assert.equal(out.status, 503);
  assert.equal(out.body.error.code, 'ENCRYPTION_REQUIRED');
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.listConnections(f.actor.tenantId).length, 0);
});
