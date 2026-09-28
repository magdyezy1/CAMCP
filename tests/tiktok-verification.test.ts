import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {createHttpApp} from '../server/http-app.js';

test('TikTok root verification serves the exact downloaded bytes without authentication or a session', async () => {
  const filename = 'tiktok94H3oMGQTvC0GEzgKcmffbz8W0CAHhan.txt',
    expected = fs.readFileSync('web/' + filename);
  // SHA-256 of the original TikTok download; catches accidental edits or encoding changes.
  assert.equal(
    createHash('sha256').update(expected).digest('hex'),
    '122f458611b4f20fb6a6e786166b80da6003023518358405d0f4d03bb75971a9',
  );
  const master = Buffer.alloc(32, 61).toString('base64'),
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
    const base = 'http://127.0.0.1:' + (server.address() as {port: number}).port;
    const response = await fetch(base + '/' + filename, {redirect: 'manual'}),
      actual = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.match(response.headers.get('content-type') ?? '', /^text\/plain(?:;|$)/i);
    assert.deepEqual(actual, expected);
    assert.equal(
      (store.db.prepare('SELECT COUNT(*) AS count FROM amcp_web_sessions').get() as {count: number}).count,
      0,
    );
    for (const route of ['/app.js', '/app.css', '/index.html', '/tiktok-unregistered.txt']) {
      const other = await fetch(base + route, {redirect: 'manual'});
      await other.arrayBuffer();
      assert.equal(other.status, 404, route);
    }
    const asset = await fetch(base + '/assets/app.js');
    await asset.arrayBuffer();
    assert.equal(asset.status, 200);
  } finally {
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    store.close();
  }
});
