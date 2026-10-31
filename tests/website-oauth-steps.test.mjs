import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {WebStore} from '../dist/server/web-store.js';
import {PlatformOAuth, platform, platforms} from '../dist/server/platform-oauth.js';

// ARC-01 phase B, the OAuth flow steps: these pin each provider's part of the website's OAuth flows through
// PlatformOAuth's public entry points (start, exchange, connectService, config): the authorization request's
// parameters and what its state keeps, each token request (method, endpoint, headers and body) and what the exchange
// returns, and the provider refusals no other suite reaches. The move of each provider's steps out of
// server/platform-oauth.ts into its website login module (src/<provider>-login.ts) is held to them. This file imports
// nothing the move added, so the call-replay proof recorded it on the build before the move too.

const key = Buffer.alloc(32, 43).toString('base64'),
  password = 'synthetic-password-for-oauth-steps',
  origin = 'https://amcp.example';
const env = Object.freeze({
  AMCP_GOOGLE_CLIENT_ID: 'google-client',
  AMCP_GOOGLE_CLIENT_SECRET: 'google-secret',
  AMCP_GOOGLE_DEVELOPER_TOKEN: 'google-developer-token',
  AMCP_GBP_API_APPROVED: 'true',
  AMCP_MICROSOFT_CLIENT_ID: 'microsoft-client',
  AMCP_MICROSOFT_CLIENT_SECRET: 'microsoft-secret',
  AMCP_MICROSOFT_DEVELOPER_TOKEN: 'microsoft-developer-token',
  AMCP_META_CLIENT_ID: 'meta-client',
  AMCP_META_CLIENT_SECRET: 'meta-secret',
  AMCP_TIKTOK_CLIENT_ID: 'tiktok-app',
  AMCP_TIKTOK_CLIENT_SECRET: 'tiktok-secret',
  AMCP_SNAPCHAT_CLIENT_ID: 'snapchat-client',
  AMCP_SNAPCHAT_CLIENT_SECRET: 'snapchat-secret',
  AMCP_LINKEDIN_CLIENT_ID: 'linkedin-client',
  AMCP_LINKEDIN_CLIENT_SECRET: 'linkedin-secret',
  AMCP_X_CLIENT_ID: 'x-consumer',
  AMCP_X_CLIENT_SECRET: 'x-consumer-secret',
  AMCP_REDDIT_CLIENT_ID: 'reddit-client',
  AMCP_REDDIT_CLIENT_SECRET: 'reddit-secret',
  AMCP_REDDIT_USER_AGENT: 'AMCP-test/1 (steps)',
});
const form = text => new Response(text, {status: 200, headers: {'Content-Type': 'application/x-www-form-urlencoded'}});

/** A web store with an administrator session and an OAuth flow whose provider requests are recorded. */
async function fixture(overrides = {}, answer = () => Response.json({}), allowWrites = false) {
  const store = new Store(':memory:', key),
    web = new WebStore(store, {origin, masterKey: key, adminPassword: password}),
    session = await web.signIn(password, '127.0.0.1'),
    sent = [];
  const oauth = new PlatformOAuth(
    web,
    {...env, ...overrides},
    async (url, init = {}) => {
      const u = new URL(String(url));
      sent.push({
        method: init.method,
        url: u.href,
        headers: init.headers ?? null,
        body: init.body === undefined ? null : String(init.body),
        redirect: init.redirect,
      });
      return answer(u, init);
    },
    allowWrites,
  );
  return {store, web, session, oauth, sent};
}
/** An authorization URL's parameters in order, with the random state and PKCE challenge masked. */
const parameters = href =>
  [...new URL(href).searchParams].map(([k, v]) => [k, ['state', 'code_challenge'].includes(k) ? '<random>' : v]);
/** The X request-token and access-token Authorization header, with its random and signed parts masked. */
const oauth1 = header =>
  String(header)
    .replace(/oauth_(nonce|timestamp|signature)="[^"]*"/g, 'oauth_$1="<masked>"')
    .replace(/state%3D[A-Za-z0-9_-]+/, 'state%3D<random>');

