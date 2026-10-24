import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {createRuntime} from '../dist/server/runtime.js';
import {loadConfig} from '../dist/server/config.js';
import {linkedinVersion} from '../dist/src/linkedin-version.js';
import {metaApiVersion, resolveMetaVersion} from '../dist/src/meta-version.js';
import {googleDeveloperTokenWarning} from '../dist/src/google-version.js';

// ARC-01 phase B, the website's server modules: the provider facts of Facebook sign-in (server/social-signin.ts) and
// of the composition root's startup checks (server/runtime.ts) moved into the provider registries. These cases pin,
// through the public entry points and on the builds before and after the move, what no other suite pins exactly:
// Facebook sign-in's three requests (Meta's versioned login dialog, its token request and the profile read with its
// app-secret proof), and the startup checks' refusals, their order and the developer-token warning. The Google
// renewal's reads go through NativeTransport, which the call-replay proof records with every Google renewal suite.

const master = Buffer.alloc(32, 71).toString('base64'),
  password = 'synthetic-steps-password',
  origin = 'https://amcp.shop';
const json = body => new Response(JSON.stringify(body), {headers: {'Content-Type': 'application/json'}});

async function website() {
  const store = new Store(':memory:', master),
    env = {
      AMCP_EMAIL_API_KEY: 'synthetic-mail-secret',
      AMCP_EMAIL_FROM: 'AMCP <accounts@example.test>',
      AMCP_AUTO_APPROVE_SIGNUPS: 'true',
      AMCP_SIGNIN_FACEBOOK_CLIENT_ID: 'facebook-client',
      AMCP_SIGNIN_FACEBOOK_CLIENT_SECRET: 'facebook-secret',
    },
    calls = [];
  const fetcher = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({url: u.href, init});
    if (u.hostname === 'graph.facebook.com') {
      if (u.pathname.endsWith('/oauth/access_token')) return json({access_token: 'facebook-access-only'});
      return json({id: '123456', name: 'Facebook member'});
    }
    throw Error('Unexpected provider egress ' + u.origin);
  };
  const service = new MirrorService(new Registry(), store),
    listener = await listenForFetch(
      createHttpApp(service, store, {
        website: {origin, masterKey: master, adminPassword: password, authEnv: env, fetcher},
      }),
    ),
    base = 'http://127.0.0.1:' + listener.address().port;
  const request = async (path, method = 'GET', body, headers = {}) => {
    const r = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: {Origin: origin, ...(body ? {'Content-Type': 'application/json'} : {}), ...headers},
      body: body ? JSON.stringify(body) : undefined,
    });
    return {status: r.status, headers: r.headers, body: await r.text()};
  };
  return {
    store,
    calls,
    request,
    close: async () => {
      await new Promise(resolve => listener.close(resolve));
      store.close();
    },
  };
}

test('Facebook sign-in sends Meta’s versioned login dialog, token request and profile read with its proof', async () => {
  const f = await website();
  try {
    const started = await f.request('/api/signin/facebook/start', 'POST', {link: false});
    assert.equal(started.status, 200);
    const url = new URL(JSON.parse(started.body).url),
      state = url.searchParams.get('state');
    assert.equal(url.origin + url.pathname, 'https://www.facebook.com/' + metaApiVersion + '/dialog/oauth');
    assert.deepEqual(
      [...url.searchParams.keys()],
      ['client_id', 'redirect_uri', 'response_type', 'scope', 'state'],
      'Facebook gets no nonce and no PKCE challenge',
    );
    assert.equal(url.searchParams.get('client_id'), 'facebook-client');
    assert.equal(url.searchParams.get('redirect_uri'), origin + '/api/signin/facebook/callback');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('scope'), 'public_profile,email');
    const flow = started.headers.get('set-cookie').split(';')[0];
    const returned = await f.request(
      '/api/signin/facebook/callback?' + new URLSearchParams({state, code: 'synthetic-code'}),
      'GET',
      undefined,
      {Cookie: flow},
    );
    assert.equal(returned.status, 303);
    assert.equal(returned.headers.get('location'), '/auth/complete');
    const sent = f.calls.map(({url, init}) => ({
      url,
      method: init.method ?? 'GET',
      redirect: init.redirect,
      headers: init.headers,
      body: init.body === undefined ? undefined : String(init.body),
    }));
    assert.deepEqual(sent, [
      {
        url: 'https://graph.facebook.com/' + metaApiVersion + '/oauth/access_token',
        method: 'POST',
        redirect: 'error',
        headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'},
        body: new URLSearchParams({
          client_id: 'facebook-client',
          client_secret: 'facebook-secret',
          code: 'synthetic-code',
          redirect_uri: origin + '/api/signin/facebook/callback',
          grant_type: 'authorization_code',
        }).toString(),
      },
      {
        url:
          'https://graph.facebook.com/' +
          metaApiVersion +
          '/me?fields=id,name&appsecret_proof=' +
          createHmac('sha256', 'facebook-secret').update('facebook-access-only').digest('hex'),
        method: 'GET',
        redirect: 'error',
        headers: {Authorization: 'Bearer facebook-access-only'},
        body: undefined,
      },
    ]);
  } finally {
    await f.close();
  }
});

