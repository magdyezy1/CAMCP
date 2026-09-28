import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {AssetDiscovery} from '../server/asset-discovery.js';
import {platforms} from '../server/platform-oauth.js';
import {MirrorError} from '../src/errors.js';
import type {Connection, Credentials} from '../src/types.js';

const key = Buffer.alloc(32, 67).toString('base64'),
  owner = {tenantId: 'synthetic-discovery', userId: 'owner', role: 'admin' as const};
const connection = (gateway: string): Connection => ({
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: owner.tenantId,
  gateway,
  enabled: true,
  label: 'Synthetic',
  accounts: ['123'],
  writeAccounts: [],
  scopes: [],
  userAgent: 'amcp-test/1.0 (by /u/synthetic)',
});
const auth: Credentials = {
  accessToken: 'synthetic',
  clientId: 'synthetic-app',
  clientSecret: 'synthetic-secret',
  consumerKey: 'synthetic-consumer',
  consumerSecret: 'synthetic-consumer-secret',
  tokenSecret: 'synthetic-user-secret',
  developerToken: 'synthetic-developer',
};

// Every website provider traverses the real NativeTransport retry implementation.
for (const p of platforms)
  for (const mode of ['actor', 'login'] as const)
    test(p.id + ' discovery stops ' + mode + ' revocation before retry', async () => {
      const store = new Store(':memory:', key),
        c = connection(p.gateway);
      try {
        store.putConnection(owner, c, auth);
        let calls = 0,
          active = true;
        const discovery = new AssetDiscovery(store, async () => {
          calls++;
          if (mode === 'actor') active = false;
          else store.putConnection(owner, c, {...auth, accessToken: 'replacement'});
          return Response.json({}, {status: 503});
        });
        await assert.rejects(
          discovery.sync(c, undefined, () => {
            if (!active) throw new MirrorError('FORBIDDEN', 'Synthetic session revoked.', {}, 403);
          }),
          (e: MirrorError) => e.code === (mode === 'actor' ? 'FORBIDDEN' : 'CONNECTION_CHANGED'),
        );
        assert.equal(calls, 1);
      } finally {
        store.close();
      }
    });

for (const mode of ['actor', 'login', 'scope', 'disconnect'] as const)
  test('a successful discovery response is withheld after ' + mode + ' changes', async () => {
    const store = new Store(':memory:', key),
      c = {...connection('ga4_native_action'), scopes: ['https://www.googleapis.com/auth/analytics.readonly']};
    try {
      store.putConnection(owner, c, auth);
      let calls = 0,
        active = true;
      const discovery = new AssetDiscovery(store, async () => {
        calls++;
        if (mode === 'actor') active = false;
        else if (mode === 'disconnect')
          store.db.prepare('DELETE FROM connections WHERE tenant_id=? AND id=?').run(c.tenantId, c.id);
        else
          store.putConnection(
            owner,
            {...c, scopes: mode === 'scope' ? [] : c.scopes},
            {...auth, accessToken: mode === 'login' ? 'replacement' : 'synthetic'},
          );
        return Response.json({accountSummaries: []});
      });
      await assert.rejects(
        discovery.sync(c, undefined, () => {
          if (!active) throw new MirrorError('FORBIDDEN', 'Synthetic session revoked.', {}, 403);
        }),
        (e: MirrorError) =>
          e.code ===
          {
            actor: 'FORBIDDEN',
            login: 'CONNECTION_CHANGED',
            scope: 'INSUFFICIENT_SCOPE',
            disconnect: 'CONNECTION_NOT_FOUND',
          }[mode],
      );
      assert.equal(calls, 1);
    } finally {
      store.close();
    }
  });

test('simultaneous workspaces on one discovery instance retain independent login and session guards', async () => {
  const store = new Store(':memory:', key),
    a = connection('ga4_native_action'),
    b = {...a, tenantId: 'other-synthetic-workspace'};
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(r => (release = r)),
    arrived = new Promise<void>(r => (started = r));
  try {
    store.putConnection(owner, a, {accessToken: 'first'});
    store.putConnection({...owner, tenantId: b.tenantId}, b, {accessToken: 'second'});
    let active = true;
    const discovery = new AssetDiscovery(store, async (_u, init) => {
      if (new Headers(init?.headers).get('Authorization') === 'Bearer first') {
        started();
        await gate;
      }
      return Response.json({accountSummaries: []});
    });
    const pending = discovery.sync(a, undefined, () => {
      if (!active) throw new MirrorError('FORBIDDEN', 'First session ended.', {}, 403);
    });
    await arrived;
    const other = await discovery.sync(b);
    assert.equal(other.groups[0]!.complete, true);
    active = false;
    release();
    await assert.rejects(pending, (e: MirrorError) => e.code === 'FORBIDDEN');
    other.assertCurrent();
  } finally {
    release?.();
    store.close();
  }
});

test('discovery exposes a final commit guard and keeps legitimate refreshed credentials', async () => {
  const store = new Store(':memory:', key),
    c = {...connection('ga4_native_action'), accounts: [], enabled: false};
  try {
    store.putConnection(owner, c, {
      accessToken: 'old',
      refreshToken: 'synthetic-refresh',
      clientId: 'synthetic',
      clientSecret: 'synthetic',
      expiresAt: Date.now() - 1,
    });
    let reads = 0;
    const discovery = new AssetDiscovery(store, async (url, init) => {
      if (String(url) === 'https://oauth2.googleapis.com/token')
        return Response.json({access_token: 'refreshed', expires_in: 3600});
      reads++;
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer refreshed');
      return Response.json({accountSummaries: []});
    });
    const result = await discovery.sync(c);
    assert.equal(result.groups[0]!.complete, true);
    assert.equal(reads, 1);
    result.assertCurrent();
    store.putConnection(owner, c, {accessToken: 'replacement'});
    assert.throws(result.assertCurrent, (e: MirrorError) => e.code === 'CONNECTION_CHANGED');
    assert.equal(store.listConnections(c.tenantId)[0]!.enabled, false);
  } finally {
    store.close();
  }
});
