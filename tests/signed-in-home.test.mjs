import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {createPublicAssets} from '../dist/server/public-assets.js';
import {UserAccounts} from '../dist/server/user-accounts.js';
import {WebStore} from '../dist/server/web-store.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {pageRoutes} from '../dist/server/page-routes.js';
import express from 'express';

const varyCookie = /(?:^|,)\s*cookie\s*(?:,|$)/i;

// Owner decision P12 (DOC-03): a signed-in visitor to / goes to Home (/dashboard). Before it, / answered everyone with
// the public landing page, and a signed-in visitor had to choose "Open your workspace" there. A visitor who is not
// signed in keeps the landing page. The redirect is a fixed path on this site, so nothing in the request can steer it.
async function site() {
  const master = Buffer.alloc(32, 61).toString('base64'),
    store = new Store(':memory:', master),
    options = {origin: 'https://amcp.invalid', masterKey: master, authEnv: {}};
  let providerCalls = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      providerCalls++;
      throw Error('No provider request is allowed');
    }),
  );
  const web = new WebStore(store, options),
    accounts = new UserAccounts(web),
    member = accounts.newUser('Home visitor', 'home@example.test', null, true),
    session = web.createSession({tenantId: member.tenant_id, userId: member.id, role: 'admin'});
  const listener = await listenForFetch(
    createHttpApp(service, store, {publicOrigin: options.origin, website: options}),
  );
  const base = 'http://127.0.0.1:' + listener.address().port;
  return {
    store,
    member,
    cookie: web.cookie(session.id).split(';')[0],
    cookieName: web.cookieName,
    get: (route, headers = {}, method = 'GET') => fetch(base + route, {method, headers, redirect: 'manual'}),
    providerCalls: () => providerCalls,
    async close() {
      const closed = new Promise(resolve => listener.close(resolve));
      listener.closeAllConnections();
      await closed;
      store.close();
    },
  };
}

test('a signed-in visitor to / is sent to /dashboard with a same-site redirect that is never cached', async () => {
  const s = await site();
  try {
    for (const method of ['GET', 'HEAD'])
      for (const route of ['/', '/?lang=ar', '/?next=https://evil.example/', '/?return=//evil.example', '/?client=x']) {
        const response = await s.get(
          route,
          // A forwarded host or an Origin naming another site changes nothing: the address is not built from them.
          {cookie: s.cookie, 'x-forwarded-host': 'evil.example', origin: 'https://evil.example'},
          method,
        );
        await response.arrayBuffer();
        assert.equal(response.status, 302, method + ' ' + route);
        assert.equal(response.headers.get('location'), '/dashboard', method + ' ' + route);
        // A shared cache must never hand this answer to a visitor who is not signed in.
        assert.equal(response.headers.get('cache-control'), 'no-store', method + ' ' + route);
        assert.match(response.headers.get('vary') ?? '', varyCookie, method + ' ' + route);
        assert.equal(response.headers.get('set-cookie'), null);
      }
    // The page it leads to is the workspace shell.
    const home = await s.get('/dashboard', {cookie: s.cookie});
    assert.equal(home.status, 200);
    assert.equal(await home.text(), createPublicAssets('web').html('index.html'));
    // Only / redirects: the sign-in page and About still answer a signed-in visitor themselves.
    for (const route of ['/login', '/about', '/privacy']) {
      const page = await s.get(route, {cookie: s.cookie});
      await page.arrayBuffer();
      assert.equal(page.status, 200, route);
    }
    assert.equal(s.providerCalls(), 0);
  } finally {
    await s.close();
  }
});

test('a visitor who is not signed in keeps the public landing page at /, whatever cookie they send', async () => {
  const s = await site();
  try {
    const landing = createPublicAssets('web').html('index.html');
    for (const cookie of [
      undefined,
      s.cookieName + '=' + 'A'.repeat(43), // well formed, but no such session
      s.cookieName + '=not-a-session',
      s.cookie + '; ' + s.cookie, // two session cookies: neither is trusted
      'other=' + s.cookie.split('=')[1],
    ]) {
      const response = await s.get('/', cookie ? {cookie} : {});
      assert.equal(response.status, 200, String(cookie));
      assert.equal(response.headers.get('location'), null);
      assert.match(response.headers.get('content-type'), /^text\/html/);
      // The landing page is the other answer of the same address, so it is never stored or shared either.
      assert.equal(response.headers.get('cache-control'), 'no-store', String(cookie));
      assert.match(response.headers.get('vary') ?? '', varyCookie, String(cookie));
      assert.equal(await response.text(), landing, String(cookie));
    }
    // A session that ended no longer redirects: its account was turned off.
    s.store.db.prepare('UPDATE amcp_users SET disabled=1 WHERE id=?').run(s.member.id);
    const ended = await s.get('/', {cookie: s.cookie});
    assert.equal(ended.status, 200);
    assert.equal(await ended.text(), landing);
    assert.equal(s.providerCalls(), 0);
  } finally {
    await s.close();
  }
});

// The review of DOC-03: both answers of / were kept out of caches only by the site-wide security headers, and neither
// said that it depends on the cookie. Mounted without any other middleware, the page routes still mark both answers.
test('both answers of / say no-store and Vary: Cookie by themselves, without the site-wide headers', async () => {
  let session;
  const app = express(),
    router = express.Router(),
    publicAssets = createPublicAssets('web');
  pageRoutes({
    router,
    web: {origin: 'https://amcp.invalid', session: () => session},
    options: {},
    directory: 'web',
    publicAssets,
  });
  app.use(router);
  const listener = await listenForFetch(app);
  try {
    const base = 'http://127.0.0.1:' + listener.address().port;
    for (const [state, status] of [
      [undefined, 200],
      [{id: 'session'}, 302],
    ]) {
      session = state;
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(base + '/', {method, redirect: 'manual'});
        await response.arrayBuffer();
        assert.equal(response.status, status, method);
        assert.equal(response.headers.get('cache-control'), 'no-store', method + ' ' + status);
        assert.match(response.headers.get('vary') ?? '', varyCookie, method + ' ' + status);
      }
    }
    // Another shell address answers the same page to everyone: it does not vary by the cookie.
    const dashboard = await fetch(base + '/dashboard');
    assert.equal(await dashboard.text(), publicAssets.html('index.html'));
    assert.doesNotMatch(dashboard.headers.get('vary') ?? '', varyCookie);
  } finally {
    const closed = new Promise(resolve => listener.close(resolve));
    listener.closeAllConnections();
    await closed;
  }
});