/** Runs `run` with these deployment settings (undefined unsets one), then restores the process's own. */
function withSettings(settings, run) {
  const saved = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(settings))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
}
const refusal = check => {
  try {
    check();
  } catch (e) {
    return e.message;
  }
  throw Error('expected a refusal');
};
const unset = {
  AMCP_LINKEDIN_API_VERSION: undefined,
  AMCP_META_API_VERSION: undefined,
  AMCP_GOOGLE_DEVELOPER_TOKEN: undefined,
};

test('startup checks LinkedIn’s version pin before Meta’s, names the setting, and logs the provider_versions stage', () => {
  const linkedin = withSettings({AMCP_LINKEDIN_API_VERSION: 'latest'}, () => refusal(() => linkedinVersion())),
    meta = refusal(() => resolveMetaVersion('v1.0'));
  const start = settings =>
    withSettings({...unset, ...settings}, () => {
      const logs = [];
      try {
        createRuntime(loadConfig({MIRROR_DB: ':memory:'}, 'stdio'), {log: line => logs.push(line)}).store.close();
        return {started: true, logs};
      } catch (e) {
        return {refused: e.message, logs};
      }
    });
  const failed = {level: 'error', event: 'startup_failed', stage: 'provider_versions', code: 'STARTUP_FAILED'};
  // Both pins unreviewed: LinkedIn's is checked first.
  assert.deepEqual(start({AMCP_LINKEDIN_API_VERSION: 'latest', AMCP_META_API_VERSION: 'v1.0'}), {
    refused: 'AMCP_LINKEDIN_API_VERSION is not a reviewed provider version: ' + linkedin,
    logs: [failed],
  });
  assert.deepEqual(start({AMCP_META_API_VERSION: 'v1.0'}), {
    refused: 'AMCP_META_API_VERSION is not a reviewed provider version: ' + meta,
    logs: [failed],
  });
  // Unset, LinkedIn's reviewed default is sent and Meta's default resolves: the process starts.
  assert.equal(start({}).started, true);
  assert.equal(start({AMCP_META_API_VERSION: 'v25.0'}).started, true);
});

test('a set Google developer token is named once at startup after the configuration problems, never its value', () => {
  const token = 'synthetic-developer-token-value';
  const logs = withSettings({...unset, AMCP_GOOGLE_DEVELOPER_TOKEN: token}, () => {
    const out = [];
    createRuntime(loadConfig({MIRROR_DB: ':memory:', AMCP_SHUTDOWN_GRACE_MS: 'soon'}, 'stdio'), {
      log: line => out.push(line),
    }).store.close();
    return out;
  });
  const warnings = logs.filter(line => line.level === 'warn');
  assert.deepEqual(
    warnings.map(line => line.event),
    ['config_problem', 'google_developer_token_ignored'],
  );
  assert.deepEqual(warnings[1], {
    level: 'warn',
    event: 'google_developer_token_ignored',
    message: googleDeveloperTokenWarning({AMCP_GOOGLE_DEVELOPER_TOKEN: token}),
  });
  assert.ok(!JSON.stringify(logs).includes(token));
  // Unset, the startup says nothing about it.
  const quiet = withSettings(unset, () => {
    const out = [];
    createRuntime(loadConfig({MIRROR_DB: ':memory:'}, 'stdio'), {log: line => out.push(line)}).store.close();
    return out;
  });
  assert.ok(!quiet.some(line => line.event === 'google_developer_token_ignored'));
});
