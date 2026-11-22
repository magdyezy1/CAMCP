import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {createHttpApp} from '../server/http-app.js';

// Microsoft Entra publisher-domain verification of the Microsoft Advertising app: Microsoft reads this file from the
// website's own domain, at this exact address, as application/json. Its application ID is read from the file here and
// never written in the test.
const address = '/.well-known/microsoft-identity-association.json',
  file = 'web/microsoft-identity-association.json',
  guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The website on a loopback port over an empty store; `check` gets its base address, the store and the file's bytes. */
async function withWebsite(check: (base: string, store: Store, expected: Buffer) => Promise<void>) {
  const master = Buffer.alloc(32, 62).toString('base64'),
    store = new Store(':memory:', master);
  const app = createHttpApp(new MirrorService(new Registry(), store), store, {
    website: {
      origin: 'https://amcp.shop',
      masterKey: master,
      fetcher: async () => {
        throw Error('Unexpected provider request');
      },
    },
  });
  const server = await listenForFetch(app);
  try {
    await check('http://127.0.0.1:' + (server.address() as {port: number}).port, store, fs.readFileSync(file));
  } finally {
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    store.close();
  }
}
const sessionRows = (store: Store) =>
  (store.db.prepare('SELECT COUNT(*) AS count FROM amcp_web_sessions').get() as {count: number}).count;

test('the Microsoft identity association is served at its well-known address as application/json, byte for byte, without a redirect, cookie or session', async () => {
  await withWebsite(async (base, store, expected) => {
    // SHA-256 of the file the owner supplied; catches accidental edits or encoding changes.
    assert.equal(
      createHash('sha256').update(expected).digest('hex'),
      '348c832b505b2dc907757745be360d352ab533e1823d942fbba04ad2b80d0394',
    );
    const response = await fetch(base + address, {redirect: 'manual'}),
      actual = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json(?:;|$)/i);
    // Revalidated on every fetch, as robots.txt and security.txt are: the app's blanket `no-store` is replaced.
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.deepEqual(actual, expected);
    const listed = (JSON.parse(actual.toString('utf8')) as {associatedApplications?: {applicationId?: unknown}[]})
      .associatedApplications;
    const id = listed?.[0]?.applicationId;
    assert.ok(typeof id === 'string' && guid.test(id), 'associatedApplications[0].applicationId is a GUID');
    assert.equal(sessionRows(store), 0);
  });
});

test('the Microsoft identity association answers HEAD with the same headers and no body', async () => {
  await withWebsite(async (base, store, expected) => {
    const response = await fetch(base + address, {method: 'HEAD', redirect: 'manual'});
    assert.equal((await response.arrayBuffer()).byteLength, 0);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json(?:;|$)/i);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(response.headers.get('content-length'), String(expected.length));
    assert.equal(sessionRows(store), 0);
  });
});

test('the Microsoft identity association is served at no other address', async () => {
  await withWebsite(async (base, _store, expected) => {
    // Without the extension under .well-known, and at the site root as TikTok's verification file is.
    for (const route of ['/.well-known/microsoft-identity-association', '/microsoft-identity-association.json']) {
      const other = await fetch(base + route, {redirect: 'manual'}),
        body = Buffer.from(await other.arrayBuffer());
      assert.equal(other.status, 404, route);
      assert.equal(other.headers.get('location'), null, route);
      assert.notDeepEqual(body, expected, route);
    }
  });
});
