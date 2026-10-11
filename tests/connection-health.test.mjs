// CON-02 track A: persisted credential health. Before this, a refresh rejection was thrown and never stored, so every
// tool call sent another token request (3 calls and 3 audit rows for 3 calls), Connections kept showing "Connected"
// and the first access token's expiry, and MCP status reported credential_health: 'not_inspected'. Each test below
// fails on that code.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {CredentialProvider} from '../dist/src/auth.js';
import {
  clearRefreshFailure,
  credentialHealth,
  loginExpiryWarningMs,
  recordAuthorized,
  recordedCredentialHealth,
  storedHealth,
} from '../dist/src/connection-health.js';
import {connectionDiagnostics} from '../dist/src/connection-diagnostics.js';

const key = Buffer.alloc(32, 83).toString('base64'),
  owner = {tenantId: 'credential-health', userId: 'owner', role: 'admin'},
  day = 86400000;
const linkedin = {
  id: 'linkedin-login',
  tenantId: owner.tenantId,
  gateway: 'linkedin_native_action',
  label: 'Synthetic LinkedIn',
  enabled: true,
  accounts: ['559535022'],
  writeAccounts: [],
  scopes: ['r_ads', 'r_ads_reporting'],
};
const expiring = () => ({
  accessToken: 'expiring-access',
  refreshToken: 'synthetic-refresh',
  clientId: 'synthetic-client',
  clientSecret: 'synthetic-secret',
  expiresAt: Date.now() - 1000,
});
function fixture(connection = linkedin, credentials = expiring()) {
  const store = new Store(':memory:', key);
  store.putConnection(owner, connection, credentials);
  return store;
}
const counting = respond => {
  const fetcher = async (url, init) => {
    fetcher.calls++;
    return respond(url, init);
  };
  fetcher.calls = 0;
  return fetcher;
};
const failures = store =>
  store.audit(owner.tenantId).filter(r => JSON.parse(r.event).event === 'token_refresh_failed').length;
const current = (store, id = linkedin.id) => store.listConnections(owner.tenantId).find(c => c.id === id);
// MCP connection status exists for GA4, Search Console and Business Profile (src/connection-diagnostics.ts).
const ga4 = {
  ...linkedin,
  id: '2b0f6f0e-5c1d-4d0a-9e2f-6a4c1b7d9e31',
  gateway: 'ga4_native_action',
  accounts: ['123'],
  scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
};

test('invalid_grant: exactly one token request, then fast REAUTHORIZATION_REQUIRED and one audit row until Retry', async () => {
  const store = fixture(ga4),
    current = s => s.listConnections(owner.tenantId).find(c => c.id === ga4.id);
  try {
    const fetcher = counting(() => Response.json({error: 'invalid_grant'}, {status: 400})),
      provider = new CredentialProvider(store, fetcher);
    await assert.rejects(provider.get(current(store)), {code: 'TOKEN_REFRESH_FAILED'});
    for (let i = 0; i < 3; i++)
      await assert.rejects(provider.get(current(store)), e => {
        assert.equal(e.code, 'REAUTHORIZATION_REQUIRED');
        assert.match(e.message, /no provider request was sent/);
        return true;
      });
    assert.equal(fetcher.calls, 1, 'the dead login is asked once, not once per tool call');
    assert.equal(failures(store), 1);
    const recorded = storedHealth(store, current(store));
    assert.equal(recorded.state, 'reauthorization_required');
    assert.deepEqual(
      {code: recorded.last_failure.code, http_status: recorded.last_failure.http_status},
      {code: 'invalid_grant', http_status: 400},
    );
    // MCP status reads the stored health and opens no credentials: a throwing fetcher would fail the call.
    const status = connectionDiagnostics(
      store,
      'ga4_native_action',
      'ga4_connection_ops',
      {action: 'status', connection_id: ga4.id},
      owner,
      false,
    );
    assert.equal(status.selected_connection.credential_health.state, 'reauthorization_required');
    assert.match(status.next_action, /reauthorize this login in place/);
    assert.equal(status.network_requests, 0);
    assert.equal(JSON.stringify(status).includes('synthetic-refresh'), false);
    // An administrator's explicit Retry lets the next request ask the provider again.
    assert.equal(clearRefreshFailure(store, current(store)), true);
    await assert.rejects(provider.get(current(store)), {code: 'TOKEN_REFRESH_FAILED'});
    assert.equal(fetcher.calls, 2);
  } finally {
    store.close();
  }
});

