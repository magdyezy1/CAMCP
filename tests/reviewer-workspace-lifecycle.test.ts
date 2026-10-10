// SEC-06 S6 (review 2026-10-08, R04 shared-reviewer-workspace-lifecycle): the shared reviewer workspace kept every
// evaluator's provider login indefinitely, across reviewer password changes. A new reviewer password now removes the
// logins connected under the old one, a worker sweep removes logins older than 7 days, and Connections shows each
// reviewer login's age and removal date. Only the reviewer workspace is touched. Synthetic only; no provider calls.
import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {createHttpApp} from '../server/http-app.js';
import {WebStore} from '../server/web-store.js';
import {
  accountLifecycleSweeper,
  purgeReviewerConnections,
  reviewerConnectionLifetime,
} from '../server/account-lifecycle.js';
import type {Connection, JsonObject} from '../src/types.js';

const origin = 'https://amcp.shop',
  master = Buffer.alloc(32, 97).toString('base64'),
  adminPassword = 'synthetic-lifecycle-admin-door',
  day = 86400000;
function connect(store: Store, tenant: string, id: string, connectedAt: number | null) {
  store.ensureTenant(tenant);
  const c: Connection = {
    id,
    tenantId: tenant,
    gateway: 'meta_native_action',
    accounts: ['111'],
    label: 'Synthetic ' + id,
    enabled: true,
    scopes: ['ads_read'],
  };
  store.putConnection({tenantId: tenant, userId: 'synthetic', role: 'admin'}, c, {accessToken: 'synthetic-' + id});
  if (connectedAt !== null)
    store.putDocument(tenant, 'website_connection', id, {platform: 'meta', createdAt: connectedAt, expiresAt: null});
}
const ids = (store: Store, tenant: string) => store.listConnections(tenant).map(c => c.id);
const events = (store: Store) =>
  (
    store.db.prepare('SELECT tenant_id,event FROM audit ORDER BY seq').all() as {tenant_id: string; event: string}[]
  ).map(r => ({tenant: r.tenant_id, ...JSON.parse(r.event)}));

test('SEC-06 S6: a new reviewer password removes the reviewer workspace logins and nothing else', () => {
  const store = new Store(':memory:', master);
  try {
    const first = new WebStore(store, {
      origin,
      masterKey: master,
      adminPassword,
      testPassword: 'first-reviewer-password',
    });
    const reviewers = first.testTenantId;
    connect(store, reviewers, 'reviewer-login-a', Date.now() - day);
    connect(store, reviewers, 'reviewer-login-b', null);
    connect(store, 'local', 'owner-login', Date.now() - 30 * day);
    // The same password again changes nothing.
    new WebStore(store, {origin, masterKey: master, adminPassword, testPassword: 'first-reviewer-password'});
    assert.deepEqual(ids(store, reviewers).sort(), ['reviewer-login-a', 'reviewer-login-b']);
    new WebStore(store, {origin, masterKey: master, adminPassword, testPassword: 'second-reviewer-password'});
    assert.deepEqual(ids(store, reviewers), []);
    assert.deepEqual(ids(store, 'local'), ['owner-login'], 'the owner workspace is untouched');
    assert.equal(store.credentials('local', 'owner-login').accessToken, 'synthetic-owner-login');
    const audit = events(store);
    assert.ok(
      audit.some(
        e =>
          e.tenant === reviewers &&
          e.event === 'reviewer_connections_purged' &&
          e.reason === 'reviewer_password_change' &&
          e.connections === 2,
      ),
    );
    // Each login went the way a disconnect goes: a receipt and its own audit entry, no provider request.
    assert.equal(store.documents(reviewers, 'connection_disconnection').length, 2);
    assert.equal(audit.filter(e => e.tenant === reviewers && e.event === 'website_local_disconnect').length, 2);
    // Changing the administrator password never touches reviewer or owner logins.
    connect(store, reviewers, 'reviewer-login-c', Date.now());
    new WebStore(store, {
      origin,
      masterKey: master,
      adminPassword: 'another-synthetic-admin-door',
      testPassword: 'second-reviewer-password',
    });
    assert.deepEqual(ids(store, reviewers), ['reviewer-login-c']);
    assert.deepEqual(ids(store, 'local'), ['owner-login']);
  } finally {
    store.close();
  }
});

