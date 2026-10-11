// CON-02 track B: in-place reauthorization for every browser-OAuth login. Before this, only Google Ads could renew
// in place: every other platform threw REAUTHORIZATION_UNAVAILABLE and the only path was "Connect another", which
// orphaned saved queries, schedules and write grants on the dead connection. These tests fail on that code.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {MirrorError} from '../dist/src/errors.js';
import {scopeKey} from '../dist/src/security.js';
import {platforms, selectionKind} from '../dist/server/platform-oauth.js';
import {
  authorizationRevision,
  reauthorizationEnabled,
  reauthorizeConnection,
} from '../dist/server/connection-reauthorization.js';
import {providerGrant} from '../dist/src/provider-grants.js';
import {refreshEndpoints, storedHealth} from '../dist/src/connection-health.js';

const key = Buffer.alloc(32, 29).toString('base64'),
  actor = {tenantId: 'reauthorization', userId: 'owner', role: 'admin'},
  connectionId = 'saved-login';
/** Every browser-OAuth platform except Google Ads, which keeps its own manager-route verification. */
const oauthPlatforms = platforms.filter(p => !p.authType && p.id !== 'google');

const accountFor = p => (p.gateway === 'microsoft_ads_native_action' ? '1001' : p.id + '-account');
const scopesFor = p => {
  const g = providerGrant(p.gateway);
  return [...(g?.requestedRead ?? []), ...(g?.requestedWrite ?? [])];
};
const renewable = p => !!refreshEndpoints[p.gateway];
const credentialsFor = (p, version) =>
  p.id === 'x'
    ? {consumerKey: 'x-client', consumerSecret: 'x-secret', accessToken: version + '-access', tokenSecret: version}
    : {
        accessToken: version + '-access',
        clientId: p.id + '-client',
        clientSecret: p.id + '-secret',
        ...(renewable(p) ? {refreshToken: version + '-refresh', redirectUri: 'https://amcp.shop/cb'} : {}),
        expiresAt: Date.now() + 3600000,
      };
function fixture(p, extra = {}) {
  const store = new Store(':memory:', key),
    account = accountFor(p),
    kind = selectionKind(p.gateway),
    keys = [kind + ':' + account, ...(p.id === 'drive' ? ['folders:drive-folder'] : [])],
    accounts = keys.map(k => k.slice(k.indexOf(':') + 1)),
    writes = p.reviewedWrites === false ? [] : [account];
  const connection = {
    id: connectionId,
    tenantId: actor.tenantId,
    gateway: p.gateway,
    label: 'Saved ' + p.name,
    enabled: true,
    isDefault: true,
    accounts,
    writeAccounts: writes,
    defaultWriteAccess: writes.length > 0,
    scopes: scopesFor(p),
    ...(p.gateway === 'microsoft_ads_native_action' ? {accountCustomers: {[account]: '2002'}} : {}),
    ...extra,
  };
  store.putConnection(actor, connection, credentialsFor(p, 'old'));
  store.putDocument(actor.tenantId, 'website_assets', connectionId, {
    groups: [{kind, complete: true, assets: [{id: account, kind, name: account}]}],
    selected: keys,
    lastSync: 1,
  });
  store.putDocument(actor.tenantId, 'website_connection', connectionId, {platform: p.id, createdAt: 1});
  store.putDocument(actor.tenantId, 'reporting_query', 'saved-query', {
    connection_id: connectionId,
    account_id: account,
  });
  store.putDocument(actor.tenantId, 'reporting_schedule', 'saved-schedule', {
    schedule_config: {query_id: 'saved-query'},
    is_active: true,
  });
  return {store, connection, keys, account};
}
/** Synthetic read-only discovery with the candidate credentials: the provider reports exactly `visible`. */
const discovery = (visible, options = {}) => {
  const d = {
    calls: 0,
    async discoverWith(c, credentials, kinds, check) {
      d.calls++;
      d.credentials = credentials;
      options.during?.();
      check();
      return {
        groups: kinds.map(kind => ({
          kind,
          complete: options.complete ?? true,
          assets: visible
            .filter(k => k.startsWith(kind + ':'))
            .map(k => ({id: k.slice(kind.length + 1), kind, name: 'Fresh ' + k, parentId: '3003'})),
          ...(options.complete === false ? {error: 'Synthetic listing failure', diagnostics: []} : {}),
        })),
        identity: options.identity,
      };
    },
  };
  return d;
};
const renew = (store, p, d, extra = {}) =>
  reauthorizeConnection({
    store,
    actor,
    platform: p,
    connectionId,
    revision: authorizationRevision(store, actor.tenantId, connectionId),
    credentials: credentialsFor(p, 'fresh'),
    scopes: scopesFor(p),
    allowWrites: true,
    assertActive: () => {},
    discovery: d,
    ...extra,
  });
