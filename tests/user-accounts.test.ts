import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, randomBytes, createHash} from 'node:crypto';
import {SignJWT, exportJWK} from 'jose';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {createHttpApp} from '../server/http-app.js';
import {WebStore, sessionIdleMs} from '../server/web-store.js';
import {UserAccounts, hashUserPassword} from '../server/user-accounts.js';
import {McpOAuth} from '../server/mcp-oauth.js';
import type {JsonObject} from '../src/types.js';
const master = Buffer.alloc(32, 65).toString('base64'),
  password = 'synthetic-member-password',
  origin = 'https://amcp.shop';
const key = generateKeyPairSync('rsa', {modulusLength: 2048}),
  json = (body: unknown) => new Response(JSON.stringify(body), {headers: {'Content-Type': 'application/json'}});
async function fixture(extra: NodeJS.ProcessEnv = {}, site: {testPassword?: string} = {}) {
  const store = new Store(':memory:', master),
    env: NodeJS.ProcessEnv = {
      AMCP_EMAIL_API_KEY: 'synthetic-mail-secret',
      AMCP_EMAIL_FROM: 'AMCP <accounts@example.test>',
      AMCP_SIGNIN_GOOGLE_CLIENT_ID: 'google-client',
      AMCP_SIGNIN_GOOGLE_CLIENT_SECRET: 'google-secret',
      AMCP_SIGNIN_APPLE_CLIENT_ID: 'apple-client',
      AMCP_SIGNIN_APPLE_CLIENT_SECRET: 'synthetic-apple-secret',
      AMCP_SIGNIN_FACEBOOK_CLIENT_ID: 'facebook-client',
      AMCP_SIGNIN_FACEBOOK_CLIENT_SECRET: 'facebook-secret',
      ...extra,
    };
  const web = new WebStore(store, {
      origin,
      masterKey: master,
      adminPassword: password,
      ...site,
      authEnv: env,
      fetcher: ((...args: Parameters<typeof fetch>) => fetcher(...args)) as typeof fetch,
    }),
    accounts = new UserAccounts(web),
    calls: {url: string; init: RequestInit}[] = [],
    emails: JsonObject[] = [],
    state = {
      nonce: '',
      subject: 'person-1',
      email: 'member@example.test',
      invalid: '',
      mailGate: undefined as Promise<void> | undefined,
    };
  const jwk = {...(await exportJWK(key.publicKey)), alg: 'RS256', kid: 'test-key', use: 'sig'};
  const fetcher: typeof fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({url: u.href, init});
    if (u.href === 'https://api.resend.com/emails') {
      emails.push(JSON.parse(String(init.body)));
      await state.mailGate;
      return json({id: 'email-test'});
    }
    if (u.pathname.endsWith('/certs') || u.pathname.endsWith('/keys')) return json({keys: [jwk]});
    if (u.hostname === 'graph.facebook.com') {
      if (u.pathname.endsWith('/access_token')) return json({access_token: 'facebook-access-only'});
      return json({id: '123456', name: 'Facebook member', email: 'do-not-trust@example.test'});
    }
    if (u.hostname === 'oauth2.googleapis.com' || u.hostname === 'appleid.apple.com') {
      const apple = u.hostname === 'appleid.apple.com',
        claims: JsonObject = {
          nonce: state.invalid === 'nonce' ? 'wrong' : state.nonce,
          email: state.email,
          email_verified: true,
        };
      if (state.invalid === 'azp') claims.azp = 'another-client';
      const token = await new SignJWT(claims)
        .setProtectedHeader({alg: 'RS256', kid: 'test-key'})
        .setIssuer(
          state.invalid === 'issuer'
            ? 'https://attacker.invalid'
            : apple
              ? 'https://appleid.apple.com'
              : 'https://accounts.google.com',
        )
        .setAudience(state.invalid === 'audience' ? 'another-client' : apple ? 'apple-client' : 'google-client')
        .setSubject(state.subject)
        .setIssuedAt()
        .setExpirationTime(state.invalid === 'expired' ? Math.floor(Date.now() / 1000) - 60 : '5m')
        .sign(key.privateKey);
      return json({
        access_token: 'social-access-only',
        id_token: state.invalid === 'signature' ? token.slice(0, -8) + 'invalidx' : token,
      });
    }
    throw Error('Unexpected provider egress ' + u.origin);
  };
  const service = new MirrorService(new Registry(), store),
    listener = await listenForFetch(
      createHttpApp(service, store, {
        website: {origin, masterKey: master, adminPassword: password, ...site, authEnv: env, fetcher},
      }),
    );
  const base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  const request = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, {
        method,
        redirect: 'manual',
        headers: {Origin: origin, ...(body ? {'Content-Type': 'application/json'} : {}), ...headers},
        body: body ? JSON.stringify(body) : undefined,
      }),
      bytes = await r.arrayBuffer();
    return new Response(bytes, {status: r.status, headers: r.headers});
  };
  const create = async (email = 'member@example.test') =>
    store.transaction(() => accounts.newUser('Test member', email, null, true));
  const credentials = (s: ReturnType<WebStore['createSession']>) => ({Cookie: web.cookie(s.id), 'X-AMCP-CSRF': s.csrf});
  const signup = async (email = 'member@example.test') => {
    assert.equal((await request('/api/account/register', 'POST', {name: 'Test member', email})).status, 200);
    const link = /https:\/\/\S+/.exec(emails.at(-1)!.text)![0]!,
      params = new URLSearchParams(new URL(link).hash.slice(1));
    return {token: params.get('token'), kind: 'register', password};
  };
  const login = async (email = 'member@example.test') => {
    const r = await request('/api/account/login', 'POST', {email, password});
    assert.equal(r.status, 200);
    return {Cookie: r.headers.get('set-cookie')!.split(';')[0]!, 'X-AMCP-CSRF': (await r.json()).csrf};
  };
  const begin = async (provider: string, headers: Record<string, string> = {}, link = false) => {
    const r = await request('/api/signin/' + provider + '/start', 'POST', {link}, headers);
    assert.equal(r.status, 200);
    const url = new URL((await r.json()).url);
    state.nonce = url.searchParams.get('nonce') ?? '';
    return {url, flow: r.headers.get('set-cookie')!.split(';')[0]!, state: url.searchParams.get('state')!};
  };
  const callback = async (
    provider: string,
    start: {flow: string; state: string},
    extra: Record<string, string> = {},
  ) => {
    if (provider === 'apple') {
      const r = await fetch(base + '/api/signin/apple/callback', {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: start.flow,
            Origin: 'https://appleid.apple.com',
            ...extra,
          },
          body: new URLSearchParams({state: start.state, code: 'synthetic-code'}),
        }),
        bytes = await r.arrayBuffer();
      return new Response(bytes, {status: r.status, headers: r.headers});
    }
    return request(
      '/api/signin/' + provider + '/callback?' + new URLSearchParams({state: start.state, code: 'synthetic-code'}),
      'GET',
      undefined,
      {Cookie: start.flow, ...extra},
    );
  };
  return {
    store,
    web,
    accounts,
    env,
    state,
    calls,
    emails,
    request,
    create,
    credentials,
    signup,
    login,
    begin,
    callback,
    close: async () => {
      const p = new Promise<void>(r => listener.close(() => r()));
      listener.closeAllConnections();
      await p;
      store.close();
    },
  };
}
test('email registration verifies ownership before choosing a password; isolated member sign-in is persistent and CSRF protected', async () => {
  const f = await fixture({AMCP_AUTO_APPROVE_SIGNUPS: 'true'});
  try {
    const link = await f.signup();
    assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM amcp_users').get() as JsonObject).n, 0);
    const records = JSON.stringify(f.store.db.prepare('SELECT * FROM amcp_account_challenges').all());
    assert.ok(!records.includes(link.token!) && !records.includes('member@example.test'));
    assert.equal((await f.request('/api/account/verify-email', 'POST', link)).status, 200);
    assert.equal((await f.request('/api/account/verify-email', 'POST', link)).status, 400);
    const headers = await f.login(),
      s = await (await f.request('/api/session', 'GET', undefined, headers)).json();
    assert.equal(s.name, 'Test member');
    assert.equal(s.administrator, false);
    assert.equal(s.email, 'member@example.test');
    assert.match(headers.Cookie, /__Host-amcp_session=/);
    assert.deepEqual(
      (await (await f.request('/api/platforms', 'GET', undefined, headers)).json()).platforms.flatMap(
        (p: JsonObject) => p.connections,
      ),
      [],
    );
    const user = f.store.db.prepare('SELECT * FROM amcp_users').get() as JsonObject;
    assert.notEqual(user.tenant_id, 'local');
    assert.equal(user.password_hash.includes(password), false);
    assert.equal(
      (
        await f.request(
          '/api/account/profile',
          'POST',
          {name: 'New name', workspaceName: 'My workspace'},
          {Cookie: headers.Cookie},
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.request('/api/account/profile', 'POST', {name: 'New name', workspaceName: 'My workspace'}, headers))
        .status,
      200,
    );
    assert.equal(
      (await (await f.request('/api/session', 'GET', undefined, headers)).json()).workspaceName,
      'My workspace',
    );
    assert.equal((await f.request('/api/account/options')).headers.get('cache-control'), 'no-store');
    assert.equal((await f.request('/api/account/login', 'POST', {email: user.email, password: 'wrong'})).status, 401);
  } finally {
    await f.close();
  }
});
test('reset and registration answer without waiting on the email provider, so response time does not reveal an account', async () => {
  const f = await fixture({AMCP_AUTO_APPROVE_SIGNUPS: 'true'});
  let release = () => {};
  try {
    await f.create('member@example.test');
    f.state.mailGate = new Promise<void>(r => (release = r));
    const answer = (path: string, body: JsonObject) =>
      Promise.race([
        f.request(path, 'POST', body).then(r => r.status),
        new Promise(r => setTimeout(() => r('waited on delivery'), 3000)),
      ]);
    // The existing account gets a reset email and the new address a registration email; neither response waits for it.
    assert.equal(await answer('/api/account/forgot-password', {email: 'member@example.test'}), 200);
    assert.equal(await answer('/api/account/register', {name: 'New member', email: 'new@example.test'}), 200);
    assert.deepEqual(
      f.emails.map(e => e.to),
      [['member@example.test'], ['new@example.test']],
      'delivery started for both',
    );
    const sent = () =>
      (f.store.db.prepare("SELECT count(*) AS n FROM amcp_email_outbox WHERE state='sent'").get() as JsonObject).n;
    assert.equal(sent(), 0);
    release();
    for (let i = 0; i < 100 && sent() < 2; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(sent(), 2, 'the started deliveries complete after the responses');
  } finally {
    release();
    await f.close();
  }
});
test('a flood of one challenge kind, such as anonymous social starts, leaves room for resets and two-step sign-in', async () => {
  const f = await fixture();
  try {
    const insert = f.store.db.prepare('INSERT INTO amcp_account_challenges VALUES(?,?,?,?)'),
      until = Date.now() + 600000;
    f.store.transaction(() => {
      for (let i = 0; i < 10000; i++) insert.run('flood-' + i, 'social', 'sealed', until);
    });
    assert.throws(() => f.accounts.challenge('social', {}), {code: 'AUTH_BUSY'});
    const user = await f.create('member@example.test');
    assert.match(f.accounts.challenge('reset', {userId: user.id, version: user.version}), /^[\w-]{43}$/);
    assert.match(f.accounts.challenge('mfa_login', {userId: user.id}), /^[\w-]{43}$/);
  } finally {
    await f.close();
  }
});
test('reset links are single-use, expire, and revoke only their owner browser sessions and MCP credentials', async () => {
  const f = await fixture({AMCP_AUTO_APPROVE_SIGNUPS: 'true'});
  try {
    await f.request('/api/account/verify-email', 'POST', await f.signup());
    const headers = await f.login();
    const user = f.store.db.prepare('SELECT * FROM amcp_users').get() as JsonObject,
      other = await f.create('other@example.test');
    const key1 = f.store.createKey({tenantId: user.tenant_id, userId: 'connector/one', role: 'reader'}, 3600000),
      key2 = f.store.createKey({tenantId: other.tenant_id, userId: 'connector/two', role: 'reader'}, 3600000);
    assert.equal((await f.request('/api/account/forgot-password', 'POST', {email: user.email})).status, 200);
    const url = new URL(/https:\/\/\S+/.exec(f.emails.at(-1)!.text)![0]!),
      token = new URLSearchParams(url.hash.slice(1)).get('token');
    const input = {kind: 'reset', token, password: 'a-new-long-password'};
    assert.equal((await f.request('/api/account/verify-email', 'POST', input)).status, 200);
    assert.equal((await (await f.request('/api/session', 'GET', undefined, headers)).json()).authenticated, false);
    assert.throws(() => f.store.authenticate(key1));
    assert.ok(f.store.authenticate(key2));
    assert.equal((await f.request('/api/account/verify-email', 'POST', input)).status, 400);
    const expired = f.accounts.challenge('reset', {userId: user.id, version: 2}, -1);
    assert.throws(() => f.accounts.readChallenge(expired, 'reset'), /expired/);
  } finally {
    await f.close();
  }
});
test('Google, Apple form_post and Facebook sign-in bind a one-use state to the initiating browser and create private workspaces', async () => {
  for (const provider of ['google', 'apple', 'facebook']) {
    const f = await fixture({AMCP_AUTO_APPROVE_SIGNUPS: 'true'});
    try {
      const start = await f.begin(provider);
      assert.equal(start.url.searchParams.get('redirect_uri'), origin + '/api/signin/' + provider + '/callback');
      if (provider === 'google') {
        assert.equal(start.url.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(start.url.searchParams.get('code_challenge')?.length, 43);
      }
      if (provider === 'apple') assert.equal(start.url.searchParams.get('response_mode'), 'form_post');
      const wrong = await f.callback(provider, start, {Cookie: '__Host-amcp_login_flow=wrong'});
      assert.match(wrong.headers.get('location')!, /SIGNIN_STATE_INVALID/);
      const r = await f.callback(provider, start);
      assert.equal(r.status, 303);
      assert.equal(r.headers.get('location'), '/auth/complete');
      assert.match(r.headers.get('set-cookie')!, /HttpOnly; SameSite=Lax/);
      const user = f.store.db.prepare('SELECT * FROM amcp_users').get() as JsonObject;
      assert.notEqual(user.tenant_id, 'local');
      assert.equal(user.email, provider === 'facebook' ? null : f.state.email);
      const data = JSON.stringify(f.store.db.prepare('SELECT * FROM amcp_identities').all());
      assert.ok(!data.includes('social-access-only') && !data.includes('facebook-access-only'));
      assert.match((await f.callback(provider, start)).headers.get('location')!, /SIGNIN_FAILED/);
      const tokenCall = f.calls.find(c => c.url.includes('/token') || c.url.includes('/access_token'))!;
      assert.equal(tokenCall.init.redirect, 'error');
      assert.ok(new URLSearchParams(String(tokenCall.init.body)).get('client_secret'));
    } finally {
      await f.close();
    }
  }
});
test('signed identity validation rejects bad nonce, audience, issuer, expiry, authorized party and signature', async () => {
  for (const invalid of ['nonce', 'audience', 'issuer', 'expired', 'azp', 'signature']) {
    const f = await fixture();
    try {
      f.state.invalid = invalid;
      const r = await f.callback('google', await f.begin('google'));
      assert.match(r.headers.get('location')!, /SIGNIN_FAILED/);
      assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM amcp_users').get() as JsonObject).n, 0);
    } finally {
      await f.close();
    }
  }
});
test('matching email never silently links identities; authenticated linking works and cannot remove the last sign-in method', async () => {
  const f = await fixture({AMCP_AUTO_APPROVE_SIGNUPS: 'true'});
  try {
    await f.request('/api/account/verify-email', 'POST', await f.signup());
    const existing = await f.callback('google', await f.begin('google'));
    assert.match(existing.headers.get('location')!, /ACCOUNT_EXISTS/);
    const headers = await f.login(),
      start = await f.begin('google', headers, true),
      r = await f.callback('google', start);
    assert.equal(r.headers.get('location'), '/account?linked=true');
    assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM amcp_users').get() as JsonObject).n, 1);
    const social = await f.callback('facebook', await f.begin('facebook')),
      cookie = social.headers
        .getSetCookie()
        .find(c => c.startsWith('__Host-amcp_session='))!
        .split(';')[0]!;
    const s = await (await f.request('/api/session', 'GET', undefined, {Cookie: cookie})).json();
    assert.equal(
      (
        await f.request('/api/account/identities/facebook', 'DELETE', undefined, {
          Cookie: cookie,
          'X-AMCP-CSRF': s.csrf,
        })
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});
test('member account sessions and server-owned credentials do not cross workspace boundaries', async () => {
  const f = await fixture();
  try {
    const a = await f.create('a@example.test'),
      b = await f.create('b@example.test'),
      sa = f.accounts.session(a),
      sb = f.accounts.session(b),
      headers = f.credentials(sa),
      other = f.credentials(sb);
    const listed = await (await f.request('/api/account/sessions', 'GET', undefined, headers)).json(),
      foreign = await (await f.request('/api/account/sessions', 'GET', undefined, other)).json();
    assert.equal(listed.sessions.length, 1);
    assert.equal(
      (await f.request('/api/account/sessions/' + foreign.sessions[0].id, 'DELETE', undefined, headers)).status,
      404,
    );
    assert.equal(
      (await f.request('/api/account/sessions/' + listed.sessions[0].id, 'DELETE', undefined, headers)).status,
      200,
    );
    assert.equal((await (await f.request('/api/session', 'GET', undefined, other)).json()).authenticated, true);
    const apple = await f.request('/api/auth/apple/start', 'POST', {}, other);
    assert.equal(apple.status, 403);
    assert.equal((await apple.json()).error.code, 'SERVICE_CONNECTION_RESTRICTED');
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
test('MCP consent and refresh bind grants to the signed-in member workspace; tenant revocation cannot revoke another member', async () => {
  const f = await fixture();
  try {
    const oauth = new McpOAuth(f.web, true),
      client = await oauth.clientsStore.registerClient({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      }),
      a = await f.create('a@example.test'),
      b = await f.create('b@example.test');
    const issue = async (user: JsonObject) => {
      let redirect = '';
      const verifier = randomBytes(32).toString('base64url');
      await oauth.authorize(
        client,
        {
          redirectUri: client.redirect_uris[0]!,
          codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
          scopes: ['mcp:read'],
          resource: new URL(origin + '/mcp'),
        },
        {redirect: (_n: number, u: string) => (redirect = u)} as any,
      );
      const request = new URL(redirect).searchParams.get('request')!,
        url = oauth.decide(request, f.accounts.session(user), true);
      return oauth.exchangeAuthorizationCode(
        client,
        new URL(url).searchParams.get('code')!,
        verifier,
        client.redirect_uris[0],
        new URL(origin + '/mcp'),
      );
    };
    const first = await issue(a),
      second = await issue(b);
    assert.equal(f.store.authenticate(first.access_token).tenantId, a.tenant_id);
    assert.equal(f.store.authenticate(second.access_token).tenantId, b.tenant_id);
    assert.equal(oauth.authorizations('local').length, 0);
    assert.equal(oauth.authorizations(a.tenant_id).length, 1);
    oauth.revokeClient(client.client_id, a.tenant_id);
    assert.throws(() => f.store.authenticate(first.access_token));
    assert.ok(f.store.authenticate(second.access_token));
    const next = await oauth.exchangeRefreshToken(client, second.refresh_token!);
    assert.equal(f.store.authenticate(next.access_token).tenantId, b.tenant_id);
  } finally {
    await f.close();
  }
});
// WEB-02: production reported signupEnabled with no email delivery and no social sign-in, so every public call to
// action led to a sign-up no method could complete. registrationAvailable reports whether one can.
test('registrationAvailable is true only when sign-up is open and email or a social sign-in can complete it', async () => {
  const none = {
    AMCP_EMAIL_API_KEY: '',
    AMCP_SIGNIN_GOOGLE_CLIENT_ID: '',
    AMCP_SIGNIN_APPLE_CLIENT_ID: '',
    AMCP_SIGNIN_FACEBOOK_CLIENT_ID: '',
  };
  for (const [env, expected] of [
    [none, false],
    [{...none, AMCP_EMAIL_API_KEY: 'synthetic-mail-secret'}, true],
    [{...none, AMCP_SIGNIN_GOOGLE_CLIENT_ID: 'google-client'}, true],
    [{AMCP_ALLOW_SIGNUP: 'false'}, false],
  ] as [NodeJS.ProcessEnv, boolean][]) {
    const f = await fixture(env);
    try {
      const options = await (await f.request('/api/account/options')).json();
      assert.equal(options.registrationAvailable, expected, JSON.stringify(env));
      assert.equal(options.signupEnabled, env.AMCP_ALLOW_SIGNUP !== 'false', 'The policy flag keeps its meaning');
      if (!expected)
        assert.notEqual(
          (await f.request('/api/account/register', 'POST', {name: 'Name', email: 'new@example.test'})).status,
          200,
          'A deployment that reports registration unavailable also refuses it',
        );
    } finally {
      await f.close();
    }
  }
});
test('account recovery and social signup fail closed without configured delivery or open registration', async () => {
  const f = await fixture({AMCP_EMAIL_API_KEY: '', AMCP_ALLOW_SIGNUP: 'false'});
  try {
    const options = await (await f.request('/api/account/options')).json();
    assert.equal(options.emailEnabled, false);
    assert.equal(options.signupEnabled, false);
    assert.ok(!JSON.stringify(options).includes('secret'));
    assert.equal(
      (await f.request('/api/account/register', 'POST', {name: 'Name', email: 'test@example.test'})).status,
      403,
    );
    assert.equal((await f.request('/api/account/forgot-password', 'POST', {email: 'test@example.test'})).status, 503);
    assert.match((await f.callback('google', await f.begin('google'))).headers.get('location')!, /SIGNUP_DISABLED/);
    assert.equal(f.emails.length, 0);
    await assert.rejects(() => hashUserPassword('short'), /15 and 128/);
  } finally {
    await f.close();
  }
});
test('closing registration invalidates outstanding signup links and signing out cancels a started member social flow', async () => {
  const f = await fixture({AMCP_AUTO_APPROVE_SIGNUPS: 'true'});
  try {
    const link = await f.signup();
    f.env.AMCP_ALLOW_SIGNUP = 'false';
    assert.equal((await f.request('/api/account/verify-email', 'POST', link)).status, 403);
    f.env.AMCP_ALLOW_SIGNUP = 'true';
    await f.request('/api/account/verify-email', 'POST', link);
    const headers = await f.login(),
      start = await f.begin('google', headers, true);
    const logout = await f.request('/api/session', 'DELETE', undefined, headers);
    assert.equal(logout.status, 200);
    assert.ok(logout.headers.getSetCookie().some(c => c.includes('amcp_login_flow=;') && c.includes('Max-Age=0')));
    assert.match((await f.callback('google', start)).headers.get('location')!, /SIGNIN_FAILED/);
    assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM amcp_identities').get() as JsonObject).n, 0);
  } finally {
    await f.close();
  }
});
test('new public pages and branding assets serve with CSP, while account data requires a session', async () => {
  const f = await fixture();
  try {
    for (const path of [
      '/',
      '/connections',
      '/account',
      '/login',
      '/signup',
      '/verify-email',
      '/reset-password',
      '/forgot-password',
      '/auth/complete',
      '/assets/identity.js',
      '/assets/identity.css',
      '/assets/mark.svg',
    ]) {
      const r = await f.request(path);
      assert.equal(r.status, 200, path);
      assert.match(r.headers.get('content-security-policy')!, /script-src 'self'/);
    }
    // Google's reviewers read /privacy signed out and without JavaScript, so it must be the
    // policy itself rather than the SPA shell, and must carry its data-protection section.
    const policy = await f.request('/privacy');
    assert.equal(policy.status, 200);
    const html = await policy.text();
    assert.match(html, /How we protect sensitive data/);
    for (const claim of ['AES-256-GCM', 'scrypt', 'HttpOnly', 'Limited Use']) assert.ok(html.includes(claim), claim);
    assert.ok(!html.includes('app-shell'), '/privacy must not fall through to the SPA shell');
    assert.equal((await f.request('/assets/privacy.css')).status, 200);
    for (const path of ['/api/account', '/api/account/sessions']) assert.equal((await f.request(path)).status, 401);
    assert.equal(
      (
        await f.request(
          '/api/account/register',
          'POST',
          {name: 'Test', email: 'test@example.test'},
          {Origin: 'https://attacker.invalid'},
        )
      ).status,
      403,
    );
  } finally {
    await f.close();
  }
});

test('self-service signups need owner approval, and revoking access ends live sessions', async () => {
  const f = await fixture({AMCP_OWNER_EMAIL: 'owner@example.test'});
  try {
    // Approval is the default: signing up no longer grants access on its own.
    const verify = await f.signup();
    assert.equal((await f.request('/api/account/verify-email', 'POST', verify)).status, 200);
    const denied = await f.request('/api/account/login', 'POST', {email: 'member@example.test', password});
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'ACCOUNT_PENDING_APPROVAL');

    // The owner sees the request. A pending account cannot approve itself or anyone else.
    const owner = f.credentials(
      f.web.createSession({tenantId: f.web.tenantId, userId: 'workspace-admin', role: 'admin'}),
    );
    const listed = await (await f.request('/api/owner/accounts', 'GET', undefined, owner)).json();
    const pending = listed.accounts.find((a: any) => a.email === 'member@example.test');
    assert.equal(pending.state, 'pending');
    assert.equal(listed.pending, 1);
    // SEC-07 S4: the owner is told that requests left pending are erased after 30 days (the default).
    assert.equal(listed.pendingRetentionDays, 30);
    // The owner needs to know how someone signed up before deciding whether to let them in.
    assert.deepEqual(pending.methods, ['email']);
    assert.equal((await f.request('/api/owner/accounts', 'GET')).status, 401);

    // Granting access lets the same credentials through.
    // The owner is emailed the request, and the applicant is emailed once access is granted.
    const drain = async () => {
      while (await f.accounts.deliverEmails());
    };
    await drain();
    const request = f.emails.find(m => /access request/i.test(String(m.subject)));
    assert.ok(request, JSON.stringify(f.emails.map(m => m.subject)));
    assert.deepEqual(request!.to, ['owner@example.test']);
    assert.equal(
      (await f.request('/api/owner/accounts/access', 'POST', {user_id: pending.id, grant: true}, owner)).status,
      200,
    );
    await drain();
    assert.ok(
      f.emails.some(m => /access is ready/i.test(String(m.subject))),
      JSON.stringify(f.emails.map(m => m.subject)),
    );
    const session = await f.login();
    assert.equal((await f.request('/api/account', 'GET', undefined, session)).status, 200);

    // A workspace owner elsewhere on the instance must not inherit this authority.
    const other = await f.create('other@example.test');
    const otherSession = f.credentials(
      f.web.createSession({
        tenantId: other.tenant_id as string,
        userId: other.id as string,
        role: 'admin',
        membershipRole: 'owner',
      }),
    );
    assert.equal((await f.request('/api/owner/accounts', 'GET', undefined, otherSession)).status, 403);
    assert.equal(
      (await f.request('/api/owner/accounts/access', 'POST', {user_id: pending.id, grant: false}, otherSession)).status,
      403,
    );

    // Revoking takes effect immediately, not at session expiry.
    assert.equal(
      (await f.request('/api/owner/accounts/access', 'POST', {user_id: pending.id, grant: false}, owner)).status,
      200,
    );
    assert.equal((await f.request('/api/account', 'GET', undefined, session)).status, 401);
    // A revoked account is refused like any disabled one, without confirming it still exists.
    // Only a never-approved account is told it is waiting, which is the state it can act on.
    assert.equal((await f.request('/api/account/login', 'POST', {email: 'member@example.test', password})).status, 401);
    const after = await (await f.request('/api/owner/accounts', 'GET', undefined, owner)).json();
    assert.equal(after.accounts.find((a: any) => a.email === 'member@example.test').state, 'revoked');
    await drain();
    assert.ok(
      f.emails.some(m => /access has been removed/i.test(String(m.subject))),
      JSON.stringify(f.emails.map(m => m.subject)),
    );

    // Access can be restored, and the owner cannot lock themselves out.
    assert.equal(
      (await f.request('/api/owner/accounts/access', 'POST', {user_id: pending.id, grant: true}, owner)).status,
      200,
    );
    assert.equal((await f.request('/api/account/login', 'POST', {email: 'member@example.test', password})).status, 200);
  } finally {
    await f.close();
  }
});

test('the owner is told which variables are missing, and verification email can be resent', async () => {
  // Email off: masterKey is present here, so only the two delivery variables are named.
  const off = await fixture({
    AMCP_EMAIL_API_KEY: '',
    AMCP_EMAIL_FROM: '',
    AMCP_ALLOW_SIGNUP: 'false',
    AMCP_PENDING_ACCOUNT_DAYS: 'off',
  });
  try {
    const owner = off.credentials(
      off.web.createSession({tenantId: off.web.tenantId, userId: 'workspace-admin', role: 'admin'}),
    );
    const data = await (await off.request('/api/owner/accounts', 'GET', undefined, owner)).json();
    // SEC-07 S4: with retention off, no erasure is announced.
    assert.equal(data.pendingRetentionDays, null);
    assert.deepEqual(data.setup.email, ['AMCP_EMAIL_API_KEY', 'AMCP_EMAIL_FROM']);
    assert.deepEqual(data.setup.signup, ['AMCP_ALLOW_SIGNUP']);
    assert.ok(data.providers.some((p: any) => p.id === 'google'));
    // Setup detail is owner-only; it names server variables and must not leak to a visitor.
    assert.equal((await off.request('/api/owner/accounts')).status, 401);
  } finally {
    await off.close();
  }

  const f = await fixture({AMCP_OWNER_EMAIL: 'owner@example.test'});
  try {
    const owner = f.credentials(
      f.web.createSession({tenantId: f.web.tenantId, userId: 'workspace-admin', role: 'admin'}),
    );
    const data = await (await f.request('/api/owner/accounts', 'GET', undefined, owner)).json();
    assert.deepEqual(data.setup.email, []);
    assert.deepEqual(data.setup.ownerNotice, []);

    // Resending re-sends the verification link rather than creating a second account.
    await f.signup();
    const sent = f.emails.length;
    const again = await f.request('/api/account/resend-verification', 'POST', {
      name: 'Test member',
      email: 'member@example.test',
    });
    assert.equal(again.status, 200);
    while (await f.accounts.deliverEmails());
    assert.equal(f.emails.length, sent + 1);
    assert.deepEqual(f.emails.at(-1)!.to, ['member@example.test']);
    assert.equal(
      (f.store.db.prepare('SELECT count(*) AS n FROM amcp_users').get() as {n: number}).n,
      0,
      'resending must not create an account',
    );
  } finally {
    await f.close();
  }
});

test('a test account is scoped to the evaluator tabs and inherits no owner connections', async () => {
  const f = await fixture({
    AMCP_OWNER_EMAIL: 'owner@example.test',
    AMCP_META_CLIENT_ID: 'synthetic-meta-client',
    AMCP_META_CLIENT_SECRET: 'synthetic-meta-secret',
  });
  try {
    const owner = f.credentials(
      f.web.createSession({tenantId: f.web.tenantId, userId: 'workspace-admin', role: 'admin'}),
    );

    // The owner-initiated setup link mirrors owner setup: the recipient picks their own password.
    assert.equal(
      (
        await f.request(
          '/api/owner/accounts/test-invite',
          'POST',
          {name: 'Reviewer', email: 'reviewer@example.test'},
          owner,
        )
      ).status,
      200,
    );
    const link = /https:\/\/\S+/.exec(String(f.emails.at(-1)!.text))![0]!;
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get('token');
    assert.equal(
      (await f.request('/api/account/verify-email', 'POST', {kind: 'register', token, password})).status,
      200,
    );

    // Inviting is the vetting step, so it needs no second approval.
    const session = await f.login('reviewer@example.test');
    const profile = await (await f.request('/api/account', 'GET', undefined, session)).json();
    assert.equal(profile.testAccount, true);

    // Included tabs work.
    for (const path of ['/api/activity', '/api/platforms'])
      assert.equal((await f.request(path, 'GET', undefined, session)).status, 200);
    assert.equal((await f.request('/api/workspace/overview', 'POST', {action: 'list'}, session)).status, 200);
    const connect = await f.request('/api/auth/meta/start', 'POST', {}, session);
    assert.equal(connect.status, 200, 'an invited test account can connect its own platform login');
    assert.equal(new URL((await connect.json()).url).hostname, 'www.facebook.com');

    // Product tools are available; their own argument and write checks still apply.
    for (const tool of ['campaign', 'reporting', 'media', 'write']) {
      const blocked = await f.request('/api/workspace/' + tool, 'POST', {action: 'list'}, session);
      assert.notEqual((await blocked.json()).error?.code, 'TEST_ACCOUNT_SCOPE', tool);
    }
    assert.equal((await f.request('/api/connector-tokens', 'GET', undefined, session)).status, 200);

    // Its workspace is its own: the owner's connections are not inherited.
    assert.notEqual(profile.workspaceId, f.web.tenantId);

    // The same routes stay open for an ordinary account.
    const ordinary = await f.create('ordinary@example.test');
    const full = f.credentials(
      f.web.createSession({
        tenantId: ordinary.tenant_id as string,
        userId: ordinary.id as string,
        role: 'admin',
        membershipRole: 'owner',
      }),
    );
    assert.notEqual((await f.request('/api/workspace/campaign', 'POST', {action: 'list'}, full)).status, 403);

    // Scope changes apply to the live session at its next request, not at expiry.
    const listed = await (await f.request('/api/owner/accounts', 'GET', undefined, owner)).json();
    const reviewer = listed.accounts.find((a: any) => a.email === 'reviewer@example.test');
    assert.equal(reviewer.test, true);
    assert.equal(
      (await f.request('/api/owner/accounts/access', 'POST', {user_id: reviewer.id, grant: true, test: false}, owner))
        .status,
      200,
    );
    assert.notEqual((await f.request('/api/workspace/campaign', 'POST', {action: 'list'}, session)).status, 403);
  } finally {
    await f.close();
  }
});

test('outside its own test workspace a test account is a viewer, and its keys there act as readers at most', async () => {
  const f = await fixture();
  try {
    const host = await f.create('host@example.test'),
      evaluator = await f.create('evaluator@example.test'),
      at = {tenantId: host.tenant_id, ownerUserId: evaluator.id};
    f.store.db
      .prepare("INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,'admin',?)")
      .run(host.tenant_id, evaluator.id, Date.now());
    // Keys the member authorized in that workspace before the instance owner made the account a test account.
    const operatorKey = f.store.createKey({...at, userId: 'connector/evaluator-operator', role: 'operator'}),
      readerKey = f.store.createKey({...at, userId: 'connector/evaluator-reader', role: 'reader'});
    f.store.db.prepare('UPDATE amcp_users SET test_account=1 WHERE id=?').run(evaluator.id);
    const tested = f.accounts.user(evaluator.id),
      own = f.accounts.session(tested),
      there = f.accounts.session(tested, host.tenant_id);
    // Its own test workspace keeps the reviewer scope; another workspace sees a viewer, on every request too.
    assert.equal(own.actor.role, 'admin');
    assert.deepEqual([there.actor.role, there.actor.membershipRole], ['reader', 'viewer']);
    const profile = await (await f.request('/api/account', 'GET', undefined, f.credentials(there))).json();
    assert.equal(profile.workspaceRole, 'viewer');
    assert.throws(() => f.store.assertActorActive(f.store.authenticate(operatorKey)), {code: 'MEMBERSHIP_REVOKED'});
    f.store.assertActorActive(f.store.authenticate(readerKey));
  } finally {
    await f.close();
  }
});
test("two reviewers signed in with the test password cannot see or end each other's sessions", async () => {
  const testPassword = 'reviewer-password-for-google-review';
  const f = await fixture({}, {testPassword});
  try {
    const enter = async () => {
      const r = await f.request('/api/session/test', 'POST', {password: testPassword});
      assert.equal(r.status, 200);
      return {Cookie: r.headers.get('set-cookie')!.split(';')[0]!, 'X-AMCP-CSRF': (await r.json()).csrf};
    };
    const first = await enter(),
      second = await enter();
    const list = async (h: Record<string, string>) =>
      (await (await f.request('/api/account/sessions', 'GET', undefined, h)).json()).sessions as JsonObject[];
    const mine = await list(first),
      theirs = await list(second);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.current, true);
    assert.equal(theirs.length, 1);
    assert.notEqual(mine[0]!.id, theirs[0]!.id);
    assert.equal((await f.request('/api/account/sessions/' + theirs[0]!.id, 'DELETE', undefined, first)).status, 404);
    assert.equal(
      (await f.request('/api/account', 'GET', undefined, second)).status,
      200,
      'the other reviewer stays signed in',
    );
    assert.equal((await f.request('/api/account/sessions/' + mine[0]!.id, 'DELETE', undefined, first)).status, 200);
    assert.equal((await f.request('/api/account', 'GET', undefined, first)).status, 401);
  } finally {
    await f.close();
  }
});
test('a reviewer signs in with the test password and lands scoped, outside the owner workspace', async () => {
  const testPassword = 'reviewer-password-for-google-review';
  const f = await fixture({}, {testPassword});
  try {
    // The door is advertised only when the server has a test password.
    const options = await (await f.request('/api/account/options')).json();
    assert.equal(options.testEnabled, true);

    assert.equal((await f.request('/api/session/test', 'POST', {password: 'wrong-password-entirely'})).status, 401);
    const entry = await f.request('/api/session/test', 'POST', {password: testPassword});
    assert.equal(entry.status, 200);
    const session = {Cookie: entry.headers.get('set-cookie')!.split(';')[0]!, 'X-AMCP-CSRF': (await entry.json()).csrf};

    const profile = await (await f.request('/api/account', 'GET', undefined, session)).json();
    assert.equal(profile.testAccount, true);
    // Never the workspace that holds real connections.
    assert.notEqual(profile.workspaceId, f.web.tenantId);
    assert.equal(profile.workspaceId, f.web.testTenantId);
    assert.equal(profile.administrator, false);

    // Product workflows and connector management are available in the isolated workspace.
    assert.equal((await f.request('/api/activity', 'GET', undefined, session)).status, 200);
    assert.equal((await f.request('/api/workspace/overview', 'POST', {action: 'list'}, session)).status, 200);
    for (const tool of ['campaign', 'reporting', 'media', 'write'])
      assert.notEqual(
        (await (await f.request('/api/workspace/' + tool, 'POST', {action: 'list'}, session)).json()).error?.code,
        'TEST_ACCOUNT_SCOPE',
        tool,
      );
    assert.equal((await f.request('/api/connector-tokens', 'GET', undefined, session)).status, 200);

    // It is not the administrator: owner-only account management stays closed.
    assert.equal((await f.request('/api/owner/accounts', 'GET', undefined, session)).status, 403);
  } finally {
    await f.close();
  }

  // Without the variable the door does not exist at all.
  const off = await fixture();
  try {
    assert.equal((await (await off.request('/api/account/options')).json()).testEnabled, false);
    assert.equal((await off.request('/api/session/test', 'POST', {password: testPassword})).status, 503);
  } finally {
    await off.close();
  }
});

test('a bad test password closes that door instead of stopping the deployment', async () => {
  // A misconfigured optional feature must never crash-loop a working deployment.
  for (const [value, reason] of [
    ['short', /at least 16/],
    [password, /must differ/],
  ] as [string, RegExp][]) {
    const f = await fixture({}, {testPassword: value});
    try {
      assert.match(f.web.testPasswordProblem!, reason);
      assert.equal(f.web.testConfigured, false);
      // The rest of the deployment is untouched: the page loads and the door simply is not offered.
      assert.equal((await f.request('/api/account/options')).status, 200);
      assert.equal((await (await f.request('/api/account/options')).json()).testEnabled, false);
      assert.equal((await f.request('/api/session/test', 'POST', {password: value})).status, 503);
      // The administrator password still works, including when the test password copied it.
      assert.equal((await f.request('/api/session', 'POST', {password})).status, 200);
    } finally {
      await f.close();
    }
  }
});

test('a website session unused for two hours ends, and activity keeps it alive', async () => {
  const f = await fixture({AMCP_AUTO_APPROVE_SIGNUPS: 'true'});
  try {
    await f.request('/api/account/verify-email', 'POST', await f.signup());
    const headers = await f.login();
    assert.equal((await f.request('/api/account', 'GET', undefined, headers)).status, 200);
    const seenAt = () =>
      (f.store.db.prepare("SELECT json_extract(actor,'$.seenAt') AS s FROM amcp_web_sessions").get() as JsonObject)?.s;
    // Ten idle minutes: still signed in, and the request counts as activity.
    f.store.db.prepare("UPDATE amcp_web_sessions SET actor=json_set(actor,'$.seenAt',?)").run(Date.now() - 600000);
    assert.equal((await f.request('/api/account', 'GET', undefined, headers)).status, 200);
    assert.ok(Number(seenAt()) > Date.now() - 60000, 'activity recorded');
    // Beyond the idle limit: signed out, and the session is gone.
    f.store.db
      .prepare("UPDATE amcp_web_sessions SET actor=json_set(actor,'$.seenAt',?)")
      .run(Date.now() - sessionIdleMs - 60000);
    assert.equal((await f.request('/api/account', 'GET', undefined, headers)).status, 401);
    assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM amcp_web_sessions').get() as JsonObject).n, 0);
  } finally {
    await f.close();
  }
});

test('security changes are emailed: a password change to the account, an email change to the old address', async () => {
  const f = await fixture({AMCP_AUTO_APPROVE_SIGNUPS: 'true'});
  try {
    await f.request('/api/account/verify-email', 'POST', await f.signup());
    let headers = await f.login();
    const changed = await f.request(
      '/api/account/password',
      'POST',
      {currentPassword: password, password: 'another-synthetic-password'},
      headers,
    );
    assert.equal(changed.status, 200);
    while (await f.accounts.deliverEmails());
    const notices = () => f.emails.filter(e => e.subject === 'Security change on your AMCP account');
    assert.equal(notices().length, 1);
    assert.deepEqual(notices()[0]!.to, ['member@example.test']);
    assert.match(String(notices()[0]!.text), /password of your AMCP account was changed/);
    assert.match(String(notices()[0]!.text), /forgot-password/);
    // Change the sign-in email: the notice goes to the previous address, which the change no longer controls.
    headers = {
      Cookie: changed.headers.get('set-cookie')!.split(';')[0]!,
      'X-AMCP-CSRF': (await changed.json()).csrf,
    };
    assert.equal((await f.request('/api/account/email', 'POST', {email: 'new@example.test'}, headers)).status, 200);
    while (await f.accounts.deliverEmails());
    const link = /https:\/\/\S+/.exec(String(f.emails.at(-1)!.text))![0]!,
      params = new URLSearchParams(new URL(link).hash.slice(1));
    assert.equal(
      (await f.request('/api/account/verify-email', 'POST', {kind: 'email', token: params.get('token')})).status,
      200,
    );
    while (await f.accounts.deliverEmails());
    assert.equal(notices().length, 2);
    assert.deepEqual(notices()[1]!.to, ['member@example.test']);
    assert.match(String(notices()[1]!.text), /changed to new@example\.test/);
  } finally {
    await f.close();
  }
});
test('SEC-06: a social-only member confirms it is them with their linked provider, renewing the same session only', async () => {
  const f = await fixture();
  try {
    const user = await f.create(),
      session = f.accounts.session(user),
      hash = createHash('sha256').update(session.id).digest('hex');
    f.store.db.prepare("INSERT INTO amcp_identities VALUES('google',?,?,?)").run(f.state.subject, user.id, Date.now());
    f.store.db
      .prepare("UPDATE amcp_web_sessions SET actor=json_set(actor,'$.signedInAt',?) WHERE hash=?")
      .run(Date.now() - 16 * 60000, hash);
    const expiry = () =>
      (f.store.db.prepare('SELECT expires_at FROM amcp_web_sessions WHERE hash=?').get(hash) as JsonObject).expires_at;
    const expiresAt = expiry();
    assert.throws(() => f.accounts.fresh(session), {code: 'REAUTH_REQUIRED'});
    // Only a provider already linked to this account can confirm it.
    const unlinked = await f.request('/api/signin/apple/start', 'POST', {reauth: true}, f.credentials(session));
    assert.equal(unlinked.status, 400);
    assert.equal((await unlinked.json()).error.code, 'SIGNIN_METHOD_UNAVAILABLE');
    const start = async () => {
      const r = await f.request('/api/signin/google/start', 'POST', {reauth: true}, f.credentials(session));
      assert.equal(r.status, 200);
      const url = new URL((await r.json()).url);
      f.state.nonce = url.searchParams.get('nonce') ?? '';
      return {flow: r.headers.get('set-cookie')!.split(';')[0]!, state: url.searchParams.get('state')!};
    };
    // Another person's Google identity cannot confirm this person.
    f.state.subject = 'someone-else';
    const refused = await f.callback('google', await start());
    assert.equal(refused.headers.get('location'), '/login?error=SIGNIN_IDENTITY_MISMATCH');
    assert.throws(() => f.accounts.fresh(session), {code: 'REAUTH_REQUIRED'});
    f.state.subject = 'person-1';
    const done = await f.callback('google', await start());
    assert.equal(done.status, 303);
    assert.equal(done.headers.get('location'), '/auth/complete?reauthenticated=true');
    // The same session continues, with its original expiry, and now counts as recently proven.
    assert.doesNotThrow(() => f.accounts.fresh(session));
    assert.equal(expiry(), expiresAt);
    assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM amcp_web_sessions').get() as JsonObject).n, 1);
    assert.equal((await f.request('/api/session', 'GET', undefined, f.credentials(session))).status, 200);
  } finally {
    await f.close();
  }
});

// WEB-08: the access list marks the caller's own row, so the page offers no action the server always refuses.
test("the instance owner's own access row is marked self, and changing it is still refused", async () => {
  const f = await fixture({AMCP_OWNER_EMAIL: 'owner@example.test'});
  try {
    const me = await f.create('owner@example.test'),
      member = await f.create('member@example.test');
    // A migrated owner account: an AMCP user who owns the instance workspace.
    f.store.db
      .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
      .run(f.web.tenantId, me.id, 'owner', Date.now());
    const owner = f.credentials(f.accounts.session(me, f.web.tenantId));
    const listed = await f.request('/api/owner/accounts', 'GET', undefined, owner);
    assert.equal(listed.status, 200);
    const accounts = (await listed.json()).accounts as JsonObject[];
    assert.equal(accounts.find(a => a.id === me.id)!.self, true);
    assert.equal(accounts.find(a => a.id === member.id)!.self, false);
    assert.equal(accounts.filter(a => a.self === true).length, 1);
    // The flag only describes the list; the server keeps refusing a change to the caller's own access.
    const own = await f.request('/api/owner/accounts/access', 'POST', {user_id: me.id, grant: false}, owner);
    assert.equal(own.status, 403);
    // The administrator door is not an account row, so nothing is marked self for it.
    const door = f.credentials(
      f.web.createSession({tenantId: f.web.tenantId, userId: 'workspace-admin', role: 'admin'}),
    );
    const doorRows = (await (await f.request('/api/owner/accounts', 'GET', undefined, door)).json())
      .accounts as JsonObject[];
    assert.ok(doorRows.length >= 2);
    assert.ok(doorRows.every(a => a.self === false));
  } finally {
    await f.close();
  }
});