test('SEC-06 S6: the hourly sweep removes reviewer logins older than their lifetime', () => {
  assert.equal(reviewerConnectionLifetime({}), 7 * day);
  assert.equal(reviewerConnectionLifetime({AMCP_REVIEWER_CONNECTION_DAYS: '2'}), 2 * day);
  assert.equal(reviewerConnectionLifetime({AMCP_REVIEWER_CONNECTION_DAYS: 'off'}), null);
  assert.throws(() => reviewerConnectionLifetime({AMCP_REVIEWER_CONNECTION_DAYS: '0'}), /1 to 90/);
  const store = new Store(':memory:', master);
  try {
    let now = Date.now();
    connect(store, 'local-test', 'old-login', now - 8 * day);
    connect(store, 'local-test', 'new-login', now - day);
    connect(store, 'local', 'owner-login', now - 400 * day);
    connect(store, 'other-test-like', 'unrelated-login', now - 400 * day);
    const sweep = accountLifecycleSweeper(store, {tenantId: 'local', env: {}, now: () => now});
    assert.deepEqual(sweep(), {reviewer_connections: 1});
    assert.deepEqual(ids(store, 'local-test'), ['new-login']);
    assert.deepEqual(ids(store, 'local'), ['owner-login']);
    assert.deepEqual(ids(store, 'other-test-like'), ['unrelated-login']);
    // At most once an hour.
    now += 3600000 - 1;
    assert.equal(sweep(), undefined);
    now += 7 * day;
    assert.deepEqual(sweep(), {reviewer_connections: 1});
    assert.deepEqual(ids(store, 'local-test'), []);
    assert.ok(
      events(store).some(e => e.event === 'reviewer_connections_purged' && e.reason === 'reviewer_connection_expired'),
    );
    // Turned off, nothing is removed.
    connect(store, 'local-test', 'kept-login', now - 30 * day);
    assert.deepEqual(
      accountLifecycleSweeper(store, {tenantId: 'local', env: {AMCP_REVIEWER_CONNECTION_DAYS: 'off'}})(),
      {
        reviewer_connections: 0,
      },
    );
    assert.deepEqual(purgeReviewerConnections(store, 'local-test', 'reviewer_connection_expired', now - 31 * day), {
      connections: 0,
    });
  } finally {
    store.close();
  }
});

test('SEC-06 S6: Connections shows a reviewer login’s age and removal date', async () => {
  const store = new Store(':memory:', master),
    service = new MirrorService(new Registry(), store, undefined, undefined, {
      allowWrites: false,
      maxBudgetChange: 0,
      requireBeforeState: true,
    });
  const testPassword = 'synthetic-lifecycle-reviewer-door';
  const listener = await listenForFetch(
    createHttpApp(service, store, {
      publicOrigin: origin,
      website: {
        origin,
        masterKey: master,
        adminPassword,
        testPassword,
        authEnv: {AMCP_REVIEWER_CONNECTION_DAYS: '3'},
        fetcher: async () => {
          throw Error('No provider traffic allowed');
        },
      },
    }),
  );
  const base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  try {
    const signIn = async (url: string, password: string) => {
      const r = await fetch(base + url, {
        method: 'POST',
        headers: {Origin: origin, 'Content-Type': 'application/json'},
        body: JSON.stringify({password}),
      });
      assert.equal(r.status, 200);
      return r.headers.get('set-cookie')!.split(';')[0]!;
    };
    const connected = Date.now() - day;
    connect(store, 'local-test', 'reviewer-login', connected);
    connect(store, 'local', 'owner-login', connected);
    const platforms = async (cookie: string) =>
      (
        (await (await fetch(base + '/api/platforms', {headers: {Cookie: cookie}})).json()) as {
          platforms: {connections: JsonObject[]}[];
        }
      ).platforms.flatMap(p => p.connections);
    const reviewer = (await platforms(await signIn('/api/session/test', testPassword)))[0]!;
    assert.equal(reviewer.id, 'reviewer-login');
    assert.equal(reviewer.connectedAt, connected);
    assert.equal(reviewer.reviewerRemovesAt, connected + 3 * day);
    const owner = (await platforms(await signIn('/api/session', adminPassword)))[0]!;
    assert.equal(owner.id, 'owner-login');
    assert.equal('reviewerRemovesAt' in owner, false);
  } finally {
    await new Promise<void>(resolve => listener.close(() => resolve()));
    store.close();
  }
});
