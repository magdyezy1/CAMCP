import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  appClient,
  appClientChanged,
  appEnvironmentStems,
  deploymentAppSecrets,
  recordedClient,
  storableCredentials,
  withAppSecrets,
} from '../dist/src/app-credentials.js';
import {providerAdapters} from '../dist/src/provider-adapters.js';
import {platforms} from '../dist/server/platform-oauth.js';

/**
 * SEC-07 S2 golden: what the deployment's app credentials resolve for every provider gateway (the client, the secrets it
 * supplies, the client a login names, whether that client changed, the credentials a login is used with and what is
 * sealed for it) and the environment stem of every website platform, pinned before the stems and secret fields moved
 * into the provider adapters (ARC-01 phase B). It reads only public functions, so it passes on the build before and
 * after the move. Regenerate only for a deliberate change: AMCP_UPDATE_GOLDEN=1 node --test tests/app-credential-golden.test.mjs
 */
const goldenFile = new URL('./fixtures/app-credential-golden.json', import.meta.url);
// Every stem a website platform used, and three no platform uses (parked or unimplemented providers).
const stems = ['SHEETS', 'DRIVE', 'MICROSOFT', 'GOOGLE', 'META', 'TIKTOK', 'SNAPCHAT', 'LINKEDIN', 'X', 'GA4', 'GTM'];
stems.push('GSC', 'APPLE', 'DV360', 'REDDIT', 'GBP', 'CRITEO', 'AMAZON', 'WOOCOMMERCE');
const deploymentSecrets = {
  AMCP_MICROSOFT_DEVELOPER_TOKEN: 'ms-developer-token',
  AMCP_GOOGLE_DEVELOPER_TOKEN: 'google-developer-token',
  AMCP_APPLE_TEAM_ID: 'apple-team',
  AMCP_APPLE_KEY_ID: 'apple-key',
  AMCP_APPLE_PRIVATE_KEY: 'apple-pem',
};
// Every stem names the same client, each with its own secret, so a login of that client shows which stem was read.
const dedicated = Object.fromEntries(
  stems.flatMap(s => [
    ['AMCP_' + s + '_CLIENT_ID', 'client-1'],
    ['AMCP_' + s + '_CLIENT_SECRET', 'secret-' + s.toLowerCase()],
  ]),
);
const sharedGoogle = {
  AMCP_GOOGLE_CLIENT_ID: 'client-1',
  AMCP_GOOGLE_CLIENT_SECRET: 'secret-google',
  AMCP_X_CLIENT_ID: 'client-1',
  AMCP_X_CLIENT_SECRET: 'secret-x',
  AMCP_MICROSOFT_CLIENT_ID: 'client-1',
  AMCP_MICROSOFT_CLIENT_SECRET: 'secret-microsoft',
  ...deploymentSecrets,
};
const environments = {
  dedicated: {...dedicated, ...deploymentSecrets},
  dedicated_copy: {...dedicated, ...deploymentSecrets, AMCP_APP_SECRETS: 'copy'},
  shared_google: sharedGoogle,
  shared_google_approved: {...sharedGoogle, AMCP_GBP_API_APPROVED: 'true'},
  // A dedicated client without its secret, and a Business Profile client of its own without the approval.
  partial: {AMCP_META_CLIENT_ID: 'client-1', AMCP_GBP_CLIENT_ID: 'client-1', AMCP_GBP_CLIENT_SECRET: 'secret-gbp'},
  empty: {},
};
const everything = {
  accessToken: 'access',
  refreshToken: 'refresh',
  clientSecret: 'old-secret',
  consumerSecret: 'old-consumer-secret',
  tokenSecret: 'user-token-secret',
  developerToken: 'old-developer-token',
  appleTeamId: 'old-team',
  appleKeyId: 'old-key',
  applePrivateKey: 'old-pem',
  loginCustomerId: '1234567890',
};
const logins = {
  own_client: {...everything, clientId: 'client-1'},
  own_consumer_key: {...everything, consumerKey: 'client-1', clientId: 'other-client'},
  other_client: {...everything, clientId: 'other-client', consumerKey: 'other-client'},
  no_client: {accessToken: 'access'},
};
const gateways = [...providerAdapters.map(a => a.gateway), 'unknown_native_action', 'constructor', '__proto__'];

/** What a function made of a login: 'same' when it returned it as given, else the fields it set and removed. */
function delta(input, output) {
  if (output === input) return 'same';
  const set = Object.entries(output).filter(([k, v]) => input[k] !== v),
    removed = Object.keys(input).filter(k => !Object.hasOwn(output, k));
  return {copy: true, set: Object.fromEntries(set), removed};
}
/** The pinned view, as JSON keeps it: lists of [name, value] pairs (a gateway may be an inherited property name). */
function observed() {
  const environment = Object.entries(environments);
  const gatewayView = gateway => ({
    deployment: environment.map(([name, env]) => [name, deploymentAppSecrets(gateway, env) ?? null]),
    logins: Object.entries(logins).map(([login, credentials]) => [
      login,
      {
        recorded_client: recordedClient(gateway, credentials) ?? null,
        by_environment: [...environment, ['none', undefined]].map(([name, env]) => [
          name,
          {
            client_changed: appClientChanged(gateway, credentials, env),
            used: delta(credentials, withAppSecrets(gateway, credentials, env)),
            sealed: delta(credentials, storableCredentials(gateway, credentials, env)),
          },
        ]),
      },
    ]),
  });
  return JSON.parse(
    JSON.stringify({
      stems: Object.entries(appEnvironmentStems).sort(([a], [b]) => a.localeCompare(b)),
      platform_env: platforms.map(p => [p.id, p.env]),
      clients: environment.map(([name, env]) => [name, stems.map(s => [s, appClient(s, env)])]),
      gateways: gateways.map(gateway => [gateway, gatewayView(gateway)]),
    }),
  );
}

/** The golden file: one line per entry of each list, so a change shows as the line of its gateway or stem. */
const goldenText = value =>
  '{\n' +
  Object.entries(value)
    .map(([k, v]) => '  ' + JSON.stringify(k) + ': [\n' + v.map(e => '    ' + JSON.stringify(e)).join(',\n') + '\n  ]')
    .join(',\n') +
  '\n}\n';

test('SEC-07 S2 golden: app credentials resolve as pinned for every gateway, environment and login', () => {
  const current = observed();
  if (process.env.AMCP_UPDATE_GOLDEN === '1') fs.writeFileSync(goldenFile, goldenText(current));
  const pinned = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
  // Each gateway's view apart first, so a difference names its gateway.
  assert.deepEqual(
    current.gateways.map(([gateway]) => gateway),
    pinned.gateways.map(([gateway]) => gateway),
  );
  pinned.gateways.forEach(([gateway, view], i) => assert.deepEqual(current.gateways[i][1], view, gateway));
  assert.deepEqual(current, pinned);
});

test('SEC-07 S2 golden: a login is never handed another client’s secrets, and the user’s own token secret stays', () => {
  for (const gateway of gateways)
    for (const [name, env] of Object.entries(environments)) {
      const used = withAppSecrets(gateway, logins.other_client, env);
      assert.deepEqual(used, logins.other_client, gateway + ' ' + name);
      assert.equal(storableCredentials(gateway, logins.own_client, env).tokenSecret, 'user-token-secret');
    }
});
