import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {CredentialProvider} from '../src/auth.js';
import {SecretBox, scopeKey} from '../src/security.js';
import {credentialHealth, recordedCredentialHealth} from '../src/connection-health.js';
import {
  appEnvironmentStems,
  deploymentAppSecrets,
  storableCredentials,
  withAppSecrets,
} from '../src/app-credentials.js';
import {platforms} from '../server/platform-oauth.js';
import type {Connection, Credentials, JsonObject} from '../src/types.js';

/**
 * SEC-07 S2: the deployment's OAuth client secret, developer tokens and Apple signing key are read from the environment
 * when a login is used, keyed by the client ID the login recorded. They used to be copied into every login, so
 * rotating one in the environment left the old value in each login and broke its renewal.
 */
const owner = {tenantId: 'app-secrets', userId: 'owner', role: 'admin' as const},
  key = Buffer.alloc(32, 57).toString('base64'),
  box = new SecretBox(key);
const linkedin = (id = 'login'): Connection => ({
  id,
  tenantId: owner.tenantId,
  gateway: 'linkedin_native_action',
  accounts: ['123'],
  enabled: true,
  label: 'Synthetic LinkedIn login',
  scopes: [],
});
/** The credentials as sealed in the row, without any resolution. */
const raw = (store: Store, c: Connection): Credentials => {
  const row = store.db.prepare('SELECT secret FROM connections WHERE tenant_id=? AND id=?').get(c.tenantId, c.id) as {
    secret: string;
  };
  return box.open<Credentials>(row.secret.slice(3), scopeKey(c.tenantId, c.id));
};
const expired = (extra: Credentials = {}): Credentials => ({
  accessToken: 'old-access',
  refreshToken: 'synthetic-refresh',
  clientId: 'client-a',
  expiresAt: 1,
  ...extra,
});
/** A token endpoint that records each request's client secret and answers with a fresh token. */
function tokenEndpoint() {
  const secrets: (string | null)[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    secrets.push(new URLSearchParams(String(init?.body)).get('client_secret'));
    return Response.json({access_token: 'fresh-' + secrets.length, expires_in: 3600, token_type: 'Bearer'});
  };
  return {secrets, fetcher};
}

test('SEC-07 S2: a synthetic secret rotation keeps refresh working for existing logins (regression: the copied secret was sent after rotation)', async () => {
  const store = new Store(':memory:', key),
    c = linkedin();
  try {
    // A login saved before this change carries a copy of the client secret.
    store.putConnection(owner, c, expired({clientSecret: 'secret-1'}));
    assert.equal(raw(store, c).clientSecret, 'secret-1');
    const revision = store.listConnections(owner.tenantId)[0]!.loginRevision ?? 0;
    // The operator rotates the secret in the environment only.
    const env: NodeJS.ProcessEnv = {AMCP_LINKEDIN_CLIENT_ID: 'client-a', AMCP_LINKEDIN_CLIENT_SECRET: 'secret-2'};
    store.appEnvironment = env;
    const endpoint = tokenEndpoint(),
      provider = new CredentialProvider(store, endpoint.fetcher);
    const renewed = await provider.get(c);
    assert.equal(renewed.accessToken, 'fresh-1');
    assert.deepEqual(endpoint.secrets, ['secret-2'], 'the rotated secret, not the copy, is sent');
    // The refresh migrated the login: the copy is gone, the secret still resolves from the environment.
    assert.equal(raw(store, c).clientSecret, undefined);
    assert.equal(raw(store, c).clientId, 'client-a');
    assert.equal(store.credentials(owner.tenantId, c.id).clientSecret, 'secret-2');
    // A second rotation needs no reconnection either.
    env.AMCP_LINKEDIN_CLIENT_SECRET = 'secret-3';
    store.db
      .prepare('UPDATE connections SET secret=? WHERE id=?')
      .run('v2:' + box.seal({...raw(store, c), expiresAt: 1}, scopeKey(c.tenantId, c.id)), c.id);
    await provider.get(c);
    assert.deepEqual(endpoint.secrets, ['secret-2', 'secret-3']);
    // Renewals with a rotated secret are the same login: no login revision bump, health stays healthy.
    assert.equal(store.listConnections(owner.tenantId)[0]!.loginRevision ?? 0, revision);
    assert.equal(recordedCredentialHealth(store, store.listConnections(owner.tenantId)[0]!).state, 'healthy');
  } finally {
    store.close();
  }
});