const events = (store, name) => store.audit(actor.tenantId).filter(r => JSON.parse(r.event).event === name);

test('every browser-OAuth platform except Google Ads is covered by in-place reauthorization', () => {
  assert.deepEqual(oauthPlatforms.map(p => p.id).sort(), [
    'drive',
    'dv360',
    'ga4',
    'gsc',
    'gtm',
    'linkedin',
    'meta',
    'microsoft',
    'reddit',
    'sheets',
    'snapchat',
    'tiktok',
    'x',
  ]);
  for (const p of oauthPlatforms) assert.equal(reauthorizationEnabled(p, {}), true, p.id);
  assert.equal(
    reauthorizationEnabled(
      platforms.find(p => p.id === 'apple'),
      {},
    ),
    false,
  );
  // The per-platform rollback flag restores "Connect another".
  assert.equal(
    reauthorizationEnabled(
      platforms.find(p => p.id === 'meta'),
      {AMCP_REAUTHORIZATION_DISABLED: 'meta'},
    ),
    false,
  );
  assert.equal(
    reauthorizationEnabled(
      platforms.find(p => p.id === 'x'),
      {AMCP_REAUTHORIZATION_DISABLED: 'all'},
    ),
    false,
  );
});

for (const p of oauthPlatforms) {
  test(p.name + ': renewal keeps the connection id, selections, saved query, schedule and write grants', async () => {
    const {store, keys, account} = fixture(p);
    try {
      const before = store.listConnections(actor.tenantId)[0],
        query = store.document(actor.tenantId, 'reporting_query', 'saved-query'),
        schedule = store.document(actor.tenantId, 'reporting_schedule', 'saved-schedule'),
        d = discovery(keys);
      const next = await renew(store, p, d);
      assert.equal(d.calls, 1);
      assert.equal(d.credentials.accessToken, 'fresh-access', 'verification used the candidate credentials');
      assert.equal(store.listConnections(actor.tenantId).length, 1);
      assert.equal(next.id, connectionId);
      assert.equal(next.isDefault, true);
      assert.deepEqual(next.accounts, before.accounts);
      assert.deepEqual(next.writeAccounts, before.writeAccounts);
      assert.equal(next.loginRevision, (before.loginRevision ?? 0) + 1, 'the renewal is a new login (CON-01)');
      assert.equal(store.credentials(actor.tenantId, connectionId).accessToken, 'fresh-access');
      assert.deepEqual(store.document(actor.tenantId, 'website_assets', connectionId).selected, keys);
      assert.deepEqual(store.document(actor.tenantId, 'reporting_query', 'saved-query'), query);
      assert.deepEqual(store.document(actor.tenantId, 'reporting_schedule', 'saved-schedule'), schedule);
      assert.ok(authorizationRevision(store, actor.tenantId, connectionId));
      assert.equal(storedHealth(store, next).state, 'healthy');
      const audit = events(store, 'website_oauth_reauthorized');
      assert.equal(audit.length, 1);
      assert.equal(JSON.parse(audit[0].event).connection_id, connectionId);
      if (p.gateway === 'microsoft_ads_native_action') assert.deepEqual(next.accountCustomers, {[account]: '3003'});
    } finally {
      store.close();
    }
  });

  test(p.name + ': an account the fresh login cannot see keeps the old credentials and grants', async () => {
    const {store, keys} = fixture(p);
    try {
      const before = store.credentials(actor.tenantId, connectionId);
      await assert.rejects(
        renew(store, p, discovery(keys.slice(1))),
        e => e.code === 'REAUTHORIZATION_ACCOUNT_MISMATCH' && e.details.account_ids.length >= 1,
      );
      assert.deepEqual(store.credentials(actor.tenantId, connectionId), before);
      assert.equal(authorizationRevision(store, actor.tenantId, connectionId), null);
      assert.equal(events(store, 'website_oauth_reauthorized').length, 0);
    } finally {
      store.close();
    }
  });

  const read = providerGrant(p.gateway)?.read;
  if (read)
    test(p.name + ': a renewal without the read permission is refused before any provider request', async () => {
      const {store, keys} = fixture(p);
      try {
        const before = store.credentials(actor.tenantId, connectionId),
          d = discovery(keys);
        await assert.rejects(renew(store, p, d, {scopes: []}), {code: 'INSUFFICIENT_SCOPE'});
        assert.equal(d.calls, 0);
        assert.deepEqual(store.credentials(actor.tenantId, connectionId), before);
      } finally {
        store.close();
      }
    });

  if (renewable(p))
    test(p.name + ': a renewal without offline access cannot replace a self-renewing login', async () => {
      const {store, keys} = fixture(p);
      try {
        const d = discovery(keys);
        await assert.rejects(
          renew(store, p, d, {credentials: {...credentialsFor(p, 'fresh'), refreshToken: undefined}}),
          {code: 'REAUTHORIZATION_REQUIRED'},
        );
        assert.equal(d.calls, 0);
        assert.equal(store.credentials(actor.tenantId, connectionId).accessToken, 'old-access');
      } finally {
        store.close();
      }
    });
}