const google = [
  ['access_type', 'offline'],
  ['prompt', 'consent'],
];
const expectedAuthorization = {
  sheets: [
    ['client_id', 'google-client'],
    ['redirect_uri', origin + '/api/auth/sheets/callback'],
    ['state', '<random>'],
    ['response_type', 'code'],
    ['scope', 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets'],
    ['code_challenge', '<random>'],
    ['code_challenge_method', 'S256'],
    ...google,
  ],
  microsoft: [
    ['client_id', 'microsoft-client'],
    ['redirect_uri', origin + '/api/auth/microsoft/callback'],
    ['state', '<random>'],
    ['response_type', 'code'],
    ['scope', 'https://ads.microsoft.com/msads.manage offline_access'],
    ['code_challenge', '<random>'],
    ['code_challenge_method', 'S256'],
  ],
  meta: [
    ['client_id', 'meta-client'],
    ['redirect_uri', origin + '/api/auth/meta/callback'],
    ['state', '<random>'],
    ['response_type', 'code'],
    // Meta joins its scopes with commas.
    ['scope', 'ads_read,pages_show_list,pages_read_engagement,business_management'],
  ],
  tiktok: [
    ['app_id', 'tiktok-app'],
    ['redirect_uri', origin + '/api/auth/tiktok/callback'],
    ['state', '<random>'],
  ],
  reddit: [
    ['client_id', 'reddit-client'],
    ['redirect_uri', origin + '/api/auth/reddit/callback'],
    ['state', '<random>'],
    ['response_type', 'code'],
    // adsedit is requested only where reviewed writes are allowed (owner decision D19).
    ['scope', 'adsread'],
    ['duration', 'permanent'],
  ],
};

test('each platform’s authorization request: its endpoint, its parameters in order and what its state keeps', async () => {
  const f = await fixture({}, u => {
    if (u.href.startsWith('https://api.x.com/oauth/request_token'))
      return form('oauth_token=x-request&oauth_token_secret=x-request-secret&oauth_callback_confirmed=true');
    throw Error('unexpected ' + u.href);
  });
  try {
    for (const p of platforms.filter(p => !p.authType)) {
      const started = await f.oauth.start(f.session, p.id),
        url = new URL(started.url),
        state = url.searchParams.get('state');
      assert.equal(url.origin + url.pathname, p.authorize, p.id);
      if (expectedAuthorization[p.id]) assert.deepEqual(parameters(started.url), expectedAuthorization[p.id], p.id);
      // Every Google surface asks for offline access and consent; PKCE is the platform table's.
      const names = [...url.searchParams.keys()];
      assert.equal(names.includes('access_type'), p.token === 'https://oauth2.googleapis.com/token', p.id);
      assert.equal(names.includes('code_challenge'), p.pkce === true, p.id);
      if (p.id === 'x') {
        assert.deepEqual(parameters(started.url), [['oauth_token', 'x-request']]);
        continue;
      }
      const kept = f.web.consumeOAuth(f.session, p.id, state);
      assert.deepEqual(
        Object.keys(kept),
        [
          'attemptId',
          'redirectUri',
          'verifier',
          'requestedScopes',
          'requestedWriteAccess',
          // Google Ads also binds its client on a first authorization (its renewal compares it).
          ...(p.id === 'google' ? ['oauthClientId'] : []),
        ],
        p.id,
      );
      assert.equal(kept.redirectUri, origin + '/api/auth/' + p.id + '/callback');
    }
    // X: the request token is read first, signed with the consumer and the callback that carries the state.
    const request = f.sent.find(s => s.url.startsWith('https://api.x.com/oauth/request_token'));
    assert.equal(request.url, 'https://api.x.com/oauth/request_token?x_auth_access_type=read');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    assert.equal(request.body, null);
    assert.equal(
      oauth1(request.headers.Authorization),
      'OAuth oauth_callback="https%3A%2F%2Famcp.example%2Fapi%2Fauth%2Fx%2Fcallback%3Fstate%3D<random>", oauth_consumer_key="x-consumer", oauth_nonce="<masked>", oauth_signature="<masked>", oauth_signature_method="HMAC-SHA1", oauth_timestamp="<masked>", oauth_version="1.0"',
    );
  } finally {
    f.store.close();
  }
});

test('a renewal keeps the platform, revision and client in its state; Google lets the person choose, Meta asks again', async () => {
  const f = await fixture({AMCP_META_CONFIG_ID: 'meta-config'}, () =>
    form('oauth_token=x-renew&oauth_token_secret=x-renew-secret&oauth_callback_confirmed=true'),
  );
  try {
    const renewal = {connectionId: 'saved-login', revision: 'revision-1'};
    const google = await f.oauth.start(f.session, 'google', renewal);
    assert.deepEqual(parameters(google.url).slice(-2), [
      ['access_type', 'offline'],
      ['prompt', 'consent select_account'],
    ]);
    const meta = await f.oauth.start(f.session, 'meta', renewal);
    assert.deepEqual(parameters(meta.url).slice(5), [
      ['auth_type', 'rerequest'],
      ['config_id', 'meta-config'],
      ['override_default_response_type', 'true'],
    ]);
    const x = await f.oauth.start(f.session, 'x', renewal);
    for (const [id, started] of [
      ['google', google],
      ['meta', meta],
    ]) {
      const kept = f.web.consumeOAuth(f.session, id, new URL(started.url).searchParams.get('state'));
      assert.deepEqual(kept.reauthorization, {...renewal, platform: id});
      assert.equal(kept.oauthClientId, id + '-client');
    }
    // X's state comes back through its callback; the request token names the renewal's authorization.
    assert.deepEqual(parameters(x.url), [['oauth_token', 'x-renew']]);
  } finally {
    f.store.close();
  }
});

test('TikTok’s callback parameter is its developer portal’s; any other setting is refused before anything is kept', async () => {
  const chosen = await fixture({AMCP_TIKTOK_REDIRECT_PARAMETER: 'redirect_url'});
  const wrong = await fixture({AMCP_TIKTOK_REDIRECT_PARAMETER: 'callback'});
  try {
    assert.deepEqual(parameters((await chosen.oauth.start(chosen.session, 'tiktok')).url), [
      ['app_id', 'tiktok-app'],
      ['redirect_url', origin + '/api/auth/tiktok/callback'],
      ['state', '<random>'],
    ]);
    await assert.rejects(wrong.oauth.start(wrong.session, 'tiktok'), e => {
      assert.equal(e.code, 'CONFIG_ERROR');
      assert.equal(e.message, 'TikTok redirect parameter must match the developer portal URL.');
      return true;
    });
    assert.equal(wrong.store.db.prepare('SELECT COUNT(*) AS n FROM amcp_oauth_states').get().n, 0);
  } finally {
    chosen.store.close();
    wrong.store.close();
  }
});

/** Token answers by endpoint; Meta's exchange of its short-lived token is the second GET. */
function tokenAnswers(u, init) {
  if (u.origin === 'https://oauth2.googleapis.com')
    return Response.json({
      access_token: 'google-access',
      refresh_token: 'google-refresh',
      expires_in: 3599,
      scope: 'https://www.googleapis.com/auth/adwords openid',
    });
  if (u.origin === 'https://login.microsoftonline.com')
    return Response.json({
      access_token: 'ms-access',
      refresh_token: 'ms-refresh',
      expires_in: 3600,
      scope: 'https://ads.microsoft.com/msads.manage',
    });
  if (u.origin === 'https://graph.facebook.com')
    return u.searchParams.get('grant_type') === 'fb_exchange_token'
      ? Response.json({access_token: 'meta-long', expires_in: 5184000, token_type: 'bearer'})
      : Response.json({access_token: 'meta-short', expires_in: 3600});
  if (u.origin === 'https://business-api.tiktok.com')
    return Response.json({
      code: 0,
      message: 'OK',
      data: {access_token: 'tiktok-access', scope: [1, 4], advertiser_ids: []},
    });
  if (u.origin === 'https://accounts.snapchat.com')
    return Response.json({
      access_token: 'snap-access',
      refresh_token: 'snap-refresh',
      expires_in: 1800,
      scope: 'snapchat-marketing-api',
    });
  if (u.origin === 'https://www.linkedin.com')
    return Response.json({
      access_token: 'li-access',
      refresh_token: 'li-refresh',
      expires_in: 5184000,
      refresh_token_expires_in: 31536000,
      scope: 'r_ads,r_ads_reporting',
    });
  if (u.origin === 'https://www.reddit.com')
    return Response.json({
      access_token: 'reddit-access',
      refresh_token: 'reddit-refresh',
      expires_in: 86400,
      scope: 'adsread',
    });
  if (u.href === 'https://api.x.com/oauth/access_token')
    return form('oauth_token=x-access&oauth_token_secret=x-access-secret&user_id=42&screen_name=brand');
  throw Error('unexpected ' + init.method + ' ' + u.href);
}
const stored = id => ({redirectUri: origin + '/api/auth/' + id + '/callback', verifier: 'synthetic-verifier-' + id});
/** An exchange result with its clock-relative values marked. */
const shown = result => ({
  ...result,
  credentials: Object.fromEntries(
    Object.entries(result.credentials).map(([k, v]) => [k, k === 'expiresAt' ? typeof v : v]),
  ),
  ...(result.loginExpiresAt ? {loginExpiresAt: typeof result.loginExpiresAt} : {}),
  ...(result.grants ? {grants: {...result.grants, checked_at: typeof result.grants.checked_at}} : {}),
});

test('each provider’s token request and what its exchange returns', async () => {
  const f = await fixture({}, tokenAnswers);
  try {
    const exchanged = {};
    for (const id of ['google', 'microsoft', 'meta', 'tiktok', 'snapchat', 'linkedin', 'reddit'])
      exchanged[id] = shown(
        await f.oauth.exchange(id, stored(id), id === 'tiktok' ? {auth_code: 'tiktok-code'} : {code: id + '-code'}),
      );
    exchanged.x = shown(
      await f.oauth.exchange(
        'x',
        {requestToken: 'x-request', requestSecret: 'x-request-secret', requestedAccessType: 'read'},
        {oauth_token: 'x-request', oauth_verifier: 'x-verifier'},
      ),
    );
    assert.deepEqual(
      f.sent.map(s => [
        s.method,
        s.url,
        s.redirect,
        s.headers &&
          Object.fromEntries(
            Object.entries(s.headers).map(([k, v]) => [
              k,
              k === 'Authorization' && String(v).startsWith('OAuth ') ? oauth1(v) : v,
            ]),
          ),
        s.body,
      ]),
      [
        [
          'POST',
          'https://oauth2.googleapis.com/token',
          'error',
          {},
          'client_id=google-client&client_secret=google-secret&grant_type=authorization_code&code=google-code&redirect_uri=https%3A%2F%2Famcp.example%2Fapi%2Fauth%2Fgoogle%2Fcallback&code_verifier=synthetic-verifier-google',
        ],
        [
          'POST',
          'https://login.microsoftonline.com/common/oauth2/v2.0/token',
          'error',
          {},
          'client_id=microsoft-client&client_secret=microsoft-secret&grant_type=authorization_code&code=microsoft-code&redirect_uri=https%3A%2F%2Famcp.example%2Fapi%2Fauth%2Fmicrosoft%2Fcallback&code_verifier=synthetic-verifier-microsoft&scope=https%3A%2F%2Fads.microsoft.com%2Fmsads.manage+offline_access',
        ],
        [
          'GET',
          platform('meta').token +
            '?client_id=meta-client&client_secret=meta-secret&code=meta-code&redirect_uri=https%3A%2F%2Famcp.example%2Fapi%2Fauth%2Fmeta%2Fcallback',
          'error',
          {},
          null,
        ],
        [
          'GET',
          platform('meta').token +
            '?grant_type=fb_exchange_token&client_id=meta-client&client_secret=meta-secret&fb_exchange_token=meta-short',
          'error',
          null,
          null,
        ],
        [
          'POST',
          'https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/',
          'error',
          {'Content-Type': 'application/json'},
          '{"app_id":"tiktok-app","secret":"tiktok-secret","auth_code":"tiktok-code"}',
        ],
        [
          'POST',
          'https://accounts.snapchat.com/login/oauth2/access_token',
          'error',
          {},
          'client_id=snapchat-client&client_secret=snapchat-secret&grant_type=authorization_code&code=snapchat-code&redirect_uri=https%3A%2F%2Famcp.example%2Fapi%2Fauth%2Fsnapchat%2Fcallback',
        ],
        [
          'POST',
          'https://www.linkedin.com/oauth/v2/accessToken',
          'error',
          {},
          'client_id=linkedin-client&client_secret=linkedin-secret&grant_type=authorization_code&code=linkedin-code&redirect_uri=https%3A%2F%2Famcp.example%2Fapi%2Fauth%2Flinkedin%2Fcallback',
        ],
        [
          'POST',
          'https://www.reddit.com/api/v1/access_token',
          'error',
          {
            Authorization: 'Basic ' + Buffer.from('reddit-client:reddit-secret').toString('base64'),
            'User-Agent': 'AMCP-test/1 (steps)',
          },
          'grant_type=authorization_code&code=reddit-code&redirect_uri=https%3A%2F%2Famcp.example%2Fapi%2Fauth%2Freddit%2Fcallback',
        ],
        [
          'POST',
          'https://api.x.com/oauth/access_token',
          'error',
          {
            Authorization:
              'OAuth oauth_consumer_key="x-consumer", oauth_nonce="<masked>", oauth_signature="<masked>", oauth_signature_method="HMAC-SHA1", oauth_timestamp="<masked>", oauth_token="x-request", oauth_verifier="x-verifier", oauth_version="1.0"',
          },
          null,
        ],
      ],
    );
    assert.deepEqual(exchanged.google, {
      credentials: {
        accessToken: 'google-access',
        refreshToken: 'google-refresh',
        clientId: 'google-client',
        clientSecret: 'google-secret',
        redirectUri: origin + '/api/auth/google/callback',
        expiresAt: 'number',
        developerToken: 'google-developer-token',
      },
      label: 'Google Ads login',
      scopes: ['https://www.googleapis.com/auth/adwords', 'openid'],
    });
    assert.deepEqual(exchanged.microsoft.credentials, {
      accessToken: 'ms-access',
      refreshToken: 'ms-refresh',
      clientId: 'microsoft-client',
      clientSecret: 'microsoft-secret',
      redirectUri: origin + '/api/auth/microsoft/callback',
      expiresAt: 'number',
      developerToken: 'microsoft-developer-token',
    });
    // Meta's long-lived token replaces the short-lived one, with its own lifetime.
    assert.equal(exchanged.meta.credentials.accessToken, 'meta-long');
    assert.equal(exchanged.meta.credentials.refreshToken, undefined);
    // TikTok's token is its result's data; its scope list is kept as text.
    assert.equal(exchanged.tiktok.credentials.accessToken, 'tiktok-access');
    assert.deepEqual(exchanged.tiktok.scopes, ['1', '4']);
    assert.deepEqual(exchanged.linkedin.scopes, ['r_ads', 'r_ads_reporting']);
    assert.equal(exchanged.linkedin.loginExpiresAt, 'number');
    assert.equal(exchanged.reddit.credentials.refreshToken, 'reddit-refresh');
    assert.deepEqual(exchanged.x, {
      credentials: {
        consumerKey: 'x-consumer',
        consumerSecret: 'x-consumer-secret',
        accessToken: 'x-access',
        tokenSecret: 'x-access-secret',
      },
      label: 'X (Twitter) · @brand',
      scopes: [],
      providerId: '42',
      displayName: '@brand',
      grants: {source: 'requested_access_type', known: false, requested_access_type: 'read', checked_at: 'number'},
    });
  } finally {
    f.store.close();
  }
});

test('the provider refusals of a token exchange, each before what it guards', async () => {
  const refused = async (overrides, answer, id, kept, query, code, message) => {
    const f = await fixture(overrides, answer);
    try {
      await assert.rejects(f.oauth.exchange(id, kept, query), e => {
        assert.equal(e.code, code, id);
        if (message) assert.equal(e.message, message, id);
        return true;
      });
      return f.sent.length;
    } finally {
      f.store.close();
    }
  };
  // TikTok's own result code refuses the authorization code.
  assert.equal(
    await refused(
      {},
      () => Response.json({code: 40001, message: 'invalid'}),
      'tiktok',
      stored('tiktok'),
      {auth_code: 'tiktok-code'},
      'OAUTH_EXCHANGE_FAILED',
      'TikTok rejected the authorization code.',
    ),
    1,
  );
  // Meta: no usable short-lived token is never exchanged for a long-lived one.
  assert.equal(
    await refused(
      {},
      () => Response.json({token_type: 'bearer'}),
      'meta',
      stored('meta'),
      {code: 'meta-code'},
      'OAUTH_RESPONSE_INVALID',
      'Meta did not return a usable short-lived token.',
    ),
    1,
  );
  // Meta: a missing lifetime needs provider verification, never an invented one.
  assert.equal(
    await refused(
      {},
      u =>
        u.pathname.endsWith('/debug_token')
          ? Response.json({data: {is_valid: false}})
          : u.searchParams.get('grant_type') === 'fb_exchange_token'
            ? Response.json({access_token: 'meta-long'})
            : Response.json({access_token: 'meta-short', expires_in: 3600}),
      'meta',
      stored('meta'),
      {code: 'meta-code'},
      'OAUTH_RESPONSE_INVALID',
      'Meta did not return a valid long-lived token and lifetime.',
    ),
    3,
  );
  // Microsoft must grant offline access with a lifetime.
  assert.equal(
    await refused(
      {},
      () => Response.json({access_token: 'ms-access', expires_in: 3600}),
      'microsoft',
      stored('microsoft'),
      {code: 'microsoft-code'},
      'OAUTH_RESPONSE_INVALID',
      'Microsoft authorization must return offline access and a valid lifetime. Reconnect with offline_access.',
    ),
    1,
  );
  // Reddit's User-Agent is a header: a line break is refused before any request.
  assert.equal(
    await refused(
      {AMCP_REDDIT_USER_AGENT: 'AMCP\r\nInjected: yes'},
      tokenAnswers,
      'reddit',
      stored('reddit'),
      {code: 'reddit-code'},
      'USER_AGENT_REQUIRED',
      'AMCP_REDDIT_USER_AGENT must not contain line breaks.',
    ),
    0,
  );
  // X: a verifier for another request token is refused before any request.
  assert.equal(
    await refused(
      {},
      tokenAnswers,
      'x',
      {requestToken: 'x-request', requestSecret: 'x-request-secret'},
      {oauth_token: 'x-other', oauth_verifier: 'x-verifier'},
      'OAUTH_TOKEN_MISMATCH',
      'X returned a mismatched authorization token.',
    ),
    0,
  );
  // X: user credentials the access-token call did not return.
  assert.equal(
    await refused(
      {},
      () => form('oauth_token=x-access'),
      'x',
      {requestToken: 'x-request', requestSecret: 'x-request-secret'},
      {oauth_token: 'x-request', oauth_verifier: 'x-verifier'},
      'OAUTH_RESPONSE_INVALID',
      'X did not return usable user credentials.',
    ),
    1,
  );
  // TikTok's code travels as auth_code; a callback without it is refused before any request.
  assert.equal(
    await refused({}, tokenAnswers, 'tiktok', stored('tiktok'), {code: 'wrong-name'}, 'OAUTH_CODE_REQUIRED'),
    0,
  );
});

test('Meta accepts the provider expires alias without inheriting the short-lived lifetime', async () => {
  const f = await fixture({}, u =>
    Response.json(
      u.searchParams.get('grant_type') === 'fb_exchange_token'
        ? {access_token: 'meta-long', expires: '7200'}
        : {access_token: 'meta-short', expires_in: 60},
    ),
  );
  try {
    const before = Date.now(),
      result = await f.oauth.exchange('meta', stored('meta'), {code: 'meta-code'});
    assert.equal(result.credentials.accessToken, 'meta-long');
    assert.ok(result.credentials.expiresAt >= before + 7200 * 1000);
    assert.ok(result.credentials.expiresAt <= Date.now() + 7200 * 1000);
    assert.equal(f.sent.length, 2);
  } finally {
    f.store.close();
  }
});

test('Meta verifies a missing lifetime with the app and uses the earlier native token or data-access expiry', async () => {
  const now = Math.floor(Date.now() / 1000),
    expiry = now + 3600;
  for (const [expires_in, expires_at] of [
    [undefined, now + 7200],
    [0, now + 7200],
    ['0', now + 7200],
    [undefined, 0],
    [0, 0],
  ]) {
    const f = await fixture({}, (u, init) => {
      if (u.pathname.endsWith('/debug_token')) {
        assert.equal(u.searchParams.get('input_token'), 'meta-long');
        assert.equal(u.searchParams.has('access_token'), false);
        assert.deepEqual(init.headers, {Authorization: 'Bearer meta-client|meta-secret'});
        return Response.json({
          data: {
            is_valid: true,
            app_id: 'meta-client',
            type: 'USER',
            expires_at,
            data_access_expires_at: expiry,
          },
        });
      }
      return Response.json(
        u.searchParams.get('grant_type') === 'fb_exchange_token'
          ? {access_token: 'meta-long', ...(expires_in === undefined ? {} : {expires_in})}
          : {access_token: 'meta-short', expires_in: 60},
      );
    });
    try {
      const result = await f.oauth.exchange('meta', stored('meta'), {code: 'meta-code'});
      assert.equal(result.credentials.accessToken, 'meta-long');
      assert.ok(result.credentials.expiresAt > Date.now() + 3500 * 1000);
      assert.ok(result.credentials.expiresAt <= expiry * 1000);
      assert.equal(f.sent.length, 3);
      assert.ok(f.sent.every(request => request.method === 'GET' && request.redirect === 'error'));
      assert.ok(!JSON.stringify(result).includes('data_access_expires_at'));
    } finally {
      f.store.close();
    }
  }
});

test('Meta keeps no invented expiry for verified non-expiring user or system-user tokens', async () => {
  for (const type of ['USER', 'SYSTEM_USER', 'BUSINESS_ASSET_USER']) {
    const f = await fixture({}, u =>
      Response.json(
        u.pathname.endsWith('/debug_token')
          ? {data: {is_valid: true, app_id: 'meta-client', type, expires_at: 0, data_access_expires_at: 0, error: null}}
          : u.searchParams.get('grant_type') === 'fb_exchange_token'
            ? {access_token: 'meta-long', expires_in: 0}
            : {access_token: 'meta-short', expires_in: 60},
      ),
    );
    try {
      const result = await f.oauth.exchange('meta', stored('meta'), {code: 'meta-code'});
      assert.equal(result.credentials.accessToken, 'meta-long');
      assert.equal(Object.hasOwn(result.credentials, 'expiresAt'), false);
      assert.equal(f.sent.length, 3);
    } finally {
      f.store.close();
    }
  }
});

test('Meta refuses invalid, foreign, expired, wrong-kind and incomplete token inspection without exposing secrets', async () => {
  const now = Math.floor(Date.now() / 1000),
    valid = {is_valid: true, app_id: 'meta-client', type: 'USER', expires_at: now + 3600};
  for (const data of [
    undefined,
    [],
    {...valid, is_valid: false},
    {...valid, is_valid: 'true'},
    {...valid, app_id: 'foreign-app'},
    {...valid, type: 'PAGE'},
    {...valid, type: 'APP'},
    {...valid, expires_at: now - 1},
    {...valid, expires_at: undefined},
    {...valid, expires_at: '3600'},
    {...valid, expires_at: 0, data_access_expires_at: now - 1},
    {...valid, data_access_expires_at: now - 1},
    {...valid, data_access_expires_at: 'unknown'},
    {...valid, error: {message: 'meta-long meta-secret synthetic-private-error'}},
  ]) {
    const f = await fixture({}, u =>
      Response.json(
        u.pathname.endsWith('/debug_token')
          ? {data}
          : u.searchParams.get('grant_type') === 'fb_exchange_token'
            ? {access_token: 'meta-long'}
            : {access_token: 'meta-short', expires_in: 3600},
      ),
    );
    try {
      await assert.rejects(f.oauth.exchange('meta', stored('meta'), {code: 'meta-code'}), error => {
        assert.equal(error.code, 'OAUTH_RESPONSE_INVALID');
        assert.doesNotMatch(
          error.message + JSON.stringify(error.details),
          /meta-long|meta-secret|synthetic-private-error/,
        );
        return true;
      });
      assert.equal(f.store.listConnections('local').length, 0);
      assert.equal(f.sent.length, 3);
    } finally {
      f.store.close();
    }
  }
});

test('Meta refuses malformed explicit lifetimes and unusable extended tokens without extra provider reads', async () => {
  for (const extended of [
    {expires_in: 3600},
    {access_token: '', expires_in: 3600},
    ...[-1, 1.5, true, null, '', 'invalid', [], {}, Number.MAX_SAFE_INTEGER].map(expires_in => ({
      access_token: 'meta-long',
      expires_in,
    })),
  ]) {
    const f = await fixture({}, u =>
      Response.json(
        u.searchParams.get('grant_type') === 'fb_exchange_token'
          ? extended
          : {access_token: 'meta-short', expires_in: 3600},
      ),
    );
    try {
      await assert.rejects(f.oauth.exchange('meta', stored('meta'), {code: 'meta-code'}), {
        code: 'OAUTH_RESPONSE_INVALID',
      });
      assert.equal(f.sent.length, 2);
    } finally {
      f.store.close();
    }
  }
});

test('Meta inspection retains the session fence and provider failures without falling back to the short token', async () => {
  for (const mode of ['session-ended', 'provider-error', 'malformed']) {
    let inspected = false;
    const f = await fixture({}, u => {
      if (u.pathname.endsWith('/debug_token')) {
        inspected = true;
        if (mode === 'provider-error') return Response.json({error: {message: 'meta-secret'}}, {status: 400});
        if (mode === 'malformed') return new Response('not JSON: meta-secret');
        return Response.json({
          data: {is_valid: true, app_id: 'meta-client', type: 'USER', expires_at: Math.floor(Date.now() / 1000) + 3600},
        });
      }
      return Response.json({
        access_token: u.searchParams.get('grant_type') === 'fb_exchange_token' ? 'meta-long' : 'meta-short',
      });
    });
    try {
      await assert.rejects(
        f.oauth.exchange('meta', stored('meta'), {code: 'meta-code'}, () => {
          if (mode === 'session-ended' && inspected)
            throw Object.assign(new Error('Synthetic ended session'), {code: 'SIGN_IN_REQUIRED'});
        }),
        {
          code:
            mode === 'session-ended'
              ? 'SIGN_IN_REQUIRED'
              : mode === 'provider-error'
                ? 'OAUTH_EXCHANGE_FAILED'
                : 'OAUTH_RESPONSE_INVALID',
        },
      );
      assert.equal(f.sent.length, 3);
      assert.equal(f.store.listConnections('local').length, 0);
    } finally {
      f.store.close();
    }
  }
});

test('X’s request token must confirm the callback; Meta’s long-lived exchange can be switched off', async () => {
  const unconfirmed = await fixture({}, () => form('oauth_token=x-request&oauth_token_secret=x-secret'));
  const shortLived = await fixture({AMCP_META_LONG_LIVED_TOKEN: 'false'}, tokenAnswers);
  try {
    await assert.rejects(unconfirmed.oauth.start(unconfirmed.session, 'x'), e => {
      assert.equal(e.code, 'OAUTH_RESPONSE_INVALID');
      assert.equal(e.message, 'X did not confirm the callback.');
      return true;
    });
    const result = await shortLived.oauth.exchange('meta', stored('meta'), {code: 'meta-code'});
    assert.equal(result.credentials.accessToken, 'meta-short');
    assert.equal(shortLived.sent.length, 1);
    // With reviewed writes allowed, X asks for write access and the state records it.
    const writes = await fixture(
      {},
      () => form('oauth_token=x-write&oauth_token_secret=x-write-secret&oauth_callback_confirmed=true'),
      true,
    );
    try {
      await writes.oauth.start(writes.session, 'x');
      assert.equal(writes.sent[0].url, 'https://api.x.com/oauth/request_token?x_auth_access_type=write');
    } finally {
      writes.store.close();
    }
  } finally {
    unconfirmed.store.close();
    shortLived.store.close();
  }
});

test('Apple connects with the server’s credentials only; its key stands in for a secret and its scope is fixed', async () => {
  const f = await fixture({AMCP_APPLE_CLIENT_ID: 'SEARCHADS.apple-client'});
  try {
    await assert.rejects(f.oauth.connectService('meta'), e => e.code === 'OAUTH_FLOW_REQUIRED');
    await assert.rejects(f.oauth.connectService('apple'), e => {
      assert.equal(e.code, 'PROVIDER_SETUP_REQUIRED');
      assert.equal(e.message, 'Configure Apple Ads API credentials in Railway before connecting.');
      return true;
    });
    assert.deepEqual(f.sent, []);
    const keyed = new PlatformOAuth(f.web, {
      AMCP_APPLE_CLIENT_ID: 'SEARCHADS.apple-client',
      AMCP_APPLE_TEAM_ID: 'SEARCHADS.team',
      AMCP_APPLE_KEY_ID: 'key-id',
      AMCP_APPLE_PRIVATE_KEY: 'synthetic-key',
      AMCP_APPLE_SCOPES: 'other',
    }).config(platform('apple'));
    assert.equal(keyed.configured, true);
    assert.deepEqual(keyed.scopes, platform('apple').scopes);
    // Microsoft needs its developer token besides the client.
    assert.equal(
      new PlatformOAuth(f.web, {...env, AMCP_MICROSOFT_DEVELOPER_TOKEN: ''}).config(platform('microsoft')).configured,
      false,
    );
    assert.equal(new PlatformOAuth(f.web, env).config(platform('microsoft')).configured, true);
    // A platform's scopes setting replaces its defaults (Apple's excepted).
    assert.deepEqual(
      new PlatformOAuth(f.web, {...env, AMCP_SNAPCHAT_SCOPES: 'a, b'}).config(platform('snapchat')).scopes,
      ['a', 'b'],
    );
  } finally {
    f.store.close();
  }
});