test('SEC-07 S2: a client-ID change marks health client_changed and renews with the login’s own copy; without one it asks for reauthorization without contacting the provider', async () => {
  const store = new Store(':memory:', key);
  try {
    const legacy = linkedin('legacy'),
      migrated = linkedin('migrated');
    store.putConnection(owner, legacy, expired({clientSecret: 'secret-a'}));
    store.putConnection(owner, migrated, expired());
    store.appEnvironment = {AMCP_LINKEDIN_CLIENT_ID: 'client-b', AMCP_LINKEDIN_CLIENT_SECRET: 'secret-b'};
    const endpoint = tokenEndpoint(),
      provider = new CredentialProvider(store, endpoint.fetcher);
    // The login of the earlier app keeps working with the secret it holds, and says the client changed.
    await provider.get(legacy);
    assert.deepEqual(endpoint.secrets, ['secret-a']);
    assert.equal(raw(store, legacy).clientSecret, 'secret-a', 'the only copy of the earlier secret is kept');
    const current = store.listConnections(owner.tenantId).find(x => x.id === 'legacy')!;
    assert.equal(recordedCredentialHealth(store, current).state, 'client_changed');
    assert.equal(credentialHealth(store, current, store.credentials(owner.tenantId, 'legacy')).state, 'client_changed');
    // A login without a copy cannot renew with another app: refused before any provider request.
    await assert.rejects(provider.get(migrated), (e: JsonObject) => {
      assert.equal(e.code, 'REAUTHORIZATION_REQUIRED');
      assert.equal(e.details.reason, 'client_changed');
      return true;
    });
    assert.equal(endpoint.secrets.length, 1);
    const stored = store.listConnections(owner.tenantId).find(x => x.id === 'migrated')!;
    assert.equal(recordedCredentialHealth(store, stored).state, 'reauthorization_required');
  } finally {
    store.close();
  }
});

test('SEC-07 S2: new logins are stored without app secrets, and AMCP_APP_SECRETS=copy writes them again for a rollback', async () => {
  const store = new Store(':memory:', key),
    c = linkedin();
  try {
    const env: NodeJS.ProcessEnv = {AMCP_LINKEDIN_CLIENT_ID: 'client-a', AMCP_LINKEDIN_CLIENT_SECRET: 'secret-1'};
    store.appEnvironment = env;
    store.putConnection(owner, c, expired({clientSecret: 'secret-1', accessToken: 'live', expiresAt: undefined}));
    assert.equal(raw(store, c).clientSecret, undefined);
    assert.equal(store.credentials(owner.tenantId, c.id).clientSecret, 'secret-1');
    // Saving the login it reads back (with the secret resolved) is not a different login.
    const before = store.listConnections(owner.tenantId)[0]!.loginRevision ?? 0;
    store.putConnection(owner, c, store.credentials(owner.tenantId, c.id));
    assert.equal(store.listConnections(owner.tenantId)[0]!.loginRevision ?? 0, before);
    // The rollback lever: the next write carries the current secret again, as an older release expects.
    env.AMCP_APP_SECRETS = 'copy';
    store.replaceCredentials(owner.tenantId, c.id, store.credentials(owner.tenantId, c.id));
    assert.equal(raw(store, c).clientSecret, 'secret-1');
    assert.equal(store.listConnections(owner.tenantId)[0]!.loginRevision ?? 0, before);
  } finally {
    store.close();
  }
});