test('write grants are removed, visibly and audited, when the renewal no longer carries the write permission', async () => {
  for (const id of ['meta', 'linkedin', 'reddit', 'gtm', 'gsc']) {
    const p = platforms.find(x => x.id === id),
      {store, keys, account} = fixture(p),
      readOnly = providerGrant(p.gateway).requestedRead.filter(s => !(id === 'reddit' && s === 'adsedit'));
    try {
      const next = await renew(store, p, discovery(keys), {scopes: readOnly});
      assert.deepEqual(next.writeAccounts, [], id);
      assert.equal(next.defaultWriteAccess, false, id);
      assert.deepEqual(next.accounts, [account], 'reads stay granted');
      const change = events(store, 'website_write_access_changed').map(r => JSON.parse(r.event));
      assert.equal(change.length, 1, id);
      assert.deepEqual(change[0].previous_write_accounts, [account]);
      assert.equal(change[0].reason, 'reauthorization_without_write_permission');
    } finally {
      store.close();
    }
  }
  // A read-only deployment keeps no write grant either, for platforms whose read and write scope are the same.
  const p = platforms.find(x => x.id === 'snapchat'),
    {store, keys} = fixture(p);
  try {
    assert.deepEqual((await renew(store, p, discovery(keys), {allowWrites: false})).writeAccounts, []);
  } finally {
    store.close();
  }
});

test('a different provider identity is refused where the provider states one (owner decision D19)', async () => {
  for (const [id, saved, option] of [
    ['meta', '1000001', {identity: '2000002'}],
    ['microsoft', '42', {identity: '43'}],
    ['x', 'x-user-1', {}],
  ]) {
    const p = platforms.find(x => x.id === id),
      {store, keys} = fixture(p);
    try {
      store.putDocument(actor.tenantId, 'website_connection', connectionId, {platform: id, providerId: saved});
      await assert.rejects(renew(store, p, discovery(keys, option), id === 'x' ? {providerId: 'x-user-2'} : {}), {
        code: 'REAUTHORIZATION_IDENTITY_MISMATCH',
      });
      assert.equal(store.credentials(actor.tenantId, connectionId).accessToken, 'old-access', id);
      // The same identity renews.
      await renew(
        store,
        p,
        discovery(keys, id === 'x' ? {} : {identity: saved}),
        id === 'x' ? {providerId: saved} : {},
      );
      assert.equal(store.credentials(actor.tenantId, connectionId).accessToken, 'fresh-access', id);
      assert.equal(JSON.parse(events(store, 'website_oauth_reauthorized')[0].event).identity, 'matched');
    } finally {
      store.close();
    }
  }
});

test('a failed primary listing proves nothing: even an unselected login keeps its old credentials', async () => {
  const p = platforms.find(x => x.id === 'tiktok'),
    {store} = fixture(p, {accounts: [], writeAccounts: [], enabled: false});
  try {
    store.putDocument(actor.tenantId, 'website_assets', connectionId, {groups: [], selected: []});
    await assert.rejects(renew(store, p, discovery([], {complete: false})), {code: 'REAUTHORIZATION_ACCESS_FAILED'});
    assert.equal(store.credentials(actor.tenantId, connectionId).accessToken, 'old-access');
  } finally {
    store.close();
  }
});