test('a network failure backs off without contacting the provider and never marks the login dead', async () => {
  const store = fixture();
  try {
    const fetcher = counting(() => {
        throw TypeError('synthetic network failure');
      }),
      provider = new CredentialProvider(store, fetcher);
    await assert.rejects(provider.get(current(store)), {code: 'TOKEN_REFRESH_FAILED'});
    await assert.rejects(provider.get(current(store)), e => e.code === 'TOKEN_REFRESH_FAILED' && e.retryable);
    assert.equal(fetcher.calls, 1, 'the back-off window sends no token request');
    const recorded = storedHealth(store, current(store));
    assert.equal(recorded.state, 'refresh_failed');
    assert.ok(recorded.next_retry_at > Date.now());
    assert.equal(
      credentialHealth(store, current(store), store.credentials(owner.tenantId, linkedin.id)).state,
      'refresh_failed',
    );
    // A token that is still valid keeps working during the back-off.
    store.completeCredentialRefresh(current(store), store.credentials(owner.tenantId, linkedin.id), {
      ...expiring(),
      expiresAt: Date.now() + 60000,
    });
    assert.equal((await provider.get(current(store))).expiresAt > Date.now(), true);
    assert.equal(fetcher.calls, 1);
  } finally {
    store.close();
  }
});

test('a successful refresh records healthy access and the LinkedIn login lifetime it states', async () => {
  const store = fixture();
  try {
    const before = Date.now(),
      provider = new CredentialProvider(
        store,
        counting(() =>
          Response.json({access_token: 'renewed-access', expires_in: 5184000, refresh_token_expires_in: 31536000}),
        ),
      );
    const next = await provider.get(current(store));
    const recorded = storedHealth(store, current(store));
    assert.equal(recorded.state, 'healthy');
    assert.equal(recorded.access_expires_at, next.expiresAt);
    assert.ok(recorded.access_expires_at >= before + 5184000 * 1000);
    assert.ok(recorded.login_expires_at >= before + 31536000 * 1000);
    assert.ok(recorded.last_refresh_at >= before);
    const view = credentialHealth(store, current(store), store.credentials(owner.tenantId, linkedin.id));
    assert.equal(view.renews_automatically, true);
    assert.equal(view.state, 'healthy');
  } finally {
    store.close();
  }
});

test('a Meta login within 7 days of expiry reads expiring, and one past expiry needs reauthorization', () => {
  const meta = {...linkedin, id: 'meta-login', gateway: 'meta_native_action', scopes: ['ads_read']};
  for (const [offset, state] of [
    [30 * day, 'healthy'],
    [loginExpiryWarningMs - day, 'expiring'],
    [-1000, 'reauthorization_required'],
  ]) {
    const credentials = {accessToken: 'meta-long-lived', expiresAt: Date.now() + offset},
      store = fixture(meta, credentials);
    try {
      const c = store.listConnections(owner.tenantId)[0];
      recordAuthorized(store, c, store.credentials(owner.tenantId, c.id));
      const view = credentialHealth(store, c, store.credentials(owner.tenantId, c.id));
      assert.equal(view.state, state);
      assert.equal(view.renews_automatically, false);
      assert.equal(view.login_expires_at, credentials.expiresAt);
      // MCP status agrees without opening the credentials.
      assert.equal(recordedCredentialHealth(store, c).state, state);
    } finally {
      store.close();
    }
  }
});

test('a reauthorized login starts clean, and an outcome observed on a replaced login is dropped', async () => {
  const store = fixture();
  try {
    let replace;
    const fetcher = counting(async () => {
        replace?.();
        return Response.json({error: 'invalid_grant'}, {status: 400});
      }),
      provider = new CredentialProvider(store, fetcher);
    await assert.rejects(provider.get(current(store)), {code: 'TOKEN_REFRESH_FAILED'});
    assert.equal(storedHealth(store, current(store)).state, 'reauthorization_required');
    // A new login (reauthorization or re-provisioning) bumps the revision; the old rejection no longer applies.
    store.putConnection(owner, linkedin, {
      ...expiring(),
      refreshToken: 'fresh-refresh',
      expiresAt: Date.now() + 3600000,
    });
    assert.equal(storedHealth(store, current(store)), undefined);
    assert.equal(recordedCredentialHealth(store, current(store)).state, 'not_recorded');
    // A rejection of the old login that completes after it was replaced is not recorded against the new one.
    store.putConnection(owner, linkedin, expiring());
    replace = () => store.putConnection(owner, linkedin, {...expiring(), refreshToken: 'newest-refresh'});
    await assert.rejects(provider.get(current(store)), {code: 'TOKEN_REFRESH_FAILED'});
    assert.equal(storedHealth(store, current(store)), undefined);
  } finally {
    store.close();
  }
});