test('SEC-07 S2: each platform’s deployment secrets resolve by its own client: X consumer secret, Microsoft developer token, Apple signing key; a Google login customer stays the login’s own', () => {
  const env: NodeJS.ProcessEnv = {
    AMCP_X_CLIENT_ID: 'x-key',
    AMCP_X_CLIENT_SECRET: 'x-secret',
    AMCP_MICROSOFT_CLIENT_ID: 'ms-client',
    AMCP_MICROSOFT_CLIENT_SECRET: 'ms-secret',
    AMCP_MICROSOFT_DEVELOPER_TOKEN: 'ms-token-2',
    AMCP_APPLE_CLIENT_ID: 'SEARCHADS.synthetic',
    AMCP_APPLE_TEAM_ID: 'SEARCHADS.synthetic',
    AMCP_APPLE_KEY_ID: 'key-2',
    AMCP_APPLE_PRIVATE_KEY: 'pem-2',
    AMCP_GOOGLE_CLIENT_ID: 'g.apps.googleusercontent.com',
    AMCP_GOOGLE_CLIENT_SECRET: 'g-secret',
    AMCP_GOOGLE_LOGIN_CUSTOMER_ID: '1234567890',
  };
  const x = {consumerKey: 'x-key', consumerSecret: 'x-old', accessToken: 'a', tokenSecret: 't'};
  assert.equal(withAppSecrets('x_ads_native_action', x, env).consumerSecret, 'x-secret');
  assert.equal(storableCredentials('x_ads_native_action', x, env).consumerSecret, undefined);
  assert.equal(storableCredentials('x_ads_native_action', x, env).tokenSecret, 't', 'the user token secret stays');
  const ms = {clientId: 'ms-client', clientSecret: 'old', developerToken: 'ms-token-1', refreshToken: 'r'};
  assert.equal(withAppSecrets('microsoft_ads_native_action', ms, env).developerToken, 'ms-token-2');
  assert.deepEqual(storableCredentials('microsoft_ads_native_action', ms, env), {
    clientId: 'ms-client',
    refreshToken: 'r',
  });
  const apple = {
    clientId: 'SEARCHADS.synthetic',
    appleTeamId: 'SEARCHADS.synthetic',
    appleKeyId: 'key-1',
    applePrivateKey: 'pem-1',
  };
  assert.equal(withAppSecrets('apple_ads_native_action', apple, env).applePrivateKey, 'pem-2');
  assert.deepEqual(storableCredentials('apple_ads_native_action', apple, env), {clientId: 'SEARCHADS.synthetic'});
  // Google's developer token is no longer sent, so a copy is dropped. The login customer is per-login routing, not an
  // app secret: the deployment-wide value is never injected (CON-05) and a login's own value is never stripped.
  const google = {
    clientId: 'g.apps.googleusercontent.com',
    clientSecret: 'g-old',
    developerToken: 'legacy',
    refreshToken: 'r',
  };
  assert.equal(withAppSecrets('google_ads_native_action', google, env).loginCustomerId, undefined);
  assert.equal(withAppSecrets('google_ads_native_action', google, env).clientSecret, 'g-secret');
  assert.deepEqual(storableCredentials('google_ads_native_action', google, env), {
    clientId: 'g.apps.googleusercontent.com',
    refreshToken: 'r',
  });
  const routed = {...google, loginCustomerId: '5556667777'};
  assert.equal(withAppSecrets('google_ads_native_action', routed, env).loginCustomerId, '5556667777');
  assert.equal(storableCredentials('google_ads_native_action', routed, env).loginCustomerId, '5556667777');
  assert.equal(deploymentAppSecrets('google_ads_native_action', env)?.secrets.loginCustomerId, undefined);
  // Google surfaces without their own client share the Google one.
  assert.equal(deploymentAppSecrets('ga4_native_action', env)?.clientId, 'g.apps.googleusercontent.com');
  // A gateway the deployment does not configure (WooCommerce keys are the store's own) is untouched.
  const woo = {consumerKey: 'ck_1', consumerSecret: 'cs_1'};
  assert.equal(storableCredentials('woocommerce_native_action', woo, env), woo);
  // No environment: stored exactly as given (tests and tools).
  assert.equal(storableCredentials('x_ads_native_action', x, undefined), x);
});

