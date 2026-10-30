import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshEndpoints, renewsAutomatically} from '../dist/src/connection-health.js';
import {providerAdapters} from '../dist/src/provider-adapters.js';

/**
 * CON-02 golden: where each provider's logins renew without the user (the token endpoint the refresh POSTs a login's
 * refresh token to, src/auth.ts) and which logins renew automatically, pinned before the endpoints moved into the
 * provider adapters (ARC-01 phase B). It reads only public exports, so it passes on the build before and after the move.
 */
const google = 'https://oauth2.googleapis.com/token';
const pinned = {
  google_sheets_native_action: google,
  google_drive_native_action: google,
  google_ads_native_action: google,
  dv360_native_action: google,
  ga4_native_action: google,
  gtm_native_action: google,
  google_business_native_action: google,
  google_search_console_native_action: google,
  snapchat_native_action: 'https://accounts.snapchat.com/login/oauth2/access_token',
  linkedin_native_action: 'https://www.linkedin.com/oauth/v2/accessToken',
  amazon_native_action: 'https://api.amazon.com/auth/o2/token',
  microsoft_ads_native_action: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  reddit_native_action: 'https://www.reddit.com/api/v1/access_token',
};
const gateways = [...providerAdapters.map(a => a.gateway), 'unknown_native_action'];
const sorted = record => Object.entries(record).sort(([a], [b]) => a.localeCompare(b));

test('CON-02 golden: each gateway renews at the token endpoint it renewed at before, and only those', () => {
  assert.deepEqual(sorted(refreshEndpoints), sorted(pinned));
  for (const gateway of gateways) assert.equal(refreshEndpoints[gateway], pinned[gateway], gateway);
  // Meta, TikTok and X logins cannot be renewed without consent; Apple renews with its client's own credentials.
  for (const gateway of [
    'meta_native_action',
    'tiktok_native_action',
    'x_ads_native_action',
    'apple_ads_native_action',
  ])
    assert.equal(Object.hasOwn(refreshEndpoints, gateway), false, gateway);
});

test('CON-02 golden: a login renews automatically with a refresh token and its client, or Apple with its client', () => {
  const full = {accessToken: 'a', refreshToken: 'r', clientId: 'client', clientSecret: 'secret'};
  const logins = {
    full,
    no_refresh_token: {...full, refreshToken: undefined},
    no_client: {...full, clientId: undefined},
    no_secret: {...full, clientSecret: undefined},
    consumer_only: {accessToken: 'a', consumerKey: 'client', consumerSecret: 'secret', refreshToken: 'r'},
    client_only: {accessToken: 'a', clientId: 'client'},
    empty: {},
  };
  for (const gateway of gateways)
    for (const [name, credentials] of Object.entries(logins)) {
      const expected =
        gateway === 'apple_ads_native_action'
          ? !!credentials.clientId
          : !!pinned[gateway] && !!credentials.refreshToken && !!credentials.clientId && !!credentials.clientSecret;
      assert.equal(renewsAutomatically(gateway, credentials), expected, gateway + ' ' + name);
    }
});