test('concurrent refresh, disconnect, replacement and narrowed selections are fenced', async () => {
  const p = platforms.find(x => x.id === 'linkedin');
  // A refresh holding the lock refuses the renewal; the saved login is kept.
  {
    const {store, keys} = fixture(p);
    try {
      assert.equal(store.acquireLock('refresh:' + scopeKey(actor.tenantId, connectionId), 'refresh', 45000), true);
      await assert.rejects(renew(store, p, discovery(keys)), {code: 'REFRESH_IN_PROGRESS'});
      assert.equal(store.credentials(actor.tenantId, connectionId).accessToken, 'old-access');
      // QA-02 exit: once the refresh lets go of its lock, the same renewal completes.
      store.releaseLock('refresh:' + scopeKey(actor.tenantId, connectionId), 'refresh');
      await renew(store, p, discovery(keys));
      assert.equal(store.credentials(actor.tenantId, connectionId).accessToken, 'fresh-access');
    } finally {
      store.close();
    }
  }
  // A refresh of the old login that completes after the renewal cannot overwrite the fresh credentials.
  {
    const {store, keys, connection} = fixture(p);
    try {
      const old = store.credentials(actor.tenantId, connectionId);
      await renew(store, p, discovery(keys));
      assert.throws(
        () => store.completeCredentialRefresh(connection, old, {...old, accessToken: 'late-refresh'}),
        e => e instanceof MirrorError && e.code === 'CONNECTION_CHANGED',
      );
      assert.equal(store.credentials(actor.tenantId, connectionId).accessToken, 'fresh-access');
    } finally {
      store.close();
    }
  }
  // A routine refresh during verification is the same login, so the renewal still completes (CON-01).
  {
    const {store, keys, connection} = fixture(p);
    try {
      const during = () => {
        const held = store.connectionCredentials(connection);
        store.completeCredentialRefresh(connection, held, {...held, accessToken: 'refreshed-meanwhile'});
      };
      await renew(store, p, discovery(keys, {during}));
      assert.equal(store.credentials(actor.tenantId, connectionId).accessToken, 'fresh-access');
    } finally {
      store.close();
    }
  }
  // Disconnect or a replacement login during verification refuses without recreating or overwriting anything.
  for (const [mode, code] of [
    ['disconnect', 'CONNECTION_NOT_FOUND'],
    ['replace', 'CONNECTION_CHANGED'],
    ['revision', 'CONNECTION_CHANGED'],
  ]) {
    const {store, keys, connection} = fixture(p);
    try {
      const during = () => {
        if (mode === 'disconnect')
          store.db.prepare('DELETE FROM connections WHERE tenant_id=? AND id=?').run(actor.tenantId, connectionId);
        else if (mode === 'replace') store.putConnection(actor, connection, credentialsFor(p, 'other'));
        else store.putDocument(actor.tenantId, 'website_connection', connectionId, {authorizationRevision: 'newer'});
      };
      await assert.rejects(renew(store, p, discovery(keys, {during})), {code});
      if (mode === 'disconnect') assert.equal(store.listConnections(actor.tenantId).length, 0);
      else
        assert.equal(
          store.credentials(actor.tenantId, connectionId).accessToken,
          mode === 'replace' ? 'other-access' : 'old-access',
        );
    } finally {
      store.close();
    }
  }
  // Selections narrowed during verification stay narrowed; the renewal never restores a removed grant.
  {
    const {store, keys, connection} = fixture(p);
    try {
      const during = () =>
        store.updateConnection(actor, {...connection, accounts: [], writeAccounts: [], enabled: false});
      const next = await renew(store, p, discovery(keys, {during}));
      assert.deepEqual(next.accounts, []);
      assert.deepEqual(next.writeAccounts, []);
      assert.deepEqual(store.document(actor.tenantId, 'website_assets', connectionId).selected, []);
    } finally {
      store.close();
    }
  }
});

test('only a current workspace administrator can complete a renewal', async () => {
  const p = platforms.find(x => x.id === 'meta'),
    {store, keys} = fixture(p);
  try {
    await assert.rejects(renew(store, p, discovery(keys), {actor: {...actor, role: 'reader'}}), {code: 'FORBIDDEN'});
    let active = true;
    await assert.rejects(
      renew(store, p, discovery(keys, {during: () => (active = false)}), {
        assertActive: () => {
          if (!active) throw new MirrorError('SIGN_IN_REQUIRED', 'Synthetic session ended.', {}, 401);
        },
      }),
      {code: 'SIGN_IN_REQUIRED'},
    );
    assert.equal(store.credentials(actor.tenantId, connectionId).accessToken, 'old-access');
  } finally {
    store.close();
  }
});