test('SEC-07 S2: a provisioned Google Ads login keeps its own login customer after saving and after a refresh (regression: AMCP_GOOGLE_LOGIN_CUSTOMER_ID replaced it)', async () => {
  const store = new Store(':memory:', key),
    provisioned: Connection = {
      id: 'provisioned-google',
      tenantId: owner.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['1112223333'],
      enabled: true,
      label: 'Synthetic Google Ads login',
      scopes: [],
    };
  try {
    store.appEnvironment = {
      AMCP_GOOGLE_CLIENT_ID: 'client-g',
      AMCP_GOOGLE_CLIENT_SECRET: 'secret-g',
      AMCP_GOOGLE_LOGIN_CUSTOMER_ID: '9999999999',
    };
    store.putConnection(
      owner,
      provisioned,
      expired({clientId: 'client-g', clientSecret: 'secret-g', loginCustomerId: '1234567890'}),
    );
    assert.equal(raw(store, provisioned).loginCustomerId, '1234567890', 'stored as provisioned');
    assert.equal(raw(store, provisioned).clientSecret, undefined, 'the app secret is still left out');
    assert.equal(
      store.credentials(owner.tenantId, provisioned.id).loginCustomerId,
      '1234567890',
      'used as provisioned',
    );
    const endpoint = tokenEndpoint();
    await new CredentialProvider(store, endpoint.fetcher).get(provisioned);
    assert.deepEqual(endpoint.secrets, ['secret-g'], 'renewed with the environment secret');
    assert.equal(raw(store, provisioned).loginCustomerId, '1234567890', 'kept after a refresh');
    assert.equal(store.credentials(owner.tenantId, provisioned.id).loginCustomerId, '1234567890');
    // A login without its own login customer (a website login routes per account, CON-05) gets none from the
    // environment.
    const website = {...provisioned, id: 'website-google'};
    store.putConnection(owner, website, expired({clientId: 'client-g'}));
    assert.equal(store.credentials(owner.tenantId, website.id).loginCustomerId, undefined);
  } finally {
    store.close();
  }
});

test('SEC-07 S2: every website platform’s environment stem resolves the same client the connect flow uses', () => {
  for (const p of platforms) assert.equal(appEnvironmentStems[p.gateway], p.env, p.id);
  assert.equal(Object.keys(appEnvironmentStems).length, platforms.length);
});

test('CON-06 with SEC-07: Business Profile uses the shared Google client only once its API approval is declared, at connect and at use time', () => {
  const shared: NodeJS.ProcessEnv = {AMCP_GOOGLE_CLIENT_ID: 'g-client', AMCP_GOOGLE_CLIENT_SECRET: 'g-secret'};
  assert.equal(deploymentAppSecrets('google_business_native_action', shared), undefined, 'not approved: no client');
  assert.deepEqual(deploymentAppSecrets('google_business_native_action', {...shared, AMCP_GBP_API_APPROVED: 'true'}), {
    clientId: 'g-client',
    secrets: {clientSecret: 'g-secret'},
  });
  // A dedicated client applies with or without the declaration.
  assert.equal(
    deploymentAppSecrets('google_business_native_action', {
      ...shared,
      AMCP_GBP_CLIENT_ID: 'gbp-client',
      AMCP_GBP_CLIENT_SECRET: 'gbp-secret',
    })?.clientId,
    'gbp-client',
  );
  // The other Google surfaces keep sharing without any declaration.
  assert.equal(deploymentAppSecrets('ga4_native_action', shared)?.clientId, 'g-client');
});
