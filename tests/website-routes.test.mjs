import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {createWebsite, websiteRoutes, websiteSite} from '../dist/server/website.js';
import {enrollmentScope, securityHeaders, testAccountScope} from '../dist/server/website-gates.js';
import {platformRoutes} from '../dist/server/platform-routes.js';
import {connectionRoutes} from '../dist/server/connection-routes.js';
import {pageRoutes} from '../dist/server/page-routes.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

// ARC-04 stage D: createWebsite (1,816 lines) registered every website route itself. It now builds the website's parts
// (websiteSite) and registers the route modules of its route registry (websiteRoutes) in order. Express matches routes
// in registration order, so these tests hold that the router is exactly the modules' layers in registry order, the
// orderings that decide a match, and the fall-through answers (404, never 405) of unknown and unsupported requests.
const key = Buffer.alloc(32, 52).toString('base64');
function parts(writes = true) {
  const store = new Store(':memory:', key);
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('No provider request is allowed');
    }),
    undefined,
    {allowWrites: writes},
  );
  const options = {
    origin: 'https://amcp.invalid',
    masterKey: key,
    authEnv: {},
    fetcher: async () => {
      throw Error('No external request is allowed');
    },
  };
  return {store, service, options};
}
const probes = ['/', '/api', '/api/session', '/API/session', '/token', '/revoke', '/assets/a.js', '/dashboard', '/x'];
/** A layer as Express matches it: a route's path, methods and handler count, or a middleware's name and reach. */
const layer = l =>
  l.route
    ? 'route ' + l.route.path + ' ' + Object.keys(l.route.methods).sort().join(',') + ' ' + l.route.stack.length
    : 'use ' + l.name + ' ' + probes.filter(p => l.match(p)).join(',');

test('the router is the route modules’ layers in registry order, and nothing else', () => {
  for (const [writes, withService] of [
    [true, true],
    [false, true],
    [false, false],
  ]) {
    const {store, service, options} = parts(writes);
    try {
      const website = createWebsite(store, options, writes, withService ? service : undefined);
      const site = websiteSite(store, options, writes, withService ? service : undefined),
        expected = websiteRoutes.flatMap(routes => {
          const router = express.Router({caseSensitive: true});
          routes({...site, router});
          return router.stack.map(layer);
        });
      assert.deepEqual(website.router.stack.map(layer), expected);
      assert.deepEqual(Object.keys(website).sort(), [
        'accounts',
        'assetVersion',
        'discovery',
        'mcpOAuth',
        'oauth',
        'router',
        'web',
      ]);
      // The workspace and report download routes exist only where the MCP service runs.
      assert.equal(
        website.router.stack.some(l => l.route?.path === '/api/workspace/:tool'),
        withService,
      );
    } finally {
      store.close();
    }
  }
});

test('the registry keeps the orderings that decide a match', () => {
  const at = routes => websiteRoutes.indexOf(routes);
  assert.ok(Object.isFrozen(websiteRoutes));
  // The security headers and the access gates see every request first.
  assert.deepEqual(websiteRoutes.slice(0, 3), [securityHeaders, testAccountScope, enrollmentScope]);
  // /api/:platform/callback is registered before /api/connections/:id, so /api/connections/callback is a callback.
  assert.ok(at(platformRoutes) >= 0 && at(platformRoutes) < at(connectionRoutes));
  // The public pages answer what every module before them left, with the not-found page last.
  assert.equal(websiteRoutes.at(-1), pageRoutes);
  const {store, service, options} = parts();
  try {
    const stack = createWebsite(store, options, true, service).router.stack;
    const index = path => stack.findIndex(l => l.route?.path === path);
    assert.ok(index('/api/:platform/callback') < index('/api/connections/:id'));
    assert.ok(stack.at(-1).route === undefined, 'the not-found handler is the last layer');
  } finally {
    store.close();
  }
});

test('an unknown, unsupported or miscased request falls through to the not-found answers, never a 405', async () => {
  const {store, service, options} = parts();
  const listener = await listenForFetch(
    createHttpApp(service, store, {publicOrigin: 'https://amcp.invalid', website: options}),
  );
  const base = 'http://127.0.0.1:' + listener.address().port,
    get = (route, init = {}) => fetch(base + route, {redirect: 'manual', ...init});
  try {
    // A route that exists, with a method it does not take: the JSON NOT_FOUND every API caller reads.
    for (const [route, method] of [
      ['/api/session', 'PUT'],
      ['/api/platforms', 'PATCH'],
      ['/api/connector-tokens/abc', 'GET'],
      ['/api/workspace/workspace', 'GET'],
      ['/API/session', 'GET'],
    ]) {
      const response = await get(route, {method});
      assert.equal(response.status, 404, method + ' ' + route);
      assert.equal((await response.json()).error.code, 'NOT_FOUND', method + ' ' + route);
    }
    // A page address with another method is not the branded page either.
    const posted = await get('/dashboard', {method: 'POST'});
    assert.equal(posted.status, 404);
    assert.doesNotMatch(await posted.text(), /Page not found/);
    // A provider's return on /api/connections/callback is the callback route's (registered first): a browser without
    // a session gets the localized result page, not the connection route's JSON refusal.
    const callback = await get('/api/connections/callback?state=s', {headers: {accept: 'text/html'}});
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/oauth/result?error=SIGN_IN_REQUIRED');
    // The connection route still answers its own address.
    const connection = await get('/api/connections/abc');
    assert.equal(connection.status, 401);
    assert.equal((await connection.json()).error.code, 'SIGN_IN_REQUIRED');
  } finally {
    const closed = new Promise(resolve => listener.close(resolve));
    listener.closeAllConnections();
    await closed;
    store.close();
  }
});
