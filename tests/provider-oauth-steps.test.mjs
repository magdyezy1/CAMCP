import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {platforms} from '../dist/server/platform-oauth.js';
import {providerLogin, registeredProviderLogins} from '../dist/src/provider-logins.js';
import {googleOAuth} from '../dist/src/google-oauth.js';
import {isProviderModule, providerRegistries, runtimeGraph} from '../tools/architecture-map.mjs';

// ARC-01 phase B, the OAuth flow steps: PlatformOAuth.start and exchange (server/platform-oauth.ts) branched on the
// platform IDs of X, TikTok, Meta, Reddit, Microsoft and Google, connectService and config on Apple's and Microsoft's,
// and the platform table named Meta's versioned endpoints. Each provider's part is now the `oauth` of its website login
// steps (src/<provider>-login.ts); the flow keeps the configuration check, the state, PKCE, the requested scopes, the
// shared authorization parameters, the client-change refusal, the code and its form, every send (redirect: 'error',
// 15 seconds), the bounded read of each answer and every token check. tests/website-oauth-steps.test.mjs pins each
// provider's requests and refusals through the public entry points; these cases pin the seam.

const source = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');

test('the OAuth flow branches on no platform, names no endpoint and imports no provider module', () => {
  const flow = source('server/platform-oauth.ts');
  assert.doesNotMatch(flow, /\b(?:p\.)?id\s*[!=]==\s*'[a-z_0-9]+'/);
  assert.doesNotMatch(flow, /https:\/\/[a-z0-9.-]+\.(?:com|net)\//, 'the endpoints are the providers’');
  // The flow keeps every send's rules: one fetcher call, never following a redirect, within 15 seconds.
  assert.equal(flow.match(/this\.fetcher\(/g)?.length, 1);
  assert.match(flow, /redirect: 'error', signal: AbortSignal\.timeout\(15000\)/);
  const edges = [...runtimeGraph(process.cwd()).get('server/platform-oauth.ts')];
  assert.deepEqual(
    edges.filter(id => isProviderModule(id) && !providerRegistries.includes(id)),
    [],
    'the flow consults the provider login registry instead',
  );
  assert.ok(edges.includes('src/provider-logins.ts'));
  // The routes take what a login keeps on its connection from the steps, not from a platform's ID.
  assert.doesNotMatch(source('server/platform-routes.ts'), /redditUserAgent|p\.id === 'reddit'/);
});

test('each website platform’s endpoints are its provider’s OAuth steps', () => {
  for (const p of platforms) {
    const oauth = providerLogin(p.gateway)?.oauth;
    assert.ok(oauth && Object.isFrozen(oauth), p.id);
    assert.equal(p.authorize, oauth.authorize, p.id);
    assert.equal(p.token, oauth.token, p.id);
  }
  // Every Google surface shares Google's steps (Google Ads adds its own facts to them).
  const google = platforms.filter(p => p.token === googleOAuth.token).map(p => p.id);
  assert.deepEqual(google, ['sheets', 'drive', 'google', 'ga4', 'gtm', 'gsc', 'dv360', 'google_business']);
  for (const id of google.filter(id => id !== 'google'))
    assert.equal(providerLogin(platforms.find(p => p.id === id).gateway).oauth, googleOAuth, id);
});

test('the provider steps each platform declares, and no other', () => {
  const declaring = key =>
    registeredProviderLogins
      .filter(l => l.oauth?.[key] !== undefined)
      .map(l => platforms.find(p => p.gateway === l.gateway).id)
      .sort();
  assert.deepEqual(declaring('begin'), ['x']);
  assert.deepEqual(declaring('complete'), ['x']);
  assert.deepEqual(declaring('connect'), ['apple']);
  assert.deepEqual(declaring('serviceKey'), ['apple']);
  assert.deepEqual(declaring('fixedScopes'), ['apple']);
  assert.deepEqual(declaring('requiredSetting'), ['microsoft']);
  assert.deepEqual(declaring('bindsClient'), ['google']);
  assert.deepEqual(declaring('credentials'), ['google', 'microsoft']);
  assert.deepEqual(declaring('clientParameter'), ['tiktok']);
  assert.deepEqual(declaring('redirectParameter'), ['tiktok']);
  assert.deepEqual(declaring('noResponseType'), ['tiktok']);
  assert.deepEqual(declaring('codeParameter'), ['tiktok']);
  assert.deepEqual(declaring('tokenResult'), ['tiktok']);
  assert.deepEqual(declaring('scopeSeparator'), ['meta']);
  assert.deepEqual(declaring('extend'), ['meta']);
  assert.deepEqual(declaring('tokenRequest'), ['meta', 'microsoft', 'reddit', 'tiktok']);
  assert.deepEqual(declaring('checkTokens'), ['reddit']);
  assert.deepEqual(declaring('connectionFields'), ['reddit']);
  assert.deepEqual(declaring('authorizeParameters'), [
    'drive',
    'dv360',
    'ga4',
    'google',
    'google_business',
    'gsc',
    'gtm',
    'meta',
    'reddit',
    'sheets',
  ]);
  // A platform without a browser authorization connects with the server's credentials, and only it.
  for (const p of platforms) assert.equal(!!p.authType, !!providerLogin(p.gateway).oauth.connect, p.id);
});

test('what a login keeps on its connection is never its identity, accounts or grants', () => {
  const kept = providerLogin(platforms.find(p => p.id === 'reddit').gateway).oauth.connectionFields({
    AMCP_REDDIT_USER_AGENT: ' AMCP-test/2 ',
  });
  assert.deepEqual(kept, {userAgent: 'AMCP-test/2'});
  assert.throws(
    () =>
      providerLogin(platforms.find(p => p.id === 'reddit').gateway).oauth.connectionFields({
        AMCP_REDDIT_USER_AGENT: 'AMCP\nInjected: yes',
      }),
    e => e.code === 'USER_AGENT_REQUIRED',
  );
});
